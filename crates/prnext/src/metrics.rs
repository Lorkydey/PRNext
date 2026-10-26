//! Opt-in cumulative counters. They do not depend on the bounded event-log queue.
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::{
    sync::{Arc, Mutex, Weak},
    time::Instant,
};
use tokio::sync::Semaphore;

pub fn enabled() -> bool {
    crate::blocking::enabled() || crate::diagnostics::enabled()
}
#[derive(Clone, Copy)]
pub enum Event {
    Submitted,
    Cancelled,
    Failed,
    LaneConnected,
    LaneRetired,
    LaneDiscarded,
    HostStarted,
    HostDrainStarted,
    WatchdogKill,
}
const EVENTS: [&str; 9] = [
    "submitted",
    "consumerCancellations",
    "failedRequests",
    "laneConnections",
    "laneIdleRetirements",
    "laneDiscards",
    "hostStarts",
    "hostDrainStarts",
    "watchdogKills",
];
static COUNTS: [AtomicU64; 9] = [const { AtomicU64::new(0) }; 9];
static QUEUED: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicU64 = AtomicU64::new(0);
static PROTECTED: AtomicU64 = AtomicU64::new(0);
pub fn event(event: Event) {
    if enabled() {
        COUNTS[event as usize].fetch_add(1, Relaxed);
    }
}
pub struct Gauge(Option<&'static AtomicU64>);
impl Gauge {
    fn new(counter: &'static AtomicU64) -> Self {
        if enabled() {
            counter.fetch_add(1, Relaxed);
            Self(Some(counter))
        } else {
            Self(None)
        }
    }
    pub fn queued() -> Self {
        Self::new(&QUEUED)
    }
    pub fn active() -> Self {
        Self::new(&ACTIVE)
    }
    pub fn protected() -> Self {
        Self::new(&PROTECTED)
    }
}
impl Drop for Gauge {
    fn drop(&mut self) {
        if let Some(counter) = self.0 {
            counter.fetch_sub(1, Relaxed);
        }
    }
}
pub fn snapshot() -> serde_json::Value {
    let mut values = serde_json::Map::new();
    for (name, counter) in EVENTS.iter().zip(COUNTS.iter()) {
        values.insert((*name).into(), counter.load(Relaxed).into());
    }
    values.insert("queuedJobs".into(), QUEUED.load(Relaxed).into());
    values.insert("activeJobs".into(), ACTIVE.load(Relaxed).into());
    values.insert(
        "activityProtectedHosts".into(),
        PROTECTED.load(Relaxed).into(),
    );
    values.insert("requestStages".into(), stage_snapshots());
    values.insert("budgets".into(), budget_snapshots());
    serde_json::Value::Object(values)
}

/// Fixed labels and buckets keep metrics independent of route/user cardinality.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Stage {
    Admission,
    RenderStart,
    BodyAdmission,
    BodyRead,
    WorkerQueue,
    WorkerFirstByte,
    WorkerHeaders,
    HttpHeaders,
    ResponseBody,
    RequestTotal,
}
const STAGES: [&str; 10] = [
    "admission",
    "renderStart",
    "bodyAdmission",
    "bodyRead",
    "workerQueue",
    "workerFirstByte",
    "workerHeaders",
    "httpHeaders",
    "responseBody",
    "requestTotal",
];
const BOUNDS_MS: [u64; 15] = [
    1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];
#[derive(Clone, Copy, Debug)]
pub(crate) enum Outcome {
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}
impl Outcome {
    fn name(self) -> &'static str {
        ["completed", "failed", "cancelled", "timedOut"][self as usize]
    }
}
struct Histogram {
    count: AtomicU64,
    ns: AtomicU64,
    max_ns: AtomicU64,
    outcomes: [AtomicU64; 4],
    buckets: [AtomicU64; 16],
}
impl Histogram {
    const fn new() -> Self {
        Self {
            count: AtomicU64::new(0),
            ns: AtomicU64::new(0),
            max_ns: AtomicU64::new(0),
            outcomes: [const { AtomicU64::new(0) }; 4],
            buckets: [const { AtomicU64::new(0) }; 16],
        }
    }
    fn record(&self, ns: u64, outcome: Outcome) {
        self.count.fetch_add(1, Relaxed);
        self.ns.fetch_add(ns, Relaxed);
        self.max_ns.fetch_max(ns, Relaxed);
        self.outcomes[outcome as usize].fetch_add(1, Relaxed);
        let bucket = BOUNDS_MS
            .iter()
            .position(|bound| ns <= bound * 1_000_000)
            .unwrap_or(BOUNDS_MS.len());
        self.buckets[bucket].fetch_add(1, Relaxed);
    }
}
static HISTOGRAMS: [Histogram; 10] = [const { Histogram::new() }; 10];
pub(crate) struct StageSpan {
    started: Option<Instant>,
    stage: Stage,
}
impl StageSpan {
    pub fn new(stage: Stage) -> Self {
        Self {
            started: enabled().then(Instant::now),
            stage,
        }
    }
    pub fn finish(&mut self, outcome: Outcome) {
        let Some(started) = self.started.take() else {
            return;
        };
        let ns = started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        HISTOGRAMS[self.stage as usize].record(ns, outcome);
        if crate::diagnostics::enabled() {
            crate::diagnostics::record(
                serde_json::json!({"type":"requestStage","stage":STAGES[self.stage as usize],"outcome":outcome.name(),"durationMs":ns as f64 / 1_000_000.0}),
            );
        }
    }
}
impl Drop for StageSpan {
    fn drop(&mut self) {
        self.finish(Outcome::Cancelled);
    }
}
fn stage_snapshots() -> serde_json::Value {
    STAGES.iter().zip(HISTOGRAMS.iter()).map(|(name,h)| serde_json::json!({"stage":name,"count":h.count.load(Relaxed),"sumMs":h.ns.load(Relaxed) as f64 / 1_000_000.0,"maxMs":h.max_ns.load(Relaxed) as f64 / 1_000_000.0,
        "completed":h.outcomes[0].load(Relaxed),"failed":h.outcomes[1].load(Relaxed),"cancelled":h.outcomes[2].load(Relaxed),"timedOut":h.outcomes[3].load(Relaxed),
        "boundsMs":BOUNDS_MS,"bucketCounts":h.buckets.iter().map(|n|n.load(Relaxed)).collect::<Vec<_>>()})).collect()
}

#[derive(Clone, Copy)]
pub(crate) enum Budget {
    RenderLive,
    ApiLive,
    RenderStart,
    InputBytes,
    ResponseBytes,
}
const BUDGETS: [&str; 5] = [
    "renderLive",
    "apiLive",
    "renderStart",
    "inputBytes",
    "responseBytes",
];
struct BudgetCounters {
    gates: Mutex<Vec<(Weak<Semaphore>, usize, usize)>>,
    waiting: AtomicU64,
    peak_waiting: AtomicU64,
    rejected: AtomicU64,
    timed_out: AtomicU64,
    cancelled: AtomicU64,
    acquired: AtomicU64,
    peak_used: AtomicU64,
}
impl BudgetCounters {
    const fn new() -> Self {
        Self {
            gates: Mutex::new(Vec::new()),
            waiting: AtomicU64::new(0),
            peak_waiting: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            timed_out: AtomicU64::new(0),
            cancelled: AtomicU64::new(0),
            acquired: AtomicU64::new(0),
            peak_used: AtomicU64::new(0),
        }
    }
    fn occupancy(&self) -> (usize, usize) {
        let mut gates = self.gates.lock().unwrap();
        gates.retain(|(weak, _, _)| weak.strong_count() > 0);
        gates
            .iter()
            .filter_map(|(weak, limit, unit)| {
                weak.upgrade().map(|gate| {
                    (
                        limit * unit,
                        (limit.saturating_sub(gate.available_permits())) * unit,
                    )
                })
            })
            .fold((0, 0), |(limit, used), (n, m)| (limit + n, used + m))
    }
}
static BUDGET_COUNTERS: [BudgetCounters; 5] = [const { BudgetCounters::new() }; 5];
pub(crate) fn register_budget(kind: Budget, gate: &Arc<Semaphore>, capacity: usize, unit: usize) {
    // Registration does not enable diagnostics or initialize configuration.
    let mut gates = BUDGET_COUNTERS[kind as usize].gates.lock().unwrap();
    gates.retain(|(weak, _, _)| weak.strong_count() > 0);
    if gates.len() < 64
        && !gates
            .iter()
            .any(|(weak, _, _)| weak.ptr_eq(&Arc::downgrade(gate)))
    {
        gates.push((Arc::downgrade(gate), capacity, unit));
    }
}
pub(crate) fn reclassify_budget(from: Budget, to: Budget, gate: &Arc<Semaphore>) {
    let mut gates = BUDGET_COUNTERS[from as usize].gates.lock().unwrap();
    if let Some(index) = gates
        .iter()
        .position(|(weak, _, _)| weak.ptr_eq(&Arc::downgrade(gate)))
    {
        let (_, capacity, unit) = gates.remove(index);
        drop(gates);
        register_budget(to, gate, capacity, unit);
    }
}
pub(crate) struct BudgetWait {
    kind: Budget,
    active: bool,
}
impl BudgetWait {
    pub fn new(kind: Budget) -> Self {
        let active = enabled();
        if active {
            let c = &BUDGET_COUNTERS[kind as usize];
            let n = c.waiting.fetch_add(1, Relaxed) + 1;
            c.peak_waiting.fetch_max(n, Relaxed);
        }
        Self { kind, active }
    }
    pub fn finish(&mut self, outcome: Outcome) {
        if !self.active {
            return;
        }
        self.active = false;
        let c = &BUDGET_COUNTERS[self.kind as usize];
        c.waiting.fetch_sub(1, Relaxed);
        match outcome {
            Outcome::Completed => {
                c.acquired.fetch_add(1, Relaxed);
                c.peak_used.fetch_max(c.occupancy().1 as u64, Relaxed);
            }
            Outcome::Failed => {
                c.rejected.fetch_add(1, Relaxed);
            }
            Outcome::TimedOut => {
                c.timed_out.fetch_add(1, Relaxed);
            }
            Outcome::Cancelled => {
                c.cancelled.fetch_add(1, Relaxed);
            }
        }
    }
}
impl Drop for BudgetWait {
    fn drop(&mut self) {
        self.finish(Outcome::Cancelled);
    }
}
fn budget_snapshots() -> serde_json::Value {
    BUDGETS.iter().zip(BUDGET_COUNTERS.iter()).map(|(name,c)| {
        let (limit,used)=c.occupancy();
        serde_json::json!({"budget":name,"unit":if name.ends_with("Bytes") {"bytes"} else {"requests"},"limit":limit,"used":used,"peakUsed":c.peak_used.load(Relaxed),"waiting":c.waiting.load(Relaxed),"peakWaiting":c.peak_waiting.load(Relaxed),"acquired":c.acquired.load(Relaxed),"rejected":c.rejected.load(Relaxed),"timedOut":c.timed_out.load(Relaxed),"cancelledWaits":c.cancelled.load(Relaxed)})
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stage_histograms_have_fixed_nonoverlapping_buckets_and_outcomes() {
        let h = Histogram::new();
        h.record(0, Outcome::Completed);
        h.record(1_000_000, Outcome::Cancelled);
        h.record(1_000_001, Outcome::TimedOut);
        h.record(90_000_000_000, Outcome::Failed);
        assert_eq!(h.count.load(Relaxed), 4);
        assert_eq!(h.buckets[0].load(Relaxed), 2);
        assert_eq!(h.buckets[1].load(Relaxed), 1);
        assert_eq!(h.buckets[15].load(Relaxed), 1);
        assert_eq!(h.buckets.iter().map(|n| n.load(Relaxed)).sum::<u64>(), 4);
        assert!(h.outcomes.iter().all(|n| n.load(Relaxed) == 1));
    }
}
