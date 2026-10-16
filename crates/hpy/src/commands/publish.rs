use std::path::{Path, PathBuf};
use std::time::Duration;

use hpy_atproto::{Registry, Repo};
use hpy_plugin::artifact::{MANIFEST_MIME, WASM_MIME, inspect_image, wasm_problem};
use hpy_plugin::checksum::same_digest;
use hpy_plugin::config::{HpyToml, ImageConfig};
use hpy_plugin::locate::locate_wasm;
use hpy_plugin::manifest::Manifest;
use hpy_plugin::profile::Profile;
use hpy_plugin::release::{Artifact, ImageArtifact, Release, requires_problems};
use hpy_plugin::validate::{is_slug, version_problem};
use hpy_plugin::{PROFILE_NSID, Problem, RELEASE_NSID};
use serde_json::{Value, json};

use crate::cli::PublishArgs;
use crate::commands::profile::profile_record;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub struct PrepareOptions {
    pub wasm: Option<PathBuf>,
    pub version: Option<String>,
    pub no_build: bool,
}

pub struct Prepared {
    pub slug: String,
    pub version: String,
    pub release: Release,
    pub wasm: Vec<u8>,
    pub wasm_path: PathBuf,
    /// `manifest.json` exactly as it sits beside the module, so what the
    /// registry serves is the file the author shipped rather than a
    /// re-serialisation of it.
    pub manifest_json: Vec<u8>,
    /// Image bytes in record order: icon, banner, screenshots.
    pub images: Vec<(Vec<u8>, &'static str)>,
    /// The profile `hpy.toml` describes, used only when the PDS has none.
    pub profile: Result<Profile, Vec<Problem>>,
}

pub enum Outcome {
    DryRun(Value),
    Published {
        uri: String,
        cid: String,
        created_profile: bool,
    },
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
) -> Option<(ImageArtifact, Vec<u8>, &'static str)> {
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
        Ok(info) => Some((
            ImageArtifact {
                artifact: Artifact::from_bytes(&bytes, info.mime),
                width: info.width,
                height: info.height,
                alt: cfg.alt.clone(),
            },
            bytes,
            info.mime,
        )),
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
    let mut problems = manifest.extension_problems();

    let slug = toml.slug(Some(&manifest)).unwrap_or_default();
    if !is_slug(&slug) {
        problems.push(Problem::new(
            "slug",
            format!("`{slug}` is not a valid slug"),
        ));
    }
    let version = opts
        .version
        .clone()
        .or(release_cfg.version.clone())
        .or(manifest.version.clone());
    let version = match version {
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
    problems.extend(requires_problems(&release_cfg.requires));
    if release_cfg.artifacts.screenshots.len() > 8 {
        problems.push(Problem::new(
            "release.artifacts.screenshots",
            "at most 8 screenshots",
        ));
    }

    let mut images = Vec::new();
    let mut load = |cfg: &ImageConfig, path: String, problems: &mut Vec<Problem>| {
        load_image(dir, cfg, &path, problems).map(|(art, bytes, mime)| {
            images.push((bytes, mime));
            art
        })
    };
    let a = &release_cfg.artifacts;
    let icon = a
        .icon
        .as_ref()
        .and_then(|c| load(c, "release.artifacts.icon".into(), &mut problems));
    let banner = a
        .banner
        .as_ref()
        .and_then(|c| load(c, "release.artifacts.banner".into(), &mut problems));
    let screenshots: Vec<_> = a
        .screenshots
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            load(
                c,
                format!("release.artifacts.screenshots[{i}]"),
                &mut problems,
            )
        })
        .collect();

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

    let profile = match &toml.profile {
        Some(cfg) => match cfg.to_profile(dir, Some(&manifest)) {
            (p, problems) if problems.is_empty() => Ok(p),
            (_, problems) => Err(problems),
        },
        None => Err(vec![Problem::new("hpy.toml", "has no [profile] table")]),
    };

    let release = Release {
        slug: slug.clone(),
        version: version.clone(),
        repo: release_cfg.repo.clone(),
        requires: release_cfg.requires.clone(),
        extension: manifest.extension(),
        package: Artifact::from_bytes(&wasm, WASM_MIME),
        manifest: Some(Artifact::from_bytes(&manifest_json, MANIFEST_MIME)),
        icon,
        banner,
        screenshots,
    };
    let release_problems = release.problems();
    if !release_problems.is_empty() {
        return Err(Failure::problems("cannot publish:", &release_problems));
    }
    Ok(Prepared {
        slug,
        version,
        release,
        wasm,
        manifest_json,
        wasm_path,
        images,
        profile,
    })
}

fn summary(p: &Prepared) -> String {
    let e = &p.release.extension;
    let mut lines = vec![
        format!("Publishing {} {}", p.slug, p.version),
        format!(
            "  module:       {} ({} bytes)",
            p.wasm_path.display(),
            p.wasm.len()
        ),
        format!("  checksum:     {}", p.release.package.checksum),
        format!("  type:         {} (api {})", e.plugin_type, e.api_version),
        format!(
            "  capabilities: {}",
            if e.capabilities.is_empty() {
                "none".into()
            } else {
                e.capabilities.join(", ")
            }
        ),
    ];
    if !p.release.requires.is_empty() {
        let reqs: Vec<String> = p
            .release
            .requires
            .iter()
            .map(|(k, v)| format!("{k} {v}"))
            .collect();
        lines.push(format!("  requires:     {}", reqs.join(", ")));
    }
    if !p.images.is_empty() {
        lines.push(format!("  images:       {}", p.images.len()));
    }
    lines.push("Releases are immutable: this version can never be changed or reused.".into());
    lines.join("\n")
}

async fn upload_checked(
    repo: &dyn Repo,
    bytes: &[u8],
    mime: &str,
    expected: &Artifact,
) -> Result<Value, Failure> {
    let blob = repo.upload_blob(bytes.to_vec(), mime).await?;
    let cid = blob["ref"]["$link"].as_str().unwrap_or_default();
    if !same_digest(cid, &expected.checksum) {
        return Err(Failure::runtime(format!(
            "your PDS stored the upload as {cid}, which does not match its checksum {}; nothing was published",
            expected.checksum
        )));
    }
    Ok(blob)
}

/// How long to wait for the registry to index a profile `hpy` just created.
pub struct Timing {
    pub poll: Duration,
    pub limit: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            poll: Duration::from_secs(2),
            limit: Duration::from_secs(60),
        }
    }
}

fn is_profile_missing(e: &hpy_atproto::Error) -> bool {
    e.registry_name() == Some("ProfileMissing")
}

pub async fn execute(
    p: &Prepared,
    repo: &dyn Repo,
    registry: &dyn Registry,
    ui: &dyn Ui,
    dry_run: bool,
    timing: &Timing,
) -> Result<Outcome, Failure> {
    let rkey = p.release.rkey();
    if repo.get_record(RELEASE_NSID, &rkey).await?.is_some() {
        return Err(Failure::usage(format!(
            "{} {} is already published; releases are immutable, so bump the version",
            p.slug, p.version
        )));
    }
    match registry.get_release(repo.did(), &p.slug, &p.version).await {
        Ok(Some(view)) if view.status == "deleted" => {
            return Err(Failure::usage(format!(
                "{} {} was withdrawn, and withdrawn versions can never be republished; bump the version",
                p.slug, p.version
            )));
        }
        // The registry keeps the first record it saw at a version and ignores
        // any later `create` as a replay, so a version it already holds can
        // never be published again even if the record left your repo.
        Ok(Some(view)) => {
            return Err(Failure::usage(format!(
                "the registry already holds {} {} (status: {}); releases are immutable, so bump the version",
                p.slug, p.version, view.status
            )));
        }
        Ok(None) => {}
        Err(e) => ui.warn(&format!("could not check the registry ({e}); continuing")),
    }
    let existing_profile = repo.get_record(PROFILE_NSID, &p.slug).await?;
    let new_profile = if existing_profile.is_none() {
        match &p.profile {
            Ok(profile) => Some(profile_record(profile)),
            Err(problems) => {
                return Err(Failure::problems(
                    &format!(
                        "`{}` has no profile on your PDS, and hpy.toml cannot create one; run `hpy registry plugin init`:",
                        p.slug
                    ),
                    problems,
                ));
            }
        }
    } else {
        None
    };

    // The registry's verdict, before anything is written or uploaded. A release
    // for a profile the registry has not indexed yet answers ProfileMissing
    // once its own rules pass, so that is not a refusal here.
    if let Some(record) = &new_profile {
        registry
            .publish_profile(&p.slug, record.clone(), true)
            .await?;
    }
    match registry.publish_release(p.release.to_record(), true).await {
        Ok(_) => {}
        Err(e) if is_profile_missing(&e) && new_profile.is_some() => {}
        Err(e) if is_profile_missing(&e) => {
            // The profile is on the PDS but the registry has not indexed it —
            // perhaps it refused it. Put it to the registry to find out why,
            // before anything is uploaded.
            if let Some(stored) = &existing_profile {
                registry
                    .publish_profile(&p.slug, stored.value.clone(), true)
                    .await?;
            }
            return Err(Failure::runtime(format!(
                "your `{}` profile is on your PDS, but the registry hasn't indexed it, so a release \
                 would never appear. If you created it in the last minute, try again shortly; \
                 otherwise check it with `hpy registry plugin status`",
                p.slug
            )));
        }
        Err(e) => return Err(e.into()),
    }

    if dry_run {
        return Ok(Outcome::DryRun(p.release.to_record()));
    }
    let mut text = summary(p);
    if new_profile.is_some() {
        text.push_str(&format!(
            "\nThe `{}` profile will be created from hpy.toml.",
            p.slug
        ));
    }
    if !ui.confirm(&text)? {
        return Err(Failure::runtime("cancelled"));
    }

    if let Some(record) = &new_profile {
        registry
            .publish_profile(&p.slug, record.clone(), false)
            .await?;
    }

    ui.progress("Uploading module…");
    let mut release = p.release.clone();
    release.package.blob =
        Some(upload_checked(repo, &p.wasm, WASM_MIME, &p.release.package).await?);
    if let Some(manifest) = release.manifest.as_mut() {
        ui.progress("Uploading manifest…");
        manifest.blob =
            Some(upload_checked(repo, &p.manifest_json, MANIFEST_MIME, manifest).await?);
    }
    let mut image_targets: Vec<&mut ImageArtifact> = Vec::new();
    image_targets.extend(release.icon.as_mut());
    image_targets.extend(release.banner.as_mut());
    image_targets.extend(release.screenshots.iter_mut());
    for (target, (bytes, mime)) in image_targets.into_iter().zip(&p.images) {
        ui.progress("Uploading image…");
        target.artifact.blob = Some(upload_checked(repo, bytes, mime, &target.artifact).await?);
    }

    let record = release.to_record();
    let deadline = std::time::Instant::now() + timing.limit;
    let mut waiting = false;
    loop {
        match registry.publish_release(record.clone(), false).await {
            Ok(Some(written)) => {
                return Ok(Outcome::Published {
                    uri: written.uri,
                    cid: written.cid,
                    created_profile: new_profile.is_some(),
                });
            }
            Ok(None) => {
                return Err(Failure::runtime(
                    "the registry published the release but answered no record",
                ));
            }
            Err(e) if is_profile_missing(&e) && std::time::Instant::now() < deadline => {
                if !waiting {
                    ui.progress(&format!(
                        "Waiting for the registry to index the `{}` profile…",
                        p.slug
                    ));
                    waiting = true;
                }
                tokio::time::sleep(timing.poll).await;
            }
            Err(e) if is_profile_missing(&e) => {
                return Err(Failure::runtime(format!(
                    "the registry has not indexed the `{}` profile yet, so the release was not published; \
                     run `hpy registry plugin publish` again in a minute",
                    p.slug
                )));
            }
            Err(e) => return Err(e.into()),
        }
    }
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

pub async fn run(ctx: &Ctx, args: PublishArgs) -> Result<(), Failure> {
    let opts = PrepareOptions {
        wasm: args.wasm.clone(),
        version: args.version.clone(),
        no_build: args.no_build,
    };
    let prepared = prepare(&ctx.dir, &opts, &mut run_build(&ctx.dir))?;
    let session = ctx.session()?;
    let registry = session.registry();
    let ui = TerminalUi { ctx, yes: args.yes };
    match execute(
        &prepared,
        session.repo.as_ref(),
        &registry,
        &ui,
        args.dry_run,
        &Timing::default(),
    )
    .await?
    {
        Outcome::DryRun(record) => {
            ctx.out.status(&summary(&prepared));
            let pretty = serde_json::to_string_pretty(&record).unwrap_or_default();
            ctx.out
                .done(&pretty, json!({ "dryRun": true, "record": record }));
        }
        Outcome::Published {
            uri,
            cid,
            created_profile,
        } => {
            if created_profile {
                ctx.out
                    .status(&format!("Created the `{}` profile", prepared.slug));
            }
            ctx.out.status(&format!("Published {uri}"));
            let status = if args.wait {
                let timing = Timing {
                    poll: Duration::from_secs(3),
                    limit: Duration::from_secs(120),
                };
                let status = |msg: &str| ctx.out.status(msg);
                Some(
                    wait_for_active(
                        &registry,
                        session.repo.did(),
                        &prepared.slug,
                        &prepared.version,
                        &timing,
                        &status,
                    )
                    .await,
                )
            } else {
                None
            };
            ctx.out.done(
                &format!("{} {} published", prepared.slug, prepared.version),
                json!({ "uri": uri, "cid": cid, "createdProfile": created_profile, "registryStatus": status }),
            );
        }
    }
    Ok(())
}

/// Polls the registry until the release is `active` or `timing.limit`
/// passes, reporting each status change. Answers the last status seen.
pub async fn wait_for_active(
    registry: &dyn Registry,
    did: &str,
    slug: &str,
    version: &str,
    timing: &Timing,
    status: &dyn Fn(&str),
) -> String {
    let deadline = std::time::Instant::now() + timing.limit;
    let mut last = String::new();
    loop {
        if let Ok(Some(view)) = registry.get_release(did, slug, version).await {
            if view.status != last {
                status(&format!("registry: {}", view.status));
                last = view.status.clone();
            }
            if view.status == "active" {
                return last;
            }
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(timing.poll).await;
    }
    status("still not active; check later with `hpy registry plugin status`");
    if last.is_empty() {
        "unknown".into()
    } else {
        last
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FakeRegistry, FakeRepo};
    use std::cell::RefCell;

    const WASM: &[u8] = b"\0asm\x01\0\0\0";

    struct TestUi {
        answer: bool,
        warnings: RefCell<Vec<String>>,
    }
    impl Ui for TestUi {
        fn warn(&self, m: &str) {
            self.warnings.borrow_mut().push(m.into());
        }
        fn progress(&self, _: &str) {}
        fn confirm(&self, _: &str) -> Result<bool, Failure> {
            Ok(self.answer)
        }
    }
    fn ui() -> TestUi {
        TestUi {
            answer: true,
            warnings: RefCell::new(vec![]),
        }
    }

    fn plugin_dir(version: &str, with_profile: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("manifest.json"),
            format!(r#"{{"id":"my-plugin","name":"Mine","version":"{version}","api_version":"2","plugin_type":"library","namespace":"my.plugin","capabilities":[],"wasm_file":"my-plugin.wasm"}}"#),
        ).unwrap();
        std::fs::write(dir.path().join("my-plugin.wasm"), WASM).unwrap();
        if with_profile {
            std::fs::write(dir.path().join("hpy.toml"), "[profile]\nlicense = \"MIT\"\nauthors = [{ name = \"Ada\" }]\nsecurity = [{ email = \"s@x.io\" }]\n\n[release.requires]\n\"env:happyview\" = \">=3.0.0\"\n").unwrap();
        }
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

    #[test]
    fn prepare_collects_every_problem() {
        let dir = plugin_dir("1.0.0+abc", false);
        std::fs::write(
            dir.path().join("hpy.toml"),
            "[release.requires]\nnope = \"^1 || ^2\"\n",
        )
        .unwrap();
        let err = prepare(dir.path(), &opts(), &mut no_build()).err().unwrap();
        let text = format!("{:?}", err.report);
        assert_eq!(err.code, 2);
        assert!(text.contains("build metadata"), "{text}");
        assert!(text.contains("release.requires"), "{text}");
    }

    #[test]
    fn prepare_rejects_v_prefix_from_manifest() {
        let dir = plugin_dir("v1.0.0", true);
        let err = prepare(dir.path(), &opts(), &mut no_build()).err().unwrap();
        assert!(format!("{:?}", err.report).contains("`v`"));
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
        assert_eq!(p.release.rkey(), "my-plugin:1.1.0");
    }

    #[test]
    fn build_command_runs_unless_disabled() {
        let dir = plugin_dir("1.0.0", true);
        std::fs::write(dir.path().join("hpy.toml"), "[profile]\nlicense = \"MIT\"\nauthors = [{ name = \"Ada\" }]\nsecurity = [{ email = \"s@x.io\" }]\n[build]\ncommand = \"make wasm\"\n").unwrap();
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

    fn fast() -> Timing {
        Timing {
            poll: Duration::from_millis(1),
            limit: Duration::from_millis(200),
        }
    }

    async fn run(
        p: &Prepared,
        repo: &FakeRepo,
        reg: &FakeRegistry,
        dry_run: bool,
    ) -> Result<Outcome, Failure> {
        execute(p, repo, reg, &ui(), dry_run, &fast()).await
    }

    #[tokio::test]
    async fn happy_path_creates_profile_uploads_and_publishes() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        let Outcome::Published {
            uri,
            created_profile,
            ..
        } = run(&p, &repo, &reg, false).await.unwrap()
        else {
            panic!()
        };
        assert!(created_profile);
        assert!(
            uri.ends_with("/at.happyproto.plugin.release/my-plugin:1.0.0"),
            "{uri}"
        );
        // The module and its manifest: a module published as a blob has no
        // directory beside it, so the manifest has to travel with it.
        assert_eq!(repo.blobs.lock().unwrap().len(), 2);
        let rec = reg.published_releases.lock().unwrap()[0].clone();
        assert_eq!(
            rec["artifacts"]["package"]["checksum"],
            hpy_plugin::checksum::checksum(WASM)
        );
        assert_eq!(
            rec["artifacts"]["manifest"]["checksum"],
            hpy_plugin::checksum::checksum(&p.manifest_json),
            "the manifest is published as it sits beside the module"
        );
        assert_eq!(
            rec["artifacts"]["manifest"]["contentType"],
            "application/json"
        );
        assert_eq!(rec["requires"]["env:happyview"], ">=3.0.0");
        let (slug, profile) = reg.published_profiles.lock().unwrap()[0].clone();
        assert_eq!(slug, "my-plugin");
        assert!(profile["lastUpdated"].is_string());
        // validated before anything was written or uploaded
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [
                ("profile", true),
                ("release", true),
                ("profile", false),
                ("release", false)
            ]
        );
    }

    #[tokio::test]
    async fn existing_profile_is_untouched() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::with(&[(
            "at.happyproto.plugin.profile",
            "my-plugin",
            serde_json::json!({"license": "Apache-2.0"}),
        )]);
        let reg = FakeRegistry::default();
        let Outcome::Published {
            created_profile, ..
        } = run(&p, &repo, &reg, false).await.unwrap()
        else {
            panic!()
        };
        assert!(!created_profile);
        assert!(reg.published_profiles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn no_profile_anywhere_points_at_init() {
        let dir = plugin_dir("1.0.0", false);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let err = run(&p, &FakeRepo::default(), &FakeRegistry::default(), false)
            .await
            .err()
            .unwrap();
        assert!(format!("{:?}", err.report).contains("hpy registry plugin init"));
    }

    #[tokio::test]
    async fn already_published_is_refused_before_upload() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::with(&[(
            "at.happyproto.plugin.release",
            "my-plugin:1.0.0",
            serde_json::json!({}),
        )]);
        let err = run(&p, &repo, &FakeRegistry::default(), false)
            .await
            .err()
            .unwrap();
        assert!(format!("{:?}", err.report).contains("immutable"));
        assert!(repo.blobs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn withdrawn_version_is_refused() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let err = run(
            &p,
            &FakeRepo::default(),
            &FakeRegistry::with_release("1.0.0", "deleted"),
            false,
        )
        .await
        .err()
        .unwrap();
        assert!(format!("{:?}", err.report).contains("withdrawn"));
    }

    #[tokio::test]
    async fn version_the_registry_already_holds_is_refused() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::default();
        let err = run(
            &p,
            &repo,
            &FakeRegistry::with_release("1.0.0", "active"),
            false,
        )
        .await
        .err()
        .unwrap();
        assert!(
            format!("{:?}", err.report).contains("already holds"),
            "{:?}",
            err.report
        );
        assert!(repo.blobs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unreachable_registry_warns_and_continues() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let reg = FakeRegistry {
            unreachable: true,
            ..Default::default()
        };
        let u = ui();
        execute(&p, &FakeRepo::default(), &reg, &u, false, &fast())
            .await
            .unwrap();
        assert!(u.warnings.borrow().iter().any(|w| w.contains("registry")));
    }

    #[tokio::test]
    async fn cid_mismatch_aborts_before_publishing() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo {
            wrong_cid: Some(hpy_plugin::checksum::raw_cid(b"other")),
            ..Default::default()
        };
        let reg = FakeRegistry::default();
        let err = run(&p, &repo, &reg, false).await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("checksum"));
        assert!(reg.published_releases.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn interrupted_publish_can_be_rerun() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::with(&[(
            "at.happyproto.plugin.profile",
            "my-plugin",
            serde_json::json!({"license": "MIT"}),
        )]);
        let reg = FakeRegistry::default();
        *reg.fail_next_publish.lock().unwrap() = true;
        assert!(run(&p, &repo, &reg, false).await.is_err());
        assert!(reg.published_releases.lock().unwrap().is_empty());
        run(&p, &repo, &reg, false).await.unwrap();
        assert_eq!(reg.published_releases.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn publish_waits_for_a_new_profile_to_be_indexed() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let reg = FakeRegistry::default();
        *reg.profile_missing.lock().unwrap() = 3;
        run(&p, &FakeRepo::default(), &reg, false).await.unwrap();
        assert_eq!(reg.published_releases.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn publish_gives_up_when_the_profile_never_indexes() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let reg = FakeRegistry::default();
        *reg.profile_missing.lock().unwrap() = usize::MAX;
        let err = run(&p, &FakeRepo::default(), &reg, false)
            .await
            .err()
            .unwrap();
        assert!(
            format!("{:?}", err.report).contains("indexed"),
            "{:?}",
            err.report
        );
        assert!(reg.published_releases.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn registry_rejection_uploads_nothing() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
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
        assert!(format!("{:?}", err.report).contains("capabilities must be declared"));
        assert!(repo.blobs.lock().unwrap().is_empty());
        assert!(reg.published_profiles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn version_exists_is_a_usage_error() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let reg = FakeRegistry {
            reject_release: Some((
                "VersionExists".into(),
                "that version is already published; publish a new one".into(),
            )),
            ..Default::default()
        };
        assert_eq!(
            run(&p, &FakeRepo::default(), &reg, false)
                .await
                .err()
                .unwrap()
                .code,
            2
        );
    }

    #[tokio::test]
    async fn dry_run_asks_the_registry_and_writes_nothing() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let (repo, reg) = (FakeRepo::default(), FakeRegistry::default());
        let Outcome::DryRun(record) = run(&p, &repo, &reg, true).await.unwrap() else {
            panic!()
        };
        assert_eq!(record["version"], "1.0.0");
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("profile", true), ("release", true)]
        );
        assert!(repo.blobs.lock().unwrap().is_empty());
        let no = TestUi {
            answer: false,
            warnings: RefCell::new(vec![]),
        };
        assert!(execute(&p, &repo, &reg, &no, false, &fast()).await.is_err());
        assert!(
            reg.published_releases.lock().unwrap().is_empty()
                && reg.published_profiles.lock().unwrap().is_empty()
        );
    }

    #[tokio::test]
    async fn an_unindexed_existing_profile_stops_before_upload() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::with(&[(
            "at.happyproto.plugin.profile",
            "my-plugin",
            serde_json::json!({"license": "MIT"}),
        )]);
        let reg = FakeRegistry::default();
        *reg.profile_missing.lock().unwrap() = 1;
        let err = run(&p, &repo, &reg, false).await.err().unwrap();
        assert!(
            format!("{:?}", err.report).contains("hasn't indexed"),
            "{:?}",
            err.report
        );
        assert!(repo.blobs.lock().unwrap().is_empty());
        // the PDS's profile was put to the registry to surface its reason
        assert!(reg.calls.lock().unwrap().contains(&("profile", true)));
    }

    #[tokio::test]
    async fn an_unindexed_profile_the_registry_refuses_says_why() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::with(&[(
            "at.happyproto.plugin.profile",
            "my-plugin",
            serde_json::json!({"license": ""}),
        )]);
        let reg = FakeRegistry {
            reject_profile: Some(("InvalidRecord".into(), "license is required".into())),
            ..Default::default()
        };
        *reg.profile_missing.lock().unwrap() = 1;
        let err = run(&p, &repo, &reg, false).await.err().unwrap();
        assert_eq!(err.code, 2);
        assert!(
            format!("{:?}", err.report).contains("license is required"),
            "{:?}",
            err.report
        );
    }

    #[test]
    fn prepare_reports_release_metadata_problems() {
        let dir = plugin_dir("1.0.0", true);
        let mut toml = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        toml.push_str("\n[release]\nrepo = \"not a uri\"\n");
        std::fs::write(dir.path().join("hpy.toml"), toml).unwrap();
        let err = prepare(dir.path(), &opts(), &mut no_build()).err().unwrap();
        assert_eq!(err.code, 2);
        assert!(
            format!("{:?}", err.report).contains("release.repo"),
            "{:?}",
            err.report
        );
    }

    #[tokio::test]
    async fn waiting_reports_activation_and_gives_up_in_time() {
        let reg = FakeRegistry::with_release("1.0.0", "active");
        let seen = std::sync::Mutex::new(vec![]);
        let status = wait_for_active(&reg, "did:plc:x", "x", "1.0.0", &fast(), &|s: &str| {
            seen.lock().unwrap().push(s.to_string())
        })
        .await;
        assert_eq!(status, "active");
        let reg = FakeRegistry::with_release("1.0.0", "pending");
        let status = wait_for_active(&reg, "did:plc:x", "x", "1.0.0", &fast(), &|s: &str| {
            seen.lock().unwrap().push(s.to_string())
        })
        .await;
        assert_eq!(status, "pending");
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|s| s.contains("still not active")),
            "{:?}",
            seen.lock().unwrap()
        );
    }
}
