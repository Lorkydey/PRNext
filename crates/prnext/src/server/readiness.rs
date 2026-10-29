use anyhow::{Context, Result};
use sha2::Digest;
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn marker_lock(path: &Path) -> Result<File> {
    let key = format!(
        "{:x}",
        sha2::Sha256::digest(path.file_name().unwrap().as_encoded_bytes())
    );
    let lock = path
        .parent()
        .unwrap()
        .join(format!(".prnext-readiness-{key}.lock"));
    if let Ok(info) = std::fs::symlink_metadata(&lock) {
        anyhow::ensure!(
            info.is_file() && !info.is_symlink(),
            "readiness lock must be an ordinary file"
        );
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(lock)?;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(error) if Instant::now() >= deadline => {
                anyhow::bail!("readiness marker lock unavailable: {error}")
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
}

pub(super) struct Readiness {
    file: Option<(PathBuf, Vec<u8>)>,
}
impl Readiness {
    pub(super) async fn publish(
        path: Option<&Path>,
        address: &str,
        prewarmed: bool,
    ) -> Result<Self> {
        let Some(path) = path else {
            return Ok(Self { file: None });
        };
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir()?.join(path)
        };
        let name = path
            .file_name()
            .context("readiness file needs a filename")?;
        let parent =
            tokio::fs::canonicalize(path.parent().context("readiness file needs a parent")?)
                .await
                .context("readiness parent must already exist")?;
        let target = parent.join(name);
        if let Ok(info) = tokio::fs::symlink_metadata(&target).await {
            anyhow::ensure!(
                info.is_file() && !info.is_symlink(),
                "readiness target must be an ordinary file"
            );
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|error| anyhow::anyhow!("readiness random source: {error}"))?;
        let generation = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let temporary = parent.join(format!(".prnext-ready-{generation}.tmp"));
        let bytes = serde_json::to_vec(
            &serde_json::json!({"version":1,"ready":true,"pid":std::process::id(),"address":address,"render":if prewarmed{"prewarmed"}else{"lazy"},"generation":generation}),
        )?;
        let destination = target.clone();
        let written = bytes.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let _lock = marker_lock(&destination)?;
            if let Ok(info) = std::fs::symlink_metadata(&destination) {
                anyhow::ensure!(
                    info.is_file() && !info.is_symlink(),
                    "readiness target must be an ordinary file"
                );
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let result = (|| -> Result<()> {
                let mut file = options.open(&temporary)?;
                file.write_all(&written)?;
                file.sync_all()?;
                drop(file);
                std::fs::rename(&temporary, &destination)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(temporary);
            }
            result
        })
        .await??;
        Ok(Self {
            file: Some((target, bytes)),
        })
    }
    pub(super) async fn close(self) {
        if let Some((path, bytes)) = self.file {
            // A supervised replacement may already have published its readiness.
            // Do not remove a newer generation's marker during old-process drain.
            let _ = tokio::task::spawn_blocking(move || -> Result<()> {
                let _lock = marker_lock(&path)?;
                if std::fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
                    std::fs::remove_file(path)?;
                }
                Ok(())
            })
            .await;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn atomic_marker_distinguishes_lazy_and_warm_and_preserves_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ready.json");
        let first = Readiness::publish(Some(&path), "127.0.0.1:1", false)
            .await
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(value["render"], "lazy");
        let second = Readiness::publish(Some(&path), "127.0.0.1:2", true)
            .await
            .unwrap();
        first.close().await;
        assert!(path.exists());
        let value: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(value["render"], "prewarmed");
        second.close().await;
        assert!(!path.exists());
        assert!(Readiness::publish(Some(dir.path()), "x", false)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn concurrent_replacement_cannot_be_removed_by_old_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ready.json");
        for _ in 0..12 {
            let old = Readiness::publish(Some(&path), "old", false).await.unwrap();
            let (_, new) = tokio::join!(old.close(), Readiness::publish(Some(&path), "new", true));
            let new = new.unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&tokio::fs::read(&path).await.unwrap())
                    .unwrap()["address"],
                "new"
            );
            new.close().await;
        }
    }
}
