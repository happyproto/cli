//! Sign-ins to HappyView instances' admin APIs: one `hv_` API key per
//! instance URL, made in that instance's dashboard.
//!
//! The key goes in the OS keychain, under `hv-api-key/<host>`, and the list
//! of instances in `instances.json` (0600). Without a usable keychain the key
//! is stored in the same file instead, as `credentials.json` does.
//! `HPY_HV_API_KEY` (with `HPY_HV_URL` or `--url`) takes precedence, for CI.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::credential::{Saved, write_file};
use crate::keystore::{KeyStore, KeyStoreError};
use crate::settings::{Settings, StoreChoice};
use crate::{Error, Result};

pub const KEY_VAR: &str = "HPY_HV_API_KEY";
pub const URL_VAR: &str = "HPY_HV_URL";
const FILE: &str = "instances.json";

/// An instance and the key that signs in to it.
#[derive(Clone, PartialEq)]
pub struct Login {
    pub url: String,
    pub key: String,
}

impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key is a secret; never print it.
        f.debug_struct("Login")
            .field("url", &self.url)
            .field("key", &prefix(&self.key))
            .finish()
    }
}

/// A stored sign-in, read without the keychain.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Info {
    pub url: String,
    /// Enough of the key to find it in the dashboard's list.
    #[serde(rename = "keyPrefix")]
    pub key_prefix: String,
    /// `keychain`, `file`, or `environment`.
    pub storage: &'static str,
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    v: u8,
    instances: Vec<StoredInstance>,
}

#[derive(Serialize, Deserialize, Clone)]
struct StoredInstance {
    url: String,
    key_prefix: String,
    /// `{"keychain": true}`, or the key itself.
    key: Value,
}

impl StoredInstance {
    fn in_keychain(&self) -> bool {
        self.key.get("keychain").and_then(Value::as_bool) == Some(true)
    }

    fn info(&self) -> Info {
        Info {
            url: self.url.clone(),
            key_prefix: self.key_prefix.clone(),
            storage: if self.in_keychain() {
                "keychain"
            } else {
                "file"
            },
        }
    }
}

/// `hv_` and the first characters after it, as the dashboard lists keys.
pub fn prefix(key: &str) -> String {
    let shown: String = key.chars().take(8).collect();
    format!("{shown}…")
}

/// The keychain account for an instance's key.
pub fn account(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    format!("hv-api-key/{rest}")
}

/// An instance URL as it is stored and compared: https (or http to this
/// computer), no query or fragment, no trailing slash. A path is kept, for
/// an instance served under one.
pub fn normalize_url(raw: &str) -> Result<String> {
    let bad = |why: &str| Error::LoginRequired(format!("`{raw}` is not an instance URL: {why}"));
    let url = url::Url::parse(raw.trim()).map_err(|_| bad("expected https://api.example.com"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err(bad("it must use https")),
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("it has a query or fragment"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("it has credentials in it"));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Checks that `key` looks like a HappyView API key, without saying what it is.
pub fn check_key(key: &str) -> std::result::Result<(), String> {
    let key = key.trim();
    if !key.starts_with("hv_") || key.len() < 8 || key.chars().any(char::is_whitespace) {
        return Err("an API key starts with hv_; create one in the instance's dashboard".into());
    }
    Ok(())
}

fn path(settings: &Settings) -> std::path::PathBuf {
    settings.config_dir.join(FILE)
}

fn read(settings: &Settings) -> Result<Stored> {
    match std::fs::read_to_string(path(settings)) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| {
            Error::LoginRequired(format!(
                "{} is unreadable; delete it and run `hpy hv login --url <instance>` again",
                path(settings).display()
            ))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
        Err(e) => Err(Error::other(e)),
    }
}

fn write(settings: &Settings, stored: &Stored) -> Result<()> {
    if stored.instances.is_empty() {
        return match std::fs::remove_file(path(settings)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::other(e)),
            _ => Ok(()),
        };
    }
    write_file(&path(settings), stored)
}

/// Saves the key for `url`, replacing any key saved for it before.
pub fn save(settings: &Settings, url: &str, key: &str, store: &dyn KeyStore) -> Result<Saved> {
    let url = normalize_url(url)?;
    let key = key.trim();
    check_key(key).map_err(Error::LoginRequired)?;
    let mut stored = read(settings)?;
    stored.v = 1;
    stored.instances.retain(|i| i.url != url);
    let saved = if settings.credential_store == StoreChoice::File {
        Saved::File { reason: None }
    } else {
        match store.set(&account(&url), key) {
            Ok(()) => Saved::Keychain,
            Err(KeyStoreError::Unavailable(reason))
                if settings.credential_store == StoreChoice::Auto =>
            {
                Saved::File {
                    reason: Some(reason),
                }
            }
            Err(e) => {
                return Err(Error::Other(format!(
                    "could not store the API key in the OS keychain ({e}); set HPY_CREDENTIAL_STORE=file \
                     to keep it in a 0600 file instead"
                )));
            }
        }
    };
    stored.instances.push(StoredInstance {
        url: url.clone(),
        key_prefix: prefix(key),
        key: match saved {
            Saved::Keychain => json!({ "keychain": true }),
            Saved::File { .. } => json!(key),
        },
    });
    write(settings, &stored)?;
    Ok(saved)
}

/// Every stored sign-in, without touching the keychain.
pub fn list(settings: &Settings) -> Result<Vec<Info>> {
    Ok(read(settings)?
        .instances
        .iter()
        .map(StoredInstance::info)
        .collect())
}

fn not_signed_in(url: Option<&str>) -> Error {
    Error::LoginRequired(format!(
        "not signed in to {}; create an API key in its dashboard and run `hpy hv login --url {}`",
        url.unwrap_or("a HappyView instance"),
        url.unwrap_or("<instance>")
    ))
}

/// The stored instance `url` names, or the only one when it names none.
fn choose<'a>(stored: &'a Stored, url: Option<&str>) -> Result<&'a StoredInstance> {
    match url {
        Some(url) => stored
            .instances
            .iter()
            .find(|i| i.url == url)
            .ok_or_else(|| not_signed_in(Some(url))),
        None => match stored.instances.as_slice() {
            [] => Err(not_signed_in(None)),
            [only] => Ok(only),
            several => {
                let urls: Vec<&str> = several.iter().map(|i| i.url.as_str()).collect();
                Err(Error::Other(format!(
                    "signed in to several instances ({}); choose one with --url",
                    urls.join(", ")
                )))
            }
        },
    }
}

/// The instance to act on and its key: `HPY_HV_API_KEY` with `url` or
/// `HPY_HV_URL` when set, else a stored sign-in.
pub fn current(
    settings: &Settings,
    store: &dyn KeyStore,
    env: &dyn Fn(&str) -> Option<String>,
    url: Option<&str>,
) -> Result<Login> {
    let url = url.map(normalize_url).transpose()?;
    if let Some(key) = env(KEY_VAR) {
        let url = match url {
            Some(url) => url,
            None => normalize_url(&env(URL_VAR).ok_or_else(|| {
                Error::LoginRequired(format!(
                    "{KEY_VAR} is set, so set {URL_VAR} or pass --url too"
                ))
            })?)?,
        };
        check_key(&key).map_err(|e| Error::LoginRequired(format!("{KEY_VAR}: {e}")))?;
        return Ok(Login {
            url,
            key: key.trim().to_string(),
        });
    }
    let stored = read(settings)?;
    let chosen = choose(&stored, url.as_deref())?;
    let key = if chosen.in_keychain() {
        let again = |why: String| {
            Error::LoginRequired(format!("{why}; run `hpy hv login --url {}`", chosen.url))
        };
        match store.get(&account(&chosen.url)) {
            Ok(Some(key)) => key,
            Ok(None) => return Err(again("the API key is missing from the OS keychain".into())),
            Err(e) => {
                return Err(again(format!(
                    "could not read the API key from the OS keychain ({e})"
                )));
            }
        }
    } else {
        chosen
            .key
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| not_signed_in(Some(&chosen.url)))?
    };
    Ok(Login {
        url: chosen.url.clone(),
        key,
    })
}

/// Forgets the sign-in `url` names (or the only one): its keychain item and
/// its entry. Answers what was forgotten, if anything was stored.
pub fn remove(
    settings: &Settings,
    store: &dyn KeyStore,
    url: Option<&str>,
) -> Result<Option<Info>> {
    let url = url.map(normalize_url).transpose()?;
    let mut stored = read(settings)?;
    let chosen = match choose(&stored, url.as_deref()) {
        Ok(chosen) => chosen.clone(),
        Err(e) if e.is_auth() => return Ok(None),
        Err(e) => return Err(e),
    };
    if chosen.in_keychain() {
        let _ = store.delete(&account(&chosen.url));
    }
    stored.instances.retain(|i| i.url != chosen.url);
    write(settings, &stored)?;
    Ok(Some(chosen.info()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::MemoryStore;

    const KEY: &str = "hv_0123456789abcdef0123456789abcdef";
    const OTHER: &str = "hv_fedcba9876543210fedcba9876543210";

    fn settings(dir: &std::path::Path, choice: StoreChoice) -> Settings {
        let mut s = Settings::from_sources(None, &|_| None, dir.to_path_buf()).unwrap();
        s.credential_store = choice;
        s
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

    #[test]
    fn urls_are_https_without_a_trailing_slash() {
        assert_eq!(
            normalize_url("https://api.example.com/").unwrap(),
            "https://api.example.com"
        );
        assert_eq!(
            normalize_url("https://example.com/hv/").unwrap(),
            "https://example.com/hv"
        );
        assert_eq!(
            normalize_url("http://127.0.0.1:3000").unwrap(),
            "http://127.0.0.1:3000"
        );
        for bad in [
            "http://api.example.com",
            "api.example.com",
            "https://api.example.com/?x=1",
            "https://me:pw@api.example.com",
        ] {
            assert!(normalize_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn keys_look_like_happyview_keys() {
        assert!(check_key(KEY).is_ok());
        for bad in ["", "hvc_0123456789", "hv_12", "hv_0123 4567"] {
            assert!(check_key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn saves_the_key_in_the_keychain_and_the_instance_in_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        assert_eq!(
            save(&s, "https://api.example.com/", KEY, &store).unwrap(),
            Saved::Keychain
        );
        let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!text.contains(KEY), "{text}");
        assert_eq!(
            store.get("hv-api-key/api.example.com").unwrap().as_deref(),
            Some(KEY)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let login = current(&s, &store, &no_env, None).unwrap();
        assert_eq!(login.url, "https://api.example.com");
        assert_eq!(login.key, KEY);
        assert_eq!(
            list(&s).unwrap(),
            vec![Info {
                url: "https://api.example.com".into(),
                key_prefix: "hv_01234…".into(),
                storage: "keychain",
            }]
        );
    }

    #[test]
    fn falls_back_to_the_file_without_a_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        assert!(matches!(
            save(&s, "https://api.example.com", KEY, &Unavailable).unwrap(),
            Saved::File { reason: Some(_) }
        ));
        assert_eq!(current(&s, &Unavailable, &no_env, None).unwrap().key, KEY);
        assert_eq!(list(&s).unwrap()[0].storage, "file");
    }

    #[test]
    fn logging_in_again_replaces_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::File);
        let store = MemoryStore::default();
        save(&s, "https://api.example.com", KEY, &store).unwrap();
        save(&s, "https://api.example.com/", OTHER, &store).unwrap();
        assert_eq!(list(&s).unwrap().len(), 1);
        assert_eq!(current(&s, &store, &no_env, None).unwrap().key, OTHER);
    }

    #[test]
    fn several_instances_need_a_url_to_choose() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        save(&s, "https://a.example.com", KEY, &store).unwrap();
        save(&s, "https://b.example.com", OTHER, &store).unwrap();
        let err = current(&s, &store, &no_env, None).unwrap_err().to_string();
        assert!(err.contains("--url"), "{err}");
        assert!(err.contains("https://a.example.com"), "{err}");
        let login = current(&s, &store, &no_env, Some("https://b.example.com/")).unwrap();
        assert_eq!(login.key, OTHER);
        let err = current(&s, &store, &no_env, Some("https://c.example.com")).unwrap_err();
        assert!(err.is_auth());
        assert!(
            err.to_string()
                .contains("hpy hv login --url https://c.example.com")
        );
    }

    #[test]
    fn nothing_saved_says_how_to_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let err = current(&s, &MemoryStore::default(), &no_env, None).unwrap_err();
        assert!(err.is_auth());
        assert!(err.to_string().contains("hpy hv login --url"), "{err}");
    }

    #[test]
    fn the_environment_takes_precedence_and_never_touches_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let env = |k: &str| match k {
            KEY_VAR => Some(OTHER.to_string()),
            URL_VAR => Some("https://ci.example.com/".to_string()),
            _ => None,
        };
        let login = current(&s, &Unavailable, &env, None).unwrap();
        assert_eq!(login.url, "https://ci.example.com");
        assert_eq!(login.key, OTHER);
        // --url wins over HPY_HV_URL.
        let login = current(&s, &Unavailable, &env, Some("https://other.example.com")).unwrap();
        assert_eq!(login.url, "https://other.example.com");
        let key_only = |k: &str| (k == KEY_VAR).then(|| OTHER.to_string());
        let err = current(&s, &Unavailable, &key_only, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains(URL_VAR), "{err}");
    }

    #[test]
    fn remove_forgets_the_key_and_the_instance() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        save(&s, "https://a.example.com", KEY, &store).unwrap();
        save(&s, "https://b.example.com", OTHER, &store).unwrap();
        let gone = remove(&s, &store, Some("https://a.example.com"))
            .unwrap()
            .unwrap();
        assert_eq!(gone.url, "https://a.example.com");
        assert_eq!(store.get("hv-api-key/a.example.com").unwrap(), None);
        assert_eq!(list(&s).unwrap().len(), 1);
        assert!(
            remove(&s, &store, Some("https://a.example.com"))
                .unwrap()
                .is_none()
        );
        // With one left, no URL is needed.
        remove(&s, &store, None).unwrap().unwrap();
        assert!(!dir.path().join(FILE).exists());
    }

    #[test]
    fn debug_never_shows_the_key() {
        let login = Login {
            url: "https://api.example.com".into(),
            key: KEY.into(),
        };
        assert!(!format!("{login:?}").contains(KEY));
    }
}
