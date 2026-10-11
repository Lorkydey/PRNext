// Minimal Windows scheduler reproduction, independent of routing and file data.
// Compile against this workspace's exact Tokio dependency (see report commands).
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};
static LIVE: AtomicUsize = AtomicUsize::new(0);
static CREATED: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK_ACTIVE: AtomicUsize = AtomicUsize::new(0);
fn main() {
    let mode=std::env::args().nth(1).unwrap_or_else(||"empty".into());
    for concurrency in [1,8,32] {
        CREATED.store(0,Relaxed);PEAK.store(0,Relaxed);PEAK_ACTIVE.store(0,Relaxed);
        let runtime=tokio::runtime::Builder::new_multi_thread().worker_threads(1)
            .on_thread_start(||{CREATED.fetch_add(1,Relaxed);PEAK.fetch_max(LIVE.fetch_add(1,Relaxed)+1,Relaxed);})
            .on_thread_stop(||{LIVE.fetch_sub(1,Relaxed);}).build().unwrap();
        let start=Instant::now();
        let count=runtime.block_on(async {
            let mut tasks=tokio::task::JoinSet::new();
            for _ in 0..concurrency {
                let mode=mode.clone();
                tasks.spawn(async move {
                    let mut count=0;
                    while start.elapsed()<Duration::from_secs(3) {
                        let mode=mode.clone();
                        tokio::task::spawn_blocking(move || {
                            PEAK_ACTIVE.fetch_max(ACTIVE.fetch_add(1,Relaxed)+1,Relaxed);
                            if mode=="metadata" {std::fs::metadata("Cargo.toml").unwrap();}
                            ACTIVE.fetch_sub(1,Relaxed);
                        }).await.unwrap();
                        count+=1;
                    }count
                });
            }
            let mut count=0;while let Some(result)=tasks.join_next().await {count+=result.unwrap();}count
        });
        println!("{{\"mode\":\"{mode}\",\"concurrency\":{concurrency},\"count\":{count},\"elapsedSeconds\":{},\"created\":{},\"peakLive\":{},\"peakActiveClosures\":{}}}",start.elapsed().as_secs_f64(),CREATED.load(Relaxed),PEAK.load(Relaxed),PEAK_ACTIVE.load(Relaxed));
        drop(runtime);
    }
}
