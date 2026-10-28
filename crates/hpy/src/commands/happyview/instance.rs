use std::io::BufRead;

use hpy_atproto::admin::Admin;
use hpy_atproto::credential::Saved;
use hpy_atproto::instance::{self, Info};
use serde_json::json;

use crate::cli::{InstanceArgs, InstanceLoginArgs};
use crate::ctx::Ctx;
use crate::failure::Failure;

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn describe(i: &Info) -> serde_json::Value {
    json!({ "url": i.url, "keyPrefix": i.key_prefix, "keyStorage": i.storage })
}

/// The admin API of the instance `args` names, signed in.
pub fn admin(ctx: &Ctx, args: &InstanceArgs) -> Result<Admin, Failure> {
    let login = instance::current(&ctx.settings, ctx.keystore(), &env, args.url.as_deref())?;
    Ok(Admin::new(&login.url, &login.key))
}

pub async fn login(ctx: &Ctx, args: InstanceLoginArgs) -> Result<(), Failure> {
    let url = ctx
        .prompter
        .required("--url", "Instance URL:", args.url, None, |s| {
            instance::normalize_url(s)
                .map(|_| ())
                .map_err(|e| e.to_string())
        })?;
    let url = instance::normalize_url(&url)?;
    let key = if args.key_stdin {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(Failure::runtime)?;
        line
    } else {
        ctx.prompter.secret(
            "--key-stdin, or HPY_HV_API_KEY with HPY_HV_URL in CI",
            "API key:",
        )?
    };
    let key = key.trim().to_string();
    instance::check_key(&key).map_err(Failure::usage)?;
    // Listing plugins is the first thing a deploy does, so a key that can't
    // isn't worth saving.
    Admin::new(&url, &key).plugins().await?;
    match instance::save(&ctx.settings, &url, &key, ctx.keystore())? {
        Saved::File {
            reason: Some(reason),
        } => ctx.out.status(&format!(
            "Your OS keychain isn't available ({reason}), so the API key is stored in {}, readable only by you.",
            ctx.settings.config_dir.join("instances.json").display()
        )),
        Saved::Keychain | Saved::File { reason: None } => {}
    }
    let info = instance::list(&ctx.settings)?
        .into_iter()
        .find(|i| i.url == url)
        .ok_or_else(|| Failure::runtime("the sign-in was not saved"))?;
    ctx.out.done(
        &format!("Signed in to {url} with API key {}", info.key_prefix),
        describe(&info),
    );
    Ok(())
}

pub async fn logout(ctx: &Ctx, args: InstanceArgs) -> Result<(), Failure> {
    match instance::remove(&ctx.settings, ctx.keystore(), args.url.as_deref())? {
        Some(i) => ctx.out.done(
            &format!(
                "Forgot the API key for {}. It still works until you revoke it in the instance's dashboard.",
                i.url
            ),
            json!({ "loggedOut": i.url }),
        ),
        None => ctx.out.done("Not signed in.", json!({ "loggedOut": null })),
    }
    Ok(())
}

pub async fn whoami(ctx: &Ctx) -> Result<(), Failure> {
    let mut signed_in = instance::list(&ctx.settings)?;
    if let (Some(url), Some(key)) = (env(instance::URL_VAR), env(instance::KEY_VAR)) {
        signed_in.insert(
            0,
            Info {
                url: instance::normalize_url(&url)?,
                key_prefix: instance::prefix(&key),
                storage: "environment",
            },
        );
    }
    if signed_in.is_empty() {
        return Err(hpy_atproto::Error::LoginRequired(
            "not signed in to a HappyView instance; create an API key in its dashboard and run `hpy hv login --url <instance>`".into(),
        )
        .into());
    }
    let lines: Vec<String> = signed_in
        .iter()
        .map(|i| {
            let storage = match i.storage {
                "keychain" => "key in the OS keychain",
                "file" => "key in instances.json",
                _ => "from HPY_HV_API_KEY",
            };
            format!("{} with API key {} ({storage})", i.url, i.key_prefix)
        })
        .collect();
    ctx.out.done(
        &lines.join("\n"),
        json!({ "instances": signed_in.iter().map(describe).collect::<Vec<_>>() }),
    );
    Ok(())
}
