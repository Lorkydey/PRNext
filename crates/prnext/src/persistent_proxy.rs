//! The persistent manager's HTTP data plane. Commands use inherited stdio,
//! never an HTTP administration endpoint. Application JavaScript stays in its
//! existing isolated backend; the Node supervisor only manages lifecycle/logs.
mod listener;
use anyhow::{bail, Context, Result};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, Response, StatusCode},
    Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};
use tokio::{
    sync::{watch, Notify, Semaphore},
    task::JoinHandle,
};

struct Generation {
    port: u16,
    active: AtomicUsize,
    changed: Notify,
    cancel: watch::Sender<bool>,
}
struct Lease(Arc<Generation>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_waiters();
    }
}
struct App {
    current: RwLock<Option<Arc<Generation>>>,
    generations: Mutex<HashMap<String, Arc<Generation>>>,
    proxy: crate::proxy::Proxy,
    close: watch::Sender<bool>,
    server: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}
type Apps = Arc<tokio::sync::Mutex<HashMap<String, Arc<App>>>>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: u64,
    command: String,
    app: Option<String>,
    generation: Option<String>,
    hostname: Option<String>,
    port: Option<u16>,
    timeout: Option<u64>,
}
fn unavailable(code: StatusCode, message: &'static str) -> Response<Body> {
    Response::builder()
        .status(code)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::RETRY_AFTER, "1")
        .body(Body::from(message))
        .unwrap()
}
async fn handle(State(app): State<Arc<App>>, request: Request) -> Response<Body> {
    if request.uri().scheme().is_some()
        || request.uri().authority().is_some()
        || crate::routing::decode_path(request.uri().path()).is_err()
    {
        return unavailable(StatusCode::BAD_REQUEST, "Invalid local request path");
    }
    let lease = {
        let current = app.current.read().unwrap();
        let Some(generation) = current.as_ref() else {
            return unavailable(StatusCode::SERVICE_UNAVAILABLE, "Application is restarting");
        };
        if generation
            .active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 512).then_some(n + 1)
            })
            .is_err()
        {
            return unavailable(StatusCode::SERVICE_UNAVAILABLE, "Application is busy");
        }
        Lease(generation.clone())
    };
    let mut cancelled = lease.0.cancel.subscribe();
    if *cancelled.borrow() {
        return unavailable(StatusCode::SERVICE_UNAVAILABLE, "Application is stopping");
    }
    let destination = format!(
        "http://127.0.0.1:{}{}",
        lease.0.port,
        request
            .uri()
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/")
    );
    if request.headers().contains_key(header::UPGRADE) {
        return app
            .proxy
            .websocket(request, &destination, true, false, lease, async move {
                loop {
                    if *cancelled.borrow() {
                        break;
                    }
                    if cancelled.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| {
                unavailable(StatusCode::BAD_GATEWAY, "WebSocket backend unavailable")
            });
    }
    let response = tokio::select! {
        result=app.proxy.forward_persistent(request,&destination)=>match result {Ok(response)=>response,Err(_)=>return unavailable(StatusCode::BAD_GATEWAY,"Application connection closed")},
        _=cancelled.changed()=>return unavailable(StatusCode::SERVICE_UNAVAILABLE,"Application is stopping"),
    };
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        Some((body.into_data_stream(), cancelled, lease)),
        |state| async move {
            let (mut source, mut cancelled, lease) = state?;
            let aborted = || {
                Some((
                    Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "Persistent generation drain deadline exceeded",
                    )),
                    None,
                ))
            };
            if *cancelled.borrow() {
                return aborted();
            }
            let next =
                tokio::select! {value=source.next()=>value,_=cancelled.changed()=>return aborted()};
            next.map(|bytes| {
                (
                    bytes.map_err(io::Error::other),
                    Some((source, cancelled, lease)),
                )
            })
        },
    );
    Response::from_parts(parts, Body::from_stream(stream.fuse()))
}
fn app_name(input: &Input) -> Result<&str> {
    let name = input.app.as_deref().context("Application name required")?;
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        bail!("Invalid application name");
    }
    Ok(name)
}
async fn execute(input: &Input, apps: &Apps) -> Result<Value> {
    let name = app_name(input)?;
    if input.command == "listen" {
        let mut apps = apps.lock().await;
        if apps.contains_key(name) {
            bail!("Application already has a listener");
        }
        if apps.len() >= 128 {
            bail!("Too many applications");
        }
        let host = input.hostname.as_deref().context("Hostname required")?;
        if host.len() > 253 || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
            bail!("Invalid hostname");
        }
        let port = input.port.context("Port required")?;
        let listener = tokio::net::TcpListener::bind((host, port)).await?;
        let port = listener.local_addr()?.port();
        let (close, mut closed) = watch::channel(false);
        let app = Arc::new(App {
            current: RwLock::new(None),
            generations: Mutex::new(HashMap::new()),
            proxy: crate::proxy::Proxy::persistent(),
            close,
            server: tokio::sync::Mutex::new(None),
        });
        let router = Router::new().fallback(handle).with_state(app.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener::LimitedListener::new(listener), router)
                .with_graceful_shutdown(async move {
                    let _ = closed.changed().await;
                })
                .await;
        });
        *app.server.lock().await = Some(task);
        apps.insert(name.to_owned(), app);
        return Ok(json!({"port":port}));
    }
    let app = apps
        .lock()
        .await
        .get(name)
        .cloned()
        .context("Application listener not found")?;
    match input.command.as_str() {
        "activate" => {
            let id = input.generation.as_deref().context("Generation required")?;
            if id.is_empty() || id.len() > 256 || id.chars().any(|c| c.is_control()) {
                bail!("Invalid generation");
            }
            let port = input
                .port
                .filter(|p| *p > 0)
                .context("Backend port required")?;
            let (cancel, _) = watch::channel(false);
            let generation = Arc::new(Generation {
                port,
                active: AtomicUsize::new(0),
                changed: Notify::new(),
                cancel,
            });
            let mut generations = app.generations.lock().unwrap();
            if let Some(existing) = generations.get(id) {
                if existing.port != port || *existing.cancel.borrow() {
                    bail!("Generation cannot be reactivated");
                }
                *app.current.write().unwrap() = Some(existing.clone());
                return Ok(json!({"active":true}));
            }
            if generations.len() >= 64 {
                bail!("Retirement backlog full");
            }
            generations.insert(id.to_owned(), generation.clone());
            *app.current.write().unwrap() = Some(generation);
            Ok(json!({"active":true}))
        }
        "pause" => {
            let selected = input
                .generation
                .as_ref()
                .map(|id| app.generations.lock().unwrap().get(id).cloned());
            let mut current = app.current.write().unwrap();
            if selected.is_none()
                || selected.flatten().as_ref().is_some_and(|selected| {
                    current
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, selected))
                })
            {
                *current = None;
            }
            Ok(json!({"active":current.is_some()}))
        }
        "status" => Ok(
            json!({"generations":app.generations.lock().unwrap().iter().map(|(id,g)|(id.clone(),g.active.load(Ordering::Acquire))).collect::<HashMap<_,_>>()}),
        ),
        "retire" => {
            let id = input.generation.as_deref().context("Generation required")?;
            let generation = app.generations.lock().unwrap().get(id).cloned();
            if let Some(generation) = generation {
                if app
                    .current
                    .read()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &generation))
                {
                    bail!(
                        "Cannot retire the active generation before switching or pausing traffic"
                    );
                }
                let waiting = async {
                    loop {
                        let notified = generation.changed.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if generation.active.load(Ordering::Acquire) == 0 {
                            break;
                        }
                        notified.await;
                    }
                };
                let drained = tokio::time::timeout(
                    Duration::from_millis(input.timeout.unwrap_or(0).min(60000)),
                    waiting,
                )
                .await
                .is_ok();
                generation.cancel.send_replace(true);
                app.generations.lock().unwrap().remove(id);
                app.proxy
                    .forget_origin(&format!("http://127.0.0.1:{}", generation.port));
                Ok(json!({"drained":drained}))
            } else {
                Ok(json!({"drained":true}))
            }
        }
        "close" => {
            apps.lock().await.remove(name);
            *app.current.write().unwrap() = None;
            for generation in app.generations.lock().unwrap().values() {
                generation.cancel.send_replace(true);
            }
            app.close.send_replace(true);
            if let Some(mut task) = app.server.lock().await.take() {
                if tokio::time::timeout(Duration::from_secs(2), &mut task)
                    .await
                    .is_err()
                {
                    task.abort();
                    let _ = task.await;
                }
            }
            Ok(json!({"closed":true}))
        }
        _ => bail!("Unknown proxy command"),
    }
}
fn reply(output: &Mutex<io::Stdout>, value: Value) {
    let mut output = output.lock().unwrap();
    let _ = writeln!(output, "{value}");
    let _ = output.flush();
}
pub async fn run() -> Result<()> {
    let apps: Apps = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let output = Arc::new(Mutex::new(io::stdout()));
    let (sender, mut incoming) = tokio::sync::mpsc::channel(32);
    // A bounded native thread owns blocking stdin. EOF remains observable while
    // HTTP tasks run, and process exit never waits for Tokio's blocking pool.
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut line = Vec::new();
            let read = input.by_ref().take(65537).read_until(b'\n', &mut line);
            match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.len() > 65536 || line.last() != Some(&b'\n') {
                        break;
                    }
                    if sender.blocking_send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    reply(&output, json!({"type":"ready","protocol":1}));
    let pending = Arc::new(Semaphore::new(32));
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = incoming.recv().await {
        let input: Input =
            serde_json::from_slice(&line).context("Invalid private proxy command")?;
        let permit = pending
            .clone()
            .try_acquire_owned()
            .context("Too many outstanding proxy commands")?;
        let apps = apps.clone();
        let output = output.clone();
        tasks.spawn(async move {
            let _permit = permit;
            let result = execute(&input, &apps).await;
            reply(
                &output,
                match result {
                    Ok(value) => json!({"id":input.id,"ok":true,"value":value}),
                    Err(error) => json!({"id":input.id,"ok":false,"error":error.to_string()}),
                },
            );
        });
        while tasks.try_join_next().is_some() {}
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    for app in apps.lock().await.values() {
        for generation in app.generations.lock().unwrap().values() {
            generation.cancel.send_replace(true);
        }
        app.close.send_replace(true);
    }
    Ok(())
}
