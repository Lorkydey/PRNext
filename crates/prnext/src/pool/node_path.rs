use std::path::{Path, PathBuf};

/// Rust canonicalization returns verbatim Windows paths; Node's entry-point
/// resolver expects ordinary drive/UNC paths. Keep canonical paths everywhere
/// else, especially for filesystem containment checks.
pub(super) fn for_node(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::path::{Component, Prefix};
        let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if let Some(Component::Prefix(prefix)) = path.components().next() {
            match prefix.kind() {
                Prefix::VerbatimDisk(_) => {
                    return OsString::from_wide(&wide[4..]).into();
                }
                Prefix::VerbatimUNC(_, _) => {
                    let unc = [vec![b'\\' as u16; 2], wide[8..].to_vec()].concat();
                    return OsString::from_wide(&unc).into();
                }
                _ => {}
            }
        }
    }
    path.to_path_buf()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn node_arguments_preserve_unicode_and_unc_paths() {
        for (input, expected) in [
            (r"\\?\C:\app é\worker.mjs", r"C:\app é\worker.mjs"),
            (
                r"\\?\UNC\host\share\app é\worker.mjs",
                r"\\host\share\app é\worker.mjs",
            ),
            (r"C:\app\worker.mjs", r"C:\app\worker.mjs"),
            (r"\\host\share\worker.mjs", r"\\host\share\worker.mjs"),
        ] {
            assert_eq!(for_node(Path::new(input)), PathBuf::from(expected));
        }
    }
}
