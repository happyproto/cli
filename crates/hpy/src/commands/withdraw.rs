use hpy_atproto::Registry;
use serde_json::json;

use crate::cli::WithdrawArgs;
use crate::commands::profile::resolve_slug;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub async fn withdraw(registry: &dyn Registry, slug: &str, version: &str) -> Result<(), Failure> {
    if !registry.withdraw_release(slug, version).await? {
        return Err(Failure::usage(format!(
            "{slug} {version} is not published from your account"
        )));
    }
    Ok(())
}

pub async fn run(ctx: &Ctx, args: WithdrawArgs) -> Result<(), Failure> {
    let slug = resolve_slug(&ctx.dir, args.slug.slug)?;
    if !args.yes && !ctx.prompter.is_interactive() {
        return Err(Failure::usage("pass --yes to withdraw without a terminal"));
    }
    let session = ctx.session()?;
    ctx.out.status(&format!(
        "Withdrawing {slug} {v} removes it from search and dependency resolution. It stays installable by exact\n\
         version, and {v} can NEVER be published again.",
        v = args.version
    ));
    if !args.yes {
        let typed = inquire::Text::new(&format!("Type {} to confirm:", args.version))
            .prompt()
            .map_err(|_| Failure::runtime("cancelled"))?;
        if typed.trim() != args.version {
            return Err(Failure::runtime("cancelled"));
        }
    }
    withdraw(&session.registry(), &slug, &args.version).await?;
    ctx.out.done(
        &format!("Withdrew {slug} {}", args.version),
        json!({ "slug": slug, "version": args.version, "withdrawn": true }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRegistry;

    #[tokio::test]
    async fn withdraws_through_the_registry_and_refuses_missing() {
        let registry = FakeRegistry::with_release("1.0.0", "active");
        withdraw(&registry, "p", "1.0.0").await.unwrap();
        assert!(registry.releases.lock().unwrap().is_empty());
        let err = withdraw(&registry, "p", "1.0.0").await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("not published"));
    }
}
