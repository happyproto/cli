use serde_json::json;

use crate::channel::{self, Channel, Release, Version};
use crate::cli::ChannelArgs;
use crate::commands::update::{Outcome, install};
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::update;

/// What switching to a channel would install, and what to warn about first.
pub struct Plan {
    pub target: Version,
    pub warnings: Vec<String>,
}

pub fn plan(current: &Version, to: Channel, releases: &[Release]) -> Result<Plan, Failure> {
    let target = channel::latest_on(to, releases)
        .ok_or_else(|| Failure::runtime(format!("no {to} releases have been published yet")))?;
    let mut warnings = Vec::new();
    if to.is_prerelease() {
        warnings.push(format!(
            "The {to} channel gets prereleases. They can be unstable: commands and their \
             output may change or break from one release to the next."
        ));
    }
    if &target < current {
        warnings.push(format!(
            "The newest {to} release, {target}, is older than the hpy you have ({current}). \
             Switching installs the older version."
        ));
    }
    Ok(Plan { target, warnings })
}

fn record(file: &std::path::Path, channel: Channel) -> Result<(), Failure> {
    channel::write(file, channel).map_err(|e| {
        Failure::runtime(format!(
            "could not save the channel to {}: {e}",
            file.display()
        ))
    })
}

pub async fn run(ctx: &Ctx, args: ChannelArgs) -> Result<(), Failure> {
    let file = update::channel_file(&ctx.settings.config_dir);
    let chosen = channel::read(&file);
    let current = update::current();
    let from = channel::effective(chosen, &current);

    let Some(to) = args.channel else {
        let how = if chosen.is_some() {
            "chosen with `hpy channel`"
        } else {
            "the channel this version of hpy came from"
        };
        ctx.out.done(
            &format!("{from} ({how})"),
            json!({ "channel": from, "chosen": chosen.is_some(), "version": current.to_string() }),
        );
        return Ok(());
    };

    if to == from {
        // Recorded anyway, so the choice outlives a reinstall from elsewhere.
        record(&file, to)?;
        ctx.out.done(
            &format!("Already on the {to} channel."),
            json!({ "channel": to, "switched": false }),
        );
        return Ok(());
    }

    let releases = update::releases().await.map_err(Failure::runtime)?;
    let plan = plan(&current, to, &releases)?;
    for warning in &plan.warnings {
        ctx.out.status(&format!("warning: {warning}"));
    }
    if !plan.warnings.is_empty()
        && !ctx
            .prompter
            .confirm(&format!("Switch to the {to} channel?"), args.yes)?
    {
        return Err(Failure::runtime("cancelled"));
    }
    record(&file, to)?;

    let target = &plan.target;
    if target == &current {
        ctx.out.done(
            &format!("Switched to the {to} channel. hpy {current} is already its newest release."),
            json!({ "channel": to, "switched": true, "version": target.to_string(), "installed": false }),
        );
        return Ok(());
    }
    match install(ctx, target, |i| update::switch_hint(i, from, to, target)).await? {
        Outcome::Installed => ctx.out.done(
            &format!("Switched to the {to} channel and installed hpy {target}."),
            json!({ "channel": to, "switched": true, "version": target.to_string(), "installed": true }),
        ),
        Outcome::Hint(hint) => ctx.out.done(
            &format!(
                "Switched to the {to} channel. Your package manager owns this copy of hpy; \
                 to install hpy {target} from the {to} channel:\n\n  {hint}"
            ),
            json!({ "channel": to, "switched": true, "version": target.to_string(), "installed": false, "hint": hint }),
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::Release;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn releases(tags: &[&str]) -> Vec<Release> {
        tags.iter()
            .map(|t| Release {
                tag: t.to_string(),
                draft: false,
            })
            .collect()
    }

    #[test]
    fn a_channel_with_no_releases_cannot_be_switched_to() {
        let err = plan(&v("1.0.0"), Channel::Beta, &releases(&["v1.0.0"]))
            .err()
            .unwrap();
        assert!(format!("{:?}", err.report).contains("no beta releases"));
    }

    #[test]
    fn a_prerelease_channel_warns_that_it_is_unstable() {
        let p = plan(
            &v("1.0.0"),
            Channel::Alpha,
            &releases(&["v1.0.0", "v1.1.0-alpha.1", "v1.1.0-alpha.2"]),
        )
        .unwrap();
        assert_eq!(p.target, v("1.1.0-alpha.2"));
        assert_eq!(p.warnings.len(), 1);
        assert!(p.warnings[0].contains("unstable"), "{:?}", p.warnings);
    }

    #[test]
    fn a_channel_whose_newest_is_older_warns_of_the_downgrade() {
        let p = plan(
            &v("1.1.0-alpha.2"),
            Channel::Stable,
            &releases(&["v1.0.0", "v1.1.0-alpha.2"]),
        )
        .unwrap();
        assert_eq!(p.target, v("1.0.0"));
        assert_eq!(p.warnings.len(), 1);
        assert!(p.warnings[0].contains("older"), "{:?}", p.warnings);
    }

    #[test]
    fn a_newer_stable_needs_no_warning() {
        let p = plan(
            &v("1.0.0-alpha.2"),
            Channel::Stable,
            &releases(&["v1.0.0", "v1.0.0-alpha.2"]),
        )
        .unwrap();
        assert_eq!(p.target, v("1.0.0"));
        assert!(p.warnings.is_empty());
    }
}
