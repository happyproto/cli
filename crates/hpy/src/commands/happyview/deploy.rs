use hpy_project::config::ProjectToml;
use hpy_project::lock::{LOCK_FILE, Lockfile};
use serde_json::json;

use crate::cli::DeployArgs;
use crate::commands::happyview::instance;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::deploy::{PluginPlan, PluginStep, plan_plugins};
use crate::project::prepare::project_root;

/// The lock as committed. A deploy installs exactly what it pins, so one
/// that no longer matches `happyview.toml` is refused, never re-resolved.
fn committed_lock(ctx: &Ctx) -> Result<Lockfile, Failure> {
    let root = project_root(ctx)?;
    let config = ProjectToml::load(&root)?;
    let lock = Lockfile::load(&root)?.ok_or_else(|| {
        Failure::usage(format!(
            "there is no {LOCK_FILE}; run `hpy hv check` to write it, and commit it"
        ))
    })?;
    let drift = lock.drift(&config);
    if !drift.is_empty() {
        return Err(Failure::usage(format!(
            "{LOCK_FILE} does not match happyview.toml; run `hpy hv add` to update it:\n  {}",
            drift.join("\n  ")
        )));
    }
    Ok(lock)
}

fn show(ctx: &Ctx, plan: &PluginPlan) {
    if plan.steps.is_empty() {
        ctx.out.status(&format!(
            "Plugins: up to date ({} from {LOCK_FILE})",
            plan.unchanged.len()
        ));
    } else {
        let steps: Vec<String> = plan.steps.iter().map(|s| format!("  • {s}")).collect();
        ctx.out.status(&format!("Plugins:\n{}", steps.join("\n")));
    }
    if !plan.kept.is_empty() {
        ctx.out.status(&format!(
            "Kept, though {LOCK_FILE} doesn't list them: {} (uninstall them with --prune-plugins)",
            plan.kept.join(", ")
        ));
    }
}

fn labels(steps: &[PluginStep]) -> Vec<String> {
    steps.iter().map(ToString::to_string).collect()
}

pub async fn run(ctx: &Ctx, args: DeployArgs) -> Result<(), Failure> {
    let lock = committed_lock(ctx)?;
    let admin = instance::admin(ctx, &args.instance)?;
    let url = admin.base().to_string();
    let installed = admin.plugins().await?;
    let plan = plan_plugins(&lock.plugins, &installed, args.prune_plugins);
    ctx.out.status(&format!("Deploying to {url}"));
    show(ctx, &plan);

    if args.dry_run {
        ctx.out.done(
            "Dry run: nothing was changed.",
            json!({
                "instance": url,
                "dryRun": true,
                "plugins": { "planned": labels(&plan.steps), "unchanged": plan.unchanged, "kept": plan.kept },
            }),
        );
        return Ok(());
    }
    if !plan.steps.is_empty()
        && !ctx
            .prompter
            .confirm(&format!("Apply these changes to {url}?"), args.yes)?
    {
        return Err(Failure::runtime("cancelled"));
    }

    let mut applied = Vec::new();
    for step in &plan.steps {
        let result = match step {
            PluginStep::Install(t) | PluginStep::Replace { target: t, .. } => {
                admin.install(&t.did, &t.name, &t.version).await.map(drop)
            }
            PluginStep::Move { target, .. } => admin.reload(&target.id, &target.version).await,
            PluginStep::Remove { id } => admin.remove(id).await,
        };
        if let Err(e) = result {
            let done = if applied.is_empty() {
                "nothing".to_string()
            } else {
                labels(&applied).join(", ")
            };
            let mut failure = Failure::from(e);
            failure.report = miette::miette!("{}\nDone before it stopped: {done}", failure.report);
            return Err(failure);
        }
        ctx.out.status(&format!("  ✓ {step}"));
        applied.push(step.clone());
    }
    ctx.out.done(
        &format!("Deployed to {url}"),
        json!({
            "instance": url,
            "dryRun": false,
            "plugins": { "applied": labels(&applied), "unchanged": plan.unchanged, "kept": plan.kept },
        }),
    );
    Ok(())
}
