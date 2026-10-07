//! Bounded, opt-in local event logs; no headers, cookies, queries or bodies.
use serde_json::Value;
use std::{
    io::Write,
    sync::{mpsc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

static WRITER: OnceLock<Option<mpsc::SyncSender<Value>>> = OnceLock::new();

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("PRNEXT_INSPECT_DIR").is_some())
}
pub fn record(mut event: Value) {
    let writer = WRITER.get_or_init(|| {
        let directory = std::path::PathBuf::from(std::env::var_os("PRNEXT_INSPECT_DIR")?);
        let (sender, receiver) = mpsc::sync_channel::<Value>(256);
        std::thread::spawn(move || {
            if std::fs::create_dir_all(&directory).is_err() {
                return;
            }
            if let Ok(entries) = std::fs::read_dir(&directory) {
                let mut logs: Vec<_> = entries
                    .flatten()
                    .filter(|entry| {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        name.strip_prefix("native-")
                            .and_then(|v| {
                                v.strip_suffix(".jsonl.1")
                                    .or_else(|| v.strip_suffix(".jsonl"))
                            })
                            .is_some_and(|pid| {
                                !pid.is_empty() && pid.bytes().all(|c| c.is_ascii_digit())
                            })
                    })
                    .filter_map(|entry| {
                        Some((entry.metadata().ok()?.modified().ok()?, entry.path()))
                    })
                    .collect();
                logs.sort_by_key(|(time, _)| std::cmp::Reverse(*time));
                for (_, file) in logs.into_iter().skip(30) {
                    let _ = std::fs::remove_file(file);
                }
            }
            let file = directory.join(format!("native-{}.jsonl", std::process::id()));
            let previous = file.with_extension("jsonl.1");
            let mut size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            for event in receiver {
                let Ok(mut bytes) = serde_json::to_vec(&event) else {
                    continue;
                };
                if bytes.len() > 4096 {
                    continue;
                }
                bytes.push(b'\n');
                if size + bytes.len() as u64 > 1024 * 1024 {
                    let _ = std::fs::remove_file(&previous);
                    let _ = std::fs::rename(&file, &previous);
                    size = 0;
                }
                let mut options = std::fs::OpenOptions::new();
                options.create(true).append(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                if let Ok(mut output) = options.open(&file) {
                    if output.write_all(&bytes).is_ok() {
                        size += bytes.len() as u64;
                    }
                }
            }
        });
        Some(sender)
    });
    if let Some(writer) = writer {
        event["time"] = (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64)
            .into();
        event["pid"] = std::process::id().into();
        let _ = writer.try_send(event);
    }
}
