// hpy-plugin/src/checksum.rs: the CID a PDS gives a blob. Every byte hpy
// publishes or installs is checked against it, so it is computed locally from
// the bytes rather than trusted from whoever served them.
import { createHash } from "node:crypto";

const SHA2_256 = 0x12;
const DIGEST_LEN = 0x20;
const CID_V1 = 0x01;
const RAW_CODEC = 0x55;

export function multihash(bytes: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([SHA2_256, DIGEST_LEN]),
    createHash("sha256").update(bytes).digest(),
  ]);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, without padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A CIDv1 (raw codec, sha2-256) in lowercase base32 multibase, the form a PDS answers a blob upload with. */
export function rawCid(bytes: Uint8Array): string {
  return `b${base32(Buffer.concat([Buffer.from([CID_V1, RAW_CODEC]), multihash(bytes)]))}`;
}
