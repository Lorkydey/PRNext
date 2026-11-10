//! Bounded, per-server pre-header scheduling. Costs are conservative hints,
//! never measurements of the exact memory owned by an overlapping request.
use crate::{
    pool::WorkerPool,
    resources::pressure::{Pressure, Probe},
    server::admission::AdmissionError,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

const UNIT_BYTES: u64 = 512 * 1024;
const MAX_ROUTES: usize = 256;
const STALE: Duration = Duration::from_secs(3);
const AGE: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct HostSample {
    pub rss: u64,
    pub busy: f64,
    pub delay_ms: f64,
    pub gc: f64,
}
impl HostSample {
    fn valid(self) -> bool {
        self.rss <= 1 << 50
            && self.busy.is_finite()
            && (0.0..=1.0).contains(&self.busy)
            && self.delay_ms.is_finite()
            && (0.0..=60_000.0).contains(&self.delay_ms)
            && self.gc.is_finite()
            && (0.0..=1.0).contains(&self.gc)
    }
}
struct RouteCost {
    units: usize,
    samples: usize,
    floor: usize,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RouteSample {
    pattern: String,
    cpu_ms: f64,
}
struct Waiter {
    id: u64,
    cost: usize,
    since: Instant,
    wake: Arc<Notify>,
}
struct State {
    ceiling: usize,
    floor: usize,
    target: usize,
    used: usize,
    active: usize,
    epoch: u64,
    next: u64,
    healthy: usize,
    routes: HashMap<String, usize>,
    costs: Vec<RouteCost>,
    waiting: HashMap<Option<usize>, VecDeque<Waiter>>,
    turns: VecDeque<Option<usize>>,
    queued: usize,
    hosts: HashMap<u64, (HostSample, Instant)>,
}
impl State {
    fn host_load(&self, now: Instant) -> (u64, f64, f64, f64) {
        self.hosts
            .values()
            .filter(|(_, at)| now.duration_since(*at) <= STALE)
            .fold(
                (0u64, 0f64, 0f64, 0f64),
                |(rss, busy, delay, gc), (s, _)| {
                    (
                        rss.saturating_add(s.rss),
                        busy.max(s.busy),
                        delay.max(s.delay_ms),
                        gc.max(s.gc),
                    )
                },
            )
    }
    fn fits(&self, cost: usize) -> bool {
        self.active == 0 || self.used.saturating_add(self.charge(cost)) <= self.target
    }
    fn charge(&self, cost: usize) -> usize {
        // Leave a small lane for cheap API work even when one oversized render
        // must run serially. Under critical memory pressure serial progress
        // takes precedence; this remains an advisory reservation.
        let reserve = if self.target >= 16 { 2 } else { 0 };
        cost.min(self.target.saturating_sub(reserve).max(1))
    }
    fn selected(&self, now: Instant) -> Option<(Option<usize>, u64)> {
        for (index, route) in self.turns.iter().enumerate() {
            let first = self.waiting.get(route)?.front()?;
            if self.fits(first.cost) {
                return Some((*route, first.id));
            }
            // Reserve progress for one aged route turn, then rotate that
            // route behind its peers. A hot route cannot monopolize the gate.
            if index == 0 && now.duration_since(first.since) >= AGE {
                return None;
            }
        }
        None
    }
    fn wake(&self) {
        if let Some((route, _)) = self.selected(Instant::now()) {
            self.waiting[&route].front().unwrap().wake.notify_one();
        }
    }
    fn remove(&mut self, route: Option<usize>, id: u64, granted: bool) {
        let Some(queue) = self.waiting.get_mut(&route) else {
            return;
        };
        let Some(index) = queue.iter().position(|w| w.id == id) else {
            return;
        };
        queue.remove(index);
        self.queued -= 1;
        let empty = queue.is_empty();
        if empty {
            self.waiting.remove(&route);
        }
        if empty || granted {
            if let Some(index) = self.turns.iter().position(|r| *r == route) {
                self.turns.remove(index);
                if !empty {
                    self.turns.push_back(route);
                }
            }
        }
    }
    fn update(&mut self, pressure: Pressure, now: Instant) {
        let (_, busy, delay, gc) = self.host_load(now);
        let memory_cap = pressure
            .headroom
            .map(|n| (n / UNIT_BYTES).max(1) as usize)
            .unwrap_or(self.ceiling)
            .min(self.ceiling);
        let congested = pressure.cpu_stall > 0.2
            || pressure.memory_stall > 0.05
            || gc > 0.15
            || busy > 0.85 && delay > 25.0;
        if memory_cap < self.target {
            self.target = memory_cap;
            self.healthy = 0;
        } else if congested {
            self.target = (self.target * 3 / 4)
                .max(self.floor)
                .min(self.target)
                .min(memory_cap);
            self.healthy = 0;
        } else {
            self.healthy += 1;
            if self.healthy >= 3 {
                self.target = (self.target + (self.ceiling / 16).max(1)).min(memory_cap);
                self.healthy = 0;
            }
        }
        self.wake();
    }
}
pub(crate) struct Controller {
    state: Mutex<State>,
    waiting_limit: usize,
}
impl Controller {
    pub(crate) fn new(starts: usize, waiting_limit: usize) -> Arc<Self> {
        let ceiling = starts.saturating_mul(16).clamp(16, 32768);
        Arc::new(Self {
            waiting_limit,
            state: Mutex::new(State {
                ceiling,
                floor: (ceiling * 3 / 4 + 2).max(16).min(ceiling),
                target: ceiling,
                used: 0,
                active: 0,
                epoch: 0,
                next: 0,
                healthy: 0,
                routes: HashMap::new(),
                costs: Vec::new(),
                waiting: HashMap::new(),
                turns: VecDeque::new(),
                queued: 0,
                hosts: HashMap::new(),
            }),
        })
    }
    pub(crate) fn start(
        self: &Arc<Self>,
        pool: &WorkerPool,
        lifecycle: crate::pool::Lifecycle,
    ) -> anyhow::Result<()> {
        let weak = Arc::downgrade(self);
        pool.background(async move {
            let mut probe = Probe::discover();
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if lifecycle.is_draining() || weak.strong_count() == 0 {
                    break;
                }
                let sampled = tokio::task::spawn_blocking(move || {
                    let sample = probe.sample();
                    (probe, sample)
                })
                .await;
                let Ok((next, pressure)) = sampled else {
                    break;
                };
                probe = next;
                let Some(controller) = weak.upgrade() else {
                    break;
                };
                let mut state = controller.state.lock().unwrap();
                state.update(pressure, Instant::now());
                if crate::diagnostics::enabled() {
                    let (rss, busy, delay, gc) = state.host_load(Instant::now());
                    crate::diagnostics::record(serde_json::json!({"type":"resource-admission", "capacity":state.target,
                        "used":state.used,"active":state.active,"queued":state.queued,"rss":rss,"busy":busy,
                        "delayMs":delay,"gc":gc,"headroom":pressure.headroom,"memoryLimit":pressure.memory_limit,
                        "cpuStall":pressure.cpu_stall,"memoryStall":pressure.memory_stall}));
                }
            }
        })
    }
    pub(crate) async fn acquire(
        self: &Arc<Self>,
        pattern: &str,
        page: bool,
        deadline: tokio::time::Instant,
    ) -> Result<Lease, AdmissionError> {
        if tokio::time::Instant::now() >= deadline {
            return Err(AdmissionError::Timeout);
        }
        let now = Instant::now();
        let (id, route, cost, wake) = {
            let mut state = self.state.lock().unwrap();
            let default = if page { 16 } else { 1 };
            let route = state.routes.get(pattern).copied().or_else(|| {
                if pattern.len() > 1024 || state.costs.len() >= MAX_ROUTES {
                    return None;
                }
                let id = state.costs.len();
                state.costs.push(RouteCost {
                    units: default,
                    samples: 0,
                    floor: default,
                });
                state.routes.insert(pattern.to_owned(), id);
                Some(id)
            });
            let cost = route.map(|id| state.costs[id].units).unwrap_or(default);
            state.next = state.next.wrapping_add(1);
            let id = state.next;
            if state.waiting.is_empty() && state.fits(cost) {
                return Ok(Lease::admit(self.clone(), &mut state, route, cost, page));
            }
            if state.queued >= self.waiting_limit {
                return Err(AdmissionError::Full);
            }
            let wake = Arc::new(Notify::new());
            if !state.waiting.contains_key(&route) {
                state.turns.push_back(route);
            }
            state.waiting.entry(route).or_default().push_back(Waiter {
                id,
                cost,
                since: now,
                wake: wake.clone(),
            });
            state.queued += 1;
            (id, route, cost, wake)
        };
        let mut ticket = Ticket {
            controller: self.clone(),
            id,
            route,
        };
        loop {
            // Register the notification before inspecting the queue. Release,
            // pressure updates and cancellation all wake the next fitting turn.
            let notified = wake.notified();
            {
                let mut state = self.state.lock().unwrap();
                if state
                    .selected(Instant::now())
                    .is_some_and(|selected| selected == (route, id))
                {
                    state.remove(route, id, true);
                    ticket.id = 0;
                    let lease = Lease::admit(self.clone(), &mut state, route, cost, page);
                    state.wake();
                    return Ok(lease);
                }
            }
            tokio::time::timeout_at(deadline, notified)
                .await
                .map_err(|_| AdmissionError::Timeout)?;
            if tokio::time::Instant::now() >= deadline {
                return Err(AdmissionError::Timeout);
            }
        }
    }
    pub(crate) fn register(self: &Arc<Self>) -> HostRegistration {
        let mut state = self.state.lock().unwrap();
        state.next = state.next.wrapping_add(1);
        HostRegistration {
            controller: Arc::downgrade(self),
            id: state.next,
        }
    }
}
struct Ticket {
    controller: Arc<Controller>,
    id: u64,
    route: Option<usize>,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if self.id == 0 {
            return;
        }
        let mut state = self.controller.state.lock().unwrap();
        state.remove(self.route, self.id, false);
        state.wake();
    }
}
pub(crate) struct HostRegistration {
    controller: Weak<Controller>,
    id: u64,
}
impl HostRegistration {
    pub(crate) fn cost(&self, sample: RouteSample) -> bool {
        if sample.pattern.len() > 1024
            || !sample.cpu_ms.is_finite()
            || !(0.0..=60_000.0).contains(&sample.cpu_ms)
        {
            return false;
        }
        if let Some(controller) = self.controller.upgrade() {
            let mut state = controller.state.lock().unwrap();
            if let Some(id) = state.routes.get(&sample.pattern).copied() {
                let route = &mut state.costs[id];
                route.samples = route.samples.saturating_add(1);
                let hint = (sample.cpu_ms / 2.0).ceil() as usize;
                if route.samples >= 3 {
                    route.units =
                        ((route.units * 3 + hint.clamp(route.floor, 128)) / 4).max(route.floor);
                }
            }
        }
        true
    }
    pub(crate) fn observe(&self, sample: HostSample) -> bool {
        if !sample.valid() {
            return false;
        }
        if let Some(controller) = self.controller.upgrade() {
            let mut state = controller.state.lock().unwrap();
            if state.hosts.len() < 128 || state.hosts.contains_key(&self.id) {
                state.hosts.insert(self.id, (sample, Instant::now()));
            }
        }
        true
    }
}
impl Drop for HostRegistration {
    fn drop(&mut self) {
        if let Some(controller) = self.controller.upgrade() {
            controller.state.lock().unwrap().hosts.remove(&self.id);
        }
    }
}
pub(crate) struct Lease {
    controller: Arc<Controller>,
    route: Option<usize>,
    cost: usize,
    page: bool,
    started: Option<Instant>,
    epoch: u64,
    before: u64,
    exclusive: bool,
}
impl Lease {
    fn admit(
        controller: Arc<Controller>,
        state: &mut State,
        route: Option<usize>,
        cost: usize,
        page: bool,
    ) -> Self {
        let cost = state.charge(cost);
        state.used += cost;
        state.active += 1;
        state.epoch = state.epoch.wrapping_add(1);
        Self {
            controller,
            route,
            cost,
            page,
            started: None,
            epoch: state.epoch,
            before: 0,
            exclusive: false,
        }
    }
    pub(crate) fn start(&mut self) {
        let state = self.controller.state.lock().unwrap();
        self.started = Some(Instant::now());
        self.epoch = state.epoch;
        self.exclusive = state.active == 1;
        self.before = state.host_load(Instant::now()).0;
    }
    pub(crate) fn finish(self, success: bool) {
        let Some(_) = self.started.filter(|_| success) else {
            return;
        };
        let now = Instant::now();
        let mut state = self.controller.state.lock().unwrap();
        let (rss, _, _, gc) = state.host_load(now);
        // Latency with an idle event loop is not a CPU cost signal. Large
        // positive RSS changes are used only without overlapping admissions;
        // background work can still contribute, so this stays an upper hint.
        let memory = if self.exclusive
            && state.active == 1
            && state.epoch == self.epoch
            && self.before > 0
        {
            rss.saturating_sub(self.before) / UNIT_BYTES
        } else {
            0
        };
        let hint = (memory as usize).clamp(if self.page { 16 } else { 1 }, 128);
        let fresh = state
            .hosts
            .values()
            .any(|(_, at)| now.duration_since(*at) <= STALE);
        if fresh && gc < 0.5 && memory > 0 {
            if let Some(route) = self.route.and_then(|id| state.costs.get_mut(id)) {
                route.samples = route.samples.saturating_add(1);
                // Require multiple completed observations, avoid one cold
                // import permanently poisoning a route, and decay slowly.
                if route.samples >= 3 {
                    route.units = ((route.units * 3 + hint) / 4).max(route.floor);
                }
            }
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.controller.state.lock().unwrap();
        state.used -= self.cost;
        state.active -= 1;
        state.wake();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn deadline() -> tokio::time::Instant {
        tokio::time::Instant::now() + Duration::from_secs(3)
    }
    async fn queued(controller: &Controller, expected: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while controller.state.lock().unwrap().queued != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[test]
    fn pressure_shrinks_only_new_work_and_recovery_is_gradual() {
        let controller = Controller::new(16, 32);
        let mut state = controller.state.lock().unwrap();
        state.used = 200;
        state.active = 12;
        state.update(
            Pressure {
                headroom: Some(UNIT_BYTES * 20),
                ..Pressure::default()
            },
            Instant::now(),
        );
        assert_eq!(state.target, 20);
        assert_eq!((state.used, state.active), (200, 12));
        assert!(!state.fits(1));
        for _ in 0..3 {
            state.update(Pressure::default(), Instant::now());
        }
        assert_eq!(state.target, 36);
        state.target = 1;
        state.update(
            Pressure {
                cpu_stall: 0.9,
                ..Pressure::default()
            },
            Instant::now(),
        );
        assert_eq!(
            state.target, 1,
            "pressure must not raise an already smaller target"
        );
        state.used = 0;
        state.active = 0;
        assert!(
            state.fits(128),
            "an oversized route must still make serial progress"
        );
    }
    #[tokio::test]
    async fn lightweight_routes_pass_a_blocked_heavy_turn_but_age_prevents_starvation() {
        let controller = Controller::new(2, 32);
        let active = controller
            .acquire("/catalogue", true, deadline())
            .await
            .unwrap();
        controller.state.lock().unwrap().target = 24;
        let heavy = tokio::spawn({
            let controller = controller.clone();
            async move {
                controller
                    .acquire("/catalogue", true, deadline())
                    .await
                    .unwrap()
            }
        });
        queued(&controller, 1).await;
        let light = controller
            .acquire("/small", false, deadline())
            .await
            .unwrap();
        assert_eq!(controller.state.lock().unwrap().active, 2);
        drop(light);
        controller
            .state
            .lock()
            .unwrap()
            .waiting
            .values_mut()
            .next()
            .unwrap()
            .front_mut()
            .unwrap()
            .since = Instant::now() - AGE;
        let small = tokio::spawn({
            let controller = controller.clone();
            async move {
                controller
                    .acquire("/small", false, deadline())
                    .await
                    .unwrap()
            }
        });
        queued(&controller, 2).await;
        assert!(!small.is_finished());
        drop(active);
        let heavy = heavy.await.unwrap();
        let small = small.await.unwrap();
        drop((heavy, small));
        let state = controller.state.lock().unwrap();
        assert_eq!((state.used, state.active, state.waiting.len()), (0, 0, 0));
    }
    #[tokio::test]
    async fn abandoned_and_expired_tickets_release_capacity_and_deadlines() {
        let controller = Controller::new(1, 2);
        let active = controller
            .acquire("/active", true, deadline())
            .await
            .unwrap();
        controller.state.lock().unwrap().target = 1;
        let abandoned = tokio::spawn({
            let controller = controller.clone();
            async move { controller.acquire("/abandoned", false, deadline()).await }
        });
        queued(&controller, 1).await;
        abandoned.abort();
        let _ = abandoned.await;
        queued(&controller, 0).await;
        assert!(matches!(
            controller
                .acquire(
                    "/expired",
                    false,
                    tokio::time::Instant::now() + Duration::from_millis(10)
                )
                .await,
            Err(AdmissionError::Timeout)
        ));
        assert!(controller.state.lock().unwrap().waiting.is_empty());
        drop(active);
        drop(controller.acquire("/next", true, deadline()).await.unwrap());
        assert_eq!(controller.state.lock().unwrap().used, 0);
    }
    #[tokio::test]
    async fn bounded_waiters_cannot_retain_work_after_queue_rejection() {
        let controller = Controller::new(1, 1);
        let active = controller
            .acquire("/active", true, deadline())
            .await
            .unwrap();
        controller.state.lock().unwrap().target = 1;
        let waiter = tokio::spawn({
            let controller = controller.clone();
            async move { controller.acquire("/wait", false, deadline()).await }
        });
        queued(&controller, 1).await;
        assert!(matches!(
            controller.acquire("/excess", false, deadline()).await,
            Err(AdmissionError::Full)
        ));
        waiter.abort();
        let _ = waiter.await;
        drop(active);
        assert_eq!(controller.state.lock().unwrap().used, 0);
    }
    #[test]
    fn host_samples_are_bounded_expire_and_release_with_the_process() {
        let controller = Controller::new(4, 32);
        let host = controller.register();
        assert!(host.observe(HostSample {
            rss: 123,
            busy: 0.95,
            delay_ms: 100.0,
            gc: 0.2
        }));
        assert!(!host.observe(HostSample {
            busy: f64::NAN,
            ..HostSample::default()
        }));
        assert!(!host.observe(HostSample {
            rss: u64::MAX,
            ..HostSample::default()
        }));
        {
            let mut state = controller.state.lock().unwrap();
            assert_eq!(state.host_load(Instant::now()).0, 123);
            state.update(Pressure::default(), Instant::now());
            assert!(state.target < state.ceiling);
            assert_eq!(
                state
                    .host_load(Instant::now() + STALE + Duration::from_millis(1))
                    .0,
                0
            );
        }
        drop(host);
        assert!(controller.state.lock().unwrap().hosts.is_empty());
    }
    #[tokio::test]
    async fn io_wait_is_not_trained_as_cpu_and_overlapping_rss_is_not_attributed() {
        let controller = Controller::new(16, 32);
        let host = controller.register();
        let mut rss = 100 * 1024 * 1024;
        for _ in 0..4 {
            host.observe(HostSample {
                rss,
                busy: 1.0,
                ..HostSample::default()
            });
            let mut lease = controller
                .acquire("/slow-io", true, deadline())
                .await
                .unwrap();
            lease.start();
            lease.started = Some(Instant::now() - Duration::from_secs(1));
            let overlap = controller
                .acquire("/other", false, deadline())
                .await
                .unwrap();
            rss += 128 * 1024 * 1024;
            host.observe(HostSample {
                rss,
                busy: 1.0,
                ..HostSample::default()
            });
            drop(overlap);
            lease.finish(true);
        }
        let state = controller.state.lock().unwrap();
        let id = state.routes["/slow-io"];
        assert_eq!(state.costs[id].units, 16);
        assert_eq!(
            state.costs[id].samples, 0,
            "other work's busy loop cannot train an IO route"
        );
        assert_eq!(state.active, 0);
    }
    #[tokio::test]
    async fn expensive_completed_routes_learn_without_training_cancellations() {
        let controller = Controller::new(16, 32);
        let host = controller.register();
        host.observe(HostSample {
            busy: 1.0,
            rss: 100,
            ..HostSample::default()
        });
        for _ in 0..5 {
            let mut lease = controller.acquire("/cpu", true, deadline()).await.unwrap();
            lease.start();
            lease.started = Some(Instant::now() - Duration::from_millis(200));
            lease.finish(true);
            assert!(host.cost(RouteSample {
                pattern: "/cpu".to_owned(),
                cpu_ms: 200.0
            }));
        }
        let mut aborted = controller.acquire("/cpu", true, deadline()).await.unwrap();
        aborted.start();
        aborted.finish(false);
        assert!(!host.cost(RouteSample {
            pattern: "/cpu".to_owned(),
            cpu_ms: f64::NAN
        }));
        assert!(!host.cost(RouteSample {
            pattern: "x".repeat(1025),
            cpu_ms: 1.0
        }));
        let state = controller.state.lock().unwrap();
        let route = &state.costs[state.routes["/cpu"]];
        assert_eq!(route.samples, 5);
        assert!(route.units > 16 && route.units <= 128);
        assert_eq!(state.active, 0);
    }
    #[tokio::test]
    async fn route_history_has_a_hard_bound_and_belongs_to_one_build() {
        let controller = Controller::new(16, 32);
        for index in 0..MAX_ROUTES + 20 {
            drop(
                controller
                    .acquire(&format!("/route-{index}"), false, deadline())
                    .await
                    .unwrap(),
            );
        }
        drop(
            controller
                .acquire(&"x".repeat(1025), false, deadline())
                .await
                .unwrap(),
        );
        let state = controller.state.lock().unwrap();
        assert_eq!(state.routes.len(), MAX_ROUTES);
        assert_eq!(state.costs.len(), MAX_ROUTES);
        assert!(Controller::new(16, 32)
            .state
            .lock()
            .unwrap()
            .routes
            .is_empty());
    }

    #[tokio::test]
    async fn hot_route_backlogs_rotate_and_leave_a_turn_for_other_routes() {
        let controller = Controller::new(1, 16);
        controller.state.lock().unwrap().target = 1;
        let active = controller
            .acquire("/active", false, deadline())
            .await
            .unwrap();
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = Vec::new();
        for route in ["/hot", "/hot", "/hot", "/cold"] {
            tasks.push(tokio::spawn({
                let controller = controller.clone();
                let events = events.clone();
                async move {
                    let _lease = controller.acquire(route, false, deadline()).await.unwrap();
                    events.send(route).unwrap();
                }
            }));
            queued(&controller, tasks.len()).await;
        }
        drop(active);
        assert_eq!(received.recv().await, Some("/hot"));
        assert_eq!(received.recv().await, Some("/cold"));
        for task in tasks {
            task.await.unwrap();
        }
        let state = controller.state.lock().unwrap();
        assert!(state.waiting.is_empty() && state.turns.is_empty());
        assert_eq!((state.queued, state.active, state.used), (0, 0, 0));
    }

    #[tokio::test]
    async fn a_serial_expensive_render_keeps_a_small_api_lane() {
        let controller = Controller::new(1, 16);
        let heavy = controller
            .acquire("/render", true, deadline())
            .await
            .unwrap();
        let first = controller
            .acquire("/health", false, deadline())
            .await
            .unwrap();
        let second = controller
            .acquire("/health", false, deadline())
            .await
            .unwrap();
        assert_eq!(controller.state.lock().unwrap().active, 3);
        drop((heavy, first, second));
        assert_eq!(controller.state.lock().unwrap().used, 0);
    }

    #[test]
    fn cpu_feedback_keeps_io_pipelined_while_critical_memory_can_reduce_further() {
        let controller = Controller::new(8, 16);
        let mut state = controller.state.lock().unwrap();
        for _ in 0..100 {
            state.update(
                Pressure {
                    cpu_stall: 0.9,
                    ..Pressure::default()
                },
                Instant::now(),
            );
        }
        assert_eq!(state.target, 98);
        state.update(
            Pressure {
                headroom: Some(UNIT_BYTES * 8),
                cpu_stall: 0.9,
                ..Pressure::default()
            },
            Instant::now(),
        );
        assert_eq!(state.target, 8);
        state.update(
            Pressure {
                cpu_stall: 0.9,
                ..Pressure::default()
            },
            Instant::now(),
        );
        assert_eq!(
            state.target, 8,
            "pressure never raises an already smaller memory target"
        );
    }
}
