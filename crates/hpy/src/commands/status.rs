use hpy_atproto::{ReleaseView, StoredRecord, rkey_of};
use hpy_plugin::RELEASE_NSID;
use serde_json::json;

use crate::cli::StatusArgs;
use crate::commands::profile::resolve_slug;
use crate::ctx::Ctx;
use crate::failure::Failure;

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub version: String,
    pub registry: String,
    pub in_repo: bool,
}

fn version_of<'a>(slug: &str, uri: &'a str) -> Option<&'a str> {
    rkey_of(uri).strip_prefix(slug)?.strip_prefix(':')
}

/// Every version of `slug` in the user's repo or the registry, newest first,
/// with the registry's status for each.
pub fn rows(
    slug: &str,
    mine: Vec<StoredRecord>,
    registry: Result<Vec<ReleaseView>, hpy_atproto::Error>,
) -> Vec<Row> {
    let reachable = registry.is_ok();
    let views = registry.unwrap_or_default();
    let mut out: Vec<Row> = Vec::new();
    for r in &mine {
        if let Some(v) = version_of(slug, &r.uri) {
            let status = views
                .iter()
                .find(|x| version_of(slug, &x.uri) == Some(v))
                .map(|x| x.status.clone());
            out.push(Row {
                version: v.into(),
                registry: status.unwrap_or_else(|| {
                    if reachable {
                        "not indexed".into()
                    } else {
                        "unknown".into()
                    }
                }),
                in_repo: true,
            });
        }
    }
    for x in &views {
        if let Some(v) = version_of(slug, &x.uri)
            && !out.iter().any(|r| r.version == v)
        {
            out.push(Row {
                version: v.into(),
                registry: x.status.clone(),
                in_repo: false,
            });
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

pub async fn run(ctx: &Ctx, args: StatusArgs) -> Result<(), Failure> {
    let slug = resolve_slug(&ctx.dir, args.slug.slug)?;
    let session = ctx.session()?;
    let registry = ctx.registry();
    let did = session.repo.did().to_string();
    let package = hpy_atproto::Registry::get_package(&registry, &did, &slug).await;
    let mut rows = rows(
        &slug,
        session.repo.list_records(RELEASE_NSID).await?,
        hpy_atproto::Registry::list_releases(&registry, &did, &slug).await,
    );
    if let Some(v) = &args.version {
        rows.retain(|r| &r.version == v);
        if rows.is_empty() {
            return Err(Failure::usage(format!(
                "{slug} {v} is neither in your repo nor in the registry"
            )));
        }
    }
    let package_status = match &package {
        Ok(Some(p)) => format!(
            "{} (latest: {})",
            p.status,
            p.latest_version.as_deref().unwrap_or("none active")
        ),
        Ok(None) => "not indexed".into(),
        Err(e) => format!("unknown ({e})"),
    };
    let mut human = vec![format!("{slug}: {package_status}")];
    for r in &rows {
        let note = match (r.in_repo, r.registry.as_str()) {
            (true, "not indexed") => "  ← the registry refused it or has not seen it yet",
            (true, "pending") => "  ← indexed; artifact not copied yet",
            (false, _) => "  (no longer in your repo)",
            _ => "",
        };
        human.push(format!("  {:<16} {:<12}{note}", r.version, r.registry));
    }
    if rows.is_empty() {
        human.push("  no releases".into());
    }
    let json_rows: Vec<_> = rows
        .iter()
        .map(|r| json!({ "version": r.version, "registry": r.registry, "inRepo": r.in_repo }))
        .collect();
    ctx.out.done(
        &human.join("\n"),
        json!({ "slug": slug, "package": package_status, "releases": json_rows }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hpy_atproto::{ReleaseView, StoredRecord};

    fn mine(v: &str) -> StoredRecord {
        StoredRecord {
            uri: format!("at://did:plc:x/at.happyproto.plugin.release/p:{v}"),
            cid: None,
            value: serde_json::json!({}),
        }
    }
    fn view(v: &str, s: &str) -> ReleaseView {
        ReleaseView {
            uri: format!("at://did:plc:x/at.happyproto.plugin.release/p:{v}"),
            status: s.into(),
            record: serde_json::json!({}),
            indexed_at: None,
        }
    }

    #[test]
    fn merges_and_sorts() {
        let rows = rows(
            "p",
            vec![mine("1.10.0"), mine("1.9.0"), mine("2.0.0-rc.1")],
            Ok(vec![view("1.9.0", "active"), view("1.8.0", "deleted")]),
        );
        let got: Vec<_> = rows
            .iter()
            .map(|r| (r.version.as_str(), r.registry.as_str(), r.in_repo))
            .collect();
        assert_eq!(
            got,
            [
                ("2.0.0-rc.1", "not indexed", true),
                ("1.10.0", "not indexed", true),
                ("1.9.0", "active", true),
                ("1.8.0", "deleted", false),
            ]
        );
    }

    #[test]
    fn other_packages_are_ignored_and_unreachable_registry_is_marked() {
        let other = StoredRecord {
            uri: "at://did:plc:x/at.happyproto.plugin.release/q:1.0.0".into(),
            cid: None,
            value: serde_json::json!({}),
        };
        let rows = rows(
            "p",
            vec![mine("1.0.0"), other],
            Err(hpy_atproto::Error::Other("down".into())),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].registry, "unknown");
    }
}
