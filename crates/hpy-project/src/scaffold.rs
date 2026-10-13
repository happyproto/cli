//! A new project: `happyview.toml`, the ignore and example env files, and one
//! query lexicon with its handler in the first interpreter chosen.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use hpy_plugin::Problem;

pub const STARTER_NSID: &str = "com.example.hello";
const LEXICON_DIR: &str = "src/lexicons/com/example";

pub struct Scaffold {
    pub app_name: String,
    pub superadmin: String,
    pub happyview_version: String,
    pub interpreters: BTreeMap<String, String>,
    pub libraries: BTreeMap<String, String>,
    pub handler_language: Option<String>,
}

pub fn starter_handler(language: &str) -> Option<(&'static str, &'static str)> {
    match language {
        "lua" => Some(("hello.lua", include_str!("../templates/hello.lua"))),
        "javascript" => Some(("hello.js", include_str!("../templates/hello.js"))),
        "typescript" => Some(("hello.ts", include_str!("../templates/hello.ts"))),
        _ => None,
    }
}

fn happyview_toml(s: &Scaffold) -> String {
    use toml_edit::{DocumentMut, Table, value};
    let mut doc = DocumentMut::new();
    let mut happyview = Table::new();
    happyview.insert("version", value(&s.happyview_version));
    doc.insert("happyview", happyview.into());
    let mut instance = Table::new();
    instance.insert("app_name", value(&s.app_name));
    instance.insert("superadmin", value(&s.superadmin));
    doc.insert("instance", instance.into());
    for (name, entries) in [
        ("interpreters", &s.interpreters),
        ("libraries", &s.libraries),
    ] {
        let mut table = Table::new();
        for (k, v) in entries {
            table.insert(k, value(v));
        }
        doc.insert(name, table.into());
    }
    let mut dev = Table::new();
    dev.insert("backfill", value(false));
    doc.insert("dev", dev.into());
    format!(
        "# A HappyView project. `hpy happyview dev` runs it; happyview.lock pins\n\
         # the exact plugin versions, and `hpy happyview add` edits both files.\n\n{doc}"
    )
}

pub fn render(s: &Scaffold) -> Vec<(PathBuf, String)> {
    let mut files = vec![
        (PathBuf::from("happyview.toml"), happyview_toml(s)),
        (
            PathBuf::from(".gitignore"),
            include_str!("../templates/gitignore").to_string(),
        ),
        (
            PathBuf::from(".env.example"),
            include_str!("../templates/env.example").to_string(),
        ),
        (
            Path::new(LEXICON_DIR).join("hello.json"),
            include_str!("../templates/hello.json").to_string(),
        ),
    ];
    if let Some((name, body)) = s.handler_language.as_deref().and_then(starter_handler) {
        files.push((Path::new(LEXICON_DIR).join(name), body.to_string()));
    }
    files
}

/// Writes a project into a directory that is absent or empty, so `create`
/// never mixes its files into someone else's. Every file lands in a private
/// sibling directory that is renamed onto `dir` only once it is complete, so
/// a failure leaves nothing at `dir` and a retry starts clean.
pub fn write_new(dir: &Path, files: &[(PathBuf, String)]) -> Result<(), Problem> {
    let path = dir.display().to_string();
    let existing_empty = match std::fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(Problem::new(path, "already exists and is not empty"));
            }
            true
        }
        Err(_) => false,
    };
    let name = dir
        .file_name()
        .ok_or_else(|| Problem::new(&path, "names no directory to create"))?;
    let parent = match dir.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    std::fs::create_dir_all(&parent)
        .map_err(|e| Problem::new(&path, format!("creating {}: {e}", parent.display())))?;
    let partial = parent.join(format!(
        ".{}.partial-{}-{:016x}",
        name.to_string_lossy(),
        std::process::id(),
        random()
    ));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(&partial)
        .map_err(|e| Problem::new(&path, format!("creating {}: {e}", partial.display())))?;
    let result = fill(&partial, files).and_then(|()| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("opening up {}: {e}", partial.display()))?;
        }
        // Renaming onto an existing directory fails on Windows even when it
        // is empty.
        if existing_empty {
            std::fs::remove_dir(dir).map_err(|e| format!("replacing the empty directory: {e}"))?;
        }
        std::fs::rename(&partial, dir)
            .map_err(|e| format!("moving {} into place: {e}", partial.display()))
    });
    result.map_err(|why| {
        let _ = std::fs::remove_dir_all(&partial);
        Problem::new(path, why)
    })
}

fn fill(root: &Path, files: &[(PathBuf, String)]) -> Result<(), String> {
    for (rel, body) in files {
        let target = root.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("creating {}: {e}", rel.display()))?;
        }
        std::fs::write(&target, body).map_err(|e| format!("writing {}: {e}", rel.display()))?;
    }
    Ok(())
}

/// Enough randomness that two processes, or two runs in one, never pick the
/// same temporary name.
fn random() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProjectToml;

    fn scaffold(language: Option<&str>) -> Scaffold {
        Scaffold {
            app_name: "Jo's \"App\"".into(),
            superadmin: "did:plc:abc".into(),
            happyview_version: "3.0.0".into(),
            interpreters: [("lua".to_string(), "1.4.2".to_string())].into(),
            libraries: [("happyview.http".to_string(), "1.0.3".to_string())].into(),
            handler_language: language.map(str::to_string),
        }
    }

    fn file<'a>(files: &'a [(PathBuf, String)], path: &str) -> Option<&'a str> {
        files
            .iter()
            .find(|(p, _)| p == Path::new(path))
            .map(|(_, s)| s.as_str())
    }

    #[test]
    fn renders_a_toml_happyview_and_hpy_can_both_read() {
        let files = render(&scaffold(Some("lua")));
        let text = file(&files, "happyview.toml").unwrap();
        let cfg = ProjectToml::parse(text).unwrap();
        assert_eq!(cfg.happyview_version().unwrap(), "3.0.0");
        assert_eq!(cfg.libraries["happyview.http"], "1.0.3");
        let raw: toml::Value = toml::from_str(text).unwrap();
        assert_eq!(raw["instance"]["app_name"].as_str(), Some("Jo's \"App\""));
        assert_eq!(raw["instance"]["superadmin"].as_str(), Some("did:plc:abc"));
        assert_eq!(raw["dev"]["backfill"].as_bool(), Some(false));
    }

    #[test]
    fn the_handler_follows_the_first_interpreter() {
        for (lang, path) in [
            ("lua", "src/lexicons/com/example/hello.lua"),
            ("javascript", "src/lexicons/com/example/hello.js"),
            ("typescript", "src/lexicons/com/example/hello.ts"),
        ] {
            let files = render(&scaffold(Some(lang)));
            assert!(
                file(&files, path).unwrap().contains("com.example.hello"),
                "{lang}"
            );
            assert!(file(&files, "src/lexicons/com/example/hello.json").is_some());
        }
        let files = render(&scaffold(Some("python")));
        assert!(
            !files
                .iter()
                .any(|(p, _)| p.extension().is_some_and(|e| e == "py"))
        );
    }

    #[test]
    fn ignores_and_example_env_are_there() {
        let files = render(&scaffold(None));
        assert_eq!(file(&files, ".gitignore").unwrap(), ".env\n.happyview/\n");
        assert!(file(&files, ".env.example").unwrap().contains("ctx.env"));
    }

    #[test]
    fn the_starter_lexicon_names_its_own_path() {
        let files = render(&scaffold(Some("lua")));
        let lexicon: serde_json::Value =
            serde_json::from_str(file(&files, "src/lexicons/com/example/hello.json").unwrap())
                .unwrap();
        assert_eq!(lexicon["id"], STARTER_NSID);
        assert_eq!(STARTER_NSID.replace('.', "/"), "com/example/hello");
    }

    #[test]
    fn write_new_refuses_a_directory_with_anything_in_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "mine").unwrap();
        let err = write_new(dir.path(), &render(&scaffold(Some("lua")))).unwrap_err();
        assert!(err.message.contains("not empty"), "{err}");
        assert!(!dir.path().join("happyview.toml").exists());
        let fresh = dir.path().join("app");
        write_new(&fresh, &render(&scaffold(Some("lua")))).unwrap();
        assert!(fresh.join("src/lexicons/com/example/hello.lua").is_file());
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_failure_partway_leaves_nothing_behind() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("app");
        let mut files = render(&scaffold(Some("lua")));
        // `happyview.toml` is a file by now, so nothing can go under it.
        files.push((PathBuf::from("happyview.toml/oops"), String::new()));
        let err = write_new(&dir, &files).unwrap_err();
        assert!(err.message.contains("happyview.toml/oops"), "{err}");
        assert!(
            entries(parent.path()).is_empty(),
            "{:?}",
            entries(parent.path())
        );

        // The same with an empty directory waiting: it is the one thing left.
        std::fs::create_dir(&dir).unwrap();
        write_new(&dir, &files).unwrap_err();
        assert_eq!(entries(parent.path()), ["app"]);
        assert!(entries(&dir).is_empty());

        write_new(&dir, &render(&scaffold(Some("lua")))).unwrap();
        assert!(dir.join("happyview.toml").is_file());
    }

    #[test]
    fn an_empty_directory_is_filled_in_place() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("app");
        std::fs::create_dir(&dir).unwrap();
        write_new(&dir, &render(&scaffold(Some("lua")))).unwrap();
        assert!(dir.join("src/lexicons/com/example/hello.lua").is_file());
        assert_eq!(entries(parent.path()), ["app"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755);
        }
    }
}
