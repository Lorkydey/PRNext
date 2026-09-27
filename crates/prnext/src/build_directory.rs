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
                | ".prnext-output.json"
        )
    {
        bail!("invalid distDir in .prnext-output.json");
    }
    Ok(())
}

pub async fn resolve(root: &Path) -> Result<PathBuf> {
    let root = tokio::fs::canonicalize(root)
        .await
        .context("project root does not exist")?;
    let relative = match tokio::fs::File::open(root.join(".prnext-output.json")).await {
        Ok(file) => {
            let mut bytes = Vec::with_capacity(4097);
            file.take(4097).read_to_end(&mut bytes).await?;
            if bytes.len() > 4096 {
                bail!("PRNext output pointer exceeds 4 KiB");
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Pointer {
                dist_dir: String,
            }
            let pointer: Pointer =
                serde_json::from_slice(&bytes).context("invalid PRNext output pointer")?;
            validate(&pointer.dist_dir)?;
            pointer.dist_dir
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ".prnext".into(),
        Err(error) => return Err(error.into()),
    };
    let directory = tokio::fs::canonicalize(root.join(relative))
        .await
        .context("missing PRNext build; run `prnext build` first")?;
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
        tokio::fs::create_dir(root.path().join(".prnext"))
            .await
            .unwrap();
        assert!(resolve(root.path()).await.unwrap().ends_with(".prnext"));
        tokio::fs::create_dir_all(root.path().join("build/server"))
            .await
            .unwrap();
        tokio::fs::write(
            root.path().join(".prnext-output.json"),
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
                root.path().join(".prnext-output.json"),
                serde_json::json!({"distDir":value}).to_string(),
            )
            .await
            .unwrap();
            assert!(resolve(root.path()).await.is_err(), "{value}");
        }
        tokio::fs::write(root.path().join(".prnext-output.json"), vec![b' '; 4097])
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
            root.path().join(".prnext-output.json"),
            r#"{"distDir":"out"}"#,
        )
        .await
        .unwrap();
        assert!(resolve(root.path()).await.is_err());
    }
}
