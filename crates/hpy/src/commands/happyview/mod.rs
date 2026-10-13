pub mod check;

use crate::cli::HappyviewCommand;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub async fn run(ctx: &Ctx, command: HappyviewCommand) -> Result<(), Failure> {
    match command {
        HappyviewCommand::Check(a) => check::check(ctx, a).await,
        HappyviewCommand::Test(a) => check::test(ctx, a).await,
    }
}
