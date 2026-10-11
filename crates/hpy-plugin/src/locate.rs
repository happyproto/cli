//! Finding the `.wasm` to publish: `--wasm`, then `[build] wasm`, then the
//! manifest's `wasm_file`, then Cargo's target directory — which, in a
//! workspace, is shared and found through `cargo metadata`.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::manifest::Manifest;

pub fn locate_wasm(
    dir: &Path,
    explicit: Option<&Path>,
    configured: Option<&str>,
    manifest: &Manifest,
) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        return existing(p.to_path_buf(), "--wasm");
    }
    if let Some(p) = configured {
        return existing(dir.join(p), "hpy.toml [build] wasm");
    }
    if let Some(p) = &manifest.wasm_file {
        let path = dir.join(p);
        if path.is_file() {
            return Ok(path);
        }
    }
    if dir.join("Cargo.toml").is_file()
        && let Some((target, name)) = cargo_target(dir)
    {
        let mut found = cargo_candidates(&target, &name);
        match found.len() {
            0 => {}
            1 => return Ok(found.remove(0)),
            _ => {
                let list: Vec<String> =
                    found.iter().map(|p| format!("  {}", p.display())).collect();
                return Err(format!(
                    "found more than one built module; pass --wasm or set [build] wasm in hpy.toml:\n{}",
                    list.join("\n")
                ));
            }
        }
    }
    Err(format!(
        "could not find the plugin's .wasm; build it, then pass --wasm <path> or set [build] wasm in hpy.toml{}",
        manifest
            .wasm_file
            .as_ref()
            .map(|f| format!(" (manifest wasm_file `{f}` does not exist)"))
            .unwrap_or_default()
    ))
}

fn existing(path: PathBuf, source: &str) -> Result<PathBuf, String> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "{source} points at {}, which does not exist",
            path.display()
        ))
    }
}

/// `<target>/wasm32-*/release/<crate_name>.wasm`, in a stable order.
pub fn cargo_candidates(target_dir: &Path, crate_name: &str) -> Vec<PathBuf> {
    let file = format!("{}.wasm", crate_name.replace('-', "_"));
    let Ok(entries) = std::fs::read_dir(target_dir) else {
        return vec![];
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("wasm32-"))
        .map(|e| e.path().join("release").join(&file))
        .filter(|p| p.is_file())
        .collect();
    out.sort();
    out
}

/// Whether two paths name the same file. Both sides are canonicalized: cargo
/// reports paths in its own form (on Windows, without the verbatim `\\?\`
/// prefix `canonicalize` adds), so comparing a canonical path with cargo's
/// raw one would miss.
pub(crate) fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The target directory and package name for the Cargo package in `dir`.
fn cargo_target(dir: &Path) -> Option<(PathBuf, String)> {
    let manifest_path = dir.join("Cargo.toml").canonicalize().ok()?;
    let output = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--offline",
            "--manifest-path",
        ])
        .arg(&manifest_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let meta: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let target = PathBuf::from(meta["target_directory"].as_str()?);
    let name = meta["packages"].as_array()?.iter().find(|p| {
        p["manifest_path"]
            .as_str()
            .is_some_and(|m| same_file(Path::new(m), &manifest_path))
    })?["name"]
        .as_str()?
        .to_string();
    Some((target, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"\0asm\x01\0\0\0").unwrap();
    }

    #[test]
    fn explicit_and_configured_win() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("a.wasm"));
        touch(&dir.path().join("b.wasm"));
        let m = Manifest {
            id: "x".into(),
            wasm_file: Some("b.wasm".into()),
            ..Default::default()
        };
        assert_eq!(
            locate_wasm(dir.path(), Some(&dir.path().join("a.wasm")), None, &m).unwrap(),
            dir.path().join("a.wasm")
        );
        assert_eq!(
            locate_wasm(dir.path(), None, Some("a.wasm"), &m).unwrap(),
            dir.path().join("a.wasm")
        );
        assert_eq!(
            locate_wasm(dir.path(), None, None, &m).unwrap(),
            dir.path().join("b.wasm")
        );
        assert!(
            locate_wasm(dir.path(), None, Some("missing.wasm"), &m)
                .unwrap_err()
                .contains("missing.wasm")
        );
    }

    #[test]
    fn cargo_candidates_finds_each_target() {
        let target = tempfile::tempdir().unwrap();
        touch(
            &target
                .path()
                .join("wasm32-unknown-unknown/release/my_plugin.wasm"),
        );
        touch(&target.path().join("wasm32-wasip1/release/my_plugin.wasm"));
        touch(&target.path().join("wasm32-wasip1/debug/my_plugin.wasm"));
        let found = cargo_candidates(target.path(), "my-plugin");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    #[test]
    fn ambiguous_cargo_build_lists_candidates() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"my-plugin\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[lib]\ncrate-type = [\"cdylib\"]\n",
        )
        .unwrap();
        touch(&dir.path().join("src/lib.rs"));
        touch(
            &dir.path()
                .join("target/wasm32-unknown-unknown/release/my_plugin.wasm"),
        );
        touch(
            &dir.path()
                .join("target/wasm32-wasip1/release/my_plugin.wasm"),
        );
        let m = Manifest {
            id: "my-plugin".into(),
            ..Default::default()
        };
        let err = locate_wasm(dir.path(), None, None, &m).unwrap_err();
        assert!(
            err.contains("wasm32-unknown-unknown")
                && err.contains("wasm32-wasip1")
                && err.contains("--wasm"),
            "{err}"
        );
    }

    #[test]
    fn nothing_found_says_what_was_tried() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manifest {
            id: "x".into(),
            ..Default::default()
        };
        let err = locate_wasm(dir.path(), None, None, &m).unwrap_err();
        assert!(err.contains("--wasm"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn same_file_sees_through_symlinks() {
        let real = tempfile::tempdir().unwrap();
        touch(&real.path().join("Cargo.toml"));
        let links = tempfile::tempdir().unwrap();
        let link = links.path().join("link");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();
        assert!(same_file(
            &link.join("Cargo.toml"),
            &real.path().join("Cargo.toml")
        ));
        assert!(!same_file(
            &link.join("Cargo.toml"),
            &real.path().join("other.toml")
        ));
    }
}
