//! Preserve V8 policy; optional sampled process RSS retirement never forces GC.
use crate::profile::Profile;
use anyhow::Result;
use tokio::process::Command;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub max_rss_mb: u64,
}
impl Policy {
    pub fn validate(self) -> Result<()> {
        anyhow::ensure!(
            (64..=65536).contains(&self.max_rss_mb),
            "workerMemory.maxRssMb must be between 64 and 65536 MiB"
        );
        Ok(())
    }
}
#[derive(Default)]
pub(super) struct Samples {
    count: u8,
}
impl Samples {
    pub(super) fn observe(&mut self, bytes: u64, policy: Policy) -> bool {
        self.count = if bytes > policy.max_rss_mb.saturating_mul(1024 * 1024) {
            self.count.saturating_add(1)
        } else {
            0
        };
        self.count >= 3
    }
}
pub(super) async fn rss(pid: u32) -> Option<u64> {
    tokio::task::spawn_blocking(move || {
        let pid = sysinfo::Pid::from_u32(pid);
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_memory()
                .without_tasks(),
        );
        system.process(pid).map(sysinfo::Process::memory)
    })
    .await
    .ok()
    .flatten()
}

pub(super) fn configure(command: &mut Command) -> Result<()> {
    let profile = Profile::from_env()?;
    command.env("PRNEXT_PROFILE", profile.name());
    // The native process and its RSC isolate must use the same effective
    // policy, even when Node exposes cpusets but omits a fractional CPU quota.
    command.env(
        "PRNEXT_EFFECTIVE_PROFILE",
        serde_json::to_string(&(profile.name(), profile.settings()))?,
    );
    command.args(profile.node_arguments(&std::env::var("NODE_OPTIONS").unwrap_or_default()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transient_peaks_do_not_retire_and_limits_are_bounded() {
        let policy = Policy { max_rss_mb: 64 };
        let mut samples = Samples::default();
        assert!(!samples.observe(65 * 1024 * 1024, policy));
        assert!(!samples.observe(0, policy));
        assert!(!samples.observe(65 * 1024 * 1024, policy));
        assert!(!samples.observe(65 * 1024 * 1024, policy));
        assert!(samples.observe(65 * 1024 * 1024, policy));
        assert!(Policy { max_rss_mb: 0 }.validate().is_err());
        assert!(Policy {
            max_rss_mb: u64::MAX
        }
        .validate()
        .is_err());
    }
}
