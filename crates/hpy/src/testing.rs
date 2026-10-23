//! In-memory `Repo` and `Registry` for command tests.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use hpy_atproto::registry::{
    Availability, ChannelView, ProjectLifecycle, PublicationView, RecordRef, State,
    VersionLifecycle,
};
use hpy_atproto::{
    Error, ProjectView, PublishOut, PutProjectOut, Ref, Registry, Repo, Result, StoredRecord,
    VersionView,
};
use hpy_plugin::artifact::{MANIFEST_MIME, WASM_MIME, predicted_blob};
use hpy_plugin::checksum::raw_cid;
use serde_json::{Value, json};

#[derive(Default)]
pub struct FakeRepo {
    pub records: Mutex<BTreeMap<(String, String), (Value, String)>>,
    pub blobs: Mutex<Vec<(Vec<u8>, String)>>,
    /// When set, uploads answer this CID instead of the true one.
    pub wrong_cid: Option<String>,
    /// The grant a publish pre-checks. `None` is a repo that does not know
    /// its scopes, which is what most tests want.
    pub scopes: Option<String>,
}

pub const DID: &str = "did:plc:testuser";

impl FakeRepo {
    pub fn with(records: &[(&str, &str, Value)]) -> FakeRepo {
        let repo = FakeRepo::default();
        for (c, k, v) in records {
            repo.records.lock().unwrap().insert(
                (c.to_string(), k.to_string()),
                (v.clone(), "bafyold".into()),
            );
        }
        repo
    }
}

fn uri(c: &str, k: &str) -> String {
    format!("at://{DID}/{c}/{k}")
}

#[async_trait]
impl Repo for FakeRepo {
    fn did(&self) -> &str {
        DID
    }

    fn granted_scopes(&self) -> Option<&str> {
        self.scopes.as_deref()
    }

    async fn get_record(&self, c: &str, k: &str) -> Result<Option<StoredRecord>> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .get(&(c.into(), k.into()))
            .map(|(v, cid)| StoredRecord {
                uri: uri(c, k),
                cid: Some(cid.clone()),
                value: v.clone(),
            }))
    }

    async fn list_records(&self, c: &str) -> Result<Vec<StoredRecord>> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|((col, _), _)| col == c)
            .map(|((col, k), (v, cid))| StoredRecord {
                uri: uri(col, k),
                cid: Some(cid.clone()),
                value: v.clone(),
            })
            .collect())
    }

    async fn upload_blob(&self, bytes: Vec<u8>, mime: &str) -> Result<Value> {
        let cid = self
            .wrong_cid
            .clone()
            .unwrap_or_else(|| hpy_plugin::checksum::raw_cid(&bytes));
        let size = bytes.len();
        self.blobs.lock().unwrap().push((bytes, mime.into()));
        Ok(json!({ "$type": "blob", "ref": { "$link": cid }, "mimeType": mime, "size": size }))
    }
}

/// A view of `version` of `did`'s `name`, available and installable, with
/// `artifact` as published.
pub fn version_view(did: &str, name: &str, version: &str, artifact: Value) -> VersionView {
    VersionView {
        uri: hpy_plugin::validate::version_uri(did, name, version),
        cid: hpy_plugin::checksum::raw_cid(format!("version {did} {name} {version}").as_bytes()),
        did: did.into(),
        name: name.into(),
        version: version.into(),
        manifest: Ref {
            uri: format!("at://{did}/{}/3l{version}", hpy_plugin::MANIFEST_NSID),
            cid: manifest_cid(&artifact),
        },
        artifact,
        changelog: None,
        availability: Availability::Available,
        suspect: false,
        lifecycle: VersionLifecycle {
            state: State::Active,
            installable: true,
            superseded_by: None,
            reason: None,
            kind: None,
            events: vec![],
        },
        indexed_at: "2026-10-23T00:00:00Z".into(),
    }
}

/// A stand-in for the manifest record's CID: the same artifact always gets
/// the same one, and a different artifact a different one.
pub fn manifest_cid(artifact: &Value) -> String {
    hpy_plugin::checksum::raw_cid(artifact.to_string().as_bytes())
}

/// A project as the registry indexes it.
pub fn project_view(did: &str, name: &str, plugin_type: &str) -> ProjectView {
    ProjectView {
        uri: hpy_plugin::validate::project_uri(did, name),
        cid: Some("bafyproject".into()),
        did: did.into(),
        handle: None,
        name: name.into(),
        sidecar: RecordRef {
            uri: format!("at://{did}/{}/{name}", hpy_plugin::SIDECAR_NSID),
            cid: None,
        },
        publication: PublicationView {
            uri: format!("at://{did}/{}/{name}", hpy_plugin::PUBLICATION_NSID),
            cid: "bafypublication".into(),
            name: name.into(),
            description: None,
            url: format!("https://happyproto.at/plugins/{did}/{name}"),
            icon: None,
        },
        plugin_type: plugin_type.into(),
        keywords: vec![],
        authors: vec![],
        security: vec![],
        channels: BTreeMap::new(),
        banner: None,
        lifecycle: ProjectLifecycle {
            state: State::Active,
        },
        indexed_at: "2026-10-23T00:00:00Z".into(),
    }
}

fn refusal(r: &Option<(String, String)>) -> Result<()> {
    match r {
        Some((name, message)) => Err(Error::Registry {
            name: name.clone(),
            message: message.clone(),
        }),
        None => Ok(()),
    }
}

/// The gateway and read API for one signed-in publisher's project.
#[derive(Default)]
pub struct FakeRegistry {
    /// What `getProject` answers; `put_project` fills it in.
    pub project: Mutex<Option<ProjectView>>,
    /// What `getVersion` answers, by version; `publish_release` adds to it.
    pub versions: Mutex<BTreeMap<String, VersionView>>,
    pub unreachable: bool,
    /// What the gateway was asked: ("project"|"release", validate_only).
    pub calls: Mutex<Vec<(&'static str, bool)>>,
    /// `putProject` inputs that wrote.
    pub put_projects: Mutex<Vec<Value>>,
    /// `publishRelease` inputs that wrote.
    pub published: Mutex<Vec<Value>>,
    pub promoted: Mutex<Vec<Value>>,
    pub statuses: Mutex<Vec<Value>>,
    pub reject_project: Option<(String, String)>,
    pub reject_release: Option<(String, String)>,
    /// The next `publishRelease` that writes fails as if the network dropped
    /// after the gateway wrote the manifest.
    pub fail_next_publish: Mutex<bool>,
    /// Versions a failed publish left half-written, which the next publish
    /// of the same version resumes.
    pub half_written: Mutex<Vec<String>>,
    /// The next `publishRelease` that writes fails as the gateway does when
    /// the PDS has lost a blob the release names.
    pub missing_blob_once: Mutex<bool>,
    /// Answer `publishRelease` without a `manifest`, as the gateway may on
    /// a resumed publish.
    pub omit_manifest: Mutex<bool>,
}

impl FakeRegistry {
    /// A registry that already indexes `version` of the project, published
    /// with `artifact`.
    pub fn with_version(name: &str, version: &str, artifact: Value) -> FakeRegistry {
        let reg = FakeRegistry::default();
        reg.versions
            .lock()
            .unwrap()
            .insert(version.into(), version_view(DID, name, version, artifact));
        reg
    }

    fn check(&self) -> Result<()> {
        if self.unreachable {
            Err(Error::Other("could not reach the registry".into()))
        } else {
            Ok(())
        }
    }
}

fn refs(collection: &str, rkey: &str, cid: &str) -> Ref {
    Ref {
        uri: uri(collection, rkey),
        cid: cid.into(),
    }
}

#[async_trait]
impl Registry for FakeRegistry {
    async fn get_project(&self, _: &str, _: &str) -> Result<Option<ProjectView>> {
        self.check()?;
        Ok(self.project.lock().unwrap().clone())
    }

    async fn search_projects(&self, _: Option<&str>, _: Option<&str>) -> Result<Vec<ProjectView>> {
        self.check()?;
        Ok(self.project.lock().unwrap().clone().into_iter().collect())
    }

    /// Newest first, as the registry answers.
    async fn list_versions(&self, _: &str, _: &str) -> Result<Vec<VersionView>> {
        self.check()?;
        Ok(self
            .versions
            .lock()
            .unwrap()
            .values()
            .rev()
            .cloned()
            .collect())
    }

    async fn get_version(&self, _: &str, _: &str, version: &str) -> Result<Option<VersionView>> {
        self.check()?;
        Ok(self.versions.lock().unwrap().get(version).cloned())
    }

    async fn resolve_channel(&self, _: &str, _: &str, _: &str) -> Result<Option<VersionView>> {
        self.check()?;
        Ok(None)
    }

    async fn get_artifact(&self, _: &str) -> Result<Vec<u8>> {
        self.check()?;
        Err(Error::Other("FakeRegistry holds no artifacts".into()))
    }

    async fn put_project(
        &self,
        input: Value,
        validate_only: bool,
    ) -> Result<Option<PutProjectOut>> {
        self.calls.lock().unwrap().push(("project", validate_only));
        refusal(&self.reject_project)?;
        if validate_only {
            return Ok(None);
        }
        let name = input["name"].as_str().unwrap_or_default().to_string();
        let created = self.project.lock().unwrap().is_none();
        let mut view = project_view(
            DID,
            &name,
            input["project"]["pluginType"].as_str().unwrap_or(""),
        );
        view.publication.name = input["publication"]["name"].as_str().unwrap_or("").into();
        view.publication.description = input["publication"]["description"]
            .as_str()
            .map(str::to_string);
        view.publication.icon = input["publication"]["icon"]["ref"]["$link"]
            .as_str()
            .map(str::to_string);
        view.keywords =
            serde_json::from_value(input["project"]["keywords"].clone()).unwrap_or_default();
        view.authors =
            serde_json::from_value(input["project"]["authors"].clone()).unwrap_or_default();
        view.security =
            serde_json::from_value(input["project"]["security"].clone()).unwrap_or_default();
        *self.project.lock().unwrap() = Some(view);
        self.put_projects.lock().unwrap().push(input);
        Ok(Some(PutProjectOut {
            created,
            project: refs(hpy_plugin::PROJECT_NSID, &name, "bafyproject"),
            publication: refs(hpy_plugin::PUBLICATION_NSID, &name, "bafypublication"),
            sidecar: refs(hpy_plugin::SIDECAR_NSID, &name, "bafysidecar"),
        }))
    }

    async fn publish_release(
        &self,
        input: Value,
        validate_only: bool,
    ) -> Result<Option<PublishOut>> {
        self.calls.lock().unwrap().push(("release", validate_only));
        refusal(&self.reject_release)?;
        if validate_only {
            return Ok(None);
        }
        let name = input["name"].as_str().unwrap_or_default().to_string();
        let version = input["version"].as_str().unwrap_or_default().to_string();
        if std::mem::take(&mut *self.fail_next_publish.lock().unwrap()) {
            self.half_written.lock().unwrap().push(version);
            return Err(Error::Other("network went away".into()));
        }
        if std::mem::take(&mut *self.missing_blob_once.lock().unwrap()) {
            return Err(Error::Registry {
                name: "Upstream".into(),
                message: "the PDS answered: blob not found".into(),
            });
        }
        // A version already written with this artifact is finished again
        // rather than refused, as the gateway does.
        let finished = self
            .versions
            .lock()
            .unwrap()
            .get(&version)
            .is_some_and(|v| v.artifact == input["artifact"]);
        let resumed = finished || self.half_written.lock().unwrap().contains(&version);
        let mut view = version_view(DID, &name, &version, input["artifact"].clone());
        view.availability = Availability::Pending;
        let out = PublishOut {
            resumed,
            manifest: (!*self.omit_manifest.lock().unwrap()).then(|| view.manifest.clone()),
            version: Ref {
                uri: view.uri.clone(),
                cid: view.cid.clone(),
            },
            channel: Some(refs(
                hpy_plugin::CHANNEL_NSID,
                &format!("{name}:{}", input["track"].as_str().unwrap_or("")),
                "bafychannel",
            )),
            changelog: None,
        };
        self.versions.lock().unwrap().insert(version, view);
        self.published.lock().unwrap().push(input);
        Ok(Some(out))
    }

    async fn promote_release(&self, input: Value) -> Result<PublishOut> {
        self.check()?;
        let name = input["name"].as_str().unwrap_or_default();
        let version = input["version"].as_str().unwrap_or_default();
        let out = PublishOut {
            resumed: false,
            manifest: None,
            version: Ref {
                uri: hpy_plugin::validate::version_uri(DID, name, version),
                cid: "bafypromoted".into(),
            },
            channel: None,
            changelog: None,
        };
        self.promoted.lock().unwrap().push(input);
        Ok(out)
    }

    async fn put_status(&self, input: Value) -> Result<Ref> {
        self.check()?;
        self.statuses.lock().unwrap().push(input);
        Ok(refs(hpy_plugin::STATUS_NSID, "3lstatus", "bafystatus"))
    }
}

/// A registry holding many projects, for resolution and download tests.
#[derive(Default)]
pub struct RegistryFixture {
    pub projects: Vec<ProjectView>,
    /// Every version of each `(did, name)`, in publication order.
    pub versions: BTreeMap<(String, String), Vec<VersionView>>,
    /// Channel heads, `(did, name, channel)` → version. Kept up to date by
    /// `publish` unless set by hand.
    pub channels: BTreeMap<(String, String, String), String>,
    /// Blob bytes by CID.
    pub blobs: BTreeMap<String, Vec<u8>>,
    /// Every query answered, as `method name[@version]`.
    pub calls: Mutex<Vec<String>>,
}

impl RegistryFixture {
    /// Publishes `version` of `did`'s `name` with the plugin fields `fields`
    /// (pluginType, apiVersion, …), `requires`, and `wasm` as its module.
    /// Its shipped manifest is `{"id": name}`.
    pub fn publish(
        &mut self,
        did: &str,
        name: &str,
        version: &str,
        fields: Value,
        requires: Value,
        wasm: &[u8],
    ) {
        let manifest = serde_json::to_vec(&json!({ "id": name })).unwrap();
        self.publish_with_manifest(did, name, version, fields, requires, wasm, &manifest);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn publish_with_manifest(
        &mut self,
        did: &str,
        name: &str,
        version: &str,
        fields: Value,
        requires: Value,
        wasm: &[u8],
        manifest: &[u8],
    ) {
        let package = predicted_blob(wasm, WASM_MIME);
        let manifest_blob = predicted_blob(manifest, MANIFEST_MIME);
        let mut artifact = json!({
            "$type": hpy_plugin::ARTIFACT_TYPE,
            "package": package,
            "manifest": manifest_blob,
            "capabilities": [],
            "license": "MIT",
            "sections": { "description": "A plugin." },
            "requires": requires,
        });
        for (k, v) in fields.as_object().expect("fields are an object") {
            artifact[k] = v.clone();
        }
        let plugin_type = artifact["pluginType"].as_str().unwrap_or("").to_string();
        self.blobs.insert(raw_cid(wasm), wasm.to_vec());
        self.blobs.insert(raw_cid(manifest), manifest.to_vec());
        let key = (did.to_string(), name.to_string());
        self.versions
            .entry(key.clone())
            .or_default()
            .push(version_view(did, name, version, artifact));
        if !self.projects.iter().any(|p| p.did == did && p.name == name) {
            self.projects.push(project_view(did, name, &plugin_type));
        }
        self.refresh_channels(&key);
    }

    /// Marks a version no longer installable, as an `endOfDistribution`
    /// status does.
    pub fn retire(&mut self, did: &str, name: &str, version: &str) {
        let key = (did.to_string(), name.to_string());
        for v in self.versions.get_mut(&key).into_iter().flatten() {
            if v.version == version {
                v.lifecycle.state = State::Unavailable;
                v.lifecycle.installable = false;
                v.lifecycle.reason = Some("withdrawn by its publisher".into());
            }
        }
        self.refresh_channels(&key);
    }

    pub fn set_channel(&mut self, did: &str, name: &str, channel: &str, version: &str) {
        self.channels
            .insert((did.into(), name.into(), channel.into()), version.into());
    }

    /// `latest` follows the highest installable stable version, `beta` and
    /// `alpha` the highest prerelease named so.
    fn refresh_channels(&mut self, key: &(String, String)) {
        for channel in hpy_plugin::TRACKS {
            let head = self.versions[key]
                .iter()
                .filter(|v| v.lifecycle.installable)
                .filter_map(|v| semver::Version::parse(&v.version).ok())
                .filter(|v| match channel {
                    "latest" => v.pre.is_empty(),
                    track => v.pre.as_str().split('.').next() == Some(track),
                })
                .max();
            let at = (key.0.clone(), key.1.clone(), channel.to_string());
            match head {
                Some(v) => self.channels.insert(at, v.to_string()),
                None => self.channels.remove(&at),
            };
        }
        let heads: BTreeMap<String, ChannelView> = hpy_plugin::TRACKS
            .iter()
            .filter_map(|c| {
                let version = self
                    .channels
                    .get(&(key.0.clone(), key.1.clone(), c.to_string()))?;
                let v = self.versions[key].iter().find(|v| &v.version == version)?;
                Some((
                    c.to_string(),
                    ChannelView {
                        version: version.clone(),
                        uri: v.uri.clone(),
                        cid: v.cid.clone(),
                        state: v.lifecycle.state,
                        availability: v.availability,
                    },
                ))
            })
            .collect();
        if let Some(p) = self
            .projects
            .iter_mut()
            .find(|p| p.did == key.0 && p.name == key.1)
        {
            p.channels = heads;
        }
    }

    fn log(&self, entry: String) {
        self.calls.lock().unwrap().push(entry);
    }

    pub fn find(&self, did: &str, name: &str, version: &str) -> Option<VersionView> {
        self.versions
            .get(&(did.into(), name.into()))?
            .iter()
            .find(|v| v.version == version)
            .cloned()
    }
}

#[async_trait]
impl Registry for RegistryFixture {
    async fn get_project(&self, actor: &str, name: &str) -> Result<Option<ProjectView>> {
        self.log(format!("getProject {name}"));
        Ok(self
            .projects
            .iter()
            .find(|p| (p.did == actor || p.handle.as_deref() == Some(actor)) && p.name == name)
            .cloned())
    }

    async fn search_projects(
        &self,
        plugin_type: Option<&str>,
        _: Option<&str>,
    ) -> Result<Vec<ProjectView>> {
        self.log(format!("searchProjects {}", plugin_type.unwrap_or("*")));
        Ok(self
            .projects
            .iter()
            .filter(|p| plugin_type.is_none_or(|t| p.plugin_type == t))
            .cloned()
            .collect())
    }

    async fn list_versions(&self, did: &str, name: &str) -> Result<Vec<VersionView>> {
        self.log(format!("listVersions {name}"));
        let mut all = self
            .versions
            .get(&(did.into(), name.into()))
            .cloned()
            .unwrap_or_default();
        all.reverse();
        Ok(all)
    }

    async fn get_version(
        &self,
        did: &str,
        name: &str,
        version: &str,
    ) -> Result<Option<VersionView>> {
        self.log(format!("getVersion {name}@{version}"));
        Ok(self.find(did, name, version))
    }

    async fn resolve_channel(
        &self,
        did: &str,
        name: &str,
        channel: &str,
    ) -> Result<Option<VersionView>> {
        self.log(format!("resolveChannel {name}@{channel}"));
        Ok(self
            .channels
            .get(&(did.into(), name.into(), channel.into()))
            .and_then(|v| self.find(did, name, v)))
    }

    async fn get_artifact(&self, cid: &str) -> Result<Vec<u8>> {
        self.log(format!("getArtifact {cid}"));
        self.blobs.get(cid).cloned().ok_or_else(|| Error::Xrpc {
            method: "at.happyproto.registry.getArtifact".into(),
            name: "ArtifactNotHeld".into(),
            message: None,
        })
    }

    async fn put_project(&self, _: Value, _: bool) -> Result<Option<PutProjectOut>> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }

    async fn publish_release(&self, _: Value, _: bool) -> Result<Option<PublishOut>> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }

    async fn promote_release(&self, _: Value) -> Result<PublishOut> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }

    async fn put_status(&self, _: Value) -> Result<Ref> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }
}

/// An interpreter's plugin fields.
pub fn interpreter_ext(language: &str, extension: &str) -> Value {
    json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": language,
            "fileExtensions": [extension], "capabilities": ["script:host"] })
}

/// A library's plugin fields.
pub fn library_ext(namespace: &str) -> Value {
    json!({ "pluginType": "library", "apiVersion": "2", "namespace": namespace,
            "capabilities": [] })
}

/// A `.tar.xz` holding `files` as `(path, bytes, mode)`.
pub fn tar_xz(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(xz2::write::XzEncoder::new(Vec::new(), 6));
    for (path, bytes, mode) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(*mode);
        header.set_cksum();
        builder.append_data(&mut header, path, *bytes).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

pub fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in files {
        w.start_file(*path, zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(bytes).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// A temporary directory only this user can reach, as a cache root must be.
pub fn private_tempdir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    dir
}
