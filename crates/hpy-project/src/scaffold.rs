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
/// never mixes its files into someone else's.
pub fn write_new(dir: &Path, files: &[(PathBuf, String)]) -> Result<(), Problem> {
    let path = dir.display().to_string();
    if let Ok(mut entries) = std::fs::read_dir(dir)
        && entries.next().is_some()
    {
        return Err(Problem::new(path, "already exists and is not empty"));
    }
    for (rel, body) in files {
        let target = dir.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Problem::new(&path, e.to_string()))?;
        }
        std::fs::write(&target, body).map_err(|e| Problem::new(&path, e.to_string()))?;
    }
    Ok(())
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
}
