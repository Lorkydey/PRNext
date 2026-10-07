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
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
};

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
    running: Mutex<Option<Running>>,
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
    memory_mb: u32,
}
struct Lease(Arc<App>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.touched.store(now(), Ordering::Relaxed);
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn stop(mut running: Running) {
    // EOF handles normal shutdown on every OS, including supervisor termination.
    drop(running.child.stdin.take());
    if tokio::time::timeout(Duration::from_secs(3), running.child.wait())
        .await
        .is_err()
    {
        let _ = running.child.kill().await;
    }
    #[cfg(unix)]
    // SAFETY: This is the private group created for our owned child. Clean up
    // remaining descendants even when the server exited before the watchdog.
    unsafe {
        libc::kill(-(running.group_id as i32), libc::SIGKILL);
    }
}
impl Host {
    async fn wake(&self, app: &Arc<App>) -> Result<(String, Lease)> {
        let mut slot = app.running.lock().await;
        if self.stopping.load(Ordering::Relaxed) {
            bail!("host is shutting down");
        }
        if let Some(running) = slot.as_mut() {
            if running.child.try_wait()?.is_some() {
                stop(slot.take().unwrap()).await;
                app.blocked_until.store(now() + 5000, Ordering::Relaxed);
                *app.reason.lock().await = "application exited; retry in 5 seconds".into();
            }
        }
        if slot.is_none() {
            if now() < app.blocked_until.load(Ordering::Relaxed) {
                bail!("application is cooling down after a failure");
            }
            let _launch = self.launching.lock().await;
            if self.budget.available_permits() < app.config.memory_mb as usize {
                let mut idle: Vec<_> = self
                    .apps
                    .iter()
                    .filter(|other| !Arc::ptr_eq(app, other))
                    .collect();
                idle.sort_by_key(|other| other.touched.load(Ordering::Relaxed));
                for other in idle {
                    if let Ok(mut running) = other.running.try_lock() {
                        if other.active.load(Ordering::SeqCst) == 0 {
                            if let Some(child) = running.take() {
                                stop(child).await;
                                *other.reason.lock().await = "sleeping: capacity released".into();
                                other.rss.store(0, Ordering::Relaxed);
                            }
                        }
                    }
                    if self.budget.available_permits() >= app.config.memory_mb as usize {
                        break;
                    }
                }
            }
            let reservation = self
                .budget
                .clone()
                .try_acquire_many_owned(app.config.memory_mb)
                .context("memory capacity is busy; retry shortly")?;
            match self.launch(app, reservation).await {
                Ok(child) => {
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
        let ready = tokio::time::timeout(Duration::from_secs(15), async {
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
        })
        .await;
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
                stop(Running {
                    child,
                    #[cfg(unix)]
                    group_id,
                    address: String::new(),
                    _reservation: reservation,
                })
                .await;
                bail!("{}: startup failed: {:?}", app.config.name, result);
            }
        }
    }
    async fn snapshot(&self) -> serde_json::Value {
        let mut apps = Vec::new();
        for app in &self.apps {
            let pid = app
                .running
                .lock()
                .await
                .as_ref()
                .and_then(|running| running.child.id());
            apps.push(json!({ "name": app.config.name, "hosts": app.config.hosts, "pid": pid,
                "state": if pid.is_some() { "running" } else { "sleeping" }, "reason": *app.reason.lock().await,
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
    if request.headers().contains_key(header::UPGRADE) {
        return reply(
            StatusCode::NOT_IMPLEMENTED,
            "Hosting supports HTTP streaming; protocol upgrades are not supported",
        );
    }
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
    loop {
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
        for app in &host.apps {
            if let Ok(mut slot) = app.running.try_lock() {
                let Some(running) = slot.as_mut() else {
                    continue;
                };
                let rss = running
                    .child
                    .id()
                    .map(|pid| rss_tree(&system, pid))
                    .unwrap_or(0);
                app.rss.store(rss, Ordering::Relaxed);
                let exceeded = rss > u64::from(app.config.memory_mb) * 1024 * 1024;
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
                        "sleeping: idle"
                    }
                    .into();
                    stop(slot.take().unwrap()).await;
                    app.rss.store(0, Ordering::Relaxed);
                }
            }
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
        apps: config
            .apps
            .into_iter()
            .map(|config| {
                Arc::new(App {
                    config,
                    running: Mutex::new(None),
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
    let result = axum::serve(
        listener,
        Router::new().fallback(forward).with_state(host.clone()),
    )
    .with_graceful_shutdown(async move {
        crate::server::shutdown_signal(stdin_eof).await;
        shutdown.stopping.store(true, Ordering::Relaxed);
        for app in &shutdown.apps {
            if let Some(running) = app.running.lock().await.take() {
                stop(running).await;
            }
        }
    })
    .await;
    host.stopping.store(true, Ordering::Relaxed);
    let _ = observer.await;
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
