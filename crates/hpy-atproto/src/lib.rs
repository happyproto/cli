//! atproto for `hpy`: sessions, the user's repo, and the registry's queries.

pub mod credential;
pub mod dpop;
pub mod error;
pub mod happyview;
pub mod keystore;
pub mod login;
pub mod oauth;
pub mod pkce;
pub mod registry;
pub mod repo;
pub mod resolve;
pub mod scope;
pub mod session;
pub mod settings;

pub use error::{Error, Result};
pub use registry::{
    HttpRegistry, ProjectView, PublishOut, PutProjectOut, Ref, Registry, VersionView,
};
pub use repo::{HappyViewRepo, Repo, StoredRecord, WriteResult, rkey_of};
pub use settings::Settings;
