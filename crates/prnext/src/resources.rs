//! Effective limits, including every visible cgroup-v2 ancestor. Detection is
//! advisory: operator heap flags and explicit worker counts keep precedence.
#[cfg(any(target_os = "linux", test))]
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug)]
pub struct Resources {
    pub cpu_cores: f64,
    pub memory_mib: Option<u64>,
}
impl Resources {
    pub fn detect() -> Self {
        static LIMITS: OnceLock<Resources> = OnceLock::new();
        *LIMITS.get_or_init(|| {
            let value = Self {
                cpu_cores: std::thread::available_parallelism()
                    .map(|n| n.get() as f64)
                    .unwrap_or(1.0),
                memory_mib: None,
            };
            #[cfg(target_os = "linux")]
            {
                let mut value = value;
                value.memory_mib = std::fs::read_to_string("/proc/meminfo").ok().and_then(|s| {
                    s.lines().find_map(|line| {
                        line.strip_prefix("MemTotal:")
                            .and_then(|n| n.split_whitespace().next()?.parse::<u64>().ok())
                            .map(|n| n / 1024)
                    })
                });
                let root = Path::new("/sys/fs/cgroup");
                let relative = std::fs::read_to_string("/proc/self/cgroup")
                    .ok()
                    .and_then(|s| {
                        s.lines()
                            .find_map(|line| line.strip_prefix("0::").map(str::to_owned))
                    });
                let mut directory = relative
                    .and_then(|s| safe_group(root, &s))
                    .unwrap_or_else(|| root.to_owned());
                loop {
                    value = apply(
                        value,
                        std::fs::read_to_string(directory.join("cpu.max"))
                            .ok()
                            .as_deref(),
                        std::fs::read_to_string(directory.join("memory.max"))
                            .ok()
                            .as_deref(),
                    );
                    if directory == root || !directory.pop() {
                        break;
                    }
                }
                value
            }
            #[cfg(not(target_os = "linux"))]
            value
        })
    }
}
#[cfg(any(target_os = "linux", test))]
fn safe_group(root: &Path, group: &str) -> Option<PathBuf> {
    let relative = Path::new(group.trim_start_matches('/'));
    relative
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then(|| root.join(relative))
}
#[cfg(any(target_os = "linux", test))]
fn apply(mut value: Resources, cpu: Option<&str>, memory: Option<&str>) -> Resources {
    if let Some(text) = cpu {
        let mut parts = text.split_whitespace();
        if let (Some(Ok(quota)), Some(Ok(period))) = (
            parts.next().map(str::parse::<u64>),
            parts.next().map(str::parse::<u64>),
        ) {
            if quota > 0 && period > 0 {
                value.cpu_cores = value.cpu_cores.min(quota as f64 / period as f64);
            }
        }
    }
    if let Some(bytes) = memory
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
    {
        let mib = (bytes / 1024 / 1024).max(1);
        value.memory_mib = Some(value.memory_mib.map_or(mib, |old| old.min(mib)));
    }
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotas_include_fractional_and_ancestor_limits() {
        let value = Resources {
            cpu_cores: 8.0,
            memory_mib: Some(24000),
        };
        let value = apply(value, Some("200000 100000"), Some("1073741824"));
        let value = apply(value, Some("70000 100000"), Some("max"));
        assert_eq!(value.cpu_cores, 0.7);
        assert_eq!(value.memory_mib, Some(1024));
        assert_eq!(apply(value, Some("max 100000"), Some("max")).cpu_cores, 0.7);
        assert_eq!(
            apply(value, Some("10 0"), Some("bad")).memory_mib,
            Some(1024)
        );
        assert!(safe_group(Path::new("/sys/fs/cgroup"), "/../../tmp").is_none());
    }
}
