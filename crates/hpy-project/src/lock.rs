//! `happyview.lock`: the exact plugin versions a project runs, and the
//! checksums the registry's release records state for them.

use std::path::Path;

use hpy_plugin::Problem;
use serde::{Deserialize, Serialize};

use crate::config::{PluginKind, ProjectToml, version_matches, write_if_changed};

pub const LOCK_FILE: &str = "happyview.lock";
pub const LOCK_VERSION: u32 = 1;
const HEADER: &str = "# Written by hpy from happyview.toml. Commit it; don't edit it by hand.\n\n";

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
    pub id: String,
    pub kind: PluginKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<String>,
    /// The profile's AT URI (`at://…`), so a later resolution never
    /// re-searches the registry by name.
    pub package: String,
    pub version: String,
    /// `artifacts.package.checksum` from the release record: a multibase
    /// sha2-256 multihash (`bciq…`), the only hash `hpy` can verify.
    pub checksum: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
}

impl Lockfile {
    pub fn parse(text: &str) -> Result<Lockfile, Problem> {
        // The version is read alone first: a newer format may have a shape
        // this one cannot deserialize, and the useful answer is "upgrade".
        #[derive(Deserialize)]
        struct Format {
            version: u32,
        }
        let format: Format =
            toml::from_str(text).map_err(|e| Problem::new(LOCK_FILE, e.to_string()))?;
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
            if p.id.is_empty() {
                return Err(Problem::new(at("id"), "must not be empty"));
            }
            if !p.package.starts_with("at://") || p.package.len() == "at://".len() {
                return Err(Problem::new(
                    at("package"),
                    format!("`{}` is not an at:// URI (plugin `{}`)", p.package, p.id),
                ));
            }
            if hpy_plugin::checksum::sha256_digest(&p.checksum).is_none() {
                return Err(Problem::new(
                    at("checksum"),
                    format!(
                        "`{}` is not a sha2-256 multihash (plugin `{}`)",
                        p.checksum, p.id
                    ),
                ));
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
    /// it still does.
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
            match self.find_key(r.kind, &r.key) {
                None => out.push(format!(
                    "{} `{}` is not in the lock",
                    r.kind.plugin_type(),
                    r.key
                )),
                Some(p) if !version_matches(&r.req, &p.version) => out.push(format!(
                    "{} `{}` is locked at {}, which does not satisfy {}",
                    r.kind.plugin_type(),
                    r.key,
                    p.version,
                    r.req
                )),
                Some(_) => {}
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

    fn plugin(id: &str, kind: PluginKind, keys: &[&str], version: &str) -> LockedPlugin {
        LockedPlugin {
            id: id.into(),
            kind,
            keys: keys.iter().map(|k| k.to_string()).collect(),
            package: format!("at://did:plc:abc/at.happyproto.plugin.profile/{id}"),
            version: version.into(),
            checksum: "bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i".into(),
            dependencies: vec![],
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
        assert!(!text.contains("keys = []"), "{text}");
        let back = Lockfile::parse(&text).unwrap();
        assert_eq!(back.plugins.len(), 2);
        assert_eq!(
            back.find_key(PluginKind::Interpreter, "lua")
                .unwrap()
                .version,
            "1.4.2"
        );
        assert!(back.find_key(PluginKind::Library, "lua").is_none());
    }

    #[test]
    fn a_newer_format_is_refused() {
        let err = Lockfile::parse("version = 2\n[happyview]\nversion = \"3.0.0\"\n").unwrap_err();
        assert!(err.message.contains("upgrade hpy"), "{err}");
    }

    #[test]
    fn a_future_format_of_another_shape_still_says_to_upgrade() {
        let err = Lockfile::parse("version = 2\n[[package]]\nname = \"x\"\n").unwrap_err();
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
    fn a_bad_checksum_names_the_entry() {
        let e = parse_with(|l| l.plugins[0].checksum = "sha256:abc".into());
        assert!(
            e.path.contains("plugin[") && e.path.ends_with(".checksum"),
            "{e}"
        );
        assert!(e.message.contains("happyview-lua"), "{e}");
        let e = parse_with(|l| l.plugins[1].checksum = String::new());
        assert!(e.path.ends_with(".checksum"), "{e}");
    }

    #[test]
    fn a_package_must_be_an_at_uri() {
        let e = parse_with(|l| l.plugins[0].package = "https://example.com/x".into());
        assert!(e.path.ends_with("plugin[1].package"), "{e}");
        let e = parse_with(|l| l.plugins[0].package = "at://".into());
        assert!(e.path.ends_with("plugin[1].package"), "{e}");
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let e = parse_with(|l| l.plugins[1].id = "happyview-lua".into());
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
        assert!(Lockfile::parse("version = 1\n").is_err());
    }

    #[test]
    fn render_is_pinned_byte_for_byte() {
        let mut l = lock();
        l.plugins[0].dependencies = vec!["happyview-http".into()];
        let expected = "\
# Written by hpy from happyview.toml. Commit it; don't edit it by hand.

version = 1

[happyview]
version = \"3.0.0\"

[[plugin]]
id = \"happyview-http\"
kind = \"library\"
package = \"at://did:plc:abc/at.happyproto.plugin.profile/happyview-http\"
version = \"1.0.3\"
checksum = \"bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i\"

[[plugin]]
id = \"happyview-lua\"
kind = \"interpreter\"
keys = [\"lua\"]
package = \"at://did:plc:abc/at.happyproto.plugin.profile/happyview-lua\"
version = \"1.4.2\"
checksum = \"bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i\"
dependencies = [\"happyview-http\"]
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

    #[test]
    fn drift_is_empty_when_the_lock_describes_the_toml() {
        let cfg = ProjectToml::parse(
            "[happyview]\nversion = \"3.0.0\"\n[interpreters]\nlua = \"1.4.0\"\n",
        )
        .unwrap();
        assert_eq!(lock().drift(&cfg), Vec::<String>::new());
    }

    #[test]
    fn drift_names_every_difference() {
        let cfg = ProjectToml::parse(
            "[happyview]\nversion = \"3.1.0\"\n[interpreters]\nlua = \"2.0.0\"\ntypescript = \"0.2.0\"\n",
        )
        .unwrap();
        let mut stale = lock();
        stale
            .plugins
            .push(plugin("old-lib", PluginKind::Library, &["old"], "1.0.0"));
        let drift = stale.drift(&cfg);
        assert_eq!(
            drift,
            [
                "HappyView is locked at 3.0.0 but happyview.toml asks for 3.1.0",
                "interpreter `lua` is locked at 1.4.2, which does not satisfy 2.0.0",
                "interpreter `typescript` is not in the lock",
                "library `old` is locked but no longer in happyview.toml",
            ]
        );
    }
}
