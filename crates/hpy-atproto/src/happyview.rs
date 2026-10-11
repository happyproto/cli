//! HappyView, as `hpy` talks to it: provisioning a DPoP key, signing client
//! assertions, registering and revoking sessions, and XRPC calls made as the
//! signed-in user.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::credential::Credential;
use crate::dpop::DpopKey;
use crate::{Error, Result};

const NAMED_REGISTRY_ERRORS: [&str; 3] = ["InvalidRecord", "VersionExists", "ProfileMissing"];

pub struct HappyView {
    base: String,
    client_key: String,
    http: reqwest::Client,
}

pub struct Provision {
    pub provision_id: String,
    pub dpop_key: DpopKey,
}

#[derive(Serialize)]
pub struct SessionRegistration {
    pub provision_id: String,
    pub pkce_verifier: String,
    pub did: String,
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    pub expires_at: String,
    pub scopes: String,
    pub pds_url: String,
    pub issuer: String,
}

impl std::fmt::Debug for SessionRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Tokens and the PKCE verifier are secrets; never print them.
        f.debug_struct("SessionRegistration")
            .field("provision_id", &self.provision_id)
            .field("did", &self.did)
            .field("scopes", &self.scopes)
            .field("pds_url", &self.pds_url)
            .field("issuer", &self.issuer)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct XrpcError {
    error: Option<String>,
    message: Option<String>,
}

/// Maps an error from HappyView to ours. `as_user` is false for the sign-in
/// handshake, where a 401 means the client itself was refused, not that a
/// session expired.
pub fn xrpc_error(what: &str, status: reqwest::StatusCode, body: &[u8], as_user: bool) -> Error {
    let parsed: XrpcError = serde_json::from_slice(body).unwrap_or(XrpcError {
        error: None,
        message: None,
    });
    let name = parsed.error.unwrap_or_else(|| format!("HTTP {status}"));
    let message = parsed.message;
    if !as_user {
        let detail = match message {
            Some(m) => format!("{name}: {m}"),
            None => name,
        };
        return Error::Other(format!("HappyView refused {what} ({detail})"));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || name == "AuthRequired" {
        return Error::SessionExpired;
    }
    if NAMED_REGISTRY_ERRORS.contains(&name.as_str()) {
        return Error::Registry {
            message: message.unwrap_or_else(|| name.clone()),
            name,
        };
    }
    Error::Xrpc {
        method: what.into(),
        name,
        message,
    }
}

impl HappyView {
    pub fn new(base: &str, client_key: &str) -> HappyView {
        HappyView {
            base: base.trim_end_matches('/').into(),
            client_key: client_key.into(),
            http: reqwest::Client::builder()
                .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(60))
                .build()
                .expect("http client"),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Sends a request built by `build` (called again for a retry, so each
    /// attempt gets a fresh DPoP proof), retrying a 429 once, and answers the
    /// JSON body. A Lua procedure's `{ error, message }` arrives with 200 OK,
    /// so a body carrying `error` is an error whatever the status.
    async fn send(
        &self,
        what: &str,
        as_user: bool,
        build: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<Value> {
        for attempt in 0..2 {
            let resp = build()
                .header("x-client-key", &self.client_key)
                .send()
                .await
                .map_err(|e| {
                    Error::Other(format!("could not reach {} ({what}): {e}", self.base))
                })?;
            let status = resp.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt == 0 {
                let wait = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(1)
                    .min(10);
                tokio::time::sleep(Duration::from_secs(wait)).await;
                continue;
            }
            let body = resp.bytes().await.unwrap_or_default();
            if !status.is_success() {
                return Err(xrpc_error(what, status, &body, as_user));
            }
            if body.is_empty() {
                return Ok(Value::Null);
            }
            let value: Value = serde_json::from_slice(&body)
                .map_err(|e| Error::Other(format!("{what} answered something unreadable: {e}")))?;
            if value.get("error").is_some_and(Value::is_string) {
                return Err(xrpc_error(what, status, &body, as_user));
            }
            return Ok(value);
        }
        unreachable!("the loop returns on its second attempt")
    }

    pub async fn provision(&self, pkce_challenge: &str) -> Result<Provision> {
        let url = format!("{}/oauth/dpop-keys", self.base);
        let body = serde_json::json!({ "pkce_challenge": pkce_challenge });
        let out = self
            .send("provisioning a key", false, || {
                self.http.post(&url).json(&body)
            })
            .await?;
        Ok(Provision {
            provision_id: out["provision_id"]
                .as_str()
                .ok_or_else(|| Error::Other("HappyView provisioned no key".into()))?
                .into(),
            dpop_key: DpopKey::from_jwk(&out["dpop_key"])?,
        })
    }

    pub async fn client_assertion(
        &self,
        issuer: &str,
        provision_id: &str,
        pkce_verifier: &str,
    ) -> Result<String> {
        let url = format!("{}/oauth/client-assertion", self.base);
        let body = serde_json::json!({ "issuer": issuer, "provision_id": provision_id, "pkce_verifier": pkce_verifier });
        let out = self
            .send("signing a client assertion", false, || {
                self.http.post(&url).json(&body)
            })
            .await?;
        out["client_assertion"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| Error::Other("HappyView signed no client assertion".into()))
    }

    pub async fn register_session(&self, registration: &SessionRegistration) -> Result<()> {
        let url = format!("{}/oauth/sessions", self.base);
        self.send("registering the session", false, || {
            self.http.post(&url).json(registration)
        })
        .await?;
        Ok(())
    }

    /// Revokes this device's session.
    pub async fn revoke(&self, cred: &Credential) -> Result<()> {
        let did: String = url::form_urlencoded::byte_serialize(cred.did.as_bytes()).collect();
        let url = format!("{}/oauth/sessions/{did}", self.base);
        self.send("signing out", true, || {
            self.authed(cred, reqwest::Method::DELETE, &url)
        })
        .await?;
        Ok(())
    }

    fn authed(
        &self,
        cred: &Credential,
        method: reqwest::Method,
        url: &str,
    ) -> reqwest::RequestBuilder {
        let proof = cred
            .dpop_key
            .proof(method.as_str(), url, Some(&cred.access_token), None);
        self.http
            .request(method, url)
            .header("authorization", format!("DPoP {}", cred.access_token))
            .header("dpop", proof)
    }

    /// An XRPC procedure as the signed-in user.
    pub async fn procedure(&self, cred: &Credential, nsid: &str, body: &Value) -> Result<Value> {
        let url = format!("{}/xrpc/{nsid}", self.base);
        self.send(nsid, true, || {
            self.authed(cred, reqwest::Method::POST, &url).json(body)
        })
        .await
    }

    /// Uploads a blob to the user's PDS through HappyView; answers the blob ref.
    pub async fn upload_blob(
        &self,
        cred: &Credential,
        bytes: Vec<u8>,
        mime: &str,
    ) -> Result<Value> {
        const NSID: &str = "com.atproto.repo.uploadBlob";
        let url = format!("{}/xrpc/{NSID}", self.base);
        let out = self
            .send(NSID, true, || {
                self.authed(cred, reqwest::Method::POST, &url)
                    // A module may be 16 MB; give a slow link time to send it.
                    .timeout(Duration::from_secs(600))
                    .header("content-type", mime)
                    .body(bytes.clone())
            })
            .await?;
        match out.get("blob") {
            Some(blob) => Ok(blob.clone()),
            None => Err(Error::Other("the upload answered no blob".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sha2::Digest;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    /// Matches a request whose DPoP proof is for exactly this request and,
    /// when given, this access token.
    struct ProofFor {
        token: Option<&'static str>,
    }

    impl wiremock::Match for ProofFor {
        fn matches(&self, req: &Request) -> bool {
            let Some(proof) = req.headers.get("dpop").and_then(|v| v.to_str().ok()) else {
                return false;
            };
            let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
            let Some(claims) = proof.split('.').nth(1).and_then(|c| b64.decode(c).ok()) else {
                return false;
            };
            let claims: serde_json::Value = serde_json::from_slice(&claims).unwrap();
            // wiremock reports the URL as `http://localhost/…`; HappyView rebuilds
            // `htu` from the Host header, so compare against that and the path.
            let Ok(htu) = url::Url::parse(claims["htu"].as_str().unwrap_or_default()) else {
                return false;
            };
            let host = req
                .headers
                .get("host")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default();
            let htu_ok = htu.query().is_none()
                && htu.path() == req.url.path()
                && format!(
                    "{}:{}",
                    htu.host_str().unwrap_or_default(),
                    htu.port().unwrap_or(80)
                ) == host;
            let ath_ok = match self.token {
                Some(t) => {
                    claims["ath"] == crate::dpop::b64url(&sha2::Sha256::digest(t.as_bytes()))
                        && req
                            .headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            == Some(format!("DPoP {t}").as_str())
                }
                None => claims.get("ath").is_none(),
            };
            claims["htm"] == req.method.as_str() && htu_ok && ath_ok
        }
    }

    fn cred(server: &MockServer) -> Credential {
        Credential {
            registry: server.uri(),
            client_key: "hvc_test".into(),
            did: "did:plc:abc".into(),
            handle: None,
            pds: "https://pds.test".into(),
            scopes: "atproto".into(),
            access_token: "tok".into(),
            dpop_key: DpopKey::generate(),
        }
    }

    #[tokio::test]
    async fn provision_sends_client_key_and_challenge() {
        let server = MockServer::start().await;
        let key = DpopKey::generate();
        Mock::given(method("POST"))
            .and(path("/oauth/dpop-keys"))
            .and(header("x-client-key", "hvc_test"))
            .and(body_partial_json(
                serde_json::json!({ "pkce_challenge": "chal" }),
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "provision_id": "hvp_1", "dpop_key": key.to_jwk()
            })))
            .mount(&server)
            .await;
        let hv = HappyView::new(&server.uri(), "hvc_test");
        let p = hv.provision("chal").await.unwrap();
        assert_eq!(p.provision_id, "hvp_1");
        assert_eq!(p.dpop_key, key);
    }

    #[tokio::test]
    async fn client_assertion_proves_the_provision() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/client-assertion"))
            .and(header("x-client-key", "hvc_test"))
            .and(body_partial_json(serde_json::json!({
                "issuer": "https://pds.test", "provision_id": "hvp_1", "pkce_verifier": "ver"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "client_assertion": "eyJ.a.b", "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", "expires_in": 60
            })))
            .mount(&server)
            .await;
        let hv = HappyView::new(&server.uri(), "hvc_test");
        assert_eq!(
            hv.client_assertion("https://pds.test", "hvp_1", "ver")
                .await
                .unwrap(),
            "eyJ.a.b"
        );
    }

    #[tokio::test]
    async fn register_session_sends_the_tokens() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/sessions"))
            .and(body_partial_json(serde_json::json!({
                "provision_id": "hvp_1", "pkce_verifier": "ver", "did": "did:plc:abc",
                "access_token": "a", "refresh_token": "r", "issuer": "https://pds.test"
            })))
            .respond_with(
                ResponseTemplate::new(201)
                    .set_body_json(serde_json::json!({ "session_id": "s", "did": "did:plc:abc" })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let hv = HappyView::new(&server.uri(), "hvc_test");
        hv.register_session(&SessionRegistration {
            provision_id: "hvp_1".into(),
            pkce_verifier: "ver".into(),
            did: "did:plc:abc".into(),
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_at: "2026-10-10T00:00:00Z".into(),
            scopes: "atproto".into(),
            pds_url: "https://pds.test".into(),
            issuer: "https://pds.test".into(),
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn procedure_sends_dpop_auth_with_matching_proof() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.publishRelease"))
            .and(header("x-client-key", "hvc_test"))
            .and(ProofFor { token: Some("tok") })
            .and(body_partial_json(
                serde_json::json!({ "validateOnly": true }),
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "valid": true })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let c = cred(&server);
        let hv = HappyView::new(&server.uri(), "hvc_test");
        let out = hv
            .procedure(
                &c,
                "at.happyproto.registry.publishRelease",
                &serde_json::json!({ "record": {}, "validateOnly": true }),
            )
            .await
            .unwrap();
        assert_eq!(out["valid"], true);
    }

    #[tokio::test]
    async fn upload_blob_sends_bytes_with_content_type() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/com.atproto.repo.uploadBlob"))
            .and(header("content-type", "application/wasm"))
            .and(ProofFor { token: Some("tok") })
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "blob": { "$type": "blob", "ref": { "$link": "bafk" }, "mimeType": "application/wasm", "size": 4 }
            })))
            .mount(&server)
            .await;
        let c = cred(&server);
        let blob = HappyView::new(&server.uri(), "hvc_test")
            .upload_blob(&c, b"\0asm".to_vec(), "application/wasm")
            .await
            .unwrap();
        assert_eq!(blob["ref"]["$link"], "bafk");
    }

    #[tokio::test]
    async fn registry_errors_keep_their_name_and_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "InvalidRecord", "message": "requires key is neither env:* nor a profile AT URI: x"
            })))
            .mount(&server)
            .await;
        let c = cred(&server);
        let err = HappyView::new(&server.uri(), "hvc_test")
            .procedure(
                &c,
                "at.happyproto.registry.publishRelease",
                &serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert!(err.is_usage(), "{err:?}");
        assert!(err.to_string().contains("neither env:*"), "{err}");
    }

    #[tokio::test]
    async fn auth_failures_are_session_expired() {
        for (status, body) in [
            (
                401,
                serde_json::json!({ "error": "AuthRequired", "message": "x" }),
            ),
            (
                400,
                serde_json::json!({ "error": "AuthRequired", "message": "your identity could not be determined" }),
            ),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(status).set_body_json(body))
                .mount(&server)
                .await;
            let c = cred(&server);
            let err = HappyView::new(&server.uri(), "hvc_test")
                .procedure(&c, "a.b.c", &serde_json::json!({}))
                .await
                .unwrap_err();
            assert!(err.is_auth(), "{status}: {err:?}");
        }
    }

    #[tokio::test]
    async fn retries_429_once() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "0"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "ok": true })),
            )
            .mount(&server)
            .await;
        let c = cred(&server);
        let out = HappyView::new(&server.uri(), "hvc_test")
            .procedure(&c, "a.b.c", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
    }

    #[tokio::test]
    async fn revoke_proof_htu_is_the_encoded_url() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/oauth/sessions/did%3Aplc%3Aabc"))
            .and(ProofFor { token: Some("tok") })
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let c = cred(&server);
        HappyView::new(&server.uri(), "hvc_test")
            .revoke(&c)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn lua_failures_arrive_as_200_and_are_still_errors() {
        // HappyView returns a script's `{ error, message }` table with 200 OK.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "ProfileMissing", "message": "no profile is indexed at that slug"
            })))
            .mount(&server)
            .await;
        let c = cred(&server);
        let err = HappyView::new(&server.uri(), "hvc_test")
            .procedure(
                &c,
                "at.happyproto.registry.publishRelease",
                &serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(err.registry_name(), Some("ProfileMissing"), "{err:?}");
    }

    #[tokio::test]
    async fn a_refused_login_handshake_is_not_an_expired_session() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/dpop-keys"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({ "error": "unknown client" })),
            )
            .mount(&server)
            .await;
        let err = HappyView::new(&server.uri(), "hvc_bad")
            .provision("chal")
            .await
            .err()
            .unwrap();
        assert!(!err.is_auth(), "{err:?}");
        assert!(err.to_string().contains("unknown client"), "{err}");
    }

    #[test]
    fn session_registration_debug_hides_tokens() {
        let r = SessionRegistration {
            provision_id: "hvp_1".into(),
            pkce_verifier: "verifier-secret".into(),
            did: "did:plc:abc".into(),
            access_token: "access-secret".into(),
            refresh_token: Some("refresh-secret".into()),
            expires_at: "x".into(),
            scopes: "atproto".into(),
            pds_url: "p".into(),
            issuer: "i".into(),
        };
        let shown = format!("{r:?}");
        assert!(!shown.contains("secret"), "{shown}");
    }
}
