//! `.happyview/plugins/`, where `happyview dev` loads plugins from. The
//! directory belongs to `hpy`: after a placement it holds exactly the locked
//! plugins and nothing else.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PLUGINS_DIR: &str = ".happyview/plugins";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceMode {
    /// A symlink into the shared cache; copies on Windows, where creating
    /// one needs a privilege most accounts lack.
    Link,
    /// A real copy, for a reader that cannot follow a link into the host's
    /// cache, such as a container.
    Copy,
}

pub struct Placement<'a> {
    pub id: &'a str,
    pub source: &'a Path,
}

pub fn place_plugins(
    root: &Path,
    plugins: &[Placement<'_>],
    mode: PlaceMode,
) -> std::io::Result<()> {
    for plugin in plugins {
        check_id(plugin.id)?;
    }
    let dir = root.join(PLUGINS_DIR);
    create_private_parent(&dir)?;
    require_real_dir(&dir)?;
    std::fs::create_dir_all(&dir)?;
    let wanted: BTreeMap<&str, &Path> = plugins.iter().map(|p| (p.id, p.source)).collect();
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        let keep = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| wanted.get(n))
            .is_some_and(|source| mode == PlaceMode::Link && points_at(&path, source));
        if !keep {
            remove(&path)?;
        }
    }
    for (id, source) in wanted {
        let dest = dir.join(id);
        if dest.symlink_metadata().is_ok() {
            continue;
        }
        match mode {
            PlaceMode::Link => link(source, &dest)?,
            PlaceMode::Copy => copy_dir(source, &dest)?,
        }
    }
    Ok(())
}

/// Makes `.happyview` owner-only when this call creates it, so a command that
/// never tightens permissions afterwards does not leave it world-readable.
fn create_private_parent(dir: &Path) -> std::io::Result<()> {
    let Some(parent) = dir.parent() else {
        return Ok(());
    };
    if require_real_dir(parent)? {
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)
}

/// Whether `path` exists as a real directory. A link or a file there is
/// refused, a dangling link included: pruning through one would delete
/// whatever it points at.
fn require_real_dir(path: &Path) -> std::io::Result<bool> {
    let invalid = |what: &str| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{} {what}", path.display()),
        )
    };
    match path.symlink_metadata() {
        Ok(m) if m.file_type().is_symlink() => {
            Err(invalid("is a symlink; replace it with a real directory"))
        }
        Ok(m) if !m.is_dir() => Err(invalid("is not a directory")),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// A plugin id becomes one path segment under `plugins/`.
fn check_id(id: &str) -> std::io::Result<()> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\']) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("`{id}` cannot name a plugin directory"),
        ));
    }
    Ok(())
}

fn points_at(path: &Path, source: &Path) -> bool {
    std::fs::read_link(path).is_ok_and(|target| target == source)
}

/// Removes a link as a link: following it would delete the cached plugin
/// every other project shares.
fn remove(path: &Path) -> std::io::Result<()> {
    let meta = path.symlink_metadata()?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    }
}

#[cfg(unix)]
fn link(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, dest)
}

#[cfg(not(unix))]
fn link(source: &Path, dest: &Path) -> std::io::Result<()> {
    copy_dir(source, dest)
}

fn copy_dir(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let to: PathBuf = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cached(root: &Path, id: &str, version: &str) -> PathBuf {
        let dir = root.join(id).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), format!("{{\"id\":\"{id}\"}}")).unwrap();
        std::fs::write(dir.join(format!("{id}.wasm")), b"\0asm").unwrap();
        dir
    }

    #[test]
    fn places_exactly_the_given_plugins() {
        let cache = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let lua = cached(cache.path(), "happyview-lua", "1.4.2");
        let stray = project.path().join(PLUGINS_DIR).join("removed-plugin");
        std::fs::create_dir_all(&stray).unwrap();
        for mode in [PlaceMode::Link, PlaceMode::Copy] {
            place_plugins(
                project.path(),
                &[Placement {
                    id: "happyview-lua",
                    source: &lua,
                }],
                mode,
            )
            .unwrap();
            let placed = project.path().join(PLUGINS_DIR).join("happyview-lua");
            assert!(placed.join("manifest.json").is_file(), "{mode:?}");
            assert!(!stray.exists(), "{mode:?}");
            let names: Vec<_> = std::fs::read_dir(project.path().join(PLUGINS_DIR))
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert_eq!(names.len(), 1, "{mode:?}");
        }
    }

    #[test]
    fn a_new_version_replaces_the_old_one() {
        let cache = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let old = cached(cache.path(), "happyview-lua", "1.4.2");
        let new = cached(cache.path(), "happyview-lua", "1.5.0");
        std::fs::write(new.join("marker"), "new").unwrap();
        for source in [&old, &new] {
            place_plugins(
                project.path(),
                &[Placement {
                    id: "happyview-lua",
                    source,
                }],
                PlaceMode::Link,
            )
            .unwrap();
        }
        let placed = project.path().join(PLUGINS_DIR).join("happyview-lua");
        assert_eq!(
            std::fs::read_to_string(placed.join("marker")).unwrap(),
            "new"
        );
        assert!(!old.join("marker").exists());
        assert!(old.join("happyview-lua.wasm").is_file());
    }

    #[test]
    fn pruning_a_link_leaves_the_cache_alone() {
        let cache = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let lua = cached(cache.path(), "happyview-lua", "1.4.2");
        place_plugins(
            project.path(),
            &[Placement {
                id: "happyview-lua",
                source: &lua,
            }],
            PlaceMode::Link,
        )
        .unwrap();
        place_plugins(project.path(), &[], PlaceMode::Link).unwrap();
        assert!(
            !project
                .path()
                .join(PLUGINS_DIR)
                .join("happyview-lua")
                .exists()
        );
        assert!(lua.join("happyview-lua.wasm").is_file());
    }

    #[test]
    fn switching_to_copies_replaces_links_without_touching_the_cache() {
        let cache = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let lua = cached(cache.path(), "happyview-lua", "1.4.2");
        let plugins = [Placement {
            id: "happyview-lua",
            source: &lua,
        }];
        place_plugins(project.path(), &plugins, PlaceMode::Link).unwrap();
        place_plugins(project.path(), &plugins, PlaceMode::Copy).unwrap();
        let placed = project.path().join(PLUGINS_DIR).join("happyview-lua");
        assert!(!placed.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(lua.join("happyview-lua.wasm").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_foreign_symlink_is_removed_not_followed() {
        let outside = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "x").unwrap();
        let plugins = project.path().join(PLUGINS_DIR);
        std::fs::create_dir_all(&plugins).unwrap();
        std::os::unix::fs::symlink(outside.path(), plugins.join("stray")).unwrap();
        place_plugins(project.path(), &[], PlaceMode::Copy).unwrap();
        assert!(plugins.symlink_metadata().is_ok());
        assert!(plugins.join("stray").symlink_metadata().is_err());
        assert!(outside.path().join("keep").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_created_happyview_directory_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let project = tempfile::tempdir().unwrap();
        place_plugins(project.path(), &[], PlaceMode::Copy).unwrap();
        let mode = std::fs::metadata(project.path().join(".happyview"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_at_either_level_is_refused_and_nothing_behind_it_is_touched() {
        for (link_at, setup_inner) in [(".happyview", false), (PLUGINS_DIR, true)] {
            let outside = tempfile::tempdir().unwrap();
            let project = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("keep"), "x").unwrap();
            if setup_inner {
                std::fs::create_dir(project.path().join(".happyview")).unwrap();
            }
            std::os::unix::fs::symlink(outside.path(), project.path().join(link_at)).unwrap();
            let err = place_plugins(project.path(), &[], PlaceMode::Copy).unwrap_err();
            assert!(err.to_string().contains("is a symlink"), "{link_at}: {err}");
            assert!(err.to_string().contains(link_at), "{link_at}: {err}");
            assert!(outside.path().join("keep").is_file(), "{link_at}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_refused() {
        let project = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/nonexistent/target", project.path().join(".happyview"))
            .unwrap();
        let err = place_plugins(project.path(), &[], PlaceMode::Copy).unwrap_err();
        assert!(err.to_string().contains("is a symlink"), "{err}");
    }

    #[test]
    fn a_file_where_a_directory_belongs_is_refused() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join(".happyview"), "x").unwrap();
        let err = place_plugins(project.path(), &[], PlaceMode::Copy).unwrap_err();
        assert!(err.to_string().contains("is not a directory"), "{err}");
    }

    #[test]
    fn an_id_that_could_escape_the_plugins_directory_is_refused() {
        let cache = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let src = cached(cache.path(), "x", "1");
        for id in ["", ".", "..", "../evil", "a/b", "a\\b"] {
            let err = place_plugins(
                project.path(),
                &[Placement { id, source: &src }],
                PlaceMode::Copy,
            )
            .unwrap_err();
            assert!(err.to_string().contains("cannot name"), "{id:?}: {err}");
        }
        assert!(!project.path().join(".happyview").exists());
    }
}
