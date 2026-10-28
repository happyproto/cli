use std::io::BufRead;

use hpy_atproto::admin::Admin;
use hpy_atproto::credential::{self, Credential, Saved};
use hpy_atproto::happyview::HappyView;
use hpy_atproto::instance::{self, Auth, Info};
use hpy_atproto::login::{self, LoginOptions};
use hpy_atproto::resolve::NetworkResolver;
use serde_json::json;

use crate::cli::{InstanceArgs, InstanceLoginArgs};
use crate::ctx::Ctx;
use crate::failure::Failure;

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn no_env(_: &str) -> Option<String> {
    None
}

fn describe(i: &Info) -> serde_json::Value {
    json!({ "url": i.url, "kind": i.kind, "account": i.account, "storage": i.storage })
}

fn admin_for(auth: Auth, url: &str) -> Admin {
    match auth {
        Auth::ApiKey(key) => Admin::new(url, &key),
        Auth::Session(cred) => Admin::with_session(cred),
    }
}

/// The admin API of the instance `args` names, signed in.
pub fn admin(ctx: &Ctx, args: &InstanceArgs) -> Result<Admin, Failure> {
    let login = instance::current(&ctx.settings, ctx.keystore(), &env, args.url.as_deref())?;
    Ok(admin_for(login.auth, &login.url))
}

/// Signs a session out on its instance. Best effort: the local copy is
/// forgotten either way.
async fn revoke(cred: &Credential) {
    let _ = HappyView::new(&cred.registry, &cred.client_key)
        .revoke(cred)
        .await;
}

/// The key of the instance's built-in `hpy` client, as its `/config` names
/// it; `HPY_HV_CLIENT_KEY` overrides it, for testing.
async fn client_key(url: &str) -> Result<String, Failure> {
    if let Some(key) = env("HPY_HV_CLIENT_KEY") {
        return Ok(key);
    }
    let http = reqwest::Client::builder()
        .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(Failure::runtime)?;
    let config: serde_json::Value = http
        .get(format!("{url}/config"))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| Failure::runtime(format!("could not reach {url}: {e}")))?
        .json()
        .await
        .map_err(|e| Failure::runtime(format!("{url}/config is not a HappyView's: {e}")))?;
    Ok(config["cli_client_key"]
        .as_str()
        .unwrap_or(instance::DEFAULT_CLIENT_KEY)
        .to_string())
}

async fn login_with_key(ctx: &Ctx, url: &str) -> Result<Saved, Failure> {
    let mut key = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut key)
        .map_err(Failure::runtime)?;
    let key = key.trim();
    instance::check_key(key).map_err(Failure::usage)?;
    // Listing plugins is the first thing a deploy does, so a key that can't
    // isn't worth saving.
    Admin::new(url, key).plugins().await?;
    Ok(instance::save_key(&ctx.settings, url, key, ctx.keystore())?)
}

async fn login_with_browser(
    ctx: &Ctx,
    url: &str,
    identifier: Option<String>,
    open_browser: bool,
) -> Result<Saved, Failure> {
    let suggested = credential::peek(&ctx.settings, &no_env)
        .ok()
        .flatten()
        .map(|i| i.handle.unwrap_or(i.did));
    let identifier = ctx.prompter.required(
        "<IDENTIFIER>",
        "Handle or DID:",
        identifier,
        suggested,
        |s| {
            if s.trim().is_empty() {
                Err("required".into())
            } else {
                Ok(())
            }
        },
    )?;
    let client_key = client_key(url).await?;
    let settings = instance::login_settings(&ctx.settings, url, &client_key);
    let hv = HappyView::new(url, &client_key);
    let show = |link: &str| {
        eprintln!("Open this URL to sign in to {url}:\n\n  {link}\n");
        eprintln!("Waiting for you to sign in in your browser…");
    };
    let cred = login::login(
        &settings,
        &NetworkResolver::default(),
        &hv,
        LoginOptions {
            identifier: &identifier,
            open_browser,
            show_url: &show,
        },
    )
    .await?;
    // A session the instance won't let deploy is no use; don't keep it.
    if let Err(e) = Admin::with_session(cred.clone()).project().await {
        revoke(&cred).await;
        return Err(e.into());
    }
    let previous = instance::current(&ctx.settings, ctx.keystore(), &no_env, Some(url)).ok();
    let saved = instance::save_session(&ctx.settings, &cred, ctx.keystore())?;
    if let Some(Auth::Session(old)) = previous.map(|l| l.auth) {
        revoke(&old).await;
    }
    Ok(saved)
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
    let saved = if args.key_stdin {
        login_with_key(ctx, &url).await?
    } else {
        login_with_browser(ctx, &url, args.identifier, !args.no_browser).await?
    };
    if let Saved::File {
        reason: Some(reason),
    } = saved
    {
        ctx.out.status(&format!(
            "Your OS keychain isn't available ({reason}), so your sign-in is stored in {}, readable only by you.",
            ctx.settings.config_dir.join("instances.json").display()
        ));
    }
    let info = instance::list(&ctx.settings)?
        .into_iter()
        .find(|i| i.url == url)
        .ok_or_else(|| Failure::runtime("the sign-in was not saved"))?;
    ctx.out.done(
        &format!("Signed in to {url} as {}", info.account),
        describe(&info),
    );
    Ok(())
}

pub async fn logout(ctx: &Ctx, args: InstanceArgs) -> Result<(), Failure> {
    if let Ok(login) =
        instance::current(&ctx.settings, ctx.keystore(), &no_env, args.url.as_deref())
        && let Auth::Session(cred) = &login.auth
    {
        revoke(cred).await;
    }
    match instance::remove(&ctx.settings, ctx.keystore(), args.url.as_deref())? {
        Some(i) if i.kind == "apiKey" => ctx.out.done(
            &format!(
                "Forgot the API key for {}. It still works until you revoke it in the instance's dashboard.",
                i.url
            ),
            json!({ "loggedOut": i.url }),
        ),
        Some(i) => ctx.out.done(
            &format!("Signed out of {}", i.url),
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
                kind: "apiKey",
                account: format!("API key {}", instance::prefix(&key)),
                storage: "environment",
            },
        );
    }
    if signed_in.is_empty() {
        return Err(hpy_atproto::Error::LoginRequired(
            "not signed in to a HappyView instance; run `hpy hv login --url <instance>`".into(),
        )
        .into());
    }
    let lines: Vec<String> = signed_in
        .iter()
        .map(|i| {
            let storage = match i.storage {
                "keychain" => "in the OS keychain",
                "file" => "in instances.json",
                _ => "from HPY_HV_API_KEY",
            };
            format!("{} as {} ({storage})", i.url, i.account)
        })
        .collect();
    ctx.out.done(
        &lines.join("\n"),
        json!({ "instances": signed_in.iter().map(describe).collect::<Vec<_>>() }),
    );
    Ok(())
}
