//! A plugin's project as a whole: `[project]` in hpy.toml, and the project,
//! publication and sidecar records `putProject` writes from it.

use std::path::Path;

use hpy_atproto::session::Session;
use hpy_atproto::{ProjectView, Registry, Repo};
use hpy_plugin::PUBLICATION_NSID;
use hpy_plugin::config::{self, HpyToml, ProjectConfig};
use hpy_plugin::manifest::Manifest;
use hpy_plugin::project::{
    Author, Contact, ProjectDetails, PublicationInput, parse_author, parse_contact,
};
use hpy_plugin::validate::is_project_name;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cli::{NameArg, ProfileEditArgs, ProfileFields, ProfileInitArgs};
use crate::commands::publish::Blob;
use crate::ctx::Ctx;
use crate::failure::Failure;

/// The project name: `--name`, else hpy.toml's `[project] name`, else the
/// manifest's `id`.
pub(crate) fn resolve_name(dir: &Path, flag: Option<String>) -> Result<String, Failure> {
    let name = match flag {
        Some(s) => s,
        None => {
            let manifest = Manifest::load(dir).ok();
            let toml = HpyToml::load(dir)?.unwrap_or_default();
            toml.name(manifest.as_ref()).ok_or_else(|| {
                Failure::usage("no project name: pass --name, or run in a directory with manifest.json or hpy.toml")
            })?
        }
    };
    if !is_project_name(&name) {
        return Err(Failure::usage(format!(
            "`{name}` is not a project name: 1 to 64 lowercase letters, digits and interior `-`"
        )));
    }
    Ok(name)
}

fn non_empty(s: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        Err("required".into())
    } else {
        Ok(())
    }
}

fn check_name(s: &str) -> Result<(), String> {
    if is_project_name(s) {
        Ok(())
    } else {
        Err("1 to 64 lowercase letters, digits and interior `-`".into())
    }
}

/// The icon `cfg` names, read and checked, for upload.
fn read_icon(dir: &Path, cfg: &ProjectConfig) -> Result<Option<Blob>, Failure> {
    let Some(icon) = &cfg.icon else {
        return Ok(None);
    };
    let bytes = std::fs::read(dir.join(&icon.path))
        .map_err(|e| Failure::usage(format!("project.icon: cannot read `{}`: {e}", icon.path)))?;
    let info = hpy_plugin::artifact::inspect_image(&bytes)
        .map_err(|e| Failure::usage(format!("project.icon: `{}` {e}", icon.path)))?;
    Ok(Some(Blob::new(bytes, info.mime, "icon")))
}

/// Asks the gateway to check the project, uploads its icon, then writes it.
/// Answers the project record's URI and whether it was new.
pub(crate) async fn put_project(
    registry: &dyn Registry,
    repo: &dyn Repo,
    details: &ProjectDetails,
    icon: Option<&Blob>,
    swap_cid: Option<&str>,
) -> Result<(String, bool), Failure> {
    let mut input = details.to_input();
    if let Some(cid) = swap_cid {
        input["swapCid"] = cid.into();
    }
    registry
        .put_project(input.clone(), true)
        .await
        .map_err(put_error)?;
    if let Some(icon) = icon {
        let stored = repo.upload_blob(icon.bytes.clone(), icon.mime).await?;
        let cid = stored["ref"]["$link"].as_str().unwrap_or_default();
        if cid != icon.cid {
            return Err(Failure::runtime(format!(
                "your PDS stored the icon as {cid}, but its bytes hash to {}; nothing was written",
                icon.cid
            )));
        }
    }
    let written = registry
        .put_project(input, false)
        .await
        .map_err(put_error)?
        .ok_or_else(|| Failure::runtime("putProject answered something unreadable"))?;
    Ok((written.project.uri, written.created))
}

/// A swap conflict means someone changed the project mid-edit; say so.
pub(crate) fn put_error(e: hpy_atproto::Error) -> Failure {
    let swap = match &e {
        hpy_atproto::Error::Xrpc { name, .. } => name.contains("InvalidSwap"),
        e => e.registry_name() == Some("InvalidSwap"),
    };
    if swap {
        return Failure::runtime(
            "the project changed in your repo while you were editing; run the edit again",
        );
    }
    Failure::from(e)
}

pub async fn init(ctx: &Ctx, args: ProfileInitArgs) -> Result<(), Failure> {
    let manifest = Manifest::load(&ctx.dir).ok();
    let existing = HpyToml::load(&ctx.dir)?
        .and_then(|t| t.project)
        .unwrap_or_default();
    let p = &ctx.prompter;
    let f = args.fields;

    let default_name = existing
        .name
        .clone()
        .or(manifest.as_ref().map(|m| m.id.clone()));
    let name = p.required(
        "--name",
        "Project name:",
        args.name.name,
        default_name,
        check_name,
    )?;
    let display_name = p.required(
        "--display-name",
        "Display name:",
        f.display_name,
        existing
            .display_name
            .clone()
            .or(manifest.as_ref().and_then(|m| m.name.clone())),
        non_empty,
    )?;
    let description = p.optional(
        "One-line description:",
        f.description,
        existing
            .description
            .clone()
            .or(manifest.as_ref().and_then(|m| m.description.clone())),
    )?;
    let authors = p.list(
        "--author",
        "Author (Name <email> (url)):",
        f.authors,
        existing.authors.clone(),
        parse_author,
        1,
    )?;
    let security = p.list(
        "--security",
        "Security contact (email or URL):",
        f.security,
        existing.security.clone(),
        parse_contact,
        1,
    )?;
    let keywords = if !f.keywords.is_empty() {
        f.keywords
    } else if p.is_interactive() && existing.keywords.is_empty() {
        p.optional("Keywords (comma-separated):", None, None)?
            .map(|s| {
                s.split(',')
                    .map(|k| k.trim().to_string())
                    .filter(|k| !k.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        existing.keywords.clone()
    };

    // The name is written only when it differs from what hpy.toml would
    // fall back to, so a renamed manifest id is not shadowed by a copy.
    let fallback = manifest.as_ref().map(|m| m.id.as_str());
    let cfg = ProjectConfig {
        name: (fallback != Some(name.as_str()) || existing.name.is_some()).then(|| name.clone()),
        display_name: Some(display_name),
        description,
        icon: existing.icon.clone(),
        keywords,
        authors,
        security,
    };
    let icon = read_icon(&ctx.dir, &cfg)?;
    let details = cfg.to_details(
        &name,
        manifest.as_ref(),
        icon.as_ref()
            .map(|b| hpy_plugin::artifact::predicted_blob(&b.bytes, b.mime)),
    );
    let problems = details.problems();
    if !problems.is_empty() {
        return Err(Failure::problems("the project is not valid:", &problems));
    }
    config::write_project(&ctx.dir, &cfg).map_err(Failure::runtime)?;
    ctx.out.status(&format!(
        "Wrote {}",
        ctx.dir.join(config::FILE_NAME).display()
    ));

    if args.local_only {
        ctx.out.done(
            "",
            json!({ "name": name, "created": false, "localOnly": true }),
        );
        return Ok(());
    }
    let session = ctx.session()?;
    let registry = session.registry();
    if registry
        .get_project(session.repo.did(), &name)
        .await?
        .is_some()
    {
        return Err(Failure::usage(format!(
            "the registry already has a `{name}` project of yours; use `hpy registry plugin edit` or `hpy registry plugin pull`"
        )));
    }
    if !ctx
        .prompter
        .confirm(&format!("Create the `{name}` project?"), args.yes)?
    {
        return Err(Failure::runtime("cancelled"));
    }
    let (uri, created) = put_project(
        &registry,
        session.repo.as_ref(),
        &details,
        icon.as_ref(),
        None,
    )
    .await?;
    ctx.out.done(
        &format!("Created {uri}"),
        json!({ "name": name, "uri": uri, "created": created }),
    );
    Ok(())
}

/// The parts of a project an edit can change, as the editor shows them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Editable {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub authors: Vec<Author>,
    #[serde(default)]
    pub security: Vec<Contact>,
}

impl Editable {
    pub fn from_view(view: &ProjectView) -> Result<Editable, Failure> {
        fn read<T: serde::de::DeserializeOwned>(
            view: &ProjectView,
            what: &str,
            v: &[Value],
        ) -> Result<Vec<T>, Failure> {
            serde_json::from_value(Value::Array(v.to_vec())).map_err(|e| {
                Failure::runtime(format!(
                    "the registry's {what} for `{}` are unreadable: {e}",
                    view.name
                ))
            })
        }
        Ok(Editable {
            display_name: view.publication.name.clone(),
            description: view.publication.description.clone(),
            keywords: view.keywords.clone(),
            authors: read(view, "authors", &view.authors)?,
            security: read(view, "security contacts", &view.security)?,
        })
    }

    pub fn to_details(&self, name: &str, plugin_type: &str, icon: Option<Value>) -> ProjectDetails {
        ProjectDetails {
            name: name.into(),
            publication: PublicationInput {
                name: self.display_name.clone(),
                description: self.description.clone(),
                icon,
            },
            plugin_type: plugin_type.into(),
            keywords: self.keywords.clone(),
            authors: self.authors.clone(),
            security: self.security.clone(),
        }
    }
}

fn summary(view: &ProjectView) -> String {
    let mut lines = vec![format!("{} ({})", view.publication.name, view.name)];
    if let Some(d) = &view.publication.description {
        lines.push(d.clone());
    }
    lines.push(format!("type:     {}", view.plugin_type));
    if let Ok(e) = Editable::from_view(view) {
        lines.push(format!(
            "authors:  {}",
            e.authors
                .iter()
                .map(Author::display)
                .collect::<Vec<_>>()
                .join(", ")
        ));
        lines.push(format!(
            "security: {}",
            e.security
                .iter()
                .map(Contact::display)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !view.keywords.is_empty() {
        lines.push(format!("keywords: {}", view.keywords.join(", ")));
    }
    for (channel, head) in &view.channels {
        lines.push(format!("{channel:<9} {}", head.version));
    }
    lines.push(view.uri.clone());
    lines.join("\n")
}

struct Fetched {
    name: String,
    session: Session,
    view: ProjectView,
}

async fn fetch(ctx: &Ctx, name_flag: Option<String>) -> Result<Fetched, Failure> {
    let name = resolve_name(&ctx.dir, name_flag)?;
    let session = ctx.session()?;
    let view = session
        .registry()
        .get_project(session.repo.did(), &name)
        .await?
        .ok_or_else(|| {
            Failure::usage(format!(
                "the registry has no `{name}` project of yours; run `hpy registry plugin init`"
            ))
        })?;
    Ok(Fetched {
        name,
        session,
        view,
    })
}

pub async fn show(ctx: &Ctx, args: NameArg) -> Result<(), Failure> {
    let f = fetch(ctx, args.name).await?;
    let json = serde_json::to_value(&f.view).map_err(Failure::runtime)?;
    ctx.out.done(&summary(&f.view), json);
    Ok(())
}

pub(crate) fn apply_edits(
    p: &mut Editable,
    f: &ProfileFields,
    remove_keywords: &[String],
) -> Result<(), Failure> {
    if let Some(n) = &f.display_name {
        p.display_name = n.clone();
    }
    if let Some(d) = &f.description {
        p.description = Some(d.clone());
    }
    for a in &f.authors {
        p.authors
            .push(parse_author(a).map_err(|e| Failure::usage(format!("--author: {e}")))?);
    }
    for c in &f.security {
        p.security
            .push(parse_contact(c).map_err(|e| Failure::usage(format!("--security: {e}")))?);
    }
    p.keywords.retain(|k| !remove_keywords.contains(k));
    for k in &f.keywords {
        if !p.keywords.contains(k) {
            p.keywords.push(k.clone());
        }
    }
    Ok(())
}

pub(crate) fn to_editable(name: &str, p: &Editable) -> Result<String, Failure> {
    let toml = toml::to_string_pretty(p).map_err(Failure::runtime)?;
    Ok(format!(
        "# Editing the `{name}` project. Save and close to publish the change;\n\
         # empty the file to cancel.\n\n{toml}"
    ))
}

pub(crate) fn from_editable(text: &str) -> Result<Editable, String> {
    toml::from_str(text).map_err(|e| e.to_string())
}

fn run_editor(path: &Path) -> Result<(), Failure> {
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "notepad".into()
            } else {
                "vi".into()
            }
        });
    let status = if cfg!(windows) {
        std::process::Command::new(&editor).arg(path).status()
    } else {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("{editor} \"$1\""))
            .arg("sh")
            .arg(path)
            .status()
    }
    .map_err(|e| Failure::runtime(format!("could not start `{editor}`: {e}")))?;
    if !status.success() {
        return Err(Failure::runtime(format!("`{editor}` exited with {status}")));
    }
    Ok(())
}

/// Opens the project in `$VISUAL`/`$EDITOR` until it is valid or abandoned.
fn edit_in_editor(ctx: &Ctx, view: &ProjectView, editable: &Editable) -> Result<Editable, Failure> {
    let path = std::env::temp_dir().join(format!(
        "hpy-project-{}-{}.toml",
        view.name,
        std::process::id()
    ));
    std::fs::write(&path, to_editable(&view.name, editable)?).map_err(Failure::runtime)?;
    let result = loop {
        if let Err(e) = run_editor(&path) {
            break Err(e);
        }
        let text = std::fs::read_to_string(&path).map_err(Failure::runtime)?;
        if text
            .lines()
            .all(|l| l.trim().is_empty() || l.trim_start().starts_with('#'))
        {
            break Err(Failure::runtime("cancelled"));
        }
        let problems = match from_editable(&text) {
            Ok(e) => {
                let problems = e.to_details(&view.name, &view.plugin_type, None).problems();
                if problems.is_empty() {
                    break Ok(e);
                }
                problems.iter().map(|p| p.to_string()).collect::<Vec<_>>()
            }
            Err(e) => vec![e],
        };
        for p in &problems {
            eprintln!("  • {p}");
        }
        match ctx
            .prompter
            .confirm("The project is not valid. Edit again?", false)
        {
            Ok(true) => continue,
            Ok(false) => break Err(Failure::runtime("cancelled")),
            Err(e) => break Err(e),
        }
    };
    let _ = std::fs::remove_file(&path);
    result
}

/// The publication's icon blob as the repo holds it, so an edit that does
/// not touch the icon keeps it.
pub(crate) async fn current_icon(repo: &dyn Repo, name: &str) -> Result<Option<Value>, Failure> {
    Ok(repo
        .get_record(PUBLICATION_NSID, name)
        .await?
        .map(|r| r.value["icon"].clone())
        .filter(|icon| !icon.is_null()))
}

pub async fn edit(ctx: &Ctx, args: ProfileEditArgs) -> Result<(), Failure> {
    let Fetched {
        name,
        session,
        view,
    } = fetch(ctx, args.name.name).await?;
    let mut editable = Editable::from_view(&view)?;
    let f = &args.fields;
    let has_flags = f.display_name.is_some()
        || f.description.is_some()
        || !f.authors.is_empty()
        || !f.security.is_empty()
        || !f.keywords.is_empty()
        || !args.remove_keywords.is_empty();
    if has_flags {
        apply_edits(&mut editable, f, &args.remove_keywords)?;
    } else if ctx.prompter.is_interactive() {
        editable = edit_in_editor(ctx, &view, &editable)?;
    } else {
        return Err(Failure::usage(
            "pass field flags (e.g. --display-name, --author) to edit without a terminal",
        ));
    }
    let uri = apply_edit(
        &ctx.dir,
        &session.registry(),
        session.repo.as_ref(),
        &view,
        &editable,
    )
    .await?;
    ctx.out.done(
        &format!("Updated {uri}"),
        json!({ "name": name, "uri": uri }),
    );
    Ok(())
}

/// Writes an edit to the registry, keeping the publication's icon, and to
/// `[project]` in hpy.toml when there is one, so the next publish does not
/// put the old values back. Answers the project's URI.
pub(crate) async fn apply_edit(
    dir: &Path,
    registry: &dyn Registry,
    repo: &dyn Repo,
    view: &ProjectView,
    editable: &Editable,
) -> Result<String, Failure> {
    let icon = current_icon(repo, &view.name).await?;
    let details = editable.to_details(&view.name, &view.plugin_type, icon);
    let problems = details.problems();
    if !problems.is_empty() {
        return Err(Failure::problems(
            "the edited project is not valid:",
            &problems,
        ));
    }
    // The gateway swaps on the sidecar, which holds the fields an edit
    // changes besides the publication's.
    let (uri, _) = put_project(registry, repo, &details, None, view.sidecar.cid.as_deref()).await?;
    // Only the hpy.toml this project is described by takes the edit; a
    // `--name` for another project must leave this directory's file alone.
    let toml = HpyToml::load(dir)?;
    let manifest = Manifest::load(dir).ok();
    let belongs = toml
        .as_ref()
        .is_some_and(|t| t.name(manifest.as_ref()).as_deref() == Some(view.name.as_str()));
    if belongs && let Some(existing) = toml.and_then(|t| t.project) {
        let cfg = ProjectConfig {
            display_name: Some(editable.display_name.clone()),
            description: editable.description.clone(),
            keywords: editable.keywords.clone(),
            authors: editable.authors.clone(),
            security: editable.security.clone(),
            ..existing
        };
        config::write_project(dir, &cfg).map_err(Failure::runtime)?;
    }
    Ok(uri)
}

/// `[project]` as the registry has it, keeping the icon path hpy.toml
/// already names, since the registry holds the icon's bytes, not its path.
pub(crate) fn pulled_config(
    view: &ProjectView,
    existing: Option<&ProjectConfig>,
) -> Result<ProjectConfig, Failure> {
    let e = Editable::from_view(view)?;
    Ok(ProjectConfig {
        name: Some(view.name.clone()),
        display_name: Some(e.display_name),
        description: e.description,
        icon: existing.and_then(|c| c.icon.clone()),
        keywords: e.keywords,
        authors: e.authors,
        security: e.security,
    })
}

pub async fn pull(ctx: &Ctx, args: NameArg) -> Result<(), Failure> {
    let Fetched { name, view, .. } = fetch(ctx, args.name).await?;
    let existing = HpyToml::load(&ctx.dir)?.and_then(|t| t.project);
    let cfg = pulled_config(&view, existing.as_ref())?;
    config::write_project(&ctx.dir, &cfg).map_err(Failure::runtime)?;
    let path = ctx.dir.join(config::FILE_NAME);
    ctx.out.done(
        &format!("Wrote the `{name}` project to {}", path.display()),
        json!({ "name": name, "path": path }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::ProfileFields;
    use crate::testing::{DID, FakeRegistry, FakeRepo, project_view};

    fn editable() -> Editable {
        Editable {
            display_name: "Mine".into(),
            description: None,
            keywords: vec![],
            authors: vec![Author {
                name: "A".into(),
                ..Default::default()
            }],
            security: vec![Contact {
                email: Some("s@x.io".into()),
                url: None,
            }],
        }
    }

    #[tokio::test]
    async fn put_project_validates_uploads_the_icon_then_writes() {
        let (reg, repo) = (FakeRegistry::default(), FakeRepo::default());
        let icon = Blob::new(b"icon bytes".to_vec(), "image/png", "icon");
        let details = editable().to_details(
            "my-plugin",
            "library",
            Some(hpy_plugin::artifact::predicted_blob(&icon.bytes, icon.mime)),
        );
        let (uri, created) = put_project(&reg, &repo, &details, Some(&icon), None)
            .await
            .unwrap();
        assert!(created);
        assert_eq!(
            uri,
            "at://did:plc:testuser/software.release.project/my-plugin"
        );
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("project", true), ("project", false)]
        );
        assert_eq!(repo.blobs.lock().unwrap().len(), 1);
        assert_eq!(
            reg.put_projects.lock().unwrap()[0]["publication"]["name"],
            "Mine"
        );
    }

    #[tokio::test]
    async fn an_edit_sends_the_cid_it_read_and_a_conflict_says_so() {
        let reg = FakeRegistry::default();
        let details = editable().to_details("p", "library", None);
        put_project(&reg, &FakeRepo::default(), &details, None, Some("bafyold"))
            .await
            .unwrap();
        assert_eq!(reg.put_projects.lock().unwrap()[0]["swapCid"], "bafyold");

        let conflicted = FakeRegistry {
            reject_project: Some(("InvalidSwap".into(), "swap failed".into())),
            ..Default::default()
        };
        let err = put_project(&conflicted, &FakeRepo::default(), &details, None, Some("x"))
            .await
            .unwrap_err();
        assert!(
            err.report.to_string().contains("changed in your repo"),
            "{}",
            err.report
        );
        let f = put_error(hpy_atproto::Error::SessionExpired);
        assert_eq!(f.code, 3);
    }

    #[test]
    fn apply_edits_adds_and_replaces() {
        let mut p = editable();
        p.keywords = vec!["old".into(), "keep".into()];
        let fields = ProfileFields {
            display_name: Some("New".into()),
            authors: vec!["B <b@x.io>".into()],
            keywords: vec!["new".into()],
            ..Default::default()
        };
        apply_edits(&mut p, &fields, &["old".to_string()]).unwrap();
        assert_eq!(p.display_name, "New");
        assert_eq!(p.authors.len(), 2);
        assert_eq!(p.keywords, vec!["keep".to_string(), "new".to_string()]);
    }

    async fn edit_in(dir: &Path, name: &str) {
        let (repo, reg) = (
            crate::testing::FakeRepo::default(),
            crate::testing::FakeRegistry::default(),
        );
        let view = project_view(DID, name, "library");
        let mut e = Editable::from_view(&view).unwrap();
        e.display_name = "Edited".into();
        e.authors = vec![parse_author("Ada <a@x.io>").unwrap()];
        e.security = vec![parse_contact("security@x.io").unwrap()];
        apply_edit(dir, &reg, &repo, &view, &e).await.unwrap();
    }

    #[tokio::test]
    async fn an_edit_is_written_back_only_to_its_own_hpy_toml() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hpy.toml");
        let other = "[project]\nname = \"other\"\ndisplay_name = \"Other\"\n";
        std::fs::write(&file, other).unwrap();
        edit_in(dir.path(), "my-plugin").await;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), other);
        edit_in(dir.path(), "other").await;
        assert!(
            std::fs::read_to_string(&file)
                .unwrap()
                .contains("display_name = \"Edited\"")
        );
    }

    #[tokio::test]
    async fn an_edit_matches_a_project_named_by_the_manifest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("manifest.json"), r#"{"id":"my-plugin"}"#).unwrap();
        std::fs::write(
            dir.path().join("hpy.toml"),
            "[project]\ndisplay_name = \"Old\"\n",
        )
        .unwrap();
        edit_in(dir.path(), "my-plugin").await;
        let text = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        assert!(text.contains("display_name = \"Edited\""), "{text}");
    }

    #[test]
    fn name_resolution_order() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_name(dir.path(), None).is_err());
        std::fs::write(
            dir.path().join("manifest.json"),
            r#"{"id":"from-manifest"}"#,
        )
        .unwrap();
        assert_eq!(resolve_name(dir.path(), None).unwrap(), "from-manifest");
        std::fs::write(
            dir.path().join("hpy.toml"),
            "[project]\nname = \"from-toml\"\n",
        )
        .unwrap();
        assert_eq!(resolve_name(dir.path(), None).unwrap(), "from-toml");
        assert_eq!(
            resolve_name(dir.path(), Some("flag".into())).unwrap(),
            "flag"
        );
        assert!(resolve_name(dir.path(), Some("bad:name".into())).is_err());
    }

    #[test]
    fn editor_toml_roundtrip() {
        let p = editable();
        let text = to_editable("x", &p).unwrap();
        assert_eq!(from_editable(&text).unwrap(), p);
        assert!(from_editable("display_name = 3").is_err());
    }

    #[test]
    fn a_pull_writes_the_registrys_project_and_keeps_the_icon_path() {
        let mut view = project_view(DID, "my-plugin", "library");
        view.publication.name = "Mine".into();
        view.publication.description = Some("Does things.".into());
        view.keywords = vec!["k".into()];
        view.authors = vec![json!({ "name": "Ada", "email": "a@x.io" })];
        view.security = vec![json!({ "url": "https://x.io/security" })];
        let existing = ProjectConfig {
            icon: Some(hpy_plugin::config::ImageConfig {
                path: "icon.png".into(),
                alt: None,
            }),
            ..Default::default()
        };
        let cfg = pulled_config(&view, Some(&existing)).unwrap();
        assert_eq!(cfg.name.as_deref(), Some("my-plugin"));
        assert_eq!(cfg.display_name.as_deref(), Some("Mine"));
        assert_eq!(cfg.description.as_deref(), Some("Does things."));
        assert_eq!(cfg.icon.unwrap().path, "icon.png");
        assert_eq!(cfg.authors[0].email.as_deref(), Some("a@x.io"));
        assert_eq!(
            cfg.security[0].url.as_deref(),
            Some("https://x.io/security")
        );
        assert_eq!(cfg.keywords, ["k"]);
    }
}
