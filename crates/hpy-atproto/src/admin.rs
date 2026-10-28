//! A HappyView instance's admin API, as `hpy` talks to it: an `hv_` API key
//! sent as a bearer token, and the calls a deploy makes.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::credential::Credential;
use crate::{Error, Result};

pub struct Admin {
    base: String,
    auth: Auth,
    http: reqwest::Client,
}

/// How a request proves who sends it: an `hv_` API key (for CI), or the
/// session `hpy happyview login` registered with the instance.
enum Auth {
    ApiKey(String),
    Session(Credential),
}

impl std::fmt::Debug for Admin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key is a secret; never print it.
        f.debug_struct("Admin")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

/// A plugin as `GET /admin/plugins` lists it; only what a deploy compares.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
    pub plugin_type: String,
    /// The registry project it was installed from; `None` for a URL or file
    /// install.
    #[serde(default)]
    pub registry: Option<InstalledFrom>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct InstalledFrom {
    #[serde(default)]
    pub did: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version_uri: Option<String>,
}

#[derive(Deserialize)]
struct PluginList {
    plugins: Vec<InstalledPlugin>,
}

#[derive(Deserialize, Default)]
struct Refusal {
    error: Option<String>,
    message: Option<String>,
    #[serde(default)]
    dependents: Vec<String>,
    #[serde(default)]
    problems: Vec<ProjectProblem>,
}

/// Something wrong with a project file, as the instance's loader says it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ProjectProblem {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub line: Option<u32>,
    pub message: String,
}

impl std::fmt::Display for ProjectProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (self.path.as_str(), self.line) {
            ("", _) => write!(f, "{}", self.message),
            (path, Some(line)) => write!(f, "{path}:{line}: {}", self.message),
            (path, None) => write!(f, "{path}: {}", self.message),
        }
    }
}

/// The project an instance serves, as `GET /admin/project` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct DeployedProject {
    pub sha256: String,
    pub deployed_at: Option<String>,
    pub deployed_by: Option<String>,
    /// Why the stored project failed to build at the instance's last boot,
    /// leaving it serving none; empty when it is being served.
    pub problems: Vec<ProjectProblem>,
}

#[derive(Deserialize)]
struct RawDeployed {
    sha256: String,
    #[serde(default)]
    deployed_at: Option<String>,
    #[serde(default)]
    deployed_by: Option<String>,
    #[serde(default)]
    error: Option<RawBootError>,
}

#[derive(Deserialize)]
struct RawBootError {
    #[serde(default)]
    problems: Vec<ProjectProblem>,
}

/// What one kind of thing in the project gained, changed or lost.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Changes {
    #[serde(default)]
    pub added: Vec<String>,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub removed: Vec<String>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.changed.is_empty() && self.removed.is_empty()
    }
}

/// What `PUT /admin/project` did, or on a dry run would do.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ProjectDeploy {
    pub sha256: String,
    pub dry_run: bool,
    #[serde(default)]
    pub deployed_at: Option<String>,
    /// By kind: `lexicons`, `scripts`, `modules`, `network_lexicons`,
    /// `labelers`, and any the instance adds later.
    #[serde(default)]
    pub changes: std::collections::BTreeMap<String, Changes>,
    /// Record lexicons whose backfill this started (or would start).
    #[serde(default)]
    pub backfills: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<ProjectProblem>,
}

impl ProjectDeploy {
    /// Nothing in the project differs from what the instance serves.
    pub fn is_empty(&self) -> bool {
        self.changes.values().all(Changes::is_empty) && self.backfills.is_empty()
    }
}

enum Body<'a> {
    None,
    Json(&'a Value),
    Gzip(Vec<u8>),
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .build()
        .expect("http client")
}

impl Admin {
    /// Signed in with an API key.
    pub fn new(base: &str, key: &str) -> Admin {
        Admin {
            base: base.trim_end_matches('/').into(),
            auth: Auth::ApiKey(key.into()),
            http: http(),
        }
    }

    /// Signed in as the user whose session `cred` holds, on the instance it
    /// was registered with.
    pub fn with_session(cred: Credential) -> Admin {
        Admin {
            base: cred.registry.trim_end_matches('/').into(),
            auth: Auth::Session(cred),
            http: http(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Sends one admin request and answers its status and body; only a
    /// request that never got an answer is an error here.
    async fn request(
        &self,
        what: &str,
        method: reqwest::Method,
        path: &str,
        body: Body<'_>,
        if_match: Option<&str>,
    ) -> Result<(reqwest::StatusCode, Vec<u8>)> {
        let url = format!("{}/admin{path}", self.base);
        let mut req = match &self.auth {
            Auth::ApiKey(key) => self.http.request(method, &url).bearer_auth(key),
            Auth::Session(cred) => {
                let proof =
                    cred.dpop_key
                        .proof(method.as_str(), &url, Some(&cred.access_token), None);
                self.http
                    .request(method, &url)
                    .header("authorization", format!("DPoP {}", cred.access_token))
                    .header("dpop", proof)
                    .header("x-client-key", &cred.client_key)
            }
        };
        req = match body {
            Body::None => req,
            Body::Json(body) => req.json(body),
            Body::Gzip(bytes) => req.header("content-type", "application/gzip").body(bytes),
        };
        if let Some(etag) = if_match {
            req = req.header("if-match", format!("\"{etag}\""));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| Error::Other(format!("could not reach {} ({what}): {e}", self.base)))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(Error::other)?.to_vec();
        Ok((status, bytes))
    }

    /// The JSON body of a successful answer (`Null` for an empty one), or
    /// the refusal as an error. `what` names the call in errors.
    fn answer(&self, what: &str, status: reqwest::StatusCode, bytes: &[u8]) -> Result<Value> {
        if status.is_success() {
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_slice(bytes).map_err(|e| {
                Error::Other(format!(
                    "{} answered {what} with something unreadable: {e}",
                    self.base
                ))
            });
        }
        let refusal: Refusal = serde_json::from_slice(bytes).unwrap_or_default();
        Err(self.refused(what, status, refusal))
    }

    async fn send(
        &self,
        what: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let body = body.map_or(Body::None, Body::Json);
        let (status, bytes) = self.request(what, method, path, body, None).await?;
        self.answer(what, status, &bytes)
    }

    /// The project the instance serves; `None` when none was ever deployed.
    pub async fn project(&self) -> Result<Option<DeployedProject>> {
        let what = "reading the deployed project";
        let (status, bytes) = self
            .request(what, reqwest::Method::GET, "/project", Body::None, None)
            .await?;
        if status == reqwest::StatusCode::NOT_FOUND {
            let refusal: Refusal = serde_json::from_slice(&bytes).unwrap_or_default();
            if refusal.error.as_deref() == Some("NoProject") {
                return Ok(None);
            }
            return Err(Error::Other(format!(
                "{} has no project deploys; it runs a HappyView too old for `hpy happyview deploy`",
                self.base
            )));
        }
        let raw: RawDeployed =
            serde_json::from_value(self.answer(what, status, &bytes)?).map_err(|e| {
                Error::Other(format!(
                    "{} described its project unreadably: {e}",
                    self.base
                ))
            })?;
        Ok(Some(DeployedProject {
            sha256: raw.sha256,
            deployed_at: raw.deployed_at,
            deployed_by: raw.deployed_by,
            problems: raw.error.map(|e| e.problems).unwrap_or_default(),
        }))
    }

    /// Sends a project bundle. `seen` is the sha256 of the project this
    /// deploy compared against, so one deployed meanwhile is not overwritten.
    pub async fn deploy_project(
        &self,
        bundle: Vec<u8>,
        dry_run: bool,
        seen: Option<&str>,
    ) -> Result<ProjectDeploy> {
        let what = if dry_run {
            "checking the project"
        } else {
            "deploying the project"
        };
        let path = format!("/project?dry_run={dry_run}");
        let (status, bytes) = self
            .request(what, reqwest::Method::PUT, &path, Body::Gzip(bundle), seen)
            .await?;
        serde_json::from_value(self.answer(what, status, &bytes)?)
            .map_err(|e| Error::Other(format!("{} answered {what} unreadably: {e}", self.base)))
    }

    fn refused(&self, what: &str, status: reqwest::StatusCode, r: Refusal) -> Error {
        use reqwest::StatusCode;
        match status {
            StatusCode::UNAUTHORIZED => match self.auth {
                Auth::Session(_) => Error::LoginRequired(format!(
                    "your sign-in to {} has expired or was revoked; run `hpy hv login --url {}`",
                    self.base, self.base
                )),
                Auth::ApiKey(_) => Error::LoginRequired(format!(
                    "{} refused the API key; create a new one in its dashboard and set {} (or pipe it to `hpy hv login --url {} --key-stdin`)",
                    self.base,
                    crate::instance::KEY_VAR,
                    self.base
                )),
            },
            _ if r.error.as_deref() == Some("InvalidProject") => {
                let mut message = format!("{} refused the project", self.base);
                if let Some(m) = &r.message {
                    message = format!("{message}: {m}");
                }
                for p in &r.problems {
                    message.push_str(&format!("\n  • {p}"));
                }
                Error::Registry {
                    name: "InvalidProject".into(),
                    message,
                }
            }
            StatusCode::PRECONDITION_FAILED => Error::Other(format!(
                "the project on {} changed since this deploy read it; run the deploy again to see what it would change now",
                self.base
            )),
            StatusCode::CONFLICT if r.error.as_deref() == Some("ProjectFromFile") => {
                Error::Other(format!(
                    "{} takes its project from a directory (HAPPYVIEW_PROJECT), so a deploy can't change it; update that directory instead",
                    self.base
                ))
            }
            StatusCode::PAYLOAD_TOO_LARGE => Error::Other(format!(
                "the project is too large for {} to accept; it takes bundles up to 50 MB compressed",
                self.base
            )),
            StatusCode::FORBIDDEN
                if r.error
                    .iter()
                    .chain(&r.message)
                    .any(|m| m.contains("not a user")) =>
            {
                Error::Other(format!(
                    "your account isn't an admin of {}; ask its owner to add you in its dashboard",
                    self.base
                ))
            }
            StatusCode::FORBIDDEN
                if r.error
                    .iter()
                    .chain(&r.message)
                    .any(|m| m.contains("API client's session")) =>
            {
                Error::LoginRequired(format!(
                    "{} doesn't accept this sign-in for deploying; run `hpy hv login --url {}`",
                    self.base, self.base
                ))
            }
            StatusCode::FORBIDDEN => Error::Other(format!(
                "{} refused {what}: {}. Give the API key that permission in the dashboard, or create one that has it",
                self.base,
                r.message
                    .or(r.error)
                    .unwrap_or_else(|| "the API key's user is not allowed to".into())
            )),
            _ => {
                let mut detail = match (r.error, r.message) {
                    (Some(e), Some(m)) => format!("{e}: {m}"),
                    (Some(e), None) | (None, Some(e)) => e,
                    (None, None) => format!("HTTP {status}"),
                };
                if !r.dependents.is_empty() {
                    detail = format!("{detail} ({} depend on it)", r.dependents.join(", "));
                }
                Error::Other(format!("{} refused {what} ({detail})", self.base))
            }
        }
    }

    /// Every installed plugin.
    pub async fn plugins(&self) -> Result<Vec<InstalledPlugin>> {
        let out = self
            .send("listing plugins", reqwest::Method::GET, "/plugins", None)
            .await?;
        let list: PluginList = serde_json::from_value(out).map_err(|e| {
            Error::Other(format!("{} listed its plugins unreadably: {e}", self.base))
        })?;
        Ok(list.plugins)
    }

    /// Installs one exact version of a registry project.
    pub async fn install(&self, did: &str, name: &str, version: &str) -> Result<InstalledPlugin> {
        let body = json!({ "registry": { "did": did, "name": name, "version": version } });
        let out = self
            .send(
                &format!("installing {name} {version}"),
                reqwest::Method::POST,
                "/plugins",
                Some(&body),
            )
            .await?;
        serde_json::from_value(out).map_err(|e| {
            Error::Other(format!(
                "{} answered the install of {name} unreadably: {e}",
                self.base
            ))
        })
    }

    /// Moves an installed registry plugin to one exact version.
    pub async fn reload(&self, id: &str, version: &str) -> Result<()> {
        let body = json!({ "registry": { "version": version } });
        self.send(
            &format!("moving {id} to {version}"),
            reqwest::Method::POST,
            &format!("/plugins/{}/reload", segment(id)),
            Some(&body),
        )
        .await?;
        Ok(())
    }

    /// Uninstalls a plugin; refused while others depend on it.
    pub async fn remove(&self, id: &str) -> Result<()> {
        self.send(
            &format!("removing {id}"),
            reqwest::Method::DELETE,
            &format!("/plugins/{}", segment(id)),
            None,
        )
        .await?;
        Ok(())
    }
}

/// One path segment, percent-encoded.
fn segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_bytes, body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const KEY: &str = "hv_0123456789abcdef0123456789abcdef";

    fn plugin(id: &str, version_uri: Option<&str>) -> serde_json::Value {
        json!({
            "id": id, "name": id, "version": "1.0.0", "source": "registry",
            "enabled": true, "plugin_type": "interpreter",
            "registry": version_uri.map(|v| json!({
                "did": "did:plc:pub", "name": id, "channel": null, "version_uri": v,
                "unresolved": false
            })),
            "capabilities": {}
        })
    }

    #[tokio::test]
    async fn lists_plugins_with_the_key_as_a_bearer_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/plugins"))
            .and(header("authorization", format!("Bearer {KEY}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "plugins": [plugin("lua", Some("at://did:plc:pub/v/1")), plugin("hand-made", None)],
                "encryption_configured": true
            })))
            .mount(&server)
            .await;
        let admin = Admin::new(&server.uri(), KEY);
        let plugins = admin.plugins().await.unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].id, "lua");
        assert_eq!(plugins[0].plugin_type, "interpreter");
        let registry = plugins[0].registry.as_ref().unwrap();
        assert_eq!(registry.did.as_deref(), Some("did:plc:pub"));
        assert_eq!(
            registry.version_uri.as_deref(),
            Some("at://did:plc:pub/v/1")
        );
        assert!(plugins[1].registry.is_none());
    }

    #[tokio::test]
    async fn a_refused_key_says_how_to_sign_in_again() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({"error": "Unauthorized"})),
            )
            .mount(&server)
            .await;
        let err = Admin::new(&server.uri(), KEY).plugins().await.unwrap_err();
        assert!(err.is_auth(), "{err}");
        let text = err.to_string();
        assert!(text.contains("hpy hv login --url"), "{text}");
        assert!(text.contains(&server.uri()), "{text}");
    }

    #[tokio::test]
    async fn an_expired_session_says_to_sign_in_again() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({"error": "Unauthorized"})),
            )
            .mount(&server)
            .await;
        let cred = crate::credential::Credential {
            registry: server.uri(),
            client_key: "hvc_hpy".into(),
            did: "did:plc:me".into(),
            handle: None,
            pds: "https://pds.test".into(),
            scopes: "atproto".into(),
            access_token: "t".into(),
            dpop_key: crate::dpop::DpopKey::generate(),
        };
        let err = Admin::with_session(cred).project().await.unwrap_err();
        assert!(err.is_auth(), "{err}");
        let text = err.to_string();
        assert!(text.contains("expired"), "{text}");
        assert!(
            text.contains(&format!("hpy hv login --url {}", server.uri())),
            "{text}"
        );
        assert!(!text.contains("API key"), "{text}");
    }

    #[tokio::test]
    async fn a_missing_permission_is_named() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "error": "InsufficientPermissions", "message": "Missing permission: plugins:read"
            })))
            .mount(&server)
            .await;
        let text = Admin::new(&server.uri(), KEY)
            .plugins()
            .await
            .unwrap_err()
            .to_string();
        assert!(text.contains("plugins:read"), "{text}");
        assert!(text.contains("API key"), "{text}");
    }

    #[tokio::test]
    async fn an_account_that_is_not_an_admin_is_told_so() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({"error": "not a user"})))
            .mount(&server)
            .await;
        let err = Admin::new(&server.uri(), KEY).project().await.unwrap_err();
        let text = err.to_string();
        assert!(text.contains("isn't an admin"), "{text}");
    }

    #[tokio::test]
    async fn a_session_of_another_client_says_to_sign_in_again() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "error": "Forbidden", "message": "an API client's session cannot use the admin API"
            })))
            .mount(&server)
            .await;
        let err = Admin::new(&server.uri(), KEY).project().await.unwrap_err();
        assert!(err.is_auth(), "{err}");
        assert!(err.to_string().contains("hpy hv login --url"), "{err}");
    }

    #[tokio::test]
    async fn installs_a_registry_version() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/admin/plugins"))
            .and(body_json(json!({
                "registry": {"did": "did:plc:pub", "name": "lua", "version": "1.2.0"}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(plugin("lua", Some("at://x"))))
            .expect(1)
            .mount(&server)
            .await;
        let installed = Admin::new(&server.uri(), KEY)
            .install("did:plc:pub", "lua", "1.2.0")
            .await
            .unwrap();
        assert_eq!(installed.id, "lua");
    }

    #[tokio::test]
    async fn moves_an_installed_plugin_to_a_version() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/admin/plugins/lua/reload"))
            .and(body_json(json!({"registry": {"version": "1.3.0"}})))
            .respond_with(ResponseTemplate::new(200).set_body_json(plugin("lua", Some("at://x"))))
            .expect(1)
            .mount(&server)
            .await;
        Admin::new(&server.uri(), KEY)
            .reload("lua", "1.3.0")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn removing_a_plugin_others_need_names_them() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/admin/plugins/std"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "error": "plugin has dependents", "dependents": ["lua"]
            })))
            .mount(&server)
            .await;
        let text = Admin::new(&server.uri(), KEY)
            .remove("std")
            .await
            .unwrap_err()
            .to_string();
        assert!(text.contains("std"), "{text}");
        assert!(text.contains("lua"), "{text}");
    }

    #[tokio::test]
    async fn removes_a_plugin() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/admin/plugins/old"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Admin::new(&server.uri(), KEY).remove("old").await.unwrap();
    }

    fn deploy_answer(dry_run: bool) -> serde_json::Value {
        json!({
            "sha256": "abc", "dry_run": dry_run,
            "deployed_at": if dry_run { serde_json::Value::Null } else { json!("2026-10-28T20:00:00Z") },
            "changes": {
                "lexicons": {"added": ["com.example.hello"], "changed": [], "removed": []},
                "scripts": {"added": ["xrpc.query:com.example.hello"], "changed": [], "removed": []},
                "modules": {"added": [], "changed": [], "removed": []}
            },
            "backfills": ["com.example.post"],
            "warnings": [{"path": "happyview.toml", "message": "[jetstream] is ignored"}]
        })
    }

    #[tokio::test]
    async fn no_deployed_project_is_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/project"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "NoProject"})))
            .mount(&server)
            .await;
        assert_eq!(
            Admin::new(&server.uri(), KEY).project().await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn the_deployed_project_carries_its_boot_problems() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/project"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sha256": "abc", "deployed_at": "2026-10-28T20:00:00Z", "deployed_by": "did:plc:me",
                "error": {"problems": [{"path": "src/x.ts", "message": "no interpreter claims .ts"}]}
            })))
            .mount(&server)
            .await;
        let deployed = Admin::new(&server.uri(), KEY)
            .project()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(deployed.sha256, "abc");
        assert_eq!(deployed.problems.len(), 1);
        assert_eq!(deployed.problems[0].path, "src/x.ts");
    }

    #[tokio::test]
    async fn deploys_a_bundle_as_gzip_with_the_version_it_saw() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/admin/project"))
            .and(query_param("dry_run", "true"))
            .and(header("content-type", "application/gzip"))
            .and(header("if-match", "\"old\""))
            .and(header("authorization", format!("Bearer {KEY}").as_str()))
            .and(body_bytes(b"bundle".to_vec()))
            .respond_with(ResponseTemplate::new(200).set_body_json(deploy_answer(true)))
            .expect(1)
            .mount(&server)
            .await;
        let out = Admin::new(&server.uri(), KEY)
            .deploy_project(b"bundle".to_vec(), true, Some("old"))
            .await
            .unwrap();
        assert!(out.dry_run);
        assert_eq!(out.changes["lexicons"].added, ["com.example.hello"]);
        assert_eq!(out.backfills, ["com.example.post"]);
        assert_eq!(out.warnings[0].message, "[jetstream] is ignored");
        assert!(!out.is_empty());
    }

    #[tokio::test]
    async fn a_first_deploy_sends_no_if_match() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/admin/project"))
            .and(query_param("dry_run", "false"))
            .respond_with(move |req: &wiremock::Request| {
                assert!(req.headers.get("if-match").is_none());
                ResponseTemplate::new(200).set_body_json(deploy_answer(false))
            })
            .expect(1)
            .mount(&server)
            .await;
        Admin::new(&server.uri(), KEY)
            .deploy_project(b"bundle".to_vec(), false, None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn an_invalid_project_lists_its_problems_as_a_usage_error() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(422).set_body_json(json!({
                "error": "InvalidProject", "message": "the project has 2 problems",
                "problems": [
                    {"path": "src/lexicons/com/example/hello.json", "message": "id does not match the path"},
                    {"path": "happyview.toml", "line": 7, "message": "unknown table [scirpts]"},
                    {"path": "", "message": "the archive expands past 200 MB"}
                ]
            })))
            .mount(&server)
            .await;
        let err = Admin::new(&server.uri(), KEY)
            .deploy_project(b"x".to_vec(), true, None)
            .await
            .unwrap_err();
        assert!(err.is_usage(), "{err}");
        let text = err.to_string();
        assert!(
            text.contains("src/lexicons/com/example/hello.json: id does not match the path"),
            "{text}"
        );
        assert!(
            text.contains("happyview.toml:7: unknown table [scirpts]"),
            "{text}"
        );
        assert!(
            text.contains("  • the archive expands past 200 MB"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn refusals_of_a_deploy_say_what_to_do() {
        for (status, body, says) in [
            (412, json!({"error": "PreconditionFailed"}), "changed since"),
            (
                409,
                json!({"error": "ProjectFromFile"}),
                "HAPPYVIEW_PROJECT",
            ),
            (413, json!({"error": "PayloadTooLarge"}), "too large"),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("PUT"))
                .respond_with(ResponseTemplate::new(status).set_body_json(body))
                .mount(&server)
                .await;
            let text = Admin::new(&server.uri(), KEY)
                .deploy_project(b"x".to_vec(), false, Some("a"))
                .await
                .unwrap_err()
                .to_string();
            assert!(text.contains(says), "{status}: {text}");
        }
    }

    #[tokio::test]
    async fn an_unreachable_instance_is_named() {
        let text = Admin::new("http://127.0.0.1:9", KEY)
            .plugins()
            .await
            .unwrap_err()
            .to_string();
        assert!(text.contains("127.0.0.1:9"), "{text}");
    }

    #[tokio::test]
    async fn a_signed_in_session_sends_a_dpop_proof_for_each_request() {
        use base64::Engine;
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/admin/project"))
            .and(header("authorization", "DPoP session-token"))
            .and(header("x-client-key", "hvc_hpy"))
            .respond_with(ResponseTemplate::new(200).set_body_json(deploy_answer(true)))
            .expect(1)
            .mount(&server)
            .await;
        let cred = crate::credential::Credential {
            registry: server.uri(),
            client_key: "hvc_hpy".into(),
            did: "did:plc:me".into(),
            handle: None,
            pds: "https://pds.test".into(),
            scopes: "atproto".into(),
            access_token: "session-token".into(),
            dpop_key: crate::dpop::DpopKey::generate(),
        };
        let admin = Admin::with_session(cred);
        admin
            .deploy_project(b"x".to_vec(), true, None)
            .await
            .unwrap();
        let req = &server.received_requests().await.unwrap()[0];
        let proof = req.headers.get("dpop").unwrap().to_str().unwrap();
        let claims = proof.split('.').nth(1).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(claims)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claims["htm"], "PUT");
        // HappyView checks htu against the path, without the query.
        assert_eq!(claims["htu"], format!("{}/admin/project", server.uri()));
        assert!(claims["ath"].is_string());
    }

    #[test]
    fn the_key_never_appears_in_debug_output() {
        let admin = Admin::new("https://api.example.com", KEY);
        assert!(!format!("{admin:?}").contains(KEY));
    }
}
