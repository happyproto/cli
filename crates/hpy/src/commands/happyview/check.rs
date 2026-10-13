use std::ffi::OsString;

use crate::cli::{RunArgs, TestArgs};
use crate::commands::happyview::build::build_modules;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::prepare::{PrepareOptions, REMOVED_ENV, prepare, project_root};
use crate::project::run::{finish, run_foreground};

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
    // A run against a stale build would test code other than the source.
    build_modules(project_root(ctx)?).await?;
    let p = prepare(ctx, &PrepareOptions::native(args.run.locked)).await?;
    let mut argv: Vec<OsString> = vec!["test".into(), ".".into()];
    if args.watch {
        argv.push("--watch".into());
    }
    if let Some(filter) = args.filter {
        argv.push(filter.into());
    }
    finish(run_foreground(&p.binary, &argv, &p.root, &[], REMOVED_ENV).await?)
}
