//! Per-request transport lanes share a lazy Node process. A slow or cancelled
//! stream closes only its own connection; other lanes retain their own framing
//! and bounded four-chunk HTTP queues.
use super::*;
use std::sync::Weak;
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Semaphore};

pub(super) struct Host {
    child: StdMutex<Option<lifecycle::OwnedChild>>,
    lifecycle: Lifecycle,
    retired: std::sync::atomic::AtomicBool,
    port: u16,
    token: String,
    pub(super) binary: bool,
    graceful_shutdown: bool,
    activity: StdMutex<(usize, tokio::time::Instant)>,
    idle_changed: tokio::sync::Notify,
}
pub(super) struct Activity(Arc<Host>);
impl Drop for Activity {
    fn drop(&mut self) {
        let mut activity = self.0.activity.lock().unwrap();
        activity.0 -= 1;
        activity.1 = tokio::time::Instant::now();
        if activity.0 == 0 {
            self.0.idle_changed.notify_waiters();
        }
    }
}
impl Host {
    pub(super) fn begin_activity(self: &Arc<Self>) -> Activity {
        self.activity.lock().unwrap().0 += 1;
        Activity(self.clone())
    }
    pub(super) async fn wait_idle(&self, duration: Duration) {
        loop {
            // Register before checking activity so a final completion cannot be
            // lost. Active streams wait for a notification, not periodic ticks.
            let changed = self.idle_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let remaining = {
                let activity = self.activity.lock().unwrap();
                (activity.0 == 0).then(|| duration.saturating_sub(activity.1.elapsed()))
            };
            match remaining {
                Some(remaining) if remaining.is_zero() => return,
                // A later completion may extend this deadline. Recheck once at
                // expiry instead of waking the idle lane on every HTTP request.
                Some(remaining) => tokio::time::sleep(remaining).await,
                None => changed.await,
            }
        }
    }
    fn alive(&self) -> bool {
        !self.retired.load(Ordering::Acquire)
            && self
                .child
                .lock()
                .unwrap()
                .as_mut()
                .is_some_and(|child| child.try_wait().is_ok_and(|exit| exit.is_none()))
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let Some(mut child) = self.child.get_mut().unwrap().take() else {
            return;
        };
        if self.graceful_shutdown && !self.lifecycle.is_forced() {
            crate::metrics::event(crate::metrics::Event::HostDrainStarted);
            // Losing the last idle lane must not kill tracked application work
            // that outlived its HTTP response. The negotiated worker stops its
            // listener on EOF and exits once that work settles. The reaper owns
            // kill_on_drop, including runtime shutdown, and always collects it.
            child.stdin.take();
            let grace = self
                .lifecycle
                .deadline()
                .saturating_duration_since(tokio::time::Instant::now());
            drop(child.reap(grace));
        }
    }
}

pub(super) async fn reap_graceful_child(
    mut child: Child,
    grace: Duration,
    lifecycle: Option<Lifecycle>,
) -> Result<std::process::ExitStatus> {
    let mut deadline = tokio::time::Instant::now() + grace;
    let mut phase = lifecycle.as_ref().map(Lifecycle::subscribe);
    let waited = loop {
        if let Some(lifecycle) = &lifecycle {
            if lifecycle.is_forced() {
                deadline = tokio::time::Instant::now();
            } else if lifecycle.is_draining() {
                deadline = deadline.min(lifecycle.deadline());
            }
        }
        tokio::select! {
            result = tokio::time::timeout_at(deadline, child.wait()) => break result,
            changed = async { match phase.as_mut() {
                Some(rx) => rx.changed().await,
                None => std::future::pending().await,
            } } => {
                if changed.is_err() { phase = None; }
            },
        }
    };
    match waited {
        Ok(status) => Ok(status?),
        Err(_) => {
            // V8 may be stuck in synchronous application code and unable to
            // process EOF or its work timers. Host is already dropped, so its
            // weak heartbeat watchdog cannot own this final cleanup anymore.
            tracing::warn!(
                pid = child.id(),
                "retiring Node worker that exceeded graceful shutdown deadline"
            );
            child.start_kill()?;
            Ok(timeout(Duration::from_secs(2), child.wait()).await??)
        }
    }
}
pub(super) struct SharedHost {
    config: WorkerConfig,
    lanes: usize,
    current: Mutex<Weak<Host>>,
    connecting: Semaphore,
    owner: tokio::sync::watch::Sender<()>,
    lifecycle: Lifecycle,
}

impl SharedHost {
    pub(super) fn new(config: WorkerConfig, lanes: usize, lifecycle: Lifecycle) -> Self {
        let (owner, _) = tokio::sync::watch::channel(());
        Self {
            config,
            lanes,
            current: Mutex::new(Weak::new()),
            connecting: Semaphore::new(32),
            owner,
            lifecycle,
        }
    }
    pub(super) async fn connect(&self) -> Result<Worker> {
        // A cold host releases many queued callers together. Bound only the
        // TCP/authentication handshakes so small OS listen backlogs do not
        // reset those connections; established request lanes stay concurrent.
        let _connecting = self.connecting.acquire().await?;
        let host = {
            let mut current = self.current.lock().await;
            match current.upgrade().filter(|host| host.alive()) {
                Some(host) => host,
                None => {
                    let host = self.spawn().await?;
                    *current = Arc::downgrade(&host);
                    host
                }
            }
        };
        let _activity = host.begin_activity();
        let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, host.port)).await?;
        socket.set_nodelay(true)?;
        socket
            .write_all(format!("{}\n", host.token).as_bytes())
            .await?;
        let (reader, writer) = socket.into_split();
        let reader: Box<dyn AsyncRead + Unpin + Send> = Box::new(reader);
        let mut output = BufReader::new(reader);
        let mut acknowledgement = Vec::new();
        timeout(
            Duration::from_secs(5),
            (&mut output)
                .take(16)
                .read_until(b'\n', &mut acknowledgement),
        )
        .await??;
        if acknowledgement != b"ready\n" {
            bail!("worker transport authentication failed");
        }
        crate::metrics::event(crate::metrics::Event::LaneConnected);
        Ok(Worker {
            child: None,
            host: Some(host),
            input: Box::new(writer),
            output,
            frame_buffer: Vec::with_capacity(512),
            lifecycle: self.lifecycle.clone(),
        })
    }
    async fn spawn(&self) -> Result<Arc<Host>> {
        let work = self.lifecycle.work()?;
        let started = std::time::Instant::now();
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret)
            .map_err(|e| anyhow!("worker transport entropy unavailable: {e}"))?;
        let token = STANDARD.encode(secret);
        let mut command = Command::new(&self.config.node);
        parent::configure(&mut command);
        memory::configure(&mut command)?;
        if let Some(cache) = &self.config.cache {
            command
                .env("PRNEXT_CACHE_URL", &cache.url)
                .env("PRNEXT_CACHE_TOKEN", &cache.token);
        } else {
            command
                .env_remove("PRNEXT_CACHE_URL")
                .env_remove("PRNEXT_CACHE_TOKEN");
        }
        let child = command
            .arg(node_path::for_node(&self.config.script))
            .arg(node_path::for_node(&self.config.project))
            .arg(node_path::for_node(&self.config.dist))
            .current_dir(&self.config.project)
            .env(
                "NODE_ENV",
                std::env::var("NODE_ENV").unwrap_or_else(|_| "production".into()),
            )
            .env("PRNEXT_WORKER_SOCKET", self.lanes.to_string())
            .env("PRNEXT_WORKER_TOKEN", &token)
            .env("PRNEXT_WORKER_ACTIVITY", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut child = lifecycle::OwnedChild::new(child, work, self.lifecycle.clone());
        crate::metrics::event(crate::metrics::Event::HostStarted);
        let mut stdout = BufReader::new(
            child
                .stdout
                .take()
                .context("worker readiness pipe unavailable")?,
        );
        let mut line = Vec::new();
        timeout(
            Duration::from_secs(10),
            (&mut stdout).take(1024).read_until(b'\n', &mut line),
        )
        .await??;
        #[derive(Deserialize)]
        struct Ready {
            port: u16,
            #[serde(default)]
            binary: bool,
            #[serde(default)]
            heartbeat: bool,
            #[serde(default)]
            activity: bool,
            #[serde(default, rename = "gracefulShutdown")]
            graceful_shutdown: bool,
        }
        let ready: Ready =
            serde_json::from_slice(&line).context("invalid worker transport readiness")?;
        if ready.port == 0 {
            bail!("invalid worker transport port");
        }
        if crate::diagnostics::enabled() {
            crate::diagnostics::record(
                serde_json::json!({"type":"wake", "phase":"node-ready", "durationMs":started.elapsed().as_secs_f64()*1000.0, "workerPid":child.id()}),
            );
        }
        let host = Arc::new(Host {
            child: StdMutex::new(Some(child)),
            lifecycle: self.lifecycle.clone(),
            retired: std::sync::atomic::AtomicBool::new(false),
            port: ready.port,
            token,
            binary: ready.binary,
            graceful_shutdown: ready.graceful_shutdown,
            activity: StdMutex::new((0, tokio::time::Instant::now())),
            idle_changed: tokio::sync::Notify::new(),
        });
        if ready.heartbeat {
            let weak = Arc::downgrade(&host);
            let mut owner = self.owner.subscribe();
            // A busy heartbeat retains the existing host across idle lane
            // retirement. New traffic can reuse SharedHost's weak reference;
            // it does not create another process while cache work is draining.
            let mut busy_host = ready.activity.then(|| host.clone());
            let mut busy_metric = ready.activity.then(crate::metrics::Gauge::protected);
            let lifecycle = self.lifecycle.clone();
            let mut drain_signal = lifecycle.subscribe();
            let mut draining = false;
            // Runs outside V8: even an infinite synchronous npm loop cannot
            // disable this watchdog. Never retry a possibly mutated request.
            self.lifecycle.spawn(async move {
                let mut line = Vec::with_capacity(16);
                loop {
                    line.clear();
                    let mut heartbeat = (&mut stdout).take(32);
                    let result = tokio::select! {
                        _ = Lifecycle::draining(&mut drain_signal), if !draining => {
                            draining = true;
                            busy_host.take();
                            busy_metric.take();
                            continue;
                        },
                        // Explicit pool disposal is different from idle lane
                        // retirement. Stop retaining background work when its
                        // final SharedHost owner leaves, then use Host's bounded
                        // graceful EOF/reaper path.
                        _ = owner.changed() => break,
                        result = timeout(REQUEST_TIMEOUT,
                            heartbeat.read_until(b'\n', &mut line)) => result,
                    };
                    if matches!(result, Ok(Ok(_))) {
                        if line == b"alive\n" {
                            busy_host.take();
                            busy_metric.take();
                            continue;
                        }
                        if ready.activity && line == b"busy\n" {
                            if draining {
                                continue;
                            }
                            if busy_host.is_none() {
                                busy_host = weak.upgrade();
                                busy_metric = busy_host
                                    .as_ref()
                                    .map(|_| crate::metrics::Gauge::protected());
                            }
                            continue;
                        }
                    }
                    if let Some(host) = weak.upgrade() {
                        tracing::warn!("retiring unresponsive Node worker");
                        crate::metrics::event(crate::metrics::Event::WatchdogKill);
                        host.retired.store(true, Ordering::Release);
                        if let Some(child) = host.child.lock().unwrap().as_mut() {
                            let _ = child.start_kill();
                        }
                        // Idle lanes may keep Host alive. Reap now rather than
                        // leaving an exited child as a zombie until their drop.
                        for _ in 0..100 {
                            if host.child.lock().unwrap().as_mut().is_none_or(|child| {
                                child.try_wait().is_ok_and(|exit| exit.is_some())
                            }) {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    }
                    break;
                }
            });
        }
        Ok(host)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn graceful_shutdown_reaps_a_worker_even_when_v8_cannot_process_eof() {
        let mut child = Command::new("node")
            .arg("-e")
            .arg("process.stdin.resume();process.stdin.once('end',()=>{while(true){}});process.stdout.write('ready\\n');")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .kill_on_drop(true).spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        timeout(Duration::from_secs(3), output.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready, "ready\n");
        child.stdin.take();
        let started = tokio::time::Instant::now();
        let status = reap_graceful_child(child, Duration::from_millis(80), None)
            .await
            .unwrap();
        assert!(
            !status.success(),
            "a synchronous abandoned worker must be killed and reaped"
        );
        assert!(started.elapsed() >= Duration::from_millis(80));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
