//! A HappyView instance's admin API, as `hpy` talks to it: an `hv_` API key
//! sent as a bearer token, and the calls a deploy makes.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Error, Result};

pub struct Admin {
    base: String,
    key: String,
    http: reqwest::Client,
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
}

impl Admin {
    pub fn new(base: &str, key: &str) -> Admin {
        Admin {
            base: base.trim_end_matches('/').into(),
            key: key.into(),
            http: reqwest::Client::builder()
                .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(120))
                .build()
                .expect("http client"),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Sends one admin request and answers its JSON body (`Null` for an
    /// empty one). `what` names the call in errors.
    async fn send(
        &self,
        what: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let url = format!("{}/admin{path}", self.base);
        let mut req = self.http.request(method, &url).bearer_auth(&self.key);
        if let Some(body) = body {
            req = req.json(body);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| Error::Other(format!("could not reach {} ({what}): {e}", self.base)))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(Error::other)?;
        if status.is_success() {
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_slice(&bytes).map_err(|e| {
                Error::Other(format!(
                    "{} answered {what} with something unreadable: {e}",
                    self.base
                ))
            });
        }
        let refusal: Refusal = serde_json::from_slice(&bytes).unwrap_or_default();
        Err(self.refused(what, status, refusal))
    }

    fn refused(&self, what: &str, status: reqwest::StatusCode, r: Refusal) -> Error {
        use reqwest::StatusCode;
        match status {
            StatusCode::UNAUTHORIZED => Error::LoginRequired(format!(
                "{} refused the API key; create a new one in its dashboard and run `hpy hv login --url {}`",
                self.base, self.base
            )),
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
    use wiremock::matchers::{body_json, header, method, path};
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

    #[tokio::test]
    async fn an_unreachable_instance_is_named() {
        let text = Admin::new("http://127.0.0.1:9", KEY)
            .plugins()
            .await
            .unwrap_err()
            .to_string();
        assert!(text.contains("127.0.0.1:9"), "{text}");
    }

    #[test]
    fn the_key_never_appears_in_debug_output() {
        let admin = Admin::new("https://api.example.com", KEY);
        assert!(!format!("{admin:?}").contains(KEY));
    }
}
