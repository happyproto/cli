use std::time::Duration;

use hpy_atproto::Registry;
use serde_json::json;

use crate::cli::RetryArgs;
use crate::commands::profile::resolve_slug;
use crate::commands::publish::{Timing, wait_for_active};
use crate::ctx::Ctx;
use crate::failure::Failure;

/// Asks the registry to copy a pending release's artifact again, and answers
/// the release's status: `pending` when it did, `active` when there was
/// nothing to copy.
pub async fn retry(registry: &dyn Registry, slug: &str, version: &str) -> Result<String, Failure> {
    registry.retry_release(slug, version).await?.ok_or_else(|| {
        Failure::usage(format!(
            "{slug} {version} is not published from your account, or was withdrawn"
        ))
    })
}

pub async fn run(ctx: &Ctx, args: RetryArgs) -> Result<(), Failure> {
    let slug = resolve_slug(&ctx.dir, args.slug.slug)?;
    let session = ctx.session()?;
    let registry = session.registry();
    let mut status = retry(&registry, &slug, &args.version).await?;
    let message = if status == "active" {
        format!(
            "{slug} {} is already active; there is nothing to retry",
            args.version
        )
    } else if args.wait {
        let timing = Timing {
            poll: Duration::from_secs(3),
            limit: Duration::from_secs(120),
        };
        let report = |msg: &str| ctx.out.status(msg);
        status = wait_for_active(
            &registry,
            session.repo.did(),
            &slug,
            &args.version,
            &timing,
            &report,
        )
        .await;
        format!("Retried the copy of {slug} {}: {status}", args.version)
    } else {
        format!(
            "Retrying the copy of {slug} {v}; `hpy registry plugin status {v}` shows when it is active",
            v = args.version
        )
    };
    ctx.out.done(
        &message,
        json!({ "slug": slug, "version": args.version, "registryStatus": status }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRegistry;

    #[tokio::test]
    async fn retries_a_pending_release() {
        let registry = FakeRegistry::with_release("1.0.0", "pending");
        assert_eq!(retry(&registry, "p", "1.0.0").await.unwrap(), "pending");
        assert_eq!(*registry.retried.lock().unwrap(), ["1.0.0"]);
    }

    #[tokio::test]
    async fn an_active_release_has_nothing_to_retry() {
        let registry = FakeRegistry::with_release("1.0.0", "active");
        assert_eq!(retry(&registry, "p", "1.0.0").await.unwrap(), "active");
        assert!(registry.retried.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_version_not_published_from_this_account_is_refused() {
        let registry = FakeRegistry::default();
        let err = retry(&registry, "p", "9.9.9").await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("not published"));
    }
}
