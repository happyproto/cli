use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use hpy_atproto::{ProjectView, Registry, Repo, scope};
use hpy_plugin::artifact::{
    Image, MANIFEST_MIME, PluginArtifact, WASM_MIME, inspect_image, predicted_blob, wasm_problem,
};
use hpy_plugin::checksum::raw_cid;
use hpy_plugin::config::{HpyToml, ImageConfig};
use hpy_plugin::locate::locate_wasm;
use hpy_plugin::manifest::Manifest;
use hpy_plugin::project::{Author, Contact, ProjectDetails};
use hpy_plugin::validate::{is_project_name, range_problem, requires_key_problem, version_problem};
use hpy_plugin::{Problem, TRACKS};
use serde_json::{Value, json};

use crate::cli::PublishArgs;
use crate::commands::profile::current_icon;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub struct PrepareOptions {
    pub wasm: Option<PathBuf>,
    pub version: Option<String>,
    pub no_build: bool,
}

/// Bytes to upload, and the CID the artifact already names them by.
#[derive(Debug, Clone)]
pub struct Blob {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub cid: String,
    /// What it is, for progress and errors.
    pub what: String,
}

impl Blob {
    pub fn new(bytes: Vec<u8>, mime: &'static str, what: impl Into<String>) -> Blob {
        Blob {
            cid: raw_cid(&bytes),
            bytes,
            mime,
            what: what.into(),
        }
    }
}

pub struct Prepared {
    pub name: String,
    pub version: String,
    /// What `putProject` would send. A project the registry already has
    /// needs no `[project]` table, so its absence is kept for later rather
    /// than refused here.
    pub details: Result<ProjectDetails, Vec<Problem>>,
    /// The icon `details` names, uploaded only when the publication's differs.
    pub icon: Option<Blob>,
    /// Built from blob refs predicted from the bytes, so a dry run shows
    /// exactly what would be published and each upload can be checked.
    pub artifact: PluginArtifact,
    /// Every blob the artifact names: module, manifest, banner, screenshots.
    pub blobs: Vec<Blob>,
    /// This version's entry in the `[release] changelog` file.
    pub changelog: Option<String>,
    pub wasm_path: PathBuf,
}

pub enum Outcome {
    /// `{ dryRun, project, artifact }`.
    DryRun(Value),
    Published(Published),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Published {
    pub uri: String,
    pub cid: String,
    pub created_project: bool,
    /// The gateway finished a version an earlier attempt left half-written.
    pub resumed: bool,
    /// This run sent a blob to the PDS, so it did some of the work itself.
    pub uploaded: bool,
}

impl Published {
    /// The shape `--json` prints, which the plugin-publish action reads.
    pub fn to_json(&self, availability: Option<String>) -> Value {
        json!({
            "uri": self.uri,
            "cid": self.cid,
            "createdProject": self.created_project,
            "resumed": self.resumed,
            "availability": availability,
        })
    }
}

pub trait Ui {
    fn warn(&self, msg: &str);
    fn progress(&self, msg: &str);
    fn confirm(&self, summary: &str) -> Result<bool, Failure>;
}

fn load_image(
    dir: &Path,
    cfg: &ImageConfig,
    path: &str,
    problems: &mut Vec<Problem>,
) -> Option<(Image, Blob)> {
    let bytes = match std::fs::read(dir.join(&cfg.path)) {
        Ok(b) => b,
        Err(e) => {
            problems.push(Problem::new(
                path,
                format!("cannot read `{}`: {e}", cfg.path),
            ));
            return None;
        }
    };
    match inspect_image(&bytes) {
        Ok(info) => {
            let image = Image {
                blob: predicted_blob(&bytes, info.mime),
                width: info.width,
                height: info.height,
                alt: cfg.alt.clone(),
            };
            Some((image, Blob::new(bytes, info.mime, path)))
        }
        Err(e) => {
            problems.push(Problem::new(path, format!("`{}` {e}", cfg.path)));
            None
        }
    }
}

/// Reads and validates everything locally. Every problem is reported at once.
pub fn prepare(
    dir: &Path,
    opts: &PrepareOptions,
    build: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<Prepared, Failure> {
    let manifest = Manifest::load(dir)?;
    // The bytes, not the parse: a release serves the file the author wrote.
    let manifest_json = std::fs::read(dir.join("manifest.json"))
        .map_err(|e| Failure::runtime(format!("could not read manifest.json: {e}")))?;
    let toml = HpyToml::load(dir)?.unwrap_or_default();
    let release_cfg = toml.release.clone().unwrap_or_default();
    let mut problems = manifest.problems();

    let name = toml.name(Some(&manifest)).unwrap_or_default();
    if !is_project_name(&name) {
        problems.push(Problem::new(
            "name",
            format!("`{name}` must be 1 to 64 lowercase letters, digits and interior `-`"),
        ));
    }
    let version = match opts.version.clone().or(manifest.version.clone()) {
        Some(v) => {
            if let Some(p) = version_problem(&v) {
                problems.push(Problem::new("version", p));
            }
            v
        }
        None => {
            problems.push(Problem::new(
                "version",
                "none given: pass --version or set `version` in manifest.json",
            ));
            String::new()
        }
    };
    // Checked with the rest of hpy.toml, so one run reports them alongside
    // every other problem rather than after a build.
    for (key, range) in &release_cfg.requires {
        let path = format!("release.requires[{key:?}]");
        if let Some(p) = requires_key_problem(key) {
            problems.push(Problem::new(&path, p));
        }
        if let Some(p) = range_problem(range) {
            problems.push(Problem::new(&path, p));
        }
    }
    let (sections, section_problems) = release_cfg.sections(dir);
    problems.extend(section_problems);
    let changelog = match release_cfg.changelog(dir, &version) {
        Ok(c) => c,
        Err(p) => {
            problems.push(p);
            None
        }
    };

    let mut blobs = Vec::new();
    let a = &release_cfg.artifacts;
    let banner = a
        .banner
        .as_ref()
        .and_then(|c| load_image(dir, c, "release.artifacts.banner", &mut problems));
    let screenshots: Vec<(Image, Blob)> = a
        .screenshots
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            load_image(
                dir,
                c,
                &format!("release.artifacts.screenshots[{i}]"),
                &mut problems,
            )
        })
        .collect();
    let project_cfg = toml.project.clone();
    let icon = project_cfg
        .as_ref()
        .and_then(|p| p.icon.as_ref())
        .and_then(|c| load_image(dir, c, "project.icon", &mut problems))
        .map(|(_, blob)| blob);

    if !problems.is_empty() {
        return Err(Failure::problems("cannot publish:", &problems));
    }

    let build_cfg = toml.build.clone().unwrap_or_default();
    if let (Some(cmd), false) = (&build_cfg.command, opts.no_build) {
        build(cmd).map_err(|e| Failure::runtime(format!("build command `{cmd}` failed: {e}")))?;
    }
    let wasm_path = locate_wasm(
        dir,
        opts.wasm.as_deref(),
        build_cfg.wasm.as_deref(),
        &manifest,
    )
    .map_err(Failure::usage)?;
    let wasm = std::fs::read(&wasm_path)
        .map_err(|e| Failure::runtime(format!("cannot read {}: {e}", wasm_path.display())))?;
    if let Some(p) = wasm_problem(&wasm) {
        return Err(Failure::usage(format!("{} {p}", wasm_path.display())));
    }

    let mut artifact = PluginArtifact::from_manifest(
        &manifest,
        predicted_blob(&wasm, WASM_MIME),
        predicted_blob(&manifest_json, MANIFEST_MIME),
        release_cfg.license.clone().unwrap_or_default(),
        sections,
    );
    artifact.requires = release_cfg.requires.clone();
    blobs.push(Blob::new(wasm, WASM_MIME, "module"));
    blobs.push(Blob::new(manifest_json, MANIFEST_MIME, "manifest.json"));
    if let Some((image, blob)) = banner {
        artifact.banner = Some(image);
        blobs.push(blob);
    }
    for (image, blob) in screenshots {
        artifact.screenshots.push(image);
        blobs.push(blob);
    }
    let mut problems = artifact.problems();

    let details = match &project_cfg {
        Some(cfg) => {
            let icon_blob = icon.as_ref().map(|b| predicted_blob(&b.bytes, b.mime));
            let details = cfg.to_details(&name, Some(&manifest), icon_blob);
            // A `[project]` table the author wrote is checked now; one left
            // out is only needed if the registry has no project.
            problems.extend(details.problems());
            Ok(details)
        }
        None => Err(vec![Problem::new("hpy.toml", "has no [project] table")]),
    };
    if !problems.is_empty() {
        return Err(Failure::problems("cannot publish:", &problems));
    }
    Ok(Prepared {
        name,
        version,
        details,
        icon,
        artifact,
        blobs,
        changelog,
        wasm_path,
    })
}

/// The track a version publishes to: `--track`, else `latest` for a stable
/// version and the prerelease's own name for a beta or an alpha. Any other
/// prerelease has no channel of its own, so it needs saying.
pub fn track_for(version: &str, flag: Option<&str>) -> Result<String, Failure> {
    if let Some(track) = flag {
        if !TRACKS.contains(&track) {
            return Err(Failure::usage(format!(
                "--track: `{track}` is not one of latest, beta or alpha"
            )));
        }
        return Ok(track.into());
    }
    let pre = version.split_once('-').map(|(_, pre)| pre);
    match pre.map(|p| p.split('.').next().unwrap_or(p)) {
        None => Ok("latest".into()),
        Some(id @ ("beta" | "alpha")) => Ok(id.into()),
        Some(other) => Err(Failure::usage(format!(
            "{version} is a `{other}` prerelease, which no channel is named after; pass --track latest, beta or alpha"
        ))),
    }
}

fn summary(p: &Prepared, track: &str) -> String {
    let a = &p.artifact;
    let blob = |b: &Blob| format!("{} ({} bytes)", b.cid, b.bytes.len());
    let mut lines = vec![
        format!("Publishing {} {} to {track}", p.name, p.version),
        format!("  module:       {}", p.wasm_path.display()),
        format!("  package:      {}", blob(&p.blobs[0])),
        format!("  manifest:     {}", blob(&p.blobs[1])),
        format!("  type:         {} (api {})", a.plugin_type, a.api_version),
        format!(
            "  capabilities: {}",
            if a.capabilities.is_empty() {
                "none".into()
            } else {
                a.capabilities.join(", ")
            }
        ),
    ];
    if !a.requires.is_empty() {
        let reqs: Vec<String> = a.requires.iter().map(|(k, v)| format!("{k} {v}")).collect();
        lines.push(format!("  requires:     {}", reqs.join(", ")));
    }
    for b in &p.blobs[2..] {
        lines.push(format!("  image:        {} {}", b.what, b.cid));
    }
    if p.changelog.is_some() {
        lines.push("  changelog:    from [release] changelog".into());
    }
    lines.push("Versions are immutable: this one can never be changed or reused.".into());
    lines.join("\n")
}

/// Uploads `blob`, refusing an answer under any CID but the one the artifact
/// already names it by.
async fn upload_checked(repo: &dyn Repo, blob: &Blob) -> Result<(), Failure> {
    let stored = repo.upload_blob(blob.bytes.clone(), blob.mime).await?;
    let cid = stored["ref"]["$link"].as_str().unwrap_or_default();
    if cid != blob.cid {
        return Err(Failure::runtime(format!(
            "your PDS stored the {} as {cid}, but its bytes hash to {}; nothing was published",
            blob.what, blob.cid
        )));
    }
    Ok(())
}

/// Every blob CID a record names, wherever it sits.
fn blob_cids(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(link) = map
                .get("ref")
                .and_then(|r| r.get("$link"))
                .and_then(Value::as_str)
            {
                out.insert(link.to_string());
            }
            map.values().for_each(|v| blob_cids(v, out));
        }
        Value::Array(items) => items.iter().for_each(|v| blob_cids(v, out)),
        _ => {}
    }
}

/// Whether `putProject` would change anything the registry shows.
fn differs(details: &ProjectDetails, view: &ProjectView) -> bool {
    // No icon in `[project]` means the publication keeps the one it has,
    // not that it should lose it.
    let icon_differs = details
        .publication
        .icon
        .as_ref()
        .is_some_and(|i| view.publication.icon.as_deref() != i["ref"]["$link"].as_str());
    // Read back as the types hpy writes, so `null` and an absent field are
    // the same author.
    fn read<T: serde::de::DeserializeOwned>(v: &[Value]) -> Option<Vec<T>> {
        serde_json::from_value(Value::Array(v.to_vec())).ok()
    }
    view.publication.name != details.publication.name
        || view.publication.description != details.publication.description
        || icon_differs
        || view.plugin_type != details.plugin_type
        || view.keywords != details.keywords
        || read::<Author>(&view.authors).as_ref() != Some(&details.authors)
        || read::<Contact>(&view.security).as_ref() != Some(&details.security)
}

/// Whether a publish failed because the PDS no longer has a blob the
/// release names, which happens when a skipped upload's blob was deleted.
fn is_missing_blob(e: &hpy_atproto::Error) -> bool {
    let named = match e {
        hpy_atproto::Error::Xrpc { name, .. } => name.as_str(),
        e => e.registry_name().unwrap_or_default(),
    };
    named == "Upstream"
        || named == "BlobNotFound"
        || e.to_string().to_lowercase().contains("blob not found")
}

/// Refuses a session whose grant cannot write every record a publish writes
/// or upload every blob in `mimes`.
fn check_grant(repo: &dyn Repo, mimes: &[&str], name: &str, version: &str) -> Result<(), Failure> {
    let Some(granted) = repo.granted_scopes() else {
        return Ok(());
    };
    let mut missing = scope::missing_blob_scopes(granted, mimes.iter().copied());
    missing.extend(scope::missing_repo_scopes(
        granted,
        scope::PUBLISH_COLLECTIONS,
    ));
    if missing.is_empty() {
        return Ok(());
    }
    let needed = missing
        .iter()
        .map(|s| format!("`{s}`"))
        .collect::<Vec<_>>()
        .join(", ");
    Err(Failure::usage(format!(
        "publishing {name} {version} needs {needed}, which this sign-in was not granted. \
         A session's scopes are fixed when it is created, so publishing again \
         cannot add them: run `hpy registry login` to sign in again, then publish. \
         Nothing was uploaded."
    )))
}

fn is_project_missing(e: &hpy_atproto::Error) -> bool {
    e.registry_name() == Some("ProjectMissing")
}

pub async fn execute(
    p: &Prepared,
    repo: &dyn Repo,
    registry: &dyn Registry,
    ui: &dyn Ui,
    track: &str,
    dry_run: bool,
) -> Result<Outcome, Failure> {
    let did = repo.did();
    match registry.get_version(did, &p.name, &p.version).await {
        Ok(Some(view)) => {
            let theirs = PluginArtifact::from_value(&view.artifact).map_err(|e| {
                Failure::runtime(format!(
                    "the registry's artifact for {} {} {e}",
                    p.name, p.version
                ))
            })?;
            if theirs != p.artifact {
                return Err(Failure::usage(format!(
                    "the registry already holds {} {} with a different artifact (manifest {}); \
                     versions are immutable, so bump the version",
                    p.name, p.version, view.manifest.cid
                )));
            }
            // The same artifact: an earlier publish got this far, and the
            // gateway finishes whatever it left unwritten.
        }
        Ok(None) => {}
        Err(e) => ui.warn(&format!("could not check the registry ({e}); continuing")),
    }
    // The gateway writes several records and every artifact is a separate
    // upload, so a grant that covers some and not others fails partway. The
    // whole set is checked before the first upload.
    let mut mimes: Vec<&str> = p.blobs.iter().map(|b| b.mime).collect();
    mimes.extend(p.icon.iter().map(|b| b.mime));
    check_grant(repo, &mimes, &p.name, &p.version)?;
    let project = registry.get_project(did, &p.name).await?;
    let put = match (&project, &p.details) {
        (None, Ok(details)) => Some(details),
        (None, Err(problems)) => {
            return Err(Failure::problems(
                &format!(
                    "the registry has no `{}` project, and hpy.toml cannot create one; run `hpy registry plugin init`:",
                    p.name
                ),
                problems,
            ));
        }
        (Some(view), Ok(details)) if differs(details, view) => Some(details),
        (Some(_), _) => None,
    };
    let mut release = json!({
        "name": p.name,
        "version": p.version,
        "track": track,
        "artifact": p.artifact.to_value(),
    });
    if let Some(c) = &p.changelog {
        release["changelog"] = c.clone().into();
    }
    let project_input = match (put, &project) {
        (None, _) => None,
        (Some(details), None) => Some(details.to_input()),
        (Some(details), Some(view)) => {
            let mut input = details.to_input();
            if details.publication.icon.is_none()
                && let Some(icon) = current_icon(repo, &p.name).await?
            {
                input["publication"]["icon"] = icon;
            }
            // The gateway swaps on the sidecar, the record hpy's own
            // fields live in, so a concurrent edit there is not overwritten.
            if let Some(cid) = &view.sidecar.cid {
                input["swapCid"] = cid.clone().into();
            }
            Some(input)
        }
    };

    // The gateway's verdict, before anything is written or uploaded. A
    // release for a project not written yet answers ProjectMissing once its
    // own rules pass, so that is no refusal here.
    if let Some(input) = &project_input {
        registry.put_project(input.clone(), true).await?;
    }
    match registry.publish_release(release.clone(), true).await {
        Ok(_) => {}
        Err(e) if is_project_missing(&e) && project.is_none() => {}
        Err(e) => return Err(e.into()),
    }

    if dry_run {
        return Ok(Outcome::DryRun(json!({
            "dryRun": true,
            "project": project_input,
            "artifact": p.artifact.to_value(),
        })));
    }
    let mut text = summary(p, track);
    if put.is_some() {
        text.push_str(&format!(
            "\nThe `{}` project will be {} from hpy.toml.",
            p.name,
            if project.is_some() {
                "updated"
            } else {
                "created"
            }
        ));
    }
    if !ui.confirm(&text)? {
        return Err(Failure::runtime("cancelled"));
    }

    let mut created_project = false;
    if let Some(input) = project_input {
        let current = project.as_ref().and_then(|v| v.publication.icon.as_deref());
        if let Some(icon) = &p.icon
            && current != Some(icon.cid.as_str())
        {
            ui.progress("Uploading icon…");
            upload_checked(repo, icon).await?;
        }
        let out = registry
            .put_project(input, false)
            .await?
            .ok_or_else(|| Failure::runtime("putProject answered something unreadable"))?;
        created_project = out.created;
    }

    // A blob the previous version or the publication already names is on
    // the PDS and held by the registry, so sending it again is only traffic.
    // A version deleted at its source may have taken its blobs with it. The
    // registry trait answers every page of versions; a project has few, and
    // asking for one page would widen the trait for this alone.
    let mut held = BTreeSet::new();
    if let Some(newest) = registry
        .list_versions(did, &p.name)
        .await
        .unwrap_or_default()
        .iter()
        .find(|v| v.availability != hpy_atproto::registry::Availability::DeletedAtSource)
    {
        blob_cids(&newest.artifact, &mut held);
    }
    if let Some(icon) = project.as_ref().and_then(|v| v.publication.icon.clone()) {
        held.insert(icon);
    }
    let mut uploaded = false;
    let mut skipped = Vec::new();
    for blob in &p.blobs {
        if held.contains(&blob.cid) {
            skipped.push(blob);
            continue;
        }
        uploaded = true;
        ui.progress(&format!("Uploading {}…", blob.what));
        upload_checked(repo, blob).await?;
    }

    let out = match registry.publish_release(release.clone(), false).await {
        // A skipped blob the PDS has lost: send them all, and try once more.
        Err(e) if is_missing_blob(&e) && !skipped.is_empty() => {
            uploaded = true;
            for blob in skipped {
                ui.progress(&format!("Uploading {}…", blob.what));
                upload_checked(repo, blob).await?;
            }
            registry.publish_release(release, false).await?
        }
        out => out?,
    }
    .ok_or_else(|| Failure::runtime("publishRelease answered something unreadable"))?;
    Ok(Outcome::Published(Published {
        uri: out.version.uri,
        cid: out.version.cid,
        created_project,
        resumed: out.resumed,
        uploaded,
    }))
}

/// Republishes `from`'s artifact as `version` on `track`.
pub async fn promote(
    registry: &dyn Registry,
    name: &str,
    from: &str,
    version: &str,
    track: &str,
    changelog: Option<String>,
) -> Result<Published, Failure> {
    let mut input = json!({
        "name": name,
        "fromVersion": from,
        "version": version,
        "track": track,
    });
    if let Some(c) = changelog {
        input["changelog"] = c.into();
    }
    let out = registry.promote_release(input).await?;
    Ok(Published {
        uri: out.version.uri,
        cid: out.version.cid,
        created_project: false,
        resumed: out.resumed,
        uploaded: false,
    })
}

/// How long to wait for the registry to copy a version's blobs.
pub struct Timing {
    pub poll: Duration,
    pub limit: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            poll: Duration::from_secs(3),
            limit: Duration::from_secs(120),
        }
    }
}

fn availability_name(a: hpy_atproto::registry::Availability) -> String {
    serde_json::to_value(a)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Polls the registry until the version is `available` or `timing.limit`
/// passes, reporting each change. Answers the last availability seen, or
/// `None` when the registry never showed the version.
pub async fn wait_for_available(
    registry: &dyn Registry,
    did: &str,
    name: &str,
    version: &str,
    timing: &Timing,
    status: &dyn Fn(&str),
) -> Option<String> {
    let deadline = std::time::Instant::now() + timing.limit;
    let mut last: Option<String> = None;
    loop {
        if let Ok(Some(view)) = registry.get_version(did, name, version).await {
            let now = availability_name(view.availability);
            if last.as_deref() != Some(now.as_str()) {
                status(&format!("registry: {now}"));
                last = Some(now);
            }
            if last.as_deref() == Some("available") {
                return last;
            }
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(timing.poll).await;
    }
    status("not available yet; check later with `hpy registry plugin status`");
    last
}

struct TerminalUi<'a> {
    ctx: &'a Ctx,
    yes: bool,
}

impl Ui for TerminalUi<'_> {
    fn warn(&self, msg: &str) {
        self.ctx.out.status(&format!("warning: {msg}"));
    }

    fn progress(&self, msg: &str) {
        self.ctx.out.status(msg);
    }

    fn confirm(&self, summary: &str) -> Result<bool, Failure> {
        self.ctx.out.status(summary);
        self.ctx.prompter.confirm("Publish?", self.yes)
    }
}

fn run_build(dir: &Path) -> impl FnMut(&str) -> Result<(), String> + '_ {
    move |cmd: &str| {
        eprintln!("$ {cmd}");
        let status = if cfg!(windows) {
            std::process::Command::new("cmd")
                .arg("/C")
                .arg(cmd)
                .current_dir(dir)
                .status()
        } else {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(cmd)
                .current_dir(dir)
                .status()
        }
        .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("exited with {status}"))
        }
    }
}

/// The name and version a promotion publishes, read as `prepare` reads them
/// but without building or reading the module, which a promotion reuses.
fn promotion_target(
    dir: &Path,
    version: Option<String>,
) -> Result<(String, String, Option<String>), Failure> {
    let manifest = Manifest::load(dir).ok();
    let toml = HpyToml::load(dir)?.unwrap_or_default();
    let name = toml.name(manifest.as_ref()).ok_or_else(|| {
        Failure::usage("no project name: run in a directory with manifest.json or hpy.toml")
    })?;
    if !is_project_name(&name) {
        return Err(Failure::usage(format!(
            "`{name}` must be 1 to 64 lowercase letters, digits and interior `-`"
        )));
    }
    let version = version
        .or(manifest.and_then(|m| m.version))
        .ok_or_else(|| Failure::usage("no version: pass --version"))?;
    if let Some(p) = version_problem(&version) {
        return Err(Failure::usage(format!("--version: {p}")));
    }
    let changelog = match &toml.release {
        Some(r) => r.changelog(dir, &version)?,
        None => None,
    };
    Ok((name, version, changelog))
}

pub async fn run(ctx: &Ctx, args: PublishArgs) -> Result<(), Failure> {
    let (name, version, published) = if let Some(from) = &args.promote {
        let (name, version, changelog) = promotion_target(&ctx.dir, args.version.clone())?;
        let track = track_for(&version, args.track.as_deref())?;
        if args.dry_run {
            ctx.out.done(
                &format!("would promote {name} {from} to {version} on {track}"),
                json!({ "dryRun": true, "name": name, "fromVersion": from, "version": version, "track": track }),
            );
            return Ok(());
        }
        let session = ctx.session()?;
        check_grant(session.repo.as_ref(), &[], &name, &version)?;
        if !ctx.prompter.confirm(
            &format!("Promote {name} {from} to {version} on {track}?"),
            args.yes,
        )? {
            return Err(Failure::runtime("cancelled"));
        }
        let out = promote(
            &session.registry(),
            &name,
            from,
            &version,
            &track,
            changelog,
        )
        .await?;
        (name, version, (session, out))
    } else {
        let opts = PrepareOptions {
            wasm: args.wasm.clone(),
            version: args.version.clone(),
            no_build: args.no_build,
        };
        let prepared = prepare(&ctx.dir, &opts, &mut run_build(&ctx.dir))?;
        let track = track_for(&prepared.version, args.track.as_deref())?;
        let session = ctx.session()?;
        let registry = session.registry();
        let ui = TerminalUi { ctx, yes: args.yes };
        match execute(
            &prepared,
            session.repo.as_ref(),
            &registry,
            &ui,
            &track,
            args.dry_run,
        )
        .await?
        {
            Outcome::DryRun(out) => {
                ctx.out.status(&summary(&prepared, &track));
                let pretty = serde_json::to_string_pretty(&out).unwrap_or_default();
                ctx.out.done(&pretty, out);
                return Ok(());
            }
            Outcome::Published(out) => {
                if out.created_project {
                    ctx.out
                        .status(&format!("Created the `{}` project", prepared.name));
                }
                if out.resumed {
                    ctx.out
                        .status(&resumed_status(&out, &prepared.name, &prepared.version));
                }
                (prepared.name, prepared.version, (session, out))
            }
        }
    };
    let (session, out) = published;
    ctx.out.status(&format!("Published {}", out.uri));
    let availability = if args.wait {
        let status = |msg: &str| ctx.out.status(msg);
        wait_for_available(
            &session.registry(),
            session.repo.did(),
            &name,
            &version,
            &Timing::default(),
            &status,
        )
        .await
    } else {
        None
    };
    ctx.out.done(
        &format!("{name} {version} published"),
        out.to_json(availability),
    );
    Ok(())
}

/// What to say of a publish the gateway answered as resumed: it finished
/// an earlier attempt only if this run wrote something toward it.
fn resumed_status(out: &Published, name: &str, version: &str) -> String {
    if out.uploaded || out.created_project {
        "Finished a publish an earlier attempt left incomplete".into()
    } else {
        format!("{name} {version} was already published")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{DID, FakeRegistry, FakeRepo};
    use hpy_plugin::checksum::raw_cid;
    use std::cell::RefCell;

    const WASM: &[u8] = b"\0asm\x01\0\0\0";
    /// A 1x1 PNG.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    struct TestUi {
        answer: bool,
        warnings: RefCell<Vec<String>>,
        summaries: RefCell<Vec<String>>,
    }
    impl Ui for TestUi {
        fn warn(&self, m: &str) {
            self.warnings.borrow_mut().push(m.into());
        }
        fn progress(&self, _: &str) {}
        fn confirm(&self, summary: &str) -> Result<bool, Failure> {
            self.summaries.borrow_mut().push(summary.into());
            Ok(self.answer)
        }
    }
    fn ui() -> TestUi {
        TestUi {
            answer: true,
            warnings: RefCell::new(vec![]),
            summaries: RefCell::new(vec![]),
        }
    }

    const HPY_TOML: &str = "[project]\ndisplay_name = \"Mine\"\nicon = { path = \"icon.png\" }\nauthors = [{ name = \"Ada\" }]\nsecurity = [{ email = \"s@x.io\" }]\n\n[release]\nlicense = \"MIT\"\nchangelog = \"CHANGELOG.md\"\n\n[release.sections]\ndescription = { text = \"Does things.\" }\n\n[release.artifacts]\nbanner = { path = \"banner.png\", alt = \"A banner\" }\n\n[release.requires]\n\"env:happyview\" = \">=3.0.0\"\n";

    fn plugin_dir(version: &str, with_project: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("manifest.json"),
            format!(r#"{{"id":"my-plugin","name":"Mine","version":"{version}","api_version":"2","plugin_type":"library","namespace":"my.plugin","capabilities":[],"wasm_file":"my-plugin.wasm"}}"#),
        ).unwrap();
        std::fs::write(dir.path().join("my-plugin.wasm"), WASM).unwrap();
        std::fs::write(dir.path().join("icon.png"), PNG).unwrap();
        // Another image's bytes, so the banner has a CID of its own.
        let mut banner = PNG.to_vec();
        banner.extend_from_slice(b"banner");
        std::fs::write(dir.path().join("banner.png"), banner).unwrap();
        std::fs::write(
            dir.path().join("CHANGELOG.md"),
            format!("# Changelog\n\n## {version}\n\n* first\n"),
        )
        .unwrap();
        let toml = if with_project {
            HPY_TOML.to_string()
        } else {
            HPY_TOML
                .split("[release]")
                .nth(1)
                .map(|r| format!("[release]{r}"))
                .unwrap()
        };
        std::fs::write(dir.path().join("hpy.toml"), toml).unwrap();
        dir
    }

    fn opts() -> PrepareOptions {
        PrepareOptions {
            wasm: None,
            version: None,
            no_build: true,
        }
    }
    fn no_build() -> impl FnMut(&str) -> Result<(), String> {
        |_| Ok(())
    }

    fn prepared(version: &str) -> (tempfile::TempDir, Prepared) {
        let dir = plugin_dir(version, true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        (dir, p)
    }

    #[test]
    fn prepare_collects_every_problem() {
        let dir = plugin_dir("1.0.0+abc", true);
        let mut toml = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        toml = toml.replace("\"env:happyview\" = \">=3.0.0\"", "nope = \"^1 || ^2\"");
        std::fs::write(dir.path().join("hpy.toml"), toml).unwrap();
        let err = prepare(dir.path(), &opts(), &mut no_build()).err().unwrap();
        let text = format!("{:?}", err.report);
        assert_eq!(err.code, 2);
        assert!(text.contains("build metadata"), "{text}");
        assert!(text.contains("requires"), "{text}");
    }

    #[test]
    fn prepare_rejects_v_prefix_from_manifest() {
        let dir = plugin_dir("v1.0.0", true);
        let err = prepare(dir.path(), &opts(), &mut no_build()).err().unwrap();
        assert!(format!("{:?}", err.report).contains("`v`"));
    }

    #[test]
    fn prepare_builds_the_artifact_with_predicted_blobs() {
        let (dir, p) = prepared("1.0.0");
        assert_eq!(
            (p.name.as_str(), p.version.as_str()),
            ("my-plugin", "1.0.0")
        );
        let a = p.artifact.to_value();
        assert_eq!(a["package"]["ref"]["$link"], raw_cid(WASM));
        let manifest = std::fs::read(dir.path().join("manifest.json")).unwrap();
        assert_eq!(
            a["manifest"]["ref"]["$link"],
            raw_cid(&manifest),
            "the manifest is published as it sits beside the module"
        );
        assert_eq!(a["license"], "MIT");
        assert_eq!(a["sections"]["description"], "Does things.");
        assert_eq!(a["requires"]["env:happyview"], ">=3.0.0");
        assert_eq!(a["banner"]["alt"], "A banner");
        let details = p.details.as_ref().unwrap();
        assert_eq!(details.publication.name, "Mine");
        assert_eq!(
            details.publication.icon.as_ref().unwrap()["ref"]["$link"],
            raw_cid(PNG)
        );
        assert_eq!(p.changelog.as_deref(), Some("* first"));
    }

    #[test]
    fn version_flag_overrides_manifest() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(
            dir.path(),
            &PrepareOptions {
                version: Some("1.1.0".into()),
                ..opts()
            },
            &mut no_build(),
        )
        .unwrap();
        assert_eq!(p.version, "1.1.0");
    }

    #[test]
    fn build_command_runs_unless_disabled() {
        let dir = plugin_dir("1.0.0", true);
        let mut toml = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        toml.push_str("\n[build]\ncommand = \"make wasm\"\n");
        std::fs::write(dir.path().join("hpy.toml"), toml).unwrap();
        let mut ran = vec![];
        prepare(
            dir.path(),
            &PrepareOptions {
                no_build: false,
                ..opts()
            },
            &mut |c: &str| {
                ran.push(c.to_string());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(ran, ["make wasm"]);
        let err = prepare(
            dir.path(),
            &PrepareOptions {
                no_build: false,
                ..opts()
            },
            &mut |_: &str| Err("exit 1".into()),
        )
        .err()
        .unwrap();
        assert!(format!("{:?}", err.report).contains("make wasm"));
    }

    #[test]
    fn the_track_follows_the_version_unless_given() {
        for (version, flag, want) in [
            ("1.2.0", None, Ok("latest")),
            ("1.2.0-beta.1", None, Ok("beta")),
            ("1.2.0-alpha.3", None, Ok("alpha")),
            ("1.2.0-rc.1", None, Err("--track")),
            ("1.2.0-rc.1", Some("beta"), Ok("beta")),
            ("1.2.0", Some("alpha"), Ok("alpha")),
            ("1.2.0", Some("stable"), Err("latest, beta or alpha")),
        ] {
            let got = track_for(version, flag);
            match (got, want) {
                (Ok(t), Ok(w)) => assert_eq!(t, w, "{version} {flag:?}"),
                (Err(e), Err(needle)) => {
                    assert_eq!(e.code, 2);
                    assert!(
                        e.report.to_string().contains(needle),
                        "{version} {flag:?}: {}",
                        e.report
                    );
                }
                (got, want) => panic!("{version} {flag:?}: got {got:?}, want {want:?}"),
            }
        }
    }

    fn fast() -> Timing {
        Timing {
            poll: Duration::from_millis(1),
            limit: Duration::from_millis(50),
        }
    }

    async fn run(
        p: &Prepared,
        repo: &FakeRepo,
        reg: &FakeRegistry,
        dry_run: bool,
    ) -> Result<Outcome, Failure> {
        execute(p, repo, reg, &ui(), "latest", dry_run).await
    }

    fn published(o: Outcome) -> Published {
        match o {
            Outcome::Published(p) => p,
            Outcome::DryRun(_) => panic!("a dry run"),
        }
    }

    #[tokio::test]
    async fn a_first_publish_validates_everything_then_writes_it() {
        let (dir, p) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        let out = published(run(&p, &repo, &reg, false).await.unwrap());
        assert!(out.created_project);
        assert!(!out.resumed);
        assert_eq!(
            out.uri,
            "at://did:plc:testuser/software.release.version/my-plugin.1.0.0"
        );
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [
                ("project", true),
                ("release", true),
                ("project", false),
                ("release", false)
            ]
        );
        // Icon, module, manifest and banner, each once.
        let uploaded: Vec<String> = repo
            .blobs
            .lock()
            .unwrap()
            .iter()
            .map(|(b, _)| raw_cid(b))
            .collect();
        let manifest = std::fs::read(dir.path().join("manifest.json")).unwrap();
        assert_eq!(uploaded.len(), 4, "{uploaded:?}");
        for cid in [raw_cid(WASM), raw_cid(&manifest), raw_cid(PNG)] {
            assert!(uploaded.contains(&cid), "{cid} not uploaded");
        }
        let input = reg.published.lock().unwrap()[0].clone();
        assert_eq!(input["name"], "my-plugin");
        assert_eq!(input["version"], "1.0.0");
        assert_eq!(input["track"], "latest");
        assert_eq!(input["changelog"], "* first");
        assert_eq!(input["artifact"], p.artifact.to_value());
        let project = reg.put_projects.lock().unwrap()[0].clone();
        assert_eq!(project["name"], "my-plugin");
        assert_eq!(project["publication"]["icon"]["ref"]["$link"], raw_cid(PNG));
    }

    #[tokio::test]
    async fn a_second_publish_with_the_same_project_skips_put_project_and_unchanged_images() {
        let (_dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        reg.calls.lock().unwrap().clear();
        repo.blobs.lock().unwrap().clear();

        let (_dir, next) = prepared("1.1.0");
        let out = published(run(&next, &repo, &reg, false).await.unwrap());
        assert!(!out.created_project);
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("release", true), ("release", false)]
        );
        // The icon is the publication's and the banner the last version's,
        // so neither is sent again; only the changed manifest is.
        let uploaded: Vec<String> = repo
            .blobs
            .lock()
            .unwrap()
            .iter()
            .map(|(b, _)| raw_cid(b))
            .collect();
        assert!(!uploaded.contains(&raw_cid(PNG)), "{uploaded:?}");
        assert_eq!(uploaded.len(), 1, "{uploaded:?}");
    }

    #[tokio::test]
    async fn changed_project_details_are_put_again_without_reuploading_the_icon() {
        let (dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        reg.calls.lock().unwrap().clear();
        repo.blobs.lock().unwrap().clear();
        let toml = std::fs::read_to_string(dir.path().join("hpy.toml"))
            .unwrap()
            .replace("display_name = \"Mine\"", "display_name = \"Mine Too\"");
        std::fs::write(dir.path().join("hpy.toml"), toml).unwrap();
        let next = prepare(
            dir.path(),
            &PrepareOptions {
                version: Some("1.1.0".into()),
                ..opts()
            },
            &mut no_build(),
        )
        .unwrap();
        run(&next, &repo, &reg, false).await.unwrap();
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [
                ("project", true),
                ("release", true),
                ("project", false),
                ("release", false)
            ]
        );
        assert!(
            !repo
                .blobs
                .lock()
                .unwrap()
                .iter()
                .any(|(b, _)| raw_cid(b) == raw_cid(PNG))
        );
    }

    /// What the gateway wrote as the publication, in the repo, so `current_icon`
    /// finds it as it would on a real PDS.
    fn mirror_publication(repo: &FakeRepo, reg: &FakeRegistry) {
        let input = reg.put_projects.lock().unwrap().last().unwrap().clone();
        repo.records.lock().unwrap().insert(
            (
                hpy_plugin::PUBLICATION_NSID.into(),
                input["name"].as_str().unwrap().into(),
            ),
            (input["publication"].clone(), "bafypublication".into()),
        );
    }

    #[tokio::test]
    async fn a_project_table_without_an_icon_keeps_the_publications_icon() {
        let (dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        mirror_publication(&repo, &reg);
        reg.calls.lock().unwrap().clear();
        let toml = std::fs::read_to_string(dir.path().join("hpy.toml"))
            .unwrap()
            .replace("icon = { path = \"icon.png\" }\n", "");
        std::fs::write(dir.path().join("hpy.toml"), &toml).unwrap();
        // Without the icon line, nothing else differs: no put at all.
        let same = prepare(
            dir.path(),
            &PrepareOptions {
                version: Some("1.1.0".into()),
                ..opts()
            },
            &mut no_build(),
        )
        .unwrap();
        run(&same, &repo, &reg, false).await.unwrap();
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("release", true), ("release", false)]
        );
        // A real change is put with the icon the publication already has.
        std::fs::write(
            dir.path().join("hpy.toml"),
            toml.replace("display_name = \"Mine\"", "display_name = \"Renamed\""),
        )
        .unwrap();
        let renamed = prepare(
            dir.path(),
            &PrepareOptions {
                version: Some("1.2.0".into()),
                ..opts()
            },
            &mut no_build(),
        )
        .unwrap();
        run(&renamed, &repo, &reg, false).await.unwrap();
        let input = reg.put_projects.lock().unwrap().last().unwrap().clone();
        assert_eq!(input["publication"]["name"], "Renamed");
        assert_eq!(input["publication"]["icon"]["ref"]["$link"], raw_cid(PNG));
    }

    #[tokio::test]
    async fn an_existing_project_is_put_with_its_sidecars_cid() {
        let (dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        assert!(reg.put_projects.lock().unwrap()[0].get("swapCid").is_none());
        reg.project.lock().unwrap().as_mut().unwrap().sidecar.cid = Some("bafysidecar".into());
        let toml = std::fs::read_to_string(dir.path().join("hpy.toml"))
            .unwrap()
            .replace("display_name = \"Mine\"", "display_name = \"Renamed\"");
        std::fs::write(dir.path().join("hpy.toml"), toml).unwrap();
        let next = prepare(
            dir.path(),
            &PrepareOptions {
                version: Some("1.1.0".into()),
                ..opts()
            },
            &mut no_build(),
        )
        .unwrap();
        run(&next, &repo, &reg, false).await.unwrap();
        assert_eq!(
            reg.put_projects.lock().unwrap().last().unwrap()["swapCid"],
            "bafysidecar"
        );
    }

    #[tokio::test]
    async fn an_edit_survives_the_next_publish() {
        use crate::commands::profile::{Editable, apply_edit};
        let (dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        mirror_publication(&repo, &reg);
        reg.project.lock().unwrap().as_mut().unwrap().sidecar.cid = Some("bafysidecar".into());
        let view = reg.project.lock().unwrap().clone().unwrap();
        let mut edited = Editable::from_view(&view).unwrap();
        edited.display_name = "Edited".into();
        edited.keywords.push("new".into());
        apply_edit(dir.path(), &reg, &repo, &view, &edited)
            .await
            .unwrap();
        let put = reg.put_projects.lock().unwrap().last().unwrap().clone();
        assert_eq!(put["swapCid"], "bafysidecar");
        assert_eq!(put["publication"]["icon"]["ref"]["$link"], raw_cid(PNG));
        let toml = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        assert!(toml.contains("display_name = \"Edited\""), "{toml}");
        assert!(toml.contains("icon.png"), "{toml}");

        reg.calls.lock().unwrap().clear();
        let next = prepare(
            dir.path(),
            &PrepareOptions {
                version: Some("1.1.0".into()),
                ..opts()
            },
            &mut no_build(),
        )
        .unwrap();
        run(&next, &repo, &reg, false).await.unwrap();
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("release", true), ("release", false)],
            "publish would have reverted the edit"
        );
        assert_eq!(
            reg.project
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .publication
                .name,
            "Edited"
        );
    }

    #[test]
    fn null_and_absent_author_fields_are_the_same_author() {
        let (_dir, p) = prepared("1.0.0");
        let details = p.details.unwrap();
        let mut view = crate::testing::project_view(DID, "my-plugin", "library");
        view.publication.name = "Mine".into();
        view.publication.icon = Some(raw_cid(PNG));
        view.authors = vec![json!({ "name": "Ada", "email": null, "url": null })];
        view.security = vec![json!({ "email": "s@x.io", "url": null })];
        assert!(!differs(&details, &view));
        view.authors = vec![json!({ "name": "Bea" })];
        assert!(differs(&details, &view));
    }

    #[tokio::test]
    async fn a_deleted_version_holds_no_blobs() {
        let (_dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        reg.versions
            .lock()
            .unwrap()
            .get_mut("1.0.0")
            .unwrap()
            .availability = hpy_atproto::registry::Availability::DeletedAtSource;
        repo.blobs.lock().unwrap().clear();
        let (_dir, next) = prepared("1.1.0");
        run(&next, &repo, &reg, false).await.unwrap();
        let uploaded: Vec<String> = repo
            .blobs
            .lock()
            .unwrap()
            .iter()
            .map(|(b, _)| raw_cid(b))
            .collect();
        assert!(uploaded.contains(&raw_cid(WASM)), "{uploaded:?}");
    }

    #[tokio::test]
    async fn a_blob_the_pds_no_longer_has_is_sent_and_the_publish_retried() {
        let (_dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        repo.blobs.lock().unwrap().clear();
        *reg.missing_blob_once.lock().unwrap() = true;
        let (_dir, next) = prepared("1.1.0");
        let out = published(run(&next, &repo, &reg, false).await.unwrap());
        assert!(out.uri.ends_with("my-plugin.1.1.0"));
        let uploaded: Vec<String> = repo
            .blobs
            .lock()
            .unwrap()
            .iter()
            .map(|(b, _)| raw_cid(b))
            .collect();
        // The first pass skipped the module; the retry sent it.
        assert!(uploaded.contains(&raw_cid(WASM)), "{uploaded:?}");
        assert_eq!(
            reg.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| **c == ("release", false))
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn publishing_a_finished_version_again_reports_it_resumed() {
        let (_dir, p) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        assert!(!published(run(&p, &repo, &reg, false).await.unwrap()).resumed);
        let again = published(run(&p, &repo, &reg, false).await.unwrap());
        assert!(again.resumed);
        assert_eq!(
            again.uri,
            "at://did:plc:testuser/software.release.version/my-plugin.1.0.0"
        );
    }

    #[tokio::test]
    async fn publishing_a_finished_version_again_says_it_was_already_published() {
        let (_dir, p) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        let first = published(run(&p, &repo, &reg, false).await.unwrap());
        assert!(first.uploaded);
        let again = published(run(&p, &repo, &reg, false).await.unwrap());
        assert!(again.resumed);
        assert!(!again.uploaded);
        assert_eq!(
            resumed_status(&again, "my-plugin", "1.0.0"),
            "my-plugin 1.0.0 was already published"
        );
    }

    #[tokio::test]
    async fn a_resumed_publish_answered_without_a_manifest_succeeds() {
        let (_dir, p) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        *reg.fail_next_publish.lock().unwrap() = true;
        assert!(run(&p, &repo, &reg, false).await.is_err());
        *reg.omit_manifest.lock().unwrap() = true;
        let out = published(run(&p, &repo, &reg, false).await.unwrap());
        assert!(out.resumed);
        assert_eq!(
            out.uri,
            "at://did:plc:testuser/software.release.version/my-plugin.1.0.0"
        );
    }

    #[tokio::test]
    async fn finishing_a_cut_off_publish_says_so() {
        let (_dir, p) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        *reg.fail_next_publish.lock().unwrap() = true;
        assert!(run(&p, &repo, &reg, false).await.is_err());
        let out = published(run(&p, &repo, &reg, false).await.unwrap());
        assert!(out.resumed && out.uploaded);
        assert_eq!(
            resumed_status(&out, "my-plugin", "1.0.0"),
            "Finished a publish an earlier attempt left incomplete"
        );
    }

    #[tokio::test]
    async fn an_upload_the_pds_stores_under_another_cid_fails_naming_both() {
        let (_dir, p) = prepared("1.0.0");
        let wrong = raw_cid(b"other");
        let repo = FakeRepo {
            wrong_cid: Some(wrong.clone()),
            ..Default::default()
        };
        let reg = FakeRegistry::default();
        let err = run(&p, &repo, &reg, false).await.err().unwrap();
        let text = err.report.to_string();
        assert!(text.contains(&wrong), "{text}");
        assert!(text.contains(&raw_cid(PNG)), "{text}");
        assert!(reg.published.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_publish_cut_off_after_the_uploads_resumes_when_run_again() {
        let (_dir, p) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        *reg.fail_next_publish.lock().unwrap() = true;
        assert!(run(&p, &repo, &reg, false).await.is_err());
        assert!(reg.published.lock().unwrap().is_empty());
        let out = published(run(&p, &repo, &reg, false).await.unwrap());
        assert!(out.resumed);
        assert_eq!(reg.published.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_version_the_registry_holds_with_this_artifact_is_finished_not_refused() {
        let (_dir, p) = prepared("1.0.0");
        let reg = FakeRegistry::with_version("my-plugin", "1.0.0", p.artifact.to_value());
        *reg.project.lock().unwrap() = None;
        let out = run(&p, &FakeRepo::default(), &reg, false).await.unwrap();
        assert!(matches!(out, Outcome::Published(_)));
    }

    #[tokio::test]
    async fn a_version_the_registry_holds_with_another_artifact_is_refused() {
        let (_dir, p) = prepared("1.0.0");
        let mut other = p.artifact.to_value();
        other["license"] = "Apache-2.0".into();
        let reg = FakeRegistry::with_version("my-plugin", "1.0.0", other);
        let manifest = reg.versions.lock().unwrap()["1.0.0"].manifest.cid.clone();
        let repo = FakeRepo::default();
        let err = run(&p, &repo, &reg, false).await.err().unwrap();
        assert_eq!(err.code, 2);
        let text = err.report.to_string();
        assert!(text.contains("immutable"), "{text}");
        assert!(text.contains(&manifest), "{text}");
        assert!(repo.blobs.lock().unwrap().is_empty());
        assert!(reg.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unreadable_artifact_in_the_registry_names_the_version() {
        let (_dir, p) = prepared("1.0.0");
        let reg = FakeRegistry::with_version("my-plugin", "1.0.0", json!({ "$type": "x" }));
        let err = run(&p, &FakeRepo::default(), &reg, false)
            .await
            .err()
            .unwrap();
        assert!(
            err.report.to_string().contains("my-plugin 1.0.0"),
            "{}",
            err.report
        );
    }

    /// A grant from before the registry moved collections: it can upload
    /// every blob, so only the repo check stops it before the first upload.
    #[tokio::test]
    async fn a_grant_missing_a_scope_refuses_before_uploading_anything() {
        let (_dir, p) = prepared("1.0.0");
        let repo = FakeRepo {
            scopes: Some(
                "atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*"
                    .into(),
            ),
            ..FakeRepo::default()
        };
        let reg = FakeRegistry::default();
        let err = run(&p, &repo, &reg, false).await.err().unwrap();
        let text = err.report.to_string();
        assert!(text.contains("blob:application/json"), "{text}");
        assert!(text.contains("repo:software.release.version"), "{text}");
        assert!(text.contains("hpy registry login"), "{text}");
        assert!(repo.blobs.lock().unwrap().is_empty());
        assert!(reg.calls.lock().unwrap().is_empty());
    }

    /// The scope a login asks for has to get a publish all the way through.
    #[tokio::test]
    async fn the_default_grant_publishes() {
        let (_dir, p) = prepared("1.0.0");
        let repo = FakeRepo {
            scopes: Some(hpy_atproto::settings::DEFAULT_SCOPE.into()),
            ..FakeRepo::default()
        };
        assert!(matches!(
            run(&p, &repo, &FakeRegistry::default(), false)
                .await
                .unwrap(),
            Outcome::Published(_)
        ));
    }

    #[tokio::test]
    async fn no_project_anywhere_points_at_init() {
        let dir = plugin_dir("1.0.0", false);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let err = run(&p, &FakeRepo::default(), &FakeRegistry::default(), false)
            .await
            .err()
            .unwrap();
        assert!(format!("{:?}", err.report).contains("hpy registry plugin init"));
    }

    #[tokio::test]
    async fn a_registered_project_needs_no_project_table() {
        let (_dir, first) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        run(&first, &repo, &reg, false).await.unwrap();
        reg.calls.lock().unwrap().clear();
        let dir = plugin_dir("1.1.0", false);
        let next = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        run(&next, &repo, &reg, false).await.unwrap();
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("release", true), ("release", false)]
        );
    }

    #[tokio::test]
    async fn a_registry_refusal_uploads_nothing() {
        let (_dir, p) = prepared("1.0.0");
        let repo = FakeRepo::default();
        let reg = FakeRegistry {
            reject_release: Some((
                "InvalidRecord".into(),
                "capabilities must be declared, even when empty".into(),
            )),
            ..Default::default()
        };
        let err = run(&p, &repo, &reg, false).await.err().unwrap();
        assert_eq!(err.code, 2);
        assert!(
            err.report
                .to_string()
                .contains("capabilities must be declared")
        );
        assert!(repo.blobs.lock().unwrap().is_empty());
        assert!(reg.put_projects.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_project_not_yet_written_is_no_refusal_while_validating() {
        let (_dir, p) = prepared("1.0.0");
        let reg = FakeRegistry {
            reject_release: Some(("ProjectMissing".into(), "no such project".into())),
            ..Default::default()
        };
        // Validation passes; the write then meets the same refusal, since
        // the fake does not see the project it was just given.
        let err = run(&p, &FakeRepo::default(), &reg, false)
            .await
            .err()
            .unwrap();
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [
                ("project", true),
                ("release", true),
                ("project", false),
                ("release", false)
            ]
        );
        assert!(err.report.to_string().contains("no such project"));
    }

    #[tokio::test]
    async fn a_dry_run_asks_the_registry_and_writes_nothing() {
        let (_dir, p) = prepared("1.0.0");
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        let Outcome::DryRun(out) = run(&p, &repo, &reg, true).await.unwrap() else {
            panic!()
        };
        assert_eq!(out["dryRun"], true);
        assert_eq!(out["artifact"], p.artifact.to_value());
        assert_eq!(out["project"]["name"], "my-plugin");
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("project", true), ("release", true)]
        );
        assert!(repo.blobs.lock().unwrap().is_empty());
        let no = TestUi {
            answer: false,
            ..ui()
        };
        assert!(
            execute(&p, &repo, &reg, &no, "latest", false)
                .await
                .is_err()
        );
        assert!(reg.published.lock().unwrap().is_empty());
        assert!(reg.put_projects.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_summary_shows_cids_and_no_checksum() {
        let (_dir, p) = prepared("1.0.0");
        let u = ui();
        execute(
            &p,
            &FakeRepo::default(),
            &FakeRegistry::default(),
            &u,
            "latest",
            false,
        )
        .await
        .unwrap();
        let summary = u.summaries.borrow()[0].clone();
        assert!(summary.contains(&raw_cid(WASM)), "{summary}");
        assert!(summary.contains("latest"), "{summary}");
        assert!(!summary.contains("checksum"), "{summary}");
    }

    #[tokio::test]
    async fn promote_republishes_a_version_under_a_new_one() {
        let reg = FakeRegistry::default();
        let out = promote(
            &reg,
            "my-plugin",
            "1.0.0-beta.2",
            "1.0.0",
            "latest",
            Some("* notes".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            out.uri,
            "at://did:plc:testuser/software.release.version/my-plugin.1.0.0"
        );
        assert_eq!(
            reg.promoted.lock().unwrap()[0],
            json!({ "name": "my-plugin", "fromVersion": "1.0.0-beta.2", "version": "1.0.0",
                    "track": "latest", "changelog": "* notes" })
        );
        assert!(reg.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn waiting_reports_availability_and_gives_up_in_time() {
        let (_dir, p) = prepared("1.0.0");
        let reg = FakeRegistry::with_version("my-plugin", "1.0.0", p.artifact.to_value());
        let seen = std::sync::Mutex::new(vec![]);
        let got = wait_for_available(&reg, DID, "my-plugin", "1.0.0", &fast(), &|s: &str| {
            seen.lock().unwrap().push(s.to_string())
        })
        .await;
        assert_eq!(got.as_deref(), Some("available"));
        reg.versions
            .lock()
            .unwrap()
            .get_mut("1.0.0")
            .unwrap()
            .availability = hpy_atproto::registry::Availability::Pending;
        let got = wait_for_available(&reg, DID, "my-plugin", "1.0.0", &fast(), &|s: &str| {
            seen.lock().unwrap().push(s.to_string())
        })
        .await;
        assert_eq!(got.as_deref(), Some("pending"));
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|s| s.contains("not available yet")),
            "{:?}",
            seen.lock().unwrap()
        );
        let empty = FakeRegistry::default();
        let got = wait_for_available(&empty, DID, "my-plugin", "9.9.9", &fast(), &|_| {}).await;
        assert_eq!(got, None);
    }

    #[test]
    fn the_json_names_what_the_publish_action_reads() {
        let out = Published {
            uri: "at://v".into(),
            cid: "bafyv".into(),
            created_project: true,
            resumed: false,
            uploaded: false,
        };
        assert_eq!(
            out.to_json(Some("available".into())),
            json!({ "uri": "at://v", "cid": "bafyv", "createdProject": true, "resumed": false,
                    "availability": "available" })
        );
        assert_eq!(out.to_json(None)["availability"], Value::Null);
    }
}
