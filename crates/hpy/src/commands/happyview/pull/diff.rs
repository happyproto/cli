//! `pull --diff`: what the instance holds against the project on disk, as a
//! unified diff, file by file.

use std::path::Path;

/// The files under `src/` a project keeps that an instance never holds:
/// tests stay local, so their absence from the pull is no difference.
fn local_only(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.')
        .is_some_and(|(base, _)| base.len() > ".test".len() && base.ends_with(".test"))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let rel: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            out.push(rel.join("/"));
        }
    }
}

/// The unified diff from `project` to `pulled`, over every file the pull
/// wrote and every file under the project's `src/` but its tests. Empty when
/// they agree.
pub fn diff_trees(project: &Path, pulled: &Path) -> (String, Vec<String>) {
    let mut paths = Vec::new();
    walk(pulled, pulled, &mut paths);
    let mut local = Vec::new();
    walk(project, &project.join("src"), &mut local);
    paths.extend(local.into_iter().filter(|p| !local_only(p)));
    paths.sort();
    paths.dedup();
    let mut out = String::new();
    let mut changed = Vec::new();
    for rel in paths {
        let old = std::fs::read_to_string(project.join(&rel)).ok();
        let new = std::fs::read_to_string(pulled.join(&rel)).ok();
        if old == new {
            continue;
        }
        let a = if old.is_some() {
            format!("a/{rel}")
        } else {
            "/dev/null".into()
        };
        let b = if new.is_some() {
            format!("b/{rel}")
        } else {
            "/dev/null".into()
        };
        let (old, new) = (old.unwrap_or_default(), new.unwrap_or_default());
        let text = similar::TextDiff::from_lines(&old, &new)
            .unified_diff()
            .context_radius(3)
            .header(&a, &b)
            .to_string();
        out.push_str(&text);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        changed.push(rel);
    }
    (out, changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_changed_added_and_removed_files_but_not_tests() {
        let project = tempfile::tempdir().unwrap();
        let pulled = tempfile::tempdir().unwrap();
        let write = |root: &Path, rel: &str, body: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        };
        write(project.path(), "happyview.toml", "a = 1\n");
        write(pulled.path(), "happyview.toml", "a = 2\n");
        write(project.path(), "src/lexicons/x/y/z.json", "{}\n");
        write(pulled.path(), "src/lexicons/x/y/z.json", "{}\n");
        write(pulled.path(), "src/jobs/new.lua", "new\n");
        write(project.path(), "src/jobs/gone.lua", "gone\n");
        write(project.path(), "src/jobs/gone.test.lua", "test\n");
        let (text, changed) = diff_trees(project.path(), pulled.path());
        assert_eq!(
            changed,
            ["happyview.toml", "src/jobs/gone.lua", "src/jobs/new.lua"]
        );
        assert!(
            text.contains("--- a/happyview.toml\n+++ b/happyview.toml\n"),
            "{text}"
        );
        assert!(text.contains("-a = 1\n+a = 2\n"), "{text}");
        assert!(
            text.contains("--- /dev/null\n+++ b/src/jobs/new.lua"),
            "{text}"
        );
        assert!(
            text.contains("--- a/src/jobs/gone.lua\n+++ /dev/null"),
            "{text}"
        );
        assert!(!text.contains("gone.test.lua"), "{text}");
        let (same, none) = diff_trees(pulled.path(), pulled.path());
        assert!(same.is_empty() && none.is_empty());
    }
}
