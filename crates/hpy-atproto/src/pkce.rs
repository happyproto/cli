//! PKCE (RFC 7636), S256 only.

use sha2::{Digest, Sha256};

use crate::dpop::{b64url, random_token};

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Pkce {
        // 32 random bytes → a 43-character verifier, the RFC's minimum length.
        let verifier = random_token(32);
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        Pkce {
            verifier,
            challenge,
        }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Pkce::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn challenge_is_s256_of_verifier() {
        let p = Pkce::new();
        assert_eq!(p.verifier.len(), 43);
        assert_eq!(
            p.challenge,
            crate::dpop::b64url(&sha2::Sha256::digest(p.verifier.as_bytes()))
        );
        assert_ne!(Pkce::new().verifier, p.verifier);
    }
}
