//! Where the DPoP private key lives: the OS keychain, through `keyring`, or —
//! for tests and for machines without one — memory.

use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "hpy";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyStoreError {
    /// There is no usable keychain here (no Secret Service, locked, denied).
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Other(String),
}

pub trait KeyStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, KeyStoreError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), KeyStoreError>;
    /// Deleting what is not there succeeds.
    fn delete(&self, account: &str) -> Result<(), KeyStoreError>;
}

/// The OS keychain: macOS Keychain, Windows Credential Manager, or the Secret
/// Service on Linux.
pub struct Keychain;

fn map(e: keyring::Error) -> KeyStoreError {
    match e {
        keyring::Error::NoStorageAccess(_)
        | keyring::Error::PlatformFailure(_)
        | keyring::Error::NoDefaultStore
        | keyring::Error::NotSupportedByStore(_) => KeyStoreError::Unavailable(e.to_string()),
        other => KeyStoreError::Other(other.to_string()),
    }
}

impl KeyStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, KeyStoreError> {
        match keyring::Entry::new(SERVICE, account)
            .map_err(map)?
            .get_password()
        {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map(e)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), KeyStoreError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(map)?
            .set_password(secret)
            .map_err(map)
    }

    fn delete(&self, account: &str) -> Result<(), KeyStoreError> {
        match keyring::Entry::new(SERVICE, account)
            .map_err(map)?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map(e)),
        }
    }
}

/// An in-memory store, for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl KeyStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, KeyStoreError> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), KeyStoreError> {
        self.0.lock().unwrap().insert(account.into(), secret.into());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), KeyStoreError> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let s = MemoryStore::default();
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", "secret").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("secret"));
        s.delete("a").unwrap();
        s.delete("a").unwrap();
        assert_eq!(s.get("a").unwrap(), None);
    }

    /// Touches the real OS keychain; run by hand: `cargo test -p hpy-atproto real_keychain -- --ignored`.
    #[test]
    #[ignore]
    fn real_keychain_round_trip() {
        let account = format!("hpy-test/{}", crate::dpop::random_token(8));
        let k = Keychain;
        assert_eq!(k.get(&account).unwrap(), None);
        k.set(&account, "secret").unwrap();
        assert_eq!(k.get(&account).unwrap().as_deref(), Some("secret"));
        k.delete(&account).unwrap();
        assert_eq!(k.get(&account).unwrap(), None);
    }
}
