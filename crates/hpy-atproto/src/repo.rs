use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::credential::Credential;
use crate::happyview::{HappyView, xrpc_error};
use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct StoredRecord {
    pub uri: String,
    pub cid: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WriteResult {
    pub uri: String,
    pub cid: String,
}

/// The signed-in user's own repo. Commands are written against this trait so
/// they can be tested with an in-memory fake. Writing plugin records is the
/// registry's job (`Registry::publish_*`, `update_profile`,
/// `withdraw_release`): a raw `com.atproto.repo.*` write sent to HappyView is
/// proxied wherever the instance's routing points, which need not be the
/// user's PDS.
#[async_trait]
pub trait Repo: Send + Sync {
    fn did(&self) -> &str;
    async fn get_record(&self, collection: &str, rkey: &str) -> Result<Option<StoredRecord>>;
    async fn list_records(&self, collection: &str) -> Result<Vec<StoredRecord>>;
    /// Uploads a blob and answers the blob ref JSON (`{$type, ref, mimeType, size}`).
    async fn upload_blob(&self, bytes: Vec<u8>, mime: &str) -> Result<Value>;
    /// The scopes this session was granted, where they are known. `None`
    /// means not knowable here rather than none granted, so a caller that
    /// pre-checks a grant has to let `None` through and leave the refusal to
    /// the server.
    fn granted_scopes(&self) -> Option<&str>;
}

/// The record key: the last path segment of an AT URI.
pub fn rkey_of(uri: &str) -> &str {
    uri.rsplit('/').next().unwrap_or(uri)
}

/// Reads straight from the user's PDS (they are public); blob uploads go
/// through HappyView, which holds the session and acts as the user.
pub struct HappyViewRepo {
    hv: Arc<HappyView>,
    cred: Credential,
    http: reqwest::Client,
}

impl HappyViewRepo {
    pub fn new(hv: Arc<HappyView>, cred: Credential) -> HappyViewRepo {
        HappyViewRepo {
            hv,
            cred,
            http: reqwest::Client::builder()
                .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("http client"),
        }
    }

    async fn pds_get(&self, method: &str, params: &[(&str, &str)]) -> Result<Option<Value>> {
        let url = format!("{}/xrpc/{method}", self.cred.pds.trim_end_matches('/'));
        let resp = self
            .http
            .get(&url)
            .query(params)
            .send()
            .await
            .map_err(|e| Error::Other(format!("could not reach your PDS ({method}): {e}")))?;
        let status = resp.status();
        let body = resp.bytes().await.map_err(Error::other)?;
        if status.is_success() {
            return serde_json::from_slice(&body)
                .map(Some)
                .map_err(Error::other);
        }
        match xrpc_error(method, status, &body, true) {
            Error::Xrpc { name, .. } if name == "RecordNotFound" => Ok(None),
            e => Err(e),
        }
    }
}

fn stored(v: &Value) -> StoredRecord {
    StoredRecord {
        uri: v["uri"].as_str().unwrap_or_default().to_string(),
        cid: v["cid"].as_str().map(str::to_string),
        value: v["value"].clone(),
    }
}

#[async_trait]
impl Repo for HappyViewRepo {
    fn did(&self) -> &str {
        &self.cred.did
    }

    fn granted_scopes(&self) -> Option<&str> {
        Some(&self.cred.scopes)
    }

    async fn get_record(&self, collection: &str, rkey: &str) -> Result<Option<StoredRecord>> {
        let params = [
            ("repo", self.cred.did.as_str()),
            ("collection", collection),
            ("rkey", rkey),
        ];
        Ok(self
            .pds_get("com.atproto.repo.getRecord", &params)
            .await?
            .as_ref()
            .map(stored))
    }

    async fn list_records(&self, collection: &str) -> Result<Vec<StoredRecord>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut params = vec![
                ("repo", self.cred.did.as_str()),
                ("collection", collection),
                ("limit", "100"),
            ];
            if let Some(c) = &cursor {
                params.push(("cursor", c));
            }
            let Some(page) = self
                .pds_get("com.atproto.repo.listRecords", &params)
                .await?
            else {
                break;
            };
            out.extend(page["records"].as_array().into_iter().flatten().map(stored));
            match page["cursor"].as_str() {
                Some(c) if Some(c) != cursor.as_deref() => cursor = Some(c.to_string()),
                _ => break,
            }
        }
        Ok(out)
    }

    async fn upload_blob(&self, bytes: Vec<u8>, mime: &str) -> Result<Value> {
        self.hv.upload_blob(&self.cred, bytes, mime).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::Credential;
    use crate::dpop::DpopKey;
    use crate::happyview::HappyView;
    use std::sync::Arc;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn repo(hv: &MockServer, pds: &MockServer) -> HappyViewRepo {
        let cred = Credential {
            registry: hv.uri(),
            client_key: "hvc_test".into(),
            did: "did:plc:abc".into(),
            handle: None,
            pds: pds.uri(),
            scopes: "atproto".into(),
            access_token: "tok".into(),
            dpop_key: DpopKey::generate(),
        };
        HappyViewRepo::new(Arc::new(HappyView::new(&hv.uri(), "hvc_test")), cred)
    }

    #[tokio::test]
    async fn reads_come_from_the_pds_and_not_found_is_none() {
        let (hv, pds) = (MockServer::start().await, MockServer::start().await);
        Mock::given(method("GET"))
            .and(path("/xrpc/com.atproto.repo.getRecord"))
            .and(query_param("rkey", "x"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "uri": "at://did:plc:abc/c/x", "cid": "bafy", "value": { "a": 1 }
            })))
            .mount(&pds)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/com.atproto.repo.getRecord"))
            .and(query_param("rkey", "missing"))
            .respond_with(
                ResponseTemplate::new(400).set_body_json(
                    serde_json::json!({ "error": "RecordNotFound", "message": "nope" }),
                ),
            )
            .mount(&pds)
            .await;
        let r = repo(&hv, &pds);
        let got = r.get_record("c", "x").await.unwrap().unwrap();
        assert_eq!(
            (got.cid.as_deref(), got.value["a"].as_i64()),
            (Some("bafy"), Some(1))
        );
        assert!(r.get_record("c", "missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_records_follows_the_cursor() {
        let (hv, pds) = (MockServer::start().await, MockServer::start().await);
        Mock::given(method("GET"))
            .and(path("/xrpc/com.atproto.repo.listRecords"))
            .and(query_param("cursor", "next"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "records": [{ "uri": "at://d/c/2", "cid": "b2", "value": {} }]
            })))
            .mount(&pds)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/com.atproto.repo.listRecords"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "records": [{ "uri": "at://d/c/1", "cid": "b1", "value": {} }], "cursor": "next"
            })))
            .mount(&pds)
            .await;
        let all = repo(&hv, &pds).list_records("c").await.unwrap();
        assert_eq!(
            all.iter().map(|r| r.uri.as_str()).collect::<Vec<_>>(),
            ["at://d/c/1", "at://d/c/2"]
        );
    }
}
