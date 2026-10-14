//! In-memory `Repo` and `Registry` for command tests.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use hpy_atproto::{
    Error, PackageView, Registry, ReleaseView, Repo, Result, StoredRecord, WriteResult,
};
use serde_json::{Value, json};

#[derive(Default)]
pub struct FakeRepo {
    pub records: Mutex<BTreeMap<(String, String), (Value, String)>>,
    pub blobs: Mutex<Vec<(Vec<u8>, String)>>,
    /// When set, uploads answer this CID instead of the true one.
    pub wrong_cid: Option<String>,
}

pub const DID: &str = "did:plc:testuser";

/// A CID `FakeRegistry::update_profile` treats as out of date.
pub const STALE_CID: &str = "bafystale";

#[allow(non_snake_case)]
fn ProfileMissing() -> Error {
    Error::Registry {
        name: "ProfileMissing".into(),
        message: "no profile is indexed at that slug".into(),
    }
}

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

#[derive(Default)]
pub struct FakeRegistry {
    pub releases: Mutex<BTreeMap<String, ReleaseView>>,
    pub package: Option<PackageView>,
    pub unreachable: bool,
    /// What the publish procedures were asked: ("profile"|"release", validate_only).
    pub calls: Mutex<Vec<(&'static str, bool)>>,
    pub published_profiles: Mutex<Vec<(String, Value)>>,
    pub published_releases: Mutex<Vec<Value>>,
    /// Refuses profiles with this registry error (name, message).
    pub reject_profile: Option<(String, String)>,
    /// Refuses releases with this registry error (name, message).
    pub reject_release: Option<(String, String)>,
    /// `ProfileMissing` answers left before a release publishes.
    pub profile_missing: Mutex<usize>,
    /// The next real publish fails as if the network dropped.
    pub fail_next_publish: Mutex<bool>,
    /// Versions whose copy `retry_release` enqueued again.
    pub retried: Mutex<Vec<String>>,
    /// What `update_profile` was asked: (slug, record, swap_cid).
    pub updated_profiles: Mutex<Vec<(String, Value, Option<String>)>>,
}

impl FakeRegistry {
    pub fn with_release(version: &str, status: &str) -> FakeRegistry {
        let reg = FakeRegistry::default();
        reg.releases.lock().unwrap().insert(
            version.into(),
            ReleaseView {
                uri: format!("at://{DID}/at.happyproto.plugin.release/x:{version}"),
                status: status.into(),
                record: json!({}),
                indexed_at: None,
            },
        );
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

#[async_trait]
impl Registry for FakeRegistry {
    async fn get_package(&self, _: &str, _: &str) -> Result<Option<PackageView>> {
        self.check()?;
        Ok(self.package.clone())
    }

    async fn get_release(&self, _: &str, _: &str, version: &str) -> Result<Option<ReleaseView>> {
        self.check()?;
        Ok(self.releases.lock().unwrap().get(version).cloned())
    }

    async fn list_releases(&self, _: &str, _: &str) -> Result<Vec<ReleaseView>> {
        self.check()?;
        Ok(self.releases.lock().unwrap().values().cloned().collect())
    }

    async fn search_packages(&self, _: &str) -> Result<Vec<PackageView>> {
        self.check()?;
        Ok(self.package.clone().into_iter().collect())
    }

    async fn get_artifact(&self, _: &str, _: &str, _: &str) -> Result<Vec<u8>> {
        self.check()?;
        Err(Error::Other("FakeRegistry holds no artifacts".into()))
    }

    async fn publish_profile(
        &self,
        slug: &str,
        record: Value,
        validate_only: bool,
    ) -> Result<Option<WriteResult>> {
        self.calls.lock().unwrap().push(("profile", validate_only));
        if let Some((name, message)) = &self.reject_profile {
            return Err(Error::Registry {
                name: name.clone(),
                message: message.clone(),
            });
        }
        if validate_only {
            return Ok(None);
        }
        if std::mem::take(&mut *self.fail_next_publish.lock().unwrap()) {
            return Err(Error::Other("network went away".into()));
        }
        self.published_profiles
            .lock()
            .unwrap()
            .push((slug.into(), record));
        Ok(Some(WriteResult {
            uri: uri("at.happyproto.plugin.profile", slug),
            cid: "bafyprofile".into(),
        }))
    }

    async fn publish_release(
        &self,
        record: Value,
        validate_only: bool,
    ) -> Result<Option<WriteResult>> {
        self.calls.lock().unwrap().push(("release", validate_only));
        if let Some((name, message)) = &self.reject_release {
            return Err(Error::Registry {
                name: name.clone(),
                message: message.clone(),
            });
        }
        let missing = ProfileMissing();
        if validate_only {
            return if *self.profile_missing.lock().unwrap() > 0 {
                Err(missing)
            } else {
                Ok(None)
            };
        }
        if std::mem::take(&mut *self.fail_next_publish.lock().unwrap()) {
            return Err(Error::Other("network went away".into()));
        }
        {
            let mut left = self.profile_missing.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return Err(missing);
            }
        }
        let rkey = format!(
            "{}:{}",
            record["package"].as_str().unwrap_or(""),
            record["version"].as_str().unwrap_or("")
        );
        self.published_releases.lock().unwrap().push(record);
        Ok(Some(WriteResult {
            uri: uri("at.happyproto.plugin.release", &rkey),
            cid: "bafyrelease".into(),
        }))
    }

    async fn update_profile(
        &self,
        slug: &str,
        record: Value,
        swap_cid: Option<&str>,
    ) -> Result<WriteResult> {
        if swap_cid == Some(STALE_CID) {
            return Err(Error::Xrpc {
                method: "at.happyproto.registry.updateProfile".into(),
                name: "InvalidSwap".into(),
                message: None,
            });
        }
        self.updated_profiles.lock().unwrap().push((
            slug.into(),
            record,
            swap_cid.map(str::to_string),
        ));
        Ok(WriteResult {
            uri: uri("at.happyproto.plugin.profile", slug),
            cid: "bafyupdated".into(),
        })
    }

    async fn withdraw_release(&self, _: &str, version: &str) -> Result<bool> {
        self.check()?;
        Ok(self.releases.lock().unwrap().remove(version).is_some())
    }

    /// Records the retry in `retried`; a pending release then reads active,
    /// as if the copy succeeded.
    async fn retry_release(&self, _: &str, version: &str) -> Result<Option<String>> {
        self.check()?;
        let mut releases = self.releases.lock().unwrap();
        let Some(view) = releases.get_mut(version) else {
            return Ok(None);
        };
        let before = view.status.clone();
        if before == "pending" {
            self.retried.lock().unwrap().push(version.into());
            view.status = "active".into();
        }
        Ok(Some(before))
    }
}

/// A registry holding many packages, for resolution and download tests.
#[derive(Default)]
pub struct RegistryFixture {
    pub packages: Vec<PackageView>,
    pub releases: BTreeMap<(String, String), Vec<ReleaseView>>,
    pub artifacts: BTreeMap<(String, String, String), Vec<u8>>,
    /// Every query answered, as `method slug[@version]`.
    pub calls: Mutex<Vec<String>>,
}

impl RegistryFixture {
    pub fn publish(
        &mut self,
        did: &str,
        slug: &str,
        version: &str,
        ext: Value,
        requires: Value,
        wasm: &[u8],
    ) {
        let record = json!({
            "$type": hpy_plugin::RELEASE_NSID,
            "package": slug,
            "version": version,
            "artifacts": { "package": { "checksum": hpy_plugin::checksum::checksum(wasm) } },
            "extensions": { (hpy_plugin::EXTENSION_NSID): ext },
            "requires": requires,
        });
        let key = (did.to_string(), slug.to_string());
        self.releases
            .entry(key.clone())
            .or_default()
            .push(ReleaseView {
                uri: format!("at://{did}/{}/{slug}:{version}", hpy_plugin::RELEASE_NSID),
                status: "active".into(),
                record,
                indexed_at: None,
            });
        self.artifacts
            .insert((did.into(), slug.into(), version.into()), wasm.to_vec());
        self.refresh_package(&key);
    }

    pub fn withdraw(&mut self, did: &str, slug: &str, version: &str) {
        let key = (did.to_string(), slug.to_string());
        for r in self.releases.get_mut(&key).into_iter().flatten() {
            if r.record["version"] == version {
                r.status = "deleted".into();
            }
        }
        self.refresh_package(&key);
    }

    fn refresh_package(&mut self, key: &(String, String)) {
        let latest = self.releases[key]
            .iter()
            .filter(|r| r.status == "active")
            .filter_map(|r| semver::Version::parse(r.record["version"].as_str()?).ok())
            .max()
            .map(|v| v.to_string());
        let uri = hpy_project::manifest::package_uri(&key.0, &key.1);
        let handle = self
            .packages
            .iter()
            .find(|p| p.uri == uri)
            .and_then(|p| p.handle.clone());
        self.packages.retain(|p| p.uri != uri);
        self.packages.push(PackageView {
            uri,
            did: key.0.clone(),
            handle,
            status: "active".into(),
            latest_version: latest,
            record: json!({ "name": key.1 }),
        });
    }

    fn log(&self, entry: String) {
        self.calls.lock().unwrap().push(entry);
    }
}

#[async_trait]
impl Registry for RegistryFixture {
    async fn get_package(&self, did: &str, slug: &str) -> Result<Option<PackageView>> {
        self.log(format!("getPackage {slug}"));
        let uri = hpy_project::manifest::package_uri(did, slug);
        Ok(self.packages.iter().find(|p| p.uri == uri).cloned())
    }

    async fn get_release(
        &self,
        did: &str,
        slug: &str,
        version: &str,
    ) -> Result<Option<ReleaseView>> {
        self.log(format!("getRelease {slug}@{version}"));
        Ok(self
            .releases
            .get(&(did.into(), slug.into()))
            .and_then(|rs| rs.iter().find(|r| r.record["version"] == version))
            .cloned())
    }

    async fn list_releases(&self, did: &str, slug: &str) -> Result<Vec<ReleaseView>> {
        self.log(format!("listReleases {slug}"));
        Ok(self
            .releases
            .get(&(did.into(), slug.into()))
            .cloned()
            .unwrap_or_default())
    }

    /// Answers as the deployed registry does: no `latestVersion` and no
    /// `handle`, which only `getPackage` fills in.
    async fn search_packages(&self, plugin_type: &str) -> Result<Vec<PackageView>> {
        self.log(format!("searchPackages {plugin_type}"));
        let of_type = |p: &PackageView| {
            let slug = hpy_atproto::rkey_of(&p.uri);
            self.releases[&(p.did.clone(), slug.to_string())]
                .iter()
                .any(|r| {
                    r.record["version"].as_str() == p.latest_version.as_deref()
                        && r.record["extensions"][hpy_plugin::EXTENSION_NSID]["pluginType"]
                            == plugin_type
                })
        };
        Ok(self
            .packages
            .iter()
            .filter(|p| of_type(p))
            .map(|p| PackageView {
                latest_version: None,
                handle: None,
                ..p.clone()
            })
            .collect())
    }

    async fn get_artifact(&self, did: &str, slug: &str, version: &str) -> Result<Vec<u8>> {
        self.log(format!("getArtifact {slug}@{version}"));
        self.artifacts
            .get(&(did.into(), slug.into(), version.into()))
            .cloned()
            .ok_or_else(|| Error::Other(format!("no artifact for {slug}@{version}")))
    }

    async fn publish_profile(&self, _: &str, _: Value, _: bool) -> Result<Option<WriteResult>> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }

    async fn publish_release(&self, _: Value, _: bool) -> Result<Option<WriteResult>> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }

    async fn update_profile(&self, _: &str, _: Value, _: Option<&str>) -> Result<WriteResult> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }

    async fn withdraw_release(&self, _: &str, _: &str) -> Result<bool> {
        Err(Error::Other("RegistryFixture does not publish".into()))
    }
}

pub fn interpreter_ext(language: &str, extension: &str) -> Value {
    json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": language,
            "fileExtensions": [extension], "capabilities": ["script:host"] })
}

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
