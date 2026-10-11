//! The active session: the stored (or `HPY_CREDENTIAL`) credential, wired to
//! HappyView.

use std::sync::Arc;

use crate::Result;
use crate::credential::{self, Credential};
use crate::happyview::HappyView;
use crate::keystore::KeyStore;
use crate::registry::HttpRegistry;
use crate::repo::{HappyViewRepo, Repo};
use crate::settings::Settings;

pub struct Session {
    pub credential: Credential,
    pub happyview: Arc<HappyView>,
    pub repo: Box<dyn Repo>,
}

impl Session {
    pub fn new(credential: Credential) -> Session {
        let happyview = Arc::new(HappyView::new(&credential.registry, &credential.client_key));
        let repo = Box::new(HappyViewRepo::new(happyview.clone(), credential.clone()));
        Session {
            credential,
            happyview,
            repo,
        }
    }

    /// The registry, able to publish as this session.
    pub fn registry(&self) -> HttpRegistry {
        HttpRegistry::new(&self.credential.registry)
            .with_session(self.happyview.clone(), self.credential.clone())
    }
}

pub fn current(settings: &Settings, store: &dyn KeyStore) -> Result<Option<Session>> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    Ok(credential::load(settings, store, &env)?.map(Session::new))
}
