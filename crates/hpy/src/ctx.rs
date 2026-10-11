use std::path::PathBuf;

use hpy_atproto::keystore::{KeyStore, Keychain};
use hpy_atproto::session::{self, Session};
use hpy_atproto::{HttpRegistry, Settings};

use crate::failure::Failure;
use crate::output::Output;
use crate::prompt::Prompter;

pub struct Ctx {
    pub settings: Settings,
    pub prompter: Prompter,
    pub out: Output,
    pub dir: PathBuf,
}

impl Ctx {
    /// Where the DPoP key is kept.
    pub fn keystore(&self) -> &dyn KeyStore {
        &Keychain
    }

    pub fn session(&self) -> Result<Session, Failure> {
        session::current(&self.settings, self.keystore())?.ok_or_else(Failure::not_logged_in)
    }

    /// The registry, for reads; publishing goes through `Session::registry`.
    pub fn registry(&self) -> HttpRegistry {
        HttpRegistry::new(&self.settings.registry_url).with_client_key(&self.settings.client_key)
    }
}
