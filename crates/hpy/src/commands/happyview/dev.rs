use crate::cli::{DevArgs, Network};
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::prepare::{PrepareOptions, REMOVED_ENV, prepare};
use crate::project::run::{finish, run_foreground};

pub async fn run(ctx: &Ctx, args: DevArgs) -> Result<(), Failure> {
    if args.network == Network::Local {
        #[cfg(unix)]
        return super::network::run_local(ctx, args).await;
        // Nothing here has been verified on Windows, and Docker Desktop's
        // path translation for the project's bind mount is untested.
        #[cfg(not(unix))]
        return Err(Failure::usage(
            "--network local runs on macOS and Linux only for now",
        ));
    }
    // clap's `requires` cannot name a value of `--network`.
    if args.reset {
        return Err(Failure::usage("--reset applies only to --network local"));
    }
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
