//! `hpy happyview pull`: a v3 project built from what an instance serves.
//!
//! The source is the instance's live state, read through its admin API, not
//! the bundle `GET /admin/project` last deployed: an edit made in the
//! dashboard since would otherwise be lost. A v2 instance (`--legacy`) is
//! read the same way, with an API key, and each of its scripts rewritten for
//! v3 by the `happyview-codemod` of the HappyView the project pins.
//!
//! Never pulled: script variable values (only their keys, as empty lines in
//! `.env.example`), plugin secrets (`/plugins/{id}/secrets` is never called;
//! the names they need are listed), and the sign-in itself.

mod codemod;
mod diff;
mod map;
mod wire;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use hpy_atproto::admin::Admin;
use hpy_atproto::{Registry, VersionView};
use hpy_plugin::artifact::PluginArtifact;
use hpy_project::config::{CONFIG_FILE, Pin, PluginEntry, PluginKind, ProjectToml};
use hpy_project::lock::LOCK_FILE;
use hpy_project::scaffold::{GITIGNORE, ModuleSettings, ProjectFile, write_new};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use self::codemod::Rewrite;
use self::map::Kind;
use crate::cli::PullArgs;
use crate::commands::happyview::build::build_modules;
use crate::commands::happyview::instance;
use crate::commands::happyview::scaffold::missing_handler_warnings;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::binary::{self, HOST_TARGET, ReleaseSource};
use crate::project::prepare::{PrepareOptions, REMOVED_ENV, choose_with_prompter, prepare_at};
use crate::project::resolve::{Candidate, Resolver, candidates, resolve_lock};

/// The publisher HappyView treats as official (`plugin/official_registry.rs`,
/// `OFFICIAL_PUBLISHER_DID`). A v2 plugin was a URL install offered by it, so
/// its registry project is this DID's project of the same name.
pub const OFFICIAL_PUBLISHER_DID: &str = "did:plc:mo7vq4jbioxwafy5zkcc3eux";

/// Where `--legacy` reads the v2 API key when `--api-key-env` names none.
pub const DEFAULT_KEY_VAR: &str = "HAPPYVIEW_API_KEY";

/// What a v2 key needs for a whole pull, in v2's own names
/// (`admin/permissions.rs` on beta). Network lexicons are read under
/// `lexicons:read`.
pub const LEGACY_PERMISSIONS: &str = "lexicons:read, scripts:read, script-variables:read, \
     plugins:read, labelers:read, users:read and settings:manage";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Generation {
    V2,
    V3,
}

/// The major version `/config` reports: 2 and below are v2.
fn generation(version: &str) -> Option<Generation> {
    let v = semver::Version::parse(version.trim().trim_start_matches('v')).ok()?;
    Some(if v.major < 3 {
        Generation::V2
    } else {
        Generation::V3
    })
}

/// The HappyView version an instance runs, from its public `/config`, which
/// v2 and v3 both serve with a `version`.
async fn served_version(url: &str) -> Option<String> {
    let http = binary::http_client();
    let config: Value = http
        .get(format!("{url}/config"))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    config["version"].as_str().map(str::to_string)
}

/// Everything read from the instance.
struct Remote {
    lexicons: Vec<wire::Lexicon>,
    network: Vec<String>,
    scripts: Vec<wire::Script>,
    variables: Vec<String>,
    plugins: Vec<wire::Plugin>,
    /// `None` inside when the sign-in may not read settings.
    app_name: Option<Option<String>>,
    superadmin: Option<String>,
    labelers: Vec<String>,
}

fn parse<T: DeserializeOwned>(base: &str, what: &str, v: Value) -> Result<T, Failure> {
    serde_json::from_value(v)
        .map_err(|e| Failure::runtime(format!("{base} answered {what} unreadably: {e}")))
}

async fn get<T: DeserializeOwned>(admin: &Admin, what: &str, path: &str) -> Result<T, Failure> {
    parse(admin.base(), what, admin.get(what, path).await?)
}

async fn read(admin: &Admin) -> Result<Remote, Failure> {
    let mut lexicons: Vec<wire::Lexicon> = get(admin, "listing lexicons", "/lexicons").await?;
    for l in lexicons.iter_mut().filter(|l| !l.is_network()) {
        // An id that can't be a path is never asked for; it's reported later.
        if map::lexicon_path(&l.id).is_err() {
            continue;
        }
        let what = format!("reading lexicon {}", l.id);
        let full: wire::Lexicon = get(admin, &what, &format!("/lexicons/{}", l.id)).await?;
        l.lexicon_json = full.lexicon_json;
        l.target_collection = full.target_collection.or(l.target_collection.take());
    }
    let mut network: Vec<String> =
        get::<Vec<wire::NetworkLexicon>>(admin, "listing network lexicons", "/network-lexicons")
            .await?
            .into_iter()
            .map(|n| n.nsid)
            .chain(
                lexicons
                    .iter()
                    .filter(|l| l.is_network())
                    .map(|l| l.id.clone()),
            )
            .collect();
    network.sort();
    network.dedup();
    let scripts = get(admin, "listing scripts", "/scripts").await?;
    let mut variables: Vec<String> =
        get::<Vec<wire::Variable>>(admin, "listing script variables", "/script-variables")
            .await?
            .into_iter()
            .map(|v| v.key)
            .collect();
    variables.sort();
    let plugins = get::<wire::PluginList>(admin, "listing plugins", "/plugins")
        .await?
        .plugins;
    let app_name = match admin
        .get_if_permitted("reading settings", "/settings")
        .await?
    {
        None => None,
        Some(v) => Some(
            parse::<Vec<wire::Setting>>(admin.base(), "reading settings", v)?
                .into_iter()
                .find(|s| s.key == "app_name")
                .map(|s| s.value)
                .filter(|v| !v.trim().is_empty()),
        ),
    };
    let superadmin = get::<Vec<wire::User>>(admin, "listing users", "/users")
        .await?
        .into_iter()
        .find(|u| u.is_super)
        .map(|u| u.did);
    let labelers = get::<Vec<wire::Labeler>>(admin, "listing labelers", "/labelers")
        .await?
        .into_iter()
        .filter(|l| l.status == "active")
        .map(|l| l.did)
        .collect();
    Ok(Remote {
        lexicons,
        network,
        scripts,
        variables,
        plugins,
        app_name,
        superadmin,
        labelers,
    })
}

/// What pull says beside the files it writes.
#[derive(Default)]
struct Report {
    warnings: Vec<String>,
    /// Files a person has to finish: the codemod marked them or refused them.
    hand_edits: Vec<String>,
    /// `plugin: KEY, KEY`, to set once the project is deployed.
    secrets: Vec<String>,
    /// Compiled modules, whose source the instance doesn't hold.
    modules: Vec<String>,
}

impl Report {
    fn warn(&mut self, m: impl Into<String>) {
        self.warnings.push(m.into());
    }
}

/// The plugin tables, and the extension each interpreter's files take.
#[derive(Default)]
struct Plugins {
    interpreters: BTreeMap<String, PluginEntry>,
    libraries: BTreeMap<String, PluginEntry>,
    extensions: BTreeMap<String, String>,
}

impl Plugins {
    fn add(
        &mut self,
        kind: PluginKind,
        key: String,
        entry: PluginEntry,
        a: Option<&PluginArtifact>,
    ) {
        if kind == PluginKind::Interpreter
            && let Some(ext) = a.and_then(|a| a.file_extensions.first())
        {
            self.extensions.insert(key.clone(), ext.clone());
        }
        match kind {
            PluginKind::Interpreter => self.interpreters.insert(key, entry),
            PluginKind::Library => self.libraries.insert(key, entry),
        };
    }
}

fn plugin_kind(t: &str) -> Option<PluginKind> {
    match t {
        "interpreter" => Some(PluginKind::Interpreter),
        "library" => Some(PluginKind::Library),
        _ => None,
    }
}

fn artifact(view: Option<&VersionView>) -> Option<PluginArtifact> {
    view.and_then(|v| PluginArtifact::from_value(&v.artifact).ok())
}

fn secrets_line(p: &wire::Plugin) -> Option<String> {
    (!p.required_secrets.is_empty()).then(|| {
        let keys: Vec<&str> = p.required_secrets.iter().map(|s| s.key.as_str()).collect();
        format!("{}: {}", p.id, keys.join(", "))
    })
}

/// A v3 instance's plugins, as the registry projects they were installed
/// from. A URL or file install with no project has no place in
/// `happyview.toml`, and is left out with a warning.
async fn v3_plugins(
    reg: &dyn Registry,
    list: &[wire::Plugin],
    report: &mut Report,
) -> Result<Plugins, Failure> {
    let mut out = Plugins::default();
    for p in list {
        let project = p
            .registry
            .as_ref()
            .and_then(|r| Some((r.did.clone()?, r.name.clone()?, r.channel.clone())));
        let Some((did, name, channel)) = project else {
            report.warn(format!(
                "plugin `{}` was installed from a {} that no registry project matches; happyview.toml names only registry projects, so it is left out",
                p.id,
                p.source.as_deref().unwrap_or("URL")
            ));
            continue;
        };
        let Some(kind) = p.plugin_type.as_deref().and_then(plugin_kind) else {
            report.warn(format!(
                "plugin `{}` is a {} plugin, which happyview.toml has no table for; it is left out",
                p.id,
                p.plugin_type.as_deref().unwrap_or("untyped")
            ));
            continue;
        };
        let pin = match channel {
            Some(c) => Pin::Channel(c),
            None => Pin::Version(p.version.clone()),
        };
        let view = match &pin {
            Pin::Channel(c) => reg.resolve_channel(&did, &name, c).await?,
            Pin::Version(v) => reg.get_version(&did, &name, v).await?,
        };
        let a = artifact(view.as_ref());
        let key = match kind {
            PluginKind::Interpreter => a.as_ref().and_then(|a| a.language_id.clone()),
            PluginKind::Library => p
                .namespace
                .clone()
                .or_else(|| a.as_ref().and_then(|a| a.namespace.clone()))
                .or_else(|| Some(name.clone())),
        };
        let Some(key) = key else {
            report.warn(format!(
                "the registry doesn't say which language interpreter `{}` runs ({did}/{name}), so it is left out",
                p.id
            ));
            continue;
        };
        report.secrets.extend(secrets_line(p));
        out.add(kind, key, PluginEntry { did, name, pin }, a.as_ref());
    }
    Ok(out)
}

/// One project answering `key`: the official publisher's when it has one,
/// else the only one, else the one the user picks.
fn pick(
    ctx: &Ctx,
    kind: PluginKind,
    key: &str,
    found: &[Candidate],
) -> Result<Option<Candidate>, Failure> {
    let matches: Vec<Candidate> = found
        .iter()
        .filter(|c| c.answers(kind, key))
        .cloned()
        .collect();
    if let Some(official) = matches.iter().find(|c| c.did == OFFICIAL_PUBLISHER_DID) {
        return Ok(Some(official.clone()));
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.into_iter().next()),
        _ => {
            let i = choose_with_prompter(ctx)(key, &matches)?;
            Ok(matches.into_iter().nth(i))
        }
    }
}

fn entry(c: &Candidate) -> PluginEntry {
    PluginEntry {
        did: c.did.clone(),
        name: c.name.clone(),
        pin: Pin::Channel(c.channel.clone()),
    }
}

/// A v2 instance's plugins in v3 terms: Lua, every v2 plugin the official
/// publisher has a project for (on its alpha channel), and the libraries the
/// rewritten scripts require.
async fn v2_plugins(
    ctx: &Ctx,
    reg: &dyn Registry,
    list: &[wire::Plugin],
    requires: &BTreeSet<String>,
    report: &mut Report,
) -> Result<Plugins, Failure> {
    let mut out = Plugins::default();
    let interpreters = candidates(reg, PluginKind::Interpreter).await?;
    let lua = pick(ctx, PluginKind::Interpreter, "lua", &interpreters)?.ok_or_else(|| {
        Failure::usage(
            "no interpreter in the registry answers to `lua`, which every v2 script is written in",
        )
    })?;
    out.interpreters.insert("lua".into(), entry(&lua));
    for p in list {
        let view = reg
            .resolve_channel(OFFICIAL_PUBLISHER_DID, &p.id, "alpha")
            .await?;
        let a = artifact(view.as_ref());
        let kind = a.as_ref().and_then(|a| plugin_kind(&a.plugin_type));
        let (Some(a), Some(kind)) = (a, kind) else {
            report.warn(format!(
                "v2 plugin `{}` has no official registry project to install it from, so it is left out",
                p.id
            ));
            continue;
        };
        let key = match kind {
            PluginKind::Interpreter => a.language_id.clone().unwrap_or_else(|| p.id.clone()),
            PluginKind::Library => a.namespace.clone().unwrap_or_else(|| p.id.clone()),
        };
        report.secrets.extend(secrets_line(p));
        let e = PluginEntry {
            did: OFFICIAL_PUBLISHER_DID.into(),
            name: p.id.clone(),
            pin: Pin::Channel("alpha".into()),
        };
        out.add(kind, key, e, Some(&a));
    }
    if !requires.is_empty() {
        let libraries = candidates(reg, PluginKind::Library).await?;
        for ns in requires {
            if out.libraries.contains_key(ns) {
                continue;
            }
            match pick(ctx, PluginKind::Library, ns, &libraries)? {
                Some(c) => {
                    out.libraries.insert(ns.clone(), entry(&c));
                }
                None => report.warn(format!(
                    "a script requires `{ns}`, but no library in the registry answers to it"
                )),
            }
        }
    }
    Ok(out)
}

/// The files of `src/` and the tables of `happyview.toml` that come from
/// lexicons and scripts.
#[derive(Default)]
struct Source {
    files: BTreeMap<String, String>,
    toml: ProjectFile,
    /// `happyview.*` libraries the rewritten v2 scripts require.
    requires: BTreeSet<String>,
    lexicons: usize,
    scripts: usize,
}

async fn source(
    remote: &Remote,
    generation: Generation,
    codemod: Option<&Path>,
    extensions: &BTreeMap<String, String>,
    report: &mut Report,
) -> Result<Source, Failure> {
    let mut out = Source::default();
    let mut on_instance = BTreeSet::new();
    for l in remote.lexicons.iter().filter(|l| !l.is_network()) {
        let path = match map::lexicon_path(&l.id) {
            Ok(p) => p,
            Err(e) => {
                report.warn(format!("lexicon {e}, so it is left out"));
                continue;
            }
        };
        let Some(doc) = &l.lexicon_json else {
            report.warn(format!(
                "the instance answered no JSON for lexicon {}, so it is left out",
                l.id
            ));
            continue;
        };
        let text = serde_json::to_string_pretty(doc).map_err(Failure::runtime)?;
        out.files.insert(path, format!("{text}\n"));
        let settings = map::lexicon_settings(
            l.lexicon_type.as_deref(),
            l.backfill,
            l.token_cost,
            l.indexed,
        );
        if !settings.is_empty() {
            out.toml.lexicons.insert(l.id.clone(), settings);
        }
        on_instance.insert(l.id.clone());
        out.lexicons += 1;
    }
    out.toml.network_lexicons = remote.network.clone();
    let collections: BTreeMap<&str, &str> = remote
        .lexicons
        .iter()
        .filter_map(|l| Some((l.id.as_str(), l.target_collection.as_deref()?)))
        .collect();

    for s in &remote.scripts {
        if let Some(m) = &s.module {
            out.toml.modules.insert(
                m.module.clone(),
                ModuleSettings {
                    language: s.script_type.clone(),
                    path: m.path.clone(),
                },
            );
            report.modules.push(format!(
                "{} ({}, `{}` handles {})",
                m.module, m.path, m.handler, s.id
            ));
            continue;
        }
        let Some(trigger) = map::parse_trigger(&s.id) else {
            report.warn(format!(
                "script `{}` has a trigger pull doesn't know, so it is left out",
                s.id
            ));
            continue;
        };
        let (ext, known) = map::extension(&s.script_type, extensions);
        if !known {
            report.warn(format!(
                "no interpreter says which extension `{}` files take, so {} is written as .{ext}",
                s.script_type, s.id
            ));
        }
        let given = (generation == Generation::V3)
            .then(|| s.path.as_deref().and_then(map::safe_src_path))
            .flatten();
        let path = match given.map_or_else(|| map::handler_path(&trigger, &ext), Ok) {
            Ok(p) => p,
            Err(e) => {
                report.warn(format!("script {}: {e}, so it is left out", s.id));
                continue;
            }
        };
        if let Some(nsid) = trigger.lexicon()
            && !on_instance.contains(nsid)
        {
            report.warn(format!(
                "{} handles {nsid}, which isn't a lexicon file on the instance; `hpy hv check` will flag {path}",
                s.id
            ));
        }
        let (body, outbound) = match codemod {
            Some(bin) if generation == Generation::V2 => {
                let collection = matches!(trigger.kind, Kind::Query | Kind::Procedure)
                    .then(|| collections.get(trigger.target.as_str()).copied())
                    .flatten();
                let body = match codemod::rewrite(bin, &s.body, trigger.kind, collection).await? {
                    Rewrite::Clean(src) => src,
                    Rewrite::Marked(src) => {
                        report.hand_edits.push(format!(
                            "{path}: the codemod left `-- codemod:` markers to finish by hand"
                        ));
                        src
                    }
                    Rewrite::Failed(why) => {
                        report.hand_edits.push(format!(
                            "{path}: the codemod couldn't rewrite it ({why}), so it is still v2 code"
                        ));
                        s.body.clone()
                    }
                };
                out.requires.extend(map::happyview_requires(&body));
                // v2 derived its list from a body that no longer exists.
                (body, None)
            }
            _ => (s.body.clone(), s.outbound_xrpcs.as_deref()),
        };
        let settings = map::script_settings(&body, s.description.as_deref(), outbound);
        if settings.description.is_some() || settings.outbound_xrpcs.is_some() {
            out.toml.scripts.insert(s.id.clone(), settings);
        }
        if out.files.insert(path.clone(), body).is_some() {
            report.warn(format!(
                "two things on the instance belong at {path}; the later, {}, was kept",
                s.id
            ));
        }
        out.scripts += 1;
    }
    Ok(out)
}

/// The project a pull writes, with what it says about it.
struct Pulled {
    files: Vec<(PathBuf, String)>,
    toml: String,
    happyview: String,
    lexicons: usize,
    scripts: usize,
    network: usize,
    variables: Vec<String>,
    report: Report,
}

/// The v2 API key: from `var`, else asked for without echo. It is held only
/// in memory and never written anywhere.
fn legacy_key(ctx: &Ctx, var: &str) -> Result<String, Failure> {
    if let Some(key) = std::env::var(var).ok().filter(|k| !k.trim().is_empty()) {
        return Ok(key.trim().to_string());
    }
    if !ctx.prompter.is_interactive() {
        return Err(Failure::usage(format!(
            "--legacy reads the v2 instance's API key from {var}; set it to a key with {LEGACY_PERMISSIONS}, or run in a terminal to be asked for it"
        )));
    }
    let key = inquire::Password::new("v2 API key:")
        .without_confirmation()
        .with_display_mode(inquire::PasswordDisplayMode::Hidden)
        .prompt()
        .map_err(|e| match e {
            inquire::InquireError::OperationCanceled
            | inquire::InquireError::OperationInterrupted => Failure::runtime("cancelled"),
            e => Failure::runtime(e),
        })?;
    Ok(key.trim().to_string())
}

/// The admin API to read, and which HappyView it runs, refused when it is
/// not the one the flags expect.
async fn connect(
    ctx: &Ctx,
    args: &PullArgs,
) -> Result<(Admin, Generation, Option<String>), Failure> {
    // Signed in as `deploy` is, so the instance is the one it would use.
    let signed_in = if args.legacy {
        None
    } else {
        Some(instance::admin(ctx, &args.instance)?)
    };
    let url = match &signed_in {
        Some(admin) => admin.base().to_string(),
        None => {
            let url = args.instance.url.as_deref().ok_or_else(|| {
                Failure::usage(
                    "--legacy needs --url <instance>: a v2 instance has no `hpy hv login`",
                )
            })?;
            hpy_atproto::instance::normalize_url(url)?
        }
    };
    let version = served_version(&url).await;
    let found = version.as_deref().and_then(generation);
    match (found, args.legacy) {
        (Some(Generation::V2), false) => {
            return Err(Failure::usage(format!(
                "{url} is a v2 instance (HappyView {}); add --legacy to pull it into a v3 project",
                version.as_deref().unwrap_or_default()
            )));
        }
        (Some(Generation::V3), true) => {
            return Err(Failure::usage(format!(
                "{url} is a v3 instance (HappyView {}); pull it without --legacy",
                version.as_deref().unwrap_or_default()
            )));
        }
        (None, _) => ctx.out.status(&format!(
            "warning: {url}/config doesn't say which HappyView it runs; reading it as {}",
            if args.legacy {
                "v2, as --legacy says"
            } else {
                "v3"
            }
        )),
        _ => {}
    }
    let generation = if args.legacy {
        Generation::V2
    } else {
        Generation::V3
    };
    let admin = match signed_in {
        Some(admin) => admin,
        None => {
            // Asked for only once the instance is known to be a v2 one.
            let var = args.api_key_env.as_deref().unwrap_or(DEFAULT_KEY_VAR);
            let key = legacy_key(ctx, var)?;
            hpy_atproto::instance::check_key(&key)
                .map_err(|e| Failure::usage(format!("{var}: {e}")))?;
            Admin::new(&url, &key)
        }
    };
    Ok((admin, generation, version))
}

/// The HappyView version the project pins: the instance's own for v3, so
/// the project runs what it came from; the newest with a binary for this
/// machine for v2, whose own version can't run a v3 project.
async fn pinned_version(
    ctx: &Ctx,
    generation: Generation,
    served: Option<&str>,
) -> Result<String, Failure> {
    if generation == Generation::V3
        && let Some(v) = served.map(|v| v.trim().trim_start_matches('v'))
        && semver::Version::parse(v).is_ok()
    {
        return Ok(v.to_string());
    }
    if generation == Generation::V3 {
        ctx.out.status(
            "warning: the instance's HappyView version is unknown, so the project pins the newest release",
        );
    }
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    binary::latest_version(
        &binary::http_client(),
        &ReleaseSource::from_env(&env),
        HOST_TARGET,
    )
    .await
}

async fn pull(
    ctx: &Ctx,
    admin: &Admin,
    generation: Generation,
    served: Option<&str>,
) -> Result<Pulled, Failure> {
    let url = admin.base().to_string();
    let remote = read(admin).await.map_err(|e| {
        if generation == Generation::V2 && e.code == 3 {
            Failure::from(hpy_atproto::Error::LoginRequired(format!(
                "{url} refused the v2 API key; create one in its dashboard with {LEGACY_PERMISSIONS}, and revoke it after the pull"
            )))
        } else {
            e
        }
    })?;
    let happyview = pinned_version(ctx, generation, served).await?;
    let registry = ctx.registry();
    let mut report = Report::default();

    let (plugins, src) = match generation {
        Generation::V3 => {
            let plugins = v3_plugins(&registry, &remote.plugins, &mut report).await?;
            let src = source(&remote, generation, None, &plugins.extensions, &mut report).await?;
            (plugins, src)
        }
        Generation::V2 => {
            let codemod = binary::ensure_codemod(
                &binary::http_client(),
                &ReleaseSource::from_env(&|k: &str| {
                    std::env::var(k).ok().filter(|v| !v.is_empty())
                }),
                &crate::project::cache::cache_root()?,
                &happyview,
                HOST_TARGET,
                &|m| ctx.out.status(m),
            )
            .await?;
            let src = source(
                &remote,
                generation,
                Some(&codemod),
                &BTreeMap::new(),
                &mut report,
            )
            .await?;
            let plugins =
                v2_plugins(ctx, &registry, &remote.plugins, &src.requires, &mut report).await?;
            (plugins, src)
        }
    };

    match &remote.app_name {
        None => report.warn(
            "the sign-in can't read the instance's settings (that needs settings:manage), so [instance] app_name is left out",
        ),
        Some(None) => report.warn("the instance has no app name set, so [instance] app_name is left out"),
        Some(Some(_)) => {}
    }
    if remote.superadmin.is_none() {
        report.warn("the instance lists no superadmin, so [instance] superadmin is left out");
    }

    let mut file = src.toml;
    file.happyview_version = happyview.clone();
    file.app_name = remote.app_name.clone().flatten();
    file.superadmin = remote.superadmin.clone();
    file.interpreters = plugins.interpreters.clone();
    file.libraries = plugins.libraries.clone();
    file.labels = remote.labelers.clone();
    let toml = file.render();
    // Read back as hpy and HappyView will, so a file pull can't parse is
    // never written.
    let config = ProjectToml::parse(&toml).map_err(|p| {
        Failure::runtime(format!(
            "pull wrote a {CONFIG_FILE} it can't read back: {p}"
        ))
    })?;
    let warn = |m: &str| ctx.out.status(&format!("warning: {m}"));
    let lock = resolve_lock(
        &Resolver {
            registry: &registry,
            warn: &warn,
        },
        &config,
        None,
    )
    .await?;

    let mut files: Vec<(PathBuf, String)> = vec![
        (CONFIG_FILE.into(), toml.clone()),
        (LOCK_FILE.into(), lock.render()),
        (".gitignore".into(), GITIGNORE.to_string()),
        (".env.example".into(), map::env_example(&remote.variables)),
    ];
    files.extend(
        src.files
            .into_iter()
            .map(|(p, body)| (PathBuf::from(p), body)),
    );
    let languages: Vec<String> = plugins.interpreters.keys().cloned().collect();
    files.extend(crate::project::editor::editor_files(&languages));
    Ok(Pulled {
        files,
        toml,
        happyview,
        lexicons: src.lexicons,
        scripts: src.scripts,
        network: remote.network.len(),
        variables: remote.variables,
        report,
    })
}

/// `happyview check` on the new project, as `hpy hv check` runs it, but as
/// a child: the summary is already out, and the exit code is pull's to give.
async fn check(ctx: &Ctx, root: &Path) -> Result<i32, Failure> {
    for line in missing_handler_warnings(root) {
        ctx.out.status(&line);
    }
    build_modules(root.to_path_buf()).await?;
    let p = prepare_at(ctx, root.to_path_buf(), &PrepareOptions::native(false)).await?;
    let mut cmd = tokio::process::Command::new(&p.binary);
    for key in REMOVED_ENV {
        cmd.env_remove(key);
    }
    // stdout is pull's result; HappyView's report goes with the rest of
    // what pull says.
    let status = cmd
        .args(["check", "."])
        .current_dir(&p.root)
        .stdin(Stdio::null())
        .stdout(std::io::stderr())
        .status()
        .await
        .map_err(|e| Failure::runtime(format!("could not run {}: {e}", p.binary.display())))?;
    Ok(status.code().unwrap_or(1))
}

/// Says whether the project matches what `hpy happyview deploy` last sent.
/// Only ever a comparison: the live state is what was pulled.
async fn compare_with_deploy(ctx: &Ctx, admin: &Admin, root: &Path) {
    let Ok(deployed) = admin.project().await else {
        return;
    };
    let Some(deployed) = deployed else {
        ctx.out
            .status("Nothing was deployed there with `hpy happyview deploy`; the project is what it serves.");
        return;
    };
    let short: String = deployed.sha256.chars().take(12).collect();
    match crate::project::bundle::bundle(root, &[]) {
        Ok(b) if b.sha256 == deployed.sha256 => {
            ctx.out.status(&format!("It matches the last deploy, {short}."));
        }
        Ok(_) => ctx.out.status(&format!(
            "It differs from the last deploy, {short}{}: the project is what the instance serves now.",
            deployed
                .deployed_at
                .map(|at| format!(" ({at})"))
                .unwrap_or_default()
        )),
        Err(_) => {}
    }
}

fn summary(url: &str, dir: &Path, p: &Pulled) -> String {
    let mut lines = vec![
        format!("Pulled {url} into {}", dir.display()),
        format!(
            "  {} lexicons, {} scripts, {} network lexicons; HappyView {}",
            p.lexicons, p.scripts, p.network, p.happyview
        ),
    ];
    let r = &p.report;
    if !r.hand_edits.is_empty() {
        lines.push("To finish by hand:".into());
        lines.extend(r.hand_edits.iter().map(|h| format!("  • {h}")));
    }
    if !r.modules.is_empty() {
        lines.push(
            "Compiled modules, whose source the instance doesn't hold (only their build); copy each crate to its path:"
                .into(),
        );
        lines.extend(r.modules.iter().map(|m| format!("  • {m}")));
    }
    if !p.variables.is_empty() {
        lines.push(format!(
            "Script variables, in .env.example without their values: {}",
            p.variables.join(", ")
        ));
    }
    if !r.secrets.is_empty() {
        lines.push("Plugin secrets to set after deploying (none were pulled):".into());
        lines.extend(r.secrets.iter().map(|s| format!("  • {s}")));
    }
    lines.push(
        "[jetstream] is left at its defaults: an instance's JETSTREAM_* settings are environment variables, which pull can't read."
            .into(),
    );
    lines.join("\n")
}

fn report_json(url: &str, dir: &Path, p: &Pulled) -> Value {
    json!({
        "instance": url,
        "dir": dir,
        "happyview": p.happyview,
        "files": p.files.iter().map(|(f, _)| f.to_string_lossy().replace('\\', "/")).collect::<Vec<_>>(),
        "warnings": p.report.warnings,
        "handEdits": p.report.hand_edits,
        "modules": p.report.modules,
        "variables": p.variables,
        "secrets": p.report.secrets,
    })
}

pub async fn run(ctx: &Ctx, args: PullArgs) -> Result<(), Failure> {
    let (admin, generation, served) = connect(ctx, &args).await?;
    let url = admin.base().to_string();
    let dir = ctx.dir.join(
        args.directory
            .clone()
            .unwrap_or_else(|| PathBuf::from(map::default_dir(&url))),
    );
    let existing = dir.join(CONFIG_FILE).is_file();
    if args.diff && !existing {
        return Err(Failure::usage(format!(
            "--diff compares with a project, and {} has no {CONFIG_FILE}",
            dir.display()
        )));
    }
    if existing && !args.diff {
        return Err(Failure::usage(format!(
            "{} is already a project; use --diff to see how the instance differs, or pull into an empty directory",
            dir.display()
        )));
    }

    let pulled = pull(ctx, &admin, generation, served.as_deref()).await?;
    for w in &pulled.report.warnings {
        ctx.out.status(&format!("warning: {w}"));
    }

    if args.dry_run {
        let mut human = format!("Would write {}:\n", dir.display());
        for (f, _) in &pulled.files {
            human.push_str(&format!("  {}\n", f.to_string_lossy().replace('\\', "/")));
        }
        human.push_str(&format!("\n{CONFIG_FILE}:\n{}", pulled.toml));
        let mut out = report_json(&url, &dir, &pulled);
        out["dryRun"] = json!(true);
        out["happyviewToml"] = json!(pulled.toml);
        ctx.out.done(&human, out);
        return Ok(());
    }

    if args.diff {
        let tmp = tempfile::tempdir().map_err(Failure::runtime)?;
        let into = tmp.path().join("pulled");
        write_new(&into, &pulled.files).map_err(Failure::runtime)?;
        let (text, changed) = diff::diff_trees(&dir, &into);
        let human = if changed.is_empty() {
            format!("{} matches {url}", dir.display())
        } else {
            text.trim_end().to_string()
        };
        let mut out = report_json(&url, &dir, &pulled);
        out["changed"] = json!(changed);
        out["diff"] = json!(text);
        ctx.out.done(&human, out);
        return Ok(());
    }

    write_new(&dir, &pulled.files).map_err(Failure::runtime)?;
    if generation == Generation::V3 {
        compare_with_deploy(ctx, &admin, &dir).await;
    }
    ctx.out.done(
        &summary(&url, &dir, &pulled),
        report_json(&url, &dir, &pulled),
    );

    let written = |why: String, code: u8| Failure {
        code: code.max(1),
        report: miette::miette!(
            "{} was written, but {why}; fix what it reports, then run `hpy happyview check` in it",
            dir.display()
        ),
        quiet: false,
    };
    match check(ctx, &dir).await {
        Ok(0) => Ok(()),
        Ok(code) => Err(written(
            "`hpy happyview check` fails on it (above)".into(),
            u8::try_from(code).unwrap_or(1),
        )),
        Err(e) => Err(written(
            format!("`hpy happyview check` couldn't run on it: {}", e.report),
            e.code,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_and_below_is_v2() {
        assert_eq!(generation("2.17.0"), Some(Generation::V2));
        assert_eq!(generation("v2.0.0-beta.3"), Some(Generation::V2));
        assert_eq!(generation("3.0.0-alpha.12"), Some(Generation::V3));
        assert_eq!(generation("dev"), None);
    }
}
