//! `hpy registry login`: provision a DPoP key from HappyView, sign in to the user's
//! PDS with it, and hand the session to HappyView.

use std::time::Duration;

use crate::credential::Credential;
use crate::dpop::random_token;
use crate::happyview::{HappyView, SessionRegistration};
use crate::oauth::{self, ParParams, TokenParams};
use crate::pkce::Pkce;
use crate::resolve::Resolver;
use crate::settings::{ClientAuth, Redirect, Settings};
use crate::{Error, Result};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

pub struct LoginOptions<'a> {
    pub identifier: &'a str,
    pub open_browser: bool,
    pub show_url: &'a (dyn Fn(&str) + Sync),
}

pub async fn login(
    settings: &Settings,
    resolver: &dyn Resolver,
    hv: &HappyView,
    opts: LoginOptions<'_>,
) -> Result<Credential> {
    // Resolve first, so a mistyped handle costs nothing on HappyView.
    let resolved = resolver.resolve(opts.identifier).await?;

    // The HappyView half: a key for this device, bound to a PKCE pair that
    // later proves this is the same client that asked for it.
    let hv_pkce = Pkce::new();
    let provision = hv.provision(&hv_pkce.challenge).await?;
    let key = provision.dpop_key;

    let auth = &resolved.auth;
    let (port, callback) = oauth::listen().await?;
    let pds_pkce = Pkce::new();
    // With a relay, the hosted page reads the loopback port from `state`.
    let (redirect_uri, state) = match &settings.oauth_redirect {
        Redirect::Loopback => (
            format!("http://127.0.0.1:{port}/oauth/callback"),
            random_token(16),
        ),
        Redirect::Relay(url) => (url.clone(), format!("{port}.{}", random_token(16))),
    };
    let assertion = || async {
        match settings.oauth_client_auth {
            ClientAuth::Assertion => hv
                .client_assertion(&auth.issuer, &provision.provision_id, &hv_pkce.verifier)
                .await
                .map(Some),
            ClientAuth::None => Ok(None),
        }
    };
    let http = reqwest::Client::builder()
        .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(Error::other)?;

    let par_assertion = assertion().await?;
    let (request_uri, nonce) = oauth::par(
        &http,
        auth,
        &ParParams {
            client_id: settings.oauth_client_id.clone(),
            redirect_uri: redirect_uri.clone(),
            scope: settings.oauth_scope.clone(),
            state: state.clone(),
            code_challenge: pds_pkce.challenge.clone(),
            login_hint: Some(opts.identifier.trim().trim_start_matches('@').to_string()),
            client_assertion: par_assertion,
        },
        &key,
    )
    .await?;

    let url = oauth::authorize_url(auth, &settings.oauth_client_id, &request_uri);
    (opts.show_url)(&url);
    if opts.open_browser {
        open_browser(&url);
    }
    let callback = match tokio::time::timeout(CALLBACK_TIMEOUT, callback).await {
        Ok(Ok(result)) => result?,
        Ok(Err(e)) => return Err(Error::Other(format!("the sign-in listener failed: {e}"))),
        Err(_) => {
            return Err(Error::Other(
                "timed out after 5 minutes waiting for you to authorize hpy".into(),
            ));
        }
    };
    if callback.state != state {
        return Err(Error::Other(
            "the sign-in response's state did not match this request; try again".into(),
        ));
    }
    // atproto requires `iss` on the authorization response (RFC 9207), so a
    // response without it is not trusted.
    match &callback.iss {
        Some(iss) if iss.trim_end_matches('/') == auth.issuer.trim_end_matches('/') => {}
        Some(iss) => {
            return Err(Error::Other(format!(
                "the sign-in response came from {iss}, not {}",
                auth.issuer
            )));
        }
        None => {
            return Err(Error::Other(
                "the sign-in response did not say which server sent it (no `iss`); try again"
                    .into(),
            ));
        }
    }

    // A fresh assertion: each one is good for 60 seconds and one request.
    let token_assertion = assertion().await?;
    let tokens = oauth::exchange(
        &http,
        auth,
        &TokenParams {
            client_id: settings.oauth_client_id.clone(),
            redirect_uri,
            code: callback.code,
            code_verifier: pds_pkce.verifier,
            client_assertion: token_assertion,
        },
        &key,
        nonce,
    )
    .await?;
    if tokens.sub != resolved.did {
        return Err(Error::Other(format!(
            "the PDS issued a token for {} instead of {}; nothing was saved",
            tokens.sub, resolved.did
        )));
    }
    if !tokens.scope.split(' ').any(|s| s == "atproto") {
        return Err(Error::Other(format!(
            "the PDS granted `{}`, which lacks `atproto`",
            tokens.scope
        )));
    }

    let expires_at = jacquard::common::deps::chrono::Utc::now()
        + jacquard::common::deps::chrono::Duration::seconds(
            tokens.expires_in.unwrap_or(3600) as i64
        );
    hv.register_session(&SessionRegistration {
        provision_id: provision.provision_id,
        pkce_verifier: hv_pkce.verifier,
        did: resolved.did.clone(),
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token,
        expires_at: expires_at
            .to_rfc3339_opts(jacquard::common::deps::chrono::SecondsFormat::Secs, true),
        scopes: tokens.scope.clone(),
        pds_url: resolved.pds.clone(),
        issuer: auth.issuer.clone(),
    })
    .await?;

    Ok(Credential {
        registry: hv.base().to_string(),
        client_key: settings.client_key.clone(),
        did: resolved.did,
        handle: resolved.handle,
        pds: resolved.pds,
        scopes: tokens.scope,
        access_token: tokens.access_token,
        dpop_key: key,
    })
}

/// Best effort; the URL is always printed as well.
fn open_browser(url: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    } else {
        std::process::Command::new("xdg-open")
    };
    let _ = cmd
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::{AuthServer, Resolved, Resolver};
    use std::sync::Arc;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct FakeResolver(AuthServer);

    #[async_trait::async_trait]
    impl Resolver for FakeResolver {
        async fn resolve(&self, _: &str) -> crate::Result<Resolved> {
            Ok(Resolved {
                did: "did:plc:abc".into(),
                handle: Some("alice.test".into()),
                pds: "https://pds.test".into(),
                auth: self.0.clone(),
            })
        }
    }

    /// A HappyView and an authorization server on one mock server.
    async fn servers(sub: &str) -> (Arc<MockServer>, crate::dpop::DpopKey) {
        servers_expecting(sub, 2).await
    }

    async fn servers_expecting(
        sub: &str,
        assertions: u64,
    ) -> (Arc<MockServer>, crate::dpop::DpopKey) {
        let server = Arc::new(MockServer::start().await);
        let key = crate::dpop::DpopKey::generate();
        Mock::given(method("POST"))
            .and(path("/oauth/dpop-keys"))
            .respond_with(ResponseTemplate::new(201).set_body_json(
                serde_json::json!({ "provision_id": "hvp_1", "dpop_key": key.to_jwk() }),
            ))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/oauth/client-assertion"))
            .and(body_partial_json(
                serde_json::json!({ "provision_id": "hvp_1" }),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "client_assertion": "asrt" })),
            )
            .expect(assertions)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/oauth/par"))
            .respond_with(
                ResponseTemplate::new(201)
                    .set_body_json(serde_json::json!({ "request_uri": "urn:req:1" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/oauth/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "refresh_token": "rt", "expires_in": 3600, "scope": "atproto repo:x", "sub": sub
            })))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/oauth/sessions"))
            .and(body_partial_json(serde_json::json!({ "provision_id": "hvp_1", "did": "did:plc:abc", "access_token": "at", "refresh_token": "rt" })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "session_id": "s", "did": "did:plc:abc" })))
            .mount(&server).await;
        (server, key)
    }

    fn auth(server: &MockServer) -> AuthServer {
        AuthServer {
            issuer: server.uri(),
            par_endpoint: format!("{}/oauth/par", server.uri()),
            authorization_endpoint: format!("{}/oauth/authorize", server.uri()),
            token_endpoint: format!("{}/oauth/token", server.uri()),
        }
    }

    /// Plays the browser: reads the PAR request's state and redirect URI,
    /// then calls the loopback callback with `state_override` if given.
    fn browser(
        server: Arc<MockServer>,
        state_override: Option<&'static str>,
    ) -> impl Fn(&str) + Sync {
        browser_with(server, state_override, true)
    }

    fn browser_with(
        server: Arc<MockServer>,
        state_override: Option<&'static str>,
        send_iss: bool,
    ) -> impl Fn(&str) + Sync {
        move |_url: &str| {
            let server = server.clone();
            tokio::spawn(async move {
                let reqs = server.received_requests().await.unwrap();
                let par = reqs.iter().find(|r| r.url.path() == "/oauth/par").unwrap();
                let form: std::collections::HashMap<String, String> =
                    url::form_urlencoded::parse(&par.body)
                        .into_owned()
                        .collect();
                let state = state_override
                    .map(str::to_string)
                    .unwrap_or_else(|| form["state"].clone());
                // In relay mode the hosted page would forward to the port in `state`.
                let target = if form["redirect_uri"].starts_with("http://127.0.0.1") {
                    form["redirect_uri"].clone()
                } else {
                    let port = form["state"].split('.').next().unwrap().to_string();
                    format!("http://127.0.0.1:{port}/oauth/callback")
                };
                let iss = if send_iss {
                    format!(
                        "&iss={}",
                        url::form_urlencoded::byte_serialize(server.uri().as_bytes())
                            .collect::<String>()
                    )
                } else {
                    String::new()
                };
                let cb = format!("{target}?code=c0de&state={state}{iss}");
                let _ = reqwest::get(cb).await;
            });
        }
    }

    fn settings() -> crate::Settings {
        crate::Settings::from_sources(None, &|_| None, "/tmp/hpy-test".into()).unwrap()
    }

    #[tokio::test]
    async fn logs_in_through_happyview() {
        let (server, key) = servers("did:plc:abc").await;
        let hv = crate::happyview::HappyView::new(&server.uri(), "hvc_test");
        let show = browser(server.clone(), None);
        let cred = login(
            &settings(),
            &FakeResolver(auth(&server)),
            &hv,
            LoginOptions {
                identifier: "alice.test",
                open_browser: false,
                show_url: &show,
            },
        )
        .await
        .unwrap();
        assert_eq!(cred.did, "did:plc:abc");
        assert_eq!(cred.dpop_key, key);
        assert_eq!(cred.access_token, "at");
        assert_eq!(cred.registry, server.uri());
        let sessions = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.url.path() == "/oauth/sessions")
            .count();
        assert_eq!(sessions, 1);
    }

    #[tokio::test]
    async fn refuses_a_token_for_someone_else() {
        let (server, _) = servers("did:plc:mallory").await;
        let hv = crate::happyview::HappyView::new(&server.uri(), "hvc_test");
        let show = browser(server.clone(), None);
        let err = login(
            &settings(),
            &FakeResolver(auth(&server)),
            &hv,
            LoginOptions {
                identifier: "alice.test",
                open_browser: false,
                show_url: &show,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("did:plc:mallory"), "{err}");
    }

    #[tokio::test]
    async fn refuses_a_callback_with_the_wrong_state() {
        let (server, _) = servers("did:plc:abc").await;
        let hv = crate::happyview::HappyView::new(&server.uri(), "hvc_test");
        let show = browser(server.clone(), Some("forged"));
        let err = login(
            &settings(),
            &FakeResolver(auth(&server)),
            &hv,
            LoginOptions {
                identifier: "alice.test",
                open_browser: false,
                show_url: &show,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("state"), "{err}");
    }

    #[tokio::test]
    async fn relay_mode_carries_the_port_in_state_and_uses_the_relay_uri() {
        let (server, _) = servers("did:plc:abc").await;
        let hv = crate::happyview::HappyView::new(&server.uri(), "hvc_test");
        let mut s = settings();
        s.oauth_redirect =
            crate::settings::Redirect::Relay("https://relay.test/oauth/hpy/callback".into());
        let show = browser(server.clone(), None);
        login(
            &s,
            &FakeResolver(auth(&server)),
            &hv,
            LoginOptions {
                identifier: "alice.test",
                open_browser: false,
                show_url: &show,
            },
        )
        .await
        .unwrap();
        let reqs = server.received_requests().await.unwrap();
        let form = |p: &str| -> std::collections::HashMap<String, String> {
            let r = reqs.iter().find(|r| r.url.path() == p).unwrap();
            url::form_urlencoded::parse(&r.body).into_owned().collect()
        };
        let par = form("/oauth/par");
        assert_eq!(par["redirect_uri"], "https://relay.test/oauth/hpy/callback");
        let (port, _) = par["state"].split_once('.').unwrap();
        assert!(port.parse::<u16>().is_ok(), "{}", par["state"]);
        assert_eq!(
            form("/oauth/token")["redirect_uri"],
            "https://relay.test/oauth/hpy/callback"
        );
    }

    #[tokio::test]
    async fn public_loopback_mode_sends_no_assertions() {
        let (server, _) = servers_expecting("did:plc:abc", 0).await;
        let hv = crate::happyview::HappyView::new(&server.uri(), "hvc_test");
        let mut s = settings();
        s.oauth_redirect = crate::settings::Redirect::Loopback;
        s.oauth_client_auth = crate::settings::ClientAuth::None;
        let show = browser(server.clone(), None);
        login(
            &s,
            &FakeResolver(auth(&server)),
            &hv,
            LoginOptions {
                identifier: "alice.test",
                open_browser: false,
                show_url: &show,
            },
        )
        .await
        .unwrap();
        let reqs = server.received_requests().await.unwrap();
        let par = reqs.iter().find(|r| r.url.path() == "/oauth/par").unwrap();
        let body = String::from_utf8_lossy(&par.body);
        assert!(!body.contains("client_assertion"), "{body}");
        assert!(
            body.contains("redirect_uri=http%3A%2F%2F127.0.0.1"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn refuses_a_callback_without_iss() {
        let (server, _) = servers_expecting("did:plc:abc", 1).await;
        let hv = crate::happyview::HappyView::new(&server.uri(), "hvc_test");
        let show = browser_with(server.clone(), None, false);
        let err = login(
            &settings(),
            &FakeResolver(auth(&server)),
            &hv,
            LoginOptions {
                identifier: "alice.test",
                open_browser: false,
                show_url: &show,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("iss"), "{err}");
    }

    struct NoSuchUser;

    #[async_trait::async_trait]
    impl Resolver for NoSuchUser {
        async fn resolve(&self, id: &str) -> crate::Result<Resolved> {
            Err(crate::Error::Other(format!(
                "could not find where `{id}` signs in"
            )))
        }
    }

    #[tokio::test]
    async fn a_mistyped_handle_provisions_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/dpop-keys"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let hv = crate::happyview::HappyView::new(&server.uri(), "hvc_test");
        let show = |_: &str| {};
        let err = login(
            &settings(),
            &NoSuchUser,
            &hv,
            LoginOptions {
                identifier: "alcie.test",
                open_browser: false,
                show_url: &show,
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("alcie.test"), "{err}");
    }
}
