//! Opt-in measurements of filesystem work. Timings exclude HTTP/network waits.
use std::{
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        OnceLock,
    },
    time::Instant,
};

#[derive(Clone, Copy)]
pub enum Origin {
    Prepare,
    SmallRead,
    Containment,
    Gzip,
    Metadata,
    Canonicalize,
    Read,
    PageLookup,
}
const NAMES: [&str; 8] = [
    "static.prepare",
    "static.small_read",
    "path.containment",
    "gzip.select",
    "fs.metadata",
    "fs.canonicalize",
    "fs.read",
    "page.lookup",
];
struct Counters {
    count: AtomicU64,
    active: AtomicU64,
    peak: AtomicU64,
    queued: AtomicU64,
    queue_peak: AtomicU64,
    work_ns: AtomicU64,
    wait_ns: AtomicU64,
    work_max_ns: AtomicU64,
    wait_max_ns: AtomicU64,
}
impl Counters {
    const fn new() -> Self {
        Self {
            count: AtomicU64::new(0),
            active: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            queued: AtomicU64::new(0),
            queue_peak: AtomicU64::new(0),
            work_ns: AtomicU64::new(0),
            wait_ns: AtomicU64::new(0),
            work_max_ns: AtomicU64::new(0),
            wait_max_ns: AtomicU64::new(0),
        }
    }
}
static COUNTERS: [Counters; 8] = [const { Counters::new() }; 8];
static THREADS: AtomicU64 = AtomicU64::new(0);
static CREATED: AtomicU64 = AtomicU64::new(0);
pub fn enabled() -> bool {
    static YES: OnceLock<bool> = OnceLock::new();
    *YES.get_or_init(|| {
        std::env::var_os("PRNEXT_BLOCKING_TRACE").is_some()
            || std::env::var_os("PRNEXT_METRICS_FILE").is_some()
    })
}
pub fn thread_start() {
    THREADS.fetch_add(1, Relaxed);
    CREATED.fetch_add(1, Relaxed);
}
pub fn thread_stop() {
    THREADS.fetch_sub(1, Relaxed);
}
fn ns(t: Instant) -> u64 {
    t.elapsed().as_nanos().min(u64::MAX as u128) as u64
}
pub struct Span(Option<(Origin, Instant)>);
pub fn phase(origin: Origin) -> Span {
    if !enabled() {
        return Span(None);
    }
    let c = &COUNTERS[origin as usize];
    let active = c.active.fetch_add(1, Relaxed) + 1;
    c.peak.fetch_max(active, Relaxed);
    Span(Some((origin, Instant::now())))
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some((origin, start)) = self.0 {
            let c = &COUNTERS[origin as usize];
            let elapsed = ns(start);
            c.count.fetch_add(1, Relaxed);
            c.work_ns.fetch_add(elapsed, Relaxed);
            c.work_max_ns.fetch_max(elapsed, Relaxed);
            c.active.fetch_sub(1, Relaxed);
        }
    }
}
struct Queued(Option<(Origin, Instant)>);
impl Queued {
    fn start(&mut self) {
        if let Some((origin, start)) = self.0.take() {
            let c = &COUNTERS[origin as usize];
            c.queued.fetch_sub(1, Relaxed);
            let wait = ns(start);
            c.wait_ns.fetch_add(wait, Relaxed);
            c.wait_max_ns.fetch_max(wait, Relaxed);
        }
    }
}
impl Drop for Queued {
    fn drop(&mut self) {
        if let Some((origin, _)) = self.0.take() {
            COUNTERS[origin as usize].queued.fetch_sub(1, Relaxed);
        }
    }
}
struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
pub async fn run<F, R>(origin: Origin, f: F) -> anyhow::Result<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let permit = crate::io_admission::work().acquire(0).await?;
    let mut queued = Queued(enabled().then(|| {
        let c = &COUNTERS[origin as usize];
        let n = c.queued.fetch_add(1, Relaxed) + 1;
        c.queue_peak.fetch_max(n, Relaxed);
        (origin, Instant::now())
    }));
    let handle = tokio::task::spawn_blocking(move || {
        // Running blocking calls cannot be aborted. Keep their capacity until
        // they really finish, even when their HTTP consumer has disappeared.
        let _permit = permit;
        queued.start();
        let _span = phase(origin);
        f()
    });
    let _abort = AbortOnDrop(handle.abort_handle());
    Ok(handle.await?)
}
/// One explicitly enabled observer thread; no polling or writer when disabled.
pub fn observe(runtime_workers: usize) {
    let Some(file) = std::env::var_os("PRNEXT_METRICS_FILE")
        .or_else(|| std::env::var_os("PRNEXT_BLOCKING_TRACE"))
    else {
        return;
    };
    std::thread::Builder::new()
        .name("prnext-io-observer".into())
        .spawn(move || {
            use std::io::{Seek, Write};
            let mut file = match std::fs::File::create(&file) {
                Ok(file) => file,
                Err(error) => {
                    eprintln!("PRNext cannot create metrics file {:?}: {error}", file);
                    return;
                }
            };
            let mut written = 0;
            loop {
                let rows: Vec<_> = COUNTERS.iter().zip(NAMES).map(|(c, name)| {
                    serde_json::json!({
                        "origin":name, "count":c.count.load(Relaxed),
                        "active":c.active.load(Relaxed), "peakActive":c.peak.load(Relaxed),
                        "queued":c.queued.load(Relaxed), "peakQueued":c.queue_peak.load(Relaxed),
                        "workNs":c.work_ns.load(Relaxed), "waitNs":c.wait_ns.load(Relaxed),
                        "maxWorkNs":c.work_max_ns.load(Relaxed), "maxWaitNs":c.wait_max_ns.load(Relaxed)
                    })
                }).collect();
                let (files, work) = crate::io_admission::snapshots();
                let value = serde_json::json!({
                    "unixMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
                    "pid":std::process::id(), "runtimeWorkers":runtime_workers,
                    "tokioLiveThreads":THREADS.load(Relaxed), "tokioCreatedThreads":CREATED.load(Relaxed),
                    "operations":rows, "workers":crate::metrics::snapshot(),
                    "fileAdmission":files,
                    "fileWorkAdmission":work
                }).to_string();
                // Bound disk use for an accidentally retained diagnostic flag.
                // Counters remain cumulative even when the sample file wraps.
                if written + value.len() + 1 > 16 * 1024 * 1024 {
                    if file.rewind().and_then(|_|file.set_len(0)).is_err() { return; }
                    written = 0;
                }
                if writeln!(file, "{value}").is_err() { return; }
                written += value.len() + 1;
                let _ = file.flush();
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        })
        .expect("cannot start blocking-work observer");
}
