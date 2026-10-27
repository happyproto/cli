//! `software.release.status` records: what a publisher says about a version's
//! or the whole project's future, and the withdrawal of one said in error.

use hpy_atproto::{Registry, Repo, rkey_of};
use hpy_plugin::STATUS_NSID;
use hpy_plugin::validate::{project_uri, version_problem, version_uri};
use serde_json::{Value, json};

use crate::cli::LifecycleArgs;
use crate::commands::profile::resolve_name;
use crate::ctx::Ctx;
use crate::failure::Failure;

/// The ECMA-428 events the registry acts on. `withdrawn` is reached through
/// `--withdraw`, since it needs the status it cancels rather than a subject.
pub const EVENTS: [&str; 5] = [
    "endOfDevelopment",
    "endOfSupport",
    "supersededBy",
    "endOfDistribution",
    "endOfLife",
];

/// What a status is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Subject {
    Project,
    Version(String),
}

#[derive(Debug, Clone, Default)]
pub struct Details {
    pub kind: Option<String>,
    pub reason: Option<String>,
    pub superseded_by: Option<String>,
}

/// The `putStatus` input for `event` against `subject`.
pub fn status_input(
    did: &str,
    name: &str,
    subject: &Subject,
    event: &str,
    details: &Details,
) -> Result<Value, Failure> {
    if event == "withdrawn" {
        return Err(Failure::usage(
            "to withdraw a status, pass --withdraw <status at-uri>",
        ));
    }
    if !EVENTS.contains(&event) {
        return Err(Failure::usage(format!(
            "`{event}` is not a lifecycle event; use one of {}",
            EVENTS.join(", ")
        )));
    }
    let subject = match subject {
        Subject::Project => project_uri(did, name),
        Subject::Version(v) => {
            if let Some(p) = version_problem(v) {
                return Err(Failure::usage(format!("version: {p}")));
            }
            version_uri(did, name, v)
        }
    };
    let mut input = json!({ "subject": subject, "status": event });
    match (event, &details.superseded_by) {
        ("supersededBy", None) => {
            return Err(Failure::usage(
                "supersededBy needs --superseded-by <version>, the version to move to",
            ));
        }
        ("supersededBy", Some(v)) => {
            if let Some(p) = version_problem(v) {
                return Err(Failure::usage(format!("--superseded-by: {p}")));
            }
            input["supersededBy"] = v.clone().into();
        }
        (_, Some(_)) => {
            return Err(Failure::usage(
                "--superseded-by goes only with the supersededBy event",
            ));
        }
        (_, None) => {}
    }
    if let Some(k) = &details.kind {
        input["kind"] = k.clone().into();
    }
    if let Some(r) = &details.reason {
        input["reason"] = r.clone().into();
    }
    Ok(input)
}

/// The `putStatus` input that cancels the status at `uri`, about the same
/// subject. The status has to be the signed-in user's own.
pub async fn withdraw_input(
    repo: &dyn Repo,
    uri: &str,
    reason: Option<&str>,
) -> Result<Value, Failure> {
    let ours = uri
        .strip_prefix("at://")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(did, rest)| {
            did == repo.did() && rest.starts_with(&format!("{STATUS_NSID}/"))
        });
    if !ours {
        return Err(Failure::usage(format!(
            "--withdraw: `{uri}` is not one of your {STATUS_NSID} records"
        )));
    }
    let record = repo
        .get_record(STATUS_NSID, rkey_of(uri))
        .await?
        .ok_or_else(|| Failure::usage(format!("--withdraw: no status at {uri}")))?;
    let subject = record.value["subject"]
        .as_str()
        .ok_or_else(|| Failure::runtime(format!("the status at {uri} names no subject")))?;
    let mut input = json!({ "subject": subject, "status": "withdrawn", "withdraws": uri });
    if let Some(r) = reason {
        input["reason"] = r.into();
    }
    Ok(input)
}

/// Refuses a session that cannot write status records, before asking the
/// gateway to write one.
pub fn check_grant(repo: &dyn Repo) -> Result<(), Failure> {
    let Some(granted) = repo.granted_scopes() else {
        return Ok(());
    };
    if hpy_atproto::scope::missing_repo_scopes(granted, [STATUS_NSID]).is_empty() {
        return Ok(());
    }
    Err(Failure::usage(format!(
        "recording a lifecycle event needs `repo:{STATUS_NSID}`, which this sign-in was not granted; \
         run `hpy registry login` to sign in again"
    )))
}

pub async fn put(registry: &dyn Registry, input: Value) -> Result<Value, Failure> {
    let written = registry.put_status(input).await?;
    Ok(json!({ "uri": written.uri, "cid": written.cid }))
}

pub async fn run(ctx: &Ctx, args: LifecycleArgs) -> Result<(), Failure> {
    let session = ctx.session()?;
    check_grant(session.repo.as_ref())?;
    let details = Details {
        kind: args.kind,
        reason: args.reason,
        superseded_by: args.superseded_by,
    };
    let input = match (&args.withdraw, args.project, args.target, args.event) {
        (Some(uri), false, None, None) => {
            withdraw_input(session.repo.as_ref(), uri, details.reason.as_deref()).await?
        }
        (Some(_), ..) => {
            return Err(Failure::usage(
                "--withdraw takes the status to withdraw and nothing else",
            ));
        }
        (None, true, Some(event), None) => {
            let name = resolve_name(&ctx.dir, args.name.name)?;
            status_input(
                session.repo.did(),
                &name,
                &Subject::Project,
                &event,
                &details,
            )?
        }
        (None, false, Some(version), Some(event)) => {
            let name = resolve_name(&ctx.dir, args.name.name)?;
            let subject = Subject::Version(version);
            status_input(session.repo.did(), &name, &subject, &event, &details)?
        }
        (None, true, ..) => {
            return Err(Failure::usage(
                "usage: hpy registry plugin lifecycle --project <EVENT>",
            ));
        }
        (None, false, ..) => {
            return Err(Failure::usage(
                "usage: hpy registry plugin lifecycle <VERSION> <EVENT>, or --project <EVENT>",
            ));
        }
    };
    if !ctx.prompter.confirm(
        &format!(
            "Record `{}` for {}?",
            input["status"].as_str().unwrap_or_default(),
            input["subject"].as_str().unwrap_or_default()
        ),
        args.yes,
    )? {
        return Err(Failure::runtime("cancelled"));
    }
    let out = put(&session.registry(), input).await?;
    ctx.out.done(
        &format!("Recorded {}", out["uri"].as_str().unwrap_or_default()),
        out,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{DID, FakeRegistry, FakeRepo};

    fn input(subject: Subject, event: &str, details: Details) -> Result<Value, Failure> {
        status_input(DID, "my-plugin", &subject, event, &details)
    }

    #[test]
    fn a_version_status_names_the_version_record() {
        let got = input(
            Subject::Version("1.0.0".into()),
            "endOfSupport",
            Details {
                kind: Some("security".into()),
                reason: Some("use 2.x".into()),
                superseded_by: None,
            },
        )
        .unwrap();
        assert_eq!(
            got,
            json!({
                "subject": "at://did:plc:testuser/software.release.version/my-plugin.1.0.0",
                "status": "endOfSupport", "kind": "security", "reason": "use 2.x"
            })
        );
    }

    #[test]
    fn a_project_status_names_the_project_record() {
        let got = input(Subject::Project, "endOfLife", Details::default()).unwrap();
        assert_eq!(
            got["subject"],
            "at://did:plc:testuser/software.release.project/my-plugin"
        );
    }

    #[test]
    fn only_the_registrys_events_are_accepted() {
        for event in EVENTS {
            let details = Details {
                superseded_by: (event == "supersededBy").then(|| "2.0.0".to_string()),
                ..Details::default()
            };
            assert!(input(Subject::Project, event, details).is_ok(), "{event}");
        }
        for event in ["deprecated", "EndOfLife", ""] {
            let err = input(Subject::Project, event, Details::default()).unwrap_err();
            assert_eq!(err.code, 2, "{event}");
            assert!(
                err.report.to_string().contains("endOfDistribution"),
                "{event}"
            );
        }
        let err = input(Subject::Project, "withdrawn", Details::default()).unwrap_err();
        assert!(err.report.to_string().contains("--withdraw"));
    }

    #[test]
    fn superseded_by_needs_and_only_goes_with_its_version() {
        let err = input(Subject::Project, "supersededBy", Details::default()).unwrap_err();
        assert!(err.report.to_string().contains("--superseded-by"));
        let got = input(
            Subject::Version("1.0.0".into()),
            "supersededBy",
            Details {
                superseded_by: Some("2.0.0".into()),
                ..Details::default()
            },
        )
        .unwrap();
        assert_eq!(got["supersededBy"], "2.0.0");
        let err = input(
            Subject::Project,
            "endOfLife",
            Details {
                superseded_by: Some("2.0.0".into()),
                ..Details::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code, 2);
        let err = input(
            Subject::Version("v1".into()),
            "endOfLife",
            Details::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, 2);
    }

    #[tokio::test]
    async fn a_withdrawal_names_the_status_and_its_subject() {
        let subject = "at://did:plc:testuser/software.release.version/my-plugin.1.0.0";
        let repo = FakeRepo::with(&[(
            STATUS_NSID,
            "3labc",
            json!({ "subject": subject, "status": "endOfLife" }),
        )]);
        let uri = format!("at://{DID}/{STATUS_NSID}/3labc");
        let got = withdraw_input(&repo, &uri, Some("by mistake"))
            .await
            .unwrap();
        assert_eq!(
            got,
            json!({ "subject": subject, "status": "withdrawn", "withdraws": uri,
                    "reason": "by mistake" })
        );
        let reg = FakeRegistry::default();
        let out = put(&reg, got.clone()).await.unwrap();
        assert_eq!(
            out,
            json!({ "uri": "at://did:plc:testuser/software.release.status/3lstatus",
                    "cid": "bafystatus" })
        );
        assert_eq!(reg.statuses.lock().unwrap()[0], got);
    }

    #[test]
    fn a_grant_without_the_status_collection_is_refused() {
        let old = FakeRepo {
            scopes: Some("atproto repo:at.happyproto.plugin.release".into()),
            ..FakeRepo::default()
        };
        let err = check_grant(&old).unwrap_err();
        assert_eq!(err.code, 2);
        assert!(
            err.report
                .to_string()
                .contains("repo:software.release.status")
        );
        let current = FakeRepo {
            scopes: Some(hpy_atproto::settings::DEFAULT_SCOPE.into()),
            ..FakeRepo::default()
        };
        check_grant(&current).unwrap();
        check_grant(&FakeRepo::default()).unwrap();
    }

    #[tokio::test]
    async fn only_your_own_existing_status_can_be_withdrawn() {
        let repo = FakeRepo::default();
        for uri in [
            "at://did:plc:someoneelse/software.release.status/3labc".to_string(),
            format!("at://{DID}/software.release.version/my-plugin.1.0.0"),
            format!("at://{DID}/{STATUS_NSID}/3lnothere"),
        ] {
            let err = withdraw_input(&repo, &uri, None).await.unwrap_err();
            assert_eq!(err.code, 2, "{uri}");
        }
    }
}
