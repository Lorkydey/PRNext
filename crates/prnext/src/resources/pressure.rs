//! Read-only cgroup-v2 observations. A parent's usage is compared with that
//! parent's limit; child usage must never stand in for siblings' consumption.
use std::{path::PathBuf, time::Instant};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Pressure {
    pub headroom: Option<u64>,
    pub memory_limit: Option<u64>,
    pub cpu_stall: f64,
    pub memory_stall: f64,
}

pub(crate) struct Probe {
    groups: Vec<PathBuf>,
    previous: Vec<(Option<u64>, Option<u64>)>,
    sampled: Instant,
}
impl Probe {
    pub(crate) fn discover() -> Self {
        #[cfg(target_os = "linux")]
        let groups = {
            let root = std::path::Path::new("/sys/fs/cgroup");
            let group = std::fs::read_to_string("/proc/self/cgroup")
                .ok()
                .and_then(|text| {
                    text.lines()
                        .find_map(|s| s.strip_prefix("0::").map(str::to_owned))
                });
            let mut directory = group
                .and_then(|s| super::safe_group(root, &s))
                .unwrap_or_else(|| root.to_owned());
            let mut groups = Vec::new();
            loop {
                groups.push(directory.clone());
                if directory == root || !directory.pop() {
                    break;
                }
            }
            groups
        };
        #[cfg(not(target_os = "linux"))]
        let groups = Vec::new();
        let previous = vec![(None, None); groups.len()];
        Self {
            groups,
            previous,
            sampled: Instant::now(),
        }
    }
    pub(crate) fn sample(&mut self) -> Pressure {
        let now = Instant::now();
        let micros = now.duration_since(self.sampled).as_secs_f64() * 1_000_000.0;
        self.sampled = now;
        let mut result = Pressure::default();
        for (index, directory) in self.groups.iter().enumerate() {
            let read = |name| std::fs::read_to_string(directory.join(name)).ok();
            let current = read("memory.current").as_deref().and_then(number);
            let limit = [read("memory.max"), read("memory.high")]
                .iter()
                .filter_map(|s| s.as_deref().and_then(number))
                .min();
            if let (Some(current), Some(limit)) = (current, limit) {
                let reserve = (limit / 16).clamp(8 * 1024 * 1024, 64 * 1024 * 1024);
                let available = limit.saturating_sub(current).saturating_sub(reserve);
                result.headroom = Some(result.headroom.map_or(available, |old| old.min(available)));
                result.memory_limit = Some(result.memory_limit.map_or(limit, |old| old.min(limit)));
            }
            let cpu = read("cpu.pressure").as_deref().and_then(total);
            let memory = read("memory.pressure").as_deref().and_then(total);
            let previous = &mut self.previous[index];
            result.cpu_stall = result.cpu_stall.max(stall(previous.0, cpu, micros));
            result.memory_stall = result.memory_stall.max(stall(previous.1, memory, micros));
            *previous = (cpu, memory);
        }
        result
    }
}
fn number(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}
fn total(text: &str) -> Option<u64> {
    let line = text.lines().find(|s| s.starts_with("some "))?;
    line.split_whitespace()
        .find_map(|s| s.strip_prefix("total=").and_then(number))
}
fn stall(before: Option<u64>, after: Option<u64>, micros: f64) -> f64 {
    match (before, after) {
        (Some(before), Some(after)) if after >= before && micros >= 1.0 => {
            ((after - before) as f64 / micros).clamp(0.0, 1.0)
        }
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pressure_totals_handle_missing_files_reset_and_invalid_values() {
        assert_eq!(number("max"), None);
        assert_eq!(
            total("some avg10=0.00 avg60=0.00 avg300=0.00 total=250\nfull total=999"),
            Some(250)
        );
        assert_eq!(total("full total=999"), None);
        assert_eq!(stall(Some(100), Some(300), 1000.0), 0.2);
        assert_eq!(stall(Some(300), Some(100), 1000.0), 0.0);
        assert_eq!(stall(None, Some(100), 1000.0), 0.0);
    }
    #[test]
    fn parent_headroom_includes_siblings_and_soft_limits() {
        let root = tempfile::tempdir().unwrap();
        let child = root.path().join("child");
        std::fs::create_dir(&child).unwrap();
        for (directory, current, max, high) in [
            (root.path(), 480, "1024", "512"),
            (child.as_path(), 16, "256", "max"),
        ] {
            std::fs::write(
                directory.join("memory.current"),
                (current * 1024 * 1024u64).to_string(),
            )
            .unwrap();
            for (name, value) in [("memory.max", max), ("memory.high", high)] {
                let value = value
                    .parse::<u64>()
                    .map(|n| (n * 1024 * 1024).to_string())
                    .unwrap_or(value.to_owned());
                std::fs::write(directory.join(name), value).unwrap();
            }
        }
        let mut probe = Probe {
            groups: vec![child, root.path().to_owned()],
            previous: vec![(None, None); 2],
            sampled: Instant::now(),
        };
        let sample = probe.sample();
        assert_eq!(sample.headroom, Some(0)); // Parent has32MiB free, reserved32MiB.
        assert_eq!(sample.memory_limit, Some(256 * 1024 * 1024));
        std::fs::write(root.path().join("memory.high"), "max").unwrap();
        assert_eq!(probe.sample().headroom, Some(224 * 1024 * 1024));
    }
}
