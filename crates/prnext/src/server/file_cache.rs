//! Bounded, lazy cache of small built-file representations. No response headers,
//! route results, or user-specific data are cached. In-flight bodies share Bytes.
use axum::body::Bytes;
use std::{
    collections::HashMap,
    fs::Metadata,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Stamp {
    length: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

pub(super) fn stamp(metadata: &Metadata) -> Option<Stamp> {
    // Unix ctime also detects in-place writes with a restored mtime. Fall back
    // to ordinary reads on platforms without this change/identity information.
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(Stamp {
            length: metadata.len(),
            modified: metadata.modified().ok()?,
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        })
    }
}

struct Entry {
    stamp: Stamp,
    body: Bytes,
    used: u64,
}
#[derive(Default)]
pub(super) struct FileCache {
    entries: HashMap<PathBuf, Entry>,
    bytes: usize,
    clock: u64,
}

impl FileCache {
    fn remove(&mut self, path: &Path) {
        if let Some(entry) = self.entries.remove(path) {
            self.bytes -= entry.body.len();
        }
    }
    pub(super) fn get(&mut self, path: &Path, stamp: &Stamp) -> Option<Bytes> {
        self.clock = self.clock.wrapping_add(1);
        let entry = self.entries.get_mut(path)?;
        if &entry.stamp != stamp {
            self.remove(path);
            return None;
        }
        entry.used = self.clock;
        Some(entry.body.clone())
    }
    pub(super) fn insert(&mut self, path: &Path, stamp: Stamp, body: Bytes) {
        self.remove(path);
        // Bound keys as well as bodies; the entry cap bounds hash-table overhead.
        if body.len() > 64 * 1024 || body.is_empty() || path.as_os_str().len() > 1024 {
            return;
        }
        while self.bytes + body.len() > MAX_BYTES || self.entries.len() >= MAX_ENTRIES {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(p, _)| p.clone());
            let Some(oldest) = oldest else {
                break;
            };
            self.remove(&oldest);
        }
        self.clock = self.clock.wrapping_add(1);
        self.bytes += body.len();
        self.entries.insert(
            path.to_owned(),
            Entry {
                stamp,
                body,
                used: self.clock,
            },
        );
    }
}

pub(super) fn cache() -> &'static Mutex<FileCache> {
    static CACHE: OnceLock<Mutex<FileCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(FileCache::default()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn cache_bounds_bytes_and_entries_and_shares_hits() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let stamp = stamp(&file.as_file().metadata().unwrap()).unwrap();
        let mut cache = FileCache::default();
        for i in 0..400 {
            cache.insert(
                Path::new(&format!("/{i}")),
                stamp.clone(),
                Bytes::from(vec![0; 65536]),
            );
            assert!(cache.bytes <= MAX_BYTES);
            assert!(cache.entries.len() <= MAX_ENTRIES);
        }
        let first = cache.get(Path::new("/399"), &stamp).unwrap();
        assert_eq!(
            first.as_ptr(),
            cache.get(Path::new("/399"), &stamp).unwrap().as_ptr()
        );
        assert!(cache.get(Path::new("/0"), &stamp).is_none());
        let mut changed = stamp.clone();
        changed.length += 1;
        assert!(cache.get(Path::new("/399"), &changed).is_none());
        for i in 0..400 {
            cache.insert(
                Path::new(&format!("/small/{i}")),
                stamp.clone(),
                Bytes::from_static(b"x"),
            );
        }
        assert_eq!(cache.entries.len(), MAX_ENTRIES);
    }
}
