//! What `hpy happyview deploy` changes on an instance to make it match the
//! project, worked out before anything is sent.

use std::collections::{BTreeMap, BTreeSet};

use hpy_atproto::admin::InstalledPlugin;
use hpy_plugin::validate::parse_project_uri;
use hpy_project::lock::LockedPlugin;

/// One change to the instance's plugins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginStep {
    /// Not installed: install the locked version.
    Install(Target),
    /// The locked project at another version: move it.
    Move { target: Target, from: String },
    /// Installed under the same id from somewhere else (a URL, or another
    /// publisher): install the locked one over it.
    Replace { target: Target, from: String },
    /// Installed, not in the lock, and `--prune-plugins` was given.
    Remove { id: String },
}

/// A locked plugin, as the admin API names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub id: String,
    pub did: String,
    pub name: String,
    pub version: String,
    /// The capabilities the lock pins this version as declaring, which the
    /// deploy accepts. `None` in a lock written before hpy recorded them;
    /// `run` refuses such a lock rather than accept a set it is guessing.
    pub capabilities: Option<Vec<String>>,
    /// Of those, the ones the installed version did not declare. Empty for a
    /// fresh install, where nothing was granted before and the whole set is
    /// shown instead.
    pub new_capabilities: Vec<String>,
}

impl std::fmt::Display for PluginStep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PluginStep::Install(t) => write!(f, "install {} {}", t.id, t.version),
            PluginStep::Move { target, from } => {
                write!(f, "move {} {from} → {}", target.id, target.version)
            }
            PluginStep::Replace { target, from } => {
                write!(
                    f,
                    "replace {} {} (installed from {from})",
                    target.id, target.version
                )
            }
            PluginStep::Remove { id } => write!(f, "remove {id}"),
        }
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct PluginPlan {
    /// In the order to apply them: every install after what it depends on,
    /// removals last.
    pub steps: Vec<PluginStep>,
    /// Locked plugins already at their locked version.
    pub unchanged: Vec<String>,
    /// Installed plugins the lock doesn't list, left alone.
    pub kept: Vec<String>,
}

/// The plugin types a project's lock manages; others (auth) are the
/// instance's own business.
const PROJECT_TYPES: [&str; 2] = ["interpreter", "library"];

/// Locked plugins, each after the ones it depends on, otherwise by id. A
/// dependency the lock doesn't hold, or a cycle, is the lock's validation's
/// to refuse; here it only must not loop.
fn dependency_order(lock: &[LockedPlugin]) -> Vec<&LockedPlugin> {
    let by_id: BTreeMap<&str, &LockedPlugin> = lock.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut done = BTreeSet::new();
    let mut order = Vec::new();
    fn visit<'a>(
        p: &'a LockedPlugin,
        by_id: &BTreeMap<&str, &'a LockedPlugin>,
        done: &mut BTreeSet<&'a str>,
        order: &mut Vec<&'a LockedPlugin>,
    ) {
        if !done.insert(p.id.as_str()) {
            return;
        }
        for dep in &p.dependencies {
            if let Some(d) = by_id.get(dep.as_str()) {
                visit(d, by_id, done, order);
            }
        }
        order.push(p);
    }
    for p in by_id.values() {
        visit(p, &by_id, &mut done, &mut order);
    }
    order
}

pub fn plan_plugins(
    lock: &[LockedPlugin],
    installed: &[InstalledPlugin],
    prune: bool,
) -> PluginPlan {
    let on: BTreeMap<&str, &InstalledPlugin> =
        installed.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut plan = PluginPlan::default();
    for p in dependency_order(lock) {
        // The lock's own validation guarantees the URI parses.
        let (did, name) = parse_project_uri(&p.project).unwrap_or_default();
        let mut target = Target {
            id: p.id.clone(),
            did: did.clone(),
            name: name.clone(),
            version: p.version.clone(),
            capabilities: p.capabilities.clone(),
            new_capabilities: Vec::new(),
        };
        let Some(current) = on.get(p.id.as_str()) else {
            plan.steps.push(PluginStep::Install(target));
            continue;
        };
        // What this change would newly grant. Read from the installed
        // version's own declaration rather than from the lock's previous
        // entry, because the instance is what holds the grant in force and
        // may be running something the lock never pinned.
        let had = current.declared_capabilities();
        target.new_capabilities = target
            .capabilities
            .iter()
            .flatten()
            .filter(|c| !had.contains(&c.as_str()))
            .cloned()
            .collect();
        let from = current.registry.as_ref().filter(|r| {
            r.did.as_deref() == Some(did.as_str()) && r.name.as_deref() == Some(name.as_str())
        });
        match from {
            Some(r) if r.version_uri.as_deref() == Some(p.version_uri.as_str()) => {
                plan.unchanged.push(p.id.clone());
            }
            Some(_) => plan.steps.push(PluginStep::Move {
                target,
                from: current.version.clone(),
            }),
            None => {
                let from = current
                    .registry
                    .as_ref()
                    .and_then(|r| r.did.clone())
                    .unwrap_or_else(|| "a URL".into());
                plan.steps.push(PluginStep::Replace { target, from });
            }
        }
    }
    let locked: BTreeSet<&str> = lock.iter().map(|p| p.id.as_str()).collect();
    for (id, p) in &on {
        if locked.contains(id) || !PROJECT_TYPES.contains(&p.plugin_type.as_str()) {
            continue;
        }
        if prune {
            plan.steps.push(PluginStep::Remove { id: id.to_string() });
        } else {
            plan.kept.push(id.to_string());
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use hpy_atproto::admin::{
        DeclaredCapability, InstalledCapabilities, InstalledFrom, InstalledPlugin,
    };
    use hpy_project::config::PluginKind;
    use hpy_project::lock::LockedPlugin;

    const PUB: &str = "did:plc:pub";

    fn locked(id: &str, version: &str, deps: &[&str]) -> LockedPlugin {
        LockedPlugin {
            id: id.into(),
            kind: PluginKind::Interpreter,
            keys: vec![id.into()],
            project: hpy_plugin::validate::project_uri(PUB, id),
            version: version.into(),
            channel: None,
            version_uri: version_uri(id, version),
            manifest_cid: "bafymanifest".into(),
            package_cid: "bafypackage".into(),
            manifest_blob_cid: "bafyblob".into(),
            dependencies: deps.iter().map(|d| d.to_string()).collect(),
            capabilities: Some(vec!["kv:read".into()]),
        }
    }

    fn version_uri(id: &str, version: &str) -> String {
        hpy_plugin::validate::version_uri(PUB, id, version)
    }

    fn installed(id: &str, from: Option<(&str, &str)>) -> InstalledPlugin {
        InstalledPlugin {
            id: id.into(),
            version: from.map_or("0.0.0", |(_, v)| v).into(),
            plugin_type: "library".into(),
            registry: from.map(|(did, version)| InstalledFrom {
                did: Some(did.into()),
                name: Some(id.into()),
                version_uri: Some(hpy_plugin::validate::version_uri(did, id, version)),
            }),
            capabilities: InstalledCapabilities::default(),
        }
    }

    fn ids(plan: &PluginPlan) -> Vec<String> {
        plan.steps.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_plugin_at_the_locked_version_is_left_alone() {
        let plan = plan_plugins(
            &[locked("lua", "1.0.0", &[])],
            &[installed("lua", Some((PUB, "1.0.0")))],
            false,
        );
        assert!(plan.steps.is_empty());
        assert_eq!(plan.unchanged, vec!["lua"]);
    }

    #[test]
    fn missing_plugins_are_installed_after_what_they_depend_on() {
        let plan = plan_plugins(
            &[
                locked("lua", "1.0.0", &["std"]),
                locked("std", "2.0.0", &["http"]),
                locked("http", "0.1.0", &[]),
            ],
            &[],
            false,
        );
        assert_eq!(
            ids(&plan),
            [
                "install http 0.1.0",
                "install std 2.0.0",
                "install lua 1.0.0"
            ]
        );
    }

    #[test]
    fn another_version_of_the_same_project_is_moved() {
        let plan = plan_plugins(
            &[locked("lua", "1.1.0", &[])],
            &[installed("lua", Some((PUB, "1.0.0")))],
            false,
        );
        assert_eq!(ids(&plan), ["move lua 1.0.0 → 1.1.0"]);
    }

    /// Every capability a fresh install grants is new, so the plan carries the
    /// locked set and leaves the difference empty rather than repeating it.
    #[test]
    fn a_fresh_install_carries_the_locked_capabilities() {
        let plan = plan_plugins(&[locked("lua", "1.0.0", &[])], &[], false);
        let PluginStep::Install(t) = &plan.steps[0] else {
            panic!("{:?}", plan.steps);
        };
        assert_eq!(
            t.capabilities.as_deref(),
            Some(&["kv:read".to_string()][..])
        );
        assert!(t.new_capabilities.is_empty());
    }

    /// A move names only what the installed version did not declare: the
    /// operator already agreed to the rest.
    #[test]
    fn a_move_names_only_the_capabilities_the_installed_version_lacked() {
        let mut lock = locked("lua", "1.1.0", &[]);
        lock.capabilities = Some(vec!["kv:read".into(), "database:write".into()]);
        let mut on = installed("lua", Some((PUB, "1.0.0")));
        on.capabilities = InstalledCapabilities {
            declared: vec![DeclaredCapability {
                name: "kv:read".into(),
            }],
        };
        let plan = plan_plugins(&[lock], &[on], false);
        let PluginStep::Move { target, .. } = &plan.steps[0] else {
            panic!("{:?}", plan.steps);
        };
        assert_eq!(target.new_capabilities, ["database:write"]);
    }

    /// The difference is read from the instance, not from the lock's previous
    /// entry: the instance holds the grant, and may be running something the
    /// lock never pinned.
    #[test]
    fn a_move_to_a_version_granting_no_more_has_nothing_new() {
        let mut on = installed("lua", Some((PUB, "1.0.0")));
        on.capabilities = InstalledCapabilities {
            declared: vec![DeclaredCapability {
                name: "kv:read".into(),
            }],
        };
        let plan = plan_plugins(&[locked("lua", "1.1.0", &[])], &[on], false);
        let PluginStep::Move { target, .. } = &plan.steps[0] else {
            panic!("{:?}", plan.steps);
        };
        assert!(target.new_capabilities.is_empty());
    }

    /// A lock written before hpy recorded capabilities says so, so the deploy
    /// command can refuse rather than accept a set it would be inventing.
    #[test]
    fn an_unrecorded_lock_reaches_the_plan_as_unrecorded() {
        let mut lock = locked("lua", "1.0.0", &[]);
        lock.capabilities = None;
        let plan = plan_plugins(&[lock], &[], false);
        let PluginStep::Install(t) = &plan.steps[0] else {
            panic!("{:?}", plan.steps);
        };
        assert!(t.capabilities.is_none());
    }

    #[test]
    fn a_plugin_from_elsewhere_is_replaced() {
        let plan = plan_plugins(
            &[locked("lua", "1.0.0", &[]), locked("js", "1.0.0", &[])],
            &[
                installed("lua", None),
                installed("js", Some(("did:plc:someone-else", "1.0.0"))),
            ],
            false,
        );
        assert_eq!(
            ids(&plan),
            [
                "replace js 1.0.0 (installed from did:plc:someone-else)",
                "replace lua 1.0.0 (installed from a URL)"
            ]
        );
    }

    #[test]
    fn plugins_not_in_the_lock_are_kept_unless_pruning() {
        let lock = [locked("lua", "1.0.0", &[])];
        let on = [
            installed("lua", Some((PUB, "1.0.0"))),
            installed("old", Some((PUB, "1.0.0"))),
        ];
        let plan = plan_plugins(&lock, &on, false);
        assert!(plan.steps.is_empty());
        assert_eq!(plan.kept, vec!["old"]);
        let plan = plan_plugins(&lock, &on, true);
        assert_eq!(ids(&plan), ["remove old"]);
        assert!(plan.kept.is_empty());
    }

    #[test]
    fn auth_plugins_are_not_the_projects_to_remove() {
        let mut auth = installed("passkeys", None);
        auth.plugin_type = "auth".into();
        let plan = plan_plugins(&[], &[auth], true);
        assert!(plan.steps.is_empty());
        assert!(plan.kept.is_empty());
    }
}
