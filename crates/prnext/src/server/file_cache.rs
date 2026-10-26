//! Bounded, lazy cache of small built-file representations. No response headers,
//! route results, or user-specific data are cached. In-flight bodies share Bytes.
use axum::body::Bytes;
use std::{
    collections::HashMap,
    fs::Metadata,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 256;
// A nanosecond-shaped stat field can still use a coarse filesystem/kernel
// clock. Never retain bytes while another write could receive the same ctime.
const CHANGE_TIME_SETTLE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Stamp {
    length: u64,
    modified: SystemTime,
    changed: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64),
}

impl Stamp {
    fn stable_at(&self, now: SystemTime) -> bool {
        now.duration_since(self.changed)
            .is_ok_and(|age| age >= CHANGE_TIME_SETTLE)
    }
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
        let seconds = u64::try_from(metadata.ctime()).ok()?;
        let nanos = u32::try_from(metadata.ctime_nsec()).ok()?;
        if nanos >= 1_000_000_000 {
            return None;
        }
        Some(Stamp {
            length: metadata.len(),
            modified: metadata.modified().ok()?,
            changed: std::time::UNIX_EPOCH.checked_add(Duration::new(seconds, nanos))?,
            identity: (metadata.dev(), metadata.ino()),
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
        if !stamp.stable_at(SystemTime::now()) {
            self.remove(path);
            return None;
        }
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
        if !stamp.stable_at(SystemTime::now())
            || body.len() > 64 * 1024
            || body.is_empty()
            || path.as_os_str().len() > 1024
        {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn test_stamp(changed: SystemTime) -> Stamp {
        Stamp {
            length: 5,
            modified: UNIX_EPOCH,
            changed,
            #[cfg(unix)]
            identity: (1, 1),
        }
    }

    #[test]
    fn coarse_change_times_are_not_cacheable_until_the_clock_window_has_passed() {
        let changed = UNIX_EPOCH + Duration::from_secs(100);
        let stamp = test_stamp(changed);
        // SystemTime on Windows uses 100 ns ticks; use a representable delta.
        assert!(!stamp.stable_at(changed - Duration::from_micros(1)));
        assert!(!stamp.stable_at(changed));
        assert!(!stamp.stable_at(changed + CHANGE_TIME_SETTLE - Duration::from_micros(1)));
        assert!(stamp.stable_at(changed + CHANGE_TIME_SETTLE));
    }

    #[test]
    fn identical_recent_change_times_never_reuse_or_retain_old_bytes() {
        let path = Path::new("/same-coarse-timestamp");
        let recent = test_stamp(SystemTime::now() + Duration::from_secs(60));
        let mut cache = FileCache::default();
        for body in [b"first", b"other"] {
            cache.insert(path, recent.clone(), Bytes::from_static(body));
            assert!(cache.get(path, &recent).is_none());
            assert_eq!(cache.bytes, 0);
            assert!(cache.entries.is_empty());
        }
        let stable = test_stamp(UNIX_EPOCH);
        cache.insert(path, stable.clone(), Bytes::from_static(b"first"));
        assert_eq!(cache.get(path, &stable).unwrap(), "first");
        assert!(cache.get(path, &recent).is_none());
        assert_eq!(cache.bytes, 0);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn cache_bounds_bytes_and_entries_and_shares_hits() {
        let stamp = test_stamp(UNIX_EPOCH);
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
