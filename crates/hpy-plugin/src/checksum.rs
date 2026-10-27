//! The CID a PDS gives a blob. Every byte `hpy` publishes or installs is
//! checked against it, so it is computed locally from the bytes rather than
//! trusted from whoever served them.

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

/// A CIDv1 (raw codec, sha2-256) in lowercase base32 multibase, the form a
/// PDS answers a blob upload with.
pub fn raw_cid(bytes: &[u8]) -> String {
    let mut out = vec![CID_V1, RAW_CODEC];
    out.extend(multihash(bytes));
    format!("b{}", BASE32_NOPAD.encode(&out).to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_world_vector() {
        assert_eq!(
            raw_cid(b"hello world"),
            "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e"
        );
    }

    #[test]
    fn wasm_header_vector() {
        assert_eq!(
            raw_cid(b"\0asm\x01\0\0\0"),
            "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy"
        );
    }
}
