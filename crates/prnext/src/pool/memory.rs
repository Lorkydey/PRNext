//! Production V8 policy. No old-generation/RSS cap, forced GC or recycling.
use crate::profile::Profile;
use anyhow::Result;
use tokio::process::Command;

pub(super) fn configure(command: &mut Command) -> Result<()> {
    command.args(
        Profile::from_env()?.node_arguments(&std::env::var("NODE_OPTIONS").unwrap_or_default()),
    );
    Ok(())
}
