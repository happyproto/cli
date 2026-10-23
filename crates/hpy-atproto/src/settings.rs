use std::path::PathBuf;

use serde::Deserialize;

use crate::{Error, Result};

pub const DEFAULT_REGISTRY_URL: &str = "https://api.happyproto.at";
/// The `hpy` API client on the default registry's HappyView. Not a secret: a
/// public client's key ships with the client, like an OAuth client id.
pub const DEFAULT_CLIENT_KEY: &str = "hvc_f4b41f1b8ca045b291488098e010f5ea";
pub const DEFAULT_OAUTH_CLIENT_ID: &str = "https://happyproto.at/oauth/hpy/client-metadata.json";
/// The hosted page a confidential (web) client is redirected to; it forwards
/// the browser to `hpy`'s loopback listener, whose port is in `state`.
pub const DEFAULT_OAUTH_RELAY: &str = "https://happyproto.at/oauth/hpy/callback";
/// What a publish needs: a write to each collection the gateway fills in the
/// user's repo, and a blob upload for each artifact kind a release carries —
/// the module, its `manifest.json`, and the project's images. A scope missing
/// one of these cannot be widened later, since a session's scopes are fixed
/// when it is issued, so `scope` checks a grant against this before uploading.
pub const DEFAULT_SCOPE: &str = "atproto repo:software.release.project repo:software.release.manifest repo:software.release.version repo:software.release.channel repo:software.release.status repo:at.happyproto.registry.project repo:site.standard.publication repo:site.standard.document blob:application/wasm blob:application/json blob:image/*";

#[derive(Debug, Clone)]
pub struct Settings {
    pub registry_url: String,
    pub client_key: String,
    pub oauth_client_id: String,
    pub oauth_scope: String,
    pub credential_store: StoreChoice,
    pub oauth_redirect: Redirect,
    pub oauth_client_auth: ClientAuth,
    pub config_dir: PathBuf,
}

/// Where the PDS sends the browser after sign-in. A confidential client must
/// use an `https` page (the relay); a public native client may use loopback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Redirect {
    Relay(String),
    Loopback,
}

impl std::str::FromStr for Redirect {
    type Err = Error;
    fn from_str(s: &str) -> Result<Redirect> {
        if s == "loopback" {
            Ok(Redirect::Loopback)
        } else if s.starts_with("https://") {
            Ok(Redirect::Relay(s.into()))
        } else {
            Err(Error::Other(format!(
                "OAuth redirect `{s}` must be `loopback` or an https:// URL"
            )))
        }
    }
}

/// How `hpy` authenticates to the PDS's token endpoint: with a client
/// assertion HappyView signs (confidential), or not at all (public).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ClientAuth {
    #[default]
    Assertion,
    None,
}

impl std::str::FromStr for ClientAuth {
    type Err = Error;
    fn from_str(s: &str) -> Result<ClientAuth> {
        match s {
            "assertion" => Ok(ClientAuth::Assertion),
            "none" => Ok(ClientAuth::None),
            other => Err(Error::Other(format!(
                "OAuth client auth `{other}` is not one of assertion, none"
            ))),
        }
    }
}

/// Where the DPoP key is kept: `auto` tries the OS keychain and falls back to
/// the credentials file; the others insist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StoreChoice {
    #[default]
    Auto,
    Keychain,
    File,
}

impl std::str::FromStr for StoreChoice {
    type Err = Error;
    fn from_str(s: &str) -> Result<StoreChoice> {
        match s {
            "auto" => Ok(StoreChoice::Auto),
            "keychain" => Ok(StoreChoice::Keychain),
            "file" => Ok(StoreChoice::File),
            other => Err(Error::Other(format!(
                "credential store `{other}` is not one of auto, keychain, file"
            ))),
        }
    }
}

#[derive(Deserialize, Default)]
struct File {
    #[serde(default)]
    registry: RegistrySection,
    #[serde(default)]
    oauth: OAuthSection,
    #[serde(default)]
    credentials: CredentialsSection,
}

#[derive(Deserialize, Default)]
struct CredentialsSection {
    store: Option<String>,
}

#[derive(Deserialize, Default)]
struct RegistrySection {
    url: Option<String>,
    client_key: Option<String>,
}

#[derive(Deserialize, Default)]
struct OAuthSection {
    client_id: Option<String>,
    scope: Option<String>,
    redirect: Option<String>,
    client_auth: Option<String>,
}

/// `$XDG_CONFIG_HOME/hpy` or `~/.config/hpy` on every Unix, `%APPDATA%\hpy`
/// on Windows.
pub fn config_dir() -> Result<PathBuf> {
    use etcetera::BaseStrategy;
    let strategy = etcetera::choose_base_strategy().map_err(Error::other)?;
    Ok(strategy.config_dir().join("hpy"))
}

impl Settings {
    pub fn load() -> Result<Settings> {
        let dir = config_dir()?;
        let file = std::fs::read_to_string(dir.join("config.toml")).ok();
        Settings::from_sources(
            file.as_deref(),
            &|k| std::env::var(k).ok().filter(|v| !v.is_empty()),
            dir,
        )
    }

    pub fn from_sources(
        file: Option<&str>,
        env: &dyn Fn(&str) -> Option<String>,
        config_dir: PathBuf,
    ) -> Result<Settings> {
        let file: File = match file {
            Some(text) => toml::from_str(text)
                .map_err(|e| Error::Other(format!("config.toml is not valid: {e}")))?,
            None => File::default(),
        };
        Ok(Settings {
            registry_url: env("HPY_REGISTRY_URL")
                .or(file.registry.url)
                .unwrap_or_else(|| DEFAULT_REGISTRY_URL.into())
                .trim_end_matches('/')
                .to_string(),
            client_key: env("HPY_CLIENT_KEY")
                .or(file.registry.client_key)
                .unwrap_or_else(|| DEFAULT_CLIENT_KEY.into()),
            oauth_client_id: env("HPY_OAUTH_CLIENT_ID")
                .or(file.oauth.client_id)
                .unwrap_or_else(|| DEFAULT_OAUTH_CLIENT_ID.into()),
            oauth_scope: env("HPY_OAUTH_SCOPE")
                .or(file.oauth.scope)
                .unwrap_or_else(|| DEFAULT_SCOPE.into()),
            oauth_redirect: match env("HPY_OAUTH_REDIRECT").or(file.oauth.redirect) {
                Some(r) => r.parse()?,
                None => Redirect::Relay(DEFAULT_OAUTH_RELAY.into()),
            },
            oauth_client_auth: match env("HPY_OAUTH_CLIENT_AUTH").or(file.oauth.client_auth) {
                Some(a) => a.parse()?,
                None => ClientAuth::Assertion,
            },
            credential_store: match env("HPY_CREDENTIAL_STORE").or(file.credentials.store) {
                Some(choice) => choice.parse()?,
                None => StoreChoice::Auto,
            },
            config_dir,
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.toml")
    }

    pub fn credentials_file(&self) -> PathBuf {
        self.config_dir.join("credentials.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn defaults() {
        let s = Settings::from_sources(None, &env(&[]), "/c".into()).unwrap();
        assert_eq!(s.registry_url, DEFAULT_REGISTRY_URL);
        assert_eq!(s.oauth_client_id, DEFAULT_OAUTH_CLIENT_ID);
        assert_eq!(s.client_key, DEFAULT_CLIENT_KEY);
        assert_eq!(s.credential_store, StoreChoice::Auto);
        assert_eq!(s.oauth_scope, DEFAULT_SCOPE);
        assert_eq!(
            DEFAULT_SCOPE,
            "atproto repo:software.release.project repo:software.release.manifest repo:software.release.version repo:software.release.channel repo:software.release.status repo:at.happyproto.registry.project repo:site.standard.publication repo:site.standard.document blob:application/wasm blob:application/json blob:image/*"
        );
        assert_eq!(s.credentials_file(), PathBuf::from("/c/credentials.json"));
    }

    #[test]
    fn env_beats_file() {
        let file =
            "[registry]\nurl = \"https://file\"\n[oauth]\nclient_id = \"https://file/c.json\"\n";
        let s = Settings::from_sources(
            Some(file),
            &env(&[("HPY_REGISTRY_URL", "https://env")]),
            "/c".into(),
        )
        .unwrap();
        assert_eq!(s.registry_url, "https://env");
        assert_eq!(s.oauth_client_id, "https://file/c.json");
    }

    #[test]
    fn bad_file_is_an_error() {
        assert!(Settings::from_sources(Some("[registry"), &env(&[]), "/c".into()).is_err());
    }

    #[test]
    fn credential_store_choice() {
        let s =
            Settings::from_sources(None, &env(&[("HPY_CREDENTIAL_STORE", "file")]), "/c".into())
                .unwrap();
        assert_eq!(s.credential_store, StoreChoice::File);
        let s = Settings::from_sources(
            Some("[credentials]\nstore = \"keychain\"\n"),
            &env(&[]),
            "/c".into(),
        )
        .unwrap();
        assert_eq!(s.credential_store, StoreChoice::Keychain);
        assert!(
            Settings::from_sources(
                None,
                &env(&[("HPY_CREDENTIAL_STORE", "vault")]),
                "/c".into()
            )
            .is_err()
        );
    }

    #[test]
    fn oauth_modes() {
        let s = Settings::from_sources(None, &env(&[]), "/c".into()).unwrap();
        assert_eq!(
            s.oauth_redirect,
            Redirect::Relay(DEFAULT_OAUTH_RELAY.into())
        );
        assert_eq!(s.oauth_client_auth, ClientAuth::Assertion);
        let s = Settings::from_sources(
            None,
            &env(&[
                ("HPY_OAUTH_REDIRECT", "loopback"),
                ("HPY_OAUTH_CLIENT_AUTH", "none"),
            ]),
            "/c".into(),
        )
        .unwrap();
        assert_eq!(
            (s.oauth_redirect, s.oauth_client_auth),
            (Redirect::Loopback, ClientAuth::None)
        );
        assert!(
            Settings::from_sources(
                None,
                &env(&[("HPY_OAUTH_REDIRECT", "http://evil")]),
                "/c".into()
            )
            .is_err()
        );
        assert!(
            Settings::from_sources(
                None,
                &env(&[("HPY_OAUTH_CLIENT_AUTH", "secret")]),
                "/c".into()
            )
            .is_err()
        );
    }
}
