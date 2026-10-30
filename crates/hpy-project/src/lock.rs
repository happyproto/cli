//! `happyview.lock`: the exact plugin versions a project runs, and the CIDs
//! that pin each one's records and bytes.

use std::path::Path;

use hpy_plugin::Problem;
use hpy_plugin::validate::{parse_project_uri, version_uri};
use serde::{Deserialize, Serialize};

use crate::config::{Pin, PluginKind, ProjectToml, write_if_changed};

pub const LOCK_FILE: &str = "happyview.lock";
pub const LOCK_VERSION: u32 = 2;
const HEADER: &str = "# Written by hpy from happyview.toml. Commit it; don't edit it by hand.\n\n";
/// Version 1 named packages and checksums from the registry before it moved
/// to `software.release`; none of that can be looked up any more.
const PREDATES_REGISTRY: &str =
    "happyview.lock predates the software.release registry; delete it and run hpy happyview check";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lockfile {
    pub version: u32,
    pub happyview: LockedHappyview,
    #[serde(rename = "plugin", default, skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<LockedPlugin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LockedHappyview {
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LockedPlugin {
    /// The project's name, which HappyView loads the plugin by.
    pub id: String,
    pub kind: PluginKind,
    #[serde(default)]
    pub keys: Vec<String>,
    /// The `software.release.project` URI, so a later resolution never
    /// looks the plugin up by name again.
    pub project: String,
    pub version: String,
    /// The channel `happyview.toml` followed when this was locked; absent
    /// for an exact version pin and for a plugin only others require. A
    /// changed pin is drift, while a channel moving on is not: `check` and
    /// `dev` stay reproducible until `hpy happyview add` re-resolves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    pub version_uri: String,
    /// The `software.release.manifest` record's CID: a published version
    /// whose manifest changes is no longer the one locked.
    pub manifest_cid: String,
    /// The module's blob CID, which its downloaded bytes must hash to.
    pub package_cid: String,
    /// The published `manifest.json`'s blob CID, likewise.
    pub manifest_blob_cid: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    /// The capabilities this exact version's manifest declares, recorded so a
    /// deploy accepts what was resolved and committed rather than whatever the
    /// registry serves when it runs. The manifest is pinned by `manifest_cid`,
    /// so this is the set a reviewer of the lock saw.
    ///
    /// `None` in a lock written before hpy recorded them. A deploy refuses one
    /// rather than guess: an empty list is a plugin that asks for nothing,
    /// which is exactly the claim that must not be made on its behalf.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

/// Enough of a CID's shape to catch a hand edit or a checksum from an older
/// lock: base32 multibase, lowercase.
fn looks_like_cid(s: &str) -> bool {
    s.len() > 8
        && s.starts_with('b')
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

impl Lockfile {
    pub fn parse(text: &str) -> Result<Lockfile, Problem> {
        // The version is read alone first: another format may have a shape
        // this one cannot deserialize, and the useful answer is what to do.
        #[derive(Deserialize)]
        struct Format {
            version: u32,
        }
        let format: Format =
            toml::from_str(text).map_err(|e| Problem::new(LOCK_FILE, e.to_string()))?;
        if format.version == 1 {
            return Err(Problem::new("", PREDATES_REGISTRY));
        }
        if format.version != LOCK_VERSION {
            return Err(Problem::new(
                LOCK_FILE,
                format!(
                    "is format {} and was written by a different hpy; upgrade hpy",
                    format.version
                ),
            ));
        }
        let lock: Lockfile =
            toml::from_str(text).map_err(|e| Problem::new(LOCK_FILE, e.to_string()))?;
        lock.validate()?;
        Ok(lock)
    }

    fn validate(&self) -> Result<(), Problem> {
        for (i, p) in self.plugins.iter().enumerate() {
            let at = |field: &str| format!("{LOCK_FILE}: plugin[{i}].{field}");
            if !hpy_plugin::validate::is_project_name(&p.id) {
                return Err(Problem::new(
                    at("id"),
                    format!("`{}` is not a project name", p.id),
                ));
            }
            match parse_project_uri(&p.project) {
                Some((_, name)) if name == p.id => {}
                _ => {
                    return Err(Problem::new(
                        at("project"),
                        format!(
                            "`{}` is not the software.release.project URI of `{}`",
                            p.project, p.id
                        ),
                    ));
                }
            }
            let (did, name) = parse_project_uri(&p.project).expect("checked above");
            if p.version_uri != version_uri(&did, &name, &p.version) {
                return Err(Problem::new(
                    at("version_uri"),
                    format!(
                        "`{}` is not the version URI of {}@{}",
                        p.version_uri, p.id, p.version
                    ),
                ));
            }
            if let Some(channel) = &p.channel {
                if !hpy_plugin::TRACKS.contains(&channel.as_str()) {
                    return Err(Problem::new(
                        at("channel"),
                        format!("`{channel}` is not a channel (plugin `{}`)", p.id),
                    ));
                }
                if p.keys.is_empty() {
                    return Err(Problem::new(
                        at("channel"),
                        format!(
                            "`{}` is only required by other plugins, so no channel chose it",
                            p.id
                        ),
                    ));
                }
            }
            for (field, cid) in [
                ("manifest_cid", &p.manifest_cid),
                ("package_cid", &p.package_cid),
                ("manifest_blob_cid", &p.manifest_blob_cid),
            ] {
                if !looks_like_cid(cid) {
                    return Err(Problem::new(
                        at(field),
                        format!("`{cid}` is not a CID (plugin `{}`)", p.id),
                    ));
                }
            }
            if self.plugins[..i].iter().any(|q| q.id == p.id) {
                return Err(Problem::new(
                    at("id"),
                    format!("`{}` appears more than once", p.id),
                ));
            }
        }
        for (i, p) in self.plugins.iter().enumerate() {
            if let Some(missing) = p
                .dependencies
                .iter()
                .find(|d| !self.plugins.iter().any(|q| &q.id == *d))
            {
                return Err(Problem::new(
                    format!("{LOCK_FILE}: plugin[{i}].dependencies"),
                    format!("`{}` needs `{missing}`, which is not in the lock", p.id),
                ));
            }
        }
        Ok(())
    }

    pub fn load(root: &Path) -> Result<Option<Lockfile>, Problem> {
        match std::fs::read_to_string(root.join(LOCK_FILE)) {
            Ok(text) => Lockfile::parse(&text).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Problem::new(LOCK_FILE, format!("cannot be read: {e}"))),
        }
    }

    pub fn render(&self) -> String {
        let mut sorted = self.clone();
        sorted.plugins.sort_by(|a, b| a.id.cmp(&b.id));
        for p in &mut sorted.plugins {
            p.keys.sort();
            p.dependencies.sort();
        }
        format!(
            "{HEADER}{}",
            toml::to_string(&sorted).expect("a lockfile serializes")
        )
    }

    /// Writes beside the toml through a rename, so an interrupted write never
    /// leaves a truncated lock for the next command to misread.
    pub fn write(&self, root: &Path) -> std::io::Result<()> {
        write_if_changed(&root.join(LOCK_FILE), &self.render()).map(|_| ())
    }

    pub fn find_key(&self, kind: PluginKind, key: &str) -> Option<&LockedPlugin> {
        self.plugins
            .iter()
            .find(|p| p.kind == kind && p.keys.iter().any(|k| k == key))
    }

    /// Why this lock no longer describes `cfg`, one sentence each; empty when
    /// it still does. A channel pin is satisfied by whatever it resolved to
    /// when locked: moving to the channel's new head is an explicit update.
    pub fn drift(&self, cfg: &ProjectToml) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(wanted) = cfg.happyview.version.as_deref()
            && wanted != self.happyview.version
        {
            out.push(format!(
                "HappyView is locked at {} but happyview.toml asks for {wanted}",
                self.happyview.version
            ));
        }
        let requirements = cfg.requirements();
        for r in &requirements {
            let what = format!("{} `{}`", r.kind.plugin_type(), r.key);
            let Some(p) = self.find_key(r.kind, &r.key) else {
                out.push(format!("{what} is not in the lock"));
                continue;
            };
            let wanted = r.entry.project_uri();
            let locked = match &p.channel {
                Some(c) => format!("channel {c}"),
                None => format!("version {}", p.version),
            };
            let asked = match &r.entry.pin {
                Pin::Channel(c) => format!("channel {c}"),
                Pin::Version(v) => format!("version {v}"),
            };
            if p.project != wanted {
                out.push(format!(
                    "{what} is locked to {}, but happyview.toml names {wanted}",
                    p.project
                ));
            } else if locked != asked {
                let how = if p.channel.is_some() { "from" } else { "at" };
                out.push(format!(
                    "{what} is locked {how} {locked}, but happyview.toml asks for {asked}"
                ));
            }
        }
        for p in &self.plugins {
            for key in &p.keys {
                if !requirements
                    .iter()
                    .any(|r| r.kind == p.kind && &r.key == key)
                {
                    out.push(format!(
                        "{} `{key}` is locked but no longer in happyview.toml",
                        p.kind.plugin_type()
                    ));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProjectToml;

    const DID: &str = "did:plc:abc";

    fn plugin(id: &str, kind: PluginKind, keys: &[&str], version: &str) -> LockedPlugin {
        LockedPlugin {
            id: id.into(),
            kind,
            keys: keys.iter().map(|k| k.to_string()).collect(),
            project: format!("at://{DID}/software.release.project/{id}"),
            version: version.into(),
            channel: (!keys.is_empty()).then(|| "latest".to_string()),
            version_uri: format!("at://{DID}/software.release.version/{id}.{version}"),
            manifest_cid: "bafyreimanifest".into(),
            package_cid: "bafkreipackage".into(),
            manifest_blob_cid: "bafkreimanifestblob".into(),
            dependencies: vec![],
            capabilities: Some(vec![]),
        }
    }

    fn lock() -> Lockfile {
        Lockfile {
            version: LOCK_VERSION,
            happyview: LockedHappyview {
                version: "3.0.0".into(),
            },
            plugins: vec![
                plugin("happyview-lua", PluginKind::Interpreter, &["lua"], "1.4.2"),
                plugin("happyview-http", PluginKind::Library, &[], "1.0.3"),
            ],
        }
    }

    #[test]
    fn renders_sorted_with_a_header_and_round_trips() {
        let text = lock().render();
        assert!(text.starts_with("# Written by hpy"), "{text}");
        assert!(text.find("happyview-http").unwrap() < text.find("happyview-lua").unwrap());
        assert!(text.contains("[[plugin]]"), "{text}");
        let back = Lockfile::parse(&text).unwrap();
        assert_eq!(back, {
            let mut l = lock();
            l.plugins.reverse();
            l
        });
        assert_eq!(
            back.find_key(PluginKind::Interpreter, "lua")
                .unwrap()
                .version,
            "1.4.2"
        );
        assert!(back.find_key(PluginKind::Library, "lua").is_none());
    }

    /// A lock written by an hpy that did not record capabilities parses, and
    /// says so by absence rather than by an empty set: a deploy has to tell
    /// "declares nothing" from "nobody wrote it down".
    #[test]
    fn a_lock_without_recorded_capabilities_parses_as_unrecorded() {
        let text: String = lock()
            .render()
            .lines()
            .filter(|l| !l.starts_with("capabilities"))
            .map(|l| format!("{l}\n"))
            .collect();
        assert!(!text.contains("capabilities"), "{text}");
        let back = Lockfile::parse(&text).unwrap();
        assert!(back.plugins.iter().all(|p| p.capabilities.is_none()));
    }

    #[test]
    fn recorded_capabilities_round_trip() {
        let mut l = lock();
        l.plugins[0].capabilities = Some(vec!["database:write".into(), "kv:read".into()]);
        let back = Lockfile::parse(&l.render()).unwrap();
        let p = back
            .plugins
            .iter()
            .find(|p| p.id == l.plugins[0].id)
            .unwrap();
        assert_eq!(
            p.capabilities.as_deref(),
            Some(&["database:write".to_string(), "kv:read".to_string()][..])
        );
    }

    #[test]
    fn a_lock_from_before_the_registry_moved_says_to_delete_it() {
        let old = "version = 1\n[happyview]\nversion = \"3.0.0\"\n[[plugin]]\nid = \"x\"\nkind = \"library\"\npackage = \"at://did:plc:a/at.happyproto.plugin.profile/x\"\nversion = \"1.0.0\"\nchecksum = \"bciq\"\n";
        let err = Lockfile::parse(old).unwrap_err();
        assert_eq!(
            err.to_string(),
            "happyview.lock predates the software.release registry; delete it and run hpy happyview check"
        );
    }

    #[test]
    fn a_newer_format_is_refused() {
        let err = Lockfile::parse("version = 3\n[happyview]\nversion = \"3.0.0\"\n").unwrap_err();
        assert!(err.message.contains("upgrade hpy"), "{err}");
    }

    #[test]
    fn a_future_format_of_another_shape_still_says_to_upgrade() {
        let err = Lockfile::parse("version = 3\n[[package]]\nname = \"x\"\n").unwrap_err();
        assert!(err.message.contains("upgrade hpy"), "{err}");
    }

    #[test]
    fn version_zero_is_refused() {
        let err = Lockfile::parse("version = 0\n[happyview]\nversion = \"3.0.0\"\n").unwrap_err();
        assert!(err.message.contains("upgrade hpy"), "{err}");
    }

    fn parse_with(edit: impl FnOnce(&mut Lockfile)) -> Problem {
        let mut l = lock();
        edit(&mut l);
        Lockfile::parse(&l.render()).unwrap_err()
    }

    #[test]
    fn a_cid_that_is_not_one_names_the_entry() {
        for field in ["manifest_cid", "package_cid", "manifest_blob_cid"] {
            let e = parse_with(|l| {
                let p = &mut l.plugins[0];
                match field {
                    "manifest_cid" => p.manifest_cid = String::new(),
                    "package_cid" => p.package_cid = "sha256:abc".into(),
                    _ => p.manifest_blob_cid = "bciqNOTACID".into(),
                }
            });
            assert!(
                e.path.contains("plugin[") && e.path.ends_with(&format!(".{field}")),
                "{e}"
            );
            assert!(e.message.contains("happyview-lua"), "{e}");
        }
    }

    #[test]
    fn a_project_must_be_a_project_uri_and_match_the_version_uri() {
        let e = parse_with(|l| {
            l.plugins[0].project =
                "at://did:plc:abc/at.happyproto.plugin.profile/happyview-lua".into()
        });
        assert!(e.path.ends_with("plugin[1].project"), "{e}");
        let e = parse_with(|l| l.plugins[0].project = "https://example.com/x".into());
        assert!(e.path.ends_with("plugin[1].project"), "{e}");
        let e = parse_with(|l| {
            l.plugins[0].version_uri =
                "at://did:plc:abc/software.release.version/happyview-lua.9.9.9".into()
        });
        assert!(e.path.ends_with("plugin[1].version_uri"), "{e}");
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let e = parse_with(|l| {
            l.plugins[1] = plugin("happyview-lua", PluginKind::Library, &[], "1.0.3")
        });
        assert!(e.message.contains("more than once"), "{e}");
    }

    #[test]
    fn a_dangling_dependency_is_refused() {
        let e = parse_with(|l| l.plugins[0].dependencies = vec!["ghost".into()]);
        assert!(e.path.ends_with(".dependencies"), "{e}");
        assert!(e.message.contains("ghost"), "{e}");
        let mut l = lock();
        l.plugins[0].dependencies = vec!["happyview-http".into()];
        Lockfile::parse(&l.render()).unwrap();
    }

    #[test]
    fn garbage_and_missing_tables_are_problems_not_panics() {
        assert!(Lockfile::parse("not toml {{").is_err());
        assert!(Lockfile::parse("").is_err());
        assert!(Lockfile::parse("version = 2\n").is_err());
    }

    #[test]
    fn render_is_pinned_byte_for_byte() {
        let mut l = lock();
        l.plugins[0].dependencies = vec!["happyview-http".into()];
        let expected = "\
# Written by hpy from happyview.toml. Commit it; don't edit it by hand.

version = 2

[happyview]
version = \"3.0.0\"

[[plugin]]
id = \"happyview-http\"
kind = \"library\"
keys = []
project = \"at://did:plc:abc/software.release.project/happyview-http\"
version = \"1.0.3\"
version_uri = \"at://did:plc:abc/software.release.version/happyview-http.1.0.3\"
manifest_cid = \"bafyreimanifest\"
package_cid = \"bafkreipackage\"
manifest_blob_cid = \"bafkreimanifestblob\"
dependencies = []
capabilities = []

[[plugin]]
id = \"happyview-lua\"
kind = \"interpreter\"
keys = [\"lua\"]
project = \"at://did:plc:abc/software.release.project/happyview-lua\"
version = \"1.4.2\"
channel = \"latest\"
version_uri = \"at://did:plc:abc/software.release.version/happyview-lua.1.4.2\"
manifest_cid = \"bafyreimanifest\"
package_cid = \"bafkreipackage\"
manifest_blob_cid = \"bafkreimanifestblob\"
dependencies = [\"happyview-http\"]
capabilities = []
";
        assert_eq!(l.render(), expected);
    }

    #[test]
    fn write_then_load() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Lockfile::load(dir.path()).unwrap().is_none());
        lock().write(dir.path()).unwrap();
        assert_eq!(
            Lockfile::load(dir.path()).unwrap().unwrap().plugins.len(),
            2
        );
    }

    fn toml(body: &str) -> ProjectToml {
        ProjectToml::parse(&format!("[happyview]\nversion = \"3.0.0\"\n{body}")).unwrap()
    }

    #[test]
    fn drift_is_empty_when_the_lock_describes_the_toml() {
        let channel = toml(
            "[interpreters]\nlua = { did = \"did:plc:abc\", name = \"happyview-lua\", channel = \"latest\" }\n",
        );
        assert_eq!(lock().drift(&channel), Vec::<String>::new());
        let version = toml(
            "[interpreters]\nlua = { did = \"did:plc:abc\", name = \"happyview-lua\", version = \"1.4.2\" }\n",
        );
        let mut pinned = lock();
        pinned.plugins[0].channel = None;
        assert_eq!(pinned.drift(&version), Vec::<String>::new());
    }

    /// The lock remembers how each entry chose its version, so changing the
    /// pin is drift even when the locked version would still do.
    #[test]
    fn a_changed_pin_is_drift() {
        let entry = |pin: &str| {
            toml(&format!(
                "[interpreters]\nlua = {{ did = \"did:plc:abc\", name = \"happyview-lua\", {pin} }}\n"
            ))
        };
        assert_eq!(
            lock().drift(&entry("channel = \"beta\"")),
            [
                "interpreter `lua` is locked from channel latest, but happyview.toml asks for channel beta"
            ]
        );
        assert_eq!(
            lock().drift(&entry("version = \"1.4.2\"")),
            [
                "interpreter `lua` is locked from channel latest, but happyview.toml asks for version 1.4.2"
            ]
        );
        let mut pinned = lock();
        pinned.plugins[0].channel = None;
        assert_eq!(
            pinned.drift(&entry("channel = \"latest\"")),
            [
                "interpreter `lua` is locked at version 1.4.2, but happyview.toml asks for channel latest"
            ]
        );
    }

    #[test]
    fn a_locked_channel_must_be_one_and_only_on_a_named_plugin() {
        // Rendered sorted by id, so happyview-lua is plugin[1].
        let e = parse_with(|l| l.plugins[0].channel = Some("stable".into()));
        assert!(e.path.ends_with("plugin[1].channel"), "{e}");
        let e = parse_with(|l| l.plugins[1].channel = Some("latest".into()));
        assert!(e.path.ends_with("plugin[0].channel"), "{e}");
        assert!(e.message.contains("happyview-http"), "{e}");
    }

    #[test]
    fn drift_names_every_difference() {
        let cfg = ProjectToml::parse(
            "[happyview]\nversion = \"3.1.0\"\n[interpreters]\n\
             lua = { did = \"did:plc:abc\", name = \"happyview-lua\", version = \"2.0.0\" }\n\
             typescript = { did = \"did:plc:abc\", name = \"happyview-ts\", channel = \"latest\" }\n\
             [libraries]\n\
             \"happyview.http\" = { did = \"did:plc:other\", name = \"happyview-http\", channel = \"latest\" }\n",
        )
        .unwrap();
        let mut stale = lock();
        stale.plugins[1].keys = vec!["happyview.http".into()];
        stale
            .plugins
            .push(plugin("old-lib", PluginKind::Library, &["old"], "1.0.0"));
        let drift = stale.drift(&cfg);
        assert_eq!(
            drift,
            [
                "HappyView is locked at 3.0.0 but happyview.toml asks for 3.1.0",
                "interpreter `lua` is locked from channel latest, but happyview.toml asks for version 2.0.0",
                "interpreter `typescript` is not in the lock",
                "library `happyview.http` is locked to at://did:plc:abc/software.release.project/happyview-http, \
                 but happyview.toml names at://did:plc:other/software.release.project/happyview-http",
                "library `old` is locked but no longer in happyview.toml",
            ]
        );
    }
}
