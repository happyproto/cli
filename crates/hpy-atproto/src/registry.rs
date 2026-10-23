use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::credential::Credential;
use crate::happyview::HappyView;
use crate::{Error, Result};

/// A record the gateway wrote or the registry indexed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ref {
    pub uri: String,
    pub cid: String,
}

/// A sidecar or project record's address; the registry may not have its CID
/// yet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordRef {
    pub uri: String,
    #[serde(default)]
    pub cid: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Active,
    Deprecated,
    Unavailable,
    Retired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Pending,
    Available,
    DeletedAtSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicationView {
    pub uri: String,
    pub cid: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub url: String,
    /// The icon's blob CID.
    #[serde(default)]
    pub icon: Option<String>,
}

/// A channel's head: the version it points at and that version's standing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    pub version: String,
    pub uri: String,
    pub cid: String,
    pub state: State,
    pub availability: Availability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BannerView {
    pub cid: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLifecycle {
    pub state: State,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub uri: String,
    #[serde(default)]
    pub cid: Option<String>,
    pub did: String,
    #[serde(default)]
    pub handle: Option<String>,
    pub name: String,
    pub sidecar: RecordRef,
    pub publication: PublicationView,
    pub plugin_type: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    /// `software.release` authors and security contacts, as published.
    #[serde(default)]
    pub authors: Vec<Value>,
    #[serde(default)]
    pub security: Vec<Value>,
    #[serde(default)]
    pub channels: BTreeMap<String, ChannelView>,
    #[serde(default)]
    pub banner: Option<BannerView>,
    pub lifecycle: ProjectLifecycle,
    pub indexed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogView {
    pub uri: String,
    pub title: String,
    pub markdown: String,
    pub fetched_at: String,
}

/// One status record applied to a subject, newest last.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleEvent {
    pub uri: String,
    pub status: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub superseded_by: Option<String>,
    #[serde(default)]
    pub withdrawn_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionLifecycle {
    pub state: State,
    pub installable: bool,
    #[serde(default)]
    pub superseded_by: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub events: Vec<LifecycleEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    pub uri: String,
    pub cid: String,
    pub did: String,
    pub name: String,
    pub version: String,
    pub manifest: Ref,
    /// The `at.happyproto.plugin.v1` object as published; `hpy_plugin` reads it.
    pub artifact: Value,
    #[serde(default)]
    pub changelog: Option<ChangelogView>,
    pub availability: Availability,
    #[serde(default)]
    pub suspect: bool,
    pub lifecycle: VersionLifecycle,
    pub indexed_at: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PutProjectOut {
    #[serde(default)]
    pub created: bool,
    pub project: Ref,
    pub publication: Ref,
    pub sidecar: Ref,
}

/// What `publishRelease` and `promoteRelease` wrote. A promotion writes no
/// manifest, and writes a channel only when asked to move one.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PublishOut {
    /// The version already existed with this artifact and the call finished
    /// the records a previous attempt left unwritten.
    #[serde(default)]
    pub resumed: bool,
    #[serde(default)]
    pub manifest: Option<Ref>,
    pub version: Ref,
    #[serde(default)]
    pub channel: Option<Ref>,
    #[serde(default)]
    pub changelog: Option<Ref>,
}

#[async_trait]
pub trait Registry: Send + Sync {
    async fn get_project(&self, actor: &str, name: &str) -> Result<Option<ProjectView>>;
    /// Every project matching the filters, across all pages.
    async fn search_projects(
        &self,
        plugin_type: Option<&str>,
        q: Option<&str>,
    ) -> Result<Vec<ProjectView>>;
    /// Every version of a project, newest indexed first.
    async fn list_versions(&self, did: &str, name: &str) -> Result<Vec<VersionView>>;
    async fn get_version(
        &self,
        did: &str,
        name: &str,
        version: &str,
    ) -> Result<Option<VersionView>>;
    /// The version a channel points at.
    async fn resolve_channel(
        &self,
        did: &str,
        name: &str,
        channel: &str,
    ) -> Result<Option<VersionView>>;
    /// The bytes of the blob with this CID, from the registry's copy.
    async fn get_artifact(&self, cid: &str) -> Result<Vec<u8>>;
    /// Checks a project against the gateway's rules and, unless
    /// `validate_only`, writes it to the signed-in user's repo.
    async fn put_project(&self, input: Value, validate_only: bool)
    -> Result<Option<PutProjectOut>>;
    /// Checks a release against the gateway's rules and, unless
    /// `validate_only`, writes it to the signed-in user's repo.
    async fn publish_release(
        &self,
        input: Value,
        validate_only: bool,
    ) -> Result<Option<PublishOut>>;
    /// Republishes a version's artifact under a new version or channel.
    async fn promote_release(&self, input: Value) -> Result<PublishOut>;
    /// Records a lifecycle status against a project or version.
    async fn put_status(&self, input: Value) -> Result<Ref>;
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
struct Versions {
    #[serde(default)]
    versions: Vec<VersionView>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct Projects {
    #[serde(default)]
    projects: Vec<ProjectView>,
    cursor: Option<String>,
}

const NOT_FOUND: [&str; 4] = [
    "ProjectNotFound",
    "ActorNotFound",
    "VersionNotFound",
    "ChannelNotFound",
];

/// The most a page can hold; fewer round trips for a long listing.
const PAGE: &str = "100";

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

    /// A procedure whose output is the records it wrote; a `validate_only`
    /// call writes none, so answers `None`.
    async fn write<T: serde::de::DeserializeOwned>(
        &self,
        nsid: &str,
        mut input: Value,
        validate_only: bool,
    ) -> Result<Option<T>> {
        input["validateOnly"] = validate_only.into();
        let out = self.procedure(nsid, &input).await?;
        if validate_only {
            return Ok(None);
        }
        parse(nsid, out).map(Some)
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

fn parse<T: serde::de::DeserializeOwned>(what: &str, out: Value) -> Result<T> {
    serde_json::from_value(out)
        .map_err(|e| Error::Other(format!("{what} answered something unreadable: {e}")))
}

impl HttpRegistry {
    /// The bytes of a blob by CID, from the registry's copy.
    async fn artifact(&self, cid: &str) -> Result<Vec<u8>> {
        const METHOD: &str = "at.happyproto.registry.getArtifact";
        let url = format!("{}/xrpc/{METHOD}", self.base);
        let mut request = self.http.get(&url).query(&[("cid", cid)]);
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
    async fn get_project(&self, actor: &str, name: &str) -> Result<Option<ProjectView>> {
        self.query(
            "at.happyproto.registry.getProject",
            &[("actor", actor), ("name", name)],
        )
        .await
    }

    async fn search_projects(
        &self,
        plugin_type: Option<&str>,
        q: Option<&str>,
    ) -> Result<Vec<ProjectView>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut params = vec![("limit", PAGE)];
            if let Some(t) = plugin_type {
                params.push(("pluginType", t));
            }
            if let Some(q) = q {
                params.push(("q", q));
            }
            if let Some(c) = &cursor {
                params.push(("cursor", c));
            }
            let page: Option<Projects> = self
                .query("at.happyproto.registry.searchProjects", &params)
                .await?;
            let Some(page) = page else { break };
            out.extend(page.projects);
            match page.cursor {
                Some(c) if Some(&c) != cursor.as_ref() => cursor = Some(c),
                _ => break,
            }
        }
        Ok(out)
    }

    async fn list_versions(&self, did: &str, name: &str) -> Result<Vec<VersionView>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut params = vec![("did", did), ("name", name), ("limit", PAGE)];
            if let Some(c) = &cursor {
                params.push(("cursor", c));
            }
            let page: Option<Versions> = self
                .query("at.happyproto.registry.listVersions", &params)
                .await?;
            let Some(page) = page else { break };
            out.extend(page.versions);
            match page.cursor {
                Some(c) if Some(&c) != cursor.as_ref() => cursor = Some(c),
                _ => break,
            }
        }
        Ok(out)
    }

    async fn get_version(
        &self,
        did: &str,
        name: &str,
        version: &str,
    ) -> Result<Option<VersionView>> {
        self.query(
            "at.happyproto.registry.getVersion",
            &[("did", did), ("name", name), ("version", version)],
        )
        .await
    }

    async fn resolve_channel(
        &self,
        did: &str,
        name: &str,
        channel: &str,
    ) -> Result<Option<VersionView>> {
        self.query(
            "at.happyproto.registry.resolveChannel",
            &[("did", did), ("name", name), ("channel", channel)],
        )
        .await
    }

    async fn get_artifact(&self, cid: &str) -> Result<Vec<u8>> {
        self.artifact(cid).await
    }

    async fn put_project(
        &self,
        input: Value,
        validate_only: bool,
    ) -> Result<Option<PutProjectOut>> {
        self.write("at.happyproto.registry.putProject", input, validate_only)
            .await
    }

    async fn publish_release(
        &self,
        input: Value,
        validate_only: bool,
    ) -> Result<Option<PublishOut>> {
        self.write(
            "at.happyproto.registry.publishRelease",
            input,
            validate_only,
        )
        .await
    }

    async fn promote_release(&self, input: Value) -> Result<PublishOut> {
        const NSID: &str = "at.happyproto.registry.promoteRelease";
        parse(NSID, self.procedure(NSID, &input).await?)
    }

    async fn put_status(&self, input: Value) -> Result<Ref> {
        const NSID: &str = "at.happyproto.registry.putStatus";
        parse(NSID, self.procedure(NSID, &input).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dpop::DpopKey;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const DID: &str = "did:plc:abc";

    fn project(name: &str) -> Value {
        json!({
            "uri": format!("at://{DID}/software.release.project/{name}"),
            "cid": "bafyproj",
            "did": DID,
            "name": name,
            "sidecar": { "uri": format!("at://{DID}/at.happyproto.registry.project/{name}") },
            "publication": {
                "uri": format!("at://{DID}/site.standard.publication/{name}"),
                "cid": "bafypub", "name": "Pretty", "url": "https://x.test/p"
            },
            "pluginType": "library",
            "keywords": ["a"],
            "authors": [{ "name": "T" }],
            "security": [{ "email": "s@x.test" }],
            "channels": { "latest": {
                "version": "1.0.0", "uri": "at://v", "cid": "bafyv",
                "state": "deprecated", "availability": "deletedAtSource"
            } },
            "lifecycle": { "state": "active" },
            "indexedAt": "2026-10-23T00:00:00Z"
        })
    }

    fn version(v: &str) -> Value {
        json!({
            "uri": format!("at://{DID}/software.release.version/x:{v}"),
            "cid": "bafyver", "did": DID, "name": "x", "version": v,
            "manifest": { "uri": "at://m", "cid": "bafym" },
            "artifact": { "$type": "at.happyproto.plugin.v1" },
            "changelog": { "uri": "at://d", "title": "t", "markdown": "# t", "fetchedAt": "now" },
            "availability": "available",
            "suspect": false,
            "lifecycle": {
                "state": "deprecated", "installable": true, "supersededBy": "2.0.0",
                "events": [{ "uri": "at://s", "status": "supersededBy", "supersededBy": "2.0.0" }]
            },
            "indexedAt": "2026-10-23T00:00:00Z"
        })
    }

    async fn serve(server: &MockServer, nsid: &str, status: u16, body: Value) {
        Mock::given(method("GET"))
            .and(path(format!("/xrpc/at.happyproto.registry.{nsid}")))
            .respond_with(ResponseTemplate::new(status).set_body_json(body))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn get_project_sends_actor_and_name_and_reads_the_view() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getProject"))
            .and(query_param("actor", "trezy.dev"))
            .and(query_param("name", "x"))
            .and(header("x-client-key", "hvc_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(project("x")))
            .expect(1)
            .mount(&server)
            .await;
        let got = HttpRegistry::new(&server.uri())
            .with_client_key("hvc_test")
            .get_project("trezy.dev", "x")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.plugin_type, "library");
        assert_eq!(got.sidecar.cid, None);
        assert_eq!(got.publication.name, "Pretty");
        let head = &got.channels["latest"];
        assert_eq!(head.state, State::Deprecated);
        assert_eq!(head.availability, Availability::DeletedAtSource);
        assert_eq!(got.lifecycle.state, State::Active);
    }

    #[tokio::test]
    async fn not_found_names_answer_none_whatever_the_status() {
        for (nsid, name) in [
            ("getProject", "ProjectNotFound"),
            // A handle that resolves to no account has no projects either.
            ("getProject", "ActorNotFound"),
            ("getVersion", "VersionNotFound"),
            ("resolveChannel", "ChannelNotFound"),
        ] {
            for status in [200, 400] {
                let server = MockServer::start().await;
                serve(
                    &server,
                    nsid,
                    status,
                    json!({ "error": name, "message": "no" }),
                )
                .await;
                let reg = HttpRegistry::new(&server.uri());
                let found = match nsid {
                    "getProject" => reg.get_project("a", "x").await.unwrap().is_some(),
                    "getVersion" => reg.get_version(DID, "x", "1.0.0").await.unwrap().is_some(),
                    _ => reg
                        .resolve_channel(DID, "x", "latest")
                        .await
                        .unwrap()
                        .is_some(),
                };
                assert!(!found, "{nsid} {status}");
            }
        }
    }

    #[tokio::test]
    async fn get_version_and_resolve_channel_send_their_params() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getVersion"))
            .and(query_param("did", DID))
            .and(query_param("name", "x"))
            .and(query_param("version", "1.2.3"))
            .respond_with(ResponseTemplate::new(200).set_body_json(version("1.2.3")))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.resolveChannel"))
            .and(query_param("did", DID))
            .and(query_param("name", "x"))
            .and(query_param("channel", "beta"))
            .respond_with(ResponseTemplate::new(200).set_body_json(version("2.0.0-beta.1")))
            .expect(1)
            .mount(&server)
            .await;
        let reg = HttpRegistry::new(&server.uri());
        let v = reg.get_version(DID, "x", "1.2.3").await.unwrap().unwrap();
        assert_eq!(v.version, "1.2.3");
        assert!(v.lifecycle.installable);
        assert_eq!(v.lifecycle.superseded_by.as_deref(), Some("2.0.0"));
        assert_eq!(v.lifecycle.events[0].status, "supersededBy");
        assert_eq!(v.changelog.unwrap().markdown, "# t");
        let v = reg
            .resolve_channel(DID, "x", "beta")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(v.version, "2.0.0-beta.1");
    }

    #[tokio::test]
    async fn other_errors_surface_whatever_the_status() {
        for status in [200, 500] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(
                    ResponseTemplate::new(status).set_body_json(
                        json!({ "error": "NotConfigured", "message": "no identity" }),
                    ),
                )
                .mount(&server)
                .await;
            let err = HttpRegistry::new(&server.uri())
                .get_version(DID, "x", "1.0.0")
                .await
                .unwrap_err();
            assert!(err.to_string().contains("NotConfigured"), "{status}: {err}");
        }
    }

    #[tokio::test]
    async fn search_projects_sends_filters_and_follows_the_cursor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.searchProjects"))
            .and(query_param("pluginType", "interpreter"))
            .and(query_param("q", "lua"))
            .and(query_param("cursor", "next"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "projects": [project("b")] })),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.searchProjects"))
            .and(query_param("pluginType", "interpreter"))
            .and(query_param("q", "lua"))
            .and(query_param("limit", "100"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "projects": [project("a")], "cursor": "next" })),
            )
            .mount(&server)
            .await;
        let all = HttpRegistry::new(&server.uri())
            .search_projects(Some("interpreter"), Some("lua"))
            .await
            .unwrap();
        assert_eq!(
            all.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }

    #[tokio::test]
    async fn search_projects_without_filters_sends_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.searchProjects"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "projects": [project("a")] })),
            )
            .mount(&server)
            .await;
        let all = HttpRegistry::new(&server.uri())
            .search_projects(None, None)
            .await
            .unwrap();
        assert_eq!(all.len(), 1);
        let requests = server.received_requests().await.unwrap();
        let query = requests[0].url.query().unwrap_or_default();
        assert!(
            !query.contains("pluginType") && !query.contains("q="),
            "{query}"
        );
    }

    #[tokio::test]
    async fn list_versions_follows_the_cursor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.listVersions"))
            .and(query_param("cursor", "next"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "versions": [version("1.0.0")] })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.listVersions"))
            .and(query_param("did", DID))
            .and(query_param("name", "x"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "versions": [version("2.0.0")], "cursor": "next" })),
            )
            .mount(&server)
            .await;
        let all = HttpRegistry::new(&server.uri())
            .list_versions(DID, "x")
            .await
            .unwrap();
        assert_eq!(
            all.iter().map(|v| v.version.as_str()).collect::<Vec<_>>(),
            ["2.0.0", "1.0.0"]
        );
    }

    #[tokio::test]
    async fn listing_versions_of_an_unknown_project_is_empty() {
        let server = MockServer::start().await;
        serve(
            &server,
            "listVersions",
            200,
            json!({ "error": "ProjectNotFound", "message": "no" }),
        )
        .await;
        let all = HttpRegistry::new(&server.uri())
            .list_versions(DID, "x")
            .await
            .unwrap();
        assert!(all.is_empty());
    }

    #[tokio::test]
    async fn get_artifact_asks_for_a_cid_and_answers_bytes() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getArtifact"))
            .and(query_param("cid", "bafkok"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/wasm")
                    .set_body_bytes(b"\0asm\x01\0\0\0".to_vec()),
            )
            .expect(1)
            .mount(&server)
            .await;
        assert_eq!(
            HttpRegistry::new(&server.uri())
                .get_artifact("bafkok")
                .await
                .unwrap(),
            b"\0asm\x01\0\0\0"
        );
    }

    #[tokio::test]
    async fn get_artifact_surfaces_refusals_in_either_status() {
        let server = MockServer::start().await;
        for (cid, template) in [
            (
                "held",
                ResponseTemplate::new(400).set_body_json(
                    json!({ "error": "ArtifactNotHeld", "message": "not copied yet" }),
                ),
            ),
            (
                "lua",
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "error": "NotConfigured", "message": "no identity" })),
            ),
        ] {
            Mock::given(method("GET"))
                .and(path("/xrpc/at.happyproto.registry.getArtifact"))
                .and(query_param("cid", cid))
                .respond_with(template)
                .mount(&server)
                .await;
        }
        let reg = HttpRegistry::new(&server.uri());
        let err = reg.get_artifact("held").await.unwrap_err();
        assert!(err.to_string().contains("ArtifactNotHeld"), "{err}");
        let err = reg.get_artifact("lua").await.unwrap_err();
        assert!(err.to_string().contains("NotConfigured"), "{err}");
    }

    #[tokio::test]
    async fn a_json_artifact_that_names_no_error_still_answers() {
        // A manifest is JSON and can carry any field but `error`.
        let server = MockServer::start().await;
        let manifest = json!({ "id": "x" });
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getArtifact"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&manifest))
            .mount(&server)
            .await;
        let bytes = HttpRegistry::new(&server.uri())
            .get_artifact("bafj")
            .await
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), manifest);
    }

    fn registry(server: &MockServer) -> HttpRegistry {
        let cred = Credential {
            registry: server.uri(),
            client_key: "hvc_test".into(),
            did: DID.into(),
            handle: None,
            pds: "https://pds.test".into(),
            scopes: "atproto".into(),
            access_token: "tok".into(),
            dpop_key: DpopKey::generate(),
        };
        HttpRegistry::new(&server.uri())
            .with_session(Arc::new(HappyView::new(&server.uri(), "hvc_test")), cred)
    }

    async fn post(server: &MockServer, nsid: &str, expect: Value, status: u16, out: Value) {
        Mock::given(method("POST"))
            .and(path(format!("/xrpc/at.happyproto.registry.{nsid}")))
            .and(body_partial_json(expect))
            .respond_with(ResponseTemplate::new(status).set_body_json(out))
            .expect(1)
            .mount(server)
            .await;
    }

    fn r(uri: &str) -> Value {
        json!({ "uri": uri, "cid": "bafy" })
    }

    #[tokio::test]
    async fn put_project_answers_what_it_wrote() {
        let server = MockServer::start().await;
        post(
            &server,
            "putProject",
            json!({ "name": "x", "swapCid": "old", "validateOnly": false }),
            200,
            json!({
                "valid": true, "created": true,
                "project": r("at://p"), "publication": r("at://pub"), "sidecar": r("at://s")
            }),
        )
        .await;
        let out = registry(&server)
            .put_project(json!({ "name": "x", "swapCid": "old" }), false)
            .await
            .unwrap()
            .unwrap();
        assert!(out.created);
        assert_eq!(out.project.uri, "at://p");
        assert_eq!(out.sidecar.uri, "at://s");
    }

    #[tokio::test]
    async fn validating_writes_nothing_and_answers_none() {
        let server = MockServer::start().await;
        post(
            &server,
            "putProject",
            json!({ "validateOnly": true }),
            200,
            json!({ "valid": true }),
        )
        .await;
        post(
            &server,
            "publishRelease",
            json!({ "validateOnly": true }),
            200,
            json!({ "valid": true }),
        )
        .await;
        let reg = registry(&server);
        assert!(reg.put_project(json!({}), true).await.unwrap().is_none());
        assert!(
            reg.publish_release(json!({}), true)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn publish_release_answers_the_written_records() {
        let server = MockServer::start().await;
        post(
            &server,
            "publishRelease",
            json!({ "name": "x", "version": "1.0.0", "track": "beta", "validateOnly": false }),
            200,
            json!({
                "valid": true, "resumed": true,
                "manifest": r("at://m"), "version": r("at://v"), "channel": r("at://c"),
                "changelog": r("at://d")
            }),
        )
        .await;
        let out = registry(&server)
            .publish_release(
                json!({ "name": "x", "version": "1.0.0", "track": "beta" }),
                false,
            )
            .await
            .unwrap()
            .unwrap();
        assert!(out.resumed);
        assert_eq!(out.manifest.unwrap().uri, "at://m");
        assert_eq!(out.version.uri, "at://v");
        assert_eq!(out.channel.unwrap().uri, "at://c");
        assert_eq!(out.changelog.unwrap().uri, "at://d");
    }

    #[tokio::test]
    async fn promote_release_needs_no_manifest_or_channel() {
        let server = MockServer::start().await;
        post(
            &server,
            "promoteRelease",
            json!({ "name": "x", "fromVersion": "1.0.0-beta.1", "version": "1.0.0" }),
            200,
            json!({ "version": r("at://v") }),
        )
        .await;
        let out = registry(&server)
            .promote_release(
                json!({ "name": "x", "fromVersion": "1.0.0-beta.1", "version": "1.0.0" }),
            )
            .await
            .unwrap();
        assert_eq!(out.version.uri, "at://v");
        assert!(!out.resumed && out.manifest.is_none() && out.channel.is_none());
    }

    #[tokio::test]
    async fn put_status_answers_the_record() {
        let server = MockServer::start().await;
        post(
            &server,
            "putStatus",
            json!({ "subject": "at://v", "status": "endOfLife" }),
            200,
            r("at://status"),
        )
        .await;
        let out = registry(&server)
            .put_status(json!({ "subject": "at://v", "status": "endOfLife" }))
            .await
            .unwrap();
        assert_eq!(out.uri, "at://status");
    }

    #[tokio::test]
    async fn procedure_refusals_keep_their_names_in_either_status() {
        for (nsid, name) in [
            ("putProject", "InvalidSwap"),
            ("publishRelease", "VersionExists"),
            ("publishRelease", "ProjectMissing"),
            ("promoteRelease", "NotInstallable"),
            ("promoteRelease", "VersionNotFound"),
            ("putStatus", "SubjectNotFound"),
            ("putStatus", "InvalidStatus"),
            ("putProject", "InvalidRecord"),
        ] {
            for status in [200, 400] {
                let server = MockServer::start().await;
                post(
                    &server,
                    nsid,
                    json!({}),
                    status,
                    json!({ "error": name, "message": "say it plainly" }),
                )
                .await;
                let reg = registry(&server);
                let err = match nsid {
                    "putProject" => reg.put_project(json!({}), false).await.unwrap_err(),
                    "publishRelease" => reg.publish_release(json!({}), false).await.unwrap_err(),
                    "promoteRelease" => reg.promote_release(json!({})).await.unwrap_err(),
                    _ => reg.put_status(json!({})).await.unwrap_err(),
                };
                assert_eq!(err.registry_name(), Some(name), "{nsid} {status}: {err:?}");
                if name == "VersionNotFound" {
                    assert!(err.is_usage(), "{err:?}");
                    assert_eq!(err.to_string(), "say it plainly");
                }
            }
        }
    }

    #[tokio::test]
    async fn procedures_without_a_session_are_not_logged_in() {
        let reg = HttpRegistry::new("http://127.0.0.1:9");
        assert!(
            reg.publish_release(json!({}), true)
                .await
                .unwrap_err()
                .is_auth()
        );
        assert!(reg.put_status(json!({})).await.unwrap_err().is_auth());
    }

    #[tokio::test]
    async fn a_malformed_answer_is_an_error_not_a_default() {
        let server = MockServer::start().await;
        post(
            &server,
            "putStatus",
            json!({}),
            200,
            json!({ "uri": "at://x" }),
        )
        .await;
        let err = registry(&server).put_status(json!({})).await.unwrap_err();
        assert!(err.to_string().contains("unreadable"), "{err}");
    }
}
