//! From what the user typed to where to sign them in: handle or DID → DID
//! document → PDS → its authorization server's metadata.

use async_trait::async_trait;
use jacquard::identity::JacquardResolver;
use jacquard::oauth::resolver::OAuthResolver;

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct AuthServer {
    pub issuer: String,
    pub par_endpoint: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub did: String,
    pub handle: Option<String>,
    pub pds: String,
    pub auth: AuthServer,
}

#[async_trait]
pub trait Resolver: Send + Sync {
    async fn resolve(&self, identifier: &str) -> Result<Resolved>;
}

/// The real network, through jacquard's identity and OAuth resolvers.
#[derive(Default)]
pub struct NetworkResolver(JacquardResolver<reqwest::Client>);

#[async_trait]
impl Resolver for NetworkResolver {
    async fn resolve(&self, identifier: &str) -> Result<Resolved> {
        let identifier = identifier.trim().trim_start_matches('@');
        if identifier.starts_with("http://") || identifier.starts_with("https://") {
            return Err(Error::Other(
                "sign in with your handle or DID, not a server URL".into(),
            ));
        }
        let (meta, doc) = self.0.resolve_oauth(identifier).await.map_err(|e| {
            Error::Other(format!("could not find where `{identifier}` signs in: {e}"))
        })?;
        let doc = doc.ok_or_else(|| Error::Other(format!("`{identifier}` has no DID document")))?;
        let pds = doc
            .pds_endpoint()
            .ok_or_else(|| Error::Other(format!("`{identifier}` has no PDS in its DID document")))?
            .to_string();
        let par_endpoint = meta
            .pushed_authorization_request_endpoint
            .as_ref()
            .map(|s| s.to_string())
            .ok_or_else(|| Error::Other("the authorization server does not support PAR".into()))?;
        Ok(Resolved {
            did: doc.id.to_string(),
            handle: doc.handles().first().map(|h| h.to_string()),
            pds: pds.trim_end_matches('/').to_string(),
            auth: AuthServer {
                issuer: meta.issuer.to_string(),
                par_endpoint,
                authorization_endpoint: meta.authorization_endpoint.to_string(),
                token_endpoint: meta.token_endpoint.to_string(),
            },
        })
    }
}
