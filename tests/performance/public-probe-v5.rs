//! Standalone std-only mechanism benchmark; no production imports or cache.
//! public-probe-v5.exe PUBLIC_ROOT OUTPUT_JSONL [iterations=10000] [rounds=8]
//! The output must not exist. The benchmark never creates or modifies a fixture.
use std::{
    env,
    fs::{self, File},
    hint::black_box,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Copy, Default)]
struct Counts {
    path_metadata: u64,
    open: u64,
    handle_metadata: u64,
    found: u64,
    not_found: u64,
    not_directory: u64,
    denied: u64,
    other: u64,
    bytes: u64,
}

impl Counts {
    fn error(&mut self, error: io::Error) {
        match error.kind() {
            io::ErrorKind::NotFound => self.not_found += 1,
            io::ErrorKind::NotADirectory => self.not_directory += 1,
            io::ErrorKind::PermissionDenied => self.denied += 1,
            _ => self.other += 1,
        }
    }

    fn json(self) -> String {
        format!(
            "{{\"pathMetadataCalls\":{},\"openCalls\":{},\"handleMetadataCalls\":{},\"found\":{},\"notFound\":{},\"notDirectory\":{},\"permissionDenied\":{},\"otherErrors\":{},\"metadataBytesChecksum\":{}}}",
            self.path_metadata, self.open, self.handle_metadata, self.found,
            self.not_found, self.not_directory, self.denied, self.other, self.bytes,
        )
    }

    fn validate(self, iterations: u64, present: bool) {
        assert_eq!(self.denied + self.other, 0, "Unexpected filesystem failure");
        assert_eq!(self.found, if present { iterations } else { 0 });
        assert_eq!(self.not_found + self.not_directory, if present { 0 } else { iterations });
    }
}

#[derive(Clone, Copy)]
enum Variant {
    Metadata,
    Open,
    OpenHandleMetadata,
    MetadataThenOpenHandleMetadata,
}

impl Variant {
    fn name(self) -> &'static str {
        match self {
            Self::Metadata => "metadata",
            Self::Open => "open",
            Self::OpenHandleMetadata => "open_handle_metadata",
            Self::MetadataThenOpenHandleMetadata => "metadata_then_open_handle_metadata",
        }
    }
}

// Same error classes and operations as the public-file probing paths. Successful
// File values drop before the next iteration, including the close-handle cost.
#[inline(never)]
fn probe(path: &Path, variant: Variant, counts: &mut Counts) {
    if matches!(variant, Variant::Metadata | Variant::MetadataThenOpenHandleMetadata) {
        counts.path_metadata += 1;
        match fs::metadata(black_box(path)) {
            Ok(metadata) => {
                assert!(metadata.is_file(), "The present control became a directory");
                if matches!(variant, Variant::Metadata) {
                    counts.found += 1;
                    counts.bytes = counts.bytes.wrapping_add(black_box(metadata.len()));
                    return;
                }
            }
            Err(error) => {
                counts.error(error);
                return;
            }
        }
    }
    counts.open += 1;
    match File::open(black_box(path)) {
        Ok(source) => {
            if matches!(variant, Variant::Open) {
                counts.found += 1;
                black_box(&source);
            } else {
                counts.handle_metadata += 1;
                match source.metadata() {
                    Ok(metadata) => {
                        assert!(metadata.is_file(), "The present control became a directory");
                        counts.found += 1;
                        counts.bytes = counts.bytes.wrapping_add(black_box(metadata.len()));
                    }
                    Err(error) => counts.error(error),
                }
            }
        }
        Err(error) => counts.error(error),
    }
}

fn json_string(value: &str) -> String {
    let mut result = String::from("\"");
    for character in value.chars() {
        match character {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            character if character < ' ' => result.push_str(&format!("\\u{:04x}", character as u32)),
            character => result.push(character),
        }
    }
    result.push('"');
    result
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = env::args_os().collect();
    assert!((3..=5).contains(&arguments.len()), "PUBLIC_ROOT OUTPUT_JSONL [iterations] [rounds] required");
    let root = fs::canonicalize(&arguments[1])?;
    assert!(root.is_dir());
    let output = PathBuf::from(&arguments[2]);
    let number = |index: usize, default: u64| -> u64 {
        arguments.get(index).map(|value| value.to_str().unwrap().parse().unwrap()).unwrap_or(default)
    };
    let iterations = number(3, 10_000);
    let rounds = number(4, 8);
    assert!((1_000..=1_000_000).contains(&iterations));
    assert!((4..=32).contains(&rounds) && rounds % 4 == 0);
    let warmup_iterations = (iterations / 10).min(1_000);
    let cases = [("ssr-missing", root.join("ssr"), false),
                 ("api-json-missing", root.join("api/json"), false),
                 ("public-present", root.join("robots.txt"), true)];
    for (_, path, present) in &cases {
        let mut counts = Counts::default();
        probe(path, Variant::Metadata, &mut counts);
        counts.validate(1, *present);
    }
    let file = File::options().write(true).create_new(true).open(output)?;
    let mut writer = BufWriter::new(file);
    writeln!(writer,
        "{{\"type\":\"environment\",\"os\":{},\"arch\":{},\"publicRoot\":{},\"iterations\":{},\"rounds\":{},\"warmupIterations\":{},\"method\":\"filesystem calls only; no read, canonicalization, HTTP, workers or cache\"}}",
        json_string(env::consts::OS), json_string(env::consts::ARCH), json_string(&root.to_string_lossy()),
        iterations, rounds, warmup_iterations)?;
    let variants = [Variant::Metadata, Variant::Open, Variant::OpenHandleMetadata, Variant::MetadataThenOpenHandleMetadata];
    let started_all = Instant::now();
    let mut trials = 0;
    for round in 0..rounds {
        // Rotate the first operation and reverse alternate four-round blocks.
        // Every operation occupies each position equally over eight rounds.
        for case_position in 0..cases.len() {
            let case_index = if round % 2 == 0 { case_position } else { cases.len() - case_position - 1 };
            let (case, path, present) = &cases[case_index];
            for position in 0..variants.len() {
                let ordered = if (round / 4) % 2 == 0 { position } else { variants.len() - position - 1 };
                let variant = variants[(ordered + round as usize) % variants.len()];
                let mut warmup = Counts::default();
                for _ in 0..warmup_iterations {
                    probe(black_box(path), black_box(variant), &mut warmup);
                }
                warmup.validate(warmup_iterations, *present);
                let mut counts = Counts::default();
                let start = Instant::now();
                for _ in 0..iterations {
                    probe(black_box(path), black_box(variant), &mut counts);
                }
                let elapsed = start.elapsed().as_nanos();
                black_box(counts);
                writeln!(writer,
                    "{{\"type\":\"trial\",\"round\":{},\"position\":{},\"casePosition\":{},\"case\":{},\"path\":{},\"present\":{},\"variant\":{},\"iterations\":{},\"elapsedNs\":{},\"nsPerOperation\":{},\"counters\":{},\"warmupCounters\":{}}}",
                    round, position, case_position, json_string(case), json_string(&path.to_string_lossy()), present,
                    json_string(variant.name()), iterations, elapsed, elapsed as f64 / iterations as f64,
                    counts.json(), warmup.json())?;
                writer.flush()?;
                counts.validate(iterations, *present);
                trials += 1;
            }
        }
    }
    writeln!(writer, "{{\"type\":\"final\",\"complete\":true,\"trials\":{},\"elapsedNs\":{}}}", trials, started_all.elapsed().as_nanos())?;
    writer.flush()?;
    Ok(())
}
