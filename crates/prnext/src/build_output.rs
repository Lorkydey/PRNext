//! Public adapter metadata. Internal manifests and worker lifecycle checks remain
//! authoritative; an adapter declaration never grants rendering capabilities.
use crate::manifest::Manifest;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{io::Read, path::Path};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Output {
    version: u32,
    adapter: String,
    build_id: String,
    manifest: String,
    assets: String,
    server: serde_json::Value,
    fallback: serde_json::Value,
}

pub async fn validate(dist: &Path, manifest: &Manifest) -> Result<()> {
    let dist = dist.to_owned();
    let manifest = manifest.clone();
    tokio::task::spawn_blocking(move || validate_sync(&dist, &manifest)).await??;
    Ok(())
}

fn validate_sync(dist: &Path, manifest: &Manifest) -> Result<()> {
    let file = match std::fs::File::open(dist.join("build-output.json")) {
        Ok(file) => file,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && !manifest.config.static_only =>
        {
            return Ok(())
        }
        Err(error) => {
            return Err(error)
                .context("Missing PRNext build output contract; rebuild the application")
        }
    };
    let mut bytes = Vec::new();
    file.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        bail!("PRNext build output contract exceeds 64 KiB");
    }
    let output: Output =
        serde_json::from_slice(&bytes).context("Invalid PRNext build output contract")?;
    if output.version != 1 {
        bail!(
            "Unsupported PRNext build output version {}; expected 1",
            output.version
        );
    }
    if manifest.build_id.as_deref() != Some(output.build_id.as_str())
        || output.manifest != "manifest.json"
    {
        bail!("PRNext build output does not match its manifest; rebuild the application");
    }
    match output.adapter.as_str() {
        "react" if !manifest.config.static_only => {
            if output.assets != "assets"
                || !output.fallback.is_null()
                || output.server
                    != serde_json::json!({"entry":"runtime/worker.mjs","runtimeContract":"runtime-contract.json"})
            {
                bail!("Invalid React build output entrypoints");
            }
        }
        "static" if manifest.config.static_only => {
            let fallback = if manifest.config.static_fallback {
                serde_json::json!("index.html")
            } else {
                serde_json::Value::Null
            };
            if output.assets != "static"
                || !output.server.is_null()
                || output.fallback != fallback
                || !manifest
                    .prerendered
                    .iter()
                    .any(|page| page.path == "/" && page.file == "static/index.html")
                || manifest.prerendered.iter().any(|page| {
                    !page.file.starts_with("static/")
                        || page.data_file.is_some()
                        || page.revalidate != crate::manifest::Revalidate::Never
                })
            {
                bail!("Invalid static build output entrypoints or routes");
            }
        }
        _ => bail!("Unsupported PRNext adapter or inconsistent build output"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Manifest, serde_json::Value) {
        let root = tempfile::tempdir().unwrap();
        let manifest = serde_json::from_value(serde_json::json!({"version":1,"buildId":"fixture","config":{"staticOnly":true},"routes":[],"prerendered":[{"path":"/","file":"static/index.html"}]})).unwrap();
        let output = serde_json::json!({"version":1,"adapter":"static","buildId":"fixture","manifest":"manifest.json","assets":"static","server":null,"fallback":null});
        (root, manifest, output)
    }
    fn check(root: &Path, manifest: &Manifest, output: &serde_json::Value) -> Result<()> {
        std::fs::write(root.join("build-output.json"), serde_json::to_vec(output)?).unwrap();
        validate_sync(root, manifest)
    }
    #[test]
    fn validates_static_contract_and_rejects_incompatible_metadata() {
        let (root, manifest, output) = fixture();
        check(root.path(), &manifest, &output).unwrap();
        for (key, value) in [
            ("version", serde_json::json!(99)),
            ("adapter", serde_json::json!("nuxt")),
            ("buildId", serde_json::json!("stale")),
            ("assets", serde_json::json!("../private")),
            ("server", serde_json::json!({"entry":"server.mjs"})),
            ("fallback", serde_json::json!("../index.html")),
        ] {
            let mut changed = output.clone();
            changed[key] = value;
            assert!(check(root.path(), &manifest, &changed).is_err(), "{key}");
        }
    }
    #[test]
    fn only_legacy_react_builds_can_omit_adapter_metadata() {
        let (root, mut manifest, _) = fixture();
        assert!(validate_sync(root.path(), &manifest).is_err());
        manifest.config.static_only = false;
        assert!(validate_sync(root.path(), &manifest).is_ok());
    }
}
