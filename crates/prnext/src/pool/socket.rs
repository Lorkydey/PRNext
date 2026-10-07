//! Per-request transport lanes share a lazy Node process. A slow or cancelled
//! stream closes only its own connection; other lanes retain their own framing
//! and bounded four-chunk HTTP queues.
use super::*;
use std::sync::Weak;
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Semaphore};

pub(super) struct Host {
    child: StdMutex<Child>,
    retired: std::sync::atomic::AtomicBool,
    port: u16,
    token: String,
    pub(super) binary: bool,
}
impl Host {
    fn alive(&self) -> bool {
        !self.retired.load(Ordering::Acquire)
            && self
                .child
                .lock()
                .unwrap()
                .try_wait()
                .is_ok_and(|exit| exit.is_none())
    }
}
pub(super) struct SharedHost {
    config: WorkerConfig,
    lanes: usize,
    current: Mutex<Weak<Host>>,
    connecting: Semaphore,
}
impl SharedHost {
    pub(super) fn new(config: WorkerConfig, lanes: usize) -> Self {
        Self {
            config,
            lanes,
            current: Mutex::new(Weak::new()),
            connecting: Semaphore::new(32),
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
        Ok(Worker {
            child: None,
            host: Some(host),
            input: Box::new(writer),
            output,
            frame_buffer: Vec::with_capacity(512),
        })
    }
    async fn spawn(&self) -> Result<Arc<Host>> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret)
            .map_err(|e| anyhow!("worker transport entropy unavailable: {e}"))?;
        let token = STANDARD.encode(secret);
        let mut command = Command::new(&self.config.node);
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
        let mut child = command
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
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
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
        }
        let ready: Ready =
            serde_json::from_slice(&line).context("invalid worker transport readiness")?;
        if ready.port == 0 {
            bail!("invalid worker transport port");
        }
        let host = Arc::new(Host {
            child: StdMutex::new(child),
            retired: std::sync::atomic::AtomicBool::new(false),
            port: ready.port,
            token,
            binary: ready.binary,
        });
        if ready.heartbeat {
            let weak = Arc::downgrade(&host);
            // Runs outside V8: even an infinite synchronous npm loop cannot
            // disable this watchdog. Never retry a possibly mutated request.
            tokio::spawn(async move {
                let mut line = Vec::with_capacity(16);
                loop {
                    line.clear();
                    let result = timeout(
                        REQUEST_TIMEOUT,
                        (&mut stdout).take(32).read_until(b'\n', &mut line),
                    )
                    .await;
                    if matches!(result, Ok(Ok(_))) && line == b"alive\n" {
                        continue;
                    }
                    if let Some(host) = weak.upgrade() {
                        tracing::warn!("retiring unresponsive Node worker");
                        host.retired.store(true, Ordering::Release);
                        let _ = host.child.lock().unwrap().start_kill();
                        // Idle lanes may keep Host alive. Reap now rather than
                        // leaving an exited child as a zombie until their drop.
                        for _ in 0..100 {
                            if host
                                .child
                                .lock()
                                .unwrap()
                                .try_wait()
                                .is_ok_and(|exit| exit.is_some())
                            {
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
