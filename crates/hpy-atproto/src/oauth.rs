//! The atproto OAuth requests `hpy` makes to a PDS's authorization server, as
//! a confidential client whose assertions HappyView signs: PAR, the loopback
//! callback, and the token exchange. Every request carries a DPoP proof made
//! with the key HappyView provisioned.

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::dpop::DpopKey;
use crate::resolve::AuthServer;
use crate::{Error, Result};

const ASSERTION_TYPE: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

pub struct ParParams {
    pub client_id: String,
    pub redirect_uri: String,
    pub scope: String,
    pub state: String,
    pub code_challenge: String,
    pub login_hint: Option<String>,
    /// HappyView-signed, for a confidential client; `None` for a public one.
    pub client_assertion: Option<String>,
}

pub struct TokenParams {
    pub client_id: String,
    pub redirect_uri: String,
    pub code: String,
    pub code_verifier: String,
    /// HappyView-signed, for a confidential client; `None` for a public one.
    pub client_assertion: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenSet {
    pub access_token: String,
    /// HappyView refreshes the session; a server may still issue none.
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub scope: String,
    pub sub: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Callback {
    pub code: String,
    pub state: String,
    pub iss: Option<String>,
}

/// A form POST with a DPoP proof; retried once when the server asks for a
/// nonce. Answers the JSON body and the latest nonce the server sent.
async fn post_form(
    http: &reqwest::Client,
    what: &str,
    url: &str,
    form: &[(&str, String)],
    key: &DpopKey,
    mut nonce: Option<String>,
) -> Result<(Value, Option<String>)> {
    for attempt in 0..2 {
        let proof = key.proof("POST", url, None, nonce.as_deref());
        let resp = http
            .post(url)
            .header("dpop", proof)
            .form(form)
            .send()
            .await
            .map_err(|e| {
                Error::Other(format!(
                    "could not reach the authorization server ({what}): {e}"
                ))
            })?;
        let new_nonce = resp
            .headers()
            .get("dpop-nonce")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok((body, new_nonce.or(nonce)));
        }
        if body["error"] == "use_dpop_nonce" && attempt == 0 && new_nonce.is_some() {
            nonce = new_nonce;
            continue;
        }
        let error = body["error"].as_str().unwrap_or("unknown_error");
        let description = body["error_description"]
            .as_str()
            .map(|d| format!(": {d}"))
            .unwrap_or_default();
        return Err(Error::Other(format!(
            "{what} was refused ({status}) — {error}{description}"
        )));
    }
    unreachable!("the loop returns on its second attempt")
}

/// Pushed authorization request; answers the `request_uri` and the nonce to
/// use next.
pub async fn par(
    http: &reqwest::Client,
    auth: &AuthServer,
    p: &ParParams,
    key: &DpopKey,
) -> Result<(String, Option<String>)> {
    let mut form = vec![
        ("response_type", "code".to_string()),
        ("client_id", p.client_id.clone()),
        ("redirect_uri", p.redirect_uri.clone()),
        ("scope", p.scope.clone()),
        ("state", p.state.clone()),
        ("code_challenge", p.code_challenge.clone()),
        ("code_challenge_method", "S256".to_string()),
    ];
    if let Some(assertion) = &p.client_assertion {
        form.push(("client_assertion_type", ASSERTION_TYPE.to_string()));
        form.push(("client_assertion", assertion.clone()));
    }
    if let Some(hint) = &p.login_hint {
        form.push(("login_hint", hint.clone()));
    }
    let (body, nonce) = post_form(
        http,
        "the sign-in request",
        &auth.par_endpoint,
        &form,
        key,
        None,
    )
    .await?;
    let uri = body["request_uri"]
        .as_str()
        .ok_or_else(|| Error::Other("the authorization server answered no request_uri".into()))?;
    Ok((uri.to_string(), nonce))
}

pub fn authorize_url(auth: &AuthServer, client_id: &str, request_uri: &str) -> String {
    let query: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("request_uri", request_uri)
        .finish();
    format!("{}?{query}", auth.authorization_endpoint)
}

pub async fn exchange(
    http: &reqwest::Client,
    auth: &AuthServer,
    p: &TokenParams,
    key: &DpopKey,
    nonce: Option<String>,
) -> Result<TokenSet> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", p.code.clone()),
        ("redirect_uri", p.redirect_uri.clone()),
        ("code_verifier", p.code_verifier.clone()),
        ("client_id", p.client_id.clone()),
    ];
    if let Some(assertion) = &p.client_assertion {
        form.push(("client_assertion_type", ASSERTION_TYPE.to_string()));
        form.push(("client_assertion", assertion.clone()));
    }
    let (body, _) = post_form(
        http,
        "the token request",
        &auth.token_endpoint,
        &form,
        key,
        nonce,
    )
    .await?;
    let field = |name: &str| {
        body[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| Error::Other(format!("the token response has no {name}")))
    };
    Ok(TokenSet {
        access_token: field("access_token")?,
        refresh_token: body["refresh_token"].as_str().map(str::to_string),
        expires_in: body["expires_in"].as_u64(),
        scope: field("scope")?,
        sub: field("sub")?,
    })
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>hpy</title>\
<body style=\"font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem\">";

/// Binds the loopback redirect listener; answers its port and the callback,
/// which resolves when the browser comes back to `/oauth/callback`.
pub async fn listen() -> Result<(u16, tokio::task::JoinHandle<Result<Callback>>)> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(Error::other)?;
    let port = listener.local_addr().map_err(Error::other)?.port();
    let handle = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(Error::other)?;
            let mut buf = vec![0u8; 8192];
            let mut len = 0;
            while len < buf.len() {
                let n = socket.read(&mut buf[len..]).await.map_err(Error::other)?;
                if n == 0 {
                    break;
                }
                len += n;
                if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&buf[..len]);
            let target = request
                .lines()
                .next()
                .and_then(|l| l.split(' ').nth(1))
                .unwrap_or("");
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            if path != "/oauth/callback" {
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                continue;
            }
            let params: std::collections::HashMap<String, String> =
                url::form_urlencoded::parse(query.as_bytes())
                    .into_owned()
                    .collect();
            let (result, message) =
                match (params.get("error"), params.get("code"), params.get("state")) {
                    (Some(error), _, _) => {
                        let why = params.get("error_description").unwrap_or(error).clone();
                        (
                            Err(Error::Other(format!("sign-in was not completed: {why}"))),
                            format!("Sign-in was not completed: {why}."),
                        )
                    }
                    (None, Some(code), Some(state)) => (
                        Ok(Callback {
                            code: code.clone(),
                            state: state.clone(),
                            iss: params.get("iss").cloned(),
                        }),
                        "You're signed in to hpy.".to_string(),
                    ),
                    _ => (
                        Err(Error::Other("the sign-in response had no code".into())),
                        "Sign-in failed: the response had no code.".to_string(),
                    ),
                };
            let html = format!(
                "{PAGE}<p>{message}</p><p>You can close this tab and return to your terminal.</p></body>"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                html.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
            return result;
        }
    });
    Ok((port, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::AuthServer;
    use base64::Engine;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn auth(server: &MockServer) -> AuthServer {
        AuthServer {
            issuer: server.uri(),
            par_endpoint: format!("{}/oauth/par", server.uri()),
            authorization_endpoint: format!("{}/oauth/authorize", server.uri()),
            token_endpoint: format!("{}/oauth/token", server.uri()),
        }
    }

    fn proof_claims(req: &Request) -> serde_json::Value {
        let proof = req.headers.get("dpop").unwrap().to_str().unwrap();
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(proof.split('.').nth(1).unwrap())
            .unwrap();
        serde_json::from_slice(&claims).unwrap()
    }

    fn par_params() -> ParParams {
        ParParams {
            client_id: "https://c.example/meta.json".into(),
            redirect_uri: "http://127.0.0.1:1/oauth/callback".into(),
            scope: "atproto".into(),
            state: "st".into(),
            code_challenge: "chal".into(),
            login_hint: Some("alice.test".into()),
            client_assertion: Some("assert.ion.jwt".into()),
        }
    }

    #[tokio::test]
    async fn par_sends_assertion_pkce_and_dpop() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/par"))
            .and(body_string_contains("client_assertion=assert.ion.jwt"))
            .and(body_string_contains("client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer"))
            .and(body_string_contains("code_challenge_method=S256"))
            .and(body_string_contains("login_hint=alice.test"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "request_uri": "urn:req:1", "expires_in": 60 })))
            .mount(&server)
            .await;
        let key = DpopKey::generate();
        let (uri, nonce) = par(&reqwest::Client::new(), &auth(&server), &par_params(), &key)
            .await
            .unwrap();
        assert_eq!(uri, "urn:req:1");
        assert_eq!(nonce, None);
        let req = &server.received_requests().await.unwrap()[0];
        let claims = proof_claims(req);
        assert_eq!(claims["htm"], "POST");
        assert!(claims.get("ath").is_none());
    }

    #[tokio::test]
    async fn par_retries_once_with_dpop_nonce() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/par"))
            .respond_with(
                ResponseTemplate::new(400)
                    .insert_header("dpop-nonce", "n1")
                    .set_body_json(serde_json::json!({ "error": "use_dpop_nonce" })),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/oauth/par"))
            .respond_with(
                ResponseTemplate::new(201)
                    .insert_header("dpop-nonce", "n2")
                    .set_body_json(serde_json::json!({ "request_uri": "urn:req:2" })),
            )
            .mount(&server)
            .await;
        let (uri, nonce) = par(
            &reqwest::Client::new(),
            &auth(&server),
            &par_params(),
            &DpopKey::generate(),
        )
        .await
        .unwrap();
        assert_eq!(uri, "urn:req:2");
        assert_eq!(nonce.as_deref(), Some("n2"));
        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 2);
        assert!(proof_claims(&reqs[0]).get("nonce").is_none());
        assert_eq!(proof_claims(&reqs[1])["nonce"], "n1");
    }

    #[tokio::test]
    async fn exchange_returns_tokens_and_reuses_the_nonce() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .and(body_string_contains("code=c0de"))
            .and(body_string_contains("code_verifier=ver"))
            .and(body_string_contains("client_assertion=a2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "refresh_token": "rt", "expires_in": 3600,
                "scope": "atproto repo:x", "sub": "did:plc:abc", "token_type": "DPoP"
            })))
            .mount(&server)
            .await;
        let tokens = exchange(
            &reqwest::Client::new(),
            &auth(&server),
            &TokenParams {
                client_id: "https://c.example/meta.json".into(),
                redirect_uri: "http://127.0.0.1:1/oauth/callback".into(),
                code: "c0de".into(),
                code_verifier: "ver".into(),
                client_assertion: Some("a2".into()),
            },
            &DpopKey::generate(),
            Some("n2".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            (
                tokens.access_token.as_str(),
                tokens.refresh_token.as_deref().unwrap_or(""),
                tokens.sub.as_str()
            ),
            ("at", "rt", "did:plc:abc")
        );
        assert_eq!(tokens.expires_in, Some(3600));
        let req = &server.received_requests().await.unwrap()[0];
        assert_eq!(proof_claims(req)["nonce"], "n2");
    }

    #[tokio::test]
    async fn token_errors_carry_the_server_description() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_client", "error_description": "client authentication failed"
            })))
            .mount(&server)
            .await;
        let err = par(
            &reqwest::Client::new(),
            &auth(&server),
            &par_params(),
            &DpopKey::generate(),
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("client authentication failed"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn callback_parses_code_and_rejects_access_denied() {
        let (port, callback) = listen().await.unwrap();
        let body = reqwest::get(format!(
            "http://127.0.0.1:{port}/oauth/callback?code=c0de&state=st&iss=https%3A%2F%2Fpds.test"
        ))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
        assert!(body.contains("close this tab"), "{body}");
        let cb = callback.await.unwrap().unwrap();
        assert_eq!(
            (cb.code.as_str(), cb.state.as_str(), cb.iss.as_deref()),
            ("c0de", "st", Some("https://pds.test"))
        );

        let (port, callback) = listen().await.unwrap();
        let _ = reqwest::get(format!("http://127.0.0.1:{port}/oauth/callback?error=access_denied&error_description=User+said+no&state=st")).await;
        let err = callback.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("User said no"), "{err}");
    }

    #[tokio::test]
    async fn callback_ignores_other_paths_until_the_real_one() {
        let (port, callback) = listen().await.unwrap();
        let _ = reqwest::get(format!("http://127.0.0.1:{port}/favicon.ico")).await;
        let _ = reqwest::get(format!(
            "http://127.0.0.1:{port}/oauth/callback?code=c&state=s"
        ))
        .await;
        assert_eq!(callback.await.unwrap().unwrap().code, "c");
    }

    #[tokio::test]
    async fn exchange_accepts_a_missing_refresh_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 60, "scope": "atproto", "sub": "did:plc:abc"
            })))
            .mount(&server)
            .await;
        let tokens = exchange(
            &reqwest::Client::new(),
            &auth(&server),
            &TokenParams {
                client_id: "c".into(),
                redirect_uri: "r".into(),
                code: "c".into(),
                code_verifier: "v".into(),
                client_assertion: None,
            },
            &DpopKey::generate(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(tokens.refresh_token, None);
    }
}
