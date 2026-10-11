//! DPoP (RFC 9449): the P-256 key HappyView provisions, and the proofs signed
//! with it for every request to the PDS's authorization server and to
//! HappyView.

use base64::Engine;
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rand_core::{OsRng, RngCore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `bytes` of randomness, base64url-encoded.
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    b64url(&buf)
}

/// The `htu` claim: scheme, authority and path exactly as sent, without the
/// query or fragment (RFC 9449 §4.2). Percent-encoding is kept, because the
/// server compares against the URL as it received it.
pub fn htu(url: &str) -> String {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    url[..end].to_string()
}

#[derive(Clone)]
pub struct DpopKey(p256::SecretKey);

impl std::fmt::Debug for DpopKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the private key.
        write!(f, "DpopKey({})", self.thumbprint())
    }
}

impl PartialEq for DpopKey {
    fn eq(&self, other: &Self) -> bool {
        self.thumbprint() == other.thumbprint()
    }
}

impl DpopKey {
    pub fn generate() -> DpopKey {
        DpopKey(p256::SecretKey::random(&mut OsRng))
    }

    pub fn from_jwk(jwk: &Value) -> Result<DpopKey> {
        p256::SecretKey::from_jwk_str(&jwk.to_string())
            .map(DpopKey)
            .map_err(|_| Error::Other("the DPoP key is not a P-256 private JWK".into()))
    }

    /// The private JWK, `d` included.
    pub fn to_jwk(&self) -> Value {
        serde_json::from_str(&self.0.to_jwk_string()).expect("p256 emits valid JSON")
    }

    /// The public JWK: exactly `kty`, `crv`, `x`, `y`.
    pub fn public_jwk(&self) -> Value {
        let point = self.0.public_key().to_encoded_point(false);
        json!({
            "kty": "EC",
            "crv": "P-256",
            "x": b64url(point.x().expect("uncompressed point")),
            "y": b64url(point.y().expect("uncompressed point")),
        })
    }

    /// RFC 7638 thumbprint: SHA-256 of the required members in lexical order.
    pub fn thumbprint(&self) -> String {
        let jwk = self.public_jwk();
        let canonical = format!(
            r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
            jwk["x"].as_str().unwrap_or_default(),
            jwk["y"].as_str().unwrap_or_default()
        );
        b64url(&Sha256::digest(canonical.as_bytes()))
    }

    /// A DPoP proof for one request. `access_token` adds `ath`; `nonce` is the
    /// server's last `DPoP-Nonce`, when it asked for one.
    pub fn proof(
        &self,
        method: &str,
        url: &str,
        access_token: Option<&str>,
        nonce: Option<&str>,
    ) -> String {
        let header = json!({ "typ": "dpop+jwt", "alg": "ES256", "jwk": self.public_jwk() });
        let iat = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut claims = json!({
            "jti": random_token(16),
            "htm": method.to_ascii_uppercase(),
            "htu": htu(url),
            "iat": iat,
        });
        if let Some(token) = access_token {
            claims["ath"] = b64url(&Sha256::digest(token.as_bytes())).into();
        }
        if let Some(nonce) = nonce {
            claims["nonce"] = nonce.into();
        }
        sign_jwt(&self.0, &header, &claims)
    }
}

fn sign_jwt(key: &p256::SecretKey, header: &Value, claims: &Value) -> String {
    let input = format!(
        "{}.{}",
        b64url(header.to_string().as_bytes()),
        b64url(claims.to_string().as_bytes())
    );
    let signature: Signature = SigningKey::from(key).sign(input.as_bytes());
    format!("{input}.{}", b64url(&signature.to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use sha2::Digest;

    /// Splits a compact JWT, checks its ES256 signature against the key in its
    /// own header, and answers the decoded header and claims.
    fn verify(jwt: &str) -> (serde_json::Value, serde_json::Value) {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value =
            serde_json::from_slice(&b64.decode(parts[0]).unwrap()).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&b64.decode(parts[1]).unwrap()).unwrap();
        let public = p256::PublicKey::from_jwk_str(&header["jwk"].to_string()).unwrap();
        let sig = p256::ecdsa::Signature::from_slice(&b64.decode(parts[2]).unwrap()).unwrap();
        p256::ecdsa::VerifyingKey::from(public)
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .expect("signature verifies");
        (header, claims)
    }

    #[test]
    fn proof_verifies_and_carries_the_claims() {
        let key = DpopKey::generate();
        let jwt = key.proof(
            "post",
            "https://hv.example/xrpc/x.y?q=1#f",
            Some("tok"),
            Some("n1"),
        );
        let (header, claims) = verify(&jwt);
        assert_eq!(header["typ"], "dpop+jwt");
        assert_eq!(header["alg"], "ES256");
        assert!(header["jwk"].get("d").is_none());
        assert_eq!(header["jwk"], key.public_jwk());
        assert_eq!(claims["htm"], "POST");
        assert_eq!(claims["htu"], "https://hv.example/xrpc/x.y");
        assert_eq!(claims["ath"], b64url(&sha2::Sha256::digest(b"tok")));
        assert_eq!(claims["nonce"], "n1");
        assert!(claims["jti"].as_str().unwrap().len() >= 16);
        assert!(claims["iat"].as_i64().unwrap() > 1_700_000_000);
    }

    #[test]
    fn proof_without_token_or_nonce_omits_them() {
        let key = DpopKey::generate();
        let (_, claims) = verify(&key.proof("GET", "https://x.example/a", None, None));
        assert!(claims.get("ath").is_none());
        assert!(claims.get("nonce").is_none());
    }

    #[test]
    fn jwk_round_trip_and_rfc7638_thumbprint() {
        // RFC 7517 appendix A.2's P-256 key; thumbprint computed independently.
        let jwk = serde_json::json!({"kty":"EC","crv":"P-256",
            "x":"MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
            "y":"4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM",
            "d":"870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE"});
        let key = DpopKey::from_jwk(&jwk).unwrap();
        assert_eq!(key.to_jwk(), jwk);
        assert_eq!(
            key.thumbprint(),
            "cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn-s"
        );
        assert!(DpopKey::from_jwk(&serde_json::json!({"kty":"EC"})).is_err());
    }

    #[test]
    fn htu_keeps_percent_encoding_and_port() {
        assert_eq!(
            htu("http://127.0.0.1:3000/oauth/sessions/did%3Aplc%3Aabc?x=1"),
            "http://127.0.0.1:3000/oauth/sessions/did%3Aplc%3Aabc"
        );
        assert_eq!(
            htu("https://api.happyproto.at/xrpc/a.b#frag"),
            "https://api.happyproto.at/xrpc/a.b"
        );
    }
}
