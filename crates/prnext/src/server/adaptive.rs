//! Optional latency controller. No sampling task or per-request allocation.
//! Admission remains bounded by the original semaphore and waiter limits.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) struct Adaptive {
    semaphore: Arc<Semaphore>,
    state: Mutex<State>,
}
struct State {
    floor: usize,
    ceiling: usize,
    target: usize,
    effective: usize,
    baseline: f64,
    total_ms: f64,
    samples: usize,
    peak: usize,
    window: Instant,
}
impl State {
    fn sample(&mut self, elapsed: Duration, now: Instant) {
        self.total_ms += elapsed.as_secs_f64() * 1000.0;
        self.samples += 1;
        if self.samples < 32 || now.duration_since(self.window) < Duration::from_millis(500) {
            return;
        }
        let latency = (self.total_ms / self.samples as f64).max(0.01);
        if self.baseline == 0.0 {
            self.baseline = latency;
        }
        if self.peak >= self.target * 3 / 4 {
            if latency > self.baseline * 1.5 {
                self.target = (self.target * 7 / 8).max(self.floor);
            } else if latency <= self.baseline * 1.2 {
                self.target = (self.target + (self.target / 16).max(1)).min(self.ceiling);
            }
        } else if self.peak < self.target / 4 {
            // An idle/light window must not leave the next burst permanently
            // throttled after a transient slowdown or a change of traffic.
            self.target = (self.target + (self.ceiling / 16).max(1)).min(self.ceiling);
        }
        // Decay towards slower traffic too: a permanent application latency
        // change must not pin the gate at its minimum indefinitely.
        self.baseline = if latency < self.baseline {
            latency
        } else {
            self.baseline * 0.9 + latency * 0.1
        };
        self.samples = 0;
        self.total_ms = 0.0;
        self.peak = 0;
        self.window = now;
    }
    fn reconcile(&mut self, semaphore: &Semaphore) {
        if self.target > self.effective {
            semaphore.add_permits(self.target - self.effective);
            self.effective = self.target;
        } else if self.target < self.effective {
            // Never revoke active work. Outstanding permits are reclaimed on
            // later admissions/completions as they become available.
            self.effective -= semaphore.forget_permits(self.effective - self.target);
        }
        self.peak = self
            .peak
            .max(self.effective - semaphore.available_permits().min(self.effective));
    }
}
impl Adaptive {
    pub(super) fn accept(&self, permit: OwnedSemaphorePermit) -> Option<OwnedSemaphorePermit> {
        let mut state = self.state.lock().unwrap();
        if state.effective > state.target {
            // Reclaim at admission too: a busy semaphore hands released slots
            // straight to queued waiters, so forget_permits alone cannot shrink.
            permit.forget();
            state.effective -= 1;
            None
        } else {
            state.peak = state
                .peak
                .max(state.effective - self.semaphore.available_permits().min(state.effective));
            Some(permit)
        }
    }
    pub(super) fn new(semaphore: Arc<Semaphore>, floor: usize, ceiling: usize) -> Self {
        Self {
            semaphore,
            state: Mutex::new(State {
                floor,
                ceiling,
                target: ceiling,
                effective: ceiling,
                baseline: 0.0,
                total_ms: 0.0,
                samples: 0,
                peak: 0,
                window: Instant::now(),
            }),
        }
    }
    pub(super) fn reconcile(&self) {
        self.state.lock().unwrap().reconcile(&self.semaphore);
    }
    pub(super) fn record(&self, elapsed: Duration) {
        let mut state = self.state.lock().unwrap();
        state.sample(elapsed, Instant::now());
        state.reconcile(&self.semaphore);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(state: &mut State, ms: u64, busy: usize) {
        state.peak = busy;
        let now = state.window + Duration::from_secs(1);
        for _ in 0..32 {
            state.sample(Duration::from_millis(ms), now);
        }
    }
    #[test]
    fn pressure_reduces_concurrency_and_quiet_windows_restore_capacity() {
        let sem = Arc::new(Semaphore::new(128));
        let controller = Adaptive::new(sem.clone(), 16, 128);
        let mut state = controller.state.lock().unwrap();
        window(&mut state, 10, 128);
        window(&mut state, 40, 128);
        state.reconcile(&sem);
        assert_eq!(state.target, 112);
        assert_eq!(sem.available_permits(), 112);
        for _ in 0..20 {
            window(&mut state, 10, 1);
            state.reconcile(&sem);
        }
        assert_eq!(state.target, 128);
        assert_eq!(sem.available_permits(), 128);
    }
    #[test]
    fn active_permits_survive_shrinking_and_capacity_never_exceeds_ceiling() {
        let sem = Arc::new(Semaphore::new(64));
        let controller = Adaptive::new(sem.clone(), 8, 64);
        let active = sem.clone().try_acquire_many_owned(64).unwrap();
        let mut state = controller.state.lock().unwrap();
        state.target = 8;
        state.reconcile(&sem);
        assert_eq!(state.effective, 64);
        assert_eq!(active.num_permits(), 64);
        drop(active);
        state.reconcile(&sem);
        assert_eq!(state.effective, 8);
        assert_eq!(sem.available_permits(), 8);
        for _ in 0..100 {
            window(&mut state, 10, 1);
            state.reconcile(&sem);
        }
        assert_eq!(sem.available_permits(), 64);
    }

    #[tokio::test]
    async fn queued_waiters_can_reclaim_capacity_under_continuous_load() {
        let sem = Arc::new(Semaphore::new(4));
        let controller = Adaptive::new(sem.clone(), 1, 4);
        let active = sem.clone().acquire_many_owned(4).await.unwrap();
        controller.state.lock().unwrap().target = 2;
        let waiting = tokio::spawn({
            let sem = sem.clone();
            async move { sem.acquire_owned().await.unwrap() }
        });
        tokio::task::yield_now().await;
        drop(active);
        assert!(controller.accept(waiting.await.unwrap()).is_none());
        assert!(controller
            .accept(sem.clone().acquire_owned().await.unwrap())
            .is_none());
        assert!(controller
            .accept(sem.clone().acquire_owned().await.unwrap())
            .is_some());
        assert_eq!(controller.state.lock().unwrap().effective, 2);
        assert_eq!(sem.available_permits(), 2);
    }
}
