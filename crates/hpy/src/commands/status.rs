use hpy_atproto::{Registry, StoredRecord, VersionView, rkey_of};
use hpy_plugin::VERSION_NSID;
use serde_json::{Value, json};

use crate::cli::StatusArgs;
use crate::commands::profile::resolve_name;
use crate::ctx::Ctx;
use crate::failure::Failure;

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub version: String,
    /// The registry's `availability`, or `not indexed` for a version only
    /// the repo has, or `unknown` when the registry could not be asked.
    pub availability: String,
    pub state: String,
    pub installable: bool,
    pub in_repo: bool,
}

impl Row {
    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "availability": self.availability,
            "state": self.state,
            "installable": self.installable,
            "inRepo": self.in_repo,
        })
    }
}

fn version_of<'a>(name: &str, uri: &'a str) -> Option<&'a str> {
    rkey_of(uri).strip_prefix(name)?.strip_prefix(':')
}

fn name_of<T: serde::Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Every version of `name` in the user's repo or the registry, newest first.
pub fn rows(
    name: &str,
    mine: Vec<StoredRecord>,
    registry: Result<Vec<VersionView>, hpy_atproto::Error>,
) -> Vec<Row> {
    let reachable = registry.is_ok();
    let views = registry.unwrap_or_default();
    let mut out: Vec<Row> = views
        .iter()
        .map(|v| Row {
            version: v.version.clone(),
            availability: name_of(v.availability),
            state: name_of(v.lifecycle.state),
            installable: v.lifecycle.installable,
            in_repo: false,
        })
        .collect();
    for r in &mine {
        let Some(v) = version_of(name, &r.uri) else {
            continue;
        };
        match out.iter_mut().find(|row| row.version == v) {
            Some(row) => row.in_repo = true,
            None => out.push(Row {
                version: v.into(),
                availability: if reachable { "not indexed" } else { "unknown" }.into(),
                state: "active".into(),
                installable: false,
                in_repo: true,
            }),
        }
    }
    out.sort_by(|a, b| {
        match (
            semver::Version::parse(&a.version),
            semver::Version::parse(&b.version),
        ) {
            (Ok(x), Ok(y)) => y.cmp(&x),
            _ => b.version.cmp(&a.version),
        }
    });
    out
}

/// The `--json` answer, which the plugin-publish action reads.
pub fn report(name: &str, project: Option<&str>, rows: &[Row]) -> Value {
    json!({
        "name": name,
        "project": project,
        "versions": rows.iter().map(Row::to_json).collect::<Vec<_>>(),
    })
}

pub async fn run(ctx: &Ctx, args: StatusArgs) -> Result<(), Failure> {
    let name = resolve_name(&ctx.dir, args.name.name)?;
    let session = ctx.session()?;
    let registry = ctx.registry();
    let did = session.repo.did().to_string();
    let project = registry.get_project(&did, &name).await;
    let mut rows = rows(
        &name,
        session.repo.list_records(VERSION_NSID).await?,
        registry.list_versions(&did, &name).await,
    );
    if let Some(v) = &args.version {
        rows.retain(|r| &r.version == v);
        if rows.is_empty() {
            return Err(Failure::usage(format!(
                "{name} {v} is neither in your repo nor in the registry"
            )));
        }
    }
    let project_line = match &project {
        Ok(Some(p)) => {
            let heads: Vec<String> = p
                .channels
                .iter()
                .map(|(c, h)| format!("{c} {}", h.version))
                .collect();
            format!(
                "{} ({})",
                name_of(p.lifecycle.state),
                if heads.is_empty() {
                    "no channels".into()
                } else {
                    heads.join(", ")
                }
            )
        }
        Ok(None) => "not indexed".into(),
        Err(e) => format!("unknown ({e})"),
    };
    let mut human = vec![format!("{name}: {project_line}")];
    for r in &rows {
        let note = match (r.in_repo, r.availability.as_str()) {
            (true, "not indexed") => "  ← the registry refused it or has not seen it yet",
            (_, "pending") => "  ← indexed; the registry has not copied its blobs yet",
            (false, _) => "  (no longer in your repo)",
            _ => "",
        };
        human.push(format!(
            "  {:<16} {:<16} {:<12}{note}",
            r.version, r.availability, r.state
        ));
    }
    if rows.is_empty() {
        human.push("  no versions".into());
    }
    let uri = project.ok().flatten().map(|p| p.uri);
    ctx.out
        .done(&human.join("\n"), report(&name, uri.as_deref(), &rows));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::version_view;
    use hpy_atproto::StoredRecord;
    use hpy_atproto::registry::{Availability, State};

    fn mine(v: &str) -> StoredRecord {
        StoredRecord {
            uri: format!("at://did:plc:x/software.release.version/p:{v}"),
            cid: None,
            value: json!({}),
        }
    }

    fn view(v: &str, availability: Availability, state: State, installable: bool) -> VersionView {
        let mut view = version_view("did:plc:x", "p", v, json!({}));
        view.availability = availability;
        view.lifecycle.state = state;
        view.lifecycle.installable = installable;
        view
    }

    #[test]
    fn merges_and_sorts() {
        let rows = rows(
            "p",
            vec![mine("1.10.0"), mine("1.9.0"), mine("2.0.0-rc.1")],
            Ok(vec![
                view("1.9.0", Availability::Available, State::Deprecated, true),
                view(
                    "1.8.0",
                    Availability::DeletedAtSource,
                    State::Retired,
                    false,
                ),
            ]),
        );
        let got: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.version.as_str(),
                    r.availability.as_str(),
                    r.state.as_str(),
                    r.installable,
                    r.in_repo,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("2.0.0-rc.1", "not indexed", "active", false, true),
                ("1.10.0", "not indexed", "active", false, true),
                ("1.9.0", "available", "deprecated", true, true),
                ("1.8.0", "deletedAtSource", "retired", false, false),
            ]
        );
    }

    #[test]
    fn other_projects_are_ignored_and_an_unreachable_registry_is_marked() {
        let other = StoredRecord {
            uri: "at://did:plc:x/software.release.version/q:1.0.0".into(),
            cid: None,
            value: json!({}),
        };
        let rows = rows(
            "p",
            vec![mine("1.0.0"), other],
            Err(hpy_atproto::Error::Other("down".into())),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].availability, "unknown");
    }

    #[test]
    fn the_json_names_what_the_publish_action_reads() {
        let rows = rows(
            "p",
            vec![mine("1.2.0")],
            Ok(vec![view(
                "1.2.0",
                Availability::Pending,
                State::Active,
                true,
            )]),
        );
        assert_eq!(
            report(
                "p",
                Some("at://did:plc:x/software.release.project/p"),
                &rows
            ),
            json!({
                "name": "p",
                "project": "at://did:plc:x/software.release.project/p",
                "versions": [{ "version": "1.2.0", "availability": "pending", "state": "active",
                               "installable": true, "inRepo": true }]
            })
        );
        assert_eq!(report("p", None, &[])["project"], Value::Null);
    }
}
