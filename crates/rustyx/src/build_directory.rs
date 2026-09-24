//! Bounded artifact discovery; never executes project configuration at startup.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use tokio::io::AsyncReadExt;

fn validate(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 1024
        || value.contains(['\\', ':'])
        || value.bytes().any(|byte| byte < 32 || byte == 127)
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || matches!(
            value.split('/').next().unwrap_or(""),
            "public"
                | "node_modules"
                | "app"
                | "pages"
                | "src"
                | "components"
                | "lib"
                | "packages"
                | "target"
                | ".git"
                | ".rustyx-output.json"
        )
    {
        bail!("invalid distDir in .rustyx-output.json");
    }
    Ok(())
}

pub async fn resolve(root: &Path) -> Result<PathBuf> {
    let root = tokio::fs::canonicalize(root)
        .await
        .context("project root does not exist")?;
    let relative = match tokio::fs::File::open(root.join(".rustyx-output.json")).await {
        Ok(file) => {
            let mut bytes = Vec::with_capacity(4097);
            file.take(4097).read_to_end(&mut bytes).await?;
            if bytes.len() > 4096 {
                bail!("Rustyx output pointer exceeds 4 KiB");
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Pointer {
                dist_dir: String,
            }
            let pointer: Pointer =
                serde_json::from_slice(&bytes).context("invalid Rustyx output pointer")?;
            validate(&pointer.dist_dir)?;
            pointer.dist_dir
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ".rustyx".into(),
        Err(error) => return Err(error.into()),
    };
    let directory = tokio::fs::canonicalize(root.join(relative))
        .await
        .context("missing Rustyx build; run `rustyx build` first")?;
    if directory == root || !directory.starts_with(&root) {
        bail!("distDir escapes the project root");
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn default_custom_and_invalid_artifact_pointers() {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(root.path().join(".rustyx"))
            .await
            .unwrap();
        assert!(resolve(root.path()).await.unwrap().ends_with(".rustyx"));
        tokio::fs::create_dir_all(root.path().join("build/server"))
            .await
            .unwrap();
        tokio::fs::write(
            root.path().join(".rustyx-output.json"),
            r#"{"distDir":"build/server"}"#,
        )
        .await
        .unwrap();
        assert!(resolve(root.path())
            .await
            .unwrap()
            .ends_with("build/server"));
        for value in [
            "../outside",
            "/absolute",
            "public",
            "node_modules/build",
            "a/../b",
            "a//b",
            "a\\b",
            ".",
        ] {
            tokio::fs::write(
                root.path().join(".rustyx-output.json"),
                serde_json::json!({"distDir":value}).to_string(),
            )
            .await
            .unwrap();
            assert!(resolve(root.path()).await.is_err(), "{value}");
        }
        tokio::fs::write(root.path().join(".rustyx-output.json"), vec![b' '; 4097])
            .await
            .unwrap();
        assert!(resolve(root.path()).await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn artifact_directory_cannot_escape_through_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("out")).unwrap();
        tokio::fs::write(
            root.path().join(".rustyx-output.json"),
            r#"{"distDir":"out"}"#,
        )
        .await
        .unwrap();
        assert!(resolve(root.path()).await.is_err());
    }
}
