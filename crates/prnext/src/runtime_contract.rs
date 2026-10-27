//! Build-time assertions are tied to the actual lifecycle implementation bytes.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read, path::Path};

const MODULES: [&str; 6] = [
    "worker.mjs",
    "transport.mjs",
    "request-work.mjs",
    "app-render.mjs",
    "app-stream-html.mjs",
    "rsc-worker.mjs",
];
const CAPABILITIES: [&str; 4] = [
    "activity",
    "tracked-finalization",
    "graceful-drain",
    "lane-cancellation",
];
const REBUILD: &str = "Rebuild this application with the installed PRNext: prnext build <project>. Protocol compatibility alone does not protect post-response work.";
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Contract {
    schema: u32,
    protocol: u32,
    lifecycle: u32,
    #[serde(default)]
    deployment: Option<u32>,
    capabilities: Vec<String>,
    modules: BTreeMap<String, String>,
}

pub async fn validate(dist: &Path, worker: &Path, needs_worker: bool) -> Result<()> {
    let dist = dist.to_owned();
    let worker = worker.to_owned();
    tokio::task::spawn_blocking(move || validate_sync(&dist, &worker, needs_worker)).await??;
    Ok(())
}
fn validate_sync(dist: &Path, worker: &Path, needs_worker: bool) -> Result<()> {
    let file = dist.join("runtime-contract.json");
    let source = match std::fs::File::open(&file) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !needs_worker => {
            return Ok(())
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Missing or unreadable runtime capabilities in {}. {REBUILD}",
                    file.display()
                )
            })
        }
    };
    let mut bytes = Vec::new();
    source.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        bail!("Runtime capabilities exceed 64 KiB. {REBUILD}");
    }
    let contract: Contract = serde_json::from_slice(&bytes)
        .with_context(|| format!("Invalid runtime capabilities. {REBUILD}"))?;
    if contract.schema != 1 || contract.protocol != 2 || contract.lifecycle != 1 {
        bail!("Unsupported runtime contract (schema {}, protocol {}, lifecycle {}). Expected 1/2/1. {REBUILD}", contract.schema, contract.protocol, contract.lifecycle);
    }
    if contract.deployment.is_some_and(|version| version != 1) {
        bail!("Unsupported deployment coherence contract. {REBUILD}");
    }
    if CAPABILITIES
        .iter()
        .any(|required| !contract.capabilities.iter().any(|c| c == required))
    {
        bail!(
            "Build lacks required activity/finalization/drain/cancellation guarantees. {REBUILD}"
        );
    }
    let root = std::fs::canonicalize(dist)?;
    for directory in ["runtime", "compat"] {
        let folder = std::fs::canonicalize(dist.join(directory))
            .with_context(|| format!("Missing runtime directory {directory}. {REBUILD}"))?;
        if folder.parent() != Some(root.as_path()) {
            bail!("Runtime directories must remain within their build. {REBUILD}");
        }
        for entry in std::fs::read_dir(&folder)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if [".mjs", ".cjs", ".json"]
                .iter()
                .any(|extension| name.ends_with(extension))
                && !contract
                    .modules
                    .contains_key(&format!("{directory}/{name}"))
            {
                bail!("Runtime module {directory}/{name} lacks a build fingerprint. {REBUILD}");
            }
        }
    }
    // Enumerate our known filenames, never paths supplied by metadata. A copied
    // sidecar cannot upgrade old modules, nor can --worker bypass validation.
    for name in MODULES {
        if !contract.modules.contains_key(&format!("runtime/{name}")) {
            bail!("Missing runtime module fingerprint {name}. {REBUILD}");
        }
    }
    for (name, expected) in &contract.modules {
        let parts: Vec<_> = name.split('/').collect();
        if parts.len() != 2
            || !["runtime", "compat"].contains(&parts[0])
            || crate::manifest::validate_relative_file(name).is_err()
            || !["mjs", "cjs", "json"]
                .iter()
                .any(|extension| name.ends_with(&format!(".{extension}")))
        {
            bail!("Invalid runtime module path in build capabilities. {REBUILD}");
        }
        let file = if name == "runtime/worker.mjs" {
            worker.to_owned()
        } else {
            dist.join(name)
        };
        if std::fs::canonicalize(&file)
            .with_context(|| format!("Cannot verify runtime module {name}. {REBUILD}"))?
            .parent()
            != Some(std::fs::canonicalize(dist.join(parts[0]))?.as_path())
        {
            bail!("Runtime modules and --worker must use this build's verified directories. {REBUILD}");
        }
        let bytes = std::fs::read(&file)
            .with_context(|| format!("Cannot verify runtime module {name}. {REBUILD}"))?;
        let actual = format!("{:x}", Sha256::digest(bytes));
        if expected != &actual {
            bail!("Runtime module {name} differs from its build capabilities; mixed or modified runtime artifacts. {REBUILD}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("runtime")).unwrap();
        std::fs::create_dir(dir.path().join("compat")).unwrap();
        let mut modules = BTreeMap::new();
        for name in MODULES {
            std::fs::write(dir.path().join("runtime").join(name), name).unwrap();
            modules.insert(
                format!("runtime/{name}"),
                format!("{:x}", Sha256::digest(name)),
            );
        }
        let contract = serde_json::json!({"schema":1,"protocol":2,"lifecycle":1,"capabilities":CAPABILITIES,"modules":modules});
        (dir, contract)
    }
    fn check(dir: &Path, value: &serde_json::Value) -> Result<()> {
        std::fs::write(
            dir.join("runtime-contract.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
        validate_sync(dir, &dir.join("runtime/worker.mjs"), true)
    }
    #[test]
    fn missing_metadata_only_allows_worker_free_artifacts() {
        let (dir, _) = fixture();
        assert!(validate_sync(dir.path(), &dir.path().join("runtime/worker.mjs"), false).is_ok());
        assert!(
            validate_sync(dir.path(), &dir.path().join("runtime/worker.mjs"), true)
                .unwrap_err()
                .to_string()
                .contains("prnext build")
        );
    }
    #[test]
    fn validates_versions_capabilities_and_actual_modules() {
        let (dir, value) = fixture();
        check(dir.path(), &value).unwrap();
        for key in ["schema", "protocol", "lifecycle"] {
            for version in [0, 99] {
                let mut changed = value.clone();
                changed[key] = version.into();
                assert!(check(dir.path(), &changed).is_err());
            }
        }
        let mut deployment = value.clone();
        deployment["deployment"] = 1.into();
        check(dir.path(), &deployment).unwrap();
        for version in [0, 2, 99] {
            deployment["deployment"] = version.into();
            assert!(check(dir.path(), &deployment).is_err());
        }
        for invalid in [
            serde_json::json!(null),
            serde_json::json!({}),
            serde_json::json!({"schema":"1"}),
        ] {
            assert!(check(dir.path(), &invalid).is_err());
        }
        let mut changed = value.clone();
        changed["capabilities"] = serde_json::json!(["activity"]);
        assert!(check(dir.path(), &changed).is_err());
        std::fs::write(
            dir.path().join("runtime/request-work.mjs"),
            "old implementation",
        )
        .unwrap();
        assert!(check(dir.path(), &value)
            .unwrap_err()
            .to_string()
            .contains("mixed or modified"));
    }
}
