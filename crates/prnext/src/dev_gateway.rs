//! Stable development listener. Lifecycle RPC travels over inherited stdio;
//! HTTP bodies remain in Rust and each response leases its selected generation.
use anyhow::{bail, Context, Result};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, Response, StatusCode},
    Router,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::future::IntoFuture;
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};
use tokio::sync::{oneshot, Notify, Semaphore};
use tower::ServiceExt;

struct Generation {
    id: String,
    port: u16,
    dist: PathBuf,
    active: AtomicUsize,
    changed: Notify,
}
struct Lease(Arc<Generation>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_waiters();
    }
}
struct ClientLease {
    client: String,
    connection: u64,
}
impl Drop for ClientLease {
    fn drop(&mut self) {
        let _ = emit(&json!({"type":"close","client":self.client,"connection":self.connection}));
    }
}
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
struct PendingLease {
    id: u64,
    pending: Pending,
}
impl Drop for PendingLease {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}
struct App {
    root: PathBuf,
    current: RwLock<Option<Arc<Generation>>>,
    generations: RwLock<Vec<Arc<Generation>>>,
    proxy: crate::proxy::Proxy,
    dev: crate::dev::DevState,
    pending: Pending,
    sequence: AtomicU64,
    requests: Arc<Semaphore>,
    traffic: Arc<Semaphore>,
}
fn emit(value: &Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{value}")?;
    out.flush()
}
fn error(status: StatusCode, message: impl Into<String>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(message.into()))
        .unwrap()
}
fn valid_path(path: &str) -> bool {
    path.len() <= 8192
        && path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains(['\\', '\r', '\n', '\0'])
        && crate::routing::decode_path(path.split('?').next().unwrap_or("/")).is_ok()
}
async fn ensure(app: &Arc<App>, path: &str, client: Option<String>) -> Result<Value> {
    if !valid_path(path) {
        bail!("Invalid development request path");
    }
    let _permit = app
        .requests
        .clone()
        .try_acquire_owned()
        .context("Development compilation queue is full")?;
    let id = app.sequence.fetch_add(1, Ordering::Relaxed);
    let (send, receive) = oneshot::channel();
    app.pending.lock().unwrap().insert(id, send);
    let _pending = PendingLease {
        id,
        pending: app.pending.clone(),
    };
    emit(&json!({"type":"ensure","id":id,"path":path,"client":client}))?;
    let value = tokio::time::timeout(Duration::from_secs(120), receive)
        .await
        .context("Development compilation timed out")??;
    if value.get("error").is_some() {
        bail!(
            "{}",
            value["error"].as_str().unwrap_or("Compilation failed")
        );
    }
    Ok(value)
}
async fn asset(app: &App, request: Request, suffix: &str) -> Response<Body> {
    let Ok(parts) = crate::routing::decode_path(&format!("/{suffix}")) else {
        return error(StatusCode::BAD_REQUEST, "Invalid asset path");
    };
    let generations = app.generations.read().unwrap().clone();
    for generation in generations.iter().rev() {
        let directory = generation.dist.join("assets");
        let mut candidate = directory.clone();
        for part in &parts {
            candidate.push(part);
        }
        let Ok(file) = tokio::fs::canonicalize(candidate).await else {
            continue;
        };
        if !file.starts_with(&directory) {
            return error(StatusCode::FORBIDDEN, "Asset outside build directory");
        }
        if !tokio::fs::metadata(&file)
            .await
            .is_ok_and(|info| info.is_file())
        {
            continue;
        }
        generation.active.fetch_add(1, Ordering::AcqRel);
        let lease = Lease(generation.clone());
        let response = tower_http::services::ServeFile::new(file)
            .oneshot(request)
            .await
            .unwrap()
            .map(Body::new);
        let (parts, body) = response.into_parts();
        let stream = futures_util::stream::unfold(
            (body.into_data_stream(), lease),
            |(mut source, lease)| async move { source.next().await.map(|next| (next, (source, lease))) },
        );
        return Response::from_parts(parts, Body::from_stream(stream));
    }
    error(StatusCode::NOT_FOUND, "Development asset not found")
}
async fn handle(State(app): State<Arc<App>>, request: Request) -> Response<Body> {
    let Ok(permit) = app.traffic.clone().try_acquire_owned() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Development server is busy",
        );
    };
    let response = handle_request(app, request).await;
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (body.into_data_stream(), permit),
        |(mut source, permit)| async move { source.next().await.map(|next| (next, (source, permit))) },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}
async fn handle_request(app: Arc<App>, request: Request) -> Response<Body> {
    if request.uri().scheme().is_some()
        || request.uri().authority().is_some()
        || !valid_path(&request.uri().to_string())
    {
        return error(StatusCode::BAD_REQUEST, "Invalid local request path");
    }
    let path = request.uri().path().to_owned();
    let query = reqwest::Url::parse(&format!("http://local{}", request.uri())).ok();
    let parameter = |name: &str| {
        query.as_ref().and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
        })
    };
    let client = parameter("client").filter(|value| {
        !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    if path.ends_with("/_prnext/dev") {
        let response = app.dev.response(request.method(), request.headers());
        if response.status() != StatusCode::OK {
            return response;
        }
        let lease = client.and_then(|client| {
            parameter("path")
                .filter(|path| valid_path(path))
                .map(|path| {
                    let connection = app.sequence.fetch_add(1, Ordering::Relaxed);
                    let _ = emit(
                        &json!({"type":"open","client":client,"path":path,"connection":connection}),
                    );
                    ClientLease { client, connection }
                })
        });
        let (parts, body) = response.into_parts();
        let stream = futures_util::stream::unfold(
            (body.into_data_stream(), lease),
            |(mut source, lease)| async move { source.next().await.map(|next| (next, (source, lease))) },
        );
        return Response::from_parts(parts, Body::from_stream(stream));
    }
    if let Some((_, suffix)) = path.split_once("/_prnext/assets/") {
        return asset(&app, request, suffix).await;
    }
    let explicit = path.ends_with("/_prnext/ensure");
    let requested = if explicit {
        if request.method() != axum::http::Method::GET {
            return error(StatusCode::METHOD_NOT_ALLOWED, "GET required");
        }
        if request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
        {
            return error(StatusCode::FORBIDDEN, "Cross-site development request");
        }
        reqwest::Url::parse(&format!("http://local{}", request.uri()))
            .ok()
            .and_then(|url| {
                url.query_pairs()
                    .find(|(name, _)| name == "path")
                    .map(|(_, value)| value.into_owned())
            })
            .unwrap_or_default()
    } else {
        request
            .uri()
            .path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("/")
            .to_owned()
    };
    if !valid_path(&requested) {
        return error(StatusCode::BAD_REQUEST, "Invalid development request path");
    }
    let value = match ensure(&app, &requested, client).await {
        Ok(value) => value,
        Err(failure) => {
            if !explicit && request.method() == axum::http::Method::GET {
                let previous_build = app.current.read().unwrap().as_ref().map(|g| g.id.clone());
                let previous_build = serde_json::to_string(&previous_build).unwrap();
                let details = failure
                    .to_string()
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;");
                return Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).header(header::CONTENT_TYPE,"text/html; charset=utf-8").header(header::CACHE_CONTROL,"no-store").body(Body::from(format!("<!doctype html><html><head><title>PRNext development error</title></head><body><pre>{details}</pre><script>const previous={previous_build},source=new EventSource('/_prnext/dev');source.onmessage=e=>{{try{{const next=JSON.parse(e.data);if(next.state==='ready'&&next.buildId!==previous)location.reload()}}catch{{}}}};</script></body></html>"))).unwrap();
            }
            return error(StatusCode::INTERNAL_SERVER_ERROR, failure.to_string());
        }
    };
    if explicit {
        return Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(value.to_string()))
            .unwrap();
    }
    let selected = app.current.read().unwrap().clone();
    let Some(generation) = selected else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Development server is compiling",
        );
    };
    if generation
        .active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 512).then_some(n + 1)
        })
        .is_err()
    {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Development server is busy",
        );
    }
    let lease = Lease(generation);
    let destination = format!("http://127.0.0.1:{}{}", lease.0.port, request.uri());
    if request.headers().contains_key(header::UPGRADE) {
        return app
            .proxy
            .websocket(
                request,
                &destination,
                true,
                false,
                lease,
                std::future::pending(),
            )
            .await
            .unwrap_or_else(|e| error(StatusCode::BAD_GATEWAY, e.to_string()));
    }
    let response = match app.proxy.forward_persistent(request, &destination).await {
        Ok(response) => response,
        Err(e) => return error(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (body.into_data_stream(), lease),
        |(mut source, lease)| async move { source.next().await.map(|next| (next, (source, lease))) },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}
async fn command(app: &Arc<App>, input: &Value) -> Result<Value> {
    match input["command"].as_str().context("Missing command")? {
        "result" => {
            let id = input["request"].as_u64().context("Missing request ID")?;
            if let Some(sender) = app.pending.lock().unwrap().remove(&id) {
                let _ = sender.send(input["value"].clone());
            }
            Ok(json!(true))
        }
        "activate" => {
            let id = input["generation"]
                .as_str()
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
                .context("Invalid generation")?;
            let port = input["port"]
                .as_u64()
                .filter(|port| *port > 0 && *port <= 65535)
                .context("Invalid backend port")? as u16;
            let relative = input["directory"]
                .as_str()
                .context("Missing build directory")?;
            let dist = crate::build_directory::resolve_selected(&app.root, Some(relative)).await?;
            let manifest = crate::manifest::Manifest::load(&dist).await?;
            if !manifest.dev {
                bail!("Development gateway requires a development build");
            }
            let mut generations = app.generations.write().unwrap();
            if generations.len() >= 16 || generations.iter().any(|g| g.id == id) {
                bail!("Too many or duplicate development generations");
            }
            let next = Arc::new(Generation {
                id: id.to_owned(),
                port,
                dist,
                active: AtomicUsize::new(0),
                changed: Notify::new(),
            });
            generations.push(next.clone());
            *app.current.write().unwrap() = Some(next);
            Ok(json!(true))
        }
        "retire" => {
            let id = input["generation"].as_str().context("Missing generation")?;
            let old = app
                .generations
                .read()
                .unwrap()
                .iter()
                .find(|g| g.id == id)
                .cloned();
            if let Some(old) = old {
                if app
                    .current
                    .read()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|g| g.id == id)
                {
                    bail!("Cannot retire current generation");
                }
                tokio::time::timeout(Duration::from_secs(30), async {
                    loop {
                        let changed = old.changed.notified();
                        if old.active.load(Ordering::Acquire) == 0 {
                            break;
                        }
                        changed.await;
                    }
                })
                .await
                .context("Development generation still has active requests")?;
            }
            Ok(json!(true))
        }
        "forget" => {
            let id = input["generation"].as_str().context("Missing generation")?;
            if app
                .current
                .read()
                .unwrap()
                .as_ref()
                .is_some_and(|g| g.id == id)
            {
                bail!("Cannot forget current generation");
            }
            app.generations
                .write()
                .unwrap()
                .retain(|g| g.id != id || g.active.load(Ordering::Acquire) > 0);
            Ok(json!(true))
        }
        _ => bail!("Unknown development command"),
    }
}
pub async fn run(root: &Path, hostname: &str, port: u16) -> Result<()> {
    let root = tokio::fs::canonicalize(root).await?;
    let listener = tokio::net::TcpListener::bind((hostname, port)).await?;
    let address = listener.local_addr()?;
    let app = Arc::new(App {
        dev: crate::dev::DevState::new(&root, None),
        root,
        current: RwLock::new(None),
        generations: RwLock::new(Vec::new()),
        proxy: crate::proxy::Proxy::persistent(),
        pending: Arc::new(Mutex::new(HashMap::new())),
        sequence: AtomicU64::new(1),
        requests: Arc::new(Semaphore::new(64)),
        traffic: Arc::new(Semaphore::new(512)),
    });
    let (send, mut receive) = tokio::sync::mpsc::channel(64);
    std::thread::spawn(move || {
        let input = io::stdin();
        let mut reader = input.lock();
        loop {
            let mut line = Vec::new();
            let mut limited = (&mut reader).take(65537);
            use std::io::Read;
            match limited.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 65536 => break,
                _ => {}
            };
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                break;
            };
            if send.blocking_send(value).is_err() {
                break;
            }
        }
    });
    let (shutdown, stop) = oneshot::channel();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new().fallback(handle).with_state(app.clone()),
        )
        .with_graceful_shutdown(async {
            let _ = stop.await;
        })
        .into_future(),
    );
    emit(&json!({"type":"ready","protocol":1,"port":address.port(),"pid":std::process::id()}))?;
    while let Some(input) = receive.recv().await {
        // A retire may wait on responses whose compilation result is still in
        // flight. Never block the inherited control reader behind that wait.
        let app = app.clone();
        tokio::spawn(async move {
            let id = input["id"].clone();
            let output = match command(&app, &input).await {
                Ok(value) => json!({"id":id,"ok":true,"value":value}),
                Err(error) => json!({"id":id,"ok":false,"error":error.to_string()}),
            };
            let _ = emit(&output);
        });
    }
    app.dev.close();
    app.pending.lock().unwrap().clear();
    let _ = shutdown.send(());
    if tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .is_err()
    {
        bail!("Development gateway shutdown timed out");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app(root: &Path) -> Arc<App> {
        Arc::new(App {
            root: root.canonicalize().unwrap(),
            current: RwLock::new(None),
            generations: RwLock::new(Vec::new()),
            proxy: crate::proxy::Proxy::persistent(),
            dev: crate::dev::DevState::new(root, None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            sequence: AtomicU64::new(1),
            requests: Arc::new(Semaphore::new(64)),
            traffic: Arc::new(Semaphore::new(1)),
        })
    }
    #[test]
    fn only_bounded_origin_paths_are_valid() {
        for path in ["/", "/docs/a?view=one", "/%E2%9C%93"] {
            assert!(valid_path(path), "{path}");
        }
        for path in [
            "",
            "https://other/",
            "//other/",
            "/../private",
            "/%2e%2e/private",
            "/bad%zz",
            "/a%2fb",
            "/a\\b",
        ] {
            assert!(!valid_path(path), "{path}");
        }
        assert!(!valid_path(&format!("/{}", "a".repeat(8192))));
    }
    #[tokio::test]
    async fn control_paths_reject_invalid_requests_before_compilation_and_bound_live_bodies() {
        let root = tempfile::tempdir().unwrap();
        let app = app(root.path());
        for (method, uri, site, expected) in [
            (
                "POST",
                "/_prnext/ensure?path=/",
                "same-origin",
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                "GET",
                "/_prnext/ensure?path=/",
                "cross-site",
                StatusCode::FORBIDDEN,
            ),
            (
                "GET",
                "/_prnext/ensure?path=https://other/",
                "same-origin",
                StatusCode::BAD_REQUEST,
            ),
            (
                "GET",
                "/_prnext/ensure",
                "same-origin",
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(uri)
                .header("sec-fetch-site", site)
                .body(Body::empty())
                .unwrap();
            assert_eq!(handle(State(app.clone()), request).await.status(), expected);
        }
        let live = handle(
            State(app.clone()),
            Request::builder()
                .uri("/_prnext/dev")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(live.status(), StatusCode::OK);
        let busy = handle(
            State(app.clone()),
            Request::builder()
                .uri("/_prnext/dev")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(live);
        assert_eq!(app.traffic.available_permits(), 1);
        app.dev.close();
    }
    #[tokio::test]
    async fn retained_assets_hold_generation_leases_and_retirement_waits_for_them() {
        let root = tempfile::tempdir().unwrap();
        let app = app(root.path());
        let dist = root.path().canonicalize().unwrap().join("snapshot");
        tokio::fs::create_dir_all(dist.join("assets"))
            .await
            .unwrap();
        tokio::fs::write(dist.join("assets/test.js"), b"retained asset")
            .await
            .unwrap();
        let generation = Arc::new(Generation {
            id: "old".into(),
            port: 1,
            dist,
            active: AtomicUsize::new(0),
            changed: Notify::new(),
        });
        app.generations.write().unwrap().push(generation.clone());
        let response = asset(
            &app,
            Request::builder()
                .uri("/_prnext/assets/test.js")
                .body(Body::empty())
                .unwrap(),
            "test.js",
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(generation.active.load(Ordering::Acquire), 1);
        let retire_app = app.clone();
        let retire = tokio::spawn(async move {
            command(&retire_app, &json!({"command":"retire","generation":"old"})).await
        });
        tokio::task::yield_now().await;
        assert!(!retire.is_finished());
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()
                .as_ref(),
            b"retained asset"
        );
        retire.await.unwrap().unwrap();
        *app.current.write().unwrap() = Some(generation);
        assert!(
            command(&app, &json!({"command":"retire","generation":"old"}))
                .await
                .is_err()
        );
        assert!(
            command(&app, &json!({"command":"forget","generation":"old"}))
                .await
                .is_err()
        );
        app.dev.close();
    }
}
