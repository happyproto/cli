pub mod add;
pub mod build;
pub mod check;
pub mod create;
pub mod dev;
#[cfg(unix)]
pub mod network;

use crate::cli::HappyviewCommand;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub async fn run(ctx: &Ctx, command: HappyviewCommand) -> Result<(), Failure> {
    match command {
        HappyviewCommand::Create(a) => create::run(ctx, a).await,
        HappyviewCommand::Dev(a) => dev::run(ctx, a).await,
        HappyviewCommand::Add(a) => add::run(ctx, a).await,
        HappyviewCommand::Build => build::run(ctx).await,
        HappyviewCommand::Check(a) => check::check(ctx, a).await,
        HappyviewCommand::Test(a) => check::test(ctx, a).await,
        HappyviewCommand::Types(a) => check::types(ctx, a).await,
    }
}
