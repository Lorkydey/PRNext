//! Bounded filesystem work and live file responses. No observer unless requested.
use std::{
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        Arc, OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug)]
pub struct Busy;
impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Filesystem admission capacity or wait deadline exceeded")
    }
}
impl std::error::Error for Busy {}

#[derive(Default)]
struct Counters {
    submitted: AtomicU64,
    active: AtomicU64,
    waiting: AtomicU64,
    peak_active: AtomicU64,
    peak_waiting: AtomicU64,
    waiting_bytes: AtomicU64,
    peak_waiting_bytes: AtomicU64,
    rejected: AtomicU64,
    timed_out: AtomicU64,
    cancelled_waits: AtomicU64,
    released: AtomicU64,
    wait_ns: AtomicU64,
    max_wait_ns: AtomicU64,
}
pub struct Gate {
    active: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
    timeout: Duration,
    counters: Arc<Counters>,
    active_limit: usize,
    waiting_limit: usize,
}
pub struct Lease {
    _permit: OwnedSemaphorePermit,
    counters: Option<Arc<Counters>>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(c) = &self.counters {
            c.active.fetch_sub(1, Relaxed);
            c.released.fetch_add(1, Relaxed);
        }
    }
}
struct Wait {
    counters: Option<Arc<Counters>>,
    bytes: u64,
    start: Instant,
    settled: bool,
}
impl Drop for Wait {
    fn drop(&mut self) {
        if let Some(c) = &self.counters {
            c.waiting.fetch_sub(1, Relaxed);
            c.waiting_bytes.fetch_sub(self.bytes, Relaxed);
            let ns = self.start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
            c.wait_ns.fetch_add(ns, Relaxed);
            c.max_wait_ns.fetch_max(ns, Relaxed);
            if !self.settled {
                c.cancelled_waits.fetch_add(1, Relaxed);
            }
        }
    }
}
impl Gate {
    pub fn new(active: usize, waiting: usize, timeout: Duration) -> Self {
        Self {
            active: Arc::new(Semaphore::new(active)),
            waiting: Arc::new(Semaphore::new(waiting)),
            timeout,
            counters: Arc::new(Counters::default()),
            active_limit: active,
            waiting_limit: waiting,
        }
    }
    pub async fn acquire(&self, retained_header_bytes: u64) -> Result<Lease, Busy> {
        let tracked = crate::blocking::enabled();
        let c = &self.counters;
        if tracked {
            c.submitted.fetch_add(1, Relaxed);
        }
        let permit = match self.active.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _slot = self.waiting.clone().try_acquire_owned().map_err(|_| {
                    if tracked {
                        c.rejected.fetch_add(1, Relaxed);
                    }
                    Busy
                })?;
                let mut wait = Wait {
                    counters: tracked.then(|| c.clone()),
                    bytes: retained_header_bytes,
                    start: Instant::now(),
                    settled: false,
                };
                if tracked {
                    let count = c.waiting.fetch_add(1, Relaxed) + 1;
                    c.peak_waiting.fetch_max(count, Relaxed);
                    let bytes = c.waiting_bytes.fetch_add(retained_header_bytes, Relaxed)
                        + retained_header_bytes;
                    c.peak_waiting_bytes.fetch_max(bytes, Relaxed);
                }
                let result =
                    tokio::time::timeout(self.timeout, self.active.clone().acquire_owned()).await;
                wait.settled = true;
                match result {
                    Ok(Ok(permit)) => permit,
                    _ => {
                        if tracked {
                            c.timed_out.fetch_add(1, Relaxed);
                        }
                        return Err(Busy);
                    }
                }
            }
        };
        if tracked {
            let n = c.active.fetch_add(1, Relaxed) + 1;
            c.peak_active.fetch_max(n, Relaxed);
        }
        Ok(Lease {
            _permit: permit,
            counters: tracked.then(|| c.clone()),
        })
    }
    pub fn snapshot(&self) -> serde_json::Value {
        let c = &self.counters;
        serde_json::json!({"activeLimit":self.active_limit,"waitingLimit":self.waiting_limit,"waitTimeoutMs":self.timeout.as_millis(),
            "submitted":c.submitted.load(Relaxed),"active":c.active.load(Relaxed),"waiting":c.waiting.load(Relaxed),
            "peakActive":c.peak_active.load(Relaxed),"peakWaiting":c.peak_waiting.load(Relaxed),
            "waitingHeaderBytes":c.waiting_bytes.load(Relaxed),"peakWaitingHeaderBytes":c.peak_waiting_bytes.load(Relaxed),
            "rejected":c.rejected.load(Relaxed),"timedOut":c.timed_out.load(Relaxed),"cancelledWaits":c.cancelled_waits.load(Relaxed),
            "released":c.released.load(Relaxed),"waitNs":c.wait_ns.load(Relaxed),"maxWaitNs":c.max_wait_ns.load(Relaxed)})
    }
}
static FILES: OnceLock<Gate> = OnceLock::new();
static WORK: OnceLock<Gate> = OnceLock::new();
fn setting(name: &str, default: usize, min: usize, max: usize) -> anyhow::Result<usize> {
    match std::env::var(name) {
        Err(std::env::VarError::NotPresent) => Ok(default),
        value => value
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| (min..=max).contains(v))
            .ok_or_else(|| anyhow::anyhow!("{name} must be an integer between {min} and {max}")),
    }
}
pub fn configure() -> anyhow::Result<()> {
    let files = setting("PRNEXT_FILE_CONCURRENCY", 64, 1, 4096)?;
    let work = setting("PRNEXT_FILE_WORK_CONCURRENCY", 16, 1, 1024)?;
    let waiting = setting("PRNEXT_FILE_QUEUE", 128, 0, 4096)?;
    let wait = Duration::from_millis(setting("PRNEXT_FILE_WAIT_MS", 2000, 1, 60000)? as u64);
    FILES.get_or_init(|| Gate::new(files, waiting, wait));
    WORK.get_or_init(|| Gate::new(work, waiting, wait));
    Ok(())
}
pub fn files() -> &'static Gate {
    FILES.get_or_init(|| Gate::new(64, 128, Duration::from_secs(2)))
}
pub fn work() -> &'static Gate {
    WORK.get_or_init(|| Gate::new(16, 128, Duration::from_secs(2)))
}
// An observer must never initialize a default before startup reads overrides.
pub fn snapshots() -> (Option<serde_json::Value>, Option<serde_json::Value>) {
    (
        FILES.get().map(Gate::snapshot),
        WORK.get().map(Gate::snapshot),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bounded_wait_cancellation_timeout_and_recovery() {
        let gate = Arc::new(Gate::new(1, 1, Duration::from_millis(20)));
        let active = gate.acquire(0).await.unwrap();
        let waiter = tokio::spawn({
            let gate = gate.clone();
            async move { gate.acquire(100).await }
        });
        while gate.waiting.available_permits() != 0 {
            tokio::task::yield_now().await;
        }
        assert!(gate.acquire(0).await.is_err());
        waiter.abort();
        let _ = waiter.await;
        assert_eq!(gate.waiting.available_permits(), 1);
        assert!(gate.acquire(0).await.is_err());
        assert_eq!(gate.waiting.available_permits(), 1);
        drop(active);
        assert!(gate.acquire(0).await.is_ok());
    }
    #[tokio::test]
    async fn no_wait_queue_rejects_immediately() {
        let gate = Gate::new(1, 0, Duration::from_secs(30));
        let active = gate.acquire(0).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), gate.acquire(0))
                .await
                .unwrap()
                .is_err()
        );
        drop(active);
        assert!(gate.acquire(0).await.is_ok());
    }
}
