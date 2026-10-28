//! One server's workers and detached ISR work, never a process-global registry.
//! Leases are acquired before spawn and transferred through child reaping.
use super::*;
use std::{collections::HashMap, future::Future};
use tokio::{
    sync::{watch, Notify},
    task::AbortHandle,
    time::Instant,
};

#[derive(Clone, Copy, Default)]
pub(super) struct Phase {
    deadline: Option<Instant>,
    stopped: bool,
    forced: bool,
}

#[derive(Default)]
struct State {
    work: usize,
    sealed: bool,
    forced: bool,
    failed: bool,
    next_task: u64,
    tasks: HashMap<u64, (Option<AbortHandle>, bool)>,
}

struct Inner {
    state: StdMutex<State>,
    changed: Notify,
    phase: watch::Sender<Phase>,
}

#[derive(Clone)]
pub(crate) struct Lifecycle(Arc<Inner>);

impl Default for Lifecycle {
    fn default() -> Self {
        let (phase, _) = watch::channel(Phase::default());
        Self(Arc::new(Inner {
            state: StdMutex::new(State::default()),
            changed: Notify::new(),
            phase,
        }))
    }
}

pub(super) struct WorkLease(Lifecycle);
impl Drop for WorkLease {
    fn drop(&mut self) {
        let mut state = self.0 .0.state.lock().unwrap();
        state.work -= 1;
        if state.work == 0 {
            self.0 .0.changed.notify_waiters();
        }
    }
}

/// Own the process from spawn to wait(), even if startup or its lane is cancelled.
pub(super) struct OwnedChild {
    child: Option<Child>,
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
    work: Option<WorkLease>,
    lifecycle: Lifecycle,
}
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        self.child.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        self.child.as_mut().unwrap()
    }
}
impl OwnedChild {
    pub(super) fn new(child: Child, work: WorkLease, lifecycle: Lifecycle) -> Self {
        Self {
            child: Some(child),
            slot: None,
            work: Some(work),
            lifecycle,
        }
    }
    pub(super) fn retain_slot(&mut self, slot: tokio::sync::OwnedSemaphorePermit) {
        self.slot = Some(slot);
    }
    pub(super) fn reap(mut self, grace: Duration) -> oneshot::Receiver<()> {
        let child = self.child.take().unwrap();
        let work = self.work.take();
        let slot = self.slot.take();
        let (done, receiver) = oneshot::channel();
        let lifecycle = self.lifecycle.clone();
        self.lifecycle.spawn_reaper(async move {
            let _work = work;
            let _slot = slot;
            if let Err(error) =
                socket::reap_graceful_child(child, grace, Some(lifecycle.clone())).await
            {
                lifecycle.0.state.lock().unwrap().failed = true;
                tracing::warn!(%error, "failed to reap owned Node worker");
            }
            let _ = done.send(());
        });
        receiver
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let work = self.work.take();
            let slot = self.slot.take();
            let lifecycle = self.lifecycle.clone();
            self.lifecycle.spawn_reaper(async move {
                let _work = work;
                let _slot = slot;
                if let Err(error) = socket::reap_graceful_child(child, Duration::ZERO, None).await {
                    lifecycle.0.state.lock().unwrap().failed = true;
                    tracing::warn!(%error, "failed to reap cancelled Node worker");
                }
            });
        }
    }
}

struct TaskLease {
    lifecycle: Lifecycle,
    id: u64,
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        self.lifecycle
            .0
            .state
            .lock()
            .unwrap()
            .tasks
            .remove(&self.id);
        self.lifecycle.0.changed.notify_waiters();
    }
}

struct TrackedTask<F> {
    // Field drop order matters, including cancellation before the first poll:
    // dropping a worker future may synchronously register a child reaper.
    future: Pin<Box<F>>,
    _lease: TaskLease,
}
impl<F: Future<Output = ()>> Future for TrackedTask<F> {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<()> {
        self.get_mut().future.as_mut().poll(cx)
    }
}

impl Lifecycle {
    pub(super) fn work(&self) -> Result<WorkLease> {
        let mut state = self.0.state.lock().unwrap();
        if state.sealed {
            bail!("server worker lifecycle stopped");
        }
        state.work += 1;
        Ok(WorkLease(self.clone()))
    }

    pub(super) fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) {
        self.spawn_inner(future, false);
    }

    pub(super) fn spawn_reaper(&self, future: impl Future<Output = ()> + Send + 'static) {
        self.spawn_inner(future, true);
    }

    fn spawn_inner(&self, future: impl Future<Output = ()> + Send + 'static, reaper: bool) {
        // Reserve synchronously, before spawn. Do not hold the mutex across
        // spawn: a shutting-down runtime can drop the task immediately.
        let id = {
            let mut state = self.0.state.lock().unwrap();
            let id = state.next_task;
            state.next_task += 1;
            state.tasks.insert(id, (None, reaper));
            id
        };
        let lease = TaskLease {
            lifecycle: self.clone(),
            id,
        };
        let task = tokio::spawn(TrackedTask {
            future: Box::pin(future),
            _lease: lease,
        });
        let mut state = self.0.state.lock().unwrap();
        if state.forced && !reaper {
            task.abort();
        }
        if let Some(entry) = state.tasks.get_mut(&id) {
            entry.0 = Some(task.abort_handle());
        }
    }

    pub(super) fn is_draining(&self) -> bool {
        self.0.phase.borrow().deadline.is_some()
    }

    pub(super) fn is_forced(&self) -> bool {
        self.0.phase.borrow().forced
    }

    pub(crate) fn deadline(&self) -> Instant {
        self.0
            .phase
            .borrow()
            .deadline
            // Ordinary retirement is allowed to finish any supported route's
            // maxDuration (up to 300 s). A service drain installs its own bound.
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(300))
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<Phase> {
        self.0.phase.subscribe()
    }

    pub(super) async fn draining(phase: &mut watch::Receiver<Phase>) {
        while phase.borrow_and_update().deadline.is_none() {
            if phase.changed().await.is_err() {
                return;
            }
        }
    }

    pub(super) async fn stopped(phase: &mut watch::Receiver<Phase>) {
        while !phase.borrow_and_update().stopped {
            if phase.changed().await.is_err() {
                return;
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn begin_drain(&self) {
        self.begin_drain_for(REQUEST_TIMEOUT);
    }

    pub(crate) fn begin_drain_for(&self, grace: Duration) {
        self.0.phase.send_modify(|phase| {
            if phase.deadline.is_none() {
                phase.deadline = Some(Instant::now() + grace);
            }
        });
    }

    /// Keep the owning AppState and private services alive while this runs.
    /// Child callbacks can create ISR work/another host before their lease ends.
    /// Sealing and observing zero happen under the same lock as acquisition.
    pub(crate) async fn drain_work(&self) -> bool {
        let done = async {
            loop {
                let changed = self.0.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                {
                    let mut state = self.0.state.lock().unwrap();
                    if state.work == 0 {
                        state.sealed = true;
                        return;
                    }
                }
                changed.await;
            }
        };
        if tokio::time::timeout_at(self.deadline(), done).await.is_ok() {
            return true;
        }
        self.force();
        false
    }

    pub(crate) fn force(&self) {
        self.0.phase.send_modify(|phase| {
            phase.forced = true;
            phase.stopped = true;
        });
        let mut state = self.0.state.lock().unwrap();
        state.sealed = true;
        state.forced = true;
        // Reapers retain ownership until wait() finishes; aborting them would
        // recreate the RuntimeDrop race. Aborted drivers may create reapers.
        for (task, reaper) in state.tasks.values() {
            if !reaper {
                if let Some(task) = task {
                    task.abort();
                }
            }
        }
    }

    /// Called after private services have closed and the last AppState is dropped.
    pub(crate) async fn join(&self) -> bool {
        self.0.phase.send_modify(|phase| phase.stopped = true);
        let done = async {
            loop {
                let changed = self.0.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if self.0.state.lock().unwrap().tasks.is_empty() {
                    return;
                }
                changed.await;
            }
        };
        // Forced child reaping has its own two-second bound. This extra second
        // allows the drivers and their newly registered reapers to be polled.
        let deadline = self.deadline().max(Instant::now()) + Duration::from_secs(3);
        if tokio::time::timeout_at(deadline, done).await.is_ok() {
            let state = self.0.state.lock().unwrap();
            !state.failed && state.work == 0
        } else {
            self.force();
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn generation_capacity_is_retained_until_the_child_is_reaped() {
        let lifecycle = Lifecycle::default();
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let slot = slots.clone().acquire_owned().await.unwrap();
        let child = Command::new("node")
            .args(["-e", "process.stdin.resume()"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut child = OwnedChild::new(child, lifecycle.work().unwrap(), lifecycle);
        child.retain_slot(slot);
        let finished = child.reap(Duration::ZERO);
        assert_eq!(slots.available_permits(), 0);
        finished.await.unwrap();
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn nested_work_has_no_zero_count_gap_and_servers_are_independent() {
        let first = Lifecycle::default();
        let other = Lifecycle::default();
        let first_work = first.work().unwrap();
        let other_work = other.work().unwrap();
        first.begin_drain_for(Duration::from_secs(2));
        let child_work = first.work().unwrap();
        drop(first_work);
        assert!(timeout(Duration::from_millis(10), first.drain_work())
            .await
            .is_err());
        drop(child_work);
        assert!(first.drain_work().await);
        assert!(
            first.work().is_err(),
            "zero and final admission closure are atomic"
        );
        assert!(!other.is_draining());
        assert!(other.work().is_ok());
        drop(other_work);
        assert!(first.join().await);
    }

    #[tokio::test]
    async fn driver_drop_registers_reaper_before_join_can_finish() {
        struct ReapOnDrop {
            lifecycle: Lifecycle,
            work: Option<WorkLease>,
            done: Arc<AtomicU64>,
        }
        impl Drop for ReapOnDrop {
            fn drop(&mut self) {
                let work = self.work.take();
                let done = self.done.clone();
                self.lifecycle.spawn_reaper(async move {
                    tokio::task::yield_now().await;
                    done.store(1, Ordering::Release);
                    drop(work);
                });
            }
        }
        let lifecycle = Lifecycle::default();
        let done = Arc::new(AtomicU64::new(0));
        let owned = ReapOnDrop {
            lifecycle: lifecycle.clone(),
            work: Some(lifecycle.work().unwrap()),
            done: done.clone(),
        };
        lifecycle.spawn(async move {
            let _owned = owned;
            std::future::pending::<()>().await;
        });
        lifecycle.begin_drain_for(Duration::from_millis(10));
        assert!(!lifecycle.drain_work().await);
        assert!(lifecycle.join().await);
        assert_eq!(done.load(Ordering::Acquire), 1);
        assert_eq!(lifecycle.0.state.lock().unwrap().work, 0);
    }

    #[tokio::test]
    async fn never_started_service_drains_without_a_fixed_delay() {
        let lifecycle = Lifecycle::default();
        lifecycle.begin_drain();
        timeout(Duration::from_millis(100), async {
            assert!(lifecycle.drain_work().await);
            assert!(lifecycle.join().await);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn service_deadline_shortens_an_already_retiring_child() {
        let lifecycle = Lifecycle::default();
        let mut child = Command::new("node")
            .args([
                "-e",
                "process.stdin.resume();setInterval(()=>{},1000);console.log('ready')",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        timeout(Duration::from_secs(3), output.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready, "ready\n");
        child.stdin.take();
        let child = OwnedChild::new(child, lifecycle.work().unwrap(), lifecycle.clone());
        let reaped = child.reap(Duration::from_secs(300));
        // Retirement has started before the global deadline exists.
        tokio::time::sleep(Duration::from_millis(40)).await;
        lifecycle.begin_drain_for(Duration::from_millis(80));
        let _ = lifecycle.drain_work().await;
        assert!(
            lifecycle.join().await,
            "an existing reaper must honor the shortened service deadline"
        );
        assert!(reaped.await.is_ok());
        assert_eq!(lifecycle.0.state.lock().unwrap().work, 0);
    }
}
