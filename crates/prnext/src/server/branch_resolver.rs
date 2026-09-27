//! Private, bounded probes through the ordinary native routing pipeline.
//! The marker is a Rust extension, never an HTTP header accepted from clients.
use super::*;
use serde::{Deserialize, Serialize};
use std::sync::{OnceLock, Weak};
use tokio::{
    sync::Semaphore,
    task::JoinHandle,
    time::{timeout, Duration},
};

#[derive(Clone, Copy)]
pub(super) struct Probe;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolved {
    route_id: String,
    url: String,
    headers: BTreeMap<String, String>,
}

pub(super) struct Service {
    pub credentials: crate::pool::RoutingResolver,
    state: Arc<OnceLock<Weak<AppState>>>,
    task: JoinHandle<()>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Service {
    pub fn attach(&self, state: &Arc<AppState>) {
        let _ = self.state.set(Arc::downgrade(state));
    }
    pub async fn start() -> Result<Self> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random)?;
        let token = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let credentials = crate::pool::RoutingResolver {
            url: format!("http://{}/resolve", listener.local_addr()?),
            token: token.clone(),
        };
        let state = Arc::new(OnceLock::new());
        let app = Router::new()
            .route("/resolve", axum::routing::post(handle))
            .with_state(Arc::new(Bridge {
                token,
                state: state.clone(),
                slots: Arc::new(Semaphore::new(8)),
            }));
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::error!(%error, "private routing resolver stopped");
            }
        });
        Ok(Self {
            credentials,
            state,
            task,
        })
    }
}
struct Bridge {
    token: String,
    state: Arc<OnceLock<Weak<AppState>>>,
    slots: Arc<Semaphore>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    url: String,
    headers: BTreeMap<String, String>,
}

async fn handle(State(bridge): State<Arc<Bridge>>, request: Request) -> Response<Body> {
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    if supplied.len() != bridge.token.len()
        || supplied
            .bytes()
            .zip(bridge.token.bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            != 0
    {
        return error_response(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let Ok(_permit) = bridge.slots.clone().try_acquire_owned() else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Routing resolver is busy");
    };
    let Some(state) = bridge.state.get().and_then(Weak::upgrade) else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Routing resolver is unavailable",
        );
    };
    match timeout(Duration::from_secs(5), probe(state, request)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            tracing::warn!(%error, "routing probe failed");
            error_response(StatusCode::BAD_REQUEST, "Invalid routing probe")
        }
        Err(_) => error_response(StatusCode::GATEWAY_TIMEOUT, "Routing probe timed out"),
    }
}
async fn probe(state: Arc<AppState>, request: Request) -> Result<Response<Body>> {
    let input: Input = serde_json::from_slice(&to_bytes(request.into_body(), 96 * 1024).await?)?;
    if input.url.len() > crate::custom_routes::MAX_URL
        || !input.url.starts_with('/')
        || input.url.starts_with("//")
        || input.url.contains(['\\', '#'])
    {
        bail!("invalid routing probe URL");
    }
    if input
        .headers
        .iter()
        .map(|(key, value)| key.len() + value.len() + 4)
        .sum::<usize>()
        > 64 * 1024
    {
        bail!("routing probe headers exceed 64 KiB");
    }
    let mut routed = Request::builder()
        .method(Method::GET)
        .uri(input.url)
        .body(Body::empty())?;
    for (name, value) in input.headers {
        routed.headers_mut().insert(
            HeaderName::from_bytes(name.as_bytes())?,
            HeaderValue::from_str(&value)?,
        );
    }
    // Probe only the saved GET URL. It carries no action body or routing state,
    // and can never recursively invoke this bridge through the render worker.
    for name in [
        "x-prnext-router-state",
        "next-action",
        "content-length",
        "content-type",
        "transfer-encoding",
    ] {
        routed.headers_mut().remove(name);
    }
    routed.extensions_mut().insert(Probe);
    let response = handle_inner(state, routed).await?;
    let body = serde_json::to_vec(&serde_json::json!({
        "status": response.status().as_u16(),
        "resolved": response.extensions().get::<Resolved>(),
        "responseHeaders": crate::middleware::wire_headers(response.headers().clone())?,
    }))?;
    if body.len() > 192 * 1024 {
        bail!("routing probe response exceeds 192 KiB");
    }
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))?)
}

pub(super) async fn forward_or_probe(
    state: &AppState,
    request: Request,
    target: &str,
) -> Result<Response<Body>> {
    if request.extensions().get::<Probe>().is_some() {
        return Ok(Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header(header::LOCATION, target)
            .body(Body::empty())?);
    }
    state.proxy.forward(request, target).await
}

pub(super) async fn resolve(state: &AppState, request: Request) -> Result<Response<Body>> {
    let denied = || error_response(StatusCode::NOT_FOUND, "Not an App page");
    if state
        .images
        .as_ref()
        .is_some_and(|images| images.matches(request.uri().path()))
        || asset_path(&state.config, request.uri().path()).is_some()
        || request
            .extensions()
            .get::<RoutingContext>()
            .is_some_and(|context| context.data)
    {
        return Ok(denied());
    }
    let Some(internal) = mounted_path(request.uri().path(), &state.config.base_path) else {
        return Ok(denied());
    };
    let parts = decode_path(internal)?;
    let path = format!("/{}", parts.join("/"));
    if parts
        .first()
        .is_some_and(|part| part == "_prnext" || part == "_next")
    {
        return Ok(denied());
    }
    let Some((route, _)) = state.routes.resolve(&path, &parts) else {
        return Ok(denied());
    };
    if route.kind != RouteKind::Page
        || route.router.as_deref() != Some("app")
        || !route.allows(&path)
    {
        return Ok(denied());
    }
    if let Some(public) = &state.public {
        if contained_file(public, path.trim_start_matches('/'))
            .await?
            .is_some()
        {
            return Ok(denied());
        }
    }
    let mut response = Response::new(Body::empty());
    response.extensions_mut().insert(Resolved {
        route_id: route.id.clone(),
        url: format!(
            "{internal}{}",
            request
                .uri()
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default()
        ),
        headers: request_headers(request.headers()),
    });
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn private_bridge_authenticates_and_resolves_without_starting_a_render_worker() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_owned();
        let service = Service::start().await.unwrap();
        let page: Route = serde_json::from_value(serde_json::json!({
            "id":"page", "pattern":"/page", "kind":"page", "module":"missing.cjs", "router":"app"
        }))
        .unwrap();
        let state = Arc::new(AppState {
            routing_resolver: Some(service.credentials.clone()),
            images: None,
            dist: root.clone(),
            public: None,
            assets: None,
            routes: RouteTable::new(vec![page]).unwrap(),
            prerendered: HashMap::new(),
            pool: WorkerPool::new(
                WorkerConfig {
                    node: root.join("missing-node"),
                    script: root.join("missing-worker"),
                    project: root.clone(),
                    dist: root,
                    cache: None,
                },
                1,
            ),
            render_admission: super::super::admission::Admission::new(1),
            api_admission: super::super::admission::Admission::new(1),
            default_host: "localhost".into(),
            build_id: Some("test".into()),
            preview_mode_id: None,
            dev: None,
            pages: None,
            custom: Default::default(),
            proxy: Default::default(),
            middleware: None,
            config: Default::default(),
            errors: Default::default(),
        });
        service.attach(&state);
        let client = reqwest::Client::new();
        let input = serde_json::json!({"url":"/page?part=one&part=two", "headers":{"cookie":"auth=yes", "next-action":"untrusted", "x-prnext-router-state":"untrusted"}}).to_string();
        for token in ["".to_owned(), "x".repeat(64)] {
            let response = client
                .post(&service.credentials.url)
                .bearer_auth(token)
                .body(input.clone())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let response = client
            .post(&service.credentials.url)
            .bearer_auth(&service.credentials.token)
            .body(input)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(body["status"], 200);
        assert_eq!(body["resolved"]["routeId"], "page");
        assert_eq!(body["resolved"]["url"], "/page?part=one&part=two");
        assert_eq!(body["resolved"]["headers"]["cookie"], "auth=yes");
        assert!(body["resolved"]["headers"].get("next-action").is_none());
        assert!(body["resolved"]["headers"]
            .get("x-prnext-router-state")
            .is_none());
        for input in [
            serde_json::json!({"url":"http://external.invalid/page", "headers":{}}).to_string(),
            serde_json::json!({"url":"/page", "headers":{"large":"x".repeat(65 * 1024)}})
                .to_string(),
            serde_json::json!({"url":"/page", "headers":{}, "method":"POST"}).to_string(),
        ] {
            let response = client
                .post(&service.credentials.url)
                .bearer_auth(&service.credentials.token)
                .body(input)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        // A normal HTTP request still needs the renderer; only the private
        // endpoint can attach the Rust extension that bypasses execution.
        let normal = handle_inner(
            state.clone(),
            Request::builder().uri("/page").body(Body::empty()).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(normal.status(), StatusCode::BAD_GATEWAY);
        drop(state);
        let response = client
            .post(&service.credentials.url)
            .bearer_auth(&service.credentials.token)
            .body("{\"url\":\"/page\",\"headers\":{}}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
