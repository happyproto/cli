#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not logged in; run `hpy registry login`")]
    NotLoggedIn,
    #[error("your session has expired or was revoked; run `hpy registry login`")]
    SessionExpired,
    /// Stored credentials that cannot be used; the message says why.
    #[error("{0}")]
    LoginRequired(String),
    #[error("{method} failed: {name}{}", .message.as_ref().map(|m| format!(" — {m}")).unwrap_or_default())]
    Xrpc {
        method: String,
        name: String,
        message: Option<String>,
    },
    /// A refusal from the registry's own procedures (`InvalidRecord`,
    /// `VersionExists`, `ProfileMissing`, …); its message is written for the
    /// publisher.
    #[error("{message}")]
    Registry { name: String, message: String },
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn is_auth(&self) -> bool {
        matches!(
            self,
            Error::NotLoggedIn | Error::SessionExpired | Error::LoginRequired(_)
        )
    }

    /// Errors that are the publisher's to fix, not a failure of the tool.
    pub fn is_usage(&self) -> bool {
        matches!(self, Error::Registry { name, .. } if name == "InvalidRecord" || name == "VersionExists")
    }

    /// The registry's error name, for errors that came from it.
    pub fn registry_name(&self) -> Option<&str> {
        match self {
            Error::Registry { name, .. } => Some(name),
            _ => None,
        }
    }

    pub fn other(e: impl std::fmt::Display) -> Error {
        Error::Other(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
