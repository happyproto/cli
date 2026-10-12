use serde_json::json;

use crate::channel::Version;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::update::{self, Install};

pub enum Outcome {
    /// The installer put the new version in place of this one.
    Installed,
    /// A package manager owns this copy; this is how to install it there.
    Hint(String),
}

/// Installs `target` over this copy of hpy when the installer put it here,
/// and otherwise answers how to install it with what did.
pub(crate) async fn install(
    ctx: &Ctx,
    target: &Version,
    hint: impl FnOnce(Install) -> String,
) -> Result<Outcome, Failure> {
    let this = update::this_install()
        .ok_or_else(|| Failure::runtime("could not tell where this copy of hpy is installed"))?;
    match (this.install, this.prefix) {
        (Install::Script, Some(prefix)) => {
            ctx.out.status(&format!(
                "Installing hpy {target} into {}…",
                prefix.display()
            ));
            update::self_update(target, &prefix)
                .await
                .map_err(|e| Failure::runtime(update::self_update_failed(target, &e)))?;
            Ok(Outcome::Installed)
        }
        (install, _) => Ok(Outcome::Hint(hint(install))),
    }
}

pub async fn run(ctx: &Ctx) -> Result<(), Failure> {
    let channel = update::following(&ctx.settings.config_dir);
    let current = update::current();
    let releases = update::releases().await.map_err(Failure::runtime)?;
    let Some(latest) = update::available(&current, channel, &releases) else {
        ctx.out.done(
            &format!("hpy {current} is the newest release on the {channel} channel."),
            json!({ "channel": channel, "version": current.to_string(), "updated": false }),
        );
        return Ok(());
    };
    match install(ctx, &latest, |i| update::upgrade_hint(i, channel, &latest)).await? {
        Outcome::Installed => ctx.out.done(
            &format!("Updated hpy {current} → {latest}."),
            json!({ "channel": channel, "version": latest.to_string(), "updated": true }),
        ),
        Outcome::Hint(hint) => ctx.out.done(
            &format!(
                "hpy {latest} is available on the {channel} channel (you have {current}). \
                 Your package manager owns this copy of hpy; to upgrade:\n\n  {hint}"
            ),
            json!({ "channel": channel, "version": latest.to_string(), "updated": false, "hint": hint }),
        ),
    }
    Ok(())
}
