//! V8 caches compiled code, never application state or responses. Node validates
//! source contents and separates incompatible Node/V8 versions automatically.
use std::path::{Path, PathBuf};
use tokio::process::Command;

fn directory(project: &Path) -> Option<PathBuf> {
    let root = std::fs::canonicalize(project).ok()?;
    let mut path = root;
    for part in [".prnext-cache", "node-compile-v1"] {
        path.push(part);
        match std::fs::create_dir(&path) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).ok()?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
        let info = std::fs::symlink_metadata(&path).ok()?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return None;
        }
    }
    // Code-cache files are disposable. Bound retained bytes across old Node
    // versions and build generations; open readers remain valid on Unix.
    let mut files = Vec::new();
    fn collect(root: &Path, depth: usize, files: &mut Vec<(PathBuf, u64, std::time::SystemTime)>) {
        if depth > 3 || files.len() >= 8192 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten().take(8192) {
            let Ok(info) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if info.file_type().is_symlink() {
                continue;
            }
            if info.is_dir() {
                collect(&entry.path(), depth + 1, files);
            } else if info.is_file() {
                files.push((
                    entry.path(),
                    info.len(),
                    info.modified().unwrap_or(std::time::UNIX_EPOCH),
                ));
            }
            if files.len() >= 8192 {
                break;
            }
        }
    }
    collect(&path, 0, &mut files);
    files.sort_by_key(|entry| std::cmp::Reverse(entry.2));
    let mut bytes = 0u64;
    for (i, (name, size, _)) in files.into_iter().enumerate() {
        bytes = bytes.saturating_add(size);
        if i >= 4096 || bytes > 128 * 1024 * 1024 {
            let _ = std::fs::remove_file(name);
        }
    }
    Some(path)
}
pub(super) async fn configure(command: &mut Command, project: &Path) {
    if std::env::var("PRNEXT_WORKER_COMPILE_CACHE").as_deref() == Ok("0")
        || std::env::var("NODE_DISABLE_COMPILE_CACHE").as_deref() == Ok("1")
        || std::env::var_os("NODE_COMPILE_CACHE").is_some()
    {
        return;
    }
    let project = project.to_owned();
    if let Ok(Some(path)) = tokio::task::spawn_blocking(move || directory(&project)).await {
        command.env("NODE_COMPILE_CACHE", super::node_path::for_node(&path));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_cache_reuses_ordinary_directories_and_fails_soft_for_invalid_paths() {
        let temp = tempfile::tempdir().unwrap();
        let cache = directory(temp.path()).unwrap();
        assert_eq!(directory(temp.path()), Some(cache.clone()));
        assert!(cache.starts_with(temp.path().canonicalize().unwrap()));
        let blocked = tempfile::tempdir().unwrap();
        std::fs::write(blocked.path().join(".prnext-cache"), b"file").unwrap();
        assert!(directory(blocked.path()).is_none());
    }
    #[cfg(unix)]
    #[test]
    fn cache_does_not_follow_a_project_cache_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), temp.path().join(".prnext-cache")).unwrap();
        assert!(directory(temp.path()).is_none());
        assert_eq!(std::fs::read_dir(other.path()).unwrap().count(), 0);
    }
}
