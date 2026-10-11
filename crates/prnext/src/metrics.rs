//! Opt-in cumulative counters. They do not depend on the bounded event-log queue.
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
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
    if crate::blocking::enabled() {
        COUNTS[event as usize].fetch_add(1, Relaxed);
    }
}
pub struct Gauge(Option<&'static AtomicU64>);
impl Gauge {
    fn new(counter: &'static AtomicU64) -> Self {
        if crate::blocking::enabled() {
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
    serde_json::Value::Object(values)
}
