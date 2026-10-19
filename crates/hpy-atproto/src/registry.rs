use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

use std::sync::Arc;

use crate::credential::Credential;
use crate::happyview::HappyView;
use crate::repo::WriteResult;
use crate::{Error, Result};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageView {
    pub uri: String,
    #[serde(default)]
    pub did: String,
    #[serde(default)]
    pub handle: Option<String>,
    pub status: String,
    #[serde(default)]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub record: Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseView {
    pub uri: String,
    pub status: String,
    #[serde(default)]
    pub record: Value,
    #[serde(default)]
    pub indexed_at: Option<String>,
}

#[async_trait]
pub trait Registry: Send + Sync {
    async fn get_package(&self, did: &str, slug: &str) -> Result<Option<PackageView>>;
    async fn get_release(
        &self,
        did: &str,
        slug: &str,
        version: &str,
    ) -> Result<Option<ReleaseView>>;
    async fn list_releases(&self, did: &str, slug: &str) -> Result<Vec<ReleaseView>>;
    /// Every package whose latest release is of `plugin_type`. The registry
    /// leaves `latest_version` and `handle` unset here; `get_package` fills them.
    async fn search_packages(&self, plugin_type: &str) -> Result<Vec<PackageView>>;
    /// The `package` artifact of one release: the module's bytes.
    async fn get_artifact(&self, did: &str, slug: &str, version: &str) -> Result<Vec<u8>>;
    /// The `manifest` artifact of one release: the `manifest.json` its
    /// publisher attached.
    async fn get_manifest_artifact(&self, did: &str, slug: &str, version: &str) -> Result<Vec<u8>>;
    /// Checks a profile against the indexer's rules and, unless
    /// `validate_only`, writes it to the signed-in user's repo.
    async fn publish_profile(
        &self,
        slug: &str,
        record: Value,
        validate_only: bool,
    ) -> Result<Option<WriteResult>>;
    /// Checks a release against the indexer's rules and, unless
    /// `validate_only`, writes it to the signed-in user's repo.
    async fn publish_release(
        &self,
        record: Value,
        validate_only: bool,
    ) -> Result<Option<WriteResult>>;
    /// Replaces a profile the signed-in user already published. With
    /// `swap_cid`, refuses (`InvalidSwap`) if it changed since that read.
    async fn update_profile(
        &self,
        slug: &str,
        record: Value,
        swap_cid: Option<&str>,
    ) -> Result<WriteResult>;
    /// Deletes one of the signed-in user's releases; `false` when that
    /// version is not published from their account.
    async fn withdraw_release(&self, slug: &str, version: &str) -> Result<bool>;
    /// Enqueues the artifact copy of one of the signed-in user's pending
    /// releases again, and answers the release's status: `pending` when the
    /// copy was enqueued, `active` when the artifact is already held. `None`
    /// when that version is not published from their account or was
    /// withdrawn.
    async fn retry_release(&self, slug: &str, version: &str) -> Result<Option<String>>;
}

/// The registry's public XRPC queries, over plain HTTP.
pub struct HttpRegistry {
    base: String,
    http: reqwest::Client,
    /// The signed-in session, for the procedures that write.
    session: Option<(Arc<HappyView>, Credential)>,
    /// Identifies `hpy` to HappyView on reads, so they get its rate limit
    /// rather than the shared anonymous one.
    client_key: Option<String>,
}

#[derive(Deserialize)]
struct XrpcErrorBody {
    error: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct ListReleases {
    #[serde(default)]
    releases: Vec<ReleaseView>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct SearchPackages {
    #[serde(default)]
    packages: Vec<PackageView>,
    cursor: Option<String>,
}

const NOT_FOUND: [&str; 2] = ["PackageNotFound", "ReleaseNotFound"];

impl HttpRegistry {
    pub fn new(base_url: &str) -> HttpRegistry {
        HttpRegistry {
            base: base_url.trim_end_matches('/').into(),
            http: reqwest::Client::builder()
                .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
            session: None,
            client_key: None,
        }
    }

    pub fn with_client_key(mut self, client_key: &str) -> HttpRegistry {
        self.client_key = Some(client_key.into());
        self
    }

    pub fn with_session(mut self, hv: Arc<HappyView>, cred: Credential) -> HttpRegistry {
        self.client_key = Some(cred.client_key.clone());
        self.session = Some((hv, cred));
        self
    }

    /// A registry procedure as the signed-in user.
    async fn procedure(&self, nsid: &str, body: &Value) -> Result<Value> {
        let (hv, cred) = self.session.as_ref().ok_or(Error::NotLoggedIn)?;
        hv.procedure(cred, nsid, body).await
    }

    async fn publish(
        &self,
        nsid: &str,
        mut body: Value,
        validate_only: bool,
    ) -> Result<Option<WriteResult>> {
        body["validateOnly"] = validate_only.into();
        let out = self.procedure(nsid, &body).await?;
        if validate_only {
            return Ok(None);
        }
        written(nsid, &out).map(Some)
    }

    /// `Ok(None)` for the registry's not-found errors.
    async fn query<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: &[(&str, &str)],
    ) -> Result<Option<T>> {
        let url = format!("{}/xrpc/{method}", self.base);
        let mut request = self.http.get(&url).query(params);
        if let Some(key) = &self.client_key {
            request = request.header("x-client-key", key);
        }
        let resp = request.send().await.map_err(|e| {
            Error::Other(format!(
                "could not reach the registry at {}: {e}",
                self.base
            ))
        })?;
        let status = resp.status();
        let body = resp.bytes().await.map_err(Error::other)?;
        // A Lua query's `{ error, message }` arrives with 200 OK, so a body
        // carrying `error` is an error whatever the status.
        let value: Option<Value> = serde_json::from_slice(&body).ok();
        let failed = !status.is_success()
            || value
                .as_ref()
                .is_some_and(|v| v.get("error").is_some_and(Value::is_string));
        if !failed {
            let value = value
                .ok_or_else(|| Error::Other(format!("{method} answered something unreadable")))?;
            return serde_json::from_value(value)
                .map(Some)
                .map_err(|e| Error::Other(format!("{method} answered something unreadable: {e}")));
        }
        let err: XrpcErrorBody = serde_json::from_slice(&body).unwrap_or(XrpcErrorBody {
            error: None,
            message: None,
        });
        let name = err.error.unwrap_or_else(|| format!("HTTP {status}"));
        if NOT_FOUND.contains(&name.as_str()) {
            return Ok(None);
        }
        Err(Error::Xrpc {
            method: method.into(),
            name,
            message: err.message,
        })
    }
}

fn written(nsid: &str, out: &Value) -> Result<WriteResult> {
    match (out["uri"].as_str(), out["cid"].as_str()) {
        (Some(uri), Some(cid)) => Ok(WriteResult {
            uri: uri.into(),
            cid: cid.into(),
        }),
        _ => Err(Error::Other(format!("{nsid} answered no uri/cid"))),
    }
}

impl HttpRegistry {
    /// One artifact of a release by its `type`, from the registry's copy.
    async fn artifact(&self, did: &str, slug: &str, version: &str, kind: &str) -> Result<Vec<u8>> {
        const METHOD: &str = "at.happyproto.registry.getArtifact";
        let url = format!("{}/xrpc/{METHOD}", self.base);
        let mut request = self.http.get(&url).query(&[
            ("did", did),
            ("slug", slug),
            ("version", version),
            ("type", kind),
        ]);
        if let Some(key) = &self.client_key {
            request = request.header("x-client-key", key);
        }
        let resp = request.send().await.map_err(|e| {
            Error::Other(format!(
                "could not reach the registry at {}: {e}",
                self.base
            ))
        })?;
        let status = resp.status();
        // A JSON body under 200 is an error envelope when it names an error,
        // as a Lua query's errors arrive; a manifest is JSON that names none.
        let json = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"));
        let body = resp.bytes().await.map_err(Error::other)?;
        let err: XrpcErrorBody = json
            .then(|| serde_json::from_slice(&body).ok())
            .flatten()
            .unwrap_or(XrpcErrorBody {
                error: None,
                message: None,
            });
        if status.is_success() && err.error.is_none() {
            return Ok(body.to_vec());
        }
        Err(Error::Xrpc {
            method: METHOD.into(),
            name: err.error.unwrap_or_else(|| format!("HTTP {status}")),
            message: err.message,
        })
    }
}

#[async_trait]
impl Registry for HttpRegistry {
    async fn get_package(&self, did: &str, slug: &str) -> Result<Option<PackageView>> {
        self.query(
            "at.happyproto.registry.getPackage",
            &[("actor", did), ("slug", slug)],
        )
        .await
    }

    async fn get_release(
        &self,
        did: &str,
        slug: &str,
        version: &str,
    ) -> Result<Option<ReleaseView>> {
        self.query(
            "at.happyproto.registry.getRelease",
            &[("did", did), ("slug", slug), ("version", version)],
        )
        .await
    }

    async fn list_releases(&self, did: &str, slug: &str) -> Result<Vec<ReleaseView>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut params = vec![("did", did), ("slug", slug), ("limit", "100")];
            if let Some(c) = &cursor {
                params.push(("cursor", c));
            }
            let page: Option<ListReleases> = self
                .query("at.happyproto.registry.listReleases", &params)
                .await?;
            let Some(page) = page else { break };
            out.extend(page.releases);
            match page.cursor {
                Some(c) if Some(&c) != cursor.as_ref() => cursor = Some(c),
                _ => break,
            }
        }
        Ok(out)
    }

    async fn search_packages(&self, plugin_type: &str) -> Result<Vec<PackageView>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut params = vec![("pluginType", plugin_type), ("limit", "100")];
            if let Some(c) = &cursor {
                params.push(("cursor", c));
            }
            let page: Option<SearchPackages> = self
                .query("at.happyproto.registry.searchPackages", &params)
                .await?;
            let Some(page) = page else { break };
            out.extend(page.packages);
            match page.cursor {
                Some(c) if Some(&c) != cursor.as_ref() => cursor = Some(c),
                _ => break,
            }
        }
        Ok(out)
    }

    async fn get_artifact(&self, did: &str, slug: &str, version: &str) -> Result<Vec<u8>> {
        self.artifact(did, slug, version, "package").await
    }

    async fn get_manifest_artifact(&self, did: &str, slug: &str, version: &str) -> Result<Vec<u8>> {
        self.artifact(did, slug, version, "manifest").await
    }

    async fn publish_profile(
        &self,
        slug: &str,
        record: Value,
        validate_only: bool,
    ) -> Result<Option<WriteResult>> {
        let body = serde_json::json!({ "slug": slug, "record": record });
        self.publish("at.happyproto.registry.publishProfile", body, validate_only)
            .await
    }

    async fn publish_release(
        &self,
        record: Value,
        validate_only: bool,
    ) -> Result<Option<WriteResult>> {
        let body = serde_json::json!({ "record": record });
        self.publish("at.happyproto.registry.publishRelease", body, validate_only)
            .await
    }

    async fn update_profile(
        &self,
        slug: &str,
        record: Value,
        swap_cid: Option<&str>,
    ) -> Result<WriteResult> {
        const NSID: &str = "at.happyproto.registry.updateProfile";
        let mut body = serde_json::json!({ "slug": slug, "record": record });
        if let Some(cid) = swap_cid {
            body["swapCid"] = cid.into();
        }
        written(NSID, &self.procedure(NSID, &body).await?)
    }

    async fn withdraw_release(&self, slug: &str, version: &str) -> Result<bool> {
        let body = serde_json::json!({ "slug": slug, "version": version });
        match self
            .procedure("at.happyproto.registry.withdrawRelease", &body)
            .await
        {
            Ok(_) => Ok(true),
            Err(Error::Xrpc { name, .. }) if name == "ReleaseNotFound" => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn retry_release(&self, slug: &str, version: &str) -> Result<Option<String>> {
        let body = serde_json::json!({ "slug": slug, "version": version });
        match self
            .procedure("at.happyproto.registry.retryRelease", &body)
            .await
        {
            Ok(out) => match out["status"].as_str() {
                Some(status) => Ok(Some(status.into())),
                None => Err(Error::Other(
                    "at.happyproto.registry.retryRelease answered no status".into(),
                )),
            },
            Err(Error::Xrpc { name, .. }) if name == "ReleaseNotFound" => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_release_found_and_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getRelease"))
            .and(query_param("version", "1.0.0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "uri": "at://did:plc:a/at.happyproto.plugin.release/x:1.0.0",
                "record": {}, "status": "pending"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getRelease"))
            .and(query_param("version", "2.0.0"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "ReleaseNotFound", "message": "no release"
            })))
            .mount(&server)
            .await;
        let reg = HttpRegistry::new(&server.uri());
        let found = reg
            .get_release("did:plc:a", "x", "1.0.0")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.status, "pending");
        assert!(
            reg.get_release("did:plc:a", "x", "2.0.0")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn list_releases_follows_cursor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.listReleases"))
            .and(query_param("cursor", "next"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "releases": [{"uri": "u2", "record": {}, "status": "active"}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.listReleases"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "releases": [{"uri": "u1", "record": {}, "status": "active"}], "cursor": "next"
            })))
            .mount(&server)
            .await;
        let reg = HttpRegistry::new(&server.uri());
        let all = reg.list_releases("did:plc:a", "x").await.unwrap();
        assert_eq!(
            all.iter().map(|r| r.uri.as_str()).collect::<Vec<_>>(),
            ["u1", "u2"]
        );
    }

    #[tokio::test]
    async fn search_packages_filters_by_type_and_follows_the_cursor() {
        // The deployed query leaves `latestVersion` and `handle` out.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.searchPackages"))
            .and(query_param("pluginType", "interpreter"))
            .and(query_param("cursor", "next"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "packages": [{ "uri": "u2", "did": "did:plc:a", "record": {}, "status": "active" }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.searchPackages"))
            .and(query_param("pluginType", "interpreter"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "packages": [{ "uri": "u1", "did": "did:plc:a", "record": {}, "status": "active" }],
                "cursor": "next"
            })))
            .mount(&server)
            .await;
        let all = HttpRegistry::new(&server.uri())
            .search_packages("interpreter")
            .await
            .unwrap();
        assert_eq!(
            all.iter().map(|p| p.uri.as_str()).collect::<Vec<_>>(),
            ["u1", "u2"]
        );
        assert_eq!(all[0].handle, None);
        assert_eq!(all[0].latest_version, None);
    }

    #[tokio::test]
    async fn get_artifact_answers_bytes_and_surfaces_refusals() {
        let server = MockServer::start().await;
        for (version, template) in [
            (
                "1.0.0",
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/wasm")
                    .set_body_bytes(b"\0asm\x01\0\0\0".to_vec()),
            ),
            (
                "2.0.0",
                ResponseTemplate::new(400).set_body_json(serde_json::json!({
                    "error": "ArtifactNotHeld", "message": "not copied yet"
                })),
            ),
            (
                "3.0.0",
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "error": "NotConfigured", "message": "no identity"
                })),
            ),
        ] {
            Mock::given(method("GET"))
                .and(path("/xrpc/at.happyproto.registry.getArtifact"))
                .and(query_param("version", version))
                .respond_with(template)
                .mount(&server)
                .await;
        }
        let reg = HttpRegistry::new(&server.uri());
        assert_eq!(
            reg.get_artifact("did:plc:a", "x", "1.0.0").await.unwrap(),
            b"\0asm\x01\0\0\0"
        );
        let err = reg
            .get_artifact("did:plc:a", "x", "2.0.0")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("ArtifactNotHeld"), "{err}");
        let err = reg
            .get_artifact("did:plc:a", "x", "3.0.0")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("NotConfigured"), "{err}");
    }

    #[tokio::test]
    async fn a_manifest_artifact_is_json_and_still_answers() {
        let server = MockServer::start().await;
        let manifest = serde_json::json!({ "id": "x", "supports_libraries": ["*"] });
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getArtifact"))
            .and(query_param("type", "manifest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&manifest))
            .mount(&server)
            .await;
        let bytes = HttpRegistry::new(&server.uri())
            .get_manifest_artifact("did:plc:a", "x", "1.0.0")
            .await
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), manifest);
    }

    #[tokio::test]
    async fn other_errors_surface() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
                "error": "NotConfigured", "message": "no identity"
            })))
            .mount(&server)
            .await;
        let err = HttpRegistry::new(&server.uri())
            .get_package("did:plc:a", "x")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("NotConfigured"), "{err}");
    }
}

#[cfg(test)]
mod publish_tests {
    use super::*;
    use crate::credential::Credential;
    use crate::dpop::DpopKey;
    use crate::happyview::HappyView;
    use std::sync::Arc;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn registry(server: &MockServer) -> HttpRegistry {
        let cred = Credential {
            registry: server.uri(),
            client_key: "hvc_test".into(),
            did: "did:plc:abc".into(),
            handle: None,
            pds: "https://pds.test".into(),
            scopes: "atproto".into(),
            access_token: "tok".into(),
            dpop_key: DpopKey::generate(),
        };
        HttpRegistry::new(&server.uri())
            .with_session(Arc::new(HappyView::new(&server.uri(), "hvc_test")), cred)
    }

    #[tokio::test]
    async fn validate_only_writes_nothing_and_answers_none() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.publishRelease"))
            .and(body_partial_json(
                serde_json::json!({ "validateOnly": true }),
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "valid": true })),
            )
            .expect(1)
            .mount(&server)
            .await;
        assert!(
            registry(&server)
                .publish_release(serde_json::json!({}), true)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn publish_profile_answers_the_written_record() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.publishProfile"))
            .and(body_partial_json(serde_json::json!({ "slug": "p", "validateOnly": false })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "valid": true, "uri": "at://did:plc:abc/at.happyproto.plugin.profile/p", "cid": "bafy"
            })))
            .mount(&server)
            .await;
        let w = registry(&server)
            .publish_profile("p", serde_json::json!({}), false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(w.cid, "bafy");
    }

    #[tokio::test]
    async fn update_profile_goes_through_the_registry_with_the_swap_cid() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.updateProfile"))
            .and(body_partial_json(serde_json::json!({
                "slug": "p", "record": { "name": "P" }, "swapCid": "bafyold"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "uri": "at://did:plc:abc/at.happyproto.plugin.profile/p", "cid": "bafynew"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let w = registry(&server)
            .update_profile("p", serde_json::json!({ "name": "P" }), Some("bafyold"))
            .await
            .unwrap();
        assert_eq!(w.cid, "bafynew");
    }

    #[tokio::test]
    async fn withdraw_release_goes_through_the_registry() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.withdrawRelease"))
            .and(body_partial_json(
                serde_json::json!({ "slug": "p", "version": "1.0.0" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "uri": "at://did:plc:abc/at.happyproto.plugin.release/p:1.0.0"
            })))
            .expect(1)
            .mount(&server)
            .await;
        assert!(
            registry(&server)
                .withdraw_release("p", "1.0.0")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn withdrawing_an_unpublished_version_answers_false() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.withdrawRelease"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "ReleaseNotFound", "message": "that version is not published from your account"
            })))
            .mount(&server)
            .await;
        assert!(
            !registry(&server)
                .withdraw_release("p", "9.9.9")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn retry_release_goes_through_the_registry_and_answers_the_status() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.retryRelease"))
            .and(body_partial_json(
                serde_json::json!({ "slug": "p", "version": "1.0.0" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "uri": "at://did:plc:abc/at.happyproto.plugin.release/p:1.0.0",
                "status": "pending"
            })))
            .expect(1)
            .mount(&server)
            .await;
        assert_eq!(
            registry(&server)
                .retry_release("p", "1.0.0")
                .await
                .unwrap()
                .as_deref(),
            Some("pending")
        );
    }

    #[tokio::test]
    async fn retrying_an_unpublished_version_answers_none() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/xrpc/at.happyproto.registry.retryRelease"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "ReleaseNotFound", "message": "that version is not published from your account"
            })))
            .mount(&server)
            .await;
        assert_eq!(
            registry(&server).retry_release("p", "9.9.9").await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn publishing_without_a_session_is_not_logged_in() {
        let err = HttpRegistry::new("http://127.0.0.1:9")
            .publish_release(serde_json::json!({}), true)
            .await
            .unwrap_err();
        assert!(err.is_auth());
    }

    #[tokio::test]
    async fn not_found_arriving_as_200_is_none_and_reads_carry_the_client_key() {
        use wiremock::matchers::header;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getPackage"))
            .and(header("x-client-key", "hvc_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "PackageNotFound", "message": "no package is indexed for that publisher and slug"
            })))
            .mount(&server)
            .await;
        let reg = HttpRegistry::new(&server.uri()).with_client_key("hvc_test");
        assert!(reg.get_package("did:plc:a", "x").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn other_errors_arriving_as_200_surface() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "error": "NotConfigured", "message": "no identity" }),
            ))
            .mount(&server)
            .await;
        let err = HttpRegistry::new(&server.uri())
            .get_release("did:plc:a", "x", "1.0.0")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("NotConfigured"), "{err}");
    }
}
