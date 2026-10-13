use crate::cli::DevArgs;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::prepare::{PrepareOptions, REMOVED_ENV, prepare};
use crate::project::run::{finish, run_foreground};

pub async fn run(ctx: &Ctx, args: DevArgs) -> Result<(), Failure> {
    let p = prepare(ctx, &PrepareOptions::native(args.run.locked)).await?;
    finish(
        run_foreground(
            &p.binary,
            &["dev".into(), ".".into()],
            &p.root,
            &[],
            REMOVED_ENV,
        )
        .await?,
    )
}
