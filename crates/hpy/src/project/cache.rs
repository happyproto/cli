//! `~/.cache/hpy`: HappyView binaries and plugins, shared by every project.
//! Everything is written beside its final name and renamed into place, so a
//! reader (another `hpy`, a running HappyView) sees the old entry or the new
//! one, never half of one. The cache holds code that gets executed, so its
//! directories are private to the user.

use std::path::{Path, PathBuf};

use crate::failure::Failure;

pub fn cache_root() -> Result<PathBuf, Failure> {
    let (root, origin) = match std::env::var_os("HPY_CACHE_DIR").filter(|d| !d.is_empty()) {
        Some(dir) => (PathBuf::from(dir), RootOrigin::Named),
        None => {
            use etcetera::BaseStrategy;
            let strategy = etcetera::choose_base_strategy().map_err(Failure::runtime)?;
            (strategy.cache_dir().join("hpy"), RootOrigin::Default)
        }
    };
    prepare_root(&root, origin).map_err(|e| {
        Failure::runtime(format!(
            "the cache directory {} cannot be trusted: {e}",
            root.display()
        ))
    })?;
    Ok(root)
}

pub fn plugin_dir(root: &Path, id: &str, version: &str) -> PathBuf {
    root.join("plugins").join(id).join(version)
}

/// Where the HappyView binary for `version` lives. A binary for another
/// machine than this one sits one level deeper, under its triple, so both can
/// be cached side by side.
pub fn binary_path(root: &Path, version: &str, target: &str) -> PathBuf {
    let dir = root.join("happyview").join(version);
    let dir = if target == crate::project::binary::HOST_TARGET {
        dir
    } else {
        dir.join(target)
    };
    dir.join(crate::project::binary::BINARY_NAME)
}

/// Creates `path` and any missing parents, 0700 on unix, so nothing another
/// user could swap a module into is ever world-writable.
fn create_private_dirs(path: &Path) -> std::io::Result<()> {
    private_dir_builder().recursive(true).create(path)
}

/// A builder whose directories only their owner can enter, where the
/// platform has modes.
fn private_dir_builder() -> std::fs::DirBuilder {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    }
    #[cfg(not(unix))]
    std::fs::DirBuilder::new()
}

/// Whether a cache root is one the user named (`HPY_CACHE_DIR`), whose mode
/// is theirs to decide, or hpy's own default, which hpy may tighten.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RootOrigin {
    Named,
    Default,
}

fn refuse(why: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::PermissionDenied, why)
}

/// Makes sure the cache root and its `plugins/` and `happyview/` directories
/// exist and are this user's alone. The cache holds code that gets executed,
/// so a directory another user owns, a symlink that could be repointed, or
/// anything that is not a directory is refused before anything is created
/// inside it. A loose mode is tightened to 0700 only on a directory hpy owns:
/// one it just created, its default root, or the two beneath the root. A root
/// the user named with a loose mode is refused instead, since its mode is
/// theirs.
pub fn prepare_root(root: &Path, origin: RootOrigin) -> std::io::Result<()> {
    let root_created = prepare_dir(root, true)?;
    let tighten_root = root_created || origin == RootOrigin::Default;
    check_private(root, tighten_root)?;
    for sub in ["plugins", "happyview"] {
        let dir = root.join(sub);
        prepare_dir(&dir, false)?;
        check_private(&dir, true)?;
    }
    Ok(())
}

/// Creates `dir` 0700 when it is absent, and refuses a symlink or anything
/// that is not a directory. Answers whether it was created.
fn prepare_dir(dir: &Path, with_parents: bool) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(refuse(format!("{} is a symlink", dir.display())))
        }
        Ok(meta) if !meta.is_dir() => Err(refuse(format!("{} is not a directory", dir.display()))),
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if with_parents {
                create_private_dirs(dir)?;
            } else {
                private_dir_builder().create(dir)?;
            }
            // Someone else may have put a link there in between.
            prepare_dir(dir, false).map(|_| true)
        }
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn check_private(dir: &Path, may_tighten: bool) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = std::fs::symlink_metadata(dir)?;
    // SAFETY: `geteuid` reads a process attribute and cannot fail.
    let euid = unsafe { libc::geteuid() };
    if meta.uid() != euid {
        return Err(refuse(format!(
            "{} is owned by uid {}, not by this user",
            dir.display(),
            meta.uid()
        )));
    }
    let mode = meta.mode() & 0o777;
    if mode & 0o077 != 0 {
        if !may_tighten {
            return Err(refuse(format!(
                "{} has mode {mode:o}, so other users can reach the code hpy keeps there; \
                 hpy does not change the mode of a directory you named, so run \
                 `chmod 700 {}` or point HPY_CACHE_DIR somewhere private",
                dir.display(),
                dir.display()
            )));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private(_dir: &Path, _may_tighten: bool) -> std::io::Result<()> {
    Ok(())
}

/// A name no other process, or task in this one, is using.
fn partial(path: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    path.with_file_name(format!(
        ".{name}.partial-{}-{}-{nanos:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Removes leftovers of installs that were killed before they could rename.
/// An hour is far longer than any download, so a live install is never hit.
fn sweep_stale(parent: &Path) {
    let cutoff = std::time::Duration::from_secs(3600);
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with('.') && name.contains(".partial-")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > cutoff);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Whether `dir` holds exactly `files`, byte for byte.
fn holds(dir: &Path, files: &[(&str, &[u8])]) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let names: Vec<_> = entries.flatten().map(|e| e.file_name()).collect();
    names.len() == files.len()
        && files
            .iter()
            .all(|(name, bytes)| std::fs::read(dir.join(name)).is_ok_and(|b| b == *bytes))
}

fn create_new(path: &Path, mode: u32) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(path)
}

/// Makes `dir` a directory holding exactly `files`. Each name must be a plain
/// file name: nothing is written outside `dir`.
///
/// The finished directory is renamed straight onto `dir`, so a reader sees
/// the old entry or the new one. When `dir` already exists the entry is
/// either what a concurrent install just wrote (kept, ours discarded) or
/// something else, which is moved aside whole before ours takes its place.
pub fn install_dir(dir: &Path, files: &[(&str, &[u8])]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = dir.parent().unwrap_or(Path::new("."));
    create_private_dirs(parent)?;
    sweep_stale(parent);
    let tmp = partial(dir);
    private_dir_builder().create(&tmp)?;
    let written = files.iter().try_for_each(|(name, bytes)| {
        let plain = Path::new(name).components().count() == 1
            && Path::new(name).file_name().is_some_and(|n| n == *name);
        if !plain {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("`{name}` is not a plain file name"),
            ));
        }
        create_new(&tmp.join(name), 0o600)?.write_all(bytes)
    });
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let mut last = None;
    for _ in 0..5 {
        match std::fs::rename(&tmp, dir) {
            Ok(()) => return Ok(()),
            Err(e) if !dir.exists() => {
                last = Some(e);
                continue;
            }
            Err(e) => last = Some(e),
        }
        if holds(dir, files) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Ok(());
        }
        let aside = partial(dir);
        match std::fs::rename(dir, &aside) {
            Ok(()) => {
                let _ = std::fs::remove_dir_all(&aside);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => last = Some(e),
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    Err(last.unwrap_or_else(|| std::io::Error::other("could not install the directory")))
}

pub fn install_file(path: &Path, bytes: &[u8], executable: bool) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path.parent().unwrap_or(Path::new("."));
    create_private_dirs(parent)?;
    sweep_stale(parent);
    let tmp = partial(path);
    let mode = if executable { 0o755 } else { 0o600 };
    let written = create_new(&tmp, mode).and_then(|mut f| f.write_all(bytes));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_dir_replaces_a_directory_whole() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("plugins/x/1.0.0");
        install_dir(&dir, &[("a", b"one"), ("b", b"two")]).unwrap();
        install_dir(&dir, &[("a", b"three")]).unwrap();
        assert_eq!(std::fs::read(dir.join("a")).unwrap(), b"three");
        assert!(!dir.join("b").exists());
        let leftovers: Vec<_> = std::fs::read_dir(dir.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, [std::ffi::OsString::from("1.0.0")]);
    }

    #[test]
    fn install_dir_refuses_a_name_that_leaves_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("plugins/x/1.0.0");
        assert!(install_dir(&dir, &[("../escape", b"x")]).is_err());
        assert!(!dir.exists());
        assert!(!root.path().join("plugins/x/escape").exists());
        let leftovers = std::fs::read_dir(dir.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 0);
    }

    #[cfg(unix)]
    #[test]
    fn install_file_can_mark_executable() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("happyview/3.0.0/happyview");
        install_file(&path, b"#!/bin/sh\n", true).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(unix)]
    #[test]
    fn created_directories_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("plugins/x/1.0.0");
        install_dir(&dir, &[("a", b"one")]).unwrap();
        for d in [&dir, dir.parent().unwrap(), &root.path().join("plugins")] {
            assert_eq!(
                std::fs::metadata(d).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn concurrent_installs_both_succeed_and_keep_one_whole_entry() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("plugins/x/1.0.0");
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..20 {
                        install_dir(&dir, &[("a", b"one"), ("b", b"two")]).unwrap();
                        assert!(dir.join("a").exists() && dir.join("b").exists());
                    }
                });
            }
        });
        assert!(holds(&dir, &[("a", b"one"), ("b", b"two")]));
        let leftovers = std::fs::read_dir(dir.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1);
    }

    #[test]
    fn a_failed_install_leaves_the_old_entry() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("plugins/x/1.0.0");
        install_dir(&dir, &[("a", b"good")]).unwrap();
        assert!(install_dir(&dir, &[("a", b"new"), ("../b", b"x")]).is_err());
        assert!(holds(&dir, &[("a", b"good")]));
        assert_eq!(std::fs::read_dir(dir.parent().unwrap()).unwrap().count(), 1);
    }

    /// A directory opened so its times can be set. Windows opens a directory
    /// only with backup semantics, and setting a time needs write-attributes
    /// access, which a plain `File::open` does not ask for.
    fn open_dir(path: &Path) -> std::fs::File {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            std::fs::OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .unwrap()
        }
        #[cfg(not(windows))]
        std::fs::File::open(path).unwrap()
    }

    #[test]
    fn stale_partials_are_swept_and_fresh_ones_kept() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("plugins/x");
        std::fs::create_dir_all(&parent).unwrap();
        let stale = parent.join(".1.0.0.partial-1-0-0");
        let fresh = parent.join(".2.0.0.partial-1-0-0");
        std::fs::create_dir(&stale).unwrap();
        std::fs::create_dir(&fresh).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        open_dir(&stale).set_modified(old).unwrap();
        install_dir(&parent.join("3.0.0"), &[("a", b"x")]).unwrap();
        assert!(!stale.exists());
        assert!(fresh.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_root_that_is_not_this_users_to_trust_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |d: &Path| std::fs::metadata(d).unwrap().permissions().mode() & 0o777;
        let base = tempfile::tempdir().unwrap();
        let real = base.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = base.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        for origin in [RootOrigin::Named, RootOrigin::Default] {
            let err = prepare_root(&link, origin).unwrap_err();
            assert!(err.to_string().contains("is a symlink"), "{err}");
        }
        // Refused before anything was made through the link.
        assert_eq!(std::fs::read_dir(&real).unwrap().count(), 0);

        // A directory the user named keeps its mode, and is refused.
        let loose = base.path().join("loose");
        std::fs::create_dir(&loose).unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = prepare_root(&loose, RootOrigin::Named).unwrap_err();
        assert!(err.to_string().contains("chmod 700"), "{err}");
        assert_eq!(mode(&loose), 0o755);
        assert_eq!(std::fs::read_dir(&loose).unwrap().count(), 0);

        // hpy's own default root is tightened, with what it holds.
        std::fs::create_dir(loose.join("plugins")).unwrap();
        std::fs::set_permissions(
            loose.join("plugins"),
            std::fs::Permissions::from_mode(0o777),
        )
        .unwrap();
        prepare_root(&loose, RootOrigin::Default).unwrap();
        for d in [
            loose.clone(),
            loose.join("plugins"),
            loose.join("happyview"),
        ] {
            assert_eq!(mode(&d), 0o700, "{}", d.display());
        }

        let linked = base.path().join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(&real, linked.join("happyview")).unwrap();
        assert!(prepare_root(&linked, RootOrigin::Named).is_err());

        let file = base.path().join("file");
        std::fs::write(&file, b"").unwrap();
        let err = prepare_root(&file, RootOrigin::Named).unwrap_err();
        assert!(err.to_string().contains("not a directory"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_named_root_hpy_creates_is_private_and_its_subdirectories_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |d: &Path| std::fs::metadata(d).unwrap().permissions().mode() & 0o777;
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("a/b/cache");
        prepare_root(&root, RootOrigin::Named).unwrap();
        for d in [root.clone(), root.join("plugins"), root.join("happyview")] {
            assert_eq!(mode(&d), 0o700, "{}", d.display());
        }
        // Beneath a named root, the two directories are hpy's.
        std::fs::set_permissions(root.join("plugins"), std::fs::Permissions::from_mode(0o775))
            .unwrap();
        prepare_root(&root, RootOrigin::Named).unwrap();
        assert_eq!(mode(&root.join("plugins")), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_at_a_temp_name_is_never_followed() {
        let root = tempfile::tempdir().unwrap();
        let victim = root.path().join("victim");
        std::fs::write(&victim, b"keep").unwrap();
        let path = root.path().join("bin/happyview");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        install_file(&path, b"new", false).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        let tmp = root.path().join("bin/t");
        std::os::unix::fs::symlink(&victim, &tmp).unwrap();
        assert!(create_new(&tmp, 0o600).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
    }
}
