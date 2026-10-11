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
}
