//! The sandbox user who is the local instance's superadmin. A developer's real
//! DID cannot sign in to a sandbox PDS, so the first seeded user stands in.

use std::path::Path;

use serde_json::Value;

use crate::failure::Failure;

pub const SUPERADMIN_HANDLE: &str = "user1.pds1.atmosbox.test";

pub struct SeededAccount {
    pub handle: String,
    pub did: String,
    pub password: String,
}

// Hand-written so the password cannot reach a log through `{:?}`.
impl std::fmt::Debug for SeededAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SeededAccount")
            .field("handle", &self.handle)
            .field("did", &self.did)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// `None` until `seed` has created the account and recorded its DID.
pub fn seeded_superadmin(checkout: &Path) -> Result<Option<SeededAccount>, Failure> {
    let path = checkout.join("state/accounts.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Failure::runtime(format!("state/accounts.json: {e}"))),
    };
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| Failure::runtime(format!("state/accounts.json is not readable: {e}")))?;
    let entry = &v["accounts"][SUPERADMIN_HANDLE];
    // An account that is still being created may already carry a DID.
    if entry["phase"].as_str() != Some("ready") {
        return Ok(None);
    }
    match (entry["did"].as_str(), entry["password"].as_str()) {
        (Some(did), Some(password)) => Ok(Some(SeededAccount {
            handle: SUPERADMIN_HANDLE.into(),
            did: did.into(),
            password: password.into(),
        })),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(checkout: &Path, body: &str) {
        std::fs::create_dir_all(checkout.join("state")).unwrap();
        std::fs::write(checkout.join("state/accounts.json"), body).unwrap();
    }

    #[test]
    fn reads_the_ready_seeded_user() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            r#"{"version":1,"accounts":{"user1.pds1.atmosbox.test":
            {"handle":"user1.pds1.atmosbox.test","email":"u@x.test","pds":"pds1",
             "password":"pw","phase":"ready","did":"did:plc:user1"}}}"#,
        );
        let a = seeded_superadmin(dir.path()).unwrap().unwrap();
        assert_eq!(
            (a.did.as_str(), a.password.as_str()),
            ("did:plc:user1", "pw")
        );
    }

    #[test]
    fn nothing_before_seed_finishes() {
        let dir = tempfile::tempdir().unwrap();
        assert!(seeded_superadmin(dir.path()).unwrap().is_none());
        write(
            dir.path(),
            r#"{"version":1,"accounts":{"user1.pds1.atmosbox.test":
            {"handle":"user1.pds1.atmosbox.test","password":"pw","phase":"prepared"}}}"#,
        );
        assert!(seeded_superadmin(dir.path()).unwrap().is_none());
        write(
            dir.path(),
            r#"{"version":1,"accounts":{"user1.pds1.atmosbox.test":
            {"handle":"user1.pds1.atmosbox.test","password":"pw","phase":"attempted","did":"did:plc:user1"}}}"#,
        );
        assert!(seeded_superadmin(dir.path()).unwrap().is_none());
    }

    #[test]
    fn an_unreadable_file_says_so() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "{not json");
        assert!(
            format!("{:?}", seeded_superadmin(dir.path()).unwrap_err().report)
                .contains("state/accounts.json")
        );
    }
}
