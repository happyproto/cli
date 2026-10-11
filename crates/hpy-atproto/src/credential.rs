//! The signed-in session: what HappyView needs to recognise this device.
//!
//! The DPoP private key is the secret — the access token is bound to it and
//! useless alone — so the key goes in the OS keychain and everything else in
//! `credentials.json` (0600). Without a usable keychain the key is stored in
//! the same file instead. `HPY_CREDENTIAL` (from `hpy registry login --export`) takes
//! precedence over both, for CI.

use std::io::Write;
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::dpop::DpopKey;
use crate::keystore::{KeyStore, KeyStoreError};
use crate::settings::{Settings, StoreChoice};
use crate::{Error, Result};

pub const ENV_VAR: &str = "HPY_CREDENTIAL";

#[derive(Clone, PartialEq)]
pub struct Credential {
    pub registry: String,
    pub client_key: String,
    pub did: String,
    pub handle: Option<String>,
    pub pds: String,
    pub scopes: String,
    pub access_token: String,
    pub dpop_key: DpopKey,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The access token is a secret; the key's Debug shows only its thumbprint.
        f.debug_struct("Credential")
            .field("registry", &self.registry)
            .field("did", &self.did)
            .field("handle", &self.handle)
            .field("pds", &self.pds)
            .field("scopes", &self.scopes)
            .field("dpop_key", &self.dpop_key)
            .finish_non_exhaustive()
    }
}

/// Who is signed in, read without the keychain.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub did: String,
    pub handle: Option<String>,
    pub pds: String,
    pub registry: String,
    /// `keychain`, `file`, or `environment`.
    pub storage: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Saved {
    Keychain,
    /// In the file; `reason` says why the keychain was not used, if it was tried.
    File {
        reason: Option<String>,
    },
}

#[derive(Serialize, Deserialize)]
struct Stored {
    v: u8,
    registry: String,
    client_key: String,
    did: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    handle: Option<String>,
    pds: String,
    scopes: String,
    access_token: String,
    /// `{"keychain": true}`, or the private JWK itself.
    dpop_key: Value,
}

impl Stored {
    fn from(c: &Credential, dpop_key: Value) -> Stored {
        Stored {
            v: 1,
            registry: c.registry.clone(),
            client_key: c.client_key.clone(),
            did: c.did.clone(),
            handle: c.handle.clone(),
            pds: c.pds.clone(),
            scopes: c.scopes.clone(),
            access_token: c.access_token.clone(),
            dpop_key,
        }
    }

    fn in_keychain(&self) -> bool {
        self.dpop_key.get("keychain").and_then(Value::as_bool) == Some(true)
    }

    fn into_credential(self, dpop_key: DpopKey) -> Credential {
        Credential {
            registry: self.registry,
            client_key: self.client_key,
            did: self.did,
            handle: self.handle,
            pds: self.pds,
            scopes: self.scopes,
            access_token: self.access_token,
            dpop_key,
        }
    }

    fn identity(&self, storage: &'static str) -> Identity {
        Identity {
            did: self.did.clone(),
            handle: self.handle.clone(),
            pds: self.pds.clone(),
            registry: self.registry.clone(),
            storage,
        }
    }
}

/// The keychain account: `<registry host>/<did>`, so sessions on different
/// registries never collide.
pub fn account(registry: &str, did: &str) -> String {
    let host = url::Url::parse(registry)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            })
        })
        .unwrap_or_else(|| registry.trim_end_matches('/').to_string());
    format!("{host}/{did}")
}

fn login_again(why: &str) -> Error {
    Error::LoginRequired(format!("{why}; run `hpy registry login`"))
}

/// Writes `credentials.json` owner-only, atomically.
fn write_file(path: &Path, stored: &Stored) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::Other("credentials path has no directory".into()))?;
    std::fs::create_dir_all(dir).map_err(Error::other)?;
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(Error::other)?;
    file.write_all(
        serde_json::to_string_pretty(stored)
            .map_err(Error::other)?
            .as_bytes(),
    )
    .map_err(Error::other)?;
    file.sync_all().map_err(Error::other)?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(Error::other)
}

fn read_file(path: &Path) -> Result<Option<std::result::Result<Stored, String>>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(serde_json::from_str(&text).map_err(|e| e.to_string()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::other(e)),
    }
}

/// The file the login before HappyView left behind; it held tokens.
const LEGACY_SESSION_FILE: &str = "session.toml";

pub fn save(settings: &Settings, c: &Credential, store: &dyn KeyStore) -> Result<Saved> {
    let _ = std::fs::remove_file(settings.config_dir.join(LEGACY_SESSION_FILE));
    let path = settings.credentials_file();
    let inline = || write_file(&path, &Stored::from(c, c.dpop_key.to_jwk()));
    if settings.credential_store == StoreChoice::File {
        inline()?;
        return Ok(Saved::File { reason: None });
    }
    match store.set(
        &account(&c.registry, &c.did),
        &c.dpop_key.to_jwk().to_string(),
    ) {
        Ok(()) => {
            write_file(&path, &Stored::from(c, json!({ "keychain": true })))?;
            Ok(Saved::Keychain)
        }
        Err(KeyStoreError::Unavailable(reason))
            if settings.credential_store == StoreChoice::Auto =>
        {
            inline()?;
            Ok(Saved::File {
                reason: Some(reason),
            })
        }
        Err(e) => Err(Error::Other(format!(
            "could not store your key in the OS keychain ({e}); set HPY_CREDENTIAL_STORE=file \
             to keep it in a 0600 file instead"
        ))),
    }
}

pub fn load(
    settings: &Settings,
    store: &dyn KeyStore,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<Credential>> {
    if let Some(exported) = env(ENV_VAR) {
        return import(&exported).map(Some);
    }
    let Some(stored) = read_file(&settings.credentials_file())? else {
        return Ok(None);
    };
    let stored = stored.map_err(|_| login_again("your saved login is unreadable"))?;
    let jwk: Value = if stored.in_keychain() {
        match store.get(&account(&stored.registry, &stored.did)) {
            Ok(Some(secret)) => serde_json::from_str(&secret)
                .map_err(|_| login_again("the key in your OS keychain is unreadable"))?,
            Ok(None) => return Err(login_again("your hpy key is missing from the OS keychain")),
            Err(e) => {
                return Err(login_again(&format!(
                    "could not read your key from the OS keychain ({e})"
                )));
            }
        }
    } else {
        stored.dpop_key.clone()
    };
    let key = DpopKey::from_jwk(&jwk).map_err(|_| login_again("your saved key is unreadable"))?;
    Ok(Some(stored.into_credential(key)))
}

/// Who is signed in, without touching the keychain (for `whoami`).
pub fn peek(settings: &Settings, env: &dyn Fn(&str) -> Option<String>) -> Result<Option<Identity>> {
    if let Some(exported) = env(ENV_VAR) {
        let c = import(&exported)?;
        return Ok(Some(Stored::from(&c, Value::Null).identity("environment")));
    }
    match read_file(&settings.credentials_file())? {
        None => Ok(None),
        Some(Err(_)) => Err(login_again("your saved login is unreadable")),
        Some(Ok(stored)) => {
            let storage = if stored.in_keychain() {
                "keychain"
            } else {
                "file"
            };
            Ok(Some(stored.identity(storage)))
        }
    }
}

/// Forgets the stored session: the keychain item and the file. A corrupt file
/// is removed too. Answers who was signed in, when that could be read.
pub fn remove(settings: &Settings, store: &dyn KeyStore) -> Result<Option<Identity>> {
    let path = settings.credentials_file();
    let _ = std::fs::remove_file(path.with_extension("json.tmp"));
    let _ = std::fs::remove_file(settings.config_dir.join(LEGACY_SESSION_FILE));
    let identity = match read_file(&path)? {
        None => return Ok(None),
        Some(Err(_)) => None,
        Some(Ok(stored)) => {
            if stored.in_keychain() {
                let _ = store.delete(&account(&stored.registry, &stored.did));
            }
            Some(stored.identity(if stored.in_keychain() {
                "keychain"
            } else {
                "file"
            }))
        }
    };
    let _ = std::fs::remove_file(&path);
    Ok(identity)
}

/// The whole credential, key included, as one string for `HPY_CREDENTIAL`.
pub fn export(c: &Credential) -> String {
    let json =
        serde_json::to_vec(&Stored::from(c, c.dpop_key.to_jwk())).expect("credential serializes");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

pub fn import(exported: &str) -> Result<Credential> {
    let bad = || {
        Error::LoginRequired(format!(
            "{ENV_VAR} is not a credential from `hpy registry login --export`"
        ))
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(exported.trim())
        .map_err(|_| bad())?;
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    let key = DpopKey::from_jwk(&stored.dpop_key).map_err(|_| bad())?;
    Ok(stored.into_credential(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::{KeyStore, KeyStoreError, MemoryStore};
    use crate::settings::{Settings, StoreChoice};

    fn settings(dir: &std::path::Path, choice: StoreChoice) -> Settings {
        let mut s = Settings::from_sources(None, &|_| None, dir.to_path_buf()).unwrap();
        s.credential_store = choice;
        s
    }

    fn cred(did: &str) -> Credential {
        Credential {
            registry: "https://api.happyproto.at".into(),
            client_key: "hvc_test".into(),
            did: did.into(),
            handle: Some("alice.test".into()),
            pds: "https://pds.test".into(),
            scopes: "atproto".into(),
            access_token: "token".into(),
            dpop_key: DpopKey::generate(),
        }
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    struct Unavailable;
    impl KeyStore for Unavailable {
        fn get(&self, _: &str) -> std::result::Result<Option<String>, KeyStoreError> {
            Err(KeyStoreError::Unavailable("no secret service".into()))
        }
        fn set(&self, _: &str, _: &str) -> std::result::Result<(), KeyStoreError> {
            Err(KeyStoreError::Unavailable("no secret service".into()))
        }
        fn delete(&self, _: &str) -> std::result::Result<(), KeyStoreError> {
            Err(KeyStoreError::Unavailable("no secret service".into()))
        }
    }

    struct MustNotBeUsed;
    impl KeyStore for MustNotBeUsed {
        fn get(&self, _: &str) -> std::result::Result<Option<String>, KeyStoreError> {
            panic!("keychain touched")
        }
        fn set(&self, _: &str, _: &str) -> std::result::Result<(), KeyStoreError> {
            panic!("keychain touched")
        }
        fn delete(&self, _: &str) -> std::result::Result<(), KeyStoreError> {
            panic!("keychain touched")
        }
    }

    #[test]
    fn saves_key_in_keychain_and_rest_in_file() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        let c = cred("did:plc:abc");
        assert_eq!(save(&s, &c, &store).unwrap(), Saved::Keychain);
        let text = std::fs::read_to_string(s.credentials_file()).unwrap();
        let file: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(file["dpop_key"], serde_json::json!({ "keychain": true }));
        assert!(!text.contains("\"d\""), "{text}");
        assert!(
            store
                .get(&account(&c.registry, &c.did))
                .unwrap()
                .unwrap()
                .contains("\"d\"")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(s.credentials_file())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(load(&s, &store, &no_env).unwrap().unwrap(), c);
    }

    #[test]
    fn account_is_registry_host_and_did() {
        assert_eq!(
            account("https://api.happyproto.at", "did:plc:abc"),
            "api.happyproto.at/did:plc:abc"
        );
        assert_eq!(
            account("http://127.0.0.1:3000/", "did:plc:abc"),
            "127.0.0.1:3000/did:plc:abc"
        );
    }

    #[test]
    fn falls_back_to_file_when_keychain_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let c = cred("did:plc:abc");
        assert!(matches!(
            save(&s, &c, &Unavailable).unwrap(),
            Saved::File { reason: Some(_) }
        ));
        assert_eq!(load(&s, &Unavailable, &no_env).unwrap().unwrap(), c);
    }

    #[test]
    fn keychain_choice_makes_unavailable_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Keychain);
        let err = save(&s, &cred("did:plc:abc"), &Unavailable).unwrap_err();
        assert!(err.to_string().contains("HPY_CREDENTIAL_STORE"), "{err}");
        assert!(!s.credentials_file().exists());
    }

    #[test]
    fn file_choice_never_touches_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::File);
        let c = cred("did:plc:abc");
        assert_eq!(
            save(&s, &c, &MustNotBeUsed).unwrap(),
            Saved::File { reason: None }
        );
        assert_eq!(load(&s, &MustNotBeUsed, &no_env).unwrap().unwrap(), c);
        assert!(remove(&s, &MustNotBeUsed).unwrap().is_some());
    }

    #[test]
    fn missing_keychain_item_is_an_auth_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        let c = cred("did:plc:abc");
        save(&s, &c, &store).unwrap();
        store.delete(&account(&c.registry, &c.did)).unwrap();
        let err = load(&s, &store, &no_env).unwrap_err();
        assert!(err.is_auth(), "{err}");
        assert!(err.to_string().contains("hpy registry login"), "{err}");
    }

    #[test]
    fn env_credential_wins() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        save(&s, &cred("did:plc:file"), &store).unwrap();
        let ci = cred("did:plc:ci");
        let exported = export(&ci);
        let env = move |k: &str| (k == "HPY_CREDENTIAL").then(|| exported.clone());
        assert_eq!(load(&s, &MustNotBeUsed, &env).unwrap().unwrap(), ci);
        assert_eq!(peek(&s, &env).unwrap().unwrap().did, "did:plc:ci");
    }

    #[test]
    fn export_import_round_trip() {
        let c = cred("did:plc:abc");
        assert_eq!(import(&export(&c)).unwrap(), c);
        let err = import("not a credential").unwrap_err();
        assert!(
            err.to_string().contains("hpy registry login --export"),
            "{err}"
        );
    }

    #[test]
    fn peek_reads_the_file_without_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        save(&s, &cred("did:plc:abc"), &MemoryStore::default()).unwrap();
        let id = peek(&s, &no_env).unwrap().unwrap();
        assert_eq!(
            (id.did.as_str(), id.handle.as_deref()),
            ("did:plc:abc", Some("alice.test"))
        );
        assert_eq!(id.storage, "keychain");
    }

    #[test]
    fn remove_deletes_both_and_tolerates_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        let c = cred("did:plc:abc");
        save(&s, &c, &store).unwrap();
        let removed = remove(&s, &store).unwrap().unwrap();
        assert_eq!(removed.did, "did:plc:abc");
        assert!(!s.credentials_file().exists());
        assert_eq!(store.get(&account(&c.registry, &c.did)).unwrap(), None);
        std::fs::write(s.credentials_file(), "{garbage").unwrap();
        assert!(remove(&s, &store).unwrap().is_none());
        assert!(!s.credentials_file().exists());
        assert!(remove(&s, &store).unwrap().is_none());
    }

    #[test]
    fn corrupt_file_on_load_says_to_log_in() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        std::fs::write(s.credentials_file(), "{garbage").unwrap();
        let err = load(&s, &MemoryStore::default(), &no_env).unwrap_err();
        assert!(
            err.is_auth() && err.to_string().contains("hpy registry login"),
            "{err}"
        );
    }

    #[test]
    fn debug_never_shows_secrets() {
        let c = cred("did:plc:abc");
        let shown = format!("{c:?}");
        assert!(!shown.contains("token"), "{shown}");
        assert!(shown.contains("did:plc:abc"));
    }

    #[test]
    fn saving_and_removing_clear_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::File);
        std::fs::create_dir_all(dir.path()).unwrap();
        // the pre-HappyView session pointer, and an interrupted write
        std::fs::write(dir.path().join("session.toml"), "did = \"x\"").unwrap();
        save(&s, &cred("did:plc:abc"), &MemoryStore::default()).unwrap();
        assert!(!dir.path().join("session.toml").exists());
        std::fs::write(dir.path().join("credentials.json.tmp"), "{}").unwrap();
        remove(&s, &MemoryStore::default()).unwrap();
        assert!(!dir.path().join("credentials.json.tmp").exists());
    }
}
