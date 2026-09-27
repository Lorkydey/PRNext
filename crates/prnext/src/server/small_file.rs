//! Batch short filesystem operations, sharing bounded cached built-file bytes.
//! Larger files and conditional/range requests use ServeFile.
use anyhow::{Context, Result};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, Method, Response},
};
use std::{fs::File, io::Read, path::Path};

const MAX_BYTES: u64 = 64 * 1024;

// Common browser headers need no allocation. Leave weighted/complex negotiation
// to tower-http so this fast path does not introduce a second q-value parser.
pub(super) fn simple_gzip(headers: &HeaderMap) -> Option<bool> {
    let mut gzip = false;
    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let value = value.to_str().ok()?;
        if value.contains(';') {
            return None;
        }
        gzip |= value.split(',').any(|encoding| {
            let encoding = encoding.trim();
            encoding.eq_ignore_ascii_case("gzip") || encoding.eq_ignore_ascii_case("x-gzip")
        });
    }
    Some(gzip)
}

pub(super) async fn response(
    file: &Path,
    method: &Method,
    headers: &HeaderMap,
    precompressed: bool,
) -> Result<Option<Response<Body>>> {
    if !matches!(*method, Method::GET | Method::HEAD)
        || [
            header::RANGE,
            header::IF_RANGE,
            header::IF_MODIFIED_SINCE,
            header::IF_UNMODIFIED_SINCE,
            header::IF_MATCH,
            header::IF_NONE_MATCH,
        ]
        .iter()
        .any(|name| headers.contains_key(name))
    {
        return Ok(None);
    }
    let Some(gzip) = simple_gzip(headers) else {
        return Ok(None);
    };
    let gzip = precompressed && gzip;
    let file = file.to_owned();
    let head = method == Method::HEAD;
    tokio::task::spawn_blocking(move || {
        // Errors fall back to ServeFile's existing HTTP error mapping.
        let prepared = (|| -> std::io::Result<Option<Response<Body>>> {
            let compressed = gzip && super::fresh_gzip_sidecar_sync(&file)?;
            let selected = if compressed {
                let mut name = file.as_os_str().to_owned();
                name.push(".gz");
                std::path::PathBuf::from(name)
            } else {
                file.clone()
            };
            let metadata = std::fs::metadata(&selected)?;
            if !metadata.is_file() || metadata.len() > MAX_BYTES {
                return Ok(None);
            }
            let body = if head {
                Body::empty()
            } else {
                let stamp = precompressed
                    .then(|| super::file_cache::stamp(&metadata))
                    .flatten();
                let cached = stamp.as_ref().and_then(|stamp| {
                    super::file_cache::cache()
                        .lock()
                        .ok()?
                        .get(&selected, stamp)
                });
                if let Some(bytes) = cached {
                    Body::from(bytes)
                } else {
                    let mut source = File::open(&selected)?;
                    let mut bytes = Vec::with_capacity(metadata.len() as usize);
                    // A concurrent writer must not turn a small file into an
                    // unbounded allocation. Re-open through ServeFile if it grew.
                    (&mut source).take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
                    if bytes.len() as u64 != metadata.len() {
                        return Ok(None);
                    }
                    let bytes = Bytes::from(bytes.into_boxed_slice());
                    if let Some(stamp) = stamp {
                        // Do not publish a body read across an in-place file change.
                        if super::file_cache::stamp(&source.metadata()?).as_ref() == Some(&stamp) {
                            if let Ok(mut cache) = super::file_cache::cache().lock() {
                                cache.insert(&selected, stamp, bytes.clone());
                            }
                        }
                    }
                    Body::from(bytes)
                }
            };
            let mut response = Response::new(body);
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(metadata.len()));
            headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(
                    mime_guess::from_path(&file)
                        .first_raw()
                        .unwrap_or("application/octet-stream"),
                ),
            );
            if let Ok(modified) = metadata.modified() {
                headers.insert(
                    header::LAST_MODIFIED,
                    HeaderValue::from_str(&httpdate::fmt_http_date(modified)).unwrap(),
                );
            }
            if compressed {
                headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            }
            Ok(Some(response))
        })();
        prepared.unwrap_or(None)
    })
    .await
    .context("small file read task failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn cached_built_files_invalidate_on_replacement_and_deletion() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("page.html");
        std::fs::write(&file, "first").unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        for text in ["first", "other", "a larger replacement"] {
            std::fs::write(&file, text).unwrap();
            // A restored mtime must not make a same-length update invisible.
            File::options()
                .write(true)
                .open(&file)
                .unwrap()
                .set_modified(modified)
                .unwrap();
            for _ in 0..2 {
                let result = response(&file, &Method::GET, &HeaderMap::new(), true)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(to_bytes(result.into_body(), 100).await.unwrap(), text);
            }
        }
        let replacement = directory.path().join("replacement");
        std::fs::write(&replacement, "replacement via rename").unwrap();
        std::fs::rename(&replacement, &file).unwrap();
        let result = response(&file, &Method::GET, &HeaderMap::new(), true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            to_bytes(result.into_body(), 100).await.unwrap(),
            "replacement via rename"
        );
        std::fs::remove_file(&file).unwrap();
        assert!(response(&file, &Method::GET, &HeaderMap::new(), true)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn small_reads_see_file_changes_and_head_preserves_length() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("value.txt");
        for value in ["first", "other", "a longer replacement"] {
            std::fs::write(&file, value).unwrap();
            let result = response(&file, &Method::GET, &HeaderMap::new(), false)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                result.headers()[header::CONTENT_LENGTH],
                value.len().to_string()
            );
            assert_eq!(result.headers()[header::CONTENT_TYPE], "text/plain");
            assert_eq!(to_bytes(result.into_body(), 100).await.unwrap(), value);
        }
        let result = response(&file, &Method::HEAD, &HeaderMap::new(), false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.headers()[header::CONTENT_LENGTH], "20");
        assert!(result.headers().contains_key(header::LAST_MODIFIED));
        assert!(to_bytes(result.into_body(), 100).await.unwrap().is_empty());
        std::fs::remove_file(&file).unwrap();
        assert!(response(&file, &Method::GET, &HeaderMap::new(), false)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn large_conditional_and_weighted_requests_keep_the_streaming_service() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("value.txt");
        std::fs::write(&file, vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        assert!(response(&file, &Method::GET, &HeaderMap::new(), false)
            .await
            .unwrap()
            .is_none());
        std::fs::write(&file, "small").unwrap();
        for (header, value) in [
            (header::RANGE, "bytes=0-2"),
            (header::IF_MODIFIED_SINCE, "Wed, 01 Jan 2100 00:00:00 GMT"),
            (header::IF_UNMODIFIED_SINCE, "Wed, 01 Jan 2000 00:00:00 GMT"),
            (header::ACCEPT_ENCODING, "gzip;q=0, identity"),
            (header::ACCEPT_ENCODING, "gzip;q=0.5, identity;q=1"),
        ] {
            let headers = HeaderMap::from_iter([(header, HeaderValue::from_static(value))]);
            assert!(response(&file, &Method::GET, &headers, true)
                .await
                .unwrap()
                .is_none());
        }
    }
}
