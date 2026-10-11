//! Open, check and read the same Windows file object on the small-file path.
//! No handles or path results survive a request; writers retain normal sharing.
use std::{
    ffi::OsString,
    fs::{File, Metadata},
    io,
    os::windows::{ffi::OsStringExt, io::AsRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
};

pub(super) struct OpenedFile {
    pub path: PathBuf,
    pub source: File,
    pub metadata: Metadata,
}

pub(super) fn open(root: &Path, relative: &str) -> io::Result<Option<OpenedFile>> {
    if relative.is_empty() || crate::manifest::validate_relative_file(relative).is_err() {
        return Ok(None);
    }
    open_path(root, &root.join(relative))
}

// Both callers construct this path themselves: root + validated relative path,
// or the canonical identity file's sibling. root is already canonical.
pub(super) fn open_path(root: &Path, candidate: &Path) -> io::Result<Option<OpenedFile>> {
    let source = match File::open(candidate) {
        Ok(source) => source,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    let metadata = {
        let _span = crate::blocking::phase(crate::blocking::Origin::Metadata);
        source.metadata()?
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    let path = {
        let _span = crate::blocking::phase(crate::blocking::Origin::Canonicalize);
        final_path(&source)?
    };
    if !path.starts_with(root) {
        return Ok(None);
    }
    Ok(Some(OpenedFile {
        path,
        source,
        metadata,
    }))
}

fn final_path(source: &File) -> io::Result<PathBuf> {
    fn query(source: &File, buffer: &mut [u16]) -> io::Result<usize> {
        // The borrowed File outlives the call; the buffer is writable for the
        // supplied character count. NORMALIZED follows every reparse point.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                source.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        if length == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(length as usize)
        }
    }

    let mut stack = [0u16; 512];
    let mut length = query(source, &mut stack)?;
    if length < stack.len() {
        return Ok(PathBuf::from(OsString::from_wide(&stack[..length])));
    }
    // On insufficient capacity the API returns the required count including
    // NUL. Bound retries/allocation if a concurrent rename changes the length.
    for _ in 0..2 {
        if length > 32768 {
            break;
        }
        let mut buffer = vec![0; length];
        length = query(source, &mut buffer)?;
        if length < buffer.len() {
            return Ok(PathBuf::from(OsString::from_wide(&buffer[..length])));
        }
    }
    Err(io::Error::other(
        "final file path changed or exceeded its bound",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_unicode_path_and_case_alias_resolve_the_open_handle() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let relative = format!("{}/MiXeD-é-東京.txt", vec!["a".repeat(100); 6].join("/"));
        let file = root.join(&relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "long path").unwrap();
        let alias = relative.replace("MiXeD", "mixed");
        let opened = open(&root, &alias).unwrap().unwrap();
        assert_eq!(opened.path, file.canonicalize().unwrap());
        assert_eq!(opened.metadata.len(), 9);
        assert_eq!(opened.source.metadata().unwrap().len(), 9);
    }

    #[test]
    fn traversal_directories_and_external_symlinks_are_not_opened_for_serving() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("public");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let outside = directory.path().join("private.txt");
        std::fs::write(&outside, "private").unwrap();
        for relative in ["", "../private.txt", "missing"] {
            assert!(open(&root, relative).unwrap().is_none());
        }
        // The real HTTP suite also checks Windows directory junctions.
        match std::os::windows::fs::symlink_file(&outside, root.join("link.txt")) {
            Ok(()) => assert!(open(&root, "link.txt").unwrap().is_none()),
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!("symlink check unavailable: Windows symlink privilege is absent");
            }
            Err(error) => panic!("create symlink: {error}"),
        }
    }
}
