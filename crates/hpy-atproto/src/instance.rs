//! Sign-ins to HappyView instances' admin APIs, one per instance URL.
//!
//! A person signs in through the browser: `hpy happyview login` registers an
//! OAuth session with the instance as HappyView's built-in `hpy` client, and
//! keeps its DPoP key, as `hpy registry login` does for the registry. CI
//! uses an `hv_` API key made in the instance's dashboard instead.
//!
//! The secret (the DPoP key, or the API key) goes in the OS keychain, under
//! `hv-session/<host>` or `hv-api-key/<host>`, and everything else in
//! `instances.json` (0600). Without a usable keychain the secret is stored in
//! the same file instead, as `credentials.json` does. `HPY_HV_API_KEY` (with
//! `HPY_HV_URL` or `--url`) takes precedence over both.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::credential::{Credential, Saved, write_file};
use crate::dpop::DpopKey;
use crate::keystore::{KeyStore, KeyStoreError};
use crate::settings::{ClientAuth, Redirect, Settings, StoreChoice};
use crate::{Error, Result};

pub const KEY_VAR: &str = "HPY_HV_API_KEY";
pub const URL_VAR: &str = "HPY_HV_URL";
const FILE: &str = "instances.json";

/// The OAuth client every instance knows `hpy` as: public and native, so
/// no instance holds a key for it.
pub const OAUTH_CLIENT_ID: &str = "https://happyproto.at/oauth/hpy-cli/client-metadata.json";
/// The built-in API client's key, when an instance's `/config` doesn't say.
pub const DEFAULT_CLIENT_KEY: &str = "hvc_hpy";

/// What a login asks the PDS for: who the user is, and HappyView's
/// permission set for managing an instance, which every instance accepts.
pub const SCOPE: &str = "atproto include:dev.happyview.adminFull";

/// The method the set grants, as a PDS spells it out in the token's scope
/// once it has expanded the `include:`.
const ADMIN_LXM: &str = "dev.happyview.admin.manage";

/// Whether a granted scope lets the session manage an instance: an `rpc`
/// permission naming the admin method, for any audience, written either as
/// `rpc:<method>?aud=*` or `rpc?lxm=<method>&lxm=…&aud=*`. A PDS that
/// doesn't know permission sets grants only `atproto`, and a sign-in through
/// it can't deploy.
pub fn grants_admin(scopes: &str) -> bool {
    scopes.split_whitespace().any(|scope| {
        let Some(rest) = scope.strip_prefix("rpc") else {
            return false;
        };
        let (method, params) = match rest.strip_prefix(':') {
            Some(rest) => rest.split_once('?').unwrap_or((rest, "")),
            None => match rest.strip_prefix('?') {
                Some(params) => ("", params),
                None => return false,
            },
        };
        let params: Vec<&str> = params.split('&').collect();
        let any_audience = params
            .iter()
            .any(|p| *p == "aud=*" || p.eq_ignore_ascii_case("aud=%2A"));
        let admin = method == ADMIN_LXM
            || params
                .iter()
                .any(|p| p.strip_prefix("lxm=") == Some(ADMIN_LXM));
        any_audience && admin
    })
}

/// The settings `hpy registry login` signs in with, turned toward an
/// instance: its HappyView and its `hpy` client, as a public client with a
/// loopback redirect, asking for HappyView's instance-management permissions.
pub fn login_settings(base: &Settings, url: &str, client_key: &str) -> Settings {
    let mut s = base.clone();
    s.registry_url = url.to_string();
    s.client_key = client_key.to_string();
    s.oauth_client_id = std::env::var("HPY_HV_OAUTH_CLIENT_ID")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| OAUTH_CLIENT_ID.into());
    s.oauth_scope = SCOPE.into();
    s.oauth_redirect = Redirect::Loopback;
    s.oauth_client_auth = ClientAuth::None;
    s
}

/// How a sign-in proves itself to the instance.
#[derive(Clone, PartialEq)]
pub enum Auth {
    ApiKey(String),
    Session(Credential),
}

/// An instance and how to sign in to it.
#[derive(Clone, PartialEq)]
pub struct Login {
    pub url: String,
    pub auth: Auth,
}

impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Secrets never print: a key shows its prefix, a session its account.
        let auth = match &self.auth {
            Auth::ApiKey(key) => format!("api key {}", prefix(key)),
            Auth::Session(c) => format!("session for {}", c.did),
        };
        f.debug_struct("Login")
            .field("url", &self.url)
            .field("auth", &auth)
            .finish()
    }
}

/// A stored sign-in, read without the keychain.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Info {
    pub url: String,
    /// `session` or `apiKey`.
    pub kind: &'static str,
    /// Who: the handle (or DID) signed in, or enough of the API key to find
    /// it in the dashboard's list.
    pub account: String,
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
    #[serde(flatten)]
    sign_in: SignIn,
    /// `{"keychain": true}`, or the secret itself: the API key, or the
    /// session's private JWK.
    secret: Value,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SignIn {
    ApiKey {
        key_prefix: String,
    },
    Session {
        client_key: String,
        did: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        handle: Option<String>,
        pds: String,
        scopes: String,
        access_token: String,
    },
}

impl StoredInstance {
    fn in_keychain(&self) -> bool {
        self.secret.get("keychain").and_then(Value::as_bool) == Some(true)
    }

    fn account(&self) -> String {
        account(&self.url, matches!(self.sign_in, SignIn::Session { .. }))
    }

    fn info(&self) -> Info {
        let (kind, account) = match &self.sign_in {
            SignIn::ApiKey { key_prefix } => ("apiKey", format!("API key {key_prefix}")),
            SignIn::Session { did, handle, .. } => (
                "session",
                handle
                    .as_ref()
                    .map(|h| format!("@{h}"))
                    .unwrap_or_else(|| did.clone()),
            ),
        };
        Info {
            url: self.url.clone(),
            kind,
            account,
            storage: if self.in_keychain() {
                "keychain"
            } else {
                "file"
            },
        }
    }

    fn login(&self, secret: Value) -> Result<Login> {
        let unreadable = || {
            Error::LoginRequired(format!(
                "the saved sign-in for {} is unreadable; run `hpy hv login --url {}`",
                self.url, self.url
            ))
        };
        let auth = match &self.sign_in {
            SignIn::ApiKey { .. } => {
                Auth::ApiKey(secret.as_str().ok_or_else(unreadable)?.to_string())
            }
            SignIn::Session {
                client_key,
                did,
                handle,
                pds,
                scopes,
                access_token,
            } => Auth::Session(Credential {
                registry: self.url.clone(),
                client_key: client_key.clone(),
                did: did.clone(),
                handle: handle.clone(),
                pds: pds.clone(),
                scopes: scopes.clone(),
                access_token: access_token.clone(),
                dpop_key: DpopKey::from_jwk(&secret).map_err(|_| unreadable())?,
            }),
        };
        Ok(Login {
            url: self.url.clone(),
            auth,
        })
    }
}

/// `hv_` and the first characters after it, as the dashboard lists keys.
pub fn prefix(key: &str) -> String {
    let shown: String = key.chars().take(8).collect();
    format!("{shown}…")
}

/// The keychain account for an instance's session key or API key.
pub fn account(url: &str, session: bool) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let kind = if session { "hv-session" } else { "hv-api-key" };
    format!("{kind}/{rest}")
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

/// Saves a sign-in, replacing whatever was saved for its instance: the
/// secret in the keychain when it can, else inline.
fn save(
    settings: &Settings,
    url: String,
    sign_in: SignIn,
    secret: Value,
    store: &dyn KeyStore,
) -> Result<Saved> {
    let mut stored = read(settings)?;
    stored.v = 1;
    if let Some(old) = stored.instances.iter().find(|i| i.url == url)
        && old.in_keychain()
    {
        let _ = store.delete(&old.account());
    }
    stored.instances.retain(|i| i.url != url);
    let mut entry = StoredInstance {
        url,
        sign_in,
        secret: json!({ "keychain": true }),
    };
    let text = match &secret {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let saved = if settings.credential_store == StoreChoice::File {
        Saved::File { reason: None }
    } else {
        match store.set(&entry.account(), &text) {
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
                    "could not store your sign-in in the OS keychain ({e}); set HPY_CREDENTIAL_STORE=file \
                     to keep it in a 0600 file instead"
                )));
            }
        }
    };
    if !matches!(saved, Saved::Keychain) {
        entry.secret = secret;
    }
    stored.instances.push(entry);
    write(settings, &stored)?;
    Ok(saved)
}

/// Saves the API key for `url`.
pub fn save_key(settings: &Settings, url: &str, key: &str, store: &dyn KeyStore) -> Result<Saved> {
    let url = normalize_url(url)?;
    let key = key.trim();
    check_key(key).map_err(Error::LoginRequired)?;
    let sign_in = SignIn::ApiKey {
        key_prefix: prefix(key),
    };
    save(settings, url, sign_in, json!(key), store)
}

/// Saves the session `hpy happyview login` registered with `c.registry`.
pub fn save_session(settings: &Settings, c: &Credential, store: &dyn KeyStore) -> Result<Saved> {
    let url = normalize_url(&c.registry)?;
    let sign_in = SignIn::Session {
        client_key: c.client_key.clone(),
        did: c.did.clone(),
        handle: c.handle.clone(),
        pds: c.pds.clone(),
        scopes: c.scopes.clone(),
        access_token: c.access_token.clone(),
    };
    save(settings, url, sign_in, c.dpop_key.to_jwk(), store)
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
        "not signed in to {}; run `hpy hv login --url {}`",
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

/// The instance to act on, `url` or else `HPY_HV_URL`, and how to sign in
/// to it: `HPY_HV_API_KEY` when set, else a stored sign-in.
pub fn current(
    settings: &Settings,
    store: &dyn KeyStore,
    env: &dyn Fn(&str) -> Option<String>,
    url: Option<&str>,
) -> Result<Login> {
    let url = url
        .map(str::to_string)
        .or_else(|| env(URL_VAR))
        .map(|u| normalize_url(&u))
        .transpose()?;
    if let Some(key) = env(KEY_VAR) {
        let url = url.ok_or_else(|| {
            Error::LoginRequired(format!(
                "{KEY_VAR} is set, so set {URL_VAR} or pass --url too"
            ))
        })?;
        check_key(&key).map_err(|e| Error::LoginRequired(format!("{KEY_VAR}: {e}")))?;
        return Ok(Login {
            url,
            auth: Auth::ApiKey(key.trim().to_string()),
        });
    }
    let stored = read(settings)?;
    let chosen = choose(&stored, url.as_deref())?;
    let secret = if chosen.in_keychain() {
        let again = |why: String| {
            Error::LoginRequired(format!("{why}; run `hpy hv login --url {}`", chosen.url))
        };
        let text = match store.get(&chosen.account()) {
            Ok(Some(text)) => text,
            Ok(None) => return Err(again("your sign-in is missing from the OS keychain".into())),
            Err(e) => {
                return Err(again(format!(
                    "could not read your sign-in from the OS keychain ({e})"
                )));
            }
        };
        match chosen.sign_in {
            SignIn::ApiKey { .. } => Value::String(text),
            SignIn::Session { .. } => serde_json::from_str(&text)
                .map_err(|_| again("the key in your OS keychain is unreadable".into()))?,
        }
    } else {
        chosen.secret.clone()
    };
    chosen.login(secret)
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
        let _ = store.delete(&chosen.account());
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

    fn key(login: &Login) -> &str {
        match &login.auth {
            Auth::ApiKey(key) => key,
            Auth::Session(_) => panic!("a session, not an API key"),
        }
    }

    fn session(url: &str) -> Credential {
        Credential {
            registry: url.into(),
            client_key: "hvc_hpy".into(),
            did: "did:plc:me".into(),
            handle: Some("me.test".into()),
            pds: "https://pds.test".into(),
            scopes: "atproto".into(),
            access_token: "token".into(),
            dpop_key: DpopKey::generate(),
        }
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
            save_key(&s, "https://api.example.com/", KEY, &store).unwrap(),
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
        assert_eq!(key(&login), KEY);
        assert_eq!(
            list(&s).unwrap(),
            vec![Info {
                url: "https://api.example.com".into(),
                kind: "apiKey",
                account: "API key hv_01234…".into(),
                storage: "keychain",
            }]
        );
    }

    #[test]
    fn falls_back_to_the_file_without_a_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        assert!(matches!(
            save_key(&s, "https://api.example.com", KEY, &Unavailable).unwrap(),
            Saved::File { reason: Some(_) }
        ));
        assert_eq!(key(&current(&s, &Unavailable, &no_env, None).unwrap()), KEY);
        assert_eq!(list(&s).unwrap()[0].storage, "file");
    }

    #[test]
    fn logging_in_again_replaces_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::File);
        let store = MemoryStore::default();
        save_key(&s, "https://api.example.com", KEY, &store).unwrap();
        save_key(&s, "https://api.example.com/", OTHER, &store).unwrap();
        assert_eq!(list(&s).unwrap().len(), 1);
        assert_eq!(key(&current(&s, &store, &no_env, None).unwrap()), OTHER);
    }

    #[test]
    fn several_instances_need_a_url_to_choose() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        save_key(&s, "https://a.example.com", KEY, &store).unwrap();
        save_key(&s, "https://b.example.com", OTHER, &store).unwrap();
        let err = current(&s, &store, &no_env, None).unwrap_err().to_string();
        assert!(err.contains("--url"), "{err}");
        assert!(err.contains("https://a.example.com"), "{err}");
        let login = current(&s, &store, &no_env, Some("https://b.example.com/")).unwrap();
        assert_eq!(key(&login), OTHER);
        let err = current(&s, &store, &no_env, Some("https://c.example.com")).unwrap_err();
        assert!(err.is_auth());
        assert!(
            err.to_string()
                .contains("hpy hv login --url https://c.example.com")
        );
    }

    #[test]
    fn hpy_hv_url_chooses_a_saved_sign_in_too() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        save_key(&s, "https://a.example.com", KEY, &store).unwrap();
        save_key(&s, "https://b.example.com", OTHER, &store).unwrap();
        let env = |k: &str| (k == URL_VAR).then(|| "https://b.example.com/".to_string());
        assert_eq!(key(&current(&s, &store, &env, None).unwrap()), OTHER);
        // --url wins over it.
        let login = current(&s, &store, &env, Some("https://a.example.com")).unwrap();
        assert_eq!(key(&login), KEY);
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
        assert_eq!(key(&login), OTHER);
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
        save_key(&s, "https://a.example.com", KEY, &store).unwrap();
        save_key(&s, "https://b.example.com", OTHER, &store).unwrap();
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
            auth: Auth::ApiKey(KEY.into()),
        };
        assert!(!format!("{login:?}").contains(KEY));
        let c = session("https://api.example.com");
        let login = Login {
            url: "https://api.example.com".into(),
            auth: Auth::Session(c.clone()),
        };
        let shown = format!("{login:?}");
        assert!(!shown.contains("token"), "{shown}");
        assert!(
            !shown.contains(&c.dpop_key.to_jwk()["d"].to_string()),
            "{shown}"
        );
    }

    #[test]
    fn a_session_keeps_its_key_in_the_keychain_and_the_rest_in_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        let c = session("https://api.example.com/");
        assert_eq!(save_session(&s, &c, &store).unwrap(), Saved::Keychain);
        let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!text.contains("\"d\""), "{text}");
        assert!(
            store
                .get("hv-session/api.example.com")
                .unwrap()
                .unwrap()
                .contains("\"d\"")
        );
        let login = current(&s, &store, &no_env, None).unwrap();
        assert_eq!(login.url, "https://api.example.com");
        let Auth::Session(back) = login.auth else {
            panic!("an API key, not a session")
        };
        assert_eq!(back.registry, "https://api.example.com");
        assert_eq!(back.dpop_key.thumbprint(), c.dpop_key.thumbprint());
        assert_eq!(back.access_token, "token");
        assert_eq!(
            list(&s).unwrap(),
            vec![Info {
                url: "https://api.example.com".into(),
                kind: "session",
                account: "@me.test".into(),
                storage: "keychain",
            }]
        );
    }

    #[test]
    fn a_session_falls_back_to_the_file_without_a_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let c = session("https://api.example.com");
        assert!(matches!(
            save_session(&s, &c, &Unavailable).unwrap(),
            Saved::File { reason: Some(_) }
        ));
        let Auth::Session(back) = current(&s, &Unavailable, &no_env, None).unwrap().auth else {
            panic!()
        };
        assert_eq!(back.dpop_key.thumbprint(), c.dpop_key.thumbprint());
    }

    #[test]
    fn signing_in_again_replaces_a_key_with_a_session() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path(), StoreChoice::Auto);
        let store = MemoryStore::default();
        save_key(&s, "https://api.example.com", KEY, &store).unwrap();
        save_session(&s, &session("https://api.example.com"), &store).unwrap();
        assert_eq!(store.get("hv-api-key/api.example.com").unwrap(), None);
        assert_eq!(list(&s).unwrap().len(), 1);
        assert!(matches!(
            current(&s, &store, &no_env, None).unwrap().auth,
            Auth::Session(_)
        ));
        remove(&s, &store, None).unwrap().unwrap();
        assert_eq!(store.get("hv-session/api.example.com").unwrap(), None);
    }

    #[test]
    fn a_grant_manages_the_instance_only_with_the_admin_rpc() {
        assert!(grants_admin("atproto rpc:dev.happyview.admin.manage?aud=*"));
        // A PDS may percent-encode the audience.
        assert!(grants_admin(
            "rpc:dev.happyview.admin.manage?aud=%2A atproto"
        ));
        // Or name several methods in one permission.
        assert!(grants_admin(
            "atproto rpc?lxm=dev.happyview.admin.manage&lxm=com.example.other&aud=*"
        ));
        for no in [
            "atproto",
            "atproto include:dev.happyview.adminFull",
            "atproto rpc:dev.happyview.admin.manage?aud=did:web:other#hv",
            "atproto rpc:dev.happyview.admin.manageX?aud=*",
            "atproto rpc:*?aud=*",
            "atproto rpc?lxm=com.example.other&aud=*",
            "atproto rpc?lxm=dev.happyview.admin.manage&aud=did:web:other%23hv",
        ] {
            assert!(!grants_admin(no), "{no}");
        }
    }

    #[test]
    fn instance_logins_use_the_public_hpy_client() {
        let base = Settings::from_sources(None, &|_| None, "/c".into()).unwrap();
        let s = login_settings(&base, "https://api.example.com", "hvc_hpy");
        assert_eq!(s.registry_url, "https://api.example.com");
        assert_eq!(s.client_key, "hvc_hpy");
        assert_eq!(s.oauth_scope, "atproto include:dev.happyview.adminFull");
        assert_eq!(s.oauth_redirect, Redirect::Loopback);
        assert!(matches!(s.oauth_client_auth, ClientAuth::None));
        assert_eq!(s.config_dir, base.config_dir);
    }
}
