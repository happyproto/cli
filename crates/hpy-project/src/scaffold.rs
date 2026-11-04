//! A new project: `happyview.toml`, the ignore and example env files, and one
//! query lexicon with its handler in the first interpreter chosen.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use hpy_plugin::Problem;

use crate::config::{PluginEntry, entry_value};

pub const STARTER_NSID: &str = "com.example.hello";
const LEXICON_DIR: &str = "src/lexicons/com/example";

pub struct Scaffold {
    pub app_name: String,
    pub superadmin: String,
    pub happyview_version: String,
    pub interpreters: BTreeMap<String, PluginEntry>,
    pub libraries: BTreeMap<String, PluginEntry>,
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

const HEADER: &str = "# A HappyView project. `hpy happyview dev` runs it; happyview.lock pins\n\
     # the exact plugin versions, and `hpy happyview add` edits both files.\n\n";

/// `[happyview]`, `[instance]` and the plugin tables, which every project
/// `hpy` writes has.
fn base_doc(
    version: &str,
    app_name: Option<&str>,
    superadmin: Option<&str>,
    interpreters: &BTreeMap<String, PluginEntry>,
    libraries: &BTreeMap<String, PluginEntry>,
) -> toml_edit::DocumentMut {
    use toml_edit::{DocumentMut, Table, value};
    let mut doc = DocumentMut::new();
    let mut happyview = Table::new();
    happyview.insert("version", value(version));
    doc.insert("happyview", happyview.into());
    let mut instance = Table::new();
    if let Some(app_name) = app_name {
        instance.insert("app_name", value(app_name));
    }
    if let Some(superadmin) = superadmin {
        instance.insert("superadmin", value(superadmin));
    }
    doc.insert("instance", instance.into());
    for (name, entries) in [("interpreters", interpreters), ("libraries", libraries)] {
        let mut table = Table::new();
        for (k, entry) in entries {
            table.insert(k, toml_edit::Item::Value(entry_value(entry)));
        }
        doc.insert(name, table.into());
    }
    doc
}

fn dev_table(doc: &mut toml_edit::DocumentMut) {
    let mut dev = toml_edit::Table::new();
    dev.insert("backfill", toml_edit::value(false));
    doc.insert("dev", dev.into());
}

fn happyview_toml(s: &Scaffold) -> String {
    let mut doc = base_doc(
        &s.happyview_version,
        Some(&s.app_name),
        Some(&s.superadmin),
        &s.interpreters,
        &s.libraries,
    );
    dev_table(&mut doc);
    format!("{HEADER}{doc}")
}

/// `[lexicons."<nsid>"]`: only the settings that differ from a project
/// lexicon's defaults (no backfill, indexed, no token cost).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LexiconSettings {
    pub backfill: Option<bool>,
    pub token_cost: Option<i64>,
    pub indexed: Option<bool>,
}

impl LexiconSettings {
    pub fn is_empty(&self) -> bool {
        *self == LexiconSettings::default()
    }
}

/// `[scripts."<trigger>"]`: what the file cannot say about itself.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScriptSettings {
    pub description: Option<String>,
    pub outbound_xrpcs: Option<Vec<String>>,
}

/// `[modules.<name>]`: a compiled module's crate.
#[derive(Debug, Clone, PartialEq)]
pub struct ModuleSettings {
    pub language: String,
    pub path: String,
}

/// A whole `happyview.toml`, as `hpy happyview pull` writes one from an
/// instance: the scaffold's tables, and the ones an instance can fill in.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProjectFile {
    pub happyview_version: String,
    pub app_name: Option<String>,
    pub superadmin: Option<String>,
    pub interpreters: BTreeMap<String, PluginEntry>,
    pub libraries: BTreeMap<String, PluginEntry>,
    pub network_lexicons: Vec<String>,
    pub labels: Vec<String>,
    pub lexicons: BTreeMap<String, LexiconSettings>,
    pub scripts: BTreeMap<String, ScriptSettings>,
    pub modules: BTreeMap<String, ModuleSettings>,
}

fn string_array(items: &[String]) -> toml_edit::Value {
    let mut array = toml_edit::Array::new();
    for item in items {
        array.push(item.as_str());
    }
    toml_edit::Value::Array(array)
}

impl ProjectFile {
    pub fn render(&self) -> String {
        use toml_edit::{Table, value};
        let mut doc = base_doc(
            &self.happyview_version,
            self.app_name.as_deref(),
            self.superadmin.as_deref(),
            &self.interpreters,
            &self.libraries,
        );
        dev_table(&mut doc);
        if !self.network_lexicons.is_empty() {
            let mut t = Table::new();
            t.insert("include", value(string_array(&self.network_lexicons)));
            doc.insert("network_lexicons", t.into());
        }
        if !self.labels.is_empty() {
            let mut t = Table::new();
            t.insert("subscribe", value(string_array(&self.labels)));
            doc.insert("labels", t.into());
        }
        let mut keyed = |name: &str, rows: Vec<(String, Table)>| {
            if rows.is_empty() {
                return;
            }
            let mut outer = Table::new();
            // Only the per-key tables are written, never an empty `[name]`.
            outer.set_implicit(true);
            for (key, table) in rows {
                outer.insert(&key, table.into());
            }
            doc.insert(name, outer.into());
        };
        keyed(
            "lexicons",
            self.lexicons
                .iter()
                .filter(|(_, l)| !l.is_empty())
                .map(|(nsid, l)| {
                    let mut t = Table::new();
                    if let Some(b) = l.backfill {
                        t.insert("backfill", value(b));
                    }
                    if let Some(c) = l.token_cost {
                        t.insert("token_cost", value(c));
                    }
                    if let Some(i) = l.indexed {
                        t.insert("indexed", value(i));
                    }
                    (nsid.clone(), t)
                })
                .collect(),
        );
        keyed(
            "scripts",
            self.scripts
                .iter()
                .filter(|(_, s)| s.description.is_some() || s.outbound_xrpcs.is_some())
                .map(|(trigger, s)| {
                    let mut t = Table::new();
                    if let Some(d) = &s.description {
                        t.insert("description", value(d));
                    }
                    if let Some(o) = &s.outbound_xrpcs {
                        t.insert("outbound_xrpcs", value(string_array(o)));
                    }
                    (trigger.clone(), t)
                })
                .collect(),
        );
        keyed(
            "modules",
            self.modules
                .iter()
                .map(|(name, m)| {
                    let mut t = Table::new();
                    t.insert("language", value(&m.language));
                    t.insert("path", value(&m.path));
                    (name.clone(), t)
                })
                .collect(),
        );
        format!("{HEADER}{doc}")
    }
}

/// The `.gitignore` every project gets.
pub const GITIGNORE: &str = include_str!("../templates/gitignore");

pub fn render(s: &Scaffold) -> Vec<(PathBuf, String)> {
    let mut files = vec![
        (PathBuf::from("happyview.toml"), happyview_toml(s)),
        (PathBuf::from(".gitignore"), GITIGNORE.to_string()),
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
/// never mixes its files into someone else's, and a failure leaves `dir` as
/// it was so a retry starts clean.
///
/// An empty directory is filled where it is, so it keeps its owner, mode and
/// place (it may be the working directory or a mount point), and is emptied
/// again on failure. An absent one is filled as a sibling and renamed into
/// place once complete.
pub fn write_new(dir: &Path, files: &[(PathBuf, String)]) -> Result<(), Problem> {
    let path = dir.display().to_string();
    match std::fs::metadata(dir) {
        Ok(meta) if !meta.is_dir() => {
            Err(Problem::new(path, "already exists and is not a directory"))
        }
        Ok(_) => {
            let mut entries = std::fs::read_dir(dir)
                .map_err(|e| Problem::new(&path, format!("reading it: {e}")))?;
            if entries.next().is_some() {
                return Err(Problem::new(path, "already exists and is not empty"));
            }
            fill(dir, files).map_err(|why| {
                // It was empty on entry, so everything in it is ours.
                empty_out(dir);
                Problem::new(path, why)
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => write_absent(dir, files),
        Err(e) => Err(Problem::new(path, format!("reading it: {e}"))),
    }
}

fn write_absent(dir: &Path, files: &[(PathBuf, String)]) -> Result<(), Problem> {
    let path = dir.display().to_string();
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
    std::fs::create_dir(&partial)
        .map_err(|e| Problem::new(&path, format!("creating {}: {e}", partial.display())))?;
    let result = fill(&partial, files).and_then(|()| {
        std::fs::rename(&partial, dir)
            .map_err(|e| format!("moving {} into place: {e}", partial.display()))
    });
    result.map_err(|why| {
        let _ = std::fs::remove_dir_all(&partial);
        Problem::new(path, why)
    })
}

fn empty_out(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = if entry.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::remove_dir_all(entry.path())
        } else {
            std::fs::remove_file(entry.path())
        };
    }
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

    fn entry(name: &str, channel: &str) -> PluginEntry {
        PluginEntry {
            did: "did:plc:happyview".into(),
            name: name.into(),
            pin: crate::config::Pin::Channel(channel.into()),
        }
    }

    fn scaffold(language: Option<&str>) -> Scaffold {
        Scaffold {
            app_name: "Jo's \"App\"".into(),
            superadmin: "did:plc:abc".into(),
            happyview_version: "3.0.0".into(),
            interpreters: [("lua".to_string(), entry("happyview-lua", "latest"))].into(),
            libraries: [(
                "happyview.http".to_string(),
                entry("happyview-http", "beta"),
            )]
            .into(),
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
        assert_eq!(
            cfg.libraries["happyview.http"],
            entry("happyview-http", "beta")
        );
        assert_eq!(cfg.interpreters["lua"], entry("happyview-lua", "latest"));
        let raw: toml::Value = toml::from_str(text).unwrap();
        assert_eq!(raw["instance"]["app_name"].as_str(), Some("Jo's \"App\""));
        assert_eq!(raw["instance"]["superadmin"].as_str(), Some("did:plc:abc"));
        assert_eq!(raw["dev"]["backfill"].as_bool(), Some(false));
    }

    #[test]
    fn a_pulled_file_writes_only_the_tables_it_has() {
        let mut file = ProjectFile {
            happyview_version: "3.0.0".into(),
            superadmin: Some("did:plc:abc".into()),
            interpreters: [("lua".to_string(), entry("happyview-lua", "alpha"))].into(),
            ..ProjectFile::default()
        };
        let bare = file.render();
        let raw: toml::Value = toml::from_str(&bare).unwrap();
        assert!(raw["instance"].get("app_name").is_none(), "{bare}");
        for absent in [
            "lexicons",
            "scripts",
            "modules",
            "labels",
            "network_lexicons",
        ] {
            assert!(raw.get(absent).is_none(), "{absent}: {bare}");
        }
        file.app_name = Some("App".into());
        file.network_lexicons = vec!["com.other.post".into()];
        file.labels = vec!["did:plc:labeler".into()];
        file.lexicons.insert(
            "com.example.post".into(),
            LexiconSettings {
                backfill: Some(true),
                token_cost: Some(3),
                indexed: None,
            },
        );
        file.lexicons
            .insert("com.example.quiet".into(), LexiconSettings::default());
        file.scripts.insert(
            "xrpc.query:com.example.hello".into(),
            ScriptSettings {
                description: Some("Says \"hi\"".into()),
                outbound_xrpcs: Some(vec!["com.other.get".into()]),
            },
        );
        file.modules.insert(
            "scoring".into(),
            ModuleSettings {
                language: "rust".into(),
                path: "modules/scoring".into(),
            },
        );
        let text = file.render();
        let cfg = ProjectToml::parse(&text).unwrap();
        assert_eq!(cfg.interpreters["lua"], entry("happyview-lua", "alpha"));
        let raw: toml::Value = toml::from_str(&text).unwrap();
        assert_eq!(raw["instance"]["app_name"].as_str(), Some("App"));
        assert_eq!(
            raw["network_lexicons"]["include"][0].as_str(),
            Some("com.other.post")
        );
        assert_eq!(
            raw["labels"]["subscribe"][0].as_str(),
            Some("did:plc:labeler")
        );
        let post = &raw["lexicons"]["com.example.post"];
        assert_eq!(post["backfill"].as_bool(), Some(true));
        assert_eq!(post["token_cost"].as_integer(), Some(3));
        assert!(post.get("indexed").is_none());
        // Nothing to say, so not written at all.
        assert!(raw["lexicons"].get("com.example.quiet").is_none(), "{text}");
        assert!(text.contains("[lexicons.\"com.example.post\"]"), "{text}");
        assert!(!text.contains("[lexicons]\n"), "{text}");
        let script = &raw["scripts"]["xrpc.query:com.example.hello"];
        assert_eq!(script["description"].as_str(), Some("Says \"hi\""));
        assert_eq!(script["outbound_xrpcs"][0].as_str(), Some("com.other.get"));
        assert_eq!(raw["modules"]["scoring"]["language"].as_str(), Some("rust"));
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
        let env = file(&files, ".env.example").unwrap();
        assert!(env.contains("ctx.env"));
        // Every line is a comment, so copying it sets nothing by accident.
        for line in env.lines().filter(|l| !l.trim().is_empty()) {
            assert!(line.trim_start().starts_with('#'), "{line:?}");
        }
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
        let files = failing_files();
        let err = write_new(&dir, &files).unwrap_err();
        assert!(err.message.contains("happyview.toml/oops"), "{err}");
        assert!(
            entries(parent.path()).is_empty(),
            "{:?}",
            entries(parent.path())
        );
        write_new(&dir, &render(&scaffold(Some("lua")))).unwrap();
        assert!(dir.join("happyview.toml").is_file());
    }

    /// A project whose last file cannot be written: `happyview.toml` is a
    /// file by then, so nothing can go under it.
    fn failing_files() -> Vec<(PathBuf, String)> {
        let mut files = render(&scaffold(Some("lua")));
        files.push((PathBuf::from("happyview.toml/oops"), String::new()));
        files
    }

    #[test]
    fn a_failure_in_an_empty_directory_empties_it_again_in_place() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("app");
        std::fs::create_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
        }
        let inode = identity(&dir);
        let err = write_new(&dir, &failing_files()).unwrap_err();
        assert!(err.message.contains("happyview.toml/oops"), "{err}");
        assert_eq!(entries(parent.path()), ["app"]);
        assert!(entries(&dir).is_empty(), "{:?}", entries(&dir));
        assert_eq!(identity(&dir), inode, "the directory was replaced");

        write_new(&dir, &render(&scaffold(Some("lua")))).unwrap();
        assert!(dir.join("happyview.toml").is_file());
        assert_eq!(identity(&dir), inode, "the directory was replaced");
    }

    /// What tells one directory from another put at the same path.
    fn identity(dir: &Path) -> (u64, u32) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let meta = std::fs::metadata(dir).unwrap();
            (meta.ino(), meta.permissions().mode() & 0o777)
        }
        #[cfg(not(unix))]
        {
            let _ = dir;
            (0, 0)
        }
    }

    #[test]
    fn an_empty_directory_is_filled_in_place() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("app");
        std::fs::create_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let before = identity(&dir);
        write_new(&dir, &render(&scaffold(Some("lua")))).unwrap();
        assert!(dir.join("src/lexicons/com/example/hello.lua").is_file());
        assert_eq!(entries(parent.path()), ["app"]);
        assert_eq!(identity(&dir), before, "the directory was replaced");
    }

    #[test]
    fn the_working_directory_can_be_filled_through_dot() {
        let dir = tempfile::tempdir().unwrap();
        write_new(&dir.path().join("."), &render(&scaffold(Some("lua")))).unwrap();
        assert!(dir.path().join("happyview.toml").is_file());
    }

    #[test]
    fn a_file_at_the_name_is_refused_and_kept() {
        let parent = tempfile::tempdir().unwrap();
        let file = parent.path().join("app");
        std::fs::write(&file, "mine").unwrap();
        let err = write_new(&file, &render(&scaffold(Some("lua")))).unwrap_err();
        assert!(err.message.contains("not a directory"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
        assert_eq!(entries(parent.path()), ["app"]);
    }
}
