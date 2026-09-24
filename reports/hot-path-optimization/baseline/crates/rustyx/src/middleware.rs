//! Native middleware matching and bounded worker transport.
use crate::{
    custom_routes::{CompiledRoutes, CompiledRule, Rule},
    pool::{
        HeaderValues, PoolError, RenderedBody, RenderedResponse, WorkerConfig, WorkerPool,
        WorkerRequest, MAX_BODY_BYTES,
    },
};
use anyhow::{bail, Result};
use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, HeaderMap, HeaderName, HeaderValue, Response, Uri},
};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiddlewareManifest {
    pub module: String,
    pub export_name: String,
    pub convention: String,
    pub runtime: String,
    pub matchers: Vec<Rule>,
}
impl MiddlewareManifest {
    pub fn validate(&self) -> Result<()> {
        crate::manifest::validate_relative_file(&self.module)?;
        if !matches!(
            self.export_name.as_str(),
            "default" | "middleware" | "proxy"
        ) || !matches!(self.convention.as_str(), "middleware" | "proxy")
            || !matches!(self.runtime.as_str(), "nodejs" | "edge")
            || self.matchers.len() > 1000
        {
            bail!("invalid middleware manifest");
        }
        Ok(())
    }
}

pub struct Middleware {
    matchers: Vec<CompiledRule>,
    pool: WorkerPool,
    slots: Arc<Semaphore>,
    worker_slots: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
    bodies: crate::pool::BodyBudget,
}
impl Middleware {
    pub fn new(manifest: Option<MiddlewareManifest>, worker: WorkerConfig) -> Result<Option<Self>> {
        let Some(manifest) = manifest else {
            return Ok(None);
        };
        manifest.validate()?;
        Ok(Some(Self {
            matchers: CompiledRoutes::compile_matchers(manifest.matchers)?,
            pool: WorkerPool::new(worker, 1).retire_after(Duration::from_secs(30)),
            slots: Arc::new(Semaphore::new(5)),
            // The worker channel has four queued jobs. Keeping admission at
            // four also covers a cold worker that has not dequeued its first
            // job yet; a legitimate fifth arrival must not race try_send.
            worker_slots: Arc::new(Semaphore::new(4)),
            waiting: Arc::new(Semaphore::new(64)),
            bodies: crate::pool::BodyBudget::default(),
        }))
    }
    pub fn with_pool(mut self, pool: WorkerPool) -> Self {
        let capacity = pool.capacity();
        self.pool = pool;
        self.slots = Arc::new(Semaphore::new(capacity));
        self.worker_slots = Arc::new(Semaphore::new(capacity));
        self.waiting = Arc::new(Semaphore::new((capacity * 16).min(1024)));
        self
    }
    pub fn with_bodies(mut self, bodies: crate::pool::BodyBudget) -> Self {
        self.bodies = bodies;
        self
    }
    pub fn matches(&self, uri: &Uri, headers: &HeaderMap) -> Result<bool> {
        for matcher in &self.matchers {
            if matcher.captures(uri, headers)?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub async fn execute(
        &self,
        request: Request,
        original_url: &str,
    ) -> std::result::Result<(Request, RenderedResponse, OwnedSemaphorePermit), Box<Response<Body>>>
    {
        // A single module graph can request many assets simultaneously. Wait
        // before buffering their bodies rather than rejecting the sixth asset
        // and breaking hydration. The waiting population stays strictly bounded
        // and cancellation drops every permit without creating a worker job.
        let waiting = self
            .waiting
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure(503, "Middleware queue is full; retry shortly"))?;
        let (permit, worker_permit) = tokio::time::timeout(Duration::from_secs(30), async {
            let permit = self.slots.clone().acquire_owned().await?;
            let worker_permit = self.worker_slots.clone().acquire_owned().await?;
            Ok::<_, tokio::sync::AcquireError>((permit, worker_permit))
        })
        .await
        .map_err(|_| failure(504, "Middleware admission timed out"))?
        .map_err(|_| failure(503, "Middleware queue is closed"))?;
        drop(waiting);
        let mut body_budget = self
            .bodies
            .request(&request, MAX_BODY_BYTES)
            .await
            .map_err(|message| failure(408, message))?;
        let (mut parts, body) = request.into_parts();
        let bytes =
            match tokio::time::timeout(Duration::from_secs(30), to_bytes(body, MAX_BODY_BYTES))
                .await
            {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => {
                    return Err(failure(
                        413,
                        "Request body exceeds 8 MiB or could not be read",
                    ))
                }
                Err(_) => return Err(failure(408, "Request body timed out")),
            };
        body_budget.shrink_to(bytes.len());
        parts.extensions.insert(body_budget.clone());
        let origin = reqwest::Url::parse(original_url)
            .map_err(|_| failure(400, "Invalid middleware request URL"))?;
        let url = format!(
            "{}{}",
            origin.origin().ascii_serialization(),
            parts
                .uri
                .path_and_query()
                .map(|value| value.as_str())
                .unwrap_or("/")
        );
        let input = WorkerRequest {
            id: 0,
            route_id: "__rustyx_middleware".into(),
            method: parts.method.to_string(),
            original_url: (url != original_url).then(|| original_url.to_owned()),
            routing_request_headers: None,
            routing_resolver: None,
            url,
            headers: crate::server::request_headers(&parts.headers),
            body: crate::pool::WorkerBody::new(bytes.clone(), body_budget),
            params: Default::default(),
            stream: true,
            render_mode: Some("middleware".into()),
            revalidate_reason: None,
            page_failure: None,
            document_request: None,
            middleware_matched: false,
        };
        // The middleware and downstream receive independent readers over the
        // same bounded bytes. Consuming the first never consumes the second.
        let request = Request::from_parts(parts, Body::from(bytes));
        let rendered = self
            .pool
            .request(input, Some(worker_permit))
            .await
            .map_err(|error| match error {
                PoolError::Overloaded => failure(503, "Middleware queue is full; retry shortly"),
                PoolError::Timeout => failure(504, "Middleware timed out"),
                PoolError::Worker(error) => {
                    tracing::warn!(%error, "middleware worker failed");
                    failure(502, "Middleware worker failed")
                }
            })?;
        Ok((request, rendered, permit))
    }
}

fn failure(status: u16, message: &'static str) -> Box<Response<Body>> {
    let mut response = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store");
    if status == 503 {
        response = response.header(header::RETRY_AFTER, "1");
    }
    Box::new(response.body(Body::from(message)).unwrap())
}

pub(crate) async fn drain_control(body: RenderedBody) -> Result<()> {
    let body = match body {
        RenderedBody::Buffered(bytes) => Body::from(bytes),
        RenderedBody::Stream(stream) => Body::from_stream(stream),
    };
    // A continuation has no public body. A malformed worker cannot reserve the
    // dedicated slot forever or make dispatch buffer an unbounded response.
    tokio::time::timeout(Duration::from_secs(30), to_bytes(body, 64 * 1024)).await??;
    Ok(())
}

const FLIGHT_HEADERS: [&str; 6] = [
    "rsc",
    "next-router-state-tree",
    "x-rustyx-router-state",
    "next-router-prefetch",
    "next-hmr-refresh",
    "next-router-segment-prefetch",
];
pub(crate) enum Action {
    Next,
    Rewrite(crate::custom_routes::Target),
    Response,
}
pub(crate) struct Effects {
    pub action: Action,
    pub headers: HeaderMap,
}
pub(crate) fn effects(
    values: BTreeMap<String, HeaderValues>,
    request: &mut HeaderMap,
    original_url: &str,
    uri: &Uri,
    normalize: bool,
) -> Result<Effects> {
    let mut headers = HeaderMap::new();
    for (name, values) in values {
        let name = HeaderName::try_from(name)?;
        for value in values.values() {
            headers.append(name.clone(), HeaderValue::try_from(value)?);
        }
    }
    crate::proxy::strip_hop(&mut headers);
    headers.remove(header::CONTENT_LENGTH);
    if let Some(location) = headers.get(header::LOCATION) {
        let location = relative_location(location.to_str()?, original_url)?;
        headers.insert(header::LOCATION, HeaderValue::try_from(location)?);
    }
    let mut action = if let Some(rewrite) = headers
        .get("x-middleware-rewrite")
        .filter(|value| !value.is_empty())
    {
        Action::Rewrite(rewrite_target(rewrite.to_str()?, original_url)?)
    } else if headers.contains_key(header::LOCATION) {
        Action::Response
    } else if headers
        .get("x-middleware-next")
        .is_some_and(|value| !value.is_empty())
    {
        Action::Next
    } else {
        Action::Response
    };
    let data = request.contains_key("x-nextjs-data");
    let rsc = request.get("rsc").is_some_and(|value| value == "1");
    if let Action::Rewrite(target) = &mut action {
        if target.external && rsc {
            let original = reqwest::Url::parse(original_url)?;
            let mut destination = reqwest::Url::parse(&target.url)?;
            if !destination.query_pairs().any(|(name, _)| name == "_rsc") {
                if let Some((_, value)) = original.query_pairs().find(|(name, _)| name == "_rsc") {
                    destination.query_pairs_mut().append_pair("_rsc", &value);
                    target.url = destination.to_string();
                }
            }
        }
    }
    let flight = FLIGHT_HEADERS
        .into_iter()
        .filter_map(|name| request.get(name).cloned().map(|value| (name, value)))
        .collect::<Vec<_>>();
    if let Some(list) = headers
        .get("x-middleware-override-headers")
        .filter(|value| !value.is_empty())
    {
        let mut replacement = HeaderMap::new();
        for name in list
            .to_str()?
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            let name = HeaderName::from_bytes(name.as_bytes())?;
            if name.as_str().starts_with("x-middleware-")
                || crate::server::is_hop_header(&name)
                || name == header::CONTENT_LENGTH
            {
                continue;
            }
            if let Some(value) = headers.get(format!("x-middleware-request-{name}")) {
                replacement.insert(name, value.clone());
            }
        }
        *request = replacement;
    }
    let cookie_marker = headers.get("x-middleware-set-cookie").cloned();
    strip_incoming(&mut headers);
    headers.remove("x-rustyx-rewrite");
    if !matches!(action, Action::Response) {
        for name in headers.keys() {
            request.remove(name);
            for value in headers.get_all(name) {
                request.append(name.clone(), value.clone());
            }
        }
        if let Some(value) = cookie_marker {
            request.insert("x-middleware-set-cookie", value);
        }
    }
    if normalize {
        for name in FLIGHT_HEADERS {
            request.remove(name);
        }
        for (name, value) in flight {
            request.insert(name, value);
        }
    }
    if let Action::Rewrite(target) = &action {
        headers.insert("x-middleware-rewrite", HeaderValue::try_from(&target.url)?);
        if data {
            headers.insert("x-nextjs-rewrite", HeaderValue::try_from(&target.url)?);
        }
        if rsc && !target.external {
            let destination: Uri = target.url.parse()?;
            if destination.path() != uri.path() {
                headers.insert(
                    "x-nextjs-rewritten-path",
                    HeaderValue::try_from(destination.path())?,
                );
            }
            if destination.query() != uri.query() {
                headers.insert(
                    "x-nextjs-rewritten-query",
                    HeaderValue::try_from(destination.query().unwrap_or(""))?,
                );
            }
        }
    } else if data {
        if let Some(location) = headers.remove(header::LOCATION) {
            headers.insert("x-nextjs-redirect", location);
        }
    }
    Ok(Effects { action, headers })
}

fn relative_location(value: &str, original_url: &str) -> Result<String> {
    if value.len() > crate::custom_routes::MAX_URL {
        bail!("middleware location exceeds URL bound");
    }
    let original = reqwest::Url::parse(original_url)?;
    Ok(match reqwest::Url::parse(value) {
        Ok(target) if target.origin() == original.origin() => format!(
            "{}{}{}",
            target.path(),
            target
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default(),
            target
                .fragment()
                .map(|fragment| format!("#{fragment}"))
                .unwrap_or_default()
        ),
        _ => value.to_owned(),
    })
}

fn rewrite_target(value: &str, original_url: &str) -> Result<crate::custom_routes::Target> {
    if value.len() > crate::custom_routes::MAX_URL {
        bail!("middleware rewrite exceeds URL bound");
    }
    let original = reqwest::Url::parse(original_url)?;
    let mut target = if value.starts_with('/') && !value.starts_with("//") {
        original.join(value)?
    } else {
        reqwest::Url::parse(value)?
    };
    if !matches!(target.scheme(), "http" | "https")
        || target.host_str().is_none()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        bail!("invalid middleware rewrite URL");
    }
    target.set_fragment(None);
    let external = target.origin() != original.origin();
    let url = if external {
        target.to_string()
    } else {
        format!(
            "{}{}",
            target.path(),
            target
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default()
        )
    };
    Ok(crate::custom_routes::Target { url, external })
}

pub(crate) fn wire_headers(headers: HeaderMap) -> Result<BTreeMap<String, HeaderValues>> {
    headers
        .keys()
        .map(|name| {
            Ok((
                name.to_string(),
                HeaderValues::Multiple(
                    headers
                        .get_all(name)
                        .iter()
                        .map(|value| String::from_utf8(value.as_bytes().to_vec()))
                        .collect::<std::result::Result<Vec<_>, _>>()?,
                ),
            ))
        })
        .collect()
}

/// These fields are produced only by a trusted middleware response. In
/// particular, clients cannot forge recursion bypasses or cookie propagation.
pub fn strip_incoming(headers: &mut HeaderMap) {
    let names = headers
        .keys()
        .filter(|name| name.as_str().starts_with("x-middleware-"))
        .cloned()
        .collect::<Vec<_>>();
    for name in names {
        headers.remove(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    fn headers(values: &[(&str, &str)]) -> HeaderMap {
        values
            .iter()
            .map(|(name, value)| {
                (
                    HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    HeaderValue::from_str(value).unwrap(),
                )
            })
            .collect()
    }
    fn wire(values: &[(&str, &str)]) -> BTreeMap<String, HeaderValues> {
        values
            .iter()
            .map(|(name, value)| (name.to_string(), (*value).into()))
            .collect()
    }
    fn manifest() -> MiddlewareManifest {
        serde_json::from_value(serde_json::json!({"module":"server/middleware.mjs","exportName":"default","convention":"middleware","runtime":"nodejs","matchers":[{"source":"/guard/:path*","regex":"^/guard(?:/.*)?$","keys":[],"has":[],"missing":[{"type":"header","key":"skip","captures":[]}]}]})).unwrap()
    }
    #[test]
    fn raw_middleware_normalization_allows_explicit_flight_header_overrides() {
        let mut request = headers(&[("rsc", "1"), ("next-router-state-tree", "original")]);
        effects(
            wire(&[
                ("x-middleware-next", "1"),
                ("x-middleware-override-headers", "rsc"),
                ("x-middleware-request-rsc", "changed"),
            ]),
            &mut request,
            "http://example.test/path",
            &"/path".parse().unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(request["rsc"], "changed");
        assert!(!request.contains_key("next-router-state-tree"));
    }

    #[test]
    fn matcher_and_manifest_validation_are_native_and_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let worker = WorkerConfig {
            node: directory.path().join("never-start"),
            script: directory.path().join("missing"),
            project: directory.path().into(),
            dist: directory.path().into(),
            cache: None,
        };
        let matcher = Middleware::new(Some(manifest()), worker.clone())
            .unwrap()
            .unwrap();
        assert!(matcher
            .matches(&"/guard/a".parse().unwrap(), &HeaderMap::new())
            .unwrap());
        assert!(!matcher
            .matches(&"/guard/a".parse().unwrap(), &headers(&[("skip", "1")]))
            .unwrap());
        assert!(!matcher
            .matches(&"/public.txt".parse().unwrap(), &HeaderMap::new())
            .unwrap());
        let mut empty = manifest();
        empty.matchers.clear();
        assert!(!Middleware::new(Some(empty), worker)
            .unwrap()
            .unwrap()
            .matches(&"/guard".parse().unwrap(), &HeaderMap::new())
            .unwrap());
        let mut invalid = manifest();
        invalid.module = "../escape.mjs".into();
        assert!(invalid.validate().is_err());
    }
    #[test]
    fn overrides_replace_request_headers_but_preserve_original_flight_transport() {
        let mut request = headers(&[
            ("host", "example.test"),
            ("cookie", "old=yes"),
            ("rsc", "1"),
            ("next-router-state-tree", "original"),
            ("x-rustyx-router-state", "original-rustyx"),
            ("x-middleware-subrequest", "middleware:middleware"),
            ("x-middleware-set-cookie", "forged=yes"),
        ]);
        strip_incoming(&mut request);
        assert!(!request.contains_key("x-middleware-subrequest"));
        let effects = effects(
            wire(&[
                ("x-middleware-next", "1"),
                (
                    "x-middleware-override-headers",
                    "x-added, cookie, rsc, content-length",
                ),
                ("x-middleware-request-x-added", "yes"),
                ("x-middleware-request-cookie", "fresh=yes"),
                ("x-middleware-request-rsc", "forged"),
                ("x-middleware-request-content-length", "999"),
                ("x-order", "middleware"),
                ("set-cookie", "out=yes; Path=/"),
                ("x-middleware-set-cookie", "out=yes; Path=/"),
            ]),
            &mut request,
            "http://example.test/path",
            &"/path".parse().unwrap(),
            true,
        )
        .unwrap();
        assert!(matches!(effects.action, Action::Next));
        assert!(!request.contains_key(header::HOST));
        assert!(!request.contains_key(header::CONTENT_LENGTH));
        assert_eq!(request[header::COOKIE], "fresh=yes");
        assert_eq!(request["rsc"], "1");
        assert_eq!(request["next-router-state-tree"], "original");
        assert_eq!(request["x-rustyx-router-state"], "original-rustyx");
        assert_eq!(request["x-order"], "middleware");
        assert_eq!(request["x-middleware-set-cookie"], "out=yes; Path=/");
        assert_eq!(effects.headers[header::SET_COOKIE], "out=yes; Path=/");
        assert!(!effects
            .headers
            .keys()
            .any(|name| name.as_str().starts_with("x-middleware-")));
        let mut unchanged = headers(&[("cookie", "original=yes")]);
        effects_for_empty(&mut unchanged);
        assert_eq!(unchanged[header::COOKIE], "original=yes");
    }
    fn effects_for_empty(request: &mut HeaderMap) {
        effects(
            wire(&[
                ("x-middleware-next", "1"),
                ("x-middleware-override-headers", ""),
            ]),
            request,
            "http://example.test/path",
            &"/path".parse().unwrap(),
            true,
        )
        .unwrap();
    }
    #[test]
    fn data_and_flight_rewrites_emit_transport_metadata_without_leaking_override_controls() {
        let mut request = headers(&[("x-nextjs-data", "1"), ("rsc", "1")]);
        let result = effects(
            wire(&[
                (
                    "x-middleware-rewrite",
                    "http://example.test/destination?from=middleware",
                ),
                ("connection", "x-secret"),
                ("x-secret", "hidden"),
            ]),
            &mut request,
            "http://example.test/source?old=1",
            &"/source?old=1".parse().unwrap(),
            true,
        )
        .unwrap();
        assert_eq!(
            result.headers["x-middleware-rewrite"],
            "/destination?from=middleware"
        );
        assert_eq!(
            result.headers["x-nextjs-rewrite"],
            "/destination?from=middleware"
        );
        assert_eq!(result.headers["x-nextjs-rewritten-path"], "/destination");
        assert_eq!(
            result.headers["x-nextjs-rewritten-query"],
            "from=middleware"
        );
        assert!(!request.contains_key("x-middleware-rewrite"));
        assert!(!result.headers.contains_key("x-secret"));
        let result = effects(
            wire(&[("location", "http://example.test/destination?ok=1#fragment")]),
            &mut request,
            "http://example.test/source",
            &"/source".parse().unwrap(),
            true,
        )
        .unwrap();
        assert!(matches!(result.action, Action::Response));
        assert!(!result.headers.contains_key(header::LOCATION));
        assert_eq!(
            result.headers["x-nextjs-redirect"],
            "/destination?ok=1#fragment"
        );
        let result = effects(
            wire(&[("x-middleware-rewrite", "https://upstream.test/path")]),
            &mut request,
            "http://example.test/source?_rsc=token",
            &"/source?_rsc=token".parse().unwrap(),
            true,
        )
        .unwrap();
        assert_eq!(
            result.headers["x-middleware-rewrite"],
            "https://upstream.test/path?_rsc=token"
        );
        assert!(!result.headers.contains_key("x-nextjs-rewritten-path"));
        assert!(rewrite_target("file:///private", "http://example.test/").is_err());
        assert!(
            rewrite_target("http://user:password@example.test/", "http://example.test/").is_err()
        );
    }
    #[tokio::test]
    async fn worker_upload_is_replayable_for_downstream_and_admission_precedes_buffering() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.mjs");
        std::fs::write(&script, r#"import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,status:200,headers:{'x-middleware-next':'1','x-seen-body':r.body,'x-seen-url':r.url,'x-seen-mode':r.renderMode},body:''})+'\n')}"#).unwrap();
        let worker = WorkerConfig {
            node: "node".into(),
            script,
            project: directory.path().into(),
            dist: directory.path().into(),
            cache: None,
        };
        let middleware = Middleware::new(Some(manifest()), worker).unwrap().unwrap();
        let mut reserved = Vec::new();
        for _ in 0..4 {
            reserved.push(middleware.slots.clone().try_acquire_owned().unwrap());
        }
        let request = Request::builder()
            .method("POST")
            .uri("/guard?x=1")
            .body(Body::from(vec![0, 255, 128, 1]))
            .unwrap();
        let (request, reply, permit) = middleware
            .execute(
                request,
                "http://example.test/_next/data/build/guard.json?x=1",
            )
            .await
            .unwrap();
        assert_eq!(reply.headers["x-seen-mode"].first(), Some("middleware"));
        assert_eq!(
            reply.headers["x-seen-url"].first(),
            Some("http://example.test/guard?x=1")
        );
        assert_eq!(
            STANDARD
                .decode(reply.headers["x-seen-body"].first().unwrap())
                .unwrap(),
            [0, 255, 128, 1]
        );
        assert_eq!(
            to_bytes(request.into_body(), 16).await.unwrap().as_ref(),
            &[0, 255, 128, 1]
        );
        drain_control(reply.body).await.unwrap();
        let polled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observe = polled.clone();
        let body = Body::from_stream(futures_util::stream::once(async move {
            observe.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"held"))
        }));
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            middleware.execute(Request::new(body), "http://example.test/")
        )
        .await
        .is_err());
        assert!(!polled.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(middleware.waiting.available_permits(), 64);
        // The cancelled waiter returned its admission, while an actually full
        // waiting population still rejects immediately before reading a body.
        let waiting = middleware
            .waiting
            .clone()
            .try_acquire_many_owned(64)
            .unwrap();
        let overloaded = middleware
            .execute(Request::new(Body::empty()), "http://example.test/")
            .await
            .err()
            .unwrap();
        assert_eq!(overloaded.status(), 503);
        assert_eq!(overloaded.headers()[header::RETRY_AFTER], "1");
        drop(waiting);
        drop(permit);
        drop(reserved);
        assert_eq!(middleware.slots.available_permits(), 5);
    }
    #[tokio::test]
    async fn final_streams_use_pool_admission_independently_of_replayable_uploads() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.mjs");
        std::fs::write(&script,r#"import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const{id}=JSON.parse(line);process.stdout.write(JSON.stringify({id,type:'head',status:200,headers:{}})+'\n');process.stdout.write(JSON.stringify({id,type:'chunk',length:1})+'\n');process.stdout.write(Buffer.from([42]));process.stdout.write(JSON.stringify({id,type:'end'})+'\n')}"#).unwrap();
        let middleware = Middleware::new(
            Some(manifest()),
            WorkerConfig {
                node: "node".into(),
                script,
                project: directory.path().into(),
                dist: directory.path().into(),
                cache: None,
            },
        )
        .unwrap()
        .unwrap();
        for consume in [true, false] {
            let (request, reply, upload) = middleware
                .execute(Request::new(Body::empty()), "http://example.test/")
                .await
                .unwrap();
            drop(request);
            drop(upload);
            assert_eq!(middleware.slots.available_permits(), 5);
            assert_eq!(middleware.worker_slots.available_permits(), 3);
            if consume {
                drain_control(reply.body).await.unwrap();
            } else {
                drop(reply);
            }
            tokio::time::timeout(Duration::from_secs(1), async {
                while middleware.worker_slots.available_permits() != 4 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
        }
        assert!(
            drain_control(RenderedBody::Buffered(vec![0; 64 * 1024 + 1]))
                .await
                .is_err()
        );
    }
}
