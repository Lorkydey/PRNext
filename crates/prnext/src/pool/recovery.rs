//! Per-pool startup circuit. Never retries a request or counts a client disconnect.
use super::*;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::time::Instant;

#[derive(Default)]
struct State {
    failures: u32,
    blocked_until: Option<Instant>,
    healthy_since: Option<Instant>,
}
#[derive(Clone, Default)]
pub(super) struct Recovery {
    state: Arc<StdMutex<State>>,
    startup: Arc<Mutex<()>>,
}
impl Recovery {
    pub(super) async fn start(&self) -> OwnedMutexGuard<()> {
        let guard = self.startup.clone().lock_owned().await;
        let until = self.state.lock().unwrap().blocked_until;
        if let Some(until) = until {
            tokio::time::sleep_until(until).await;
        }
        guard
    }
    pub(super) fn failed(&self) {
        let delay = self.record_failure(Instant::now());
        tracing::warn!(
            delay_ms = delay.as_millis(),
            "Node worker recovery cooling down"
        );
    }
    fn record_failure(&self, now: Instant) -> Duration {
        let mut state = self.state.lock().unwrap();
        state.failures = state.failures.saturating_add(1).min(16);
        state.healthy_since = None;
        let delay = Duration::from_millis((100u64 << (state.failures - 1)).min(30_000));
        state.blocked_until = Some(now + delay);
        delay
    }
    pub(super) fn healthy(&self) {
        self.record_healthy(Instant::now());
    }
    fn record_healthy(&self, now: Instant) {
        let mut state = self.state.lock().unwrap();
        let since = *state.healthy_since.get_or_insert(now);
        if now.duration_since(since) >= Duration::from_secs(60) {
            *state = State::default();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failures_back_off_and_only_a_sustained_healthy_period_resets() {
        let recovery = Recovery::default();
        let now = Instant::now();
        assert_eq!(recovery.record_failure(now), Duration::from_millis(100));
        recovery.record_healthy(now);
        recovery.record_healthy(now + Duration::from_secs(59));
        assert_eq!(
            recovery.record_failure(now + Duration::from_secs(59)),
            Duration::from_millis(200)
        );
        for _ in 0..30 {
            assert!(recovery.record_failure(now) <= Duration::from_secs(30));
        }
        recovery.record_healthy(now);
        recovery.record_healthy(now + Duration::from_secs(60));
        assert_eq!(
            recovery.record_failure(now + Duration::from_secs(61)),
            Duration::from_millis(100)
        );
    }
    #[tokio::test]
    async fn cancelled_startup_does_not_keep_the_startup_lock() {
        let recovery = Recovery::default();
        recovery.failed();
        assert!(timeout(Duration::from_millis(5), recovery.start())
            .await
            .is_err());
        assert!(timeout(Duration::from_secs(1), recovery.start())
            .await
            .is_ok());
    }
}
