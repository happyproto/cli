//! The parts of `happyview.toml` that `hpy` reads and writes: the HappyView
//! version and the plugins. HappyView reads the whole file; everything else in
//! it passes through `hpy` untouched.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use hpy_plugin::Problem;
use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "happyview.toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Interpreter,
    Library,
}

impl PluginKind {
    /// The `happyview.toml` table that lists this kind.
    pub fn table(self) -> &'static str {
        match self {
            PluginKind::Interpreter => "interpreters",
            PluginKind::Library => "libraries",
        }
    }

    /// The registry's `pluginType` for this kind.
    pub fn plugin_type(self) -> &'static str {
        match self {
            PluginKind::Interpreter => "interpreter",
            PluginKind::Library => "library",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ProjectToml {
    #[serde(default)]
    pub happyview: HappyviewTable,
    #[serde(default)]
    pub interpreters: BTreeMap<String, String>,
    #[serde(default)]
    pub libraries: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct HappyviewTable {
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub kind: PluginKind,
    pub key: String,
    pub req: String,
}

impl ProjectToml {
    pub fn parse(text: &str) -> Result<ProjectToml, Problem> {
        toml::from_str(text).map_err(|e| Problem::new(CONFIG_FILE, e.to_string()))
    }

    pub fn load(root: &Path) -> Result<ProjectToml, Problem> {
        let text = std::fs::read_to_string(root.join(CONFIG_FILE))
            .map_err(|e| Problem::new(CONFIG_FILE, format!("cannot be read: {e}")))?;
        ProjectToml::parse(&text)
    }

    pub fn happyview_version(&self) -> Result<&str, Problem> {
        self.happyview.version.as_deref().ok_or_else(|| {
            Problem::new(
                "happyview.version",
                "is required, e.g. `[happyview]` then `version = \"3.0.0\"`",
            )
        })
    }

    /// Interpreters first, then libraries, each in key order.
    pub fn requirements(&self) -> Vec<Requirement> {
        let tables = [
            (PluginKind::Interpreter, &self.interpreters),
            (PluginKind::Library, &self.libraries),
        ];
        tables
            .into_iter()
            .flat_map(|(kind, table)| {
                table.iter().map(move |(key, req)| Requirement {
                    kind,
                    key: key.clone(),
                    req: req.clone(),
                })
            })
            .collect()
    }
}

/// The nearest directory at or above `start` holding `happyview.toml`, so a
/// command run from inside `src/` still finds its project.
pub fn find_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| dir.join(CONFIG_FILE).is_file())
        .map(Path::to_path_buf)
}

/// Replaces `path` with `text` through a temporary file and a rename, so an
/// interrupted write cannot leave a truncated file, and leaves it alone when
/// it already holds `text`, so a watcher sees no change that is not one.
/// Returns whether it wrote.
pub fn write_if_changed(path: &Path, text: &str) -> std::io::Result<bool> {
    if std::fs::read(path).is_ok_and(|old| old == text.as_bytes()) {
        return Ok(false);
    }
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other(format!("{} names no file", path.display())))?;
    let tmp = path.with_file_name(format!(
        ".{}.{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(true)
}

/// `text` with `key = "version"` in the kind's table and nothing else changed:
/// comments, ordering and a replaced value's trailing comment all survive.
pub fn set_plugin(
    text: &str,
    kind: PluginKind,
    key: &str,
    version: &str,
) -> Result<String, Problem> {
    check_entry(kind, key, version)?;
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e: toml_edit::TomlError| Problem::new(CONFIG_FILE, e.to_string()))?;
    let item = doc
        .entry(kind.table())
        .or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
    let Some(table) = item.as_table_like_mut() else {
        return Err(Problem::new(kind.table(), "must be a table"));
    };
    match table.get_mut(key).and_then(toml_edit::Item::as_value_mut) {
        Some(value) => {
            let decor = value.decor().clone();
            *value = version.into();
            *value.decor_mut() = decor;
        }
        None => {
            table.insert(key, toml_edit::value(version));
        }
    }
    Ok(doc.to_string())
}

/// HappyView refuses a `happyview.toml` at boot whose `[interpreters]` key is
/// not a language id or whose value is blank, so the rule is mirrored here and
/// no writer can produce a file HappyView rejects. Its source
/// (`config/project.rs`, `IdentifierRule` and `NonEmptyRule`, over
/// `plugin::loader::is_valid_language_id`): an interpreter key is lowercase
/// ASCII letters, digits, `-` or `_` starting with a letter; a library key and
/// every version must be non-empty after trimming.
fn check_entry(kind: PluginKind, key: &str, version: &str) -> Result<(), Problem> {
    let path = format!("{}.{key}", kind.table());
    if kind == PluginKind::Interpreter {
        let mut chars = key.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !valid {
            return Err(Problem::new(
                path,
                format!(
                    "'{key}' must be lowercase letters, digits, '-' or '_', starting with a letter"
                ),
            ));
        }
    } else if key.trim().is_empty() {
        return Err(Problem::new(path, "key must not be empty"));
    }
    if version.trim().is_empty() {
        return Err(Problem::new(path, "version must not be empty"));
    }
    Ok(())
}

/// Whether `version` satisfies `req` in Cargo's dialect, which is the one
/// HappyView's dependency graph and the registry both use. A prerelease
/// matches only a range that itself names a prerelease of the same version,
/// `*` included, so asking for "any" version never lands on an alpha.
pub fn version_matches(req: &str, version: &str) -> bool {
    let Ok(version) = semver::Version::parse(version) else {
        return false;
    };
    semver::VersionReq::parse(req).is_ok_and(|r| r.matches(&version))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = r#"# The registry's own instance.
[happyview]
version = "3.0.0" # pinned for the workshop

[instance]
app_name = "HappyProto Registry"

[interpreters]
lua = "1.4.0" # the language most handlers use
typescript = "0.2.0"

[libraries]
"happyview.record" = "2.1.0"
"#;

    #[test]
    fn reads_the_slice_hpy_owns_and_ignores_the_rest() {
        let cfg = ProjectToml::parse(PROJECT).unwrap();
        assert_eq!(cfg.happyview_version().unwrap(), "3.0.0");
        let reqs: Vec<_> = cfg
            .requirements()
            .into_iter()
            .map(|r| (r.kind, r.key, r.req))
            .collect();
        assert_eq!(
            reqs,
            [
                (PluginKind::Interpreter, "lua".into(), "1.4.0".into()),
                (PluginKind::Interpreter, "typescript".into(), "0.2.0".into()),
                (
                    PluginKind::Library,
                    "happyview.record".into(),
                    "2.1.0".into()
                ),
            ]
        );
    }

    /// A file using every table HappyView accepts, including ones `hpy` has no
    /// type for, must load here and survive an edit.
    #[test]
    fn a_full_happyview_file_loads_and_hpys_own_edits_stay_valid() {
        const FULL: &str = r#"
[happyview]
version = "3.0.0"

[instance]
app_name = "Games"
superadmin = "did:plc:abc123"

[dev]
port = 3000
backfill = true

[interpreters]
lua = "1.4.0"

[libraries]
"happyview.record" = "2.1.0"

[network_lexicons]
include = ["app.bsky.feed.post"]

[labels]
subscribe = ["did:plc:labeler"]

[jetstream]
protocol = "v2"
compression = true

[lexicons."com.example.getThing"]
backfill = true
token_cost = 2

[scripts."xrpc.query:com.example.getThing"]
description = "reads a thing"

[modules.shared]
language = "lua"
path = "modules/shared"
"#;
        let cfg = ProjectToml::parse(FULL).unwrap();
        assert_eq!(cfg.happyview_version().unwrap(), "3.0.0");
        assert_eq!(cfg.requirements().len(), 2);

        // The edit must leave every table it did not touch intact.
        let edited = set_plugin(FULL, PluginKind::Library, "happyview.http", "1.0.3").unwrap();
        assert!(edited.contains("[modules.shared]"), "{edited}");
        let again = ProjectToml::parse(&edited).unwrap();
        assert_eq!(again.libraries["happyview.http"], "1.0.3");
        assert_eq!(again.interpreters["lua"], "1.4.0");
    }

    #[test]
    fn a_missing_version_says_how_to_pin_one() {
        let err = ProjectToml::parse("[interpreters]\nlua = \"1\"\n")
            .unwrap()
            .happyview_version()
            .unwrap_err();
        assert_eq!(err.path, "happyview.version");
        assert!(err.message.contains("[happyview]"), "{err}");
    }

    #[test]
    fn set_plugin_keeps_comments_order_and_trailing_comments() {
        let out = set_plugin(PROJECT, PluginKind::Interpreter, "lua", "1.5.0").unwrap();
        assert!(
            out.contains("lua = \"1.5.0\" # the language most handlers use"),
            "{out}"
        );
        assert!(out.starts_with("# The registry's own instance."), "{out}");
        assert!(
            out.contains("version = \"3.0.0\" # pinned for the workshop"),
            "{out}"
        );
        let lua = out.find("lua =").unwrap();
        let ts = out.find("typescript =").unwrap();
        assert!(lua < ts, "{out}");
    }

    #[test]
    fn set_plugin_quotes_dotted_keys_and_creates_the_table() {
        let out = set_plugin(
            "[happyview]\nversion = \"3.0.0\"\n",
            PluginKind::Library,
            "happyview.http",
            "1.0.3",
        )
        .unwrap();
        assert!(
            out.contains("[libraries]\n\"happyview.http\" = \"1.0.3\""),
            "{out}"
        );
        let cfg = ProjectToml::parse(&out).unwrap();
        assert_eq!(cfg.libraries["happyview.http"], "1.0.3");
    }

    #[test]
    fn set_plugin_refuses_a_table_that_is_not_one() {
        let err =
            set_plugin("interpreters = 3\n", PluginKind::Interpreter, "lua", "1").unwrap_err();
        assert_eq!(err.path, "interpreters");
    }

    #[test]
    fn set_plugin_refuses_what_happyview_would_refuse() {
        for key in ["Lua", "1lua", "", "lua.x", "lu a"] {
            let err = set_plugin("", PluginKind::Interpreter, key, "1.0.0").unwrap_err();
            assert_eq!(err.path, format!("interpreters.{key}"));
            assert!(err.message.contains("lowercase"), "{err}");
        }
        assert!(set_plugin("", PluginKind::Interpreter, "type-script_2", "1").is_ok());
        assert!(set_plugin("", PluginKind::Library, " ", "1").is_err());
        assert!(set_plugin("", PluginKind::Library, "Happyview.Http", "1").is_ok());
        assert!(set_plugin("", PluginKind::Library, "happyview.http", " ").is_err());
    }

    #[test]
    fn find_root_walks_up() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), "").unwrap();
        let deep = dir.path().join("src/lexicons/com/example");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(find_root(&deep).unwrap(), dir.path());
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(find_root(elsewhere.path()).is_none());
    }

    #[test]
    fn version_matching_is_cargo_flavoured() {
        assert!(version_matches("1.4.0", "1.9.2"));
        assert!(!version_matches("1.4.0", "2.0.0"));
        assert!(version_matches("=1.4.0", "1.4.0"));
        assert!(version_matches("*", "1.2.0"));
        assert!(!version_matches("*", "0.1.0-alpha.3"));
        assert!(!version_matches(">=3.0.0", "3.0.0-alpha.10"));
        assert!(version_matches("^1.3.0-alpha", "1.3.0-alpha.1"));
        assert!(version_matches("0.1.0-alpha.3", "0.1.0-alpha.3"));
        assert!(!version_matches("not a range", "1.0.0"));
        assert!(!version_matches("1", "not a version"));
    }

    #[test]
    fn write_if_changed_replaces_and_skips_identical_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        assert!(write_if_changed(&path, "a = 1\n").unwrap());
        assert!(!write_if_changed(&path, "a = 1\n").unwrap());
        assert!(write_if_changed(&path, "a = 2\n").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a = 2\n");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [CONFIG_FILE], "no temporary file is left behind");
    }
}
