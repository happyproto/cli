//! Everything `dev`, `check` and `test` do before the binary starts: find the
//! project, bring the lock up to date, and put the pinned binary and the
//! locked plugins where they are expected.

use std::path::PathBuf;

use hpy_project::config::{CONFIG_FILE, ProjectToml, find_root};
use hpy_project::lock::Lockfile;
use hpy_project::place::{PlaceMode, Placement, place_plugins};

use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::binary::{self, HOST_TARGET, ReleaseSource};
use crate::project::resolve::{Candidate, Resolver, resolve_lock};
use crate::project::{cache, plugins};

/// Variables removed from the binary's environment. HappyView reads a real
/// `PLUGIN_DIR` before its own default, so an inherited one would load
/// something other than the plugins just placed.
pub const REMOVED_ENV: &[&str] = &["PLUGIN_DIR"];

pub struct PrepareOptions {
    /// Refuse to rewrite a lock that no longer matches, as CI should.
    pub locked: bool,
    pub place: PlaceMode,
    pub target: String,
}

impl PrepareOptions {
    pub fn native(locked: bool) -> PrepareOptions {
        PrepareOptions {
            locked,
            place: PlaceMode::Link,
            target: HOST_TARGET.into(),
        }
    }
}

pub struct Prepared {
    pub root: PathBuf,
    pub binary: PathBuf,
}

pub fn choose_with_prompter(
    ctx: &Ctx,
) -> impl Fn(&str, &[Candidate]) -> Result<usize, Failure> + Sync + '_ {
    move |key: &str, found: &[Candidate]| {
        let labels: Vec<String> = found.iter().map(Candidate::label).collect();
        ctx.prompter.choose(
            "--package <AT-URI> (with `hpy happyview add`)",
            &format!("Several packages answer to `{key}`."),
            &labels,
        )
    }
}

pub async fn prepare(ctx: &Ctx, opts: &PrepareOptions) -> Result<Prepared, Failure> {
    let root = find_root(&ctx.dir).ok_or_else(|| {
        Failure::usage(format!(
            "no {CONFIG_FILE} in {} or any directory above it; start one with `hpy happyview create`",
            ctx.dir.display()
        ))
    })?;
    if std::env::var_os("PLUGIN_DIR").is_some() {
        ctx.out
            .status("warning: ignoring PLUGIN_DIR; hpy runs the plugins locked in happyview.lock");
    }
    let config = ProjectToml::load(&root)?;
    let version = config.happyview_version()?.to_string();
    let previous = Lockfile::load(&root)?;
    let registry = ctx.registry();
    let drift = previous.as_ref().map(|l| l.drift(&config));
    let lock = match (previous, drift) {
        (Some(lock), Some(drift)) if drift.is_empty() => lock,
        (previous, drift) => {
            if opts.locked {
                let why = drift
                    .map(|d| d.join("\n  "))
                    .unwrap_or_else(|| "there is no happyview.lock".into());
                return Err(Failure::usage(format!(
                    "happyview.lock does not match happyview.toml, and --locked forbids updating it:\n  {why}"
                )));
            }
            let choose = choose_with_prompter(ctx);
            let warn = |m: &str| ctx.out.status(&format!("warning: {m}"));
            let r = Resolver {
                registry: &registry,
                choose: &choose,
                warn: &warn,
                pins: Default::default(),
            };
            let lock = resolve_lock(&r, &config, previous.as_ref()).await?;
            lock.write(&root).map_err(Failure::runtime)?;
            ctx.out.status("updated happyview.lock");
            lock
        }
    };
    let cache_root = cache::cache_root()?;
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let http = binary::http_client();
    let binary = binary::ensure_binary(
        &http,
        &ReleaseSource::from_env(&env),
        &cache_root,
        &version,
        &opts.target,
        &|m| ctx.out.status(m),
    )
    .await?;
    let mut placed = Vec::new();
    for p in &lock.plugins {
        placed.push((
            p.id.clone(),
            plugins::ensure_plugin(&registry, &cache_root, p).await?,
        ));
    }
    let placements: Vec<Placement<'_>> = placed
        .iter()
        .map(|(id, dir)| Placement { id, source: dir })
        .collect();
    place_plugins(&root, &placements, opts.place).map_err(Failure::runtime)?;
    Ok(Prepared { root, binary })
}
