use std::ffi::OsString;

use crate::cli::{RunArgs, TestArgs};
use crate::commands::happyview::build::build_modules;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::editor::{languages, write_editor_config};
use crate::project::modules::{Snapshot, read_modules};
use crate::project::prepare::{PrepareOptions, REMOVED_ENV, prepare, project_root};
use crate::project::run::{finish, run_foreground, run_rebuilding_modules};

/// Point editors at the types HappyView writes, for the interpreters the
/// project has, reporting each settings file written or left to the author.
pub fn point_editors_at_types(ctx: &Ctx, root: &std::path::Path) -> Result<(), Failure> {
    for line in write_editor_config(root, &languages(root)).map_err(Failure::runtime)? {
        ctx.out.status(&line);
    }
    Ok(())
}

// `happyview check` reads a `.env` from its working directory, which is the
// project root here.
pub async fn check(ctx: &Ctx, args: RunArgs) -> Result<(), Failure> {
    // HappyView reads the modules from their build files, so they are built
    // first; one that does not compile fails before anything is fetched.
    build_modules(project_root(ctx)?).await?;
    let p = prepare(ctx, &PrepareOptions::native(args.locked)).await?;
    finish(
        run_foreground(
            &p.binary,
            &["check".into(), ".".into()],
            &p.root,
            &[],
            REMOVED_ENV,
        )
        .await?,
    )
}

pub async fn test(ctx: &Ctx, args: TestArgs) -> Result<(), Failure> {
    let root = project_root(ctx)?;
    // Before the build, so a save made while it runs is rebuilt.
    let from = if args.watch {
        Some(Snapshot::take(&root, read_modules(&root)?))
    } else {
        None
    };
    // A run against a stale build would test code other than the source.
    build_modules(root).await?;
    let p = prepare(ctx, &PrepareOptions::native(args.run.locked)).await?;
    let mut argv: Vec<OsString> = vec!["test".into(), ".".into()];
    if args.watch {
        argv.push("--watch".into());
    }
    if let Some(filter) = args.filter {
        argv.push(filter.into());
    }
    let Some(from) = from else {
        return finish(run_foreground(&p.binary, &argv, &p.root, &[], REMOVED_ENV).await?);
    };
    // HappyView re-runs the tests when a module's build file changes, so
    // keeping the builds current is what makes a source edit re-run them.
    finish(run_rebuilding_modules(&p.binary, &argv, &p.root, from).await?)
}

pub async fn types(ctx: &Ctx, args: RunArgs) -> Result<(), Failure> {
    // The build reads the modules' build files, as `check`'s does.
    build_modules(project_root(ctx)?).await?;
    let p = prepare(ctx, &PrepareOptions::native(args.locked)).await?;
    // Before the binary, which replaces hpy on unix; the settings name the
    // directories, not what is in them.
    point_editors_at_types(ctx, &p.root)?;
    finish(
        run_foreground(
            &p.binary,
            &["types".into(), ".".into()],
            &p.root,
            &[],
            REMOVED_ENV,
        )
        .await?,
    )
}
