//! The registry's checksum format: a lowercase base32 multibase (`b…`)
//! sha2-256 multihash. A PDS answers a blob upload with a CIDv1 over the same
//! multihash, so the two compare by digest.

use data_encoding::BASE32_NOPAD;
use sha2::{Digest, Sha256};

const SHA2_256: u8 = 0x12;
const DIGEST_LEN: u8 = 0x20;
const CID_V1: u8 = 0x01;
const RAW_CODEC: u8 = 0x55;

pub fn multihash(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![SHA2_256, DIGEST_LEN];
    out.extend_from_slice(&Sha256::digest(bytes));
    out
}

fn multibase(bytes: &[u8]) -> String {
    format!("b{}", BASE32_NOPAD.encode(bytes).to_ascii_lowercase())
}

/// The `checksum` field of an artifact.
pub fn checksum(bytes: &[u8]) -> String {
    multibase(&multihash(bytes))
}

/// The CID a PDS assigns a blob with these bytes.
pub fn raw_cid(bytes: &[u8]) -> String {
    let mut out = vec![CID_V1, RAW_CODEC];
    out.extend(multihash(bytes));
    multibase(&out)
}

fn read_varint(bytes: &[u8]) -> Option<(u64, &[u8])> {
    let mut value = 0u64;
    for (i, byte) in bytes.iter().enumerate().take(9) {
        value |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Some((value, &bytes[i + 1..]));
        }
    }
    None
}

/// The sha2-256 digest inside a multibase-`b` multihash or CIDv1, or `None`
/// for anything else (another hash function, another base, malformed).
pub fn sha256_digest(multibase: &str) -> Option<[u8; 32]> {
    let encoded = multibase.strip_prefix('b')?;
    let bytes = BASE32_NOPAD
        .decode(encoded.to_ascii_uppercase().as_bytes())
        .ok()?;
    let mh: &[u8] = if bytes.first() == Some(&SHA2_256) {
        &bytes
    } else {
        let (version, rest) = read_varint(&bytes)?;
        if version != 1 {
            return None;
        }
        let (_codec, rest) = read_varint(rest)?;
        rest
    };
    match mh {
        [SHA2_256, DIGEST_LEN, digest @ ..] if digest.len() == 32 => digest.try_into().ok(),
        _ => None,
    }
}

/// Whether two multibase strings (checksum or CID) name the same sha2-256
/// digest. False when either cannot be read.
pub fn same_digest(a: &str, b: &str) -> bool {
    matches!((sha256_digest(a), sha256_digest(b)), (Some(x), Some(y)) if x == y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_world_vectors() {
        assert_eq!(
            checksum(b"hello world"),
            "bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i"
        );
        assert_eq!(
            raw_cid(b"hello world"),
            "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e"
        );
    }

    #[test]
    fn wasm_header_vectors() {
        let bytes = b"\0asm\x01\0\0\0";
        assert_eq!(
            checksum(bytes),
            "bciqjhjclxolmoujbrzgabvdz4taugwasfi4jvtfbmic3dzgq3rpzi5q"
        );
        assert_eq!(
            raw_cid(bytes),
            "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy"
        );
    }

    #[test]
    fn digest_compare_across_forms() {
        let sum = checksum(b"hello world");
        let cid = raw_cid(b"hello world");
        assert!(same_digest(&sum, &cid));
        assert!(!same_digest(&sum, &raw_cid(b"goodbye")));
        // a dag-cbor (0x71) CID of the same multihash still compares by digest
        let mut bytes = vec![0x01, 0x71];
        bytes.extend(multihash(b"hello world"));
        let cbor = format!(
            "b{}",
            data_encoding::BASE32_NOPAD
                .encode(&bytes)
                .to_ascii_lowercase()
        );
        assert!(same_digest(&sum, &cbor));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(sha256_digest("zQm…"), None);
        assert_eq!(sha256_digest("b!!!"), None);
        assert_eq!(sha256_digest("b"), None);
        assert!(!same_digest("b", "b"));
    }
}
