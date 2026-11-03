use std::collections::{BTreeMap, BTreeSet, VecDeque};

use hpy_atproto::{Registry, VersionView};
use hpy_plugin::TRACKS;
use hpy_plugin::artifact::PluginArtifact;
use hpy_plugin::validate::{parse_project_uri, version_uri};
use hpy_project::config::{Pin, PluginKind, ProjectToml, version_matches};
use hpy_project::lock::{LOCK_VERSION, LockedHappyview, LockedPlugin, Lockfile};
use hpy_project::manifest::{happyview_requirement, project_requirements};

use crate::failure::Failure;

/// A project that answers to an interpreter or library key, as `add` and
/// `create` offer it.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub project: String,
    pub did: String,
    pub name: String,
    pub handle: Option<String>,
    pub display_name: String,
    /// The channel a new entry follows: `latest`, else the only one there is.
    pub channel: String,
    /// The version that channel points at.
    pub version: String,
    pub language_id: Option<String>,
    pub namespace: Option<String>,
}

impl Candidate {
    pub fn label(&self) -> String {
        let by = self.handle.as_deref().unwrap_or(&self.did);
        format!(
            "{} ({} {} {}, by {by}) {}",
            self.display_name, self.name, self.channel, self.version, self.project
        )
    }

    /// The name a project uses for it in `happyview.toml`.
    pub fn key(&self, kind: PluginKind) -> String {
        match kind {
            PluginKind::Interpreter => self
                .language_id
                .clone()
                .unwrap_or_else(|| self.name.clone()),
            PluginKind::Library => self.namespace.clone().unwrap_or_else(|| self.name.clone()),
        }
    }

    pub fn answers(&self, kind: PluginKind, key: &str) -> bool {
        answers(
            kind,
            key,
            &self.name,
            self.language_id.as_deref(),
            self.namespace.as_deref(),
        )
    }
}

fn answers(
    kind: PluginKind,
    key: &str,
    name: &str,
    language_id: Option<&str>,
    namespace: Option<&str>,
) -> bool {
    match kind {
        PluginKind::Interpreter => language_id == Some(key),
        PluginKind::Library => namespace == Some(key) || name == key,
    }
}

/// The artifact a version view carries, refused by name when unreadable.
pub fn artifact_of(view: &VersionView) -> Result<PluginArtifact, Failure> {
    PluginArtifact::from_value(&view.artifact).map_err(|e| {
        Failure::runtime(format!(
            "the registry's artifact for {} {} {e}",
            view.name, view.version
        ))
    })
}

fn blob_cid(blob: &serde_json::Value) -> String {
    blob["ref"]["$link"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

/// The projects a version requires. Only a library's count: HappyView links
/// libraries to libraries, and an interpreter reaches them by namespace.
fn library_requirements(artifact: &PluginArtifact) -> Vec<(String, String)> {
    if artifact.plugin_type == "library" {
        project_requirements(artifact)
    } else {
        Vec::new()
    }
}

/// Every project of this kind with a channel to follow, with what it
/// answers to.
pub async fn candidates(reg: &dyn Registry, kind: PluginKind) -> Result<Vec<Candidate>, Failure> {
    let mut out = Vec::new();
    for project in reg.search_projects(Some(kind.plugin_type()), None).await? {
        // A search may leave the channels out; then each is asked for.
        let channels: Vec<&str> = TRACKS
            .iter()
            .copied()
            .filter(|c| project.channels.is_empty() || project.channels.contains_key(*c))
            .collect();
        let mut head = None;
        for channel in channels {
            if let Some(view) = reg
                .resolve_channel(&project.did, &project.name, channel)
                .await?
            {
                head = Some((channel, view));
                break;
            }
        }
        let Some((channel, view)) = head else {
            continue;
        };
        let Ok(artifact) = PluginArtifact::from_value(&view.artifact) else {
            continue;
        };
        out.push(Candidate {
            project: project.uri.clone(),
            did: project.did.clone(),
            name: project.name.clone(),
            handle: project.handle.clone(),
            display_name: project.publication.name.clone(),
            channel: channel.into(),
            version: view.version.clone(),
            language_id: artifact.language_id,
            namespace: artifact.namespace,
        });
    }
    Ok(out)
}

/// The highest installable version satisfying every range.
pub fn pick_version<'a>(versions: &'a [VersionView], reqs: &[String]) -> Option<&'a VersionView> {
    versions
        .iter()
        .filter(|v| v.lifecycle.installable)
        .filter_map(|v| {
            let parsed = semver::Version::parse(&v.version).ok()?;
            reqs.iter()
                .all(|req| version_matches(req, &v.version))
                .then_some((parsed, v))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, v)| v)
}

/// Picks one of several candidates answering a key, by index.
pub type Choose<'a> = &'a (dyn Fn(&str, &[Candidate]) -> Result<usize, Failure> + Sync);

pub struct Resolver<'a> {
    pub registry: &'a dyn Registry,
    pub warn: &'a (dyn Fn(&str) + Sync),
}

/// A range on a project from the project URI of the library that asks it.
type Req = (String, String);

#[derive(Clone)]
struct Chosen {
    view: VersionView,
    artifact: PluginArtifact,
}

struct Node {
    did: String,
    name: String,
    kind: PluginKind,
    keys: BTreeSet<String>,
    /// What `happyview.toml` pins it to, and under which key.
    pin: Option<(Pin, String)>,
    reqs: Vec<Req>,
    chosen: Option<Chosen>,
    /// The newest version, when nothing satisfied the ranges and every
    /// installable version is a prerelease, which no plain range matches.
    only_prereleases: Option<String>,
}

impl Node {
    fn needed(&self) -> bool {
        !self.keys.is_empty() || !self.reqs.is_empty()
    }

    fn version(&self) -> Option<&str> {
        self.chosen.as_ref().map(|c| c.view.version.as_str())
    }
}

/// Removes every requirement `project` stated and returns the nodes that lost
/// one. A node left with no keys and no requirements is needed by nothing, so
/// its own requirements are withdrawn in turn and its choice forgotten.
fn withdraw(nodes: &mut BTreeMap<String, Node>, project: &str) -> BTreeSet<String> {
    let mut touched = BTreeSet::new();
    let mut pending = vec![project.to_string()];
    while let Some(requirer) = pending.pop() {
        for (uri, node) in nodes.iter_mut() {
            let before = node.reqs.len();
            node.reqs.retain(|(_, who)| who != &requirer);
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

/// Every constraint on `project` with who stated it, including the version
/// of each requiring library: that version is what a user can change.
fn conflict(nodes: &BTreeMap<String, Node>, project: &str) -> Failure {
    let node = &nodes[project];
    let mut asked = Vec::new();
    if let Some((pin, _)) = &node.pin {
        let pin = match pin {
            Pin::Channel(c) => format!("channel {c}"),
            Pin::Version(v) => format!("version {v}"),
        };
        asked.push(format!("happyview.toml pins {} {pin}", node.name));
    }
    let mut older = Vec::new();
    for (req, who) in &node.reqs {
        let requirer = &nodes[who];
        older.push(format!("`{}`", requirer.name));
        let version = requirer.version().unwrap_or("?");
        asked.push(format!(
            "{}@{version} needs {} {req}",
            requirer.name, node.name
        ));
    }
    let mut msg = format!(
        "no version of {} satisfies every requirement: {}",
        node.name,
        asked.join("; ")
    );
    if !older.is_empty() {
        msg.push_str(&format!(
            "\nan older version of {} may ask for less; naming one in happyview.toml may settle this",
            older.join(" or ")
        ));
    }
    let names_prerelease = |req: &str| {
        semver::VersionReq::parse(req)
            .is_ok_and(|r| r.comparators.iter().any(|c| !c.pre.is_empty()))
    };
    if let Some(newest) = &node.only_prereleases
        && !node.reqs.iter().any(|(req, _)| names_prerelease(req))
    {
        msg.push_str(&format!(
            "\n{} has only prereleases, which a range matches only when it names one, as \"^{newest}\" does",
            node.name
        ));
    }
    Failure::usage(msg)
}

fn state_name(view: &VersionView) -> String {
    serde_json::to_value(view.lifecycle.state)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// `unavailable (withdrawn by its publisher)`, for messages.
fn standing(view: &VersionView) -> String {
    match &view.lifecycle.reason {
        Some(reason) => format!("{}: {reason}", state_name(view)),
        None => state_name(view),
    }
}

pub async fn resolve_lock(
    r: &Resolver<'_>,
    cfg: &ProjectToml,
    previous: Option<&Lockfile>,
) -> Result<Lockfile, Failure> {
    let hv = cfg.happyview_version()?.to_string();
    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();

    for req in cfg.requirements() {
        let uri = req.entry.project_uri();
        let node = nodes.entry(uri.clone()).or_insert_with(|| Node {
            did: req.entry.did.clone(),
            name: req.entry.name.clone(),
            kind: req.kind,
            keys: BTreeSet::new(),
            pin: None,
            reqs: Vec::new(),
            chosen: None,
            only_prereleases: None,
        });
        if node.kind != req.kind {
            return Err(Failure::usage(format!(
                "happyview.toml names {uri} as both an interpreter and a library"
            )));
        }
        match &node.pin {
            Some((pin, other)) if pin != &req.entry.pin => {
                return Err(Failure::usage(format!(
                    "happyview.toml's `{other}` and `{}` both name {uri} but pin it differently; pin it one way",
                    req.key
                )));
            }
            Some(_) => {}
            None => node.pin = Some((req.entry.pin.clone(), req.key.clone())),
        }
        node.keys.insert(req.key.clone());
        queue.push_back(uri);
    }

    // A project no version satisfies is set aside rather than refused: a
    // later re-pick of whoever asked can withdraw the request that caused it.
    let mut unsatisfied: BTreeSet<String> = BTreeSet::new();
    let mut rounds = 0;
    while let Some(uri) = queue.pop_front() {
        rounds += 1;
        if rounds > 64 * (nodes.len() + 1) {
            let mut changing: BTreeSet<&str> =
                queue.iter().map(|p| nodes[p].name.as_str()).collect();
            changing.insert(nodes[&uri].name.as_str());
            let changing: Vec<&str> = changing.into_iter().collect();
            return Err(Failure::runtime(format!(
                "plugin requirements do not settle on one set of versions; still changing: {}",
                changing.join(", ")
            )));
        }
        let (ranges, pin) = {
            let n = &nodes[&uri];
            if !n.needed() {
                continue;
            }
            let ranges: Vec<String> = n.reqs.iter().map(|(req, _)| req.clone()).collect();
            (ranges, n.pin.clone().map(|(pin, _)| pin))
        };
        if let Some(v) = nodes[&uri].version()
            && ranges.iter().all(|req| version_matches(req, v))
        {
            unsatisfied.remove(&uri);
            continue;
        }
        let chosen = match choose(r, previous, &uri, &nodes[&uri], pin.as_ref(), &ranges).await? {
            Ok(chosen) => chosen,
            Err(only_prereleases) => {
                nodes.get_mut(&uri).expect("node exists").only_prereleases = only_prereleases;
                unsatisfied.insert(uri);
                continue;
            }
        };
        unsatisfied.remove(&uri);
        check_chosen(r, &nodes[&uri], &chosen, &hv)?;
        // What the version this replaces asked of other projects no longer
        // holds; left in place, it would conflict with what this one asks.
        for touched in withdraw(&mut nodes, &uri) {
            if nodes[&touched].needed() {
                queue.push_back(touched);
            } else {
                unsatisfied.remove(&touched);
            }
        }
        // In a cycle, what this project required may have been all that
        // required it.
        if !nodes[&uri].needed() {
            continue;
        }
        for (dep, range) in library_requirements(&chosen.artifact) {
            let Some((dep_did, dep_name)) = parse_project_uri(&dep) else {
                continue;
            };
            let node = nodes.entry(dep.clone()).or_insert_with(|| Node {
                did: dep_did,
                name: dep_name,
                kind: PluginKind::Library,
                keys: BTreeSet::new(),
                pin: None,
                reqs: Vec::new(),
                chosen: None,
                only_prereleases: None,
            });
            node.reqs.push((range, uri.clone()));
            queue.push_back(dep);
        }
        nodes.get_mut(&uri).expect("node exists").chosen = Some(chosen);
    }
    if let Some(uri) = unsatisfied.first() {
        return Err(conflict(&nodes, uri));
    }

    // Keep what the toml names and what those reach through requires.
    let mut reachable: BTreeSet<String> = nodes
        .iter()
        .filter(|(_, n)| !n.keys.is_empty())
        .map(|(k, _)| k.clone())
        .collect();
    let mut stack: Vec<String> = reachable.iter().cloned().collect();
    while let Some(uri) = stack.pop() {
        if let Some(chosen) = &nodes[&uri].chosen {
            for (dep, _) in library_requirements(&chosen.artifact) {
                if nodes.contains_key(&dep) && reachable.insert(dep.clone()) {
                    stack.push(dep);
                }
            }
        }
    }

    let mut plugins: Vec<LockedPlugin> = Vec::new();
    for uri in &reachable {
        let n = &nodes[uri];
        let chosen = n.chosen.clone().expect("every reachable node was resolved");
        if let Some(other) = plugins.iter().find(|p| p.id == n.name) {
            return Err(Failure::usage(format!(
                "{} and {uri} are both named `{}`, and HappyView loads plugins by id",
                other.project, n.name
            )));
        }
        let dependencies = library_requirements(&chosen.artifact)
            .into_iter()
            .filter(|(dep, _)| reachable.contains(dep))
            .filter_map(|(dep, _)| parse_project_uri(&dep).map(|(_, name)| name))
            .collect();
        let version = chosen.view.version.clone();
        plugins.push(LockedPlugin {
            id: n.name.clone(),
            kind: n.kind,
            keys: n.keys.iter().cloned().collect(),
            project: uri.clone(),
            version_uri: version_uri(&n.did, &n.name, &version),
            version,
            channel: match &n.pin {
                Some((Pin::Channel(c), _)) => Some(c.clone()),
                _ => None,
            },
            manifest_cid: chosen.view.manifest.cid.clone(),
            package_cid: blob_cid(&chosen.artifact.package),
            manifest_blob_cid: blob_cid(&chosen.artifact.manifest),
            dependencies,
            capabilities: Some(chosen.artifact.capabilities.clone()),
        });
    }
    Ok(Lockfile {
        version: LOCK_VERSION,
        happyview: LockedHappyview { version: hv },
        plugins,
    })
}

/// That the version chosen for `node` is the kind, and answers the keys,
/// `happyview.toml` names it by.
fn check_chosen(r: &Resolver<'_>, node: &Node, chosen: &Chosen, hv: &str) -> Result<(), Failure> {
    let a = &chosen.artifact;
    let at = format!("{}@{}", node.name, chosen.view.version);
    if a.plugin_type != node.kind.plugin_type() {
        return Err(Failure::usage(format!(
            "{at} is a {} plugin, but it is wanted as {} {}",
            a.plugin_type,
            if node.kind == PluginKind::Interpreter {
                "an"
            } else {
                "a"
            },
            node.kind.plugin_type()
        )));
    }
    if let Some(key) = node.keys.iter().find(|key| {
        !answers(
            node.kind,
            key,
            &node.name,
            a.language_id.as_deref(),
            a.namespace.as_deref(),
        )
    }) {
        return Err(Failure::usage(format!(
            "{at} does not answer to `{key}`, which happyview.toml names it by"
        )));
    }
    if a.plugin_type == "interpreter" && a.file_extensions.is_empty() {
        return Err(Failure::usage(format!(
            "{at} declares no file extensions, so no project file can name it; \
             it predates project mode, so pick a later version"
        )));
    }
    if let Some(range) = happyview_requirement(a)
        && !version_matches(&range, hv)
    {
        (r.warn)(&format!(
            "{at} asks for HappyView {range}, and this project pins {hv}"
        ));
    }
    Ok(())
}

/// `version` of the project, which the lock may already pin: a locked
/// version whose manifest changed is not the one locked, so it is refused.
async fn fetch_version(
    r: &Resolver<'_>,
    locked: Option<&LockedPlugin>,
    node: &Node,
    version: &str,
) -> Result<Option<Chosen>, Failure> {
    let Some(view) = r
        .registry
        .get_version(&node.did, &node.name, version)
        .await?
    else {
        return Ok(None);
    };
    if let Some(p) = locked.filter(|p| p.version == version)
        && p.manifest_cid != view.manifest.cid
    {
        return Err(Failure::runtime(format!(
            "the registry's {} {version} no longer matches happyview.lock",
            node.name
        )));
    }
    let artifact = artifact_of(&view)?;
    Ok(Some(Chosen { view, artifact }))
}

/// The version for a node: what a pin names, else the locked one while it
/// still satisfies, else the highest installable one that does. When none
/// does, the error is the newest version if every installable one is a
/// prerelease.
async fn choose(
    r: &Resolver<'_>,
    previous: Option<&Lockfile>,
    uri: &str,
    node: &Node,
    pin: Option<&Pin>,
    ranges: &[String],
) -> Result<Result<Chosen, Option<String>>, Failure> {
    let locked = previous.and_then(|l| l.plugins.iter().find(|p| p.project == uri));
    let satisfies = |v: &str| ranges.iter().all(|req| version_matches(req, v));
    match pin {
        Some(Pin::Version(v)) => {
            let chosen = fetch_version(r, locked, node, v)
                .await?
                .ok_or_else(|| Failure::usage(format!("the registry has no {} {v}", node.name)))?;
            if !chosen.view.lifecycle.installable {
                // An exact pin is the operator's call; they hear why it is
                // not offered to anyone else.
                (r.warn)(&format!(
                    "{}@{v} is {}; happyview.toml pins it, so it is used anyway",
                    node.name,
                    standing(&chosen.view)
                ));
            }
            return Ok(if satisfies(v) { Ok(chosen) } else { Err(None) });
        }
        Some(Pin::Channel(c)) => {
            // Only a version this channel chose is kept: one locked from
            // another channel or an exact pin is not what was asked for now.
            if let Some(p) = locked
                && p.channel.as_deref() == Some(c.as_str())
                && satisfies(&p.version)
                && let Some(chosen) = fetch_version(r, locked, node, &p.version).await?
            {
                if !chosen.view.lifecycle.installable {
                    (r.warn)(&format!(
                        "{}@{} in happyview.lock is {}; it stays until `hpy happyview add` moves it",
                        node.name,
                        p.version,
                        standing(&chosen.view)
                    ));
                }
                return Ok(Ok(chosen));
            }
            let view = r
                .registry
                .resolve_channel(&node.did, &node.name, c)
                .await?
                .ok_or_else(|| {
                    Failure::usage(format!(
                        "{} has no {c} channel; name another in happyview.toml",
                        node.name
                    ))
                })?;
            if !view.lifecycle.installable {
                return Err(Failure::usage(format!(
                    "{}'s {c} channel points at {}, which is {}; pin another version in happyview.toml",
                    node.name,
                    view.version,
                    standing(&view)
                )));
            }
            let satisfied = satisfies(&view.version);
            let artifact = artifact_of(&view)?;
            let chosen = Chosen { view, artifact };
            return Ok(if satisfied { Ok(chosen) } else { Err(None) });
        }
        None => {}
    }
    if let Some(p) = locked
        && satisfies(&p.version)
    {
        let chosen = fetch_version(r, locked, node, &p.version)
            .await?
            .ok_or_else(|| {
                Failure::runtime(format!(
                    "the registry no longer has {}@{}",
                    node.name, p.version
                ))
            })?;
        if !chosen.view.lifecycle.installable {
            (r.warn)(&format!(
                "{}@{} in happyview.lock is {}; it stays until something asks for another",
                node.name,
                p.version,
                standing(&chosen.view)
            ));
        }
        return Ok(Ok(chosen));
    }
    let versions = r.registry.list_versions(&node.did, &node.name).await?;
    if let Some(view) = pick_version(&versions, ranges) {
        let view = view.clone();
        let artifact = artifact_of(&view)?;
        return Ok(Ok(Chosen { view, artifact }));
    }
    let installable: Vec<semver::Version> = versions
        .iter()
        .filter(|v| v.lifecycle.installable)
        .filter_map(|v| semver::Version::parse(&v.version).ok())
        .collect();
    let only_prereleases = installable
        .iter()
        .all(|v| !v.pre.is_empty())
        .then(|| installable.iter().max().map(|v| v.to_string()))
        .flatten();
    Ok(Err(only_prereleases))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{RegistryFixture, interpreter_ext, library_ext};
    use hpy_plugin::validate::project_uri;
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

    /// `key = { did = HV, name, <pin> }` in `table`.
    fn entry(table: &str, key: &str, name: &str, pin: &str) -> String {
        format!("[{table}]\n{key} = {{ did = \"{HV}\", name = \"{name}\", {pin} }}\n")
    }

    async fn resolve(
        reg: &RegistryFixture,
        cfg: &ProjectToml,
        prev: Option<&Lockfile>,
    ) -> Result<Lockfile, Failure> {
        let r = Resolver {
            registry: reg,
            warn: &|_| {},
        };
        resolve_lock(&r, cfg, prev).await
    }

    fn registry() -> RegistryFixture {
        let mut reg = RegistryFixture::default();
        for (v, wasm) in [
            ("1.4.0", b"lua140"),
            ("1.4.2", b"lua142"),
            ("2.0.0", b"lua200"),
        ] {
            reg.publish(
                HV,
                "happyview-lua",
                v,
                interpreter_ext("lua", "lua"),
                json!({}),
                wasm,
            );
        }
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
            json!({ project_uri(HV, "happyview-db"): "^0.1" }),
            b"record210",
        );
        reg
    }

    #[tokio::test]
    async fn a_channel_and_a_version_resolve_with_dependencies() {
        let reg = registry();
        let cfg = toml(&format!(
            "{}{}",
            entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "channel = \"latest\""
            ),
            entry(
                "libraries",
                "\"happyview.record\"",
                "happyview-record",
                "version = \"2.1.0\""
            ),
        ));
        let lock = resolve(&reg, &cfg, None).await.unwrap();
        assert_eq!(lock.happyview.version, "3.0.0-alpha.12");
        let lua = lock.find_key(PluginKind::Interpreter, "lua").unwrap();
        assert_eq!(
            (lua.id.as_str(), lua.version.as_str()),
            ("happyview-lua", "2.0.0")
        );
        assert_eq!(lua.package_cid, hpy_plugin::checksum::raw_cid(b"lua200"));
        assert_eq!(lua.project, project_uri(HV, "happyview-lua"));
        let view = reg.find(HV, "happyview-lua", "2.0.0").unwrap();
        assert_eq!(lua.version_uri, view.uri);
        assert_eq!(lua.manifest_cid, view.manifest.cid);
        assert_eq!(
            lua.manifest_blob_cid,
            view.artifact["manifest"]["ref"]["$link"].as_str().unwrap()
        );
        // What the published artifact declares, recorded so a deploy accepts
        // the set that was resolved rather than the one served later.
        assert_eq!(
            lua.capabilities.as_deref(),
            Some(&["script:host".to_string()][..])
        );
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
        // Recorded as declaring none, which a deploy can accept; distinct
        // from a lock that never recorded them, which it refuses.
        assert_eq!(db.capabilities.as_deref(), Some(&[][..]));
        // The lock it writes reads back.
        Lockfile::parse(&lock.render()).unwrap();
    }

    #[tokio::test]
    async fn a_channel_that_points_at_an_uninstallable_version_is_refused() {
        let mut reg = registry();
        reg.retire(HV, "happyview-lua", "2.0.0");
        reg.set_channel(HV, "happyview-lua", "latest", "2.0.0");
        let cfg = toml(&entry(
            "interpreters",
            "lua",
            "happyview-lua",
            "channel = \"latest\"",
        ));
        let err = resolve(&reg, &cfg, None).await.unwrap_err();
        assert_eq!(err.code, 2);
        let text = err.report.to_string();
        assert!(
            text.contains("2.0.0") && text.contains("unavailable"),
            "{text}"
        );
        assert!(text.contains("withdrawn by its publisher"), "{text}");
    }

    #[tokio::test]
    async fn a_pinned_version_that_is_not_installable_warns_but_resolves() {
        let mut reg = registry();
        reg.retire(HV, "happyview-lua", "1.4.0");
        let cfg = toml(&entry(
            "interpreters",
            "lua",
            "happyview-lua",
            "version = \"1.4.0\"",
        ));
        let warnings = Mutex::new(Vec::new());
        let warn = |m: &str| warnings.lock().unwrap().push(m.to_string());
        let r = Resolver {
            registry: &reg,
            warn: &warn,
        };
        let lock = resolve_lock(&r, &cfg, None).await.unwrap();
        assert_eq!(lock.plugins[0].version, "1.4.0");
        let warnings = warnings.into_inner().unwrap();
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("1.4.0") && w.contains("unavailable")),
            "{warnings:?}"
        );
    }

    #[tokio::test]
    async fn a_missing_channel_or_version_is_named() {
        let reg = registry();
        let err = resolve(
            &reg,
            &toml(&entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "channel = \"beta\"",
            )),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            err.report.to_string().contains("no beta channel"),
            "{}",
            err.report
        );
        let err = resolve(
            &reg,
            &toml(&entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "version = \"9.0.0\"",
            )),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.report.to_string().contains("9.0.0"), "{}", err.report);
    }

    #[tokio::test]
    async fn a_locked_version_is_kept_while_the_channel_moves_on() {
        let mut reg = RegistryFixture::default();
        reg.publish(
            HV,
            "happyview-lua",
            "1.4.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"a",
        );
        let cfg = toml(&entry(
            "interpreters",
            "lua",
            "happyview-lua",
            "channel = \"latest\"",
        ));
        let first = resolve(&reg, &cfg, None).await.unwrap();
        reg.publish(
            HV,
            "happyview-lua",
            "1.5.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"b",
        );
        let again = resolve(&reg, &cfg, Some(&first)).await.unwrap();
        assert_eq!(again.plugins[0].version, "1.4.0");
        let fresh = resolve(&reg, &cfg, None).await.unwrap();
        assert_eq!(fresh.plugins[0].version, "1.5.0");
    }

    #[tokio::test]
    async fn the_lock_records_the_channel_each_entry_follows() {
        let reg = registry();
        let cfg = toml(&format!(
            "{}{}",
            entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "channel = \"latest\""
            ),
            entry(
                "libraries",
                "\"happyview.record\"",
                "happyview-record",
                "version = \"2.1.0\""
            ),
        ));
        let lock = resolve(&reg, &cfg, None).await.unwrap();
        let channel = |id: &str| {
            lock.plugins
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .channel
                .clone()
        };
        assert_eq!(channel("happyview-lua").as_deref(), Some("latest"));
        assert_eq!(channel("happyview-record"), None);
        assert_eq!(channel("happyview-db"), None);
        assert!(lock.drift(&cfg).is_empty());
    }

    #[tokio::test]
    async fn a_locked_version_from_another_channel_is_not_kept() {
        let mut reg = registry();
        reg.publish(
            HV,
            "happyview-lua",
            "2.1.0-beta.1",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"beta",
        );
        let latest = toml(&entry(
            "interpreters",
            "lua",
            "happyview-lua",
            "channel = \"latest\"",
        ));
        let first = resolve(&reg, &latest, None).await.unwrap();
        let beta = toml(&entry(
            "interpreters",
            "lua",
            "happyview-lua",
            "channel = \"beta\"",
        ));
        assert!(!first.drift(&beta).is_empty());
        let moved = resolve(&reg, &beta, Some(&first)).await.unwrap();
        assert_eq!(moved.plugins[0].version, "2.1.0-beta.1");
        assert_eq!(moved.plugins[0].channel.as_deref(), Some("beta"));
    }

    #[tokio::test]
    async fn a_kept_locked_version_that_is_no_longer_installable_warns() {
        let mut reg = registry();
        let cfg = toml(&entry(
            "interpreters",
            "lua",
            "happyview-lua",
            "channel = \"latest\"",
        ));
        let first = resolve(&reg, &cfg, None).await.unwrap();
        reg.retire(HV, "happyview-lua", "2.0.0");
        let warnings = Mutex::new(Vec::new());
        let warn = |m: &str| warnings.lock().unwrap().push(m.to_string());
        let r = Resolver {
            registry: &reg,
            warn: &warn,
        };
        let lock = resolve_lock(&r, &cfg, Some(&first)).await.unwrap();
        assert_eq!(lock.plugins[0].version, "2.0.0");
        let warnings = warnings.into_inner().unwrap();
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("2.0.0") && w.contains("unavailable")),
            "{warnings:?}"
        );
    }

    #[tokio::test]
    async fn a_locked_version_whose_manifest_changed_is_refused() {
        let reg = registry();
        let cfg = toml(&entry(
            "interpreters",
            "lua",
            "happyview-lua",
            "channel = \"latest\"",
        ));
        let mut prev = resolve(&reg, &cfg, None).await.unwrap();
        prev.plugins[0].manifest_cid = "bafyreisomethingelse".into();
        let err = resolve(&reg, &cfg, Some(&prev)).await.unwrap_err();
        assert!(
            err.report
                .to_string()
                .contains("the registry's happyview-lua 2.0.0 no longer matches happyview.lock"),
            "{}",
            err.report
        );
    }

    #[tokio::test]
    async fn a_dependency_takes_the_highest_installable_version_in_range() {
        let mut reg = registry();
        reg.publish(
            HV,
            "happyview-db",
            "0.1.5",
            library_ext("happyview.db"),
            json!({}),
            b"db015",
        );
        reg.publish(
            HV,
            "happyview-db",
            "0.1.7",
            library_ext("happyview.db"),
            json!({}),
            b"db017",
        );
        reg.publish(
            HV,
            "happyview-db",
            "0.2.0",
            library_ext("happyview.db"),
            json!({}),
            b"db020",
        );
        reg.retire(HV, "happyview-db", "0.1.7");
        let cfg = toml(&entry(
            "libraries",
            "\"happyview.record\"",
            "happyview-record",
            "channel = \"latest\"",
        ));
        let lock = resolve(&reg, &cfg, None).await.unwrap();
        let db = lock
            .plugins
            .iter()
            .find(|p| p.id == "happyview-db")
            .unwrap();
        assert_eq!(db.version, "0.1.5");
    }

    #[tokio::test]
    async fn a_dependency_nothing_needs_any_more_is_dropped() {
        let reg = registry();
        let with = resolve(
            &reg,
            &toml(&entry(
                "libraries",
                "\"happyview.record\"",
                "happyview-record",
                "channel = \"latest\"",
            )),
            None,
        )
        .await
        .unwrap();
        assert_eq!(with.plugins.len(), 2);
        let without = resolve(
            &reg,
            &toml(&entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "channel = \"latest\"",
            )),
            Some(&with),
        )
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
    async fn a_pin_a_requirement_refuses_names_both() {
        let mut reg = registry();
        reg.publish(
            HV,
            "happyview-db",
            "0.2.0",
            library_ext("happyview.db"),
            json!({}),
            b"db020",
        );
        let cfg = toml(&format!(
            "[libraries]\n\"happyview.record\" = {{ did = \"{HV}\", name = \"happyview-record\", channel = \"latest\" }}\n\
             \"happyview.db\" = {{ did = \"{HV}\", name = \"happyview-db\", version = \"0.2.0\" }}\n"
        ));
        let err = resolve(&reg, &cfg, None).await.unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(
            err.report.to_string(),
            "no version of happyview-db satisfies every requirement: \
             happyview.toml pins happyview-db version 0.2.0; happyview-record@2.1.0 needs happyview-db ^0.1\n\
             an older version of `happyview-record` may ask for less; \
             naming one in happyview.toml may settle this"
        );
    }

    #[tokio::test]
    async fn a_repick_withdraws_its_old_requirements() {
        let c_uri = project_uri(HV, "c");
        let a_uri = project_uri(HV, "a");
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
        reg.publish(
            HV,
            "y",
            "1.0.0",
            library_ext("y"),
            json!({ &a_uri: "*" }),
            b"y1",
        );

        // `y` asks for any `a`, which picks 2 and asks for `c ^2`; then `x`
        // forces `a` back to 1, whose `c ^1` must replace that request.
        let cfg = toml(&format!(
            "[libraries]\ny = {{ did = \"{HV}\", name = \"y\", channel = \"latest\" }}\n\
             x = {{ did = \"{HV}\", name = \"x\", channel = \"latest\" }}\n"
        ));
        let lock = resolve(&reg, &cfg, None).await.unwrap();
        let versions: Vec<(&str, &str)> = lock
            .plugins
            .iter()
            .map(|p| (p.id.as_str(), p.version.as_str()))
            .collect();
        assert_eq!(
            versions,
            [
                ("a", "1.0.0"),
                ("c", "1.0.0"),
                ("x", "1.0.0"),
                ("y", "1.0.0")
            ]
        );
    }

    #[tokio::test]
    async fn a_release_must_be_the_kind_and_answer_the_key_it_was_named_for() {
        let mut reg = registry();
        reg.publish(
            OTHER,
            "js",
            "1.0.0",
            interpreter_ext("js", "js"),
            json!({}),
            b"js",
        );
        let library = resolve(
            &reg,
            &toml(&entry(
                "interpreters",
                "lua",
                "happyview-db",
                "channel = \"latest\"",
            )),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            library.report.to_string(),
            "happyview-db@0.1.0 is a library plugin, but it is wanted as an interpreter"
        );
        let other_language = resolve(
            &reg,
            &toml(&format!(
                "[interpreters]\nlua = {{ did = \"{OTHER}\", name = \"js\", channel = \"latest\" }}\n"
            )),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            other_language.report.to_string(),
            "js@1.0.0 does not answer to `lua`, which happyview.toml names it by"
        );
    }

    #[tokio::test]
    async fn only_prereleases_suggests_pinning_a_channel() {
        let mut reg = RegistryFixture::default();
        reg.publish(
            HV,
            "a",
            "1.0.0",
            library_ext("a"),
            json!({ project_uri(HV, "b"): "*" }),
            b"a",
        );
        for v in ["0.1.0-alpha.1", "0.1.0-alpha.3"] {
            reg.publish(HV, "b", v, library_ext("b"), json!({}), v.as_bytes());
        }
        let err = resolve(
            &reg,
            &toml(&entry("libraries", "a", "a", "channel = \"latest\"")),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.report.to_string(),
            "no version of b satisfies every requirement: a@1.0.0 needs b *\n\
             an older version of `a` may ask for less; naming one in happyview.toml may settle this\n\
             b has only prereleases, which a range matches only when it names one, as \"^0.1.0-alpha.3\" does"
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
        let err = resolve(
            &reg,
            &toml(&entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "channel = \"latest\"",
            )),
            None,
        )
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
            warn: &warn,
        };
        resolve_lock(
            &r,
            &toml(&entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "channel = \"latest\"",
            )),
            None,
        )
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
    async fn two_projects_with_one_name_are_refused() {
        let mut reg = registry();
        reg.publish(
            OTHER,
            "happyview-db",
            "0.1.0",
            library_ext("other.db"),
            json!({}),
            b"x",
        );
        let cfg = toml(&format!(
            "[libraries]\n\"happyview.record\" = {{ did = \"{HV}\", name = \"happyview-record\", channel = \"latest\" }}\n\
             \"other.db\" = {{ did = \"{OTHER}\", name = \"happyview-db\", channel = \"latest\" }}\n"
        ));
        let err = resolve(&reg, &cfg, None).await.unwrap_err();
        assert!(format!("{:?}", err.report).contains("by id"));
    }

    #[tokio::test]
    async fn two_keys_pinning_one_project_differently_are_refused() {
        let reg = registry();
        let cfg = toml(&format!(
            "[libraries]\none = {{ did = \"{HV}\", name = \"happyview-db\", channel = \"latest\" }}\n\
             two = {{ did = \"{HV}\", name = \"happyview-db\", version = \"0.1.0\" }}\n"
        ));
        let err = resolve(&reg, &cfg, None).await.unwrap_err();
        assert_eq!(err.code, 2);
        assert!(
            err.report.to_string().contains("`one`") && err.report.to_string().contains("`two`")
        );
    }

    #[tokio::test]
    async fn candidates_follow_each_projects_newest_channel() {
        let mut reg = registry();
        reg.publish(
            HV,
            "happyview-js",
            "0.1.0-alpha.2",
            interpreter_ext("javascript", "js"),
            json!({}),
            b"js",
        );
        let found = candidates(&reg, PluginKind::Interpreter).await.unwrap();
        let summary: Vec<(&str, &str, &str)> = found
            .iter()
            .map(|c| (c.name.as_str(), c.channel.as_str(), c.version.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                ("happyview-lua", "latest", "2.0.0"),
                ("happyview-js", "alpha", "0.1.0-alpha.2")
            ]
        );
        assert!(found[0].answers(PluginKind::Interpreter, "lua"));
        assert_eq!(found[1].key(PluginKind::Interpreter), "javascript");
    }

    #[tokio::test]
    async fn resolution_is_deterministic() {
        let cfg = toml(&format!(
            "{}{}",
            entry(
                "interpreters",
                "lua",
                "happyview-lua",
                "channel = \"latest\""
            ),
            entry(
                "libraries",
                "\"happyview.record\"",
                "happyview-record",
                "channel = \"latest\""
            ),
        ));
        let first = resolve(&registry(), &cfg, None).await.unwrap().render();
        assert_eq!(
            resolve(&registry(), &cfg, None).await.unwrap().render(),
            first
        );
    }
}
