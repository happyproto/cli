use hpy_project::config::ProjectToml;
use hpy_project::lock::{LOCK_FILE, Lockfile};
use serde_json::json;

use crate::cli::DeployArgs;
use crate::commands::happyview::instance;
use crate::ctx::Ctx;
use crate::failure::Failure;
use hpy_atproto::admin::ProjectDeploy;

use crate::commands::happyview::build::build_modules;
use crate::project::bundle::{Bundle, bundle};
use crate::project::deploy::{PluginPlan, PluginStep, Target, plan_plugins};
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

/// The target a step acts on, for the steps that grant capabilities.
fn target(step: &PluginStep) -> Option<&Target> {
    match step {
        PluginStep::Install(t)
        | PluginStep::Move { target: t, .. }
        | PluginStep::Replace { target: t, .. } => Some(t),
        PluginStep::Remove { .. } => None,
    }
}

/// What a step grants, under it, so the capabilities are on screen before the
/// prompt that accepts them.
///
/// A move or a replace also names the ones the installed version did not
/// declare: that difference is what an operator who already agreed to the old
/// version is being asked to agree to now. A fresh install names none of them
/// separately, since every capability it grants is new.
fn capability_lines(step: &PluginStep) -> Vec<String> {
    let Some(t) = target(step) else {
        return Vec::new();
    };
    let declared = t.capabilities.as_deref().unwrap_or_default();
    let mut lines = vec![if declared.is_empty() {
        "      capabilities: none".to_string()
    } else {
        format!("      capabilities: {}", declared.join(", "))
    }];
    if !matches!(step, PluginStep::Install(_)) && !t.new_capabilities.is_empty() {
        lines.push(format!("      new: {}", t.new_capabilities.join(", ")));
    }
    lines
}

/// A deploy accepts each plugin's capabilities on the operator's behalf, so a
/// lock that does not record them cannot be deployed: the set would have to
/// come from whatever the registry serves now, and holding it still is what
/// the lock is for.
fn capabilities_recorded(plan: &PluginPlan) -> Result<(), Failure> {
    let missing: Vec<&str> = plan
        .steps
        .iter()
        .filter_map(target)
        .filter(|t| t.capabilities.is_none())
        .map(|t| t.id.as_str())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(Failure::usage(format!(
        "{LOCK_FILE} does not record the capabilities these plugins declare, so this deploy \
         cannot accept them for you: {}. It was written by an older hpy; run `hpy hv check` to \
         rewrite it, and commit it",
        missing.join(", ")
    )))
}

fn show(ctx: &Ctx, plan: &PluginPlan) {
    if plan.steps.is_empty() {
        ctx.out.status(&format!(
            "Plugins: up to date ({} from {LOCK_FILE})",
            plan.unchanged.len()
        ));
    } else {
        let mut steps = Vec::new();
        for step in &plan.steps {
            steps.push(format!("  • {step}"));
            steps.extend(capability_lines(step));
        }
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

/// A kind of change in the instance's answer, as one thing of that kind is
/// called.
fn singular(kind: &str) -> String {
    match kind {
        "lexicons" => "lexicon".into(),
        "scripts" => "script".into(),
        "modules" => "module".into(),
        "network_lexicons" => "network lexicon".into(),
        "labelers" => "labeler".into(),
        other => other.replace('_', " "),
    }
}

fn show_project(ctx: &Ctx, preview: &ProjectDeploy) {
    let mut lines = Vec::new();
    for (kind, changes) in &preview.changes {
        let what = singular(kind);
        // A declaration dropped from happyview.toml leaves its row behind.
        let kept = matches!(kind.as_str(), "network_lexicons" | "labelers");
        lines.extend(changes.added.iter().map(|id| format!("  + {what} {id}")));
        lines.extend(changes.changed.iter().map(|id| format!("  ~ {what} {id}")));
        lines.extend(changes.removed.iter().map(|id| {
            if kept {
                format!("  - {what} {id} (no longer declared; kept as a dashboard row)")
            } else {
                format!("  - {what} {id}")
            }
        }));
    }
    lines.extend(
        preview
            .backfills
            .iter()
            .map(|nsid| format!("  backfill {nsid}, from the whole network")),
    );
    if lines.is_empty() {
        ctx.out.status("Project: up to date");
    } else {
        ctx.out.status(&format!("Project:\n{}", lines.join("\n")));
    }
    for w in &preview.warnings {
        ctx.out.status(&format!("warning: {w}"));
    }
}

fn project_json(p: &ProjectDeploy) -> serde_json::Value {
    let changes: serde_json::Map<String, serde_json::Value> = p
        .changes
        .iter()
        .map(|(kind, c)| {
            (
                kind.clone(),
                json!({ "added": c.added, "changed": c.changed, "removed": c.removed }),
            )
        })
        .collect();
    let warnings: Vec<String> = p.warnings.iter().map(ToString::to_string).collect();
    json!({
        "sha256": p.sha256,
        "deployedAt": p.deployed_at,
        "changes": changes,
        "backfills": p.backfills,
        "warnings": warnings,
    })
}

/// The project as it is sent: its compiled modules built first.
async fn project_bundle(ctx: &Ctx) -> Result<Bundle, Failure> {
    let root = project_root(ctx)?;
    let built = build_modules(root.clone()).await?;
    let names: Vec<String> = built.into_iter().map(|(name, _)| name).collect();
    bundle(&root, &names)
}

pub async fn run(ctx: &Ctx, args: DeployArgs) -> Result<(), Failure> {
    let lock = committed_lock(ctx)?;
    let bundle = project_bundle(ctx).await?;
    let admin = instance::admin(ctx, &args.instance)?;
    let url = admin.base().to_string();
    let installed = admin.plugins().await?;
    let plan = plan_plugins(&lock.plugins, &installed, args.prune_plugins);
    capabilities_recorded(&plan)?;
    let deployed = admin.project().await?;
    let seen = deployed.as_ref().map(|d| d.sha256.clone());

    ctx.out.status(&format!("Deploying to {url}"));
    if let Some(d) = deployed.as_ref().filter(|d| !d.problems.is_empty()) {
        let problems: Vec<String> = d.problems.iter().map(|p| format!("  • {p}")).collect();
        ctx.out.status(&format!(
            "warning: {url} is serving no project: the one deployed there didn't build when it last started:\n{}",
            problems.join("\n")
        ));
    }
    show(ctx, &plan);

    // The instance checks the project against the plugins it has now. A
    // pending install may be what the project needs, so with one pending a
    // refusal waits for the deploy itself, after the plugins.
    let plugins_pending = plan
        .steps
        .iter()
        .any(|s| !matches!(s, PluginStep::Remove { .. }));
    let preview = match admin
        .deploy_project(bundle.bytes.clone(), true, seen.as_deref())
        .await
    {
        Ok(preview) => {
            show_project(ctx, &preview);
            Some(preview)
        }
        Err(e) if plugins_pending && e.is_usage() => {
            ctx.out.status(&format!(
                "Project: the instance can't check it until the plugins above are installed; \
                 it is checked again when deployed, after the plugins. As it stands:\n{e}"
            ));
            None
        }
        Err(e) => return Err(e.into()),
    };

    if args.dry_run {
        ctx.out.done(
            "Dry run: nothing was changed.",
            json!({
                "instance": url,
                "dryRun": true,
                "plugins": { "planned": labels(&plan.steps), "unchanged": plan.unchanged, "kept": plan.kept },
                "project": preview.as_ref().map(project_json),
            }),
        );
        return Ok(());
    }
    // Unchanged only when the instance already serves these exact bytes: an
    // empty diff alone may be a first deploy, or a change only to tests.
    let project_unchanged = preview
        .as_ref()
        .is_some_and(|p| p.is_empty() && seen.as_deref() == Some(p.sha256.as_str()));
    if plan.steps.is_empty() && project_unchanged {
        ctx.out.done(
            &format!("{url} is up to date"),
            json!({
                "instance": url,
                "dryRun": false,
                "plugins": { "applied": [], "unchanged": plan.unchanged, "kept": plan.kept },
                "project": preview.as_ref().map(project_json),
            }),
        );
        return Ok(());
    }
    if !ctx
        .prompter
        .confirm(&format!("Apply these changes to {url}?"), args.yes)?
    {
        return Err(Failure::runtime("cancelled"));
    }

    let mut applied = Vec::new();
    let stopped = |e: hpy_atproto::Error, applied: &[PluginStep]| {
        let done = if applied.is_empty() {
            "nothing".to_string()
        } else {
            labels(applied).join(", ")
        };
        let mut failure = Failure::from(e);
        failure.report = miette::miette!("{}\nDone before it stopped: {done}", failure.report);
        failure
    };
    for step in &plan.steps {
        let result = match step {
            PluginStep::Install(t) | PluginStep::Replace { target: t, .. } => admin
                .install(
                    &t.did,
                    &t.name,
                    &t.version,
                    t.capabilities.as_deref().unwrap_or_default(),
                )
                .await
                .map(drop),
            PluginStep::Move { target, .. } => {
                admin
                    .reload(
                        &target.id,
                        &target.version,
                        target.capabilities.as_deref().unwrap_or_default(),
                    )
                    .await
            }
            PluginStep::Remove { id } => admin.remove(id).await,
        };
        if let Err(e) = result {
            return Err(stopped(e, &applied));
        }
        ctx.out.status(&format!("  ✓ {step}"));
        applied.push(step.clone());
    }
    let project = if project_unchanged {
        preview
    } else {
        let done = admin
            .deploy_project(bundle.bytes, false, seen.as_deref())
            .await
            .map_err(|e| stopped(e, &applied))?;
        if preview.is_none() {
            show_project(ctx, &done);
        }
        let short: String = done.sha256.chars().take(12).collect();
        ctx.out.status(&format!("  ✓ project {short}"));
        Some(done)
    };
    ctx.out.done(
        &format!("Deployed to {url}"),
        json!({
            "instance": url,
            "dryRun": false,
            "plugins": { "applied": labels(&applied), "unchanged": plan.unchanged, "kept": plan.kept },
            "project": project.as_ref().map(project_json),
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, capabilities: Option<&[&str]>, new: &[&str]) -> Target {
        Target {
            id: id.into(),
            did: "did:plc:pub".into(),
            name: id.into(),
            version: "1.0.0".into(),
            capabilities: capabilities.map(|c| c.iter().map(|c| c.to_string()).collect::<Vec<_>>()),
            new_capabilities: new.iter().map(|c| c.to_string()).collect(),
        }
    }

    fn plan(steps: Vec<PluginStep>) -> PluginPlan {
        PluginPlan {
            steps,
            ..PluginPlan::default()
        }
    }

    #[test]
    fn a_lock_recording_every_plugins_capabilities_is_accepted() {
        let p = plan(vec![
            PluginStep::Install(target("lua", Some(&["kv:read"]), &[])),
            PluginStep::Remove { id: "old".into() },
        ]);
        assert!(capabilities_recorded(&p).is_ok());
    }

    /// Named, because the operator has to know which plugins to re-resolve,
    /// and told what to run rather than only what is wrong.
    #[test]
    fn a_lock_missing_them_is_refused_and_names_the_plugins() {
        let p = plan(vec![
            PluginStep::Install(target("lua", None, &[])),
            PluginStep::Move {
                target: target("std", None, &[]),
                from: "1.0.0".into(),
            },
            PluginStep::Install(target("http", Some(&["kv:read"]), &[])),
        ]);
        let err = capabilities_recorded(&p).unwrap_err();
        assert_eq!(err.code, 2);
        let text = err.report.to_string();
        assert!(text.contains("lua"), "{text}");
        assert!(text.contains("std"), "{text}");
        assert!(!text.contains("http"), "{text}");
        assert!(text.contains("hpy hv check"), "{text}");
    }

    /// A removal grants nothing, so an unrecorded entry cannot block one.
    #[test]
    fn a_removal_needs_no_capabilities() {
        let p = plan(vec![PluginStep::Remove { id: "old".into() }]);
        assert!(capabilities_recorded(&p).is_ok());
    }

    #[test]
    fn an_install_lists_what_it_grants() {
        let lines = capability_lines(&PluginStep::Install(target(
            "lua",
            Some(&["kv:read", "database:write"]),
            &[],
        )));
        assert_eq!(lines, ["      capabilities: kv:read, database:write"]);
    }

    /// Said rather than left blank: a plugin that asks for nothing is worth
    /// seeing, and a missing line reads as a missing answer.
    #[test]
    fn a_plugin_granting_nothing_says_so() {
        let lines = capability_lines(&PluginStep::Install(target("plain", Some(&[]), &[])));
        assert_eq!(lines, ["      capabilities: none"]);
    }

    #[test]
    fn a_move_lists_the_new_ones_separately() {
        let lines = capability_lines(&PluginStep::Move {
            target: target(
                "lua",
                Some(&["kv:read", "database:write"]),
                &["database:write"],
            ),
            from: "1.0.0".into(),
        });
        assert_eq!(
            lines,
            [
                "      capabilities: kv:read, database:write",
                "      new: database:write"
            ]
        );
    }

    #[test]
    fn a_removal_lists_nothing() {
        assert!(capability_lines(&PluginStep::Remove { id: "old".into() }).is_empty());
    }
}
