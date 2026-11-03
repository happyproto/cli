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

/// The flag `create` and `add` take to decide among several projects.
pub const PROJECT_FLAG: &str = "--project <AT-URI>";

/// Asks which of several projects answering one key to use; without a
/// terminal, the error names `--project` as what decides.
pub fn choose_with_prompter(
    ctx: &Ctx,
) -> impl Fn(&str, &[Candidate]) -> Result<usize, Failure> + Sync + '_ {
    move |key: &str, found: &[Candidate]| {
        let labels: Vec<String> = found.iter().map(Candidate::label).collect();
        ctx.prompter.choose(
            PROJECT_FLAG,
            &format!("Several projects answer to `{key}`."),
            &labels,
        )
    }
}

/// The directory holding `happyview.toml`, found from the working directory
/// upwards.
pub fn project_root(ctx: &Ctx) -> Result<PathBuf, Failure> {
    find_root(&ctx.dir).ok_or_else(|| {
        Failure::usage(format!(
            "no {CONFIG_FILE} in {} or any directory above it; start one with `hpy happyview create`",
            ctx.dir.display()
        ))
    })
}

/// Why `--locked` cannot go on. Not always a mismatch: a lock from before hpy
/// recorded plugin capabilities has to be rewritten too, and telling a reader
/// it does not match `happyview.toml` would send them to a file that is fine.
fn locked_refusal(drift: Option<&[String]>, unrecorded: &[String]) -> String {
    match drift {
        None => "there is no happyview.lock".into(),
        Some(d) if !d.is_empty() => format!(
            "happyview.lock does not match happyview.toml, and --locked forbids updating it:\n  {}",
            d.join("\n  ")
        ),
        Some(_) => format!(
            "happyview.lock records no capabilities for {}, and --locked forbids updating it. It \
             was written by an hpy from before a deploy accepted them: run `hpy happyview check` \
             once without --locked, then commit the rewritten happyview.lock",
            unrecorded.join(", ")
        ),
    }
}

pub async fn prepare(ctx: &Ctx, opts: &PrepareOptions) -> Result<Prepared, Failure> {
    let root = project_root(ctx)?;
    if std::env::var_os("PLUGIN_DIR").is_some() {
        ctx.out
            .status("warning: ignoring PLUGIN_DIR; hpy runs the plugins locked in happyview.lock");
    }
    let config = ProjectToml::load(&root)?;
    let version = config.happyview_version()?.to_string();
    let previous = Lockfile::load(&root)?;
    let registry = ctx.registry();
    let drift = previous.as_ref().map(|l| l.drift(&config));
    // A lock recording no capabilities for a plugin is rewritten as well,
    // though it matches happyview.toml: a deploy accepts the capabilities the
    // lock records and cannot accept a set that is not there. Re-resolving
    // passes the previous lock, so the versions it pins do not move.
    let unrecorded: Vec<String> = previous
        .as_ref()
        .map(|l| {
            l.unrecorded_capabilities()
                .into_iter()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let lock = match (previous, drift) {
        (Some(lock), Some(drift)) if drift.is_empty() && unrecorded.is_empty() => lock,
        (previous, drift) => {
            if opts.locked {
                return Err(Failure::usage(locked_refusal(
                    drift.as_deref(),
                    &unrecorded,
                )));
            }
            let warn = |m: &str| ctx.out.status(&format!("warning: {m}"));
            let r = Resolver {
                registry: &registry,
                warn: &warn,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_lock_at_all_says_so() {
        assert_eq!(locked_refusal(None, &[]), "there is no happyview.lock");
    }

    #[test]
    fn a_mismatch_is_reported_as_one() {
        let text = locked_refusal(Some(&["lua is not in the lock".to_string()]), &[]);
        assert!(text.contains("does not match happyview.toml"), "{text}");
        assert!(text.contains("lua is not in the lock"), "{text}");
    }

    /// A lock that matches happyview.toml but records no capabilities is not a
    /// mismatch, and must not be reported as one: the reader would go looking
    /// at a file that is correct.
    #[test]
    fn an_unrecorded_lock_is_not_reported_as_a_mismatch() {
        let text = locked_refusal(Some(&[]), &["lua".to_string(), "std".to_string()]);
        assert!(!text.contains("does not match"), "{text}");
        assert!(
            text.contains("records no capabilities for lua, std"),
            "{text}"
        );
        assert!(text.contains("hpy happyview check"), "{text}");
    }
}
