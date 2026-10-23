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

/// How an entry chooses its version: a channel the publisher moves, or one
/// exact version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pin {
    Channel(String),
    Version(String),
}

/// One `[interpreters]` or `[libraries]` entry: the project that provides
/// it, by its publisher's DID so that no handle change can swap it, and
/// which of its versions to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginEntry {
    pub did: String,
    pub name: String,
    pub pin: Pin,
}

impl PluginEntry {
    pub fn project_uri(&self) -> String {
        hpy_plugin::validate::project_uri(&self.did, &self.name)
    }

    /// `channel latest` or `version 1.2.0`, for messages.
    pub fn pin_label(&self) -> String {
        match &self.pin {
            Pin::Channel(c) => format!("channel {c}"),
            Pin::Version(v) => format!("version {v}"),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProjectToml {
    pub happyview: HappyviewTable,
    pub interpreters: BTreeMap<String, PluginEntry>,
    pub libraries: BTreeMap<String, PluginEntry>,
    pub dev: DevTable,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct HappyviewTable {
    pub version: Option<String>,
}

/// `[dev]`: HappyView reads all of it; `hpy` reads `backfill` to pass it on
/// to an instance it runs itself.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct DevTable {
    #[serde(default)]
    pub backfill: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub kind: PluginKind,
    pub key: String,
    pub entry: PluginEntry,
}

/// The file as written, before its plugin entries are checked one by one.
#[derive(Deserialize)]
struct RawToml {
    #[serde(default)]
    happyview: HappyviewTable,
    #[serde(default)]
    interpreters: BTreeMap<String, toml::Value>,
    #[serde(default)]
    libraries: BTreeMap<String, toml::Value>,
    #[serde(default)]
    dev: DevTable,
}

/// The table form, as `hpy happyview add` writes it.
const ENTRY_FORM: &str = "{ did = \"did:plc:…\", name = \"<project>\", channel = \"latest\" } (or version = \"1.2.0\" in place of channel)";

/// Reads one entry, naming it in every refusal so the author can find it.
fn parse_entry(kind: PluginKind, key: &str, value: &toml::Value) -> Result<PluginEntry, Problem> {
    let path = format!("{}.{key}", kind.table());
    let problem = |m: String| Problem::new(&path, m);
    let table = match value {
        toml::Value::Table(t) => t,
        // The version strings an older hpy wrote resolved by name through a
        // registry that no longer exists, so they cannot be read as before.
        toml::Value::String(_) => {
            return Err(problem(format!(
                "is a version string, which the software.release registry replaced; write it as {key} = {ENTRY_FORM}"
            )));
        }
        _ => return Err(problem(format!("must be a table: {key} = {ENTRY_FORM}"))),
    };
    let text = |field: &str| -> Result<Option<String>, Problem> {
        match table.get(field) {
            None => Ok(None),
            Some(toml::Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(problem(format!("`{field}` must be a string"))),
        }
    };
    if let Some(unknown) = table
        .keys()
        .find(|k| !["did", "name", "channel", "version"].contains(&k.as_str()))
    {
        return Err(problem(format!(
            "has `{unknown}`, which is not one of did, name, channel or version"
        )));
    }
    let did = text("did")?.ok_or_else(|| problem("needs `did`, the publisher's DID".into()))?;
    if !hpy_plugin::validate::is_did(&did) {
        return Err(problem(format!("`did`: `{did}` is not a DID")));
    }
    let name = text("name")?.ok_or_else(|| problem("needs `name`, the project's name".into()))?;
    if !hpy_plugin::validate::is_project_name(&name) {
        return Err(problem(format!(
            "`name`: `{name}` is not a project name (lowercase letters, digits and interior `-`)"
        )));
    }
    let pin = match (text("channel")?, text("version")?) {
        (Some(_), Some(_)) => {
            return Err(problem(
                "sets both `channel` and `version`; keep the one that should choose the version"
                    .into(),
            ));
        }
        (None, None) => {
            return Err(problem(
                "needs `channel` (latest, beta or alpha) or an exact `version`".into(),
            ));
        }
        (Some(channel), None) => {
            if !hpy_plugin::TRACKS.contains(&channel.as_str()) {
                return Err(problem(format!(
                    "`channel`: `{channel}` is not one of {}",
                    hpy_plugin::TRACKS.join(", ")
                )));
            }
            Pin::Channel(channel)
        }
        (None, Some(version)) => {
            if let Some(p) = hpy_plugin::validate::version_problem(&version) {
                return Err(problem(format!("`version`: {p}")));
            }
            Pin::Version(version)
        }
    };
    Ok(PluginEntry { did, name, pin })
}

impl ProjectToml {
    pub fn parse(text: &str) -> Result<ProjectToml, Problem> {
        let raw: RawToml =
            toml::from_str(text).map_err(|e| Problem::new(CONFIG_FILE, e.to_string()))?;
        let entries = |kind: PluginKind, table: &BTreeMap<String, toml::Value>| {
            table
                .iter()
                .map(|(key, value)| Ok((key.clone(), parse_entry(kind, key, value)?)))
                .collect::<Result<BTreeMap<_, _>, Problem>>()
        };
        Ok(ProjectToml {
            interpreters: entries(PluginKind::Interpreter, &raw.interpreters)?,
            libraries: entries(PluginKind::Library, &raw.libraries)?,
            happyview: raw.happyview,
            dev: raw.dev,
        })
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
                table.iter().map(move |(key, entry)| Requirement {
                    kind,
                    key: key.clone(),
                    entry: entry.clone(),
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
/// A symlinked `path` is written where it points, so the link survives, and
/// the file keeps its mode. Returns whether it wrote.
pub fn write_if_changed(path: &Path, text: &str) -> std::io::Result<bool> {
    use std::io::Write;
    if std::fs::read(path).is_ok_and(|old| old == text.as_bytes()) {
        return Ok(false);
    }
    let (target, permissions) = match std::fs::canonicalize(path) {
        Ok(real) => {
            let permissions = std::fs::metadata(&real)?.permissions();
            (real, Some(permissions))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(std::io::Error::other(format!(
                    "{} is a symlink to a file that does not exist",
                    path.display()
                )));
            }
            (path.to_path_buf(), None)
        }
        Err(e) => return Err(e),
    };
    let (tmp, mut file) = create_temp_beside(&target, permissions.as_ref())?;
    let written = file
        .write_all(text.as_bytes())
        .and_then(|()| match &permissions {
            // The umask may have narrowed the mode the file was opened with.
            Some(p) => file.set_permissions(p.clone()),
            None => Ok(()),
        })
        .and_then(|()| {
            drop(file);
            std::fs::rename(&tmp, &target)
        });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(true)
}

/// A new file beside `target`, under a name nobody else is using, opened so
/// that nothing already at that name (a link included) is followed.
fn create_temp_beside(
    target: &Path,
    permissions: Option<&std::fs::Permissions>,
) -> std::io::Result<(PathBuf, std::fs::File)> {
    let name = target
        .file_name()
        .ok_or_else(|| std::io::Error::other(format!("{} names no file", target.display())))?
        .to_string_lossy()
        .into_owned();
    let mut last = None;
    for attempt in 0..16u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let tmp = target.with_file_name(format!(
            ".{name}.{}-{attempt}-{nanos:x}",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(p) = permissions {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(p.mode() & 0o7777);
        }
        #[cfg(not(unix))]
        let _ = permissions;
        match options.open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no free temporary name")))
}

/// The inline table `happyview.toml` holds for `entry`.
pub fn entry_value(entry: &PluginEntry) -> toml_edit::Value {
    let mut table = toml_edit::InlineTable::new();
    table.insert("did", entry.did.as_str().into());
    table.insert("name", entry.name.as_str().into());
    match &entry.pin {
        Pin::Channel(c) => table.insert("channel", c.as_str().into()),
        Pin::Version(v) => table.insert("version", v.as_str().into()),
    };
    toml_edit::Value::InlineTable(table)
}

/// `text` with `key = { did, name, channel|version }` in the kind's table and
/// nothing else changed: comments, ordering and a replaced value's trailing
/// comment all survive.
pub fn set_plugin(
    text: &str,
    kind: PluginKind,
    key: &str,
    entry: &PluginEntry,
) -> Result<String, Problem> {
    check_entry(kind, key)?;
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e: toml_edit::TomlError| Problem::new(CONFIG_FILE, e.to_string()))?;
    let item = doc
        .entry(kind.table())
        .or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
    let Some(table) = item.as_table_like_mut() else {
        return Err(Problem::new(kind.table(), "must be a table"));
    };
    let mut value = entry_value(entry);
    match table.get_mut(key).and_then(toml_edit::Item::as_value_mut) {
        Some(old) => {
            *value.decor_mut() = old.decor().clone();
            *old = value;
        }
        None => {
            table.insert(key, toml_edit::Item::Value(value));
        }
    }
    Ok(doc.to_string())
}

/// HappyView refuses a `happyview.toml` at boot whose `[interpreters]` key is
/// not a language id or whose value is blank, so the rule is mirrored here and
/// no writer can produce a file HappyView rejects. Its source
/// (`config/project.rs`, `IdentifierRule` and `NonEmptyRule`, over
/// `plugin::loader::is_valid_language_id`): an interpreter key is lowercase
/// ASCII letters, digits, `-` or `_` starting with a letter; a library key
/// must be non-empty after trimming.
fn check_entry(kind: PluginKind, key: &str) -> Result<(), Problem> {
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

    #[test]
    fn dev_backfill_defaults_off() {
        assert!(!ProjectToml::parse("").unwrap().dev.backfill);
        assert!(
            ProjectToml::parse("[dev]\nbackfill = true\n")
                .unwrap()
                .dev
                .backfill
        );
    }

    const HV: &str = "did:plc:happyview";

    const PROJECT: &str = r#"# The registry's own instance.
[happyview]
version = "3.0.0" # pinned for the workshop

[instance]
app_name = "HappyProto Registry"

[interpreters]
lua = { did = "did:plc:happyview", name = "happyview-lua", channel = "latest" } # the language most handlers use
typescript = { did = "did:plc:happyview", name = "happyview-ts", version = "0.2.0" }

[libraries]
"happyview.record" = { did = "did:plc:happyview", name = "happyview-record", channel = "beta" }
"#;

    fn entry(name: &str, pin: Pin) -> PluginEntry {
        PluginEntry {
            did: HV.into(),
            name: name.into(),
            pin,
        }
    }

    #[test]
    fn reads_the_slice_hpy_owns_and_ignores_the_rest() {
        let cfg = ProjectToml::parse(PROJECT).unwrap();
        assert_eq!(cfg.happyview_version().unwrap(), "3.0.0");
        let reqs: Vec<_> = cfg
            .requirements()
            .into_iter()
            .map(|r| (r.kind, r.key, r.entry))
            .collect();
        assert_eq!(
            reqs,
            [
                (
                    PluginKind::Interpreter,
                    "lua".into(),
                    entry("happyview-lua", Pin::Channel("latest".into()))
                ),
                (
                    PluginKind::Interpreter,
                    "typescript".into(),
                    entry("happyview-ts", Pin::Version("0.2.0".into()))
                ),
                (
                    PluginKind::Library,
                    "happyview.record".into(),
                    entry("happyview-record", Pin::Channel("beta".into()))
                ),
            ]
        );
        assert_eq!(
            cfg.interpreters["lua"].project_uri(),
            "at://did:plc:happyview/software.release.project/happyview-lua"
        );
    }

    fn refusal(entry: &str) -> Problem {
        ProjectToml::parse(&format!("[interpreters]\nlua = {entry}\n")).unwrap_err()
    }

    #[test]
    fn a_bare_version_string_is_refused_naming_the_table_form() {
        let err = refusal("\"^1\"");
        assert_eq!(err.path, "interpreters.lua");
        assert!(err.message.contains("software.release"), "{err}");
        assert!(err.message.contains("did = "), "{err}");
        assert!(err.message.contains("channel = \"latest\""), "{err}");
    }

    #[test]
    fn an_entry_needs_exactly_one_of_channel_and_version() {
        let both = refusal(
            "{ did = \"did:plc:happyview\", name = \"happyview-lua\", channel = \"latest\", version = \"1.0.0\" }",
        );
        assert_eq!(both.path, "interpreters.lua");
        assert!(both.message.contains("both"), "{both}");
        let neither = refusal("{ did = \"did:plc:happyview\", name = \"happyview-lua\" }");
        assert_eq!(neither.path, "interpreters.lua");
        assert!(neither.message.contains("channel"), "{neither}");
        assert!(neither.message.contains("version"), "{neither}");
    }

    #[test]
    fn an_entry_is_checked_field_by_field() {
        for (entry, needle) in [
            ("{ name = \"x\", channel = \"latest\" }", "needs `did`"),
            (
                "{ did = \"alice.test\", name = \"x\", channel = \"latest\" }",
                "not a DID",
            ),
            (
                "{ did = \"did:plc:a\", channel = \"latest\" }",
                "needs `name`",
            ),
            (
                "{ did = \"did:plc:a\", name = \"X\", channel = \"latest\" }",
                "not a project name",
            ),
            (
                "{ did = \"did:plc:a\", name = \"x\", channel = \"stable\" }",
                "not one of",
            ),
            (
                "{ did = \"did:plc:a\", name = \"x\", version = \"^1\" }",
                "`version`",
            ),
            (
                "{ did = \"did:plc:a\", name = \"x\", channel = \"latest\", chanel = \"beta\" }",
                "chanel",
            ),
            ("3", "must be a table"),
        ] {
            let err = refusal(entry);
            assert_eq!(err.path, "interpreters.lua", "{entry}");
            assert!(err.message.contains(needle), "{entry}: {err}");
        }
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
lua = { did = "did:plc:happyview", name = "happyview-lua", channel = "latest" }

[libraries]
"happyview.record" = { did = "did:plc:happyview", name = "happyview-record", version = "2.1.0" }

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
        let http = entry("happyview-http", Pin::Version("1.0.3".into()));
        let edited = set_plugin(FULL, PluginKind::Library, "happyview.http", &http).unwrap();
        assert!(edited.contains("[modules.shared]"), "{edited}");
        let again = ProjectToml::parse(&edited).unwrap();
        assert_eq!(again.libraries["happyview.http"], http);
        assert_eq!(
            again.interpreters["lua"],
            entry("happyview-lua", Pin::Channel("latest".into()))
        );
    }

    #[test]
    fn a_missing_version_says_how_to_pin_one() {
        let err = ProjectToml::parse("[dev]\nbackfill = true\n")
            .unwrap()
            .happyview_version()
            .unwrap_err();
        assert_eq!(err.path, "happyview.version");
        assert!(err.message.contains("[happyview]"), "{err}");
    }

    #[test]
    fn set_plugin_keeps_comments_order_and_trailing_comments() {
        let pinned = entry("happyview-lua", Pin::Version("1.5.0".into()));
        let out = set_plugin(PROJECT, PluginKind::Interpreter, "lua", &pinned).unwrap();
        assert!(
            out.contains(
                "lua = { did = \"did:plc:happyview\", name = \"happyview-lua\", version = \"1.5.0\" } # the language most handlers use"
            ),
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
        assert_eq!(
            ProjectToml::parse(&out).unwrap().interpreters["lua"],
            pinned
        );
    }

    #[test]
    fn set_plugin_quotes_dotted_keys_and_creates_the_table() {
        let http = entry("happyview-http", Pin::Channel("latest".into()));
        let out = set_plugin(
            "[happyview]\nversion = \"3.0.0\"\n",
            PluginKind::Library,
            "happyview.http",
            &http,
        )
        .unwrap();
        assert!(
            out.contains(
                "[libraries]\n\"happyview.http\" = { did = \"did:plc:happyview\", name = \"happyview-http\", channel = \"latest\" }"
            ),
            "{out}"
        );
        let cfg = ProjectToml::parse(&out).unwrap();
        assert_eq!(cfg.libraries["happyview.http"], http);
    }

    #[test]
    fn set_plugin_refuses_a_table_that_is_not_one() {
        let lua = entry("happyview-lua", Pin::Channel("latest".into()));
        let err =
            set_plugin("interpreters = 3\n", PluginKind::Interpreter, "lua", &lua).unwrap_err();
        assert_eq!(err.path, "interpreters");
    }

    #[test]
    fn set_plugin_refuses_what_happyview_would_refuse() {
        let e = entry("x", Pin::Channel("latest".into()));
        for key in ["Lua", "1lua", "", "lua.x", "lu a"] {
            let err = set_plugin("", PluginKind::Interpreter, key, &e).unwrap_err();
            assert_eq!(err.path, format!("interpreters.{key}"));
            assert!(err.message.contains("lowercase"), "{err}");
        }
        assert!(set_plugin("", PluginKind::Interpreter, "type-script_2", &e).is_ok());
        assert!(set_plugin("", PluginKind::Library, " ", &e).is_err());
        assert!(set_plugin("", PluginKind::Library, "Happyview.Http", &e).is_ok());
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

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    #[test]
    fn write_if_changed_writes_through_a_link_and_keeps_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("dotfiles");
        std::fs::create_dir(&shared).unwrap();
        let real = shared.join("real.toml");
        std::fs::write(&real, "a = 1\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let path = project.join(CONFIG_FILE);
        std::os::unix::fs::symlink("../dotfiles/real.toml", &path).unwrap();

        assert!(write_if_changed(&path, "a = 2\n").unwrap());
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "a = 2\n");
        assert_eq!(
            std::fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(names(&shared), ["real.toml"]);
        assert_eq!(names(&project), [CONFIG_FILE]);

        std::fs::remove_file(&real).unwrap();
        let err = write_if_changed(&path, "a = 3\n").unwrap_err();
        assert!(err.to_string().contains("does not exist"), "{err}");
        assert!(names(&shared).is_empty());
    }

    #[test]
    fn write_if_changed_leaves_no_temporary_file_when_it_fails() {
        let dir = tempfile::tempdir().unwrap();
        // A directory at the name: the temporary file is written, and the
        // rename onto it fails.
        let path = dir.path().join(CONFIG_FILE);
        std::fs::create_dir(&path).unwrap();
        assert!(write_if_changed(&path, "a = 1\n").is_err());
        assert_eq!(names(dir.path()), [CONFIG_FILE]);
        assert!(path.is_dir());
    }
}
