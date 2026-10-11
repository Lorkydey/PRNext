//! Batch short filesystem operations, sharing bounded cached built-file bytes.
//! Larger files and conditional/range requests use ServeFile.
use anyhow::{Context, Result};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, Method, Response},
};
use std::{
    fs::{File, Metadata},
    io::Read,
    path::Path,
};

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
    let Some(options) = Options::new(method, headers, precompressed) else {
        return Ok(None);
    };
    let file = file.to_owned();
    crate::blocking::run(crate::blocking::Origin::SmallRead, move || {
        response_sync(&file, options)
    })
    .await
    .context("small file read task failed")
}

#[derive(Clone, Copy)]
pub(super) struct Options {
    gzip: bool,
    head: bool,
    cache: bool,
}

impl Options {
    pub(super) fn new(method: &Method, headers: &HeaderMap, precompressed: bool) -> Option<Self> {
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
            return None;
        }
        let gzip = simple_gzip(headers)?;
        Some(Self {
            gzip: precompressed && gzip,
            head: method == Method::HEAD,
            cache: precompressed,
        })
    }
}

// Keep containment, metadata and the bounded read on the same blocking task.
// Never call this on an async runtime thread: public files may live on slow disks.
pub(super) fn response_sync(file: &Path, options: Options) -> Option<Response<Body>> {
    // Errors fall back to ServeFile's existing HTTP error mapping.
    let prepared = (|| -> std::io::Result<Option<Response<Body>>> {
        let sidecar = if options.gzip {
            super::fresh_gzip_file_sync(file)?
        } else {
            None
        };
        let compressed = sidecar.is_some();
        let (selected, metadata) = match sidecar {
            Some(sidecar) => sidecar,
            None => (file.to_owned(), std::fs::metadata(file)?),
        };
        let Some(body) = read_body(&selected, &metadata, options, None)? else {
            return Ok(None);
        };
        Ok(Some(representation(file, &metadata, compressed, body)))
    })();
    prepared.unwrap_or(None)
}

#[cfg(windows)]
pub(super) fn opened_response_sync(
    original: super::contained_windows::OpenedFile,
    options: Options,
) -> Option<Response<Body>> {
    let prepared = (|| -> std::io::Result<Option<Response<Body>>> {
        let identity_path = original.path.clone();
        let sidecar = if options.gzip {
            let mut sibling = original.path.as_os_str().to_owned();
            sibling.push(".gz");
            if let Some(parent) = original.path.parent() {
                super::contained_windows::open_path(parent, Path::new(&sibling))?.filter(|gzip| {
                    gzip.metadata
                        .modified()
                        .ok()
                        .zip(original.metadata.modified().ok())
                        .is_some_and(|(gzip, original)| gzip == original)
                })
            } else {
                None
            }
        } else {
            None
        };
        let compressed = sidecar.is_some();
        let selected = sidecar.unwrap_or(original);
        let Some(body) = read_body(
            &selected.path,
            &selected.metadata,
            options,
            Some(selected.source),
        )?
        else {
            return Ok(None);
        };
        Ok(Some(representation(
            &identity_path,
            &selected.metadata,
            compressed,
            body,
        )))
    })();
    prepared.unwrap_or(None)
}

fn read_body(
    selected: &Path,
    metadata: &Metadata,
    options: Options,
    source: Option<File>,
) -> std::io::Result<Option<Body>> {
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Ok(None);
    }
    if options.head {
        return Ok(Some(Body::empty()));
    }
    let stamp = options
        .cache
        .then(|| super::file_cache::stamp(metadata))
        .flatten();
    let cached = stamp
        .as_ref()
        .and_then(|stamp| super::file_cache::cache().lock().ok()?.get(selected, stamp));
    if let Some(bytes) = cached {
        return Ok(Some(Body::from(bytes)));
    }
    let _span = crate::blocking::phase(crate::blocking::Origin::Read);
    let mut source = match source {
        Some(source) => source,
        None => File::open(selected)?,
    };
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // A concurrent writer must not turn a small file into an unbounded
    // allocation. The EOF check also detects growth beyond the selected length.
    (&mut source).take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.len() {
        return Ok(None);
    }
    let bytes = Bytes::from(bytes.into_boxed_slice());
    if let Some(stamp) = stamp {
        // Do not publish a body read across an in-place file change.
        if super::file_cache::stamp(&source.metadata()?).as_ref() == Some(&stamp) {
            if let Ok(mut cache) = super::file_cache::cache().lock() {
                cache.insert(selected, stamp, bytes.clone());
            }
        }
    }
    Ok(Some(Body::from(bytes)))
}

fn representation(
    file: &Path,
    metadata: &Metadata,
    compressed: bool,
    body: Body,
) -> Response<Body> {
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(metadata.len()));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(
            mime_guess::from_path(file)
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
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[cfg(windows)]
    #[tokio::test]
    async fn opened_file_reads_the_checked_object_after_path_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("value.txt");
        std::fs::write(&file, "checked object").unwrap();
        let opened = super::super::contained_windows::open(&root, "value.txt")
            .unwrap()
            .unwrap();
        // Normal share-delete remains enabled. Replacement of the name must
        // not cause the validated handle to read the new, unchecked object.
        std::fs::rename(&file, root.join("renamed.txt")).unwrap();
        std::fs::write(&file, "replacement").unwrap();
        let result = opened_response_sync(
            opened,
            Options::new(&Method::GET, &HeaderMap::new(), false).unwrap(),
        )
        .unwrap();
        assert_eq!(
            to_bytes(result.into_body(), 100).await.unwrap(),
            "checked object"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn opened_file_keeps_writers_unblocked_and_detects_length_changes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("value.txt");
        let options = Options::new(&Method::GET, &HeaderMap::new(), true).unwrap();
        for replacement in [b"short".as_slice(), b"a longer replacement"] {
            std::fs::write(&file, "first value").unwrap();
            let opened = super::super::contained_windows::open(&root, "value.txt")
                .unwrap()
                .unwrap();
            std::fs::write(&file, replacement).unwrap();
            assert!(opened_response_sync(opened, options).is_none());
        }
        std::fs::write(&file, "first").unwrap();
        let opened = super::super::contained_windows::open(&root, "value.txt")
            .unwrap()
            .unwrap();
        let modified = opened.metadata.modified().unwrap();
        std::fs::write(&file, "other").unwrap();
        File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let result = opened_response_sync(opened, options).unwrap();
        assert_eq!(to_bytes(result.into_body(), 100).await.unwrap(), "other");
    }

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
