//! The project as `hpy happyview deploy` sends it: `happyview.toml`, every
//! file under `src/`, and each `[modules]` build, as a gzipped tar that is
//! byte-for-byte the same for the same files, so the instance can tell an
//! unchanged project from a changed one.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::failure::Failure;
use crate::project::modules::BUILD_DIR;

pub struct Bundle {
    /// The gzipped tar.
    pub bytes: Vec<u8>,
    /// Its sha256, lowercase hex.
    pub sha256: String,
    /// Every path in it, in archive order.
    pub files: Vec<String>,
}

impl std::fmt::Debug for Bundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bundle")
            .field("sha256", &self.sha256)
            .field("files", &self.files)
            .finish_non_exhaustive()
    }
}

/// Every regular file under `dir`, as `/`-separated paths relative to
/// `root`. A symlink is refused: following it could send a file from outside
/// the project, and HappyView refuses one in a bundle anyway.
fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), Failure> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(Failure::runtime(format!("reading {}: {e}", dir.display()))),
    };
    for entry in entries {
        let path = entry.map_err(Failure::runtime)?.path();
        let rel = relative(root, &path);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| Failure::runtime(format!("reading {rel}: {e}")))?;
        if meta.file_type().is_symlink() {
            return Err(Failure::usage(format!(
                "{rel} is a symlink; a deploy sends only regular files, so copy the file there instead"
            )));
        }
        if meta.is_dir() {
            walk(root, &path, out)?;
        } else if meta.is_file() {
            out.push((rel, path));
        }
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Bundles the project at `root` with the builds of `modules`, which must
/// already be in `.happyview/build/`.
pub fn bundle(root: &Path, modules: &[String]) -> Result<Bundle, Failure> {
    let mut files = vec![("happyview.toml".to_string(), root.join("happyview.toml"))];
    walk(root, &root.join("src"), &mut files)?;
    for name in modules {
        let rel = format!("{BUILD_DIR}/{name}.wasm");
        let path = root.join(&rel);
        if !path.is_file() {
            return Err(Failure::usage(format!(
                "module `{name}` has no build at {rel}; run `hpy happyview build`"
            )));
        }
        files.push((rel, path));
    }
    files.sort();

    // Fixed modes, owners and times, and none of the machine's names, so
    // only the paths and contents decide the bytes.
    let gz = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    tar.mode(tar::HeaderMode::Deterministic);
    for (rel, path) in &files {
        let body =
            std::fs::read(path).map_err(|e| Failure::runtime(format!("reading {rel}: {e}")))?;
        let mut header = tar::Header::new_ustar();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_entry_type(tar::EntryType::Regular);
        tar.append_data(&mut header, rel, &body[..])
            .map_err(|e| Failure::runtime(format!("bundling {rel}: {e}")))?;
    }
    let bytes = tar
        .into_inner()
        .and_then(|gz| gz.finish())
        .map_err(|e| Failure::runtime(format!("bundling the project: {e}")))?;
    let sha256 = data_encoding::HEXLOWER.encode(&Sha256::digest(&bytes));
    Ok(Bundle {
        bytes,
        sha256,
        files: files.into_iter().map(|(rel, _)| rel).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::path::Path;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "happyview.toml", "[happyview]\nversion = \"3.0.0\"\n");
        write(root, "src/lexicons/com/example/hello.json", "{}");
        write(root, "src/lexicons/com/example/hello.lua", "return {}");
        write(root, "src/jobs/sweep.ts", "export default 1");
        write(root, ".env", "SECRET=1");
        write(root, ".happyview/plugins/lua.wasm", "plugin");
        write(root, ".happyview/types/lua/ctx.d.lua", "types");
        write(root, ".happyview/build/counter.wasm", "module");
        write(root, ".happyview/build/stale.wasm", "old module");
        write(root, "README.md", "readme");
        dir
    }

    /// Each entry's path and contents, in archive order.
    fn entries(b: &Bundle) -> Vec<(String, String)> {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(&b.bytes[..]));
        archive
            .entries()
            .unwrap()
            .map(|e| {
                let mut e = e.unwrap();
                let path = e.path().unwrap().to_string_lossy().into_owned();
                let mut body = String::new();
                e.read_to_string(&mut body).unwrap();
                (path, body)
            })
            .collect()
    }

    #[test]
    fn holds_the_config_the_sources_and_the_module_builds_only() {
        let dir = project();
        let b = bundle(dir.path(), &["counter".into()]).unwrap();
        let paths: Vec<String> = entries(&b).into_iter().map(|(p, _)| p).collect();
        assert_eq!(
            paths,
            [
                ".happyview/build/counter.wasm",
                "happyview.toml",
                "src/jobs/sweep.ts",
                "src/lexicons/com/example/hello.json",
                "src/lexicons/com/example/hello.lua",
            ]
        );
        assert_eq!(b.files, paths);
        assert_eq!(b.sha256.len(), 64);
    }

    #[test]
    fn the_same_files_make_the_same_bytes() {
        let dir = project();
        let first = bundle(dir.path(), &["counter".into()]).unwrap();
        // Rewriting a file with the same contents changes only its mtime.
        write(dir.path(), "src/jobs/sweep.ts", "export default 1");
        let again = bundle(dir.path(), &["counter".into()]).unwrap();
        assert_eq!(first.sha256, again.sha256);
        assert_eq!(first.bytes, again.bytes);
        write(dir.path(), "src/jobs/sweep.ts", "export default 2");
        assert_ne!(
            bundle(dir.path(), &["counter".into()]).unwrap().sha256,
            first.sha256
        );
    }

    #[test]
    fn a_module_that_was_not_built_is_named() {
        let dir = project();
        let err = bundle(dir.path(), &["missing".into()]).unwrap_err();
        let text = err.report.to_string();
        assert!(text.contains("missing"), "{text}");
        assert!(text.contains("hpy happyview build"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_under_src_is_refused() {
        let dir = project();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("src/passwd.lua")).unwrap();
        let err = bundle(dir.path(), &[]).unwrap_err();
        let text = err.report.to_string();
        assert!(text.contains("src/passwd.lua"), "{text}");
        assert!(text.contains("symlink"), "{text}");
    }

    #[test]
    fn a_project_without_src_still_bundles_its_config() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "happyview.toml", "");
        let b = bundle(dir.path(), &[]).unwrap();
        assert_eq!(b.files, ["happyview.toml"]);
    }
}
