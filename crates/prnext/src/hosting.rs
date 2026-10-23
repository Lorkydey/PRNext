//! Host trusted applications in separate, lazy process trees behind one listener.
use anyhow::{bail, Context, Result};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, Response, StatusCode},
    Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
};

// The server drains HTTP + tracked work for 30 s, then reaps children. Ordinary
// retirement must allow that entire sequence, just like global host shutdown.
const APPLICATION_DRAIN: Duration = Duration::from_secs(35);
const RETIREMENT_DRAIN: Duration = Duration::from_secs(305);

fn default_address() -> String {
    "127.0.0.1".into()
}
fn default_port() -> u16 {
    8080
}
fn default_total() -> u32 {
    1024
}
fn default_memory() -> u32 {
    256
}
fn default_idle() -> u64 {
    300
}
fn default_workers() -> usize {
    1
}
fn default_profile() -> String {
    "memory".into()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostConfig {
    #[serde(default = "default_address")]
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_total")]
    pub memory_mb: u32,
    pub apps: Vec<AppConfig>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub name: String,
    pub root: PathBuf,
    pub hosts: Vec<String>,
    #[serde(default = "default_memory")]
    pub memory_mb: u32,
    #[serde(default = "default_idle")]
    pub idle_seconds: u64,
    #[serde(default = "default_workers")]
    pub workers: usize,
    #[serde(default = "default_profile")]
    pub profile: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub inspect: bool,
}
impl HostConfig {
    pub async fn load(file: &Path) -> Result<Self> {
        let bytes = tokio::fs::read(file)
            .await
            .context("cannot read hosting configuration")?;
        if bytes.len() > 1024 * 1024 {
            bail!("hosting configuration exceeds 1 MiB");
        }
        let mut config: Self =
            serde_json::from_slice(&bytes).context("invalid hosting configuration")?;
        config.validate()?;
        let parent = file.parent().unwrap_or(Path::new("."));
        let mut roots = HashSet::new();
        for app in &mut config.apps {
            app.root = tokio::fs::canonicalize(parent.join(&app.root))
                .await
                .with_context(|| format!("{}: application root is missing", app.name))?;
            if !roots.insert(app.root.clone()) {
                bail!("applications must use separate roots and caches");
            }
            let dist = crate::build_directory::resolve(&app.root).await?;
            let manifest = crate::manifest::Manifest::load(&dist)
                .await
                .with_context(|| format!("{}: run prn build before hosting", app.name))?;
            if manifest.dev {
                bail!("{}: hosting requires a production build", app.name);
            }
            crate::runtime_contract::validate(
                &dist,
                &dist.join("runtime/worker.mjs"),
                !manifest.routes.is_empty() || manifest.middleware.is_some(),
            )
            .await
            .with_context(|| format!("{}: incompatible application runtime", app.name))?;
            for host in &mut app.hosts {
                *host = host.to_ascii_lowercase();
            }
        }
        Ok(config)
    }
    fn validate(&self) -> Result<()> {
        if self.apps.is_empty() || self.apps.len() > 128 {
            bail!("hosting requires 1–128 applications");
        }
        if !(64..=1_048_576).contains(&self.memory_mb) {
            bail!("memoryMb must be 64–1048576");
        }
        let mut names = HashSet::new();
        let mut hosts = HashSet::new();
        for app in &self.apps {
            if app.name.is_empty()
                || app.name.len() > 64
                || !app
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
                || !names.insert(&app.name)
            {
                bail!("application names must be unique, using letters, digits, - or _");
            }
            if app.memory_mb < 32 || app.memory_mb > self.memory_mb {
                bail!("{}: memoryMb must be 32–{}", app.name, self.memory_mb);
            }
            if !(1..=16).contains(&app.workers) || !(1..=86400).contains(&app.idle_seconds) {
                bail!("{}: workers must be 1–16 and idleSeconds 1–86400", app.name);
            }
            crate::profile::Profile::resolve(Some(&app.profile), None, None)?;
            if app.hosts.is_empty() || app.hosts.len() > 32 {
                bail!("{}: configure 1–32 exact hostnames", app.name);
            }
            for host in &app.hosts {
                if host.is_empty()
                    || host.len() > 253
                    || !host.split('.').all(|part| {
                        !part.is_empty()
                            && part.len() <= 63
                            && !part.starts_with('-')
                            && !part.ends_with('-')
                            && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    })
                    || !hosts.insert(host.to_ascii_lowercase())
                {
                    bail!("invalid or duplicate hostname: {host}");
                }
            }
            for (key, value) in &app.env {
                if key.is_empty()
                    || key.starts_with("PRNEXT_")
                    || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                    || value.contains('\0')
                {
                    bail!(
                        "{}: invalid or reserved environment variable {key}",
                        app.name
                    );
                }
            }
        }
        Ok(())
    }
}
struct Running {
    child: Child,
    #[cfg(unix)]
    group_id: u32,
    address: String,
    _reservation: OwnedSemaphorePermit,
}
struct App {
    config: AppConfig,
    running: Arc<Mutex<Option<Running>>>,
    pid: AtomicU32,
    retiring: AtomicBool,
    forced_stop: tokio::sync::watch::Sender<Option<tokio::time::Instant>>,
    active: AtomicUsize,
    touched: AtomicU64,
    rss: AtomicU64,
    blocked_until: AtomicU64,
    starts: AtomicU64,
    reason: Mutex<String>,
    proxy: crate::proxy::Proxy,
}
struct Host {
    apps: Vec<Arc<App>>,
    hosts: HashMap<String, usize>,
    budget: Arc<Semaphore>,
    launching: Mutex<()>,
    node: PathBuf,
    binary: PathBuf,
    stopping: AtomicBool,
    shutdown: tokio::sync::watch::Sender<Option<tokio::time::Instant>>,
    memory_mb: u32,
}
struct Lease(Arc<App>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.touched.store(now(), Ordering::Relaxed);
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn stop(running: Running) {
    stop_until(
        running,
        tokio::time::Instant::now() + Duration::from_secs(3),
    )
    .await;
}

async fn retire(
    running: Running,
    shutdown: &tokio::sync::watch::Sender<Option<tokio::time::Instant>>,
    budget: Option<&tokio::sync::watch::Sender<Option<tokio::time::Instant>>>,
) {
    // Keep Running (and its memory reservation) owned until wait() completes.
    // Response completion is not evidence that after()/ISR work has finished.
    stop_watching(
        running,
        tokio::time::Instant::now() + RETIREMENT_DRAIN,
        Some(shutdown.subscribe()),
        budget.map(|signal| signal.subscribe()),
    )
    .await;
}

async fn stop_until(running: Running, deadline: tokio::time::Instant) {
    stop_watching(running, deadline, None, None).await;
}

async fn stop_watching(
    mut running: Running,
    mut deadline: tokio::time::Instant,
    mut shutdown: Option<tokio::sync::watch::Receiver<Option<tokio::time::Instant>>>,
    mut budget: Option<tokio::sync::watch::Receiver<Option<tokio::time::Instant>>>,
) {
    // EOF handles normal shutdown on every OS, including supervisor termination.
    drop(running.child.stdin.take());
    let waited = loop {
        if let Some(global) = shutdown.as_ref().and_then(|rx| *rx.borrow()) {
            deadline = deadline.min(global);
        }
        if let Some(limit) = budget.as_ref().and_then(|rx| *rx.borrow()) {
            deadline = deadline.min(limit);
        }
        tokio::select! {
            result = tokio::time::timeout_at(deadline, running.child.wait()) => break result,
            changed = async { match shutdown.as_mut() {
                Some(rx) => rx.changed().await,
                None => std::future::pending().await,
            } } => {
                if changed.is_err() { shutdown = None; }
            },
            changed = async { match budget.as_mut() {
                Some(rx) => rx.changed().await,
                None => std::future::pending().await,
            } } => {
                if changed.is_err() { budget = None; }
            },
        }
    };
    if !matches!(waited, Ok(Ok(_))) {
        if let Ok(Err(error)) = waited {
            tracing::warn!(%error, "host child wait failed");
        } else {
            tracing::warn!(
                pid = running.child.id(),
                "host application exceeded graceful shutdown deadline"
            );
        }
        let _ = running.child.start_kill();
        if !matches!(
            tokio::time::timeout(Duration::from_secs(2), running.child.wait()).await,
            Ok(Ok(_))
        ) {
            tracing::warn!("host child did not reap within forced cleanup bound");
        }
    }
    #[cfg(unix)]
    // SAFETY: This is the private group created for our owned child. Clean up
    // remaining descendants even when the server exited before the watchdog.
    unsafe {
        libc::kill(-(running.group_id as i32), libc::SIGKILL);
    }
}

async fn stop_apps(host: &Host, deadline: tokio::time::Instant) {
    // EOF starts each child's ordinary HTTP drain before its worker drain.
    // Stop independent applications together under one bound, not N * 35 s.
    let mut stops = tokio::task::JoinSet::new();
    for app in &host.apps {
        let app = app.clone();
        stops.spawn(async move {
            // A wake already owns this lock while starting or retiring a child.
            // Its shutdown-aware launch transfers that child to stop_until under
            // this same deadline before releasing the lock. Do not time out and
            // discard ownership while it is still reaping the process.
            let running = app.running.lock().await.take();
            if let Some(running) = running {
                app.retiring.store(true, Ordering::Release);
                stop_until(running, deadline).await;
                app.pid.store(0, Ordering::Release);
                app.retiring.store(false, Ordering::Release);
            }
        });
    }
    while let Some(result) = stops.join_next().await {
        if let Err(error) = result {
            tracing::warn!(%error, "host application shutdown task failed");
        }
    }
}
impl Host {
    fn begin_shutdown(&self, grace: Duration) -> tokio::time::Instant {
        self.stopping.store(true, Ordering::Release);
        let mut deadline = None;
        self.shutdown.send_modify(|current| {
            let value = *current.get_or_insert_with(|| tokio::time::Instant::now() + grace);
            deadline = Some(value);
        });
        deadline.unwrap()
    }

    async fn shutdown_started(
        receiver: &mut tokio::sync::watch::Receiver<Option<tokio::time::Instant>>,
    ) {
        loop {
            if receiver.borrow().is_some() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }

    async fn wake(&self, app: &Arc<App>) -> Result<(String, Lease)> {
        let mut slot = app.running.lock().await;
        if self.stopping.load(Ordering::Relaxed) {
            bail!("host is shutting down");
        }
        if let Some(running) = slot.as_mut() {
            if running.child.try_wait()?.is_some() {
                stop(slot.take().unwrap()).await;
                app.pid.store(0, Ordering::Release);
                app.blocked_until.store(now() + 5000, Ordering::Relaxed);
                *app.reason.lock().await = "application exited; retry in 5 seconds".into();
            }
        }
        if slot.is_none() {
            if now() < app.blocked_until.load(Ordering::Relaxed) {
                bail!("application is cooling down after a failure");
            }
            let mut shutdown = self.shutdown.subscribe();
            let _launch = tokio::select! {
                biased;
                _ = Self::shutdown_started(&mut shutdown) => bail!("host is shutting down"),
                guard = self.launching.lock() => guard,
            };
            if self.stopping.load(Ordering::Acquire) {
                bail!("host is shutting down");
            }
            if self.budget.available_permits() < app.config.memory_mb as usize {
                let mut idle: Vec<_> = self
                    .apps
                    .iter()
                    .filter(|other| !Arc::ptr_eq(app, other))
                    .collect();
                idle.sort_by_key(|other| other.touched.load(Ordering::Relaxed));
                for other in idle {
                    if self.stopping.load(Ordering::Acquire) {
                        bail!("host is shutting down");
                    }
                    if let Ok(mut running) = other.running.clone().try_lock_owned() {
                        if other.active.load(Ordering::SeqCst) == 0 {
                            if let Some(child) = running.take() {
                                other.retiring.store(true, Ordering::Release);
                                let other = other.clone();
                                let shutdown = self.shutdown.clone();
                                // A cancelled cold request must not cancel the
                                // old application's drain. This task owns its
                                // slot; global stop_apps waits for that same
                                // lock before the Tokio runtime can be dropped.
                                tokio::spawn(async move {
                                    let _slot = running;
                                    retire(child, &shutdown, Some(&other.forced_stop)).await;
                                    other.pid.store(0, Ordering::Release);
                                    other.retiring.store(false, Ordering::Release);
                                    if other.forced_stop.borrow().is_none() {
                                        *other.reason.lock().await =
                                            "sleeping: capacity released".into();
                                    }
                                    other.rss.store(0, Ordering::Relaxed);
                                })
                                .await
                                .context("application retirement task failed")?;
                            }
                        }
                    }
                    if self.budget.available_permits() >= app.config.memory_mb as usize {
                        break;
                    }
                }
            }
            if self.stopping.load(Ordering::Acquire) {
                bail!("host is shutting down");
            }
            let reservation = self
                .budget
                .clone()
                .try_acquire_many_owned(app.config.memory_mb)
                .context("memory capacity is busy; retry shortly")?;
            app.forced_stop.send_replace(None);
            match self.launch(app, reservation).await {
                Ok(child) => {
                    app.pid
                        .store(child.child.id().unwrap_or(0), Ordering::Release);
                    *slot = Some(child);
                    app.starts.fetch_add(1, Ordering::Relaxed);
                    *app.reason.lock().await = "running".into();
                }
                Err(error) => {
                    app.blocked_until.store(now() + 5000, Ordering::Relaxed);
                    *app.reason.lock().await = "startup failed; retry in 5 seconds".into();
                    return Err(error);
                }
            }
        }
        if self.stopping.load(Ordering::Acquire) {
            bail!("host is shutting down");
        }
        app.active.fetch_add(1, Ordering::SeqCst);
        app.touched.store(now(), Ordering::Relaxed);
        Ok((slot.as_ref().unwrap().address.clone(), Lease(app.clone())))
    }
    async fn launch(&self, app: &App, reservation: OwnedSemaphorePermit) -> Result<Running> {
        let mut command = Command::new(&self.binary);
        command
            .args(["start"])
            .arg(&app.config.root)
            .args([
                "--hostname",
                "127.0.0.1",
                "--port",
                "0",
                "--shutdown-on-stdin-eof",
                "--shutdown-grace-seconds",
                "300",
                "--node",
            ])
            .arg(&self.node)
            .args([
                "--workers",
                &app.config.workers.to_string(),
                "--profile",
                &app.config.profile,
            ])
            .env_clear()
            .env("NODE_ENV", "production")
            .envs(&app.config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        for name in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
        ] {
            if !app.config.env.contains_key(name) {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
        }
        if app.config.inspect {
            command.env(
                "PRNEXT_INSPECT_DIR",
                app.config.root.join(".prnext-cache/inspect"),
            );
        }
        // The RSS watchdog includes all workers. The V8 limit is only a first
        // guard; buffers and native modules are also counted by the watchdog.
        if !app.config.env.contains_key("NODE_OPTIONS") {
            command.env(
                "NODE_OPTIONS",
                format!(
                    "--max-old-space-size={}",
                    (app.config.memory_mb as usize / app.config.workers * 3 / 4).max(16)
                ),
            );
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .with_context(|| format!("{}: cannot launch native server", app.config.name))?;
        #[cfg(unix)]
        let group_id = child.id().context("missing child process ID")?;
        let mut lines =
            BufReader::new(child.stdout.take().context("missing startup pipe")?).lines();
        let mut shutdown = self.shutdown.subscribe();
        let readiness = tokio::time::timeout(Duration::from_secs(15), async {
            for _ in 0..64 {
                let line = lines
                    .next_line()
                    .await?
                    .context("server exited before listening")?;
                if let Some(address) = line
                    .split("http://")
                    .nth(1)
                    .and_then(|value| value.split_whitespace().next())
                {
                    let socket: std::net::SocketAddr = address.parse()?;
                    if socket.ip().is_loopback() {
                        return Ok::<_, anyhow::Error>(socket.to_string());
                    }
                }
            }
            bail!("server did not report a listening address")
        });
        let ready = tokio::select! {
            biased;
            _ = Self::shutdown_started(&mut shutdown) => Ok(Err(anyhow::anyhow!("host is shutting down"))),
            result = readiness => result,
        };
        match ready {
            Ok(Ok(address)) => {
                let name = app.config.name.clone();
                tokio::spawn(async move {
                    while let Ok(Some(line)) = lines.next_line().await {
                        tracing::debug!(app = %name, %line, "application output");
                    }
                });
                Ok(Running {
                    child,
                    #[cfg(unix)]
                    group_id,
                    address,
                    _reservation: reservation,
                })
            }
            result => {
                let deadline = (*self.shutdown.borrow())
                    .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3));
                stop_until(
                    Running {
                        child,
                        #[cfg(unix)]
                        group_id,
                        address: String::new(),
                        _reservation: reservation,
                    },
                    deadline,
                )
                .await;
                bail!("{}: startup failed: {:?}", app.config.name, result);
            }
        }
    }
    async fn snapshot(&self) -> serde_json::Value {
        let mut apps = Vec::new();
        for app in &self.apps {
            // Retiring applications retain their slot lock until reaped. Status
            // and other applications' memory checks must not wait behind them.
            let pid = match app.pid.load(Ordering::Acquire) {
                0 => None,
                pid => Some(pid),
            };
            apps.push(json!({ "name": app.config.name, "hosts": app.config.hosts, "pid": pid,
                "state": if app.retiring.load(Ordering::Acquire) { "draining" } else if pid.is_some() { "running" } else { "sleeping" }, "reason": *app.reason.lock().await,
                "activeRequests": app.active.load(Ordering::Relaxed), "rssBytes": app.rss.load(Ordering::Relaxed),
                "memoryMb": app.config.memory_mb, "starts": app.starts.load(Ordering::Relaxed) }));
        }
        json!({ "version": 1, "pid": std::process::id(), "time": now(), "memoryMb": self.memory_mb,
            "reservedMb": self.memory_mb as usize - self.budget.available_permits(), "stopping": self.stopping.load(Ordering::Relaxed), "apps": apps })
    }
}
async fn forward(State(host): State<Arc<Host>>, mut request: Request) -> Response<Body> {
    let hostname = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<axum::http::uri::Authority>().ok())
        .map(|value| value.host().trim_end_matches('.').to_ascii_lowercase());
    let Some(index) = hostname.and_then(|name| host.hosts.get(&name).copied()) else {
        return reply(
            StatusCode::MISDIRECTED_REQUEST,
            "Unknown application hostname",
        );
    };
    let app = &host.apps[index];
    let (address, lease) = match host.wake(app).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(app = %app.config.name, %error, "application unavailable");
            return reply(
                StatusCode::SERVICE_UNAVAILABLE,
                "Application unavailable; retry shortly",
            );
        }
    };
    // The request Host selects an exact configured app. Never trust a client's
    // forwarded host/IP to select another tenant or override its visible host.
    request.headers_mut().remove("x-forwarded-for");
    let destination = format!(
        "http://{}{}",
        address,
        request
            .uri()
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/")
    );
    if request.headers().contains_key(header::UPGRADE) {
        let mut shutdown = host.shutdown.subscribe();
        return app
            .proxy
            .websocket(request, &destination, true, true, lease, async move {
                loop {
                    let deadline = *shutdown.borrow();
                    if let Some(deadline) = deadline {
                        tokio::time::sleep_until(deadline).await;
                        break;
                    }
                    if shutdown.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| reply(StatusCode::BAD_GATEWAY, "WebSocket backend unavailable"));
    }
    match app.proxy.forward_internal(request, &destination).await {
        Ok(response) => {
            let (parts, body) = response.into_parts();
            let stream = body.into_data_stream();
            // The lease lasts through streaming and cancellation, not just headers.
            let held =
                futures_util::stream::unfold((stream, lease), |(mut stream, lease)| async move {
                    stream.next().await.map(|chunk| (chunk, (stream, lease)))
                });
            Response::from_parts(parts, Body::from_stream(held))
        }
        Err(error) => {
            tracing::warn!(app = %app.config.name, %error, "application proxy failed");
            reply(StatusCode::BAD_GATEWAY, "Application response failed")
        }
    }
}
fn reply(status: StatusCode, message: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::RETRY_AFTER, "5")
        .body(Body::from(message))
        .unwrap()
}
fn rss_tree(system: &sysinfo::System, root: u32) -> u64 {
    let root = sysinfo::Pid::from_u32(root);
    let mut included = HashSet::from([root]);
    loop {
        let previous = included.len();
        for (pid, process) in system.processes() {
            if process
                .parent()
                .is_some_and(|parent| included.contains(&parent))
            {
                included.insert(*pid);
            }
        }
        if included.len() == previous {
            break;
        }
    }
    included
        .into_iter()
        .filter_map(|pid| system.process(pid))
        .map(|process| process.memory())
        .sum()
}
async fn monitor(host: Arc<Host>, file: PathBuf) {
    let mut system = sysinfo::System::new();
    let mut retirements = tokio::task::JoinSet::new();
    loop {
        while let Some(result) = retirements.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "application retirement task failed");
            }
        }
        if host.stopping.load(Ordering::Relaxed) {
            break;
        }
        system = tokio::task::spawn_blocking(move || {
            system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::All,
                true,
                sysinfo::ProcessRefreshKind::nothing()
                    .with_memory()
                    .without_tasks(),
            );
            system
        })
        .await
        .expect("process monitor panicked");
        if host.stopping.load(Ordering::Relaxed) {
            break;
        }
        for app in &host.apps {
            if host.stopping.load(Ordering::Acquire) {
                break;
            }
            let pid = app.pid.load(Ordering::Acquire);
            let rss = if pid == 0 { 0 } else { rss_tree(&system, pid) };
            app.rss.store(rss, Ordering::Relaxed);
            let exceeded = rss > u64::from(app.config.memory_mb) * 1024 * 1024;
            // This also runs while a retirement owns the slot: long callbacks
            // cannot suspend their own memory watchdog or other apps' checks.
            if exceeded {
                app.forced_stop.send_if_modified(|deadline| {
                    if deadline.is_some() {
                        return false;
                    }
                    *deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                    true
                });
                app.blocked_until.store(now() + 30000, Ordering::Relaxed);
                *app.reason.lock().await = "memory budget exceeded; retry in 30 seconds".into();
            }
            if let Ok(mut slot) = app.running.clone().try_lock_owned() {
                let Some(running) = slot.as_mut() else {
                    continue;
                };
                let idle = app.active.load(Ordering::SeqCst) == 0
                    && now().saturating_sub(app.touched.load(Ordering::Relaxed))
                        >= app.config.idle_seconds * 1000;
                let exited = running.child.try_wait().ok().flatten().is_some();
                if exceeded || idle || exited {
                    if exceeded {
                        app.blocked_until.store(now() + 30000, Ordering::Relaxed);
                    } else if exited {
                        app.blocked_until.store(now() + 5000, Ordering::Relaxed);
                    }
                    *app.reason.lock().await = if exceeded {
                        "memory budget exceeded; retry in 30 seconds"
                    } else if exited {
                        "application exited"
                    } else {
                        "draining: idle"
                    }
                    .into();
                    let running = slot.take().unwrap();
                    app.retiring.store(true, Ordering::Release);
                    let app = app.clone();
                    let shutdown = host.shutdown.clone();
                    retirements.spawn(async move {
                        // Own the slot throughout retirement; wakes cannot
                        // start a duplicate tree or release capacity early.
                        let _slot = slot;
                        if idle && !exceeded && !exited {
                            retire(running, &shutdown, Some(&app.forced_stop)).await;
                        } else {
                            stop(running).await;
                        }
                        app.pid.store(0, Ordering::Release);
                        app.retiring.store(false, Ordering::Release);
                        app.rss.store(0, Ordering::Relaxed);
                        if idle && !exceeded && !exited && app.forced_stop.borrow().is_none() {
                            *app.reason.lock().await = "sleeping: idle".into();
                        }
                    });
                }
            }
        }
        if host.stopping.load(Ordering::Acquire) {
            break;
        }
        let snapshot = host.snapshot().await;
        let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
        if let Ok(bytes) = serde_json::to_vec_pretty(&snapshot) {
            if tokio::fs::write(&temporary, bytes).await.is_ok() {
                let _ = tokio::fs::rename(&temporary, &file).await;
            }
        }
        if host.stopping.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    while let Some(result) = retirements.join_next().await {
        if let Err(error) = result {
            tracing::warn!(%error, "application retirement task failed");
        }
    }
}
pub async fn start(file: PathBuf, node: PathBuf, stdin_eof: bool) -> Result<()> {
    let file = tokio::fs::canonicalize(file).await?;
    let config = HostConfig::load(&file).await?;
    let listener = tokio::net::TcpListener::bind((config.hostname.as_str(), config.port)).await?;
    let address = listener.local_addr()?;
    let hosts = config
        .apps
        .iter()
        .enumerate()
        .flat_map(|(index, app)| app.hosts.iter().map(move |host| (host.clone(), index)))
        .collect();
    let host = Arc::new(Host {
        hosts,
        budget: Arc::new(Semaphore::new(config.memory_mb as usize)),
        memory_mb: config.memory_mb,
        node,
        binary: std::env::current_exe()?,
        launching: Mutex::new(()),
        stopping: AtomicBool::new(false),
        shutdown: tokio::sync::watch::channel(None).0,
        apps: config
            .apps
            .into_iter()
            .map(|config| {
                Arc::new(App {
                    config,
                    running: Arc::new(Mutex::new(None)),
                    pid: AtomicU32::new(0),
                    retiring: AtomicBool::new(false),
                    forced_stop: tokio::sync::watch::channel(None).0,
                    active: AtomicUsize::new(0),
                    touched: AtomicU64::new(now()),
                    rss: AtomicU64::new(0),
                    blocked_until: AtomicU64::new(0),
                    starts: AtomicU64::new(0),
                    reason: Mutex::new("sleeping: not requested".into()),
                    proxy: crate::proxy::Proxy::default(),
                })
            })
            .collect(),
    });
    let observer = tokio::spawn(monitor(host.clone(), file.with_extension("status.json")));
    println!(
        "PRNext host · http://{address} · {} application(s) · {} MiB reserved capacity",
        host.apps.len(),
        host.memory_mb
    );
    let shutdown = host.clone();
    let (deadline_sender, mut deadline_receiver) = tokio::sync::watch::channel(None);
    let app = Router::new().fallback(forward).with_state(host.clone());
    let mut serving = Box::pin(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                crate::server::shutdown_signal(stdin_eof).await;
                deadline_sender.send_replace(Some(shutdown.begin_shutdown(APPLICATION_DRAIN)));
            })
            .await
    });
    let result = tokio::select! {
        biased;
        result = &mut serving => result,
        _ = deadline_receiver.changed() => {
            let deadline = (*deadline_receiver.borrow()).unwrap_or_else(tokio::time::Instant::now);
            let (http, ()) = tokio::join!(
                tokio::time::timeout_at(deadline, &mut serving),
                stop_apps(&host, deadline),
            );
            http.unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "host HTTP shutdown deadline exceeded")))
        },
    };
    drop(serving);
    let deadline = host.begin_shutdown(APPLICATION_DRAIN);
    let _ = observer.await;
    stop_apps(&host, deadline).await;
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn global_or_memory_stop_shortens_retirement_and_releases_its_budget() {
        for memory_stop in [false, true] {
            let budget = Arc::new(Semaphore::new(32));
            let reservation = budget.clone().acquire_many_owned(32).await.unwrap();
            let mut command = Command::new("node");
            command
            .args([
                "-e",
                "process.stdin.resume();setInterval(()=>{},1000);process.stdout.write('ready\\n')",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
            #[cfg(unix)]
            command.process_group(0);
            let mut child = command.spawn().unwrap();
            #[cfg(unix)]
            let group_id = child.id().unwrap();
            let mut ready = String::new();
            tokio::time::timeout(
                Duration::from_secs(5),
                BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(ready, "ready\n");
            let running = Running {
                child,
                #[cfg(unix)]
                group_id,
                address: String::new(),
                _reservation: reservation,
            };
            let (shutdown, _) = tokio::sync::watch::channel(None);
            let (budget_signal, _) = tokio::sync::watch::channel(None);
            let signal = shutdown.clone();
            let local = budget_signal.clone();
            let retirement =
                tokio::spawn(async move { retire(running, &signal, Some(&local)).await });
            tokio::time::sleep(Duration::from_millis(40)).await;
            assert_eq!(budget.available_permits(), 0);
            assert!(!retirement.is_finished());
            let stop_signal = if memory_stop { budget_signal } else { shutdown };
            stop_signal.send_replace(Some(
                tokio::time::Instant::now() + Duration::from_millis(40),
            ));
            tokio::time::timeout(Duration::from_secs(3), retirement)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(budget.available_permits(), 32);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_cancels_queued_cold_wakes_and_reaps_the_starting_child() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("not-ready.sh");
        std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\n' \"$$\" >> \"$SHUTDOWN_TEST_DIR/launches\"\nread ignored\nprintf '%s\\n' \"$$\" >> \"$SHUTDOWN_TEST_DIR/exits\"\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let apps = (0..4).map(|index| Arc::new(App {
            config: serde_json::from_value(json!({
                "name":format!("cold-{index}"),"root":directory.path(),"hosts":[format!("cold-{index}.localhost")],
                "memoryMb":32,"env":{"SHUTDOWN_TEST_DIR":directory.path()}
            })).unwrap(),
            running: Arc::new(Mutex::new(None)), pid: AtomicU32::new(0), retiring: AtomicBool::new(false), forced_stop: tokio::sync::watch::channel(None).0, active: AtomicUsize::new(0), touched: AtomicU64::new(now()),
            rss: AtomicU64::new(0), blocked_until: AtomicU64::new(0), starts: AtomicU64::new(0),
            reason: Mutex::new("sleeping".into()), proxy: crate::proxy::Proxy::default(),
        })).collect::<Vec<_>>();
        let host = Arc::new(Host {
            apps,
            hosts: HashMap::new(),
            budget: Arc::new(Semaphore::new(128)),
            launching: Mutex::new(()),
            node: PathBuf::from("unused-node"),
            binary: executable,
            stopping: AtomicBool::new(false),
            shutdown: tokio::sync::watch::channel(None).0,
            memory_mb: 128,
        });
        let mut wakes = tokio::task::JoinSet::new();
        let first = host.clone();
        wakes.spawn(async move { first.wake(&first.apps[0]).await.is_err() });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !directory.path().join("launches").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        for index in 1..host.apps.len() {
            let host = host.clone();
            wakes.spawn(async move { host.wake(&host.apps[index]).await.is_err() });
        }
        // Every cold app owns its slot and is queued behind the live first
        // launch, reproducing the formerly serialized 15-second startup waits.
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if host.apps.iter().all(|app| app.running.try_lock().is_err()) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let started = tokio::time::Instant::now();
        let deadline = host.begin_shutdown(Duration::from_millis(300));
        tokio::time::timeout(Duration::from_secs(2), stop_apps(&host, deadline))
            .await
            .unwrap();
        while let Some(result) = wakes.join_next().await {
            assert!(result.unwrap());
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        let launches = std::fs::read_to_string(directory.path().join("launches")).unwrap();
        assert_eq!(
            launches.lines().count(),
            1,
            "queued apps must not start after shutdown"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("exits")).unwrap(),
            launches
        );
        let pid: i32 = launches.trim().parse().unwrap();
        // SAFETY: signal 0 only queries the freshly owned/reaped process ID.
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
        assert_eq!(host.budget.available_permits(), 128);
        for app in &host.apps {
            assert!(app.running.lock().await.is_none());
            assert_eq!(app.starts.load(Ordering::Relaxed), 0);
            assert_eq!(app.active.load(Ordering::Relaxed), 0);
        }
    }
    #[test]
    fn reject_colliding_hosts_and_unbounded_budgets() {
        let mut config: HostConfig = serde_json::from_value(json!({"apps":[{"name":"one","root":".","hosts":["ONE.localhost"]},{"name":"two","root":"other","hosts":["two.localhost"]}]})).unwrap();
        assert!(config.validate().is_ok());
        config.apps[1].hosts = vec!["one.localhost".into()];
        assert!(config.validate().is_err());
        config.apps[1].hosts = vec!["evil.test/path".into()];
        assert!(config.validate().is_err());
        config.apps[1].hosts = vec!["two.localhost".into()];
        config.apps[0].memory_mb = 0;
        assert!(config.validate().is_err());
    }
}
