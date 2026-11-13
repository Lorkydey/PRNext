//! Certified build-time PPR prefix followed by the existing worker transport.
//! No HTTP header can select a continuation; only this module sets renderMode.
use super::*;
use anyhow::{anyhow, ensure};
use axum::body::Bytes;
use futures_util::{stream, StreamExt, TryStreamExt};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PREFIX: usize = 128 * 1024;
const MAX_ARTIFACT: usize = 2 * 1024 * 1024;

pub(super) struct NativeShells {
    entries: HashMap<String, (crate::manifest::NativePprArtifact, Bytes)>,
    snapshot: crate::cache::NativeSnapshot,
}

#[derive(Clone)]
pub(super) struct Selection {
    descriptor: crate::manifest::NativePprArtifact,
    prefix: Bytes,
}

fn digest(bytes: &[u8]) -> String {
    crate::hashing::sha256_hex(bytes)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl NativeShells {
    pub(super) async fn load(
        dist: &Path,
        manifest: &Manifest,
        snapshot: crate::cache::NativeSnapshot,
    ) -> Result<Option<Self>> {
        if !manifest.config.native_ppr_shell
            || manifest.dev
            || manifest.middleware.is_some()
            || manifest.config.cache_handler.is_some()
            || !manifest.config.base_path.is_empty()
        {
            return Ok(None);
        }
        ensure!(
            manifest.config.native_ppr_artifacts.len() <= 32,
            "Too many native PPR shells"
        );
        let mut entries = HashMap::new();
        let mut total = 0;
        for descriptor in &manifest.config.native_ppr_artifacts {
            let Some(route) = manifest
                .routes
                .iter()
                .find(|route| route.id == descriptor.route_id)
            else {
                bail!("Unknown native PPR route");
            };
            ensure!(
                route.kind == RouteKind::Page
                    && route.router.as_deref() == Some("app")
                    && !route.internal
                    && route
                        .cache_config
                        .as_ref()
                        .and_then(|v| v.get("runtime"))
                        .and_then(|v| v.as_str())
                        != Some("edge"),
                "Invalid native PPR route"
            );
            ensure!(
                hash(&descriptor.artifact_hash)
                    && hash(&descriptor.prefix_hash)
                    && hash(&descriptor.identity),
                "Invalid native PPR hash"
            );
            ensure!(
                descriptor.path.starts_with('/')
                    && !descriptor.path.contains(['?', '#'])
                    && decode_path(&descriptor.path).is_ok(),
                "Invalid native PPR path"
            );
            ensure!(
                descriptor.artifact.starts_with("static/")
                    && descriptor.prefix.starts_with("static/"),
                "Invalid native PPR file"
            );
            let artifact = super::contained_file(dist, &descriptor.artifact)
                .await?
                .context("Missing native PPR artifact")?;
            let prefix = super::contained_file(dist, &descriptor.prefix)
                .await?
                .context("Missing native PPR prefix")?;
            ensure!(
                tokio::fs::metadata(&artifact).await?.len() <= MAX_ARTIFACT as u64
                    && tokio::fs::metadata(&prefix).await?.len() <= MAX_PREFIX as u64,
                "Native PPR artifact too large"
            );
            let artifact = tokio::fs::read(artifact).await?;
            let prefix = tokio::fs::read(prefix).await?;
            ensure!(
                artifact.len() <= MAX_ARTIFACT
                    && prefix.len() <= MAX_PREFIX
                    && digest(&artifact) == descriptor.artifact_hash
                    && digest(&prefix) == descriptor.prefix_hash,
                "Native PPR artifact checksum mismatch"
            );
            let value: serde_json::Value = serde_json::from_slice(&artifact)?;
            ensure!(
                value["version"] == 1
                    && value.get("postponed").is_some_and(|v| !v.is_null())
                    && value.get("complete").is_none()
                    && value.get("generic").is_none()
                    && value.get("externalCache").is_none_or(|v| v == false),
                "Invalid native PPR artifact"
            );
            ensure!(
                value["flight"]
                    .as_str()
                    .is_some_and(|v| digest(v.as_bytes()) == descriptor.identity)
                    && value["generatedAt"].as_u64() == Some(descriptor.generated_at),
                "Native PPR identity mismatch"
            );
            let lifetime: crate::manifest::Revalidate = serde_json::from_value(
                value
                    .get("revalidate")
                    .cloned()
                    .unwrap_or(serde_json::Value::Bool(false)),
            )?;
            ensure!(
                lifetime == descriptor.revalidate
                    && !matches!(lifetime, crate::manifest::Revalidate::Seconds(0)),
                "Invalid native PPR lifetime"
            );
            total += prefix.len();
            ensure!(total <= 4 * 1024 * 1024, "Native PPR shell budget exceeded");
            ensure!(
                entries
                    .insert(
                        descriptor.path.clone(),
                        (descriptor.clone(), Bytes::from(prefix))
                    )
                    .is_none(),
                "Duplicate native PPR path"
            );
        }
        Ok((!entries.is_empty()).then_some(Self { entries, snapshot }))
    }

    pub(super) async fn select(
        &self,
        route: &Route,
        parts: &axum::http::request::Parts,
        original_url: Option<&str>,
    ) -> Option<Selection> {
        if parts.method != Method::GET
            || parts.uri.query().is_some()
            || original_url.is_some()
            || !eligible_headers(&parts.headers)
            || parts.extensions.get::<RoutingContext>().is_some_and(|c| {
                c.data
                    || c.middleware_matched
                    || c.rewrite.is_some()
                    || c.routing_request_headers.is_some()
            })
        {
            return None;
        }
        let (descriptor, prefix) = self.entries.get(parts.uri.path())?;
        if descriptor.route_id != route.id
            || !fresh(
                descriptor,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_millis(),
            )
            || !self.snapshot.build_generation().await
            || !fresh(
                descriptor,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_millis(),
            )
        {
            return None;
        }
        Some(Selection {
            descriptor: descriptor.clone(),
            prefix: prefix.clone(),
        })
    }
}

fn eligible_headers(headers: &HeaderMap) -> bool {
    !headers.keys().any(|name| {
        let name = name.as_str();
        matches!(
            name,
            "cookie"
                | "authorization"
                | "proxy-authorization"
                | "rsc"
                | "range"
                | "if-range"
                | "if-none-match"
                | "if-modified-since"
                | "content-security-policy"
                | "content-security-policy-report-only"
                | "content-length"
                | "transfer-encoding"
                | "next-action"
        ) || name.starts_with("x-prnext-")
            || name.starts_with("next-router-")
            || name.starts_with("x-nextjs-")
    })
}

fn fresh(descriptor: &crate::manifest::NativePprArtifact, now: u128) -> bool {
    let generated = u128::from(descriptor.generated_at);
    now >= generated
        && match descriptor.revalidate {
            crate::manifest::Revalidate::Never => true,
            crate::manifest::Revalidate::Seconds(seconds) => {
                now - generated < u128::from(seconds) * 1000
            }
        }
}

impl Selection {
    pub(super) fn render_mode(&self) -> String {
        format!("native-ppr:{}", self.descriptor.artifact_hash)
    }

    pub(super) fn response<F>(self, future: F) -> Result<Response<Body>>
    where
        F: std::future::Future<Output = std::result::Result<RenderedResponse, PoolError>>
            + Send
            + 'static,
    {
        let identity = self.descriptor.identity.clone();
        let expected = self.descriptor.artifact_hash;
        let prefix = self.prefix;
        let continuation = stream::once(async move {
            let rendered = future
                .await
                .map_err(|error| anyhow!("Native PPR continuation failed: {error:?}"))?;
            ensure!(
                rendered.status == 200 && rendered.page_error.is_none() && rendered.isr.is_none(),
                "Invalid native PPR continuation status"
            );
            ensure!(
                rendered
                    .headers
                    .get("x-prnext-native-ppr")
                    .is_some_and(|v| matches!(v, HeaderValues::Single(v) if v == &expected))
                    && !rendered.headers.contains_key("set-cookie")
                    && !rendered.headers.contains_key("location"),
                "Native PPR continuation did not acknowledge its snapshot"
            );
            Ok::<_, anyhow::Error>(
                super::render_response(rendered, false)?
                    .into_body()
                    .into_data_stream()
                    .map_err(anyhow::Error::from),
            )
        })
        .try_flatten();
        let mut total = 0usize;
        let body = stream::once(async move { Ok(prefix) })
            .chain(continuation)
            .map(move |chunk| {
                let chunk = chunk?;
                total = total.saturating_add(chunk.len());
                ensure!(
                    total <= crate::pool::MAX_RESPONSE_BYTES,
                    "Native PPR response exceeds 16 MiB"
                );
                Ok::<_, anyhow::Error>(chunk)
            });
        let mut response = Response::new(Body::from_stream(body));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache, no-store, max-age=0"),
        );
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("RSC"));
        response
            .headers_mut()
            .insert("x-prnext-prerender", HeaderValue::from_static("partial"));
        response
            .headers_mut()
            .insert("x-prnext-native-ppr", HeaderValue::from_static("1"));
        response
            .headers_mut()
            .insert("x-prnext-ppr-id", HeaderValue::from_str(&identity)?);
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_navigation_and_conditional_requests_never_commit_a_native_prefix() {
        assert!(eligible_headers(&HeaderMap::new()));
        for name in [
            "cookie",
            "authorization",
            "rsc",
            "next-router-prefetch",
            "next-action",
            "x-prnext-native-ppr",
            "x-prnext-router-state",
            "content-security-policy",
            "range",
            "if-none-match",
            "content-length",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_static("1"),
            );
            assert!(!eligible_headers(&headers), "{name}");
        }
    }

    fn selected() -> Selection {
        Selection {descriptor: serde_json::from_value(serde_json::json!({"routeId":"page","path":"/","artifact":"static/a.json","artifactHash":"a".repeat(64),"prefix":"static/a.html","prefixHash":"b".repeat(64),"identity":"c".repeat(64),"generatedAt":1000,"revalidate":2})).unwrap(), prefix: Bytes::from_static(b"<html>shell")}
    }

    #[test]
    fn shell_lifetime_rejects_expiry_and_clock_rollback() {
        let descriptor = selected().descriptor;
        assert!(!fresh(&descriptor, 999));
        assert!(fresh(&descriptor, 1000));
        assert!(fresh(&descriptor, 2999));
        assert!(!fresh(&descriptor, 3000));
    }

    #[tokio::test]
    async fn prefix_is_emitted_before_the_worker_future_runs_and_drop_cancels_it() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let started = Arc::new(AtomicBool::new(false));
        let flag = started.clone();
        let mut body = selected()
            .response(async move {
                flag.store(true, Ordering::SeqCst);
                std::future::pending().await
            })
            .unwrap()
            .into_body()
            .into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap(), "<html>shell");
        assert!(!started.load(Ordering::SeqCst));
        drop(body);
        assert!(!started.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn continuation_requires_the_exact_snapshot_acknowledgement() {
        for acknowledge in [true, false] {
            let mut headers = BTreeMap::new();
            if acknowledge {
                headers.insert(
                    "x-prnext-native-ppr".into(),
                    HeaderValues::Single("a".repeat(64)),
                );
            }
            let mut body = selected()
                .response(async move {
                    Ok(RenderedResponse {
                        status: 200,
                        headers,
                        body: RenderedBody::Buffered(b"tail".to_vec()),
                        isr: None,
                        page_error: None,
                        page_failure: None,
                    })
                })
                .unwrap()
                .into_body()
                .into_data_stream();
            assert_eq!(body.next().await.unwrap().unwrap(), "<html>shell");
            let next = body.next().await.unwrap();
            if acknowledge {
                assert_eq!(next.unwrap(), "tail");
            } else {
                assert!(next.is_err());
            }
        }
    }
}
