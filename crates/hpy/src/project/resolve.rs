use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

use hpy_atproto::{Registry, ReleaseView, rkey_of};
use hpy_project::config::{PluginKind, ProjectToml, version_matches};
use hpy_project::lock::{LOCK_VERSION, LockedHappyview, LockedPlugin, Lockfile};
use hpy_project::manifest::{
    happyview_requirement, package_requirements, package_uri, parse_package_uri, release_checksum,
    release_extension,
};
use serde_json::Value;

use crate::failure::Failure;

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub package: String,
    pub did: String,
    pub slug: String,
    pub handle: Option<String>,
    pub name: String,
    pub version: String,
    pub language_id: Option<String>,
    pub namespace: Option<String>,
}

impl Candidate {
    pub fn label(&self) -> String {
        let by = self.handle.as_deref().unwrap_or(&self.did);
        format!(
            "{} ({}@{}, by {by}) {}",
            self.name, self.slug, self.version, self.package
        )
    }

    /// The name a project uses for it in `happyview.toml`.
    pub fn key(&self, kind: PluginKind) -> String {
        match kind {
            PluginKind::Interpreter => self
                .language_id
                .clone()
                .unwrap_or_else(|| self.slug.clone()),
            PluginKind::Library => self.namespace.clone().unwrap_or_else(|| self.slug.clone()),
        }
    }

    pub fn answers(&self, kind: PluginKind, key: &str) -> bool {
        answers(
            kind,
            key,
            &self.slug,
            self.language_id.as_deref(),
            self.namespace.as_deref(),
        )
    }
}

fn answers(
    kind: PluginKind,
    key: &str,
    slug: &str,
    language_id: Option<&str>,
    namespace: Option<&str>,
) -> bool {
    match kind {
        PluginKind::Interpreter => language_id == Some(key),
        PluginKind::Library => namespace == Some(key) || slug == key,
    }
}

/// The packages a release requires. Only a library's count: HappyView links
/// libraries to libraries, and an interpreter reaches them by namespace.
fn library_requirements(record: &Value) -> Vec<(String, String)> {
    if record["extensions"][hpy_plugin::EXTENSION_NSID]["pluginType"] == "library" {
        package_requirements(record)
    } else {
        Vec::new()
    }
}

/// Every package whose latest release is of this kind, with what it answers to.
pub async fn candidates(reg: &dyn Registry, kind: PluginKind) -> Result<Vec<Candidate>, Failure> {
    let mut out = Vec::new();
    for pkg in reg.search_packages(kind.plugin_type()).await? {
        let slug = rkey_of(&pkg.uri).to_string();
        // Search leaves the latest version and the handle out; the package
        // view is where the registry states them.
        let (latest, handle) = match pkg.latest_version.clone() {
            Some(latest) => (latest, pkg.handle.clone()),
            None => match reg.get_package(&pkg.did, &slug).await? {
                Some(full) => match full.latest_version {
                    Some(latest) => (latest, full.handle.or_else(|| pkg.handle.clone())),
                    None => continue,
                },
                None => continue,
            },
        };
        let Some(release) = reg.get_release(&pkg.did, &slug, &latest).await? else {
            continue;
        };
        let Ok(ext) = release_extension(&release.record) else {
            continue;
        };
        out.push(Candidate {
            package: package_uri(&pkg.did, &slug),
            did: pkg.did.clone(),
            name: pkg.record["name"].as_str().unwrap_or(&slug).to_string(),
            slug,
            handle,
            version: latest,
            language_id: ext.language_id,
            namespace: ext.namespace,
        });
    }
    Ok(out)
}

/// The highest active release satisfying every range, with its record.
pub fn pick_version(releases: &[ReleaseView], reqs: &[String]) -> Option<(String, Value)> {
    releases
        .iter()
        .filter(|r| r.status == "active")
        .filter_map(|r| {
            let v = r.record["version"].as_str()?;
            let parsed = semver::Version::parse(v).ok()?;
            reqs.iter()
                .all(|req| version_matches(req, v))
                .then(|| (parsed, r.record.clone()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(v, record)| (v.to_string(), record))
}

pub type Choose<'a> = &'a (dyn Fn(&str, &[Candidate]) -> Result<usize, Failure> + Sync);

pub struct Resolver<'a> {
    pub registry: &'a dyn Registry,
    pub choose: Choose<'a>,
    pub warn: &'a (dyn Fn(&str) + Sync),
    /// `(kind, key)` → profile URI, answered before anything is searched.
    pub pins: BTreeMap<(PluginKind, String), String>,
}

/// One range on a package and who stated it: `None` is `happyview.toml`,
/// otherwise the requiring package's URI. A URI rather than a slug, because
/// two publishers can share a slug and a re-pick must withdraw only its own.
type Req = (String, Option<String>);

struct Node {
    did: String,
    slug: String,
    kind: PluginKind,
    keys: BTreeSet<String>,
    reqs: Vec<Req>,
    chosen: Option<(String, Value)>,
}

impl Node {
    fn needed(&self) -> bool {
        !self.keys.is_empty() || !self.reqs.is_empty()
    }
}

/// Removes every requirement `package` stated and returns the nodes that lost
/// one. A node left with no keys and no requirements is needed by nothing, so
/// its own requirements are withdrawn in turn and its choice forgotten.
fn withdraw(nodes: &mut BTreeMap<String, Node>, package: &str) -> BTreeSet<String> {
    let mut touched = BTreeSet::new();
    let mut pending = vec![package.to_string()];
    while let Some(requirer) = pending.pop() {
        for (uri, node) in nodes.iter_mut() {
            let before = node.reqs.len();
            node.reqs
                .retain(|(_, who)| who.as_deref() != Some(requirer.as_str()));
            if node.reqs.len() == before {
                continue;
            }
            touched.insert(uri.clone());
            if !node.needed() && node.chosen.take().is_some() {
                pending.push(uri.clone());
            }
        }
    }
    touched
}

/// Every range on `package` with who stated it, including the version of each
/// requiring package: that version is what a user can change to settle it.
fn conflict(nodes: &BTreeMap<String, Node>, package: &str) -> Failure {
    let node = &nodes[package];
    let mut older = Vec::new();
    let asked: Vec<String> = node
        .reqs
        .iter()
        .map(|(req, who)| match who {
            None => format!("happyview.toml needs {} {req}", node.slug),
            Some(uri) => {
                let requirer = &nodes[uri];
                older.push(format!("`{}`", requirer.slug));
                let version = requirer.chosen.as_ref().map_or("?", |(v, _)| v.as_str());
                format!("{}@{version} needs {} {req}", requirer.slug, node.slug)
            }
        })
        .collect();
    let mut msg = format!(
        "no version of {} satisfies every requirement: {}",
        node.slug,
        asked.join("; ")
    );
    if !older.is_empty() {
        msg.push_str(&format!(
            "\nan older version of {} may ask for less; naming one in happyview.toml may settle this",
            older.join(" or ")
        ));
    }
    Failure::usage(msg)
}

pub async fn resolve_lock(
    r: &Resolver<'_>,
    cfg: &ProjectToml,
    previous: Option<&Lockfile>,
) -> Result<Lockfile, Failure> {
    let hv = cfg.happyview_version()?.to_string();
    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut found: BTreeMap<PluginKind, Vec<Candidate>> = BTreeMap::new();

    for req in cfg.requirements() {
        let pinned = r.pins.get(&(req.kind, req.key.clone())).cloned();
        let locked = previous
            .and_then(|l| l.find_key(req.kind, &req.key))
            .map(|p| p.package.clone());
        let package = match pinned.or(locked) {
            Some(uri) => uri,
            None => {
                let all = match found.entry(req.kind) {
                    Entry::Occupied(e) => e.into_mut(),
                    Entry::Vacant(e) => e.insert(candidates(r.registry, req.kind).await?),
                };
                let matches: Vec<Candidate> = all
                    .iter()
                    .filter(|c| c.answers(req.kind, &req.key))
                    .cloned()
                    .collect();
                match matches.len() {
                    0 => {
                        return Err(Failure::usage(format!(
                            "no {} in the registry answers to `{}`",
                            req.kind.plugin_type(),
                            req.key
                        )));
                    }
                    1 => matches[0].package.clone(),
                    _ => matches[(r.choose)(&req.key, &matches)?].package.clone(),
                }
            }
        };
        let (did, slug) = parse_package_uri(&package)
            .ok_or_else(|| Failure::usage(format!("`{package}` is not a registry package URI")))?;
        let node = nodes.entry(package.clone()).or_insert_with(|| Node {
            did,
            slug,
            kind: req.kind,
            keys: BTreeSet::new(),
            reqs: Vec::new(),
            chosen: None,
        });
        node.keys.insert(req.key.clone());
        node.reqs.push((req.req.clone(), None));
        queue.push_back(package);
    }

    // A package no version satisfies is set aside rather than refused: a
    // later re-pick of whoever asked can withdraw the request that caused it.
    let mut unsatisfied: BTreeSet<String> = BTreeSet::new();
    let mut rounds = 0;
    while let Some(package) = queue.pop_front() {
        rounds += 1;
        if rounds > 64 * (nodes.len() + 1) {
            let mut changing: BTreeSet<&str> =
                queue.iter().map(|p| nodes[p].slug.as_str()).collect();
            changing.insert(nodes[&package].slug.as_str());
            let changing: Vec<&str> = changing.into_iter().collect();
            return Err(Failure::runtime(format!(
                "plugin requirements do not settle on one set of versions; still changing: {}",
                changing.join(", ")
            )));
        }
        let (did, slug, kind, ranges) = {
            let n = &nodes[&package];
            if !n.needed() {
                continue;
            }
            let ranges: Vec<String> = n.reqs.iter().map(|(req, _)| req.clone()).collect();
            (n.did.clone(), n.slug.clone(), n.kind, ranges)
        };
        if let Some((v, _)) = &nodes[&package].chosen
            && ranges.iter().all(|req| version_matches(req, v))
        {
            unsatisfied.remove(&package);
            continue;
        }
        let Some(chosen) = choose_release(r, previous, &package, &did, &slug, &ranges).await?
        else {
            unsatisfied.insert(package);
            continue;
        };
        unsatisfied.remove(&package);
        let ext = release_extension(&chosen.1)?;
        if ext.plugin_type != kind.plugin_type() {
            return Err(Failure::usage(format!(
                "{slug}@{} is a {} plugin, but it is wanted as {} {}",
                chosen.0,
                ext.plugin_type,
                if kind == PluginKind::Interpreter {
                    "an"
                } else {
                    "a"
                },
                kind.plugin_type()
            )));
        }
        if let Some(key) = nodes[&package].keys.iter().find(|key| {
            !answers(
                kind,
                key,
                &slug,
                ext.language_id.as_deref(),
                ext.namespace.as_deref(),
            )
        }) {
            return Err(Failure::usage(format!(
                "{slug}@{} does not answer to `{key}`, which happyview.toml names it by",
                chosen.0
            )));
        }
        if ext.plugin_type == "interpreter" && ext.file_extensions.is_empty() {
            return Err(Failure::usage(format!(
                "{slug}@{} declares no file extensions, so no project file can name it; \
                 it predates project mode, so pick a later version",
                chosen.0
            )));
        }
        if let Some(range) = happyview_requirement(&chosen.1)
            && !version_matches(&range, &hv)
        {
            (r.warn)(&format!(
                "{slug}@{} asks for HappyView {range}, and this project pins {hv}",
                chosen.0
            ));
        }
        // What the version this replaces asked of other packages no longer
        // holds; left in place, it would conflict with what this one asks.
        for touched in withdraw(&mut nodes, &package) {
            if nodes[&touched].needed() {
                queue.push_back(touched);
            } else {
                unsatisfied.remove(&touched);
            }
        }
        // In a cycle, what this package required may have been all that
        // required it.
        if !nodes[&package].needed() {
            continue;
        }
        for (dep, range) in library_requirements(&chosen.1) {
            let Some((dep_did, dep_slug)) = parse_package_uri(&dep) else {
                continue;
            };
            let node = nodes.entry(dep.clone()).or_insert_with(|| Node {
                did: dep_did,
                slug: dep_slug,
                kind: PluginKind::Library,
                keys: BTreeSet::new(),
                reqs: Vec::new(),
                chosen: None,
            });
            node.reqs.push((range, Some(package.clone())));
            queue.push_back(dep);
        }
        nodes.get_mut(&package).expect("node exists").chosen = Some(chosen);
    }
    if let Some(package) = unsatisfied.first() {
        return Err(conflict(&nodes, package));
    }

    // Keep what the toml names and what those reach through requires.
    let mut reachable: BTreeSet<String> = nodes
        .iter()
        .filter(|(_, n)| !n.keys.is_empty())
        .map(|(k, _)| k.clone())
        .collect();
    let mut stack: Vec<String> = reachable.iter().cloned().collect();
    while let Some(package) = stack.pop() {
        if let Some((_, record)) = &nodes[&package].chosen {
            for (dep, _) in library_requirements(record) {
                if nodes.contains_key(&dep) && reachable.insert(dep.clone()) {
                    stack.push(dep);
                }
            }
        }
    }

    let mut plugins: Vec<LockedPlugin> = Vec::new();
    for package in &reachable {
        let n = &nodes[package];
        let (version, record) = n.chosen.clone().expect("every reachable node was resolved");
        if let Some(other) = plugins.iter().find(|p| p.id == n.slug) {
            return Err(Failure::usage(format!(
                "{} and {package} are both named `{}`, and HappyView loads plugins by id",
                other.package, n.slug
            )));
        }
        let dependencies = library_requirements(&record)
            .into_iter()
            .filter(|(dep, _)| reachable.contains(dep))
            .filter_map(|(dep, _)| parse_package_uri(&dep).map(|(_, s)| s))
            .collect();
        plugins.push(LockedPlugin {
            id: n.slug.clone(),
            kind: n.kind,
            keys: n.keys.iter().cloned().collect(),
            package: package.clone(),
            version,
            checksum: release_checksum(&record)?,
            dependencies,
        });
    }
    Ok(Lockfile {
        version: LOCK_VERSION,
        happyview: LockedHappyview { version: hv },
        plugins,
    })
}

/// The locked version when it still satisfies `ranges`, else the highest
/// active one that does, else `None`.
async fn choose_release(
    r: &Resolver<'_>,
    previous: Option<&Lockfile>,
    package: &str,
    did: &str,
    slug: &str,
    ranges: &[String],
) -> Result<Option<(String, Value)>, Failure> {
    let locked = previous.and_then(|l| l.plugins.iter().find(|p| p.package == package));
    if let Some(p) = locked
        && ranges.iter().all(|req| version_matches(req, &p.version))
    {
        let release = r
            .registry
            .get_release(did, slug, &p.version)
            .await?
            .ok_or_else(|| {
                Failure::runtime(format!("the registry no longer has {slug}@{}", p.version))
            })?;
        let stated = release_checksum(&release.record)?;
        if stated != p.checksum {
            return Err(Failure::runtime(format!(
                "the registry states checksum {stated} for {slug}@{}, but happyview.lock records {}; \
                 a published version must never change, so hpy refuses it",
                p.version, p.checksum
            )));
        }
        return Ok(Some((p.version.clone(), release.record)));
    }
    let releases = r.registry.list_releases(did, slug).await?;
    Ok(pick_version(&releases, ranges))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{RegistryFixture, interpreter_ext, library_ext};
    use serde_json::json;
    use std::sync::Mutex;

    const HV: &str = "did:plc:happyview";
    const OTHER: &str = "did:plc:someoneelse";

    fn toml(body: &str) -> ProjectToml {
        ProjectToml::parse(&format!(
            "[happyview]\nversion = \"3.0.0-alpha.12\"\n{body}"
        ))
        .unwrap()
    }

    fn never(_: &str, _: &[Candidate]) -> Result<usize, Failure> {
        panic!("nothing should be ambiguous here")
    }

    async fn resolve(
        reg: &RegistryFixture,
        cfg: &ProjectToml,
        prev: Option<&Lockfile>,
    ) -> Result<Lockfile, Failure> {
        let r = Resolver {
            registry: reg,
            choose: &never,
            warn: &|_| {},
            pins: BTreeMap::new(),
        };
        resolve_lock(&r, cfg, prev).await
    }

    fn registry() -> RegistryFixture {
        let mut reg = RegistryFixture::default();
        reg.publish(
            HV,
            "happyview-lua",
            "1.4.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"lua140",
        );
        reg.publish(
            HV,
            "happyview-lua",
            "1.4.2",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"lua142",
        );
        reg.publish(
            HV,
            "happyview-lua",
            "2.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"lua200",
        );
        reg.publish(
            HV,
            "happyview-db",
            "0.1.0",
            library_ext("happyview.db"),
            json!({}),
            b"db010",
        );
        reg.publish(
            HV,
            "happyview-record",
            "2.1.0",
            library_ext("happyview.record"),
            json!({ "at://did:plc:happyview/at.happyproto.plugin.profile/happyview-db": "^0.1" }),
            b"record210",
        );
        reg
    }

    #[tokio::test]
    async fn resolves_by_language_and_namespace_with_dependencies() {
        let reg = registry();
        let lock = resolve(
            &reg,
            &toml("[interpreters]\nlua = \"1.4.0\"\n[libraries]\n\"happyview.record\" = \"2\"\n"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(lock.happyview.version, "3.0.0-alpha.12");
        let lua = lock.find_key(PluginKind::Interpreter, "lua").unwrap();
        assert_eq!(
            (lua.id.as_str(), lua.version.as_str()),
            ("happyview-lua", "1.4.2")
        );
        assert_eq!(lua.checksum, hpy_plugin::checksum::checksum(b"lua142"));
        let record = lock
            .find_key(PluginKind::Library, "happyview.record")
            .unwrap();
        assert_eq!(record.dependencies, ["happyview-db"]);
        let db = lock
            .plugins
            .iter()
            .find(|p| p.id == "happyview-db")
            .unwrap();
        assert!(db.keys.is_empty());
        assert_eq!(db.version, "0.1.0");
    }

    #[tokio::test]
    async fn search_without_latest_version_falls_back_to_the_package_view() {
        let mut reg = registry();
        let uri = package_uri(HV, "happyview-lua");
        reg.packages
            .iter_mut()
            .find(|p| p.uri == uri)
            .unwrap()
            .handle = Some("happyview.dev".into());
        let search = reg.search_packages("interpreter").await.unwrap();
        assert!(
            search
                .iter()
                .all(|p| p.latest_version.is_none() && p.handle.is_none())
        );

        let found = candidates(&reg, PluginKind::Interpreter).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].version, "2.0.0");
        assert_eq!(found[0].handle.as_deref(), Some("happyview.dev"));
        assert!(
            reg.calls
                .lock()
                .unwrap()
                .contains(&"getPackage happyview-lua".to_string())
        );
    }

    #[tokio::test]
    async fn a_locked_version_that_still_satisfies_is_kept() {
        let reg = registry();
        let cfg = toml("[interpreters]\nlua = \"1.4.0\"\n");
        let mut prev = resolve(&reg, &cfg, None).await.unwrap();
        prev.plugins[0].version = "1.4.0".into();
        prev.plugins[0].checksum = hpy_plugin::checksum::checksum(b"lua140");
        let lock = resolve(&reg, &cfg, Some(&prev)).await.unwrap();
        assert_eq!(lock.plugins[0].version, "1.4.0");
    }

    #[tokio::test]
    async fn previous_lock_package_is_kept_without_asking() {
        let mut reg = registry();
        reg.publish(
            OTHER,
            "lua",
            "9.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"impostor",
        );
        let cfg = toml("[interpreters]\nlua = \"1.4.0\"\n");
        let choose = |_: &str, c: &[Candidate]| -> Result<usize, Failure> {
            Ok(c.iter().position(|c| c.did == HV).unwrap())
        };
        let r = Resolver {
            registry: &reg,
            choose: &choose,
            warn: &|_| {},
            pins: BTreeMap::new(),
        };
        let first = resolve_lock(&r, &cfg, None).await.unwrap();
        let bumped = toml("[interpreters]\nlua = \"2.0.0\"\n");
        let second = resolve(&reg, &bumped, Some(&first)).await.unwrap();
        let lua = second.find_key(PluginKind::Interpreter, "lua").unwrap();
        assert_eq!(
            (lua.id.as_str(), lua.version.as_str()),
            ("happyview-lua", "2.0.0")
        );
    }

    #[tokio::test]
    async fn ambiguity_without_a_choice_is_an_error_naming_package() {
        let mut reg = registry();
        reg.publish(
            OTHER,
            "lua",
            "9.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"impostor",
        );
        let refuse = |key: &str, c: &[Candidate]| -> Result<usize, Failure> {
            Err(Failure::usage(format!(
                "{key}: {} packages; pass --package",
                c.len()
            )))
        };
        let r = Resolver {
            registry: &reg,
            choose: &refuse,
            warn: &|_| {},
            pins: BTreeMap::new(),
        };
        let err = resolve_lock(&r, &toml("[interpreters]\nlua = \"*\"\n"), None)
            .await
            .unwrap_err();
        assert_eq!(err.code, 2);
        assert!(format!("{:?}", err.report).contains("--package"));
    }

    #[tokio::test]
    async fn a_pin_answers_before_choose() {
        let mut reg = registry();
        reg.publish(
            OTHER,
            "lua",
            "9.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"impostor",
        );
        let pins = BTreeMap::from([(
            (PluginKind::Interpreter, "lua".to_string()),
            package_uri(OTHER, "lua"),
        )]);
        let r = Resolver {
            registry: &reg,
            choose: &never,
            warn: &|_| {},
            pins,
        };
        let lock = resolve_lock(&r, &toml("[interpreters]\nlua = \"*\"\n"), None)
            .await
            .unwrap();
        assert_eq!(lock.plugins[0].id, "lua");
    }

    #[tokio::test]
    async fn withdrawn_versions_are_not_picked_but_a_locked_one_stays() {
        let mut reg = registry();
        let cfg = toml("[interpreters]\nlua = \"1.4.0\"\n");
        let first = resolve(&reg, &cfg, None).await.unwrap();
        reg.withdraw(HV, "happyview-lua", "1.4.2");
        assert_eq!(
            resolve(&reg, &cfg, Some(&first)).await.unwrap().plugins[0].version,
            "1.4.2"
        );
        assert_eq!(
            resolve(&reg, &cfg, None).await.unwrap().plugins[0].version,
            "1.4.0"
        );
    }

    #[tokio::test]
    async fn a_dependency_nothing_needs_any_more_is_dropped() {
        let reg = registry();
        let with = resolve(
            &reg,
            &toml("[libraries]\n\"happyview.record\" = \"2\"\n"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(with.plugins.len(), 2);
        let without = resolve(&reg, &toml("[interpreters]\nlua = \"1\"\n"), Some(&with))
            .await
            .unwrap();
        assert_eq!(
            without
                .plugins
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["happyview-lua"]
        );
    }

    #[tokio::test]
    async fn conflicting_requirements_name_both_requirers() {
        let mut reg = registry();
        // 0.2 satisfies the toml on its own, so the conflict appears only once
        // happyview-record's `^0.1` arrives.
        reg.publish(
            HV,
            "happyview-db",
            "0.2.0",
            library_ext("happyview.db"),
            json!({}),
            b"db020",
        );
        let err = resolve(
            &reg,
            &toml("[libraries]\n\"happyview.record\" = \"2\"\n\"happyview.db\" = \"0.2\"\n"),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(
            err.report.to_string(),
            "no version of happyview-db satisfies every requirement: \
             happyview.toml needs happyview-db 0.2; happyview-record@2.1.0 needs happyview-db ^0.1\n\
             an older version of `happyview-record` may ask for less; \
             naming one in happyview.toml may settle this"
        );
    }

    #[tokio::test]
    async fn a_conflict_a_later_repick_clears_is_not_reported() {
        let c_uri = package_uri(HV, "c");
        let a_uri = package_uri(HV, "a");
        let mut reg = RegistryFixture::default();
        reg.publish(HV, "c", "1.0.0", library_ext("c"), json!({}), b"c1");
        reg.publish(HV, "c", "2.0.0", library_ext("c"), json!({}), b"c2");
        reg.publish(
            HV,
            "a",
            "1.0.0",
            library_ext("a"),
            json!({ &c_uri: "^1" }),
            b"a1",
        );
        reg.publish(
            HV,
            "a",
            "2.0.0",
            library_ext("a"),
            json!({ &c_uri: "^2" }),
            b"a2",
        );
        reg.publish(
            HV,
            "x",
            "1.0.0",
            library_ext("x"),
            json!({ &a_uri: "^1" }),
            b"x1",
        );

        // `c` is reached holding the toml's `^1` and `a@2.0.0`'s `^2` before
        // `x` moves `a` back to 1, which withdraws the `^2`.
        let lock = resolve(
            &reg,
            &toml("[libraries]\na = \"*\"\nc = \"^1\"\nx = \"*\"\n"),
            None,
        )
        .await
        .unwrap();
        let versions: Vec<(&str, &str)> = lock
            .plugins
            .iter()
            .map(|p| (p.id.as_str(), p.version.as_str()))
            .collect();
        assert_eq!(versions, [("a", "1.0.0"), ("c", "1.0.0"), ("x", "1.0.0")]);
    }

    #[tokio::test]
    async fn a_package_nothing_needs_any_more_is_not_resolved() {
        let c_uri = package_uri(HV, "c");
        let d_uri = package_uri(HV, "d");
        let a_uri = package_uri(HV, "a");
        let mut reg = RegistryFixture::default();
        // `c` has nothing to offer: resolving it at all would fail.
        reg.publish(HV, "c", "1.0.0", library_ext("c"), json!({}), b"c1");
        reg.withdraw(HV, "c", "1.0.0");
        reg.publish(
            HV,
            "d",
            "1.0.0",
            library_ext("d"),
            json!({ &c_uri: "*" }),
            b"d1",
        );
        reg.publish(HV, "a", "1.0.0", library_ext("a"), json!({}), b"a1");
        reg.publish(
            HV,
            "a",
            "2.0.0",
            library_ext("a"),
            json!({ &d_uri: "*" }),
            b"a2",
        );
        reg.publish(
            HV,
            "x",
            "1.0.0",
            library_ext("x"),
            json!({ &a_uri: "^1" }),
            b"x1",
        );

        // `a@2.0.0` brings in `d`, which queues `c`; `x` then moves `a` to 1,
        // so neither `d` nor `c` is needed by the time `c` comes up.
        let lock = resolve(&reg, &toml("[libraries]\na = \"*\"\nx = \"*\"\n"), None)
            .await
            .unwrap();
        let ids: Vec<&str> = lock.plugins.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["a", "x"]);
        assert!(
            !reg.calls
                .lock()
                .unwrap()
                .contains(&"listReleases c".to_string())
        );
    }

    #[tokio::test]
    async fn a_release_must_be_the_kind_and_answer_the_key_it_was_chosen_for() {
        let mut reg = registry();
        reg.publish(
            OTHER,
            "js",
            "1.0.0",
            interpreter_ext("js", "js"),
            json!({}),
            b"js",
        );
        let pinned = |uri: String| Resolver {
            registry: &reg,
            choose: &never,
            warn: &|_| {},
            pins: BTreeMap::from([((PluginKind::Interpreter, "lua".to_string()), uri)]),
        };
        let cfg = toml("[interpreters]\nlua = \"*\"\n");

        let library = resolve_lock(&pinned(package_uri(HV, "happyview-db")), &cfg, None)
            .await
            .unwrap_err();
        assert_eq!(
            library.report.to_string(),
            "happyview-db@0.1.0 is a library plugin, but it is wanted as an interpreter"
        );
        let other_language = resolve_lock(&pinned(package_uri(OTHER, "js")), &cfg, None)
            .await
            .unwrap_err();
        assert_eq!(
            other_language.report.to_string(),
            "js@1.0.0 does not answer to `lua`, which happyview.toml names it by"
        );
    }

    #[tokio::test]
    async fn star_skips_prereleases_unless_the_range_names_one() {
        let mut reg = RegistryFixture::default();
        for version in ["1.2.0", "1.3.0-alpha.1"] {
            reg.publish(
                HV,
                "happyview-lua",
                version,
                interpreter_ext("lua", "lua"),
                json!({}),
                version.as_bytes(),
            );
        }
        let picked = |range: &str| {
            let cfg = toml(&format!("[interpreters]\nlua = \"{range}\"\n"));
            let reg = &reg;
            async move {
                resolve(reg, &cfg, None).await.unwrap().plugins[0]
                    .version
                    .clone()
            }
        };
        assert_eq!(picked("*").await, "1.2.0");
        assert_eq!(picked("^1.3.0-alpha").await, "1.3.0-alpha.1");
    }

    #[tokio::test]
    async fn a_repick_withdraws_its_old_requirements() {
        let c_uri = package_uri(HV, "c");
        let a_uri = package_uri(HV, "a");
        let mut reg = RegistryFixture::default();
        reg.publish(HV, "c", "1.0.0", library_ext("c"), json!({}), b"c1");
        reg.publish(HV, "c", "2.0.0", library_ext("c"), json!({}), b"c2");
        reg.publish(
            HV,
            "a",
            "1.0.0",
            library_ext("a"),
            json!({ &c_uri: "^1" }),
            b"a1",
        );
        reg.publish(
            HV,
            "a",
            "2.0.0",
            library_ext("a"),
            json!({ &c_uri: "^2" }),
            b"a2",
        );
        reg.publish(
            HV,
            "x",
            "1.0.0",
            library_ext("x"),
            json!({ &a_uri: "^1" }),
            b"x1",
        );

        // `a` first picks 2, which asks for `c ^2`; then `x` forces `a` back
        // to 1, whose `c ^1` must replace that request rather than join it.
        let lock = resolve(&reg, &toml("[libraries]\na = \"*\"\nx = \"*\"\n"), None)
            .await
            .unwrap();
        let version = |id: &str| {
            lock.plugins
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .version
                .clone()
        };
        assert_eq!(
            (version("a"), version("c"), version("x")),
            ("1.0.0".into(), "1.0.0".into(), "1.0.0".into())
        );
    }

    #[tokio::test]
    async fn resolution_is_deterministic() {
        let cfg = toml("[interpreters]\nlua = \"1\"\n[libraries]\n\"happyview.record\" = \"2\"\n");
        let first = resolve(&registry(), &cfg, None).await.unwrap().render();
        assert_eq!(
            resolve(&registry(), &cfg, None).await.unwrap().render(),
            first
        );

        // The same releases published in the opposite order give the same lock.
        let forward = registry();
        let mut reversed = RegistryFixture::default();
        for ((did, slug), releases) in forward.releases.iter().rev() {
            for release in releases.iter().rev() {
                let version = release.record["version"].as_str().unwrap();
                reversed.publish(
                    did,
                    slug,
                    version,
                    release.record["extensions"][hpy_plugin::EXTENSION_NSID].clone(),
                    release.record["requires"].clone(),
                    &forward.artifacts[&(did.clone(), slug.clone(), version.to_string())],
                );
            }
        }
        assert_eq!(
            resolve(&reversed, &cfg, None).await.unwrap().render(),
            first
        );
    }

    #[tokio::test]
    async fn an_unknown_key_says_what_was_searched() {
        let reg = registry();
        let err = resolve(&reg, &toml("[interpreters]\npython = \"*\"\n"), None)
            .await
            .unwrap_err();
        assert_eq!(err.code, 2);
        assert!(
            format!("{:?}", err.report)
                .contains("no interpreter in the registry answers to `python`")
        );
    }

    #[tokio::test]
    async fn an_interpreter_without_file_extensions_is_refused() {
        let mut reg = RegistryFixture::default();
        reg.publish(
            HV,
            "happyview-lua",
            "0.1.0",
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua", "capabilities": [] }),
            json!({}),
            b"old",
        );
        let err = resolve(&reg, &toml("[interpreters]\nlua = \"*\"\n"), None)
            .await
            .unwrap_err();
        assert!(format!("{:?}", err.report).contains("no file extensions"));
    }

    #[tokio::test]
    async fn an_unmet_happyview_requirement_warns_rather_than_refusing() {
        let mut reg = RegistryFixture::default();
        reg.publish(
            HV,
            "happyview-lua",
            "1.0.0",
            interpreter_ext("lua", "lua"),
            json!({ "env:happyview": ">=3.0.0" }),
            b"lua",
        );
        let warnings = Mutex::new(Vec::new());
        let warn = |m: &str| warnings.lock().unwrap().push(m.to_string());
        let r = Resolver {
            registry: &reg,
            choose: &never,
            warn: &warn,
            pins: BTreeMap::new(),
        };
        resolve_lock(&r, &toml("[interpreters]\nlua = \"*\"\n"), None)
            .await
            .unwrap();
        let warnings = warnings.into_inner().unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains(">=3.0.0") && warnings[0].contains("3.0.0-alpha.12"),
            "{warnings:?}"
        );
    }

    #[tokio::test]
    async fn a_changed_checksum_for_a_locked_version_is_refused() {
        let reg = registry();
        let cfg = toml("[interpreters]\nlua = \"1.4.0\"\n");
        let mut prev = resolve(&reg, &cfg, None).await.unwrap();
        prev.plugins[0].checksum = hpy_plugin::checksum::checksum(b"something else");
        let err = resolve(&reg, &cfg, Some(&prev)).await.unwrap_err();
        assert!(format!("{:?}", err.report).contains("must never change"));
    }

    #[tokio::test]
    async fn two_packages_with_one_slug_are_refused() {
        let mut reg = registry();
        reg.publish(
            OTHER,
            "happyview-db",
            "0.1.0",
            library_ext("other.db"),
            json!({}),
            b"x",
        );
        let err = resolve(
            &reg,
            &toml("[libraries]\n\"happyview.record\" = \"2\"\n\"other.db\" = \"*\"\n"),
            None,
        )
        .await
        .unwrap_err();
        assert!(format!("{:?}", err.report).contains("by id"));
    }
}
