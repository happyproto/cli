use hpy_atproto::credential::{self, Credential, Identity, Saved};
use hpy_atproto::happyview::HappyView;
use hpy_atproto::login::{self, LoginOptions};
use hpy_atproto::resolve::NetworkResolver;
use serde_json::json;

use crate::cli::LoginArgs;
use crate::ctx::Ctx;
use crate::failure::Failure;

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn no_env(_: &str) -> Option<String> {
    None
}

fn who(did: &str, handle: Option<&str>) -> String {
    match handle {
        Some(h) => format!("@{h} ({did})"),
        None => did.to_string(),
    }
}

fn describe(i: &Identity) -> serde_json::Value {
    json!({ "did": i.did, "handle": i.handle, "pds": i.pds, "registry": i.registry, "keyStorage": i.storage })
}

async fn revoke(c: &Credential) {
    // Best effort: the local copy is forgotten either way.
    let _ = HappyView::new(&c.registry, &c.client_key).revoke(c).await;
}

pub async fn login(ctx: &Ctx, args: LoginArgs) -> Result<(), Failure> {
    let identifier = ctx.prompter.required(
        "<IDENTIFIER>",
        "Handle or DID:",
        args.identifier,
        None,
        |s| {
            if s.trim().is_empty() {
                Err("required".into())
            } else {
                Ok(())
            }
        },
    )?;
    let hv = HappyView::new(&ctx.settings.registry_url, &ctx.settings.client_key);
    let show = |url: &str| {
        eprintln!("Open this URL to authorize hpy:\n\n  {url}\n");
        eprintln!("Waiting for you to authorize hpy in your browser…");
    };
    let cred = login::login(
        &ctx.settings,
        &NetworkResolver::default(),
        &hv,
        LoginOptions {
            identifier: &identifier,
            open_browser: !args.no_browser,
            show_url: &show,
        },
    )
    .await?;
    let name = who(&cred.did, cred.handle.as_deref());

    if args.export {
        ctx.out.status(&format!(
            "Signed in as {name} for CI. Store the credential below as the HPY_CREDENTIAL secret; \
             it acts as you. Revoke it with `HPY_CREDENTIAL=… hpy registry logout`."
        ));
        let exported = credential::export(&cred);
        ctx.out.done(
            &exported,
            json!({ "did": cred.did, "handle": cred.handle, "credential": exported }),
        );
        return Ok(());
    }

    // Replace, don't accumulate: sign the previous session out first.
    if let Ok(Some(previous)) = credential::load(&ctx.settings, ctx.keystore(), &no_env) {
        revoke(&previous).await;
    }
    let _ = credential::remove(&ctx.settings, ctx.keystore());
    match credential::save(&ctx.settings, &cred, ctx.keystore())? {
        Saved::Keychain => {}
        Saved::File { reason: Some(reason) } => ctx.out.status(&format!(
            "Your OS keychain isn't available ({reason}), so your key is stored in {}, readable only by you.",
            ctx.settings.credentials_file().display()
        )),
        Saved::File { reason: None } => {}
    }
    let identity = credential::peek(&ctx.settings, &no_env)?
        .ok_or_else(|| Failure::runtime("the login was not saved"))?;
    ctx.out
        .done(&format!("Logged in as {name}"), describe(&identity));
    Ok(())
}

pub async fn logout(ctx: &Ctx) -> Result<(), Failure> {
    if let Some(exported) = env(credential::ENV_VAR) {
        let c = credential::import(&exported)?;
        let name = who(&c.did, c.handle.as_deref());
        // Logging out is idempotent: a session HappyView no longer knows is
        // already as revoked as it gets.
        let message = match HappyView::new(&c.registry, &c.client_key).revoke(&c).await {
            Ok(()) => format!("Revoked the HPY_CREDENTIAL session for {name}"),
            Err(e) if e.is_auth() => {
                format!("The HPY_CREDENTIAL session for {name} was already revoked")
            }
            Err(e) => return Err(e.into()),
        };
        ctx.out.done(&message, json!({ "revoked": c.did }));
        return Ok(());
    }
    if let Ok(Some(c)) = credential::load(&ctx.settings, ctx.keystore(), &no_env) {
        revoke(&c).await;
    }
    match credential::remove(&ctx.settings, ctx.keystore())? {
        Some(i) => ctx.out.done(
            &format!("Logged out {}", who(&i.did, i.handle.as_deref())),
            json!({ "loggedOut": i.did }),
        ),
        None => ctx.out.done("Not logged in.", json!({ "loggedOut": null })),
    }
    Ok(())
}

pub async fn whoami(ctx: &Ctx) -> Result<(), Failure> {
    let identity = credential::peek(&ctx.settings, &env)?.ok_or_else(Failure::not_logged_in)?;
    let storage = match identity.storage {
        "keychain" => "key in the OS keychain",
        "file" => "key in the credentials file",
        _ => "from HPY_CREDENTIAL",
    };
    ctx.out.done(
        &format!(
            "{} on {} ({storage})",
            who(&identity.did, identity.handle.as_deref()),
            identity.pds
        ),
        describe(&identity),
    );
    Ok(())
}
