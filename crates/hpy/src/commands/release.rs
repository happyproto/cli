//! `hpy registry release`: projects whose releases are servers rather than
//! plugins, such as HappyView itself.
//!
//! A server release carries no bytes for the registry to hold. Its artifact,
//! an `at.happyproto.server.release.v1`, says where the release lives: its
//! container images by digest, the commit it was built from and its release
//! page. The caller builds it (HappyView's release workflow does, from the
//! GitHub release), and hpy only checks its shape and publishes it.
//!
//! Publishing never moves a channel backwards. A channel that already points
//! at a newer version is left where it is and the version is published
//! without it, so re-running an old release's publish, or a backfill of past
//! releases, can't take a channel back in time.

use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use hpy_atproto::registry::Registry;
use hpy_plugin::project::{parse_author, parse_contact};
use serde_json::{Value, json};

use crate::ctx::Ctx;
use crate::failure::Failure;

/// The artifact type of a server release.
pub const ARTIFACT_TYPE: &str = "at.happyproto.server.release.v1";

#[derive(Subcommand)]
pub enum ReleaseCommand {
    /// Create or update a server project in the registry.
    Init(ReleaseInitArgs),
    /// Publish a server release from a prepared artifact.
    Publish(ReleasePublishArgs),
}

#[derive(Args)]
pub struct ReleaseInitArgs {
    /// The project name, its record key: lowercase letters, digits and hyphens.
    #[arg(long)]
    pub name: String,
    /// The name people see.
    #[arg(long)]
    pub display_name: String,
    /// One-line description.
    #[arg(long)]
    pub description: Option<String>,
    /// Author as `Name <email> (url)`; repeatable, at least one.
    #[arg(long = "author", value_name = "AUTHOR", required = true)]
    pub authors: Vec<String>,
    /// Security contact (email or URL); repeatable, at least one.
    #[arg(long = "security", value_name = "CONTACT", required = true)]
    pub security: Vec<String>,
    /// Keyword; repeatable.
    #[arg(long = "keyword", value_name = "KEYWORD")]
    pub keywords: Vec<String>,
    /// Check it against the registry's rules and write nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Args)]
pub struct ReleasePublishArgs {
    /// The project name.
    #[arg(long)]
    pub name: String,
    /// The version, semver without build metadata (e.g. 2.17.4 or 3.0.0-beta.12).
    #[arg(long)]
    pub version: String,
    /// A JSON file holding the at.happyproto.server.release.v1 artifact.
    #[arg(long, value_name = "FILE")]
    pub artifact: PathBuf,
    /// The channel to move to this version: latest, beta, alpha or v<major>. Omitted, no channel moves.
    #[arg(long)]
    pub track: Option<String>,
    /// The release notes' URL, linked from the version as its changelog.
    #[arg(long, value_name = "URL")]
    pub changelog_url: Option<String>,
    /// Move the channel even when it points at a newer version.
    #[arg(long)]
    pub allow_downgrade: bool,
    /// Check it against the registry's rules and write nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

pub async fn run(ctx: &Ctx, command: ReleaseCommand) -> Result<(), Failure> {
    match command {
        ReleaseCommand::Init(a) => init(ctx, a).await,
        ReleaseCommand::Publish(a) => publish(ctx, a).await,
    }
}

/// The `putProject` input for a server project.
fn project_input(args: &ReleaseInitArgs) -> Result<Value, Failure> {
    let authors = args
        .authors
        .iter()
        .map(|a| parse_author(a).map_err(|e| Failure::usage(format!("--author {a}: {e}"))))
        .collect::<Result<Vec<_>, _>>()?;
    let security = args
        .security
        .iter()
        .map(|c| parse_contact(c).map_err(|e| Failure::usage(format!("--security {c}: {e}"))))
        .collect::<Result<Vec<_>, _>>()?;
    let mut publication = json!({ "name": args.display_name });
    if let Some(d) = &args.description {
        publication["description"] = d.clone().into();
    }
    let mut project = json!({
        "kind": "server",
        "authors": authors,
        "security": security,
    });
    if !args.keywords.is_empty() {
        project["keywords"] = json!(args.keywords);
    }
    Ok(json!({
        "name": args.name,
        "publication": publication,
        "project": project,
    }))
}

async fn init(ctx: &Ctx, args: ReleaseInitArgs) -> Result<(), Failure> {
    let input = project_input(&args)?;
    let session = ctx.session()?;
    let registry = session.registry();
    if args.dry_run {
        registry.put_project(input.clone(), true).await?;
        ctx.out.done(
            &format!("{} is valid; nothing was written", args.name),
            json!({ "dryRun": true, "input": input }),
        );
        return Ok(());
    }
    ctx.out
        .status(&serde_json::to_string_pretty(&input).unwrap_or_default());
    if !ctx.prompter.confirm(
        &format!("Write the `{}` server project to your repo?", args.name),
        args.yes,
    )? {
        return Err(Failure::runtime("cancelled"));
    }
    let out = registry
        .put_project(input, false)
        .await?
        .ok_or_else(|| Failure::runtime("putProject answered something unreadable"))?;
    ctx.out.done(
        &format!(
            "{} {}",
            if out.created { "Created" } else { "Updated" },
            out.project.uri
        ),
        json!({ "created": out.created, "project": out.project.uri }),
    );
    Ok(())
}

/// The artifact in `path`, with its type filled in when it was left out.
fn read_artifact(path: &Path) -> Result<Value, Failure> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| Failure::usage(format!("cannot read {}: {e}", path.display())))?;
    let mut artifact: Value = serde_json::from_str(&text)
        .map_err(|e| Failure::usage(format!("{} is not JSON: {e}", path.display())))?;
    let Some(object) = artifact.as_object_mut() else {
        return Err(Failure::usage(format!(
            "{} must hold a JSON object",
            path.display()
        )));
    };
    match object.get("$type").and_then(Value::as_str) {
        None => {
            object.insert("$type".into(), ARTIFACT_TYPE.into());
        }
        Some(t) if t == ARTIFACT_TYPE => {}
        Some(t) => {
            return Err(Failure::usage(format!(
                "{} is a {t}, not an {ARTIFACT_TYPE}",
                path.display()
            )));
        }
    }
    Ok(artifact)
}

fn release_version(s: &str) -> Result<semver::Version, Failure> {
    let v = semver::Version::parse(s).map_err(|e| Failure::usage(format!("--version {s}: {e}")))?;
    if !v.build.is_empty() {
        return Err(Failure::usage(format!("--version {s}: no build metadata")));
    }
    Ok(v)
}

/// Whether moving `track` to `version` would take it back to an older
/// version than the one it points at now.
async fn would_go_back(
    registry: &dyn Registry,
    did: &str,
    name: &str,
    track: &str,
    version: &semver::Version,
) -> Result<Option<String>, Failure> {
    let Some(current) = registry.resolve_channel(did, name, track).await? else {
        return Ok(None);
    };
    Ok(semver::Version::parse(&current.version)
        .ok()
        .filter(|c| c > version)
        .map(|_| current.version))
}

/// The `publishRelease` input.
fn release_input(args: &ReleasePublishArgs, artifact: Value, track: Option<&str>) -> Value {
    let mut input = json!({
        "name": args.name,
        "version": args.version,
        "artifact": artifact,
    });
    if let Some(t) = track {
        input["track"] = t.into();
    }
    if let Some(url) = &args.changelog_url {
        input["changelogUrl"] = url.clone().into();
    }
    input
}

async fn publish(ctx: &Ctx, args: ReleasePublishArgs) -> Result<(), Failure> {
    let version = release_version(&args.version)?;
    let artifact = read_artifact(&args.artifact)?;
    let session = ctx.session()?;
    let registry = session.registry();

    let mut track = args.track.clone().filter(|t| !t.is_empty());
    if let Some(t) = track.as_deref()
        && !args.allow_downgrade
        && let Some(newer) =
            would_go_back(&registry, session.repo.did(), &args.name, t, &version).await?
    {
        ctx.out.status(&format!(
            "The {t} channel points at {newer}, which is newer than {}; publishing without moving it",
            args.version
        ));
        track = None;
    }

    let input = release_input(&args, artifact, track.as_deref());
    if args.dry_run {
        registry.publish_release(input.clone(), true).await?;
        ctx.out.done(
            &format!(
                "{} {} is valid; nothing was written\n{}",
                args.name,
                args.version,
                serde_json::to_string_pretty(&input).unwrap_or_default()
            ),
            json!({ "dryRun": true, "input": input }),
        );
        return Ok(());
    }

    let channel_note = track
        .as_deref()
        .map(|t| format!(" on {t}"))
        .unwrap_or_default();
    if !ctx.prompter.confirm(
        &format!("Publish {} {}{channel_note}?", args.name, args.version),
        args.yes,
    )? {
        return Err(Failure::runtime("cancelled"));
    }
    let out = registry
        .publish_release(input, false)
        .await?
        .ok_or_else(|| Failure::runtime("publishRelease answered something unreadable"))?;
    if out.resumed {
        ctx.out.status(&format!(
            "{} {} was already published",
            args.name, args.version
        ));
    }
    ctx.out.done(
        &format!("{} {} published{channel_note}", args.name, args.version),
        json!({
            "published": true,
            "resumed": out.resumed,
            "uri": out.version.uri,
            "track": track,
            "channel": out.channel.map(|c| c.uri),
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_args() -> ReleaseInitArgs {
        ReleaseInitArgs {
            name: "happyview".into(),
            display_name: "HappyView".into(),
            description: Some("An AT Protocol AppView".into()),
            authors: vec!["HappyProto <hello@happyproto.at> (https://happyproto.at)".into()],
            security: vec!["security@happyproto.at".into()],
            keywords: vec![],
            dry_run: false,
            yes: true,
        }
    }

    #[test]
    fn a_server_project_has_kind_and_no_plugin_type() {
        let input = project_input(&init_args()).unwrap();
        assert_eq!(input["name"], "happyview");
        assert_eq!(input["project"]["kind"], "server");
        assert!(input["project"].get("pluginType").is_none());
        assert_eq!(input["project"]["authors"][0]["name"], "HappyProto");
        assert_eq!(input["publication"]["name"], "HappyView");
    }

    #[test]
    fn the_artifact_type_is_filled_in_and_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, r#"{"releaseUrl":"https://example.com"}"#).unwrap();
        assert_eq!(read_artifact(&path).unwrap()["$type"], ARTIFACT_TYPE);

        std::fs::write(&path, r#"{"$type":"at.happyproto.plugin.v1"}"#).unwrap();
        assert!(read_artifact(&path).is_err());
        std::fs::write(&path, "[]").unwrap();
        assert!(read_artifact(&path).is_err());
    }

    #[test]
    fn versions_take_no_build_metadata() {
        assert!(release_version("2.17.4").is_ok());
        assert!(release_version("3.0.0-beta.12").is_ok());
        assert!(release_version("1.0.0+build.1").is_err());
        assert!(release_version("v1.0.0").is_err());
    }

    fn publish_args(track: Option<&str>, changelog: Option<&str>) -> ReleasePublishArgs {
        ReleasePublishArgs {
            name: "happyview".into(),
            version: "2.17.4".into(),
            artifact: PathBuf::from("a.json"),
            track: track.map(str::to_owned),
            changelog_url: changelog.map(str::to_owned),
            allow_downgrade: false,
            dry_run: false,
            yes: true,
        }
    }

    #[tokio::test]
    async fn a_channel_never_moves_back() {
        let registry = crate::testing::FakeRegistry::default();
        registry
            .channels
            .lock()
            .unwrap()
            .insert("alpha".into(), "3.0.0-alpha.10".into());
        let did = crate::testing::DID;
        let older = semver::Version::parse("3.0.0-alpha.9").unwrap();
        let newer = semver::Version::parse("3.0.0-alpha.11").unwrap();
        assert_eq!(
            would_go_back(&registry, did, "happyview", "alpha", &older)
                .await
                .unwrap(),
            Some("3.0.0-alpha.10".into())
        );
        assert_eq!(
            would_go_back(&registry, did, "happyview", "alpha", &newer)
                .await
                .unwrap(),
            None
        );
        // A channel that doesn't exist yet is never "back".
        assert_eq!(
            would_go_back(&registry, did, "happyview", "beta", &older)
                .await
                .unwrap(),
            None
        );
    }

    #[test]
    fn a_release_input_carries_only_what_was_given() {
        let args = publish_args(None, None);
        let input = release_input(&args, json!({}), None);
        assert!(input.get("track").is_none());
        assert!(input.get("changelogUrl").is_none());

        let args = publish_args(
            Some("v2"),
            Some("https://github.com/x/y/releases/tag/v2.17.4"),
        );
        let input = release_input(&args, json!({}), Some("v2"));
        assert_eq!(input["track"], "v2");
        assert_eq!(
            input["changelogUrl"],
            "https://github.com/x/y/releases/tag/v2.17.4"
        );
    }
}
