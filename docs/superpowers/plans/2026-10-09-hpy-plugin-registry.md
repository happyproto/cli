# `hpy` Plugin Registry (Milestone 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `hpy`, a Rust CLI whose first slice lets a plugin author log in to their atproto PDS, manage an `at.happyproto.plugin.profile` record, and publish/inspect/withdraw `at.happyproto.plugin.release` records that the HappyProto registry will accept.

**Architecture:** A Cargo workspace of three crates. `hpy-plugin` is pure (files in → validated records and `Problem`s out). `hpy-atproto` owns sessions (jacquard OAuth + app password), a `Repo` trait over `com.atproto.repo.*`, and a `Registry` trait over the registry's XRPC queries. `hpy` is the clap binary: prompts, output, and command orchestration written against the traits so it is testable with in-memory fakes.

**Tech Stack:** Rust 2024 edition (rustc ≥ 1.93), clap 4, inquire 0.9, jacquard 0.12.2 (OAuth/DPoP/XRPC), reqwest 0.13 (registry), serde/serde_json, toml 1 + toml_edit 0.25, semver 1, sha2 0.11, data-encoding 2, imagesize 0.15, unicode-segmentation 1, miette 7, thiserror 2, tokio 1, async-trait; tests: tempfile, assert_cmd, predicates, wiremock; release: dist.

**Spec:** `docs/superpowers/specs/2026-10-09-hpy-plugin-registry-design.md`

## Global Constraints

- Binary name `hpy`; package name of the binary crate `hpy-cli`.
- Collections: `at.happyproto.plugin.profile` (rkey = slug), `at.happyproto.plugin.release` (rkey = `<slug>:<version>`); manifest NSID `at.happyproto.plugin.releaseExtension`.
- Profile `type` is the const `"happyview-plugin"`.
- Slug: 1–128 chars, `^[A-Za-z][A-Za-z0-9.-]*$`.
- Version: semver 2.0, no `+` build metadata, no leading `v`.
- `requires` keys: `env:<[A-Za-z0-9.-]+>` or `at://<did>/at.happyproto.plugin.profile/<slug>`; values Cargo `VersionReq`, `||` refused by name.
- Checksum: `b` + lowercase base32 (no padding) of `0x12 0x20 <sha256>`.
- WASM: magic `\0asm`, ≤ 16 MiB (16777216), mime `application/wasm`. Images: png/jpeg/webp/gif/avif only, ≤ 1 MiB (1048576), ≤ 8 screenshots.
- Default registry `https://api.happyproto.at`; env `HPY_REGISTRY_URL`, `HPY_OAUTH_CLIENT_ID`, `HPY_OAUTH_SCOPE`, `HPY_IDENTIFIER` + `HPY_APP_PASSWORD`.
- Default OAuth scope: `atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*`.
- Config dir: `$XDG_CONFIG_HOME/hpy` or `~/.config/hpy` (all Unix incl. macOS), `%APPDATA%\hpy` on Windows. Files: `config.toml`, `session.toml`, `credentials.json` (0600).
- Exit codes: 0 ok, 1 runtime/remote, 2 usage/validation, 3 not logged in.
- `--json` prints exactly one JSON document to stdout; everything else goes to stderr.
- Never prompt without a TTY; a missing value names its flag.
- Do not run git commands (user's global instruction) — the "Commit" steps in this plan are performed only if the user asks; otherwise skip them.

## Review Focus

1. **Plugin in a Cargo workspace whose shared `target/` has more than one wasm target** (e.g. `wasm32-unknown-unknown` and `wasm32-wasip1`) — expect an error listing every candidate and suggesting `--wasm`, never a silent pick. Pinned in Task 5.
2. **`manifest.json` version written by a release tool with build metadata or a `v` prefix** (`1.2.0+abc`, `v1.2.0`) — expect publish to stop before any upload with a message saying why `+`/`v` is illegal. Pinned in Task 1 and Task 10.
3. **CI run with no TTY and an incomplete `hpy.toml`** — expect `profile init`/`publish` to exit 2 naming the missing flag/field, never hang on a prompt. Pinned in Task 9.
4. **Expired or revoked session** — expect exit 3 and "run `hpy login`", not a raw XRPC dump. Pinned in Task 6 (error mapping) and Task 8 (exit code).
5. **Publish interrupted after the blob upload but before `createRecord`** — expect a re-run to succeed (orphan blob is harmless, record absent ⇒ not "already published"). Pinned in Task 10.

---

## File Structure

```
Cargo.toml                         workspace + shared deps + dist config
rust-toolchain.toml                pins stable
crates/hpy-plugin/
  Cargo.toml
  src/lib.rs                       re-exports, NSID constants
  src/problem.rs                   Problem type
  src/validate.rs                  slug/version/range/requires/did/grapheme rules
  src/checksum.rs                  multihash, checksum string, raw CID, digest compare
  src/manifest.rs                  manifest.json + ReleaseExtension
  src/profile.rs                   Profile record type, validation, author/contact parsing
  src/config.rs                    hpy.toml model, load, write [profile] with toml_edit
  src/artifact.rs                  wasm + image inspection
  src/release.rs                   Release record builder, requires validation
  src/locate.rs                    find the .wasm (explicit/config/manifest/cargo)
crates/hpy-atproto/
  Cargo.toml
  src/lib.rs
  src/error.rs                     Error enum + jacquard mapping
  src/settings.rs                  config dir, config.toml + env
  src/repo.rs                      Repo trait, StoredRecord, WriteResult
  src/registry.rs                  Registry trait, views, HttpRegistry
  src/session.rs                   SessionPointer, login (OAuth/app pw), restore, logout
  src/jacquard_repo.rs             Repo impl over a jacquard Agent
crates/hpy/
  Cargo.toml                       package hpy-cli, bin hpy
  src/main.rs                      entry, exit codes
  src/cli.rs                       clap tree
  src/failure.rs                   Failure (exit code + report)
  src/prompt.rs                    Prompter (flag > prompt > default > error)
  src/output.rs                    Output (json vs human)
  src/ctx.rs                       Ctx: settings, prompter, output, dir, session()
  src/commands/mod.rs
  src/commands/auth.rs             login/logout/whoami
  src/commands/profile.rs          init/show/edit/pull
  src/commands/publish.rs          prepare/execute + CLI
  src/commands/status.rs           status
  src/commands/withdraw.rs         withdraw
  src/testing.rs                   FakeRepo/FakeRegistry (cfg(test))
  tests/cli.rs                     assert_cmd tests
docs/oauth-client-metadata.json    document to host for production OAuth
.github/workflows/ci.yml           fmt, clippy, test
README.md
```

---

### Task 1: Workspace scaffold and validation rules

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `.gitignore`
- Create: `crates/hpy-plugin/Cargo.toml`, `crates/hpy-plugin/src/lib.rs`, `crates/hpy-plugin/src/problem.rs`, `crates/hpy-plugin/src/validate.rs`

**Interfaces:**
- Produces: `hpy_plugin::Problem { path: String, message: String }`, `Problem::new(path, message)`, `Display` as `"{path}: {message}"`.
- Produces: `hpy_plugin::validate::{is_slug(&str) -> bool, version_problem(&str) -> Option<String>, range_problem(&str) -> Option<String>, requires_key_problem(&str) -> Option<String>, is_did(&str) -> bool, graphemes(&str) -> usize}`.
- Produces: constants `PROFILE_NSID`, `RELEASE_NSID`, `EXTENSION_NSID`, `PLUGIN_KIND = "happyview-plugin"`.

- [ ] **Step 1: Workspace files**

`Cargo.toml`:
```toml
[workspace]
resolver = "3"
members = ["crates/*"]

[workspace.package]
version = "0.1.0"
edition = "2024"
license = "MIT"
repository = "https://github.com/happyproto/cli"
rust-version = "1.93"

[workspace.dependencies]
hpy-plugin = { path = "crates/hpy-plugin" }
hpy-atproto = { path = "crates/hpy-atproto" }
async-trait = "0.1.92"
clap = { version = "4.6", features = ["derive", "env", "wrap_help"] }
data-encoding = "2.11"
etcetera = "0.11"
imagesize = "0.15"
inquire = "0.9"
jacquard = { version = "=0.12.2", default-features = false, features = ["api", "dns", "loopback"] }
miette = { version = "7.6", features = ["fancy"] }
reqwest = { version = "0.13", default-features = false, features = ["json", "rustls"] }
semver = "1.0"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.11"
thiserror = "2"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "process", "time"] }
toml = "1"
toml_edit = { version = "0.25", features = ["serde"] }
unicode-segmentation = "1.13"
bytes = "1"
tempfile = "3"
assert_cmd = "2"
predicates = "3"
wiremock = "0.6"
```

`rust-toolchain.toml`:
```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

`.gitignore`:
```
/target
```

`crates/hpy-plugin/Cargo.toml`:
```toml
[package]
name = "hpy-plugin"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = false

[dependencies]
data-encoding.workspace = true
imagesize.workspace = true
semver.workspace = true
serde.workspace = true
serde_json.workspace = true
sha2.workspace = true
toml.workspace = true
toml_edit.workspace = true
unicode-segmentation.workspace = true

[dev-dependencies]
tempfile.workspace = true
```

`crates/hpy-plugin/src/lib.rs`:
```rust
//! Everything about a HappyView plugin that needs no network: reading the
//! files in a plugin directory, validating them against the rules the
//! registry enforces, and building the records to publish.

pub mod problem;
pub mod validate;

pub use problem::Problem;

pub const PROFILE_NSID: &str = "at.happyproto.plugin.profile";
pub const RELEASE_NSID: &str = "at.happyproto.plugin.release";
pub const EXTENSION_NSID: &str = "at.happyproto.plugin.releaseExtension";
pub const PLUGIN_KIND: &str = "happyview-plugin";
```

`crates/hpy-plugin/src/problem.rs`:
```rust
use std::fmt;

/// One thing wrong with a plugin's inputs, located by a field path such as
/// `release.requires["env:happyview"]`. Validation collects these rather than
/// stopping at the first, so an author fixes everything in one pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub path: String,
    pub message: String,
}

impl Problem {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { path: path.into(), message: message.into() }
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}
```

- [ ] **Step 2: Write the failing tests** (bottom of `crates/hpy-plugin/src/validate.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert!(is_slug("happyview-atproto"));
        assert!(is_slug("a"));
        assert!(is_slug("My.Plugin-2"));
        assert!(!is_slug(""));
        assert!(!is_slug("2fast"));
        assert!(!is_slug("has:colon"));
        assert!(!is_slug("under_score"));
        assert!(!is_slug(&"a".repeat(129)));
    }

    #[test]
    fn versions() {
        assert_eq!(version_problem("1.2.3"), None);
        assert_eq!(version_problem("1.2.3-rc.1"), None);
        assert!(version_problem("1.2.3+build").unwrap().contains("build metadata"));
        assert!(version_problem("v1.2.3").unwrap().contains("`v`"));
        assert!(version_problem("1.2").is_some());
        assert!(version_problem("01.2.3").is_some());
    }

    #[test]
    fn ranges() {
        assert_eq!(range_problem(">=3.0.0"), None);
        assert_eq!(range_problem("^0.1"), None);
        assert_eq!(range_problem(">=1.0, <2.0"), None);
        assert_eq!(range_problem("*"), None);
        assert!(range_problem("^1 || ^2").unwrap().contains("||"));
        assert!(range_problem("").is_some());
        assert!(range_problem("latest").is_some());
    }

    #[test]
    fn requires_keys() {
        assert_eq!(requires_key_problem("env:happyview"), None);
        assert_eq!(
            requires_key_problem("at://did:plc:abc123/at.happyproto.plugin.profile/happyview-http"),
            None
        );
        assert!(requires_key_problem("env:").is_some());
        assert!(requires_key_problem("happyview-http").is_some());
        assert!(requires_key_problem("at://did:plc:abc/app.bsky.feed.post/x").is_some());
        assert!(requires_key_problem("at://notadid/at.happyproto.plugin.profile/x").is_some());
    }

    #[test]
    fn dids() {
        assert!(is_did("did:plc:4jrld6fwpnwqehtce56qshzv"));
        assert!(is_did("did:web:example.com"));
        assert!(!is_did("did:PLC:abc"));
        assert!(!is_did("did:plc:abc:"));
        assert!(!is_did("plc:abc"));
    }

    #[test]
    fn grapheme_count() {
        assert_eq!(graphemes("abc"), 3);
        assert_eq!(graphemes("👩‍👩‍👧"), 1);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p hpy-plugin`
Expected: compile errors — `is_slug` etc. not defined.

- [ ] **Step 4: Implement** (top of `crates/hpy-plugin/src/validate.rs`)

```rust
//! The registry's input rules, ported from the lexicons repo's Lua prelude
//! (`src/shared/prelude.lua`, blocks `validate` and `plugin`). The registry
//! enforces these by silently refusing to index, so the CLI enforces them
//! loudly first. Where a Rust crate is the real authority (`semver` is what
//! HappyView parses ranges with), it is used instead of a shape check.

use unicode_segmentation::UnicodeSegmentation;

/// A package slug: the profile's record key and the first half of a
/// release's, so it must survive a record key, a URL segment and a split on
/// `:`.
pub fn is_slug(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.starts_with(|c: char| c.is_ascii_alphabetic())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// Why `s` is not a publishable version, or `None` when it is.
pub fn version_problem(s: &str) -> Option<String> {
    if s.starts_with(['v', 'V']) {
        return Some(format!("`{s}` must not start with `v`; use `{}`", &s[1..]));
    }
    if s.contains('+') {
        return Some(format!(
            "`{s}` carries build metadata (`+…`), which cannot appear in a record key; drop it"
        ));
    }
    if s.len() > 256 {
        return Some("is longer than 256 characters".into());
    }
    match semver::Version::parse(s) {
        Ok(_) => None,
        Err(e) => Some(format!("`{s}` is not a semver 2.0 version: {e}")),
    }
}

/// Why `s` is not a version requirement HappyView can resolve, or `None`.
pub fn range_problem(s: &str) -> Option<String> {
    if s.trim().is_empty() {
        return Some("is empty".into());
    }
    if s.contains("||") {
        return Some(
            "uses `||`, which Cargo's semver does not support; give one range with \
             comma-separated bounds, or publish one release per major"
                .into(),
        );
    }
    match semver::VersionReq::parse(s) {
        Ok(_) => None,
        Err(e) => Some(format!("`{s}` is not a semver range: {e}")),
    }
}

/// Why `key` is not a valid `requires` key, or `None`.
pub fn requires_key_problem(key: &str) -> Option<String> {
    if let Some(name) = key.strip_prefix("env:") {
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
            return None;
        }
    }
    if let Some(rest) = key.strip_prefix("at://") {
        if let Some((did, slug)) = rest.split_once("/at.happyproto.plugin.profile/") {
            if is_did(did) && is_slug(slug) {
                return None;
            }
        }
    }
    Some(format!(
        "`{key}` must be `env:<name>` or `at://<did>/at.happyproto.plugin.profile/<slug>`"
    ))
}

/// atproto DID syntax: `did:<lowercase method>:<identifier>`, at most 2048
/// characters, and the identifier never ends in `:` or `%`.
pub fn is_did(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("did:") else { return false };
    let Some((method, id)) = rest.split_once(':') else { return false };
    s.len() <= 2048
        && !method.is_empty()
        && method.chars().all(|c| c.is_ascii_lowercase())
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || "._:%-".contains(c))
        && !id.ends_with([':', '%'])
}

/// User-perceived characters, which is what lexicon `maxGraphemes` counts.
pub fn graphemes(s: &str) -> usize {
    s.graphemes(true).count()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p hpy-plugin`
Expected: 6 passed.

- [ ] **Step 6: Commit** (only if the user has asked for commits)

```bash
git add Cargo.toml rust-toolchain.toml .gitignore crates/hpy-plugin
git commit -m "feat: workspace scaffold and registry validation rules"
```

---

### Task 2: Checksums and CIDs

**Files:**
- Create: `crates/hpy-plugin/src/checksum.rs`
- Modify: `crates/hpy-plugin/src/lib.rs` (add `pub mod checksum;`)

**Interfaces:**
- Produces: `checksum::checksum(&[u8]) -> String` (multibase multihash), `checksum::raw_cid(&[u8]) -> String` (CIDv1 raw codec, what a PDS returns for a blob), `checksum::sha256_digest(&str) -> Option<[u8; 32]>` (from either a multihash or a CIDv1 string), `checksum::same_digest(&str, &str) -> bool`.

- [ ] **Step 1: Write the failing tests** (vectors computed independently with Python `hashlib` + `base64.b32encode`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_world_vectors() {
        assert_eq!(checksum(b"hello world"), "bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i");
        assert_eq!(raw_cid(b"hello world"), "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e");
    }

    #[test]
    fn wasm_header_vectors() {
        let bytes = b"\0asm\x01\0\0\0";
        assert_eq!(checksum(bytes), "bciqjhjclxolmoujbrzgabvdz4taugwasfi4jvtfbmic3dzgq3rpzi5q");
        assert_eq!(raw_cid(bytes), "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy");
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
        let cbor = format!("b{}", data_encoding::BASE32_NOPAD.encode(&bytes).to_ascii_lowercase());
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p hpy-plugin checksum`
Expected: compile error, functions not defined.

- [ ] **Step 3: Implement**

```rust
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
    let bytes = BASE32_NOPAD.decode(encoded.to_ascii_uppercase().as_bytes()).ok()?;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p hpy-plugin checksum`
Expected: 4 passed.

- [ ] **Step 5: Commit** (only if asked)

```bash
git add crates/hpy-plugin && git commit -m "feat(plugin): checksum and CID helpers"
```

---

### Task 3: `manifest.json` and the release extension

**Files:**
- Create: `crates/hpy-plugin/src/manifest.rs`
- Modify: `crates/hpy-plugin/src/lib.rs` (add `pub mod manifest;`)

**Interfaces:**
- Consumes: `Problem`, `validate::version_problem`.
- Produces: `manifest::Manifest` (fields below), `Manifest::load(dir: &Path) -> Result<Manifest, Problem>`, `Manifest::extension_problems(&self) -> Vec<Problem>`, `Manifest::extension(&self) -> ReleaseExtension`, `manifest::ReleaseExtension` (camelCase serde).

- [ ] **Step 1: Failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(json: &str) -> Manifest {
        serde_json::from_str(json).unwrap()
    }

    const ATPROTO: &str = r#"{
      "id": "happyview-atproto", "name": "Atproto", "version": "0.1.0",
      "api_version": "2", "plugin_type": "library", "namespace": "happyview.atproto",
      "description": "AT Protocol helpers.", "capabilities": ["atproto:read", "attest:sign"],
      "allowed_hosts": [], "dependencies": [], "wasm_file": "happyview-atproto.wasm"
    }"#;

    #[test]
    fn maps_to_extension() {
        let m = manifest(ATPROTO);
        assert!(m.extension_problems().is_empty());
        let ext = serde_json::to_value(m.extension()).unwrap();
        assert_eq!(
            ext,
            serde_json::json!({
                "pluginType": "library", "apiVersion": "2", "namespace": "happyview.atproto",
                "capabilities": ["atproto:read", "attest:sign"]
            })
        );
    }

    #[test]
    fn interpreter_needs_language_id() {
        let m = manifest(r#"{"id":"x","api_version":"2","plugin_type":"interpreter","capabilities":[]}"#);
        let problems = m.extension_problems();
        assert!(problems.iter().any(|p| p.path == "manifest.language_id"), "{problems:?}");
    }

    #[test]
    fn rejects_old_api_and_unknown_type_and_missing_capabilities() {
        let m = manifest(r#"{"id":"x","api_version":"1","plugin_type":"theme"}"#);
        let paths: Vec<_> = m.extension_problems().into_iter().map(|p| p.path).collect();
        assert!(paths.contains(&"manifest.api_version".to_string()));
        assert!(paths.contains(&"manifest.plugin_type".to_string()));
        assert!(paths.contains(&"manifest.capabilities".to_string()));
    }

    #[test]
    fn language_id_shape() {
        let m = manifest(r#"{"id":"x","api_version":"2","plugin_type":"interpreter","language_id":"Lua","capabilities":[]}"#);
        assert!(m.extension_problems().iter().any(|p| p.path == "manifest.language_id"));
    }

    #[test]
    fn load_reports_missing_and_malformed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Manifest::load(dir.path()).unwrap_err().message.contains("no manifest.json"));
        std::fs::write(dir.path().join("manifest.json"), "{").unwrap();
        assert!(Manifest::load(dir.path()).unwrap_err().message.contains("not valid"));
        std::fs::write(dir.path().join("manifest.json"), ATPROTO).unwrap();
        assert_eq!(Manifest::load(dir.path()).unwrap().id, "happyview-atproto");
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p hpy-plugin manifest` → compile error.

- [ ] **Step 3: Implement**

```rust
//! `manifest.json`, the file HappyView's loader reads, and its image in a
//! release: `extensions["at.happyproto.plugin.releaseExtension"]`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Problem;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Manifest {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub api_version: Option<String>,
    #[serde(default)]
    pub plugin_type: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub language_id: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub wasm_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseExtension {
    pub plugin_type: String,
    pub api_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_id: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_hosts: Vec<String>,
}

const PLUGIN_TYPES: [&str; 3] = ["auth", "library", "interpreter"];

impl Manifest {
    pub fn load(dir: &Path) -> Result<Manifest, Problem> {
        let path = dir.join("manifest.json");
        let text = std::fs::read_to_string(&path).map_err(|_| {
            Problem::new("manifest.json", format!("no manifest.json in {}", dir.display()))
        })?;
        serde_json::from_str(&text)
            .map_err(|e| Problem::new("manifest.json", format!("is not valid: {e}")))
    }

    /// Everything the registry would refuse in the manifest half of a release.
    pub fn extension_problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        match self.plugin_type.as_deref() {
            Some(t) if PLUGIN_TYPES.contains(&t) => {}
            other => out.push(Problem::new(
                "manifest.plugin_type",
                format!("must be auth, library or interpreter (got {other:?})"),
            )),
        }
        let major = self
            .api_version
            .as_deref()
            .and_then(|v| v.split('.').next())
            .and_then(|m| m.parse::<u32>().ok());
        if !matches!(major, Some(m) if m >= 2) {
            out.push(Problem::new("manifest.api_version", "must be \"2\" or later"));
        }
        if self.capabilities.is_none() {
            out.push(Problem::new("manifest.capabilities", "must be declared, even when empty"));
        }
        if self.plugin_type.as_deref() == Some("library") && self.namespace.is_none() {
            out.push(Problem::new("manifest.namespace", "a library must declare its namespace"));
        }
        if self.plugin_type.as_deref() == Some("interpreter") {
            match self.language_id.as_deref() {
                None => out.push(Problem::new(
                    "manifest.language_id",
                    "an interpreter must declare its language_id",
                )),
                Some(id) if !is_language_id(id) => out.push(Problem::new(
                    "manifest.language_id",
                    "must be lowercase letters, digits, `-` or `_`, starting with a letter",
                )),
                Some(_) => {}
            }
        }
        out
    }

    /// The release extension. Call after `extension_problems` is empty.
    pub fn extension(&self) -> ReleaseExtension {
        ReleaseExtension {
            plugin_type: self.plugin_type.clone().unwrap_or_default(),
            api_version: self.api_version.clone().unwrap_or_default(),
            namespace: self.namespace.clone(),
            language_id: self.language_id.clone(),
            capabilities: self.capabilities.clone().unwrap_or_default(),
            allowed_hosts: self.allowed_hosts.clone(),
        }
    }
}

fn is_language_id(s: &str) -> bool {
    s.len() <= 64
        && s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}
```

- [ ] **Step 4: Run to verify pass** — `cargo test -p hpy-plugin manifest` → 5 passed.

- [ ] **Step 5: Commit** (only if asked)

---

### Task 4: Profile record and `hpy.toml`

**Files:**
- Create: `crates/hpy-plugin/src/profile.rs`, `crates/hpy-plugin/src/config.rs`
- Modify: `crates/hpy-plugin/src/lib.rs` (add `pub mod profile; pub mod config;`)

**Interfaces:**
- Consumes: `Problem`, `validate::{is_slug, graphemes}`, `Manifest`, `PLUGIN_KIND`, `PROFILE_NSID`.
- Produces (`profile`): `Author { name, url: Option, email: Option }`, `Contact { url: Option, email: Option }`, `Sections { description, installation, changelog, security: Option<String> }`, `Profile { kind, license, authors, security, name, description, keywords, sections: Option<Sections>, last_updated: Option<String> }`, `Profile::new_plugin() -> Profile`, `Profile::problems(&self) -> Vec<Problem>`, `Profile::to_record(&self) -> serde_json::Value`, `Profile::from_record(serde_json::Value) -> Result<Profile, String>`, `parse_author(&str) -> Result<Author, String>`, `parse_contact(&str) -> Result<Contact, String>`, `Author::display()`, `Contact::display()`.
- Produces (`config`): `HpyToml { profile: Option<ProfileConfig>, release: Option<ReleaseConfig>, build: Option<BuildConfig> }`, `ProfileConfig { slug, name, description, license: Option<String>, keywords: Vec<String>, authors: Vec<Author>, security: Vec<Contact>, sections: SectionsConfig }`, `SectionsConfig { description, installation, changelog, security: Option<SectionSource> }`, `enum SectionSource { Path(String), Inline { text: String } }`, `ReleaseConfig { version: Option<String>, repo: Option<String>, requires: BTreeMap<String, String>, artifacts: ArtifactsConfig }`, `ArtifactsConfig { icon: Option<ImageConfig>, banner: Option<ImageConfig>, screenshots: Vec<ImageConfig> }`, `ImageConfig { path: String, alt: Option<String> }`, `BuildConfig { command: Option<String>, wasm: Option<String> }`, `HpyToml::load(dir) -> Result<Option<HpyToml>, Problem>`, `HpyToml::slug(&self, manifest: Option<&Manifest>) -> Option<String>`, `ProfileConfig::to_profile(&self, dir: &Path, manifest: Option<&Manifest>) -> (Profile, Vec<Problem>)`, `ProfileConfig::from_profile(slug: &str, profile: &Profile) -> ProfileConfig` (sections inlined), `write_profile(dir: &Path, cfg: &ProfileConfig) -> std::io::Result<()>` (preserves the rest of the file).

- [ ] **Step 1: Failing tests — profile** (`profile.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Profile {
        Profile {
            license: "MIT".into(),
            authors: vec![Author { name: "Trezy".into(), url: None, email: Some("tre@trezy.com".into()) }],
            security: vec![Contact { url: None, email: Some("security@happyproto.at".into()) }],
            ..Profile::new_plugin()
        }
    }

    #[test]
    fn valid_profile_has_no_problems_and_serializes_camel_case() {
        let mut p = valid();
        p.last_updated = Some("2026-10-09T00:00:00Z".into());
        assert!(p.problems().is_empty());
        let r = p.to_record();
        assert_eq!(r["$type"], "at.happyproto.plugin.profile");
        assert_eq!(r["type"], "happyview-plugin");
        assert_eq!(r["lastUpdated"], "2026-10-09T00:00:00Z");
        assert!(r.get("keywords").is_none());
        assert_eq!(Profile::from_record(r).unwrap(), p);
    }

    #[test]
    fn required_fields() {
        let p = Profile::new_plugin();
        let paths: Vec<_> = p.problems().into_iter().map(|p| p.path).collect();
        assert!(paths.contains(&"profile.license".to_string()));
        assert!(paths.contains(&"profile.authors".to_string()));
        assert!(paths.contains(&"profile.security".to_string()));
    }

    #[test]
    fn limits() {
        let mut p = valid();
        p.name = Some("n".repeat(65));
        p.keywords = (0..21).map(|i| format!("k{i}")).collect();
        p.security = vec![Contact { url: None, email: None }];
        let paths: Vec<_> = p.problems().into_iter().map(|p| p.path).collect();
        assert!(paths.contains(&"profile.name".to_string()));
        assert!(paths.contains(&"profile.keywords".to_string()));
        assert!(paths.contains(&"profile.security[0]".to_string()));
    }

    #[test]
    fn parses_npm_style_authors_and_contacts() {
        assert_eq!(
            parse_author("Trezy <tre@trezy.com> (https://trezy.com)").unwrap(),
            Author { name: "Trezy".into(), email: Some("tre@trezy.com".into()), url: Some("https://trezy.com".into()) }
        );
        assert_eq!(parse_author("Just A Name").unwrap().name, "Just A Name");
        assert!(parse_author("  ").is_err());
        assert_eq!(parse_contact("security@x.io").unwrap().email.as_deref(), Some("security@x.io"));
        assert_eq!(parse_contact("https://x.io/sec").unwrap().url.as_deref(), Some("https://x.io/sec"));
        assert!(parse_contact("nope").is_err());
    }
}
```

- [ ] **Step 2: Failing tests — config** (`config.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const TOML: &str = r#"
# keep me
[profile]
license = "MIT"
keywords = ["atproto"]
authors = [{ name = "Trezy" }]
security = [{ email = "security@happyproto.at" }]

[profile.sections]
description = "README.md"
changelog = { text = "first" }

[release]
repo = "https://github.com/x/y"

[release.requires]
"env:happyview" = ">=3.0.0"

[release.artifacts]
icon = { path = "icon.png", alt = "logo" }

[build]
wasm = "plugin.wasm"
"#;

    #[test]
    fn loads_and_builds_profile_with_manifest_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), TOML).unwrap();
        std::fs::write(dir.path().join("README.md"), "# Hello").unwrap();
        let cfg = HpyToml::load(dir.path()).unwrap().unwrap();
        let manifest = Manifest { id: "happyview-atproto".into(), name: Some("Atproto".into()), description: Some("d".into()), ..Default::default() };
        assert_eq!(cfg.slug(Some(&manifest)).as_deref(), Some("happyview-atproto"));
        let (profile, problems) = cfg.profile.as_ref().unwrap().to_profile(dir.path(), Some(&manifest));
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(profile.name.as_deref(), Some("Atproto"));
        let sections = profile.sections.unwrap();
        assert_eq!(sections.description.as_deref(), Some("# Hello"));
        assert_eq!(sections.changelog.as_deref(), Some("first"));
        let release = cfg.release.unwrap();
        assert_eq!(release.requires["env:happyview"], ">=3.0.0");
        assert_eq!(release.artifacts.icon.unwrap().alt.as_deref(), Some("logo"));
        assert_eq!(cfg.build.unwrap().wasm.as_deref(), Some("plugin.wasm"));
    }

    #[test]
    fn missing_section_file_is_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ProfileConfig {
            sections: SectionsConfig { description: Some(SectionSource::Path("NOPE.md".into())), ..Default::default() },
            ..Default::default()
        };
        let (_, problems) = cfg.to_profile(dir.path(), None);
        assert!(problems.iter().any(|p| p.path == "profile.sections.description"));
    }

    #[test]
    fn write_profile_preserves_other_tables_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), TOML).unwrap();
        let mut cfg = HpyToml::load(dir.path()).unwrap().unwrap().profile.unwrap();
        cfg.license = Some("Apache-2.0".into());
        write_profile(dir.path(), &cfg).unwrap();
        let text = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        assert!(text.contains("# keep me"));
        assert!(text.contains("Apache-2.0"));
        assert!(text.contains("[build]"));
        let reloaded = HpyToml::load(dir.path()).unwrap().unwrap();
        assert_eq!(reloaded.profile.unwrap().license.as_deref(), Some("Apache-2.0"));
    }

    #[test]
    fn write_profile_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ProfileConfig { slug: Some("x".into()), license: Some("MIT".into()), ..Default::default() };
        write_profile(dir.path(), &cfg).unwrap();
        let loaded = HpyToml::load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.profile.unwrap().slug.as_deref(), Some("x"));
    }

    #[test]
    fn from_profile_inlines_sections() {
        let p = Profile {
            license: "MIT".into(),
            sections: Some(Sections { description: Some("long".into()), ..Default::default() }),
            ..Profile::new_plugin()
        };
        let cfg = ProfileConfig::from_profile("slug", &p);
        assert_eq!(cfg.sections.description, Some(SectionSource::Inline { text: "long".into() }));
        assert_eq!(cfg.slug.as_deref(), Some("slug"));
    }

    #[test]
    fn malformed_toml_is_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), "[profile\n").unwrap();
        assert_eq!(HpyToml::load(dir.path()).unwrap_err().path, "hpy.toml");
        let empty = tempfile::tempdir().unwrap();
        assert!(HpyToml::load(empty.path()).unwrap().is_none());
    }
}
```

- [ ] **Step 3: Run to verify failure** — `cargo test -p hpy-plugin` → compile errors.

- [ ] **Step 4: Implement `profile.rs`**

```rust
//! `at.happyproto.plugin.profile`: the package, as its publisher writes it.

use serde::{Deserialize, Serialize};

use crate::validate::graphemes;
use crate::{PLUGIN_KIND, PROFILE_NSID, Problem};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Author {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Contact {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Sections {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<String>,
}

impl Sections {
    pub fn entries(&self) -> [(&'static str, &Option<String>); 4] {
        [
            ("description", &self.description),
            ("installation", &self.installation),
            ("changelog", &self.changelog),
            ("security", &self.security),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub authors: Vec<Author>,
    #[serde(default)]
    pub security: Vec<Contact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Sections>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
}

fn too_long(out: &mut Vec<Problem>, path: &str, s: &str, max_graphemes: usize, max_bytes: usize) {
    if graphemes(s) > max_graphemes || s.len() > max_bytes {
        out.push(Problem::new(path, format!("is longer than {max_graphemes} characters")));
    }
}

fn looks_like_uri(s: &str) -> bool {
    s.split_once(':').is_some_and(|(scheme, rest)| {
        !scheme.is_empty()
            && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
            && !rest.is_empty()
    })
}

impl Profile {
    pub fn new_plugin() -> Profile {
        Profile {
            kind: PLUGIN_KIND.into(),
            license: String::new(),
            authors: Vec::new(),
            security: Vec::new(),
            name: None,
            description: None,
            keywords: Vec::new(),
            sections: None,
            last_updated: None,
        }
    }

    pub fn problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        if self.kind != PLUGIN_KIND {
            out.push(Problem::new("profile.type", format!("must be \"{PLUGIN_KIND}\"")));
        }
        if self.license.trim().is_empty() {
            out.push(Problem::new("profile.license", "is required (an SPDX expression, or \"proprietary\")"));
        } else if self.license.len() > 256 {
            out.push(Problem::new("profile.license", "is longer than 256 characters"));
        }
        if self.authors.is_empty() {
            out.push(Problem::new("profile.authors", "needs at least one author"));
        }
        for (i, a) in self.authors.iter().enumerate() {
            let path = format!("profile.authors[{i}]");
            if a.name.trim().is_empty() {
                out.push(Problem::new(&path, "needs a name"));
            }
            too_long(&mut out, &format!("{path}.name"), &a.name, 64, 640);
            if let Some(url) = &a.url {
                if !looks_like_uri(url) {
                    out.push(Problem::new(format!("{path}.url"), "is not a URI"));
                }
            }
            if a.email.as_ref().is_some_and(|e| e.len() > 320) {
                out.push(Problem::new(format!("{path}.email"), "is longer than 320 characters"));
            }
        }
        if self.security.is_empty() {
            out.push(Problem::new(
                "profile.security",
                "needs at least one contact: a plugin runs as native code in an operator's process",
            ));
        }
        for (i, c) in self.security.iter().enumerate() {
            let path = format!("profile.security[{i}]");
            if c.url.is_none() && c.email.is_none() {
                out.push(Problem::new(&path, "needs a url or an email"));
            }
            if c.url.as_ref().is_some_and(|u| !looks_like_uri(u)) {
                out.push(Problem::new(format!("{path}.url"), "is not a URI"));
            }
        }
        if let Some(name) = &self.name {
            too_long(&mut out, "profile.name", name, 64, 640);
        }
        if let Some(d) = &self.description {
            too_long(&mut out, "profile.description", d, 300, 3000);
        }
        if self.keywords.len() > 20 {
            out.push(Problem::new("profile.keywords", "has more than 20 keywords"));
        }
        for (i, k) in self.keywords.iter().enumerate() {
            too_long(&mut out, &format!("profile.keywords[{i}]"), k, 32, 320);
        }
        if let Some(sections) = &self.sections {
            for (name, text) in sections.entries() {
                if let Some(text) = text {
                    too_long(&mut out, &format!("profile.sections.{name}"), text, 2000, 20000);
                }
            }
        }
        out
    }

    pub fn to_record(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).expect("profile serializes");
        value["$type"] = PROFILE_NSID.into();
        value
    }

    pub fn from_record(mut value: serde_json::Value) -> Result<Profile, String> {
        if let Some(obj) = value.as_object_mut() {
            obj.remove("$type");
        }
        serde_json::from_value(value).map_err(|e| format!("the profile record is not readable: {e}"))
    }
}

impl Author {
    pub fn display(&self) -> String {
        let mut s = self.name.clone();
        if let Some(e) = &self.email {
            s.push_str(&format!(" <{e}>"));
        }
        if let Some(u) = &self.url {
            s.push_str(&format!(" ({u})"));
        }
        s
    }
}

impl Contact {
    pub fn display(&self) -> String {
        match (&self.email, &self.url) {
            (Some(e), Some(u)) => format!("{e} ({u})"),
            (Some(e), None) => e.clone(),
            (None, Some(u)) => u.clone(),
            (None, None) => "(empty)".into(),
        }
    }
}

/// `Name <email> (url)`, as npm writes authors; email and url are optional.
pub fn parse_author(s: &str) -> Result<Author, String> {
    let mut rest = s.trim().to_string();
    let mut take = |open: char, close: char| -> Option<String> {
        let start = rest.find(open)?;
        let end = rest[start..].find(close)? + start;
        let inner = rest[start + 1..end].trim().to_string();
        rest.replace_range(start..=end, "");
        Some(inner).filter(|s| !s.is_empty())
    };
    let email = take('<', '>');
    let url = take('(', ')');
    let name = rest.trim().to_string();
    if name.is_empty() {
        return Err("an author needs a name, e.g. `Ada <ada@example.com> (https://ada.dev)`".into());
    }
    Ok(Author { name, email, url })
}

/// A security contact: an email address or a URI.
pub fn parse_contact(s: &str) -> Result<Contact, String> {
    let s = s.trim();
    if s.contains("://") || s.starts_with("mailto:") {
        Ok(Contact { url: Some(s.into()), email: None })
    } else if s.contains('@') && !s.contains(' ') {
        Ok(Contact { url: None, email: Some(s.into()) })
    } else {
        Err(format!("`{s}` is neither an email address nor a URL"))
    }
}
```

- [ ] **Step 5: Implement `config.rs`**

```rust
//! `hpy.toml`: the registry metadata that lives in a plugin's repo beside
//! `manifest.json`. It seeds the profile; once the profile exists on the PDS,
//! the PDS wins.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::manifest::Manifest;
use crate::profile::{Author, Contact, Profile, Sections};
use crate::Problem;

pub const FILE_NAME: &str = "hpy.toml";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HpyToml {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<ProfileConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<ReleaseConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProfileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<Author>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security: Vec<Contact>,
    #[serde(default, skip_serializing_if = "SectionsConfig::is_empty")]
    pub sections: SectionsConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<SectionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<SectionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<SectionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<SectionSource>,
}

/// A long-form section: a path to a Markdown file relative to `hpy.toml`, or
/// the text inline (`{ text = "…" }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SectionSource {
    Path(String),
    Inline { text: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReleaseConfig {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub requires: BTreeMap<String, String>,
    #[serde(default)]
    pub artifacts: ArtifactsConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArtifactsConfig {
    #[serde(default)]
    pub icon: Option<ImageConfig>,
    #[serde(default)]
    pub banner: Option<ImageConfig>,
    #[serde(default)]
    pub screenshots: Vec<ImageConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImageConfig {
    pub path: String,
    #[serde(default)]
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BuildConfig {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub wasm: Option<String>,
}

impl SectionsConfig {
    pub fn is_empty(&self) -> bool {
        self.description.is_none()
            && self.installation.is_none()
            && self.changelog.is_none()
            && self.security.is_none()
    }
}

impl HpyToml {
    /// `Ok(None)` when there is no `hpy.toml`.
    pub fn load(dir: &Path) -> Result<Option<HpyToml>, Problem> {
        let path = dir.join(FILE_NAME);
        let Ok(text) = std::fs::read_to_string(&path) else { return Ok(None) };
        toml::from_str(&text)
            .map(Some)
            .map_err(|e| Problem::new(FILE_NAME, format!("is not valid: {e}")))
    }

    /// `[profile] slug`, else the manifest's `id`.
    pub fn slug(&self, manifest: Option<&Manifest>) -> Option<String> {
        self.profile
            .as_ref()
            .and_then(|p| p.slug.clone())
            .or_else(|| manifest.map(|m| m.id.clone()))
    }
}

fn read_section(dir: &Path, name: &str, source: &Option<SectionSource>, out: &mut Vec<Problem>) -> Option<String> {
    match source {
        None => None,
        Some(SectionSource::Inline { text }) => Some(text.clone()),
        Some(SectionSource::Path(p)) => match std::fs::read_to_string(dir.join(p)) {
            Ok(text) => Some(text),
            Err(e) => {
                out.push(Problem::new(format!("profile.sections.{name}"), format!("cannot read `{p}`: {e}")));
                None
            }
        },
    }
}

impl ProfileConfig {
    /// The profile this config describes, with manifest `name`/`description`
    /// as defaults, plus every problem with it (including the record's own).
    pub fn to_profile(&self, dir: &Path, manifest: Option<&Manifest>) -> (Profile, Vec<Problem>) {
        let mut problems = Vec::new();
        let s = &self.sections;
        let sections = Sections {
            description: read_section(dir, "description", &s.description, &mut problems),
            installation: read_section(dir, "installation", &s.installation, &mut problems),
            changelog: read_section(dir, "changelog", &s.changelog, &mut problems),
            security: read_section(dir, "security", &s.security, &mut problems),
        };
        let profile = Profile {
            license: self.license.clone().unwrap_or_default(),
            authors: self.authors.clone(),
            security: self.security.clone(),
            name: self.name.clone().or_else(|| manifest.and_then(|m| m.name.clone())),
            description: self.description.clone().or_else(|| manifest.and_then(|m| m.description.clone())),
            keywords: self.keywords.clone(),
            sections: (sections != Sections::default()).then_some(sections),
            ..Profile::new_plugin()
        };
        problems.extend(profile.problems());
        (profile, problems)
    }

    pub fn from_profile(slug: &str, profile: &Profile) -> ProfileConfig {
        let inline = |t: &Option<String>| t.clone().map(|text| SectionSource::Inline { text });
        let sections = profile.sections.clone().unwrap_or_default();
        ProfileConfig {
            slug: Some(slug.into()),
            name: profile.name.clone(),
            description: profile.description.clone(),
            license: Some(profile.license.clone()).filter(|l| !l.is_empty()),
            keywords: profile.keywords.clone(),
            authors: profile.authors.clone(),
            security: profile.security.clone(),
            sections: SectionsConfig {
                description: inline(&sections.description),
                installation: inline(&sections.installation),
                changelog: inline(&sections.changelog),
                security: inline(&sections.security),
            },
        }
    }
}

/// Replaces the `[profile]` table of `dir/hpy.toml`, creating the file if
/// needed and leaving every other table and comment alone.
pub fn write_profile(dir: &Path, cfg: &ProfileConfig) -> std::io::Result<()> {
    let path = dir.join(FILE_NAME);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = existing
        .parse()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{FILE_NAME}: {e}")))?;
    let table = toml_edit::ser::to_document(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    doc["profile"] = toml_edit::Item::Table(table.as_table().clone());
    std::fs::write(path, doc.to_string())
}
```

- [ ] **Step 6: Run to verify pass** — `cargo test -p hpy-plugin` → all tests pass (fix any `toml_edit` API drift — e.g. if `to_document` produces inline tables for `authors`, that is acceptable TOML; the reload assertion is what matters).

- [ ] **Step 7: Commit** (only if asked)

---

### Task 5: Artifacts, release record, locating the WASM

**Files:**
- Create: `crates/hpy-plugin/src/artifact.rs`, `crates/hpy-plugin/src/release.rs`, `crates/hpy-plugin/src/locate.rs`
- Modify: `crates/hpy-plugin/src/lib.rs` (add the three modules)

**Interfaces:**
- Consumes: `checksum::{checksum, raw_cid}`, `ReleaseExtension`, `validate::{requires_key_problem, range_problem}`, `Manifest`, `RELEASE_NSID`, `EXTENSION_NSID`.
- Produces (`artifact`): `MAX_WASM_BYTES`, `MAX_IMAGE_BYTES`, `WASM_MIME = "application/wasm"`, `wasm_problem(&[u8]) -> Option<String>`, `ImageInfo { mime: &'static str, width: u32, height: u32 }`, `inspect_image(&[u8]) -> Result<ImageInfo, String>`.
- Produces (`release`): `release_rkey(slug, version) -> String`, `Artifact { blob: Option<Value>, url: Option<String>, checksum: String, content_type: String }`, `Artifact::from_bytes(bytes, mime) -> Artifact` (blob = predicted blob ref), `ImageArtifact { artifact, width, height, alt }`, `Release { slug, version, repo, requires, extension, package, icon, banner, screenshots }`, `Release::to_record(&self) -> Value`, `requires_problems(&BTreeMap<String,String>) -> Vec<Problem>`, `predicted_blob(bytes, mime) -> Value`.
- Produces (`locate`): `locate_wasm(dir: &Path, explicit: Option<&Path>, configured: Option<&str>, manifest: &Manifest) -> Result<PathBuf, String>`, `cargo_candidates(target_dir: &Path, crate_name: &str) -> Vec<PathBuf>`.

- [ ] **Step 1: Failing tests — artifact**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // 1x1 PNG
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0,
        5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn wasm_magic_and_size() {
        assert_eq!(wasm_problem(b"\0asm\x01\0\0\0"), None);
        assert!(wasm_problem(b"PK\x03\x04").unwrap().contains("not a WebAssembly"));
        let mut big = b"\0asm\x01\0\0\0".to_vec();
        big.resize(MAX_WASM_BYTES + 1, 0);
        assert!(wasm_problem(&big).unwrap().contains("16 MiB"));
    }

    #[test]
    fn png_is_inspected() {
        let info = inspect_image(PNG).unwrap();
        assert_eq!((info.mime, info.width, info.height), ("image/png", 1, 1));
    }

    #[test]
    fn svg_and_oversize_refused() {
        assert!(inspect_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(inspect_image(&big).unwrap_err().contains("1 MiB"));
    }
}
```

- [ ] **Step 2: Failing tests — release**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::ReleaseExtension;

    fn ext() -> ReleaseExtension {
        ReleaseExtension {
            plugin_type: "library".into(), api_version: "2".into(), namespace: Some("x.y".into()),
            language_id: None, capabilities: vec![], allowed_hosts: vec![],
        }
    }

    #[test]
    fn builds_record() {
        let wasm = b"\0asm\x01\0\0\0";
        let release = Release {
            slug: "x".into(), version: "1.0.0".into(), repo: Some("https://github.com/x/y".into()),
            requires: [("env:happyview".to_string(), ">=3".to_string())].into(),
            extension: ext(),
            package: Artifact::from_bytes(wasm, "application/wasm"),
            icon: None, banner: None, screenshots: vec![],
        };
        let r = release.to_record();
        assert_eq!(r["$type"], "at.happyproto.plugin.release");
        assert_eq!(r["package"], "x");
        assert_eq!(r["version"], "1.0.0");
        assert_eq!(r["requires"]["env:happyview"], ">=3");
        assert_eq!(r["extensions"]["at.happyproto.plugin.releaseExtension"]["pluginType"], "library");
        let pkg = &r["artifacts"]["package"];
        assert_eq!(pkg["checksum"], "bciqjhjclxolmoujbrzgabvdz4taugwasfi4jvtfbmic3dzgq3rpzi5q");
        assert_eq!(pkg["blob"]["$type"], "blob");
        assert_eq!(pkg["blob"]["ref"]["$link"], "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy");
        assert_eq!(pkg["blob"]["mimeType"], "application/wasm");
        assert_eq!(pkg["blob"]["size"], 8);
        assert!(r["artifacts"].get("icon").is_none());
        assert!(r["artifacts"].get("screenshots").is_none());
        assert_eq!(release_rkey("x", "1.0.0"), "x:1.0.0");
    }

    #[test]
    fn requires_validation_collects_all() {
        let map = [
            ("env:happyview".to_string(), "^1 || ^2".to_string()),
            ("nope".to_string(), ">=1".to_string()),
        ]
        .into();
        let problems = requires_problems(&map);
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems.iter().any(|p| p.path == "release.requires[\"env:happyview\"]"));
    }
}
```

- [ ] **Step 3: Failing tests — locate** (Review Focus #1)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"\0asm\x01\0\0\0").unwrap();
    }

    #[test]
    fn explicit_and_configured_win() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("a.wasm"));
        touch(&dir.path().join("b.wasm"));
        let m = Manifest { id: "x".into(), wasm_file: Some("b.wasm".into()), ..Default::default() };
        assert_eq!(locate_wasm(dir.path(), Some(&dir.path().join("a.wasm")), None, &m).unwrap(), dir.path().join("a.wasm"));
        assert_eq!(locate_wasm(dir.path(), None, Some("a.wasm"), &m).unwrap(), dir.path().join("a.wasm"));
        assert_eq!(locate_wasm(dir.path(), None, None, &m).unwrap(), dir.path().join("b.wasm"));
        assert!(locate_wasm(dir.path(), None, Some("missing.wasm"), &m).unwrap_err().contains("missing.wasm"));
    }

    #[test]
    fn cargo_candidates_finds_each_target() {
        let target = tempfile::tempdir().unwrap();
        touch(&target.path().join("wasm32-unknown-unknown/release/my_plugin.wasm"));
        touch(&target.path().join("wasm32-wasip1/release/my_plugin.wasm"));
        touch(&target.path().join("wasm32-wasip1/debug/my_plugin.wasm"));
        let found = cargo_candidates(target.path(), "my-plugin");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    #[test]
    fn ambiguous_cargo_build_lists_candidates() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"my-plugin\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[lib]\ncrate-type = [\"cdylib\"]\n",
        )
        .unwrap();
        touch(&dir.path().join("src/lib.rs"));
        touch(&dir.path().join("target/wasm32-unknown-unknown/release/my_plugin.wasm"));
        touch(&dir.path().join("target/wasm32-wasip1/release/my_plugin.wasm"));
        let m = Manifest { id: "my-plugin".into(), ..Default::default() };
        let err = locate_wasm(dir.path(), None, None, &m).unwrap_err();
        assert!(err.contains("wasm32-unknown-unknown") && err.contains("wasm32-wasip1") && err.contains("--wasm"), "{err}");
    }

    #[test]
    fn nothing_found_says_what_was_tried() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manifest { id: "x".into(), ..Default::default() };
        let err = locate_wasm(dir.path(), None, None, &m).unwrap_err();
        assert!(err.contains("--wasm"), "{err}");
    }
}
```

- [ ] **Step 4: Run to verify failure** — `cargo test -p hpy-plugin` → compile errors.

- [ ] **Step 5: Implement `artifact.rs`**

```rust
//! Checks on the bytes a release carries, matching the release lexicon's
//! blob constraints.

pub const MAX_WASM_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 1024 * 1024;
pub const WASM_MIME: &str = "application/wasm";

pub fn wasm_problem(bytes: &[u8]) -> Option<String> {
    if !bytes.starts_with(b"\0asm") {
        return Some("is not a WebAssembly module (no `\\0asm` header)".into());
    }
    if bytes.len() > MAX_WASM_BYTES {
        return Some(format!("is {} bytes; the registry accepts at most 16 MiB", bytes.len()));
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// The type and size of a presentation image. SVG and anything else the
/// lexicon does not accept is refused.
pub fn inspect_image(bytes: &[u8]) -> Result<ImageInfo, String> {
    use imagesize::{Compression, ImageType};
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("is {} bytes; images may be at most 1 MiB", bytes.len()));
    }
    let mime = match imagesize::image_type(bytes) {
        Ok(ImageType::Png) => "image/png",
        Ok(ImageType::Jpeg) => "image/jpeg",
        Ok(ImageType::Webp) => "image/webp",
        Ok(ImageType::Gif) => "image/gif",
        Ok(ImageType::Heif(Compression::Av1)) => "image/avif",
        _ => return Err("must be PNG, JPEG, WebP, GIF or AVIF (SVG is not accepted)".into()),
    };
    let size = imagesize::blob_size(bytes).map_err(|e| format!("cannot read its dimensions: {e}"))?;
    Ok(ImageInfo { mime, width: size.width as u32, height: size.height as u32 })
}
```

- [ ] **Step 6: Implement `release.rs`**

```rust
//! `at.happyproto.plugin.release`: one immutable version of a package.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::checksum::{checksum, raw_cid};
use crate::manifest::ReleaseExtension;
use crate::validate::{range_problem, requires_key_problem};
use crate::{EXTENSION_NSID, Problem, RELEASE_NSID};

pub fn release_rkey(slug: &str, version: &str) -> String {
    format!("{slug}:{version}")
}

/// The blob ref a PDS will answer an upload of these bytes with. Building the
/// record from it before uploading lets `--dry-run` show the exact record,
/// and the upload is then checked against it.
pub fn predicted_blob(bytes: &[u8], mime: &str) -> Value {
    json!({
        "$type": "blob",
        "ref": { "$link": raw_cid(bytes) },
        "mimeType": mime,
        "size": bytes.len(),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Artifact {
    pub blob: Option<Value>,
    pub url: Option<String>,
    pub checksum: String,
    pub content_type: String,
}

impl Artifact {
    pub fn from_bytes(bytes: &[u8], mime: &str) -> Artifact {
        Artifact {
            blob: Some(predicted_blob(bytes, mime)),
            url: None,
            checksum: checksum(bytes),
            content_type: mime.into(),
        }
    }

    fn to_value(&self) -> Map<String, Value> {
        let mut m = Map::new();
        if let Some(b) = &self.blob {
            m.insert("blob".into(), b.clone());
        }
        if let Some(u) = &self.url {
            m.insert("url".into(), u.clone().into());
        }
        m.insert("checksum".into(), self.checksum.clone().into());
        m.insert("contentType".into(), self.content_type.clone().into());
        m
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageArtifact {
    pub artifact: Artifact,
    pub width: u32,
    pub height: u32,
    pub alt: Option<String>,
}

impl ImageArtifact {
    fn to_value(&self) -> Value {
        let mut m = self.artifact.to_value();
        m.insert("width".into(), self.width.into());
        m.insert("height".into(), self.height.into());
        if let Some(alt) = &self.alt {
            m.insert("alt".into(), alt.clone().into());
        }
        Value::Object(m)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub slug: String,
    pub version: String,
    pub repo: Option<String>,
    pub requires: BTreeMap<String, String>,
    pub extension: ReleaseExtension,
    pub package: Artifact,
    pub icon: Option<ImageArtifact>,
    pub banner: Option<ImageArtifact>,
    pub screenshots: Vec<ImageArtifact>,
}

impl Release {
    pub fn rkey(&self) -> String {
        release_rkey(&self.slug, &self.version)
    }

    pub fn to_record(&self) -> Value {
        let mut artifacts = Map::new();
        artifacts.insert("package".into(), Value::Object(self.package.to_value()));
        if let Some(i) = &self.icon {
            artifacts.insert("icon".into(), i.to_value());
        }
        if let Some(b) = &self.banner {
            artifacts.insert("banner".into(), b.to_value());
        }
        if !self.screenshots.is_empty() {
            artifacts.insert("screenshots".into(), self.screenshots.iter().map(ImageArtifact::to_value).collect());
        }
        let mut record = json!({
            "$type": RELEASE_NSID,
            "package": self.slug,
            "version": self.version,
            "artifacts": artifacts,
            "extensions": { EXTENSION_NSID: self.extension },
        });
        if !self.requires.is_empty() {
            record["requires"] = json!(self.requires);
        }
        if let Some(repo) = &self.repo {
            record["repo"] = repo.clone().into();
        }
        record
    }
}

pub fn requires_problems(requires: &BTreeMap<String, String>) -> Vec<Problem> {
    let mut out = Vec::new();
    for (key, range) in requires {
        let path = format!("release.requires[{key:?}]");
        if let Some(p) = requires_key_problem(key) {
            out.push(Problem::new(&path, p));
        }
        if let Some(p) = range_problem(range) {
            out.push(Problem::new(&path, p));
        }
    }
    out
}
```

- [ ] **Step 7: Implement `locate.rs`**

```rust
//! Finding the `.wasm` to publish: `--wasm`, then `[build] wasm`, then the
//! manifest's `wasm_file`, then Cargo's target directory — which, in a
//! workspace, is shared and found through `cargo metadata`.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::manifest::Manifest;

pub fn locate_wasm(
    dir: &Path,
    explicit: Option<&Path>,
    configured: Option<&str>,
    manifest: &Manifest,
) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        return existing(p.to_path_buf(), "--wasm");
    }
    if let Some(p) = configured {
        return existing(dir.join(p), "hpy.toml [build] wasm");
    }
    if let Some(p) = &manifest.wasm_file {
        let path = dir.join(p);
        if path.is_file() {
            return Ok(path);
        }
    }
    if dir.join("Cargo.toml").is_file() {
        if let Some((target, name)) = cargo_target(dir) {
            let found = cargo_candidates(&target, &name);
            match found.len() {
                1 => return Ok(found.into_iter().next().unwrap()),
                0 => {}
                _ => {
                    let list: Vec<String> = found.iter().map(|p| format!("  {}", p.display())).collect();
                    return Err(format!(
                        "found more than one built module; pass --wasm or set [build] wasm in hpy.toml:\n{}",
                        list.join("\n")
                    ));
                }
            }
        }
    }
    Err(format!(
        "could not find the plugin's .wasm; build it, then pass --wasm <path> or set [build] wasm in hpy.toml{}",
        manifest
            .wasm_file
            .as_ref()
            .map(|f| format!(" (manifest wasm_file `{f}` does not exist)"))
            .unwrap_or_default()
    ))
}

fn existing(path: PathBuf, source: &str) -> Result<PathBuf, String> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{source} points at {}, which does not exist", path.display()))
    }
}

/// `<target>/wasm32-*/release/<crate_name>.wasm`, in a stable order.
pub fn cargo_candidates(target_dir: &Path, crate_name: &str) -> Vec<PathBuf> {
    let file = format!("{}.wasm", crate_name.replace('-', "_"));
    let Ok(entries) = std::fs::read_dir(target_dir) else { return vec![] };
    let mut out: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("wasm32-"))
        .map(|e| e.path().join("release").join(&file))
        .filter(|p| p.is_file())
        .collect();
    out.sort();
    out
}

/// The target directory and package name for the Cargo package in `dir`.
fn cargo_target(dir: &Path) -> Option<(PathBuf, String)> {
    let manifest_path = dir.join("Cargo.toml").canonicalize().ok()?;
    let output = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args(["metadata", "--format-version", "1", "--no-deps", "--offline", "--manifest-path"])
        .arg(&manifest_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let meta: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let target = PathBuf::from(meta["target_directory"].as_str()?);
    let name = meta["packages"]
        .as_array()?
        .iter()
        .find(|p| p["manifest_path"].as_str().map(PathBuf::from).as_deref() == Some(manifest_path.as_path()))?
        ["name"]
        .as_str()?
        .to_string();
    Some((target, name))
}
```

- [ ] **Step 8: Run to verify pass** — `cargo test -p hpy-plugin` → all pass. If `imagesize` 0.15 names differ (`ImageType::Heif(Compression::Av1)`), adjust to the crate's actual enum, keeping the accepted set png/jpeg/webp/gif/avif.

- [ ] **Step 9: Commit** (only if asked)

---

### Task 6: `hpy-atproto` — errors, settings, Repo/Registry traits, HTTP registry

**Files:**
- Create: `crates/hpy-atproto/Cargo.toml`, `src/lib.rs`, `src/error.rs`, `src/settings.rs`, `src/repo.rs`, `src/registry.rs`

**Interfaces:**
- Produces: `hpy_atproto::Error { NotLoggedIn, SessionExpired, Xrpc { method: String, name: String, message: Option<String> }, Other(String) }`, `Error::is_auth(&self) -> bool`, `type Result<T>`.
- Produces: `Settings { registry_url: String, oauth_client_id: Option<String>, oauth_scope: String, config_dir: PathBuf }`, `Settings::load() -> Result<Settings>`, `Settings::from_sources(file: Option<&str>, env: &dyn Fn(&str) -> Option<String>, config_dir: PathBuf) -> Result<Settings>`, `Settings::{config_file, session_file, credentials_file}(&self) -> PathBuf`, `DEFAULT_REGISTRY_URL`, `DEFAULT_SCOPE`.
- Produces: `#[async_trait] trait Repo: Send + Sync { fn did(&self) -> &str; async fn get_record(&self, collection: &str, rkey: &str) -> Result<Option<StoredRecord>>; async fn list_records(&self, collection: &str) -> Result<Vec<StoredRecord>>; async fn create_record(&self, collection: &str, rkey: &str, record: Value) -> Result<WriteResult>; async fn put_record(&self, collection: &str, rkey: &str, record: Value, swap_record: Option<&str>) -> Result<WriteResult>; async fn delete_record(&self, collection: &str, rkey: &str) -> Result<()>; async fn upload_blob(&self, bytes: Vec<u8>, mime: &str) -> Result<Value>; }`, `StoredRecord { uri: String, cid: Option<String>, value: Value }`, `WriteResult { uri: String, cid: String }`, `rkey_of(uri: &str) -> &str`.
- Produces: `#[async_trait] trait Registry: Send + Sync { async fn get_package(&self, did: &str, slug: &str) -> Result<Option<PackageView>>; async fn get_release(&self, did: &str, slug: &str, version: &str) -> Result<Option<ReleaseView>>; async fn list_releases(&self, did: &str, slug: &str) -> Result<Vec<ReleaseView>>; }`, `PackageView { uri, did, status, latest_version: Option<String>, record: Value }`, `ReleaseView { uri, status, record: Value, indexed_at: Option<String> }` (serde camelCase), `HttpRegistry::new(base_url: &str) -> HttpRegistry`.

- [ ] **Step 1: Cargo.toml**

```toml
[package]
name = "hpy-atproto"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = false

[dependencies]
async-trait.workspace = true
bytes.workspace = true
etcetera.workspace = true
jacquard.workspace = true
reqwest.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
tokio.workspace = true
toml.workspace = true

[dev-dependencies]
tempfile.workspace = true
tokio = { workspace = true, features = ["macros", "rt-multi-thread"] }
wiremock.workspace = true
```

- [ ] **Step 2: Failing tests — settings** (`settings.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn defaults() {
        let s = Settings::from_sources(None, &env(&[]), "/c".into()).unwrap();
        assert_eq!(s.registry_url, DEFAULT_REGISTRY_URL);
        assert_eq!(s.oauth_client_id, None);
        assert_eq!(s.oauth_scope, DEFAULT_SCOPE);
        assert_eq!(s.session_file(), PathBuf::from("/c/session.toml"));
    }

    #[test]
    fn env_beats_file() {
        let file = "[registry]\nurl = \"https://file\"\n[oauth]\nclient_id = \"https://file/c.json\"\n";
        let s = Settings::from_sources(Some(file), &env(&[("HPY_REGISTRY_URL", "https://env")]), "/c".into()).unwrap();
        assert_eq!(s.registry_url, "https://env");
        assert_eq!(s.oauth_client_id.as_deref(), Some("https://file/c.json"));
    }

    #[test]
    fn bad_file_is_an_error() {
        assert!(Settings::from_sources(Some("[registry"), &env(&[]), "/c".into()).is_err());
    }
}
```

- [ ] **Step 3: Failing tests — registry** (`registry.rs`, wiremock)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_release_found_and_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getRelease"))
            .and(query_param("version", "1.0.0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "uri": "at://did:plc:a/at.happyproto.plugin.release/x:1.0.0",
                "record": {}, "status": "pending"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getRelease"))
            .and(query_param("version", "2.0.0"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "ReleaseNotFound", "message": "no release"
            })))
            .mount(&server)
            .await;
        let reg = HttpRegistry::new(&server.uri());
        let found = reg.get_release("did:plc:a", "x", "1.0.0").await.unwrap().unwrap();
        assert_eq!(found.status, "pending");
        assert!(reg.get_release("did:plc:a", "x", "2.0.0").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_releases_follows_cursor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.listReleases"))
            .and(query_param("cursor", "next"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "releases": [{"uri": "u2", "record": {}, "status": "active"}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.listReleases"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "releases": [{"uri": "u1", "record": {}, "status": "active"}], "cursor": "next"
            })))
            .mount(&server)
            .await;
        let reg = HttpRegistry::new(&server.uri());
        let all = reg.list_releases("did:plc:a", "x").await.unwrap();
        assert_eq!(all.iter().map(|r| r.uri.as_str()).collect::<Vec<_>>(), ["u1", "u2"]);
    }

    #[tokio::test]
    async fn other_errors_surface() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
                "error": "NotConfigured", "message": "no identity"
            })))
            .mount(&server)
            .await;
        let err = HttpRegistry::new(&server.uri()).get_package("did:plc:a", "x").await.unwrap_err();
        assert!(err.to_string().contains("NotConfigured"), "{err}");
    }
}
```

Note: check the `listReleases` lexicon output key (`releases`) against `lexicons/lexicons/at/happyproto/registry/listReleases.json` and use whatever array name it declares.

- [ ] **Step 4: Run to verify failure** — `cargo test -p hpy-atproto` → compile errors.

- [ ] **Step 5: Implement `error.rs`**

```rust
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not logged in; run `hpy login`")]
    NotLoggedIn,
    #[error("your session has expired or was revoked; run `hpy login`")]
    SessionExpired,
    #[error("{method} failed: {name}{}", .message.as_ref().map(|m| format!(" — {m}")).unwrap_or_default())]
    Xrpc { method: String, name: String, message: Option<String> },
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn is_auth(&self) -> bool {
        matches!(self, Error::NotLoggedIn | Error::SessionExpired)
    }

    pub fn other(e: impl std::fmt::Display) -> Error {
        Error::Other(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
```

- [ ] **Step 6: Implement `settings.rs`**

```rust
use std::path::PathBuf;

use serde::Deserialize;

use crate::{Error, Result};

pub const DEFAULT_REGISTRY_URL: &str = "https://api.happyproto.at";
pub const DEFAULT_SCOPE: &str = "atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*";

#[derive(Debug, Clone)]
pub struct Settings {
    pub registry_url: String,
    pub oauth_client_id: Option<String>,
    pub oauth_scope: String,
    pub config_dir: PathBuf,
}

#[derive(Deserialize, Default)]
struct File {
    #[serde(default)]
    registry: RegistrySection,
    #[serde(default)]
    oauth: OAuthSection,
}

#[derive(Deserialize, Default)]
struct RegistrySection {
    url: Option<String>,
}

#[derive(Deserialize, Default)]
struct OAuthSection {
    client_id: Option<String>,
    scope: Option<String>,
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
        Settings::from_sources(file.as_deref(), &|k| std::env::var(k).ok().filter(|v| !v.is_empty()), dir)
    }

    pub fn from_sources(
        file: Option<&str>,
        env: &dyn Fn(&str) -> Option<String>,
        config_dir: PathBuf,
    ) -> Result<Settings> {
        let file: File = match file {
            Some(text) => toml::from_str(text).map_err(|e| Error::Other(format!("config.toml is not valid: {e}")))?,
            None => File::default(),
        };
        Ok(Settings {
            registry_url: env("HPY_REGISTRY_URL")
                .or(file.registry.url)
                .unwrap_or_else(|| DEFAULT_REGISTRY_URL.into())
                .trim_end_matches('/')
                .to_string(),
            oauth_client_id: env("HPY_OAUTH_CLIENT_ID").or(file.oauth.client_id),
            oauth_scope: env("HPY_OAUTH_SCOPE").or(file.oauth.scope).unwrap_or_else(|| DEFAULT_SCOPE.into()),
            config_dir,
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.toml")
    }
    pub fn session_file(&self) -> PathBuf {
        self.config_dir.join("session.toml")
    }
    pub fn credentials_file(&self) -> PathBuf {
        self.config_dir.join("credentials.json")
    }
}
```

- [ ] **Step 7: Implement `repo.rs`**

```rust
use async_trait::async_trait;
use serde_json::Value;

use crate::Result;

#[derive(Debug, Clone, PartialEq)]
pub struct StoredRecord {
    pub uri: String,
    pub cid: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WriteResult {
    pub uri: String,
    pub cid: String,
}

/// The signed-in user's own repo. Commands are written against this trait so
/// they can be tested with an in-memory fake.
#[async_trait]
pub trait Repo: Send + Sync {
    fn did(&self) -> &str;
    async fn get_record(&self, collection: &str, rkey: &str) -> Result<Option<StoredRecord>>;
    async fn list_records(&self, collection: &str) -> Result<Vec<StoredRecord>>;
    async fn create_record(&self, collection: &str, rkey: &str, record: Value) -> Result<WriteResult>;
    async fn put_record(&self, collection: &str, rkey: &str, record: Value, swap_record: Option<&str>) -> Result<WriteResult>;
    async fn delete_record(&self, collection: &str, rkey: &str) -> Result<()>;
    /// Uploads a blob and answers the blob ref JSON (`{$type, ref, mimeType, size}`).
    async fn upload_blob(&self, bytes: Vec<u8>, mime: &str) -> Result<Value>;
}

/// The record key: the last path segment of an AT URI.
pub fn rkey_of(uri: &str) -> &str {
    uri.rsplit('/').next().unwrap_or(uri)
}
```

- [ ] **Step 8: Implement `registry.rs`**

```rust
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

use crate::{Error, Result};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageView {
    pub uri: String,
    #[serde(default)]
    pub did: String,
    pub status: String,
    #[serde(default)]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub record: Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseView {
    pub uri: String,
    pub status: String,
    #[serde(default)]
    pub record: Value,
    #[serde(default)]
    pub indexed_at: Option<String>,
}

#[async_trait]
pub trait Registry: Send + Sync {
    async fn get_package(&self, did: &str, slug: &str) -> Result<Option<PackageView>>;
    async fn get_release(&self, did: &str, slug: &str, version: &str) -> Result<Option<ReleaseView>>;
    async fn list_releases(&self, did: &str, slug: &str) -> Result<Vec<ReleaseView>>;
}

/// The registry's public XRPC queries, over plain HTTP.
pub struct HttpRegistry {
    base: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct XrpcErrorBody {
    error: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct ListReleases {
    #[serde(default)]
    releases: Vec<ReleaseView>,
    cursor: Option<String>,
}

const NOT_FOUND: [&str; 2] = ["PackageNotFound", "ReleaseNotFound"];

impl HttpRegistry {
    pub fn new(base_url: &str) -> HttpRegistry {
        HttpRegistry {
            base: base_url.trim_end_matches('/').into(),
            http: reqwest::Client::builder()
                .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
        }
    }

    /// `Ok(None)` for the registry's not-found errors.
    async fn query<T: serde::de::DeserializeOwned>(&self, method: &str, params: &[(&str, &str)]) -> Result<Option<T>> {
        let url = format!("{}/xrpc/{method}", self.base);
        let resp = self
            .http
            .get(&url)
            .query(params)
            .send()
            .await
            .map_err(|e| Error::Other(format!("could not reach the registry at {}: {e}", self.base)))?;
        let status = resp.status();
        let body = resp.bytes().await.map_err(Error::other)?;
        if status.is_success() {
            return serde_json::from_slice(&body)
                .map(Some)
                .map_err(|e| Error::Other(format!("{method} answered something unreadable: {e}")));
        }
        let err: XrpcErrorBody = serde_json::from_slice(&body).unwrap_or(XrpcErrorBody { error: None, message: None });
        let name = err.error.unwrap_or_else(|| format!("HTTP {status}"));
        if NOT_FOUND.contains(&name.as_str()) {
            return Ok(None);
        }
        Err(Error::Xrpc { method: method.into(), name, message: err.message })
    }
}

#[async_trait]
impl Registry for HttpRegistry {
    async fn get_package(&self, did: &str, slug: &str) -> Result<Option<PackageView>> {
        self.query("at.happyproto.registry.getPackage", &[("actor", did), ("slug", slug)]).await
    }

    async fn get_release(&self, did: &str, slug: &str, version: &str) -> Result<Option<ReleaseView>> {
        self.query("at.happyproto.registry.getRelease", &[("did", did), ("slug", slug), ("version", version)])
            .await
    }

    async fn list_releases(&self, did: &str, slug: &str) -> Result<Vec<ReleaseView>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut params = vec![("did", did), ("slug", slug), ("limit", "100")];
            if let Some(c) = &cursor {
                params.push(("cursor", c));
            }
            let Some(page): Option<ListReleases> = self.query("at.happyproto.registry.listReleases", &params).await? else {
                break;
            };
            out.extend(page.releases);
            match page.cursor {
                Some(c) if Some(&c) != cursor.as_ref() => cursor = Some(c),
                _ => break,
            }
        }
        Ok(out)
    }
}
```

`lib.rs`:
```rust
//! atproto for `hpy`: sessions, the user's repo, and the registry's queries.

pub mod error;
pub mod registry;
pub mod repo;
pub mod settings;

pub use error::{Error, Result};
pub use registry::{HttpRegistry, PackageView, Registry, ReleaseView};
pub use repo::{Repo, StoredRecord, WriteResult, rkey_of};
pub use settings::Settings;
```

- [ ] **Step 9: Run to verify pass** — `cargo test -p hpy-atproto` → 6 passed.

- [ ] **Step 10: Commit** (only if asked)

---

### Task 7: Sessions and the jacquard-backed Repo

**Files:**
- Create: `crates/hpy-atproto/src/session.rs`, `crates/hpy-atproto/src/jacquard_repo.rs`
- Modify: `crates/hpy-atproto/src/lib.rs` (add modules + re-exports `Session, SessionPointer, AuthMethod`)

**Interfaces:**
- Consumes: `Settings`, `Repo`, `Error`.
- Produces: `SessionPointer { did, handle: Option<String>, pds: String, session_id: String, method: AuthMethod }` (TOML), `AuthMethod::{OAuth { client_id: Option<String>, redirect_uri: String, scope: String }, AppPassword, Environment}`, `Session { pointer: SessionPointer, repo: Box<dyn Repo> }`, `login_app_password(&Settings, identifier: &str, password: &str) -> Result<SessionPointer>`, `login_oauth(&Settings, identifier: &str, open_browser: bool, show_url: &(dyn Fn(&str) + Sync)) -> Result<SessionPointer>`, `current(&Settings) -> Result<Option<Session>>` (environment credentials first, then the pointer), `logout(&Settings) -> Result<Option<SessionPointer>>`, `read_pointer(&Settings) -> Result<Option<SessionPointer>>`.
- Produces: `JacquardRepo<A>::new(agent: Agent<A>, did: String)` implementing `Repo`.

Network paths cannot be unit-tested without a PDS; this task's automated tests cover the pointer file and credential-file permissions, and the README documents a manual verification. The jacquard calls follow the API confirmed in the spike (scratchpad `spike/src/main.rs`): `CredentialSession::new(store, resolver).login(id, pw, None, None, None, None)`, `one_shot_server(("127.0.0.1", 0))`, `OAuthClient::new_with_shared(store, client, ClientData { keyset: None, config })`, `flow.start_auth(id, AuthorizeOptions { scopes, .. })`, `handle_localhost_callback(handle, &flow, &LoopbackConfig::default())`, bootstrap request types in `jacquard::common::xrpc::atproto` with explicit `::<SmolStr>`.

- [ ] **Step 1: Failing tests** (`session.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn settings(dir: &std::path::Path) -> Settings {
        Settings::from_sources(None, &|_| None, dir.to_path_buf()).unwrap()
    }

    #[test]
    fn pointer_roundtrip_and_logout_file_handling() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(dir.path());
        assert!(read_pointer(&s).unwrap().is_none());
        let p = SessionPointer {
            did: "did:plc:abc".into(),
            handle: Some("alice.test".into()),
            pds: "https://pds.test".into(),
            session_id: "sess".into(),
            method: AuthMethod::OAuth {
                client_id: None,
                redirect_uri: "http://127.0.0.1:1234/oauth/callback".into(),
                scope: "atproto".into(),
            },
        };
        write_pointer(&s, &p).unwrap();
        assert_eq!(read_pointer(&s).unwrap().unwrap(), p);
        let text = std::fs::read_to_string(s.session_file()).unwrap();
        assert!(text.contains("method = \"oauth\""), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn credentials_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let s = settings(&dir.path().join("nested"));
        prepare_credentials_file(&s).unwrap();
        let mode = std::fs::metadata(s.credentials_file()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn environment_credentials_are_detected() {
        assert_eq!(
            env_credentials(&|k| match k {
                "HPY_IDENTIFIER" => Some("alice.test".into()),
                "HPY_APP_PASSWORD" => Some("pw".into()),
                _ => None,
            }),
            Some(("alice.test".into(), "pw".into()))
        );
        assert_eq!(env_credentials(&|_| None), None);
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p hpy-atproto session` → compile errors.

- [ ] **Step 3: Implement `jacquard_repo.rs`**

```rust
//! `Repo` over a jacquard agent — OAuth or app password alike.

use async_trait::async_trait;
use jacquard::client::{Agent, AgentSession};
use jacquard::common::deps::smol_str::SmolStr;
use jacquard::common::types::ident::AtIdentifier;
use jacquard::common::types::string::{Did, Nsid, RecordKey, Rkey};
use jacquard::common::types::value::Data;
use jacquard::common::xrpc::atproto::{
    CreateRecord, DeleteRecord, GetRecord, ListRecords, PutRecord, UploadBlob,
};
use jacquard::common::types::cid::Cid;
use jacquard::xrpc::XrpcClient;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::repo::{Repo, StoredRecord, WriteResult};

pub struct JacquardRepo<A: AgentSession> {
    agent: Agent<A>,
    did: String,
}

impl<A: AgentSession> JacquardRepo<A> {
    pub fn new(agent: Agent<A>, did: String) -> Self {
        Self { agent, did }
    }

    fn repo_id(&self) -> Result<AtIdentifier<SmolStr>> {
        Ok(AtIdentifier::Did(Did::new_owned(&self.did).map_err(Error::other)?))
    }
}

fn nsid(s: &str) -> Result<Nsid<SmolStr>> {
    Nsid::new_owned(s).map_err(Error::other)
}

fn rkey(s: &str) -> Result<RecordKey<Rkey<SmolStr>>> {
    Ok(RecordKey(Rkey::new_owned(s).map_err(Error::other)?))
}

fn data(v: Value) -> Result<Data<SmolStr>> {
    serde_json::from_value(v).map_err(|e| Error::Other(format!("record is not valid atproto data: {e}")))
}

/// Maps any jacquard failure (send or decode) into ours, recognising an
/// authentication failure so commands can say "run `hpy login`".
fn map_err(method: &str, e: impl std::fmt::Display) -> Error {
    crate::error::from_display(method, &e.to_string())
}

#[async_trait]
impl<A: AgentSession + Send + Sync> Repo for JacquardRepo<A> {
    fn did(&self) -> &str {
        &self.did
    }

    async fn get_record(&self, collection: &str, key: &str) -> Result<Option<StoredRecord>> {
        const M: &str = "com.atproto.repo.getRecord";
        let req = GetRecord::<SmolStr> { cid: None, collection: nsid(collection)?, repo: self.repo_id()?, rkey: rkey(key)? };
        let resp = self.agent.send(req).await.map_err(|e| map_err(M, e))?;
        match resp.into_output() {
            Ok(out) => Ok(Some(StoredRecord {
                uri: out.uri.to_string(),
                cid: out.cid.map(|c| c.to_string()),
                value: serde_json::to_value(&out.value).map_err(Error::other)?,
            })),
            Err(e) if e.to_string().contains("RecordNotFound") => Ok(None),
            Err(e) => Err(map_err(M, e)),
        }
    }

    async fn list_records(&self, collection: &str) -> Result<Vec<StoredRecord>> {
        const M: &str = "com.atproto.repo.listRecords";
        let mut out = Vec::new();
        let mut cursor: Option<SmolStr> = None;
        loop {
            let req = ListRecords::<SmolStr> {
                collection: nsid(collection)?,
                repo: self.repo_id()?,
                cursor: cursor.clone(),
                limit: Some(100),
                reverse: None,
            };
            let page = self.agent.send(req).await.map_err(|e| map_err(M, e))?.into_output().map_err(|e| map_err(M, e))?;
            for r in page.records {
                out.push(StoredRecord {
                    uri: r.uri.to_string(),
                    cid: Some(r.cid.to_string()),
                    value: serde_json::to_value(&r.value).map_err(Error::other)?,
                });
            }
            match page.cursor {
                Some(c) if Some(&c) != cursor.as_ref() => cursor = Some(c),
                _ => break,
            }
        }
        Ok(out)
    }

    async fn create_record(&self, collection: &str, key: &str, record: Value) -> Result<WriteResult> {
        const M: &str = "com.atproto.repo.createRecord";
        let req = CreateRecord::<SmolStr> {
            collection: nsid(collection)?,
            record: data(record)?,
            repo: self.repo_id()?,
            rkey: Some(rkey(key)?),
            swap_commit: None,
            validate: None,
        };
        let out = self.agent.send(req).await.map_err(|e| map_err(M, e))?.into_output().map_err(|e| map_err(M, e))?;
        Ok(WriteResult { uri: out.uri.to_string(), cid: out.cid.to_string() })
    }

    async fn put_record(&self, collection: &str, key: &str, record: Value, swap_record: Option<&str>) -> Result<WriteResult> {
        const M: &str = "com.atproto.repo.putRecord";
        let req = PutRecord::<SmolStr> {
            collection: nsid(collection)?,
            record: data(record)?,
            repo: self.repo_id()?,
            rkey: rkey(key)?,
            swap_commit: None,
            swap_record: swap_record.map(|c| Cid::str(c).into_static_owned()).transpose()?,
            validate: None,
        };
        let out = self.agent.send(req).await.map_err(|e| map_err(M, e))?.into_output().map_err(|e| map_err(M, e))?;
        Ok(WriteResult { uri: out.uri.to_string(), cid: out.cid.to_string() })
    }

    async fn delete_record(&self, collection: &str, key: &str) -> Result<()> {
        const M: &str = "com.atproto.repo.deleteRecord";
        let req = DeleteRecord::<SmolStr> {
            collection: nsid(collection)?,
            repo: self.repo_id()?,
            rkey: rkey(key)?,
            swap_commit: None,
            swap_record: None,
        };
        self.agent.send(req).await.map_err(|e| map_err(M, e))?.into_output().map_err(|e| map_err(M, e))?;
        Ok(())
    }

    async fn upload_blob(&self, bytes: Vec<u8>, mime: &str) -> Result<Value> {
        const M: &str = "com.atproto.repo.uploadBlob";
        let mut opts = self.agent.opts().await;
        opts.extra_headers.push((
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_str(mime).map_err(Error::other)?,
        ));
        let out = self
            .agent
            .send_with_opts(UploadBlob { body: bytes.into() }, opts)
            .await
            .map_err(|e| map_err(M, e))?
            .into_output()
            .map_err(|e| map_err(M, e))?;
        serde_json::to_value(&out.blob).map_err(Error::other)
    }
}
```

Exact jacquard type paths (`Cid` constructor for `swap_record`, `ListRecords` field names, `opts()`/`send_with_opts` visibility, `http` re-export) are fixed against the compiler in this step; the spike confirmed `GetRecord`/`CreateRecord`/`UploadBlob`. Add to `error.rs`:

```rust
/// Classifies a jacquard error by its rendered text. jacquard's error enums
/// are deep and version-specific; their Display is stable enough to spot the
/// cases that matter to a user.
pub fn from_display(method: &str, text: &str) -> Error {
    let lower = text.to_ascii_lowercase();
    if ["expiredtoken", "invalidtoken", "invalid_grant", "unauthorized", "authentication"]
        .iter()
        .any(|k| lower.contains(k))
    {
        return Error::SessionExpired;
    }
    Error::Xrpc { method: method.into(), name: text.into(), message: None }
}
```

with a unit test:

```rust
#[test]
fn auth_failures_are_recognised() {
    assert!(matches!(from_display("m", "XRPC error: ExpiredToken: Token has expired"), Error::SessionExpired));
    assert!(matches!(from_display("m", "token refresh failed: invalid_grant"), Error::SessionExpired));
    assert!(matches!(from_display("m", "InvalidRequest: bad"), Error::Xrpc { .. }));
}
```

- [ ] **Step 4: Implement `session.rs`**

```rust
//! Signing in, staying signed in, and signing out.
//!
//! Tokens live in jacquard's `FileAuthStore` (`credentials.json`, 0600). The
//! non-secret `session.toml` says which session is active and — for OAuth —
//! the exact client id, redirect URI and scope it was issued to, because a
//! refresh must present the same client id.

use std::sync::Arc;

use jacquard::client::credential_session::CredentialSession;
use jacquard::client::{Agent, FileAuthStore};
use jacquard::common::deps::fluent_uri::Uri;
use jacquard::common::deps::smol_str::SmolStr;
use jacquard::identity::JacquardResolver;
use jacquard::oauth::atproto::AtprotoClientMetadata;
use jacquard::oauth::client::OAuthClient;
use jacquard::oauth::loopback::{LoopbackConfig, handle_localhost_callback, one_shot_server, try_open_in_browser};
use jacquard::oauth::scopes::Scopes;
use jacquard::oauth::session::ClientData;
use jacquard::oauth::types::AuthorizeOptions;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::jacquard_repo::JacquardRepo;
use crate::repo::Repo;
use crate::settings::Settings;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionPointer {
    pub did: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub pds: String,
    pub session_id: String,
    #[serde(flatten)]
    pub method: AuthMethod,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum AuthMethod {
    #[serde(rename = "oauth")]
    OAuth {
        /// `None` means the atproto localhost development client.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        redirect_uri: String,
        scope: String,
    },
    AppPassword,
    /// `HPY_IDENTIFIER` + `HPY_APP_PASSWORD`; never written to disk.
    Environment,
}

pub struct Session {
    pub pointer: SessionPointer,
    pub repo: Box<dyn Repo>,
}

pub fn read_pointer(settings: &Settings) -> Result<Option<SessionPointer>> {
    match std::fs::read_to_string(settings.session_file()) {
        Ok(text) => toml::from_str(&text)
            .map(Some)
            .map_err(|e| Error::Other(format!("{} is corrupt ({e}); run `hpy login`", settings.session_file().display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::other(e)),
    }
}

pub fn write_pointer(settings: &Settings, pointer: &SessionPointer) -> Result<()> {
    std::fs::create_dir_all(&settings.config_dir).map_err(Error::other)?;
    let text = toml::to_string(pointer).map_err(Error::other)?;
    std::fs::write(settings.session_file(), text).map_err(Error::other)
}

/// Creates `credentials.json` owner-only before jacquard writes tokens to it.
pub fn prepare_credentials_file(settings: &Settings) -> Result<()> {
    std::fs::create_dir_all(&settings.config_dir).map_err(Error::other)?;
    let path = settings.credentials_file();
    if !path.exists() {
        std::fs::write(&path, "{}").map_err(Error::other)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(Error::other)?;
    }
    Ok(())
}

pub fn env_credentials(env: &dyn Fn(&str) -> Option<String>) -> Option<(String, String)> {
    Some((env("HPY_IDENTIFIER")?, env("HPY_APP_PASSWORD")?))
}

fn store(settings: &Settings) -> Result<FileAuthStore> {
    prepare_credentials_file(settings)?;
    Ok(FileAuthStore::new(settings.credentials_file()))
}

fn client_data(client_id: Option<&str>, redirect_uri: &str, scope: &str) -> Result<ClientData<SmolStr>> {
    let redirect = Uri::parse(redirect_uri.to_string()).map_err(Error::other)?;
    let scopes = Scopes::new(SmolStr::new(scope)).map_err(|e| Error::Other(format!("invalid OAuth scope `{scope}`: {e:?}")))?;
    let config = match client_id {
        None => AtprotoClientMetadata::new_localhost(Some(vec![redirect]), Some(scopes)),
        Some(id) => AtprotoClientMetadata::new(
            vec![redirect],
            Uri::parse(id.to_string()).map_err(Error::other)?,
            Some(scopes),
        ),
    };
    Ok(ClientData { keyset: None, config })
}

async fn handle_for(pds: &str, did: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Describe {
        handle: String,
    }
    let url = format!("{}/xrpc/com.atproto.repo.describeRepo", pds.trim_end_matches('/'));
    let resp = reqwest::Client::new().get(url).query(&[("repo", did)]).send().await.ok()?;
    resp.json::<Describe>().await.ok().map(|d| d.handle)
}

pub async fn login_app_password(settings: &Settings, identifier: &str, password: &str) -> Result<SessionPointer> {
    let session = CredentialSession::new(Arc::new(store(settings)?), Arc::new(JacquardResolver::default()));
    let atp = session
        .login(identifier, password, None, None, None, None)
        .await
        .map_err(|e| Error::Other(format!("login failed: {e}")))?;
    let pointer = SessionPointer {
        did: atp.did.to_string(),
        handle: Some(atp.handle.to_string()),
        pds: session.endpoint().await.to_string(),
        session_id: atp.session_id.to_string(),
        method: AuthMethod::AppPassword,
    };
    write_pointer(settings, &pointer)?;
    Ok(pointer)
}

pub async fn login_oauth(
    settings: &Settings,
    identifier: &str,
    open_browser: bool,
    show_url: &(dyn Fn(&str) + Sync),
) -> Result<SessionPointer> {
    let base = OAuthClient::with_default_config(store(settings)?);
    let (addr, handle) = one_shot_server(("127.0.0.1", 0)).await.map_err(Error::other)?;
    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", addr.port());
    let client_id = settings.oauth_client_id.clone();
    let data = client_data(client_id.as_deref(), &redirect_uri, &settings.oauth_scope)?;
    let flow = OAuthClient::new_with_shared(base.registry.store.clone(), base.client.clone(), data);
    let url = flow
        .start_auth(identifier, AuthorizeOptions::default())
        .await
        .map_err(|e| Error::Other(format!("could not start OAuth with your PDS: {e}")))?;
    show_url(&url);
    if open_browser {
        let _ = try_open_in_browser(&url);
    }
    let session = handle_localhost_callback(handle, &flow, &LoopbackConfig::default())
        .await
        .map_err(|e| Error::Other(format!("OAuth did not complete: {e}")))?;
    let agent = Agent::from(session);
    let (did, session_id) = agent.info().await.ok_or_else(|| Error::Other("OAuth completed without a session".into()))?;
    let pds = agent.endpoint().await.to_string();
    let pointer = SessionPointer {
        handle: handle_for(&pds, did.as_str()).await,
        did: did.to_string(),
        pds,
        session_id: session_id.map(|s| s.to_string()).unwrap_or_default(),
        method: AuthMethod::OAuth { client_id, redirect_uri, scope: settings.oauth_scope.clone() },
    };
    write_pointer(settings, &pointer)?;
    Ok(pointer)
}

/// The active session: environment credentials first (CI), then the stored
/// one. `Ok(None)` when nobody is signed in.
pub async fn current(settings: &Settings) -> Result<Option<Session>> {
    if let Some((identifier, password)) = env_credentials(&|k| std::env::var(k).ok().filter(|v| !v.is_empty())) {
        let session = CredentialSession::new(
            Arc::new(jacquard::client::MemorySessionStore::default()),
            Arc::new(JacquardResolver::default()),
        );
        let atp = session
            .login(&identifier, &password, None, None, None, None)
            .await
            .map_err(|e| Error::Other(format!("HPY_IDENTIFIER/HPY_APP_PASSWORD login failed: {e}")))?;
        let pointer = SessionPointer {
            did: atp.did.to_string(),
            handle: Some(atp.handle.to_string()),
            pds: session.endpoint().await.to_string(),
            session_id: atp.session_id.to_string(),
            method: AuthMethod::Environment,
        };
        let repo = JacquardRepo::new(Agent::new(session), pointer.did.clone());
        return Ok(Some(Session { pointer, repo: Box::new(repo) }));
    }

    let Some(pointer) = read_pointer(settings)? else { return Ok(None) };
    let did = jacquard::common::types::string::Did::<SmolStr>::new_owned(&pointer.did).map_err(Error::other)?;
    let repo: Box<dyn Repo> = match &pointer.method {
        AuthMethod::OAuth { client_id, redirect_uri, scope } => {
            let base = OAuthClient::with_default_config(store(settings)?);
            let client = OAuthClient::new_with_shared(
                base.registry.store.clone(),
                base.client.clone(),
                client_data(client_id.as_deref(), redirect_uri, scope)?,
            );
            let session = client.restore(&did, &pointer.session_id).await.map_err(|_| Error::SessionExpired)?;
            Box::new(JacquardRepo::new(Agent::from(session), pointer.did.clone()))
        }
        AuthMethod::AppPassword => {
            let session = CredentialSession::new(Arc::new(store(settings)?), Arc::new(JacquardResolver::default()));
            session.restore(did, SmolStr::new(&pointer.session_id)).await.map_err(|_| Error::SessionExpired)?;
            Box::new(JacquardRepo::new(Agent::new(session), pointer.did.clone()))
        }
        AuthMethod::Environment => return Ok(None),
    };
    Ok(Some(Session { pointer, repo }))
}

/// Revokes server-side where the method allows, then forgets the session.
pub async fn logout(settings: &Settings) -> Result<Option<SessionPointer>> {
    let Some(pointer) = read_pointer(settings)? else { return Ok(None) };
    revoke(settings, &pointer).await;
    let _ = std::fs::remove_file(settings.session_file());
    let _ = std::fs::remove_file(settings.credentials_file());
    Ok(Some(pointer))
}
```

Revocation is best-effort: it rebuilds the stored session and calls jacquard's `logout()`; any failure is ignored because the local files are removed regardless.

```rust
async fn revoke(settings: &Settings, pointer: &SessionPointer) {
    let Ok(did) = jacquard::common::types::string::Did::<SmolStr>::new_owned(&pointer.did) else { return };
    match &pointer.method {
        AuthMethod::OAuth { client_id, redirect_uri, scope } => {
            let (Ok(store), Ok(data)) = (store(settings), client_data(client_id.as_deref(), redirect_uri, scope)) else { return };
            let base = OAuthClient::with_default_config(store);
            let client = OAuthClient::new_with_shared(base.registry.store.clone(), base.client.clone(), data);
            if let Ok(session) = client.restore(&did, &pointer.session_id).await {
                let _ = session.logout().await;
            }
        }
        AuthMethod::AppPassword => {
            let Ok(store) = store(settings) else { return };
            let session = CredentialSession::new(Arc::new(store), Arc::new(JacquardResolver::default()));
            if session.restore(did, SmolStr::new(&pointer.session_id)).await.is_ok() {
                let _ = session.logout().await;
            }
        }
        AuthMethod::Environment => {}
    }
}
```



- [ ] **Step 5: Build and run tests** — `cargo test -p hpy-atproto` → all pass. Resolve jacquard signature mismatches (e.g. `CredentialSession::restore` argument types, `Agent::info` return shape, `AtpSession` field names) against the compiler, keeping the behaviour above.

- [ ] **Step 6: Commit** (only if asked)

---

### Task 8: Binary skeleton — CLI tree, failure/exit codes, prompter, output, auth commands

**Files:**
- Create: `crates/hpy/Cargo.toml`, `src/main.rs`, `src/cli.rs`, `src/failure.rs`, `src/prompt.rs`, `src/output.rs`, `src/ctx.rs`, `src/commands/mod.rs`, `src/commands/auth.rs`, `tests/cli.rs`

**Interfaces:**
- Consumes: `hpy_atproto::{Settings, session::*, Error}`.
- Produces: `Failure { code: u8, report: miette::Report }`, `Failure::{usage, runtime, not_logged_in}`, `impl From<hpy_atproto::Error> for Failure` (auth → 3, else 1), `fn problems(Vec<Problem>) -> Failure` (code 2, lists every problem).
- Produces: `Prompter::new(no_input: bool)`, `Prompter::{is_interactive, required, optional, list, confirm, secret}` (signatures below).
- Produces: `Output::new(json: bool)`, `Output::{status(&str), done(human: &str, json: serde_json::Value)}`.
- Produces: `Ctx { settings, prompter, out, dir }`, `Ctx::session(&self) -> Result<Session, Failure>`, `Ctx::registry(&self) -> HttpRegistry`.

- [ ] **Step 1: Cargo.toml**

```toml
[package]
name = "hpy-cli"
description = "The HappyProto command line"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[[bin]]
name = "hpy"
path = "src/main.rs"

[dependencies]
hpy-plugin.workspace = true
hpy-atproto.workspace = true
async-trait.workspace = true
clap.workspace = true
inquire.workspace = true
miette.workspace = true
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
toml.workspace = true

[dev-dependencies]
assert_cmd.workspace = true
predicates.workspace = true
tempfile.workspace = true
```

- [ ] **Step 2: Failing CLI tests** (`crates/hpy/tests/cli.rs`) — Review Focus #4 (exit 3)

```rust
use assert_cmd::Command;
use predicates::prelude::*;

fn hpy(config: &std::path::Path) -> Command {
    let mut cmd = Command::cargo_bin("hpy").unwrap();
    cmd.env("XDG_CONFIG_HOME", config)
        .env("APPDATA", config)
        .env_remove("HPY_IDENTIFIER")
        .env_remove("HPY_APP_PASSWORD")
        .env("HPY_REGISTRY_URL", "http://127.0.0.1:9");
    cmd
}

#[test]
fn help_lists_groups() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path()).arg("--help").assert().success()
        .stdout(predicate::str::contains("login").and(predicate::str::contains("plugin")));
    hpy(dir.path()).args(["plugin", "--help"]).assert().success()
        .stdout(predicate::str::contains("publish").and(predicate::str::contains("profile")));
}

#[test]
fn whoami_when_logged_out_exits_3() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path()).arg("whoami").assert().code(3).stderr(predicate::str::contains("hpy login"));
}

#[test]
fn whoami_reads_pointer() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("hpy")).unwrap();
    std::fs::write(
        dir.path().join("hpy/session.toml"),
        "did = \"did:plc:abc\"\nhandle = \"alice.test\"\npds = \"https://pds.test\"\nsession_id = \"s\"\nmethod = \"app-password\"\n",
    ).unwrap();
    hpy(dir.path()).args(["whoami", "--json"]).assert().success()
        .stdout(predicate::str::contains("\"did\": \"did:plc:abc\""));
}

#[test]
fn login_without_tty_needs_identifier() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path()).args(["login", "--no-input"]).assert().code(2)
        .stderr(predicate::str::contains("<IDENTIFIER>"));
}

#[test]
fn logout_when_logged_out_is_fine() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path()).arg("logout").assert().success();
}
```

`whoami` reads only the pointer (no network): it reports what is stored, so it works offline.

- [ ] **Step 3: Run to verify failure** — `cargo test -p hpy-cli` → compile errors.

- [ ] **Step 4: Implement `failure.rs`**

```rust
use hpy_plugin::Problem;

/// An error with its exit code: 1 runtime/remote, 2 usage/validation,
/// 3 not logged in.
pub struct Failure {
    pub code: u8,
    pub report: miette::Report,
}

impl Failure {
    pub fn usage(msg: impl std::fmt::Display) -> Failure {
        Failure { code: 2, report: miette::miette!("{msg}") }
    }
    pub fn runtime(msg: impl std::fmt::Display) -> Failure {
        Failure { code: 1, report: miette::miette!("{msg}") }
    }
    pub fn not_logged_in() -> Failure {
        Failure { code: 3, report: miette::miette!("not logged in; run `hpy login`") }
    }
    pub fn problems(intro: &str, problems: &[Problem]) -> Failure {
        let list: Vec<String> = problems.iter().map(|p| format!("  • {p}")).collect();
        Failure::usage(format!("{intro}\n{}", list.join("\n")))
    }
}

impl From<hpy_atproto::Error> for Failure {
    fn from(e: hpy_atproto::Error) -> Failure {
        let code = if e.is_auth() { 3 } else { 1 };
        Failure { code, report: miette::miette!("{e}") }
    }
}

impl From<Problem> for Failure {
    fn from(p: Problem) -> Failure {
        Failure::usage(p)
    }
}
```

- [ ] **Step 5: Implement `prompt.rs`**

```rust
use std::io::IsTerminal;

use crate::failure::Failure;

/// Flag value, else a prompt (only with a terminal), else the default, else
/// an error naming the flag. Nothing here ever blocks without a TTY.
pub struct Prompter {
    interactive: bool,
}

fn prompt_err(e: inquire::InquireError) -> Failure {
    match e {
        inquire::InquireError::OperationCanceled | inquire::InquireError::OperationInterrupted => {
            Failure::runtime("cancelled")
        }
        e => Failure::runtime(e),
    }
}

impl Prompter {
    pub fn new(no_input: bool) -> Prompter {
        Prompter { interactive: !no_input && std::io::stdin().is_terminal() && std::io::stderr().is_terminal() }
    }

    pub fn is_interactive(&self) -> bool {
        self.interactive
    }

    pub fn required(
        &self,
        flag: &str,
        label: &str,
        given: Option<String>,
        default: Option<String>,
        check: fn(&str) -> Result<(), String>,
    ) -> Result<String, Failure> {
        if let Some(v) = given {
            check(&v).map_err(|e| Failure::usage(format!("{flag}: {e}")))?;
            return Ok(v);
        }
        if self.interactive {
            let mut p = inquire::Text::new(label).with_validator(move |s: &str| {
                Ok(match check(s) {
                    Ok(()) => inquire::validator::Validation::Valid,
                    Err(e) => inquire::validator::Validation::Invalid(e.into()),
                })
            });
            if let Some(d) = &default {
                p = p.with_default(d);
            }
            return p.prompt().map_err(prompt_err);
        }
        match default {
            Some(d) => {
                check(&d).map_err(|e| Failure::usage(format!("{flag} (defaulted to `{d}`): {e}")))?;
                Ok(d)
            }
            None => Err(Failure::usage(format!("missing {flag} (no terminal to prompt on)"))),
        }
    }

    pub fn optional(&self, label: &str, given: Option<String>, default: Option<String>) -> Result<Option<String>, Failure> {
        if given.is_some() {
            return Ok(given);
        }
        if self.interactive {
            let mut p = inquire::Text::new(label).with_help_message("optional; leave blank to skip");
            if let Some(d) = &default {
                p = p.with_default(d);
            }
            let v = p.prompt().map_err(prompt_err)?;
            return Ok(Some(v).filter(|s| !s.trim().is_empty()));
        }
        Ok(default)
    }

    /// A repeated value: flags if any were given, else prompt one per line
    /// (blank to finish), else the defaults. Fewer than `min` is an error.
    pub fn list<T>(
        &self,
        flag: &str,
        label: &str,
        given: Vec<String>,
        default: Vec<T>,
        parse: fn(&str) -> Result<T, String>,
        min: usize,
    ) -> Result<Vec<T>, Failure> {
        let items: Vec<T> = if !given.is_empty() {
            given.iter().map(|s| parse(s).map_err(|e| Failure::usage(format!("{flag}: {e}")))).collect::<Result<_, _>>()?
        } else if self.interactive && default.is_empty() {
            let mut out = Vec::new();
            loop {
                let help = if out.len() < min { "required" } else { "leave blank to finish" };
                let s = inquire::Text::new(label).with_help_message(help).prompt().map_err(prompt_err)?;
                if s.trim().is_empty() {
                    if out.len() >= min {
                        break;
                    }
                    continue;
                }
                match parse(&s) {
                    Ok(v) => out.push(v),
                    Err(e) => eprintln!("  {e}"),
                }
            }
            out
        } else {
            default
        };
        if items.len() < min {
            return Err(Failure::usage(format!("missing {flag} (no terminal to prompt on)")));
        }
        Ok(items)
    }

    pub fn confirm(&self, label: &str, yes: bool) -> Result<bool, Failure> {
        if yes {
            return Ok(true);
        }
        if self.interactive {
            return inquire::Confirm::new(label).with_default(false).prompt().map_err(prompt_err);
        }
        Err(Failure::usage("pass --yes to confirm without a terminal"))
    }

    pub fn secret(&self, flag: &str, label: &str, given: Option<String>) -> Result<String, Failure> {
        if let Some(v) = given.filter(|v| !v.is_empty()) {
            return Ok(v);
        }
        if self.interactive {
            return inquire::Password::new(label).without_confirmation().prompt().map_err(prompt_err);
        }
        Err(Failure::usage(format!("missing {flag} (no terminal to prompt on)")))
    }
}
```

- [ ] **Step 6: Implement `output.rs`**

```rust
/// Human text to stderr; the result to stdout — as JSON with `--json`.
pub struct Output {
    json: bool,
}

impl Output {
    pub fn new(json: bool) -> Output {
        Output { json }
    }

    pub fn status(&self, msg: &str) {
        eprintln!("{msg}");
    }

    pub fn done(&self, human: &str, json: serde_json::Value) {
        if self.json {
            println!("{}", serde_json::to_string_pretty(&json).expect("json"));
        } else if !human.is_empty() {
            println!("{human}");
        }
    }
}
```

- [ ] **Step 7: Implement `ctx.rs`**

```rust
use std::path::PathBuf;

use hpy_atproto::session::{self, Session};
use hpy_atproto::{HttpRegistry, Settings};

use crate::failure::Failure;
use crate::output::Output;
use crate::prompt::Prompter;

pub struct Ctx {
    pub settings: Settings,
    pub prompter: Prompter,
    pub out: Output,
    pub dir: PathBuf,
}

impl Ctx {
    pub async fn session(&self) -> Result<Session, Failure> {
        session::current(&self.settings).await?.ok_or_else(Failure::not_logged_in)
    }

    pub fn registry(&self) -> HttpRegistry {
        HttpRegistry::new(&self.settings.registry_url)
    }
}
```

- [ ] **Step 8: Implement `cli.rs`** (full tree for milestone 1)

```rust
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "hpy", version, about = "The HappyProto command line", propagate_version = true)]
pub struct Cli {
    /// Print the result as JSON on stdout.
    #[arg(long, global = true)]
    pub json: bool,
    /// Never prompt; fail when a required value is missing. Implied without a terminal.
    #[arg(long, global = true)]
    pub no_input: bool,
    /// Run as if started in DIR.
    #[arg(short = 'C', global = true, value_name = "DIR")]
    pub dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Sign in to your atproto account.
    Login(LoginArgs),
    /// Sign out and forget stored credentials.
    Logout,
    /// Show who you are signed in as.
    Whoami,
    /// Manage HappyView plugins in the HappyProto registry.
    #[command(subcommand)]
    Plugin(PluginCommand),
}

#[derive(Args)]
pub struct LoginArgs {
    /// Your handle, DID, or PDS URL.
    pub identifier: Option<String>,
    /// Use an app password instead of OAuth (prompted if no value is given; also HPY_APP_PASSWORD).
    #[arg(long, num_args = 0..=1, default_missing_value = "", value_name = "PASSWORD")]
    pub app_password: Option<String>,
    /// Print the authorization URL instead of opening a browser.
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(Subcommand)]
pub enum PluginCommand {
    /// Create and maintain the plugin's registry profile.
    #[command(subcommand)]
    Profile(ProfileCommand),
    /// Publish the plugin in the current directory as a new release.
    Publish(PublishArgs),
    /// Show what the registry knows about this plugin's releases.
    Status(StatusArgs),
    /// Withdraw a published release (it stays installable by exact version).
    Withdraw(WithdrawArgs),
}

#[derive(Args, Default)]
pub struct SlugArg {
    /// Package slug (default: hpy.toml [profile] slug, then manifest.json id).
    #[arg(long)]
    pub slug: Option<String>,
}

#[derive(Subcommand)]
pub enum ProfileCommand {
    /// Write hpy.toml and create the profile on your PDS.
    Init(ProfileInitArgs),
    /// Show the profile on your PDS.
    Show(SlugArg),
    /// Edit the profile on your PDS.
    Edit(ProfileEditArgs),
    /// Copy the profile on your PDS into hpy.toml.
    Pull(SlugArg),
}

#[derive(Args, Default)]
pub struct ProfileFields {
    /// Display name.
    #[arg(long)]
    pub name: Option<String>,
    /// One-line description.
    #[arg(long)]
    pub description: Option<String>,
    /// SPDX license expression, or "proprietary".
    #[arg(long)]
    pub license: Option<String>,
    /// Author as `Name <email> (url)`; repeatable.
    #[arg(long = "author", value_name = "AUTHOR")]
    pub authors: Vec<String>,
    /// Security contact (email or URL); repeatable.
    #[arg(long = "security", value_name = "CONTACT")]
    pub security: Vec<String>,
    /// Keyword; repeatable.
    #[arg(long = "keyword", value_name = "KEYWORD")]
    pub keywords: Vec<String>,
}

#[derive(Args)]
pub struct ProfileInitArgs {
    #[command(flatten)]
    pub slug: SlugArg,
    #[command(flatten)]
    pub fields: ProfileFields,
    /// Only write hpy.toml; do not create the record.
    #[arg(long)]
    pub local_only: bool,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Args)]
pub struct ProfileEditArgs {
    #[command(flatten)]
    pub slug: SlugArg,
    /// Replace the fields given; authors/security/keywords given here are added.
    #[command(flatten)]
    pub fields: ProfileFields,
    /// Remove a keyword; repeatable.
    #[arg(long = "remove-keyword", value_name = "KEYWORD")]
    pub remove_keywords: Vec<String>,
}

#[derive(Args)]
pub struct PublishArgs {
    /// Path to the built .wasm module.
    #[arg(long)]
    pub wasm: Option<PathBuf>,
    /// Version to publish (default: hpy.toml [release] version, then manifest.json version).
    #[arg(long)]
    pub version: Option<String>,
    /// Validate and print the record without publishing.
    #[arg(long)]
    pub dry_run: bool,
    /// Skip hpy.toml [build] command.
    #[arg(long)]
    pub no_build: bool,
    /// Wait until the registry has copied the artifact.
    #[arg(long)]
    pub wait: bool,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Args)]
pub struct StatusArgs {
    /// A single version to inspect.
    pub version: Option<String>,
    #[command(flatten)]
    pub slug: SlugArg,
}

#[derive(Args)]
pub struct WithdrawArgs {
    /// The version to withdraw.
    pub version: String,
    #[command(flatten)]
    pub slug: SlugArg,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}
```

- [ ] **Step 9: Implement `commands/auth.rs`**

```rust
use hpy_atproto::session::{self, AuthMethod, SessionPointer};
use serde_json::json;

use crate::cli::LoginArgs;
use crate::ctx::Ctx;
use crate::failure::Failure;

fn describe(p: &SessionPointer) -> serde_json::Value {
    let method = match &p.method {
        AuthMethod::OAuth { .. } => "oauth",
        AuthMethod::AppPassword => "app-password",
        AuthMethod::Environment => "environment",
    };
    json!({ "did": p.did, "handle": p.handle, "pds": p.pds, "method": method })
}

fn who(p: &SessionPointer) -> String {
    match &p.handle {
        Some(h) => format!("@{h} ({})", p.did),
        None => p.did.clone(),
    }
}

pub async fn login(ctx: &Ctx, args: LoginArgs) -> Result<(), Failure> {
    let identifier = ctx.prompter.required("<IDENTIFIER>", "Handle or DID:", args.identifier, None, |s| {
        if s.trim().is_empty() { Err("required".into()) } else { Ok(()) }
    })?;
    let env_password = std::env::var("HPY_APP_PASSWORD").ok().filter(|p| !p.is_empty());
    let pointer = if args.app_password.is_some() || env_password.is_some() {
        let given = args.app_password.filter(|p| !p.is_empty()).or(env_password);
        let password = ctx.prompter.secret("--app-password", "App password:", given)?;
        session::login_app_password(&ctx.settings, &identifier, &password).await?
    } else {
        let show = |url: &str| eprintln!("Open this URL to authorize hpy:\n\n  {url}\n");
        ctx.out.status("Waiting for authorization in your browser…");
        session::login_oauth(&ctx.settings, &identifier, !args.no_browser, &show).await?
    };
    ctx.out.done(&format!("Logged in as {}", who(&pointer)), describe(&pointer));
    Ok(())
}

pub async fn logout(ctx: &Ctx) -> Result<(), Failure> {
    match session::logout(&ctx.settings).await? {
        Some(p) => ctx.out.done(&format!("Logged out {}", who(&p)), json!({ "loggedOut": p.did })),
        None => ctx.out.done("Not logged in.", json!({ "loggedOut": null })),
    }
    Ok(())
}

pub async fn whoami(ctx: &Ctx) -> Result<(), Failure> {
    if let Some((id, _)) = session::env_credentials(&|k| std::env::var(k).ok().filter(|v| !v.is_empty())) {
        ctx.out.done(&format!("{id} (from HPY_IDENTIFIER)"), json!({ "identifier": id, "method": "environment" }));
        return Ok(());
    }
    let pointer = session::read_pointer(&ctx.settings)?.ok_or_else(Failure::not_logged_in)?;
    ctx.out.done(&format!("{} on {}", who(&pointer), pointer.pds), describe(&pointer));
    Ok(())
}
```

- [ ] **Step 10: Implement `commands/mod.rs` and `main.rs`**

```rust
// commands/mod.rs
pub mod auth;
pub mod profile;
pub mod publish;
pub mod status;
pub mod withdraw;
```

(Until Tasks 9–11 land, `profile`, `publish`, `status`, `withdraw` dispatch to `Err(Failure::runtime("not implemented yet"))`; create the modules as each task arrives.)

```rust
// main.rs
mod cli;
mod commands;
mod ctx;
mod failure;
mod output;
mod prompt;
#[cfg(test)]
mod testing;

use std::process::ExitCode;

use clap::Parser;

use cli::{Cli, Command, PluginCommand, ProfileCommand};
use ctx::Ctx;
use failure::Failure;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(f) => {
            eprintln!("{:?}", f.report);
            ExitCode::from(f.code)
        }
    }
}

async fn run(cli: Cli) -> Result<(), Failure> {
    let settings = hpy_atproto::Settings::load()?;
    let dir = match cli.dir {
        Some(d) => d,
        None => std::env::current_dir().map_err(Failure::runtime)?,
    };
    let ctx = Ctx { settings, prompter: prompt::Prompter::new(cli.no_input), out: output::Output::new(cli.json), dir };
    match cli.command {
        Command::Login(a) => commands::auth::login(&ctx, a).await,
        Command::Logout => commands::auth::logout(&ctx).await,
        Command::Whoami => commands::auth::whoami(&ctx).await,
        Command::Plugin(PluginCommand::Profile(ProfileCommand::Init(a))) => commands::profile::init(&ctx, a).await,
        Command::Plugin(PluginCommand::Profile(ProfileCommand::Show(a))) => commands::profile::show(&ctx, a).await,
        Command::Plugin(PluginCommand::Profile(ProfileCommand::Edit(a))) => commands::profile::edit(&ctx, a).await,
        Command::Plugin(PluginCommand::Profile(ProfileCommand::Pull(a))) => commands::profile::pull(&ctx, a).await,
        Command::Plugin(PluginCommand::Publish(a)) => commands::publish::run(&ctx, a).await,
        Command::Plugin(PluginCommand::Status(a)) => commands::status::run(&ctx, a).await,
        Command::Plugin(PluginCommand::Withdraw(a)) => commands::withdraw::run(&ctx, a).await,
    }
}
```

- [ ] **Step 11: Run tests** — `cargo test -p hpy-cli --test cli` → 5 passed.

- [ ] **Step 12: Commit** (only if asked)

---

### Task 9: Profile commands

**Files:**
- Create: `crates/hpy/src/commands/profile.rs`, `crates/hpy/src/testing.rs`
- Modify: `crates/hpy/tests/cli.rs` (non-TTY test)

**Interfaces:**
- Consumes: `Ctx`, `Prompter`, `hpy_plugin::{config::*, profile::*, manifest::Manifest, PROFILE_NSID}`, `Repo`.
- Produces: `resolve_slug(dir, flag: Option<String>) -> Result<String, Failure>` (pub(crate), used by publish/status/withdraw), `testing::{FakeRepo, FakeRegistry}`.
- Produces: `async fn create_profile_if_absent(repo: &dyn Repo, slug: &str, profile: &Profile) -> Result<bool, Failure>` (true when created; used by publish).

- [ ] **Step 1: Write `testing.rs`** (used by Tasks 9–11)

```rust
//! In-memory `Repo` and `Registry` for command tests.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use hpy_atproto::{Error, PackageView, Registry, ReleaseView, Repo, Result, StoredRecord, WriteResult};
use serde_json::{Value, json};

#[derive(Default)]
pub struct FakeRepo {
    pub records: Mutex<BTreeMap<(String, String), (Value, String)>>,
    pub blobs: Mutex<Vec<(Vec<u8>, String)>>,
    pub fail_next_create: Mutex<bool>,
    /// When set, uploads answer this CID instead of the true one.
    pub wrong_cid: Option<String>,
    counter: Mutex<u32>,
}

pub const DID: &str = "did:plc:testuser";

impl FakeRepo {
    pub fn with(records: &[(&str, &str, Value)]) -> FakeRepo {
        let repo = FakeRepo::default();
        for (c, k, v) in records {
            repo.records.lock().unwrap().insert((c.to_string(), k.to_string()), (v.clone(), "bafyold".into()));
        }
        repo
    }

    pub fn get(&self, collection: &str, rkey: &str) -> Option<Value> {
        self.records.lock().unwrap().get(&(collection.into(), rkey.into())).map(|(v, _)| v.clone())
    }

    fn next_cid(&self) -> String {
        let mut n = self.counter.lock().unwrap();
        *n += 1;
        format!("bafyfake{n}")
    }
}

fn uri(c: &str, k: &str) -> String {
    format!("at://{DID}/{c}/{k}")
}

#[async_trait]
impl Repo for FakeRepo {
    fn did(&self) -> &str {
        DID
    }

    async fn get_record(&self, c: &str, k: &str) -> Result<Option<StoredRecord>> {
        Ok(self.records.lock().unwrap().get(&(c.into(), k.into())).map(|(v, cid)| StoredRecord {
            uri: uri(c, k),
            cid: Some(cid.clone()),
            value: v.clone(),
        }))
    }

    async fn list_records(&self, c: &str) -> Result<Vec<StoredRecord>> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|((col, _), _)| col == c)
            .map(|((col, k), (v, cid))| StoredRecord { uri: uri(col, k), cid: Some(cid.clone()), value: v.clone() })
            .collect())
    }

    async fn create_record(&self, c: &str, k: &str, record: Value) -> Result<WriteResult> {
        if std::mem::take(&mut *self.fail_next_create.lock().unwrap()) {
            return Err(Error::Other("network went away".into()));
        }
        let key = (c.to_string(), k.to_string());
        if self.records.lock().unwrap().contains_key(&key) {
            return Err(Error::Xrpc { method: "createRecord".into(), name: "RecordAlreadyExists".into(), message: None });
        }
        let cid = self.next_cid();
        self.records.lock().unwrap().insert(key, (record, cid.clone()));
        Ok(WriteResult { uri: uri(c, k), cid })
    }

    async fn put_record(&self, c: &str, k: &str, record: Value, swap: Option<&str>) -> Result<WriteResult> {
        let key = (c.to_string(), k.to_string());
        let current = self.records.lock().unwrap().get(&key).map(|(_, cid)| cid.clone());
        if let Some(swap) = swap {
            if current.as_deref() != Some(swap) {
                return Err(Error::Xrpc { method: "putRecord".into(), name: "InvalidSwap".into(), message: None });
            }
        }
        let cid = self.next_cid();
        self.records.lock().unwrap().insert(key, (record, cid.clone()));
        Ok(WriteResult { uri: uri(c, k), cid })
    }

    async fn delete_record(&self, c: &str, k: &str) -> Result<()> {
        self.records.lock().unwrap().remove(&(c.into(), k.into()));
        Ok(())
    }

    async fn upload_blob(&self, bytes: Vec<u8>, mime: &str) -> Result<Value> {
        let cid = self.wrong_cid.clone().unwrap_or_else(|| hpy_plugin::checksum::raw_cid(&bytes));
        let size = bytes.len();
        self.blobs.lock().unwrap().push((bytes, mime.into()));
        Ok(json!({ "$type": "blob", "ref": { "$link": cid }, "mimeType": mime, "size": size }))
    }
}

#[derive(Default)]
pub struct FakeRegistry {
    pub releases: Mutex<BTreeMap<String, ReleaseView>>,
    pub package: Option<PackageView>,
    pub unreachable: bool,
}

impl FakeRegistry {
    pub fn with_release(version: &str, status: &str) -> FakeRegistry {
        let reg = FakeRegistry::default();
        reg.releases.lock().unwrap().insert(
            version.into(),
            ReleaseView { uri: format!("at://{DID}/at.happyproto.plugin.release/x:{version}"), status: status.into(), record: json!({}), indexed_at: None },
        );
        reg
    }
}

#[async_trait]
impl Registry for FakeRegistry {
    async fn get_package(&self, _: &str, _: &str) -> Result<Option<PackageView>> {
        if self.unreachable {
            return Err(Error::Other("could not reach the registry".into()));
        }
        Ok(self.package.clone())
    }
    async fn get_release(&self, _: &str, _: &str, version: &str) -> Result<Option<ReleaseView>> {
        if self.unreachable {
            return Err(Error::Other("could not reach the registry".into()));
        }
        Ok(self.releases.lock().unwrap().get(version).cloned())
    }
    async fn list_releases(&self, _: &str, _: &str) -> Result<Vec<ReleaseView>> {
        if self.unreachable {
            return Err(Error::Other("could not reach the registry".into()));
        }
        Ok(self.releases.lock().unwrap().values().cloned().collect())
    }
}
```

- [ ] **Step 2: Failing tests** (bottom of `commands/profile.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRepo;
    use hpy_plugin::profile::{Author, Contact};

    fn profile() -> Profile {
        Profile {
            license: "MIT".into(),
            authors: vec![Author { name: "A".into(), ..Default::default() }],
            security: vec![Contact { email: Some("s@x.io".into()), url: None }],
            ..Profile::new_plugin()
        }
    }

    #[tokio::test]
    async fn creates_only_when_absent() {
        let repo = FakeRepo::default();
        assert!(create_profile_if_absent(&repo, "x", &profile()).await.unwrap());
        let stored = repo.get(PROFILE_NSID, "x").unwrap();
        assert_eq!(stored["license"], "MIT");
        assert!(stored["lastUpdated"].is_string());
        let mut other = profile();
        other.license = "Apache-2.0".into();
        assert!(!create_profile_if_absent(&repo, "x", &other).await.unwrap());
        assert_eq!(repo.get(PROFILE_NSID, "x").unwrap()["license"], "MIT");
    }

    #[test]
    fn apply_edits_adds_and_replaces() {
        let mut p = profile();
        p.keywords = vec!["old".into(), "keep".into()];
        let fields = ProfileFields {
            name: Some("New".into()),
            authors: vec!["B <b@x.io>".into()],
            keywords: vec!["new".into()],
            ..Default::default()
        };
        apply_edits(&mut p, &fields, &["old".to_string()]).unwrap();
        assert_eq!(p.name.as_deref(), Some("New"));
        assert_eq!(p.authors.len(), 2);
        assert_eq!(p.keywords, vec!["keep".to_string(), "new".to_string()]);
    }

    #[test]
    fn slug_resolution_order() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_slug(dir.path(), None).is_err());
        std::fs::write(dir.path().join("manifest.json"), r#"{"id":"from-manifest"}"#).unwrap();
        assert_eq!(resolve_slug(dir.path(), None).unwrap(), "from-manifest");
        std::fs::write(dir.path().join("hpy.toml"), "[profile]\nslug = \"from-toml\"\n").unwrap();
        assert_eq!(resolve_slug(dir.path(), None).unwrap(), "from-toml");
        assert_eq!(resolve_slug(dir.path(), Some("flag".into())).unwrap(), "flag");
        assert!(resolve_slug(dir.path(), Some("bad:slug".into())).is_err());
    }

    #[test]
    fn editor_toml_roundtrip() {
        let p = profile();
        let text = to_editable("x", &p).unwrap();
        assert_eq!(from_editable(&text).unwrap(), p);
        assert!(from_editable("license = 3").is_err());
    }
}
```

CLI test (Review Focus #3) appended to `tests/cli.rs`:

```rust
#[test]
fn profile_init_without_tty_names_missing_flag() {
    let config = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    std::fs::write(plugin.path().join("manifest.json"), r#"{"id":"my-plugin","name":"Mine"}"#).unwrap();
    hpy(config.path())
        .args(["plugin", "profile", "init", "--no-input", "--local-only", "-C"])
        .arg(plugin.path())
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--license"));
}

#[test]
fn profile_init_local_only_from_flags_writes_hpy_toml() {
    let config = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    std::fs::write(plugin.path().join("manifest.json"), r#"{"id":"my-plugin","name":"Mine"}"#).unwrap();
    hpy(config.path())
        .args(["plugin", "profile", "init", "--no-input", "--local-only", "--license", "MIT",
               "--author", "Ada <ada@x.io>", "--security", "sec@x.io", "-C"])
        .arg(plugin.path())
        .assert()
        .success();
    let text = std::fs::read_to_string(plugin.path().join("hpy.toml")).unwrap();
    assert!(text.contains("license = \"MIT\"") && text.contains("Ada"), "{text}");
}
```

- [ ] **Step 3: Run to verify failure** — `cargo test -p hpy-cli` → compile errors.

- [ ] **Step 4: Implement `commands/profile.rs`**

```rust
use std::path::Path;

use hpy_atproto::Repo;
use hpy_plugin::config::{self, HpyToml, ProfileConfig};
use hpy_plugin::manifest::Manifest;
use hpy_plugin::profile::{Profile, parse_author, parse_contact};
use hpy_plugin::validate::is_slug;
use hpy_plugin::PROFILE_NSID;
use serde_json::json;

use crate::cli::{ProfileEditArgs, ProfileFields, ProfileInitArgs, SlugArg};
use crate::ctx::Ctx;
use crate::failure::Failure;

fn now() -> String {
    // RFC 3339 UTC without pulling in a date crate.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub(crate) fn resolve_slug(dir: &Path, flag: Option<String>) -> Result<String, Failure> {
    let slug = match flag {
        Some(s) => s,
        None => {
            let manifest = Manifest::load(dir).ok();
            let toml = HpyToml::load(dir)?.unwrap_or_default();
            toml.slug(manifest.as_ref()).ok_or_else(|| {
                Failure::usage("no package slug: pass --slug, or run in a directory with manifest.json or hpy.toml")
            })?
        }
    };
    if !is_slug(&slug) {
        return Err(Failure::usage(format!(
            "`{slug}` is not a valid slug: 1–128 characters, a letter first, then letters, digits, `-` or `.`"
        )));
    }
    Ok(slug)
}

pub(crate) async fn create_profile_if_absent(repo: &dyn Repo, slug: &str, profile: &Profile) -> Result<bool, Failure> {
    if repo.get_record(PROFILE_NSID, slug).await?.is_some() {
        return Ok(false);
    }
    let mut p = profile.clone();
    p.last_updated = Some(now());
    repo.create_record(PROFILE_NSID, slug, p.to_record()).await?;
    Ok(true)
}

fn non_empty(s: &str) -> Result<(), String> {
    if s.trim().is_empty() { Err("required".into()) } else { Ok(()) }
}

pub async fn init(ctx: &Ctx, args: ProfileInitArgs) -> Result<(), Failure> {
    let manifest = Manifest::load(&ctx.dir).ok();
    let existing = HpyToml::load(&ctx.dir)?.and_then(|t| t.profile).unwrap_or_default();
    let p = &ctx.prompter;
    let f = args.fields;

    let default_slug = args.slug.slug.clone().or(existing.slug.clone()).or(manifest.as_ref().map(|m| m.id.clone()));
    let slug = p.required("--slug", "Package slug:", None, default_slug, |s| {
        if is_slug(s) { Ok(()) } else { Err("a letter first, then letters, digits, `-` or `.`".into()) }
    })?;
    let name = p.optional("Display name:", f.name, existing.name.clone().or(manifest.as_ref().and_then(|m| m.name.clone())))?;
    let description = p.optional(
        "One-line description:",
        f.description,
        existing.description.clone().or(manifest.as_ref().and_then(|m| m.description.clone())),
    )?;
    let license = p.required("--license", "License (SPDX, or \"proprietary\"):", f.license, existing.license.clone(), non_empty)?;
    let authors = p.list("--author", "Author (Name <email> (url)):", f.authors, existing.authors.clone(), parse_author, 1)?;
    let security = p.list("--security", "Security contact (email or URL):", f.security, existing.security.clone(), parse_contact, 1)?;
    let keywords = if f.keywords.is_empty() && p.is_interactive() && existing.keywords.is_empty() {
        p.optional("Keywords (comma-separated):", None, None)?
            .map(|s| s.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect())
            .unwrap_or_default()
    } else if f.keywords.is_empty() {
        existing.keywords.clone()
    } else {
        f.keywords
    };

    let cfg = ProfileConfig {
        slug: Some(slug.clone()),
        name,
        description,
        license: Some(license),
        keywords,
        authors,
        security,
        sections: existing.sections.clone(),
    };
    let (profile, problems) = cfg.to_profile(&ctx.dir, manifest.as_ref());
    if !problems.is_empty() {
        return Err(Failure::problems("the profile is not valid:", &problems));
    }
    config::write_profile(&ctx.dir, &cfg).map_err(Failure::runtime)?;
    ctx.out.status(&format!("Wrote {}", ctx.dir.join(config::FILE_NAME).display()));

    if args.local_only {
        ctx.out.done("", json!({ "slug": slug, "created": false, "localOnly": true }));
        return Ok(());
    }
    let session = ctx.session().await?;
    if session.repo.get_record(PROFILE_NSID, &slug).await?.is_some() {
        return Err(Failure::usage(format!(
            "a profile for `{slug}` already exists on your PDS; use `hpy plugin profile edit` or `hpy plugin profile pull`"
        )));
    }
    if !ctx.prompter.confirm(&format!("Create the `{slug}` profile on your PDS?"), args.yes)? {
        return Err(Failure::runtime("cancelled"));
    }
    create_profile_if_absent(session.repo.as_ref(), &slug, &profile).await?;
    let uri = format!("at://{}/{PROFILE_NSID}/{slug}", session.pointer.did);
    ctx.out.done(&format!("Created {uri}"), json!({ "slug": slug, "uri": uri, "created": true }));
    Ok(())
}

fn summary(slug: &str, p: &Profile) -> String {
    let mut lines = vec![format!("{} ({slug})", p.name.as_deref().unwrap_or(slug))];
    if let Some(d) = &p.description {
        lines.push(d.clone());
    }
    lines.push(format!("license:  {}", p.license));
    lines.push(format!("authors:  {}", p.authors.iter().map(|a| a.display()).collect::<Vec<_>>().join(", ")));
    lines.push(format!("security: {}", p.security.iter().map(|c| c.display()).collect::<Vec<_>>().join(", ")));
    if !p.keywords.is_empty() {
        lines.push(format!("keywords: {}", p.keywords.join(", ")));
    }
    if let Some(u) = &p.last_updated {
        lines.push(format!("updated:  {u}"));
    }
    lines.join("\n")
}

async fn fetch(ctx: &Ctx, slug_flag: Option<String>) -> Result<(String, hpy_atproto::session::Session, Profile, Option<String>), Failure> {
    let slug = resolve_slug(&ctx.dir, slug_flag)?;
    let session = ctx.session().await?;
    let stored = session.repo.get_record(PROFILE_NSID, &slug).await?.ok_or_else(|| {
        Failure::usage(format!("no profile for `{slug}` on your PDS; run `hpy plugin profile init`"))
    })?;
    let profile = Profile::from_record(stored.value).map_err(Failure::runtime)?;
    Ok((slug, session, profile, stored.cid))
}

pub async fn show(ctx: &Ctx, args: SlugArg) -> Result<(), Failure> {
    let (slug, _session, profile, _) = fetch(ctx, args.slug).await?;
    ctx.out.done(&summary(&slug, &profile), profile.to_record());
    Ok(())
}

pub(crate) fn apply_edits(p: &mut Profile, f: &ProfileFields, remove_keywords: &[String]) -> Result<(), Failure> {
    if let Some(n) = &f.name {
        p.name = Some(n.clone());
    }
    if let Some(d) = &f.description {
        p.description = Some(d.clone());
    }
    if let Some(l) = &f.license {
        p.license = l.clone();
    }
    for a in &f.authors {
        p.authors.push(parse_author(a).map_err(|e| Failure::usage(format!("--author: {e}")))?);
    }
    for c in &f.security {
        p.security.push(parse_contact(c).map_err(|e| Failure::usage(format!("--security: {e}")))?);
    }
    p.keywords.retain(|k| !remove_keywords.contains(k));
    for k in &f.keywords {
        if !p.keywords.contains(k) {
            p.keywords.push(k.clone());
        }
    }
    Ok(())
}

pub(crate) fn to_editable(slug: &str, p: &Profile) -> Result<String, Failure> {
    let mut body = p.clone();
    body.last_updated = None;
    let toml = toml::to_string_pretty(&body).map_err(Failure::runtime)?;
    Ok(format!(
        "# Editing the `{slug}` profile on your PDS. Save and close to publish the change;\n\
         # empty the file to cancel. `type` must stay \"happyview-plugin\".\n\n{toml}"
    ))
}

pub(crate) fn from_editable(text: &str) -> Result<Profile, String> {
    toml::from_str(text).map_err(|e| e.to_string())
}

fn run_editor(path: &Path) -> Result<(), Failure> {
    let editor = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| {
        if cfg!(windows) { "notepad".into() } else { "vi".into() }
    });
    let status = if cfg!(windows) {
        std::process::Command::new(&editor).arg(path).status()
    } else {
        std::process::Command::new("sh").arg("-c").arg(format!("{editor} \"$1\"")).arg("sh").arg(path).status()
    }
    .map_err(|e| Failure::runtime(format!("could not start `{editor}`: {e}")))?;
    if !status.success() {
        return Err(Failure::runtime(format!("`{editor}` exited with {status}")));
    }
    Ok(())
}

pub async fn edit(ctx: &Ctx, args: ProfileEditArgs) -> Result<(), Failure> {
    let (slug, session, mut profile, cid) = fetch(ctx, args.slug.slug).await?;
    let f = &args.fields;
    let has_flags = f.name.is_some() || f.description.is_some() || f.license.is_some()
        || !f.authors.is_empty() || !f.security.is_empty() || !f.keywords.is_empty() || !args.remove_keywords.is_empty();

    if has_flags {
        apply_edits(&mut profile, f, &args.remove_keywords)?;
        let problems = profile.problems();
        if !problems.is_empty() {
            return Err(Failure::problems("the edited profile is not valid:", &problems));
        }
    } else {
        if !ctx.prompter.is_interactive() {
            return Err(Failure::usage("pass field flags (e.g. --name, --license) to edit without a terminal"));
        }
        let path = std::env::temp_dir().join(format!("hpy-profile-{slug}-{}.toml", std::process::id()));
        std::fs::write(&path, to_editable(&slug, &profile)?).map_err(Failure::runtime)?;
        profile = loop {
            run_editor(&path)?;
            let text = std::fs::read_to_string(&path).map_err(Failure::runtime)?;
            if text.lines().all(|l| l.trim().is_empty() || l.trim_start().starts_with('#')) {
                let _ = std::fs::remove_file(&path);
                return Err(Failure::runtime("cancelled"));
            }
            let problems = match from_editable(&text) {
                Ok(p) => {
                    let problems = p.problems();
                    if problems.is_empty() {
                        break p;
                    }
                    problems.iter().map(|p| p.to_string()).collect::<Vec<_>>()
                }
                Err(e) => vec![e],
            };
            for p in &problems {
                eprintln!("  • {p}");
            }
            if !ctx.prompter.confirm("The profile is not valid. Edit again?", false)? {
                let _ = std::fs::remove_file(&path);
                return Err(Failure::runtime("cancelled"));
            }
        };
        let _ = std::fs::remove_file(&path);
    }

    profile.last_updated = Some(now());
    let result = session
        .repo
        .put_record(PROFILE_NSID, &slug, profile.to_record(), cid.as_deref())
        .await
        .map_err(|e| match &e {
            hpy_atproto::Error::Xrpc { name, .. } if name.contains("InvalidSwap") => {
                Failure::runtime("the profile changed on your PDS while you were editing; run the edit again")
            }
            _ => Failure::from(e),
        })?;
    ctx.out.done(&format!("Updated {}", result.uri), json!({ "uri": result.uri, "cid": result.cid }));
    Ok(())
}

pub async fn pull(ctx: &Ctx, args: SlugArg) -> Result<(), Failure> {
    let (slug, _session, profile, _) = fetch(ctx, args.slug).await?;
    let mut cfg = ProfileConfig::from_profile(&slug, &profile);
    // Keep section file paths the author already chose: write the PDS text into them.
    if let Some(existing) = HpyToml::load(&ctx.dir)?.and_then(|t| t.profile) {
        use hpy_plugin::config::SectionSource;
        let pairs = [
            (&existing.sections.description, &mut cfg.sections.description),
            (&existing.sections.installation, &mut cfg.sections.installation),
            (&existing.sections.changelog, &mut cfg.sections.changelog),
            (&existing.sections.security, &mut cfg.sections.security),
        ];
        for (old, new) in pairs {
            if let (Some(SectionSource::Path(path)), Some(SectionSource::Inline { text })) = (old, new.as_ref()) {
                std::fs::write(ctx.dir.join(path), text).map_err(Failure::runtime)?;
                *new = Some(SectionSource::Path(path.clone()));
            }
        }
    }
    config::write_profile(&ctx.dir, &cfg).map_err(Failure::runtime)?;
    ctx.out.done(
        &format!("Wrote the `{slug}` profile to {}", ctx.dir.join(config::FILE_NAME).display()),
        json!({ "slug": slug, "path": ctx.dir.join(config::FILE_NAME) }),
    );
    Ok(())
}
```

- [ ] **Step 5: Run tests** — `cargo test -p hpy-cli` → all pass.

- [ ] **Step 6: Commit** (only if asked)

---

### Task 10: Publish

**Files:**
- Create: `crates/hpy/src/commands/publish.rs`
- Modify: `crates/hpy/tests/cli.rs` (dry-run test)

**Interfaces:**
- Consumes: everything in `hpy_plugin`, `Repo`, `Registry`, `create_profile_if_absent`, `resolve_slug`.
- Produces: `Prepared { slug, version, release: Release, wasm: Vec<u8>, images: Vec<(Vec<u8>, &'static str)>, profile: Result<Profile, Vec<Problem>> }`, `prepare(dir, opts: &PrepareOptions, build: &mut dyn FnMut(&str) -> Result<(), String>) -> Result<Prepared, Failure>`, `PrepareOptions { wasm: Option<PathBuf>, version: Option<String>, no_build: bool }`, `trait Ui { fn warn(&self, msg: &str); fn progress(&self, msg: &str); fn confirm(&self, summary: &str) -> Result<bool, Failure>; }`, `execute(p: &Prepared, repo: &dyn Repo, registry: &dyn Registry, ui: &dyn Ui, dry_run: bool) -> Result<Outcome, Failure>`, `enum Outcome { DryRun(Value), Published { uri: String, cid: String, created_profile: bool } }`.

- [ ] **Step 1: Failing tests** (bottom of `publish.rs`) — includes Review Focus #2 and #5

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FakeRegistry, FakeRepo};
    use std::cell::RefCell;

    const WASM: &[u8] = b"\0asm\x01\0\0\0";

    struct TestUi {
        answer: bool,
        warnings: RefCell<Vec<String>>,
    }
    impl Ui for TestUi {
        fn warn(&self, m: &str) { self.warnings.borrow_mut().push(m.into()); }
        fn progress(&self, _: &str) {}
        fn confirm(&self, _: &str) -> Result<bool, Failure> { Ok(self.answer) }
    }
    fn ui() -> TestUi { TestUi { answer: true, warnings: RefCell::new(vec![]) } }

    fn plugin_dir(version: &str, with_profile: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("manifest.json"),
            format!(r#"{{"id":"my-plugin","name":"Mine","version":"{version}","api_version":"2","plugin_type":"library","namespace":"my.plugin","capabilities":[],"wasm_file":"my-plugin.wasm"}}"#),
        ).unwrap();
        std::fs::write(dir.path().join("my-plugin.wasm"), WASM).unwrap();
        if with_profile {
            std::fs::write(dir.path().join("hpy.toml"), "[profile]\nlicense = \"MIT\"\nauthors = [{ name = \"Ada\" }]\nsecurity = [{ email = \"s@x.io\" }]\n\n[release.requires]\n\"env:happyview\" = \">=3.0.0\"\n").unwrap();
        }
        dir
    }

    fn opts() -> PrepareOptions { PrepareOptions { wasm: None, version: None, no_build: true } }
    fn no_build() -> impl FnMut(&str) -> Result<(), String> { |_| Ok(()) }

    #[test]
    fn prepare_collects_every_problem() {
        let dir = plugin_dir("1.0.0+abc", false);
        std::fs::write(dir.path().join("hpy.toml"), "[release.requires]\nnope = \"^1 || ^2\"\n").unwrap();
        let err = prepare(dir.path(), &opts(), &mut no_build()).err().unwrap();
        let text = format!("{:?}", err.report);
        assert_eq!(err.code, 2);
        assert!(text.contains("build metadata"), "{text}");
        assert!(text.contains("release.requires"), "{text}");
    }

    #[test]
    fn prepare_rejects_v_prefix_from_manifest() {
        let dir = plugin_dir("v1.0.0", true);
        let err = prepare(dir.path(), &opts(), &mut no_build()).err().unwrap();
        assert!(format!("{:?}", err.report).contains("`v`"));
    }

    #[test]
    fn version_flag_overrides_manifest() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &PrepareOptions { version: Some("1.1.0".into()), ..opts() }, &mut no_build()).unwrap();
        assert_eq!(p.version, "1.1.0");
        assert_eq!(p.release.rkey(), "my-plugin:1.1.0");
    }

    #[test]
    fn build_command_runs_unless_disabled() {
        let dir = plugin_dir("1.0.0", true);
        std::fs::write(dir.path().join("hpy.toml"), "[profile]\nlicense = \"MIT\"\nauthors = [{ name = \"Ada\" }]\nsecurity = [{ email = \"s@x.io\" }]\n[build]\ncommand = \"make wasm\"\n").unwrap();
        let mut ran = vec![];
        prepare(dir.path(), &PrepareOptions { no_build: false, ..opts() }, &mut |c: &str| { ran.push(c.to_string()); Ok(()) }).unwrap();
        assert_eq!(ran, ["make wasm"]);
        let err = prepare(dir.path(), &PrepareOptions { no_build: false, ..opts() }, &mut |_: &str| Err("exit 1".into())).err().unwrap();
        assert!(format!("{:?}", err.report).contains("make wasm"));
    }

    #[tokio::test]
    async fn happy_path_creates_profile_uploads_and_records() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::default();
        let out = execute(&p, &repo, &FakeRegistry::default(), &ui(), false).await.unwrap();
        let Outcome::Published { uri, created_profile, .. } = out else { panic!() };
        assert!(created_profile);
        assert!(uri.ends_with("/at.happyproto.plugin.release/my-plugin:1.0.0"));
        assert_eq!(repo.blobs.lock().unwrap().len(), 1);
        let rec = repo.get("at.happyproto.plugin.release", "my-plugin:1.0.0").unwrap();
        assert_eq!(rec["artifacts"]["package"]["checksum"], hpy_plugin::checksum::checksum(WASM));
        assert_eq!(rec["requires"]["env:happyview"], ">=3.0.0");
        assert!(repo.get("at.happyproto.plugin.profile", "my-plugin").is_some());
    }

    #[tokio::test]
    async fn existing_profile_is_untouched() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::with(&[("at.happyproto.plugin.profile", "my-plugin", serde_json::json!({"license": "Apache-2.0"}))]);
        let Outcome::Published { created_profile, .. } = execute(&p, &repo, &FakeRegistry::default(), &ui(), false).await.unwrap() else { panic!() };
        assert!(!created_profile);
        assert_eq!(repo.get("at.happyproto.plugin.profile", "my-plugin").unwrap()["license"], "Apache-2.0");
    }

    #[tokio::test]
    async fn no_profile_anywhere_points_at_init() {
        let dir = plugin_dir("1.0.0", false);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let err = execute(&p, &FakeRepo::default(), &FakeRegistry::default(), &ui(), false).await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("profile init"));
    }

    #[tokio::test]
    async fn already_published_is_refused_before_upload() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::with(&[("at.happyproto.plugin.release", "my-plugin:1.0.0", serde_json::json!({}))]);
        let err = execute(&p, &repo, &FakeRegistry::default(), &ui(), false).await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("immutable"));
        assert!(repo.blobs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn withdrawn_version_is_refused() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let err = execute(&p, &FakeRepo::default(), &FakeRegistry::with_release("1.0.0", "deleted"), &ui(), false).await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("withdrawn"));
    }

    #[tokio::test]
    async fn unreachable_registry_warns_and_continues() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let reg = FakeRegistry { unreachable: true, ..Default::default() };
        let u = ui();
        execute(&p, &FakeRepo::default(), &reg, &u, false).await.unwrap();
        assert!(u.warnings.borrow().iter().any(|w| w.contains("registry")));
    }

    #[tokio::test]
    async fn cid_mismatch_aborts_before_record() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo { wrong_cid: Some(hpy_plugin::checksum::raw_cid(b"other")), ..Default::default() };
        let err = execute(&p, &repo, &FakeRegistry::default(), &ui(), false).await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("checksum"));
        assert!(repo.get("at.happyproto.plugin.release", "my-plugin:1.0.0").is_none());
    }

    #[tokio::test]
    async fn interrupted_publish_can_be_rerun() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::default();
        *repo.fail_next_create.lock().unwrap() = true;
        // first create is the profile; make the release create fail instead
        repo.records.lock().unwrap().insert(
            ("at.happyproto.plugin.profile".into(), "my-plugin".into()),
            (serde_json::json!({"license": "MIT"}), "bafyp".into()),
        );
        assert!(execute(&p, &repo, &FakeRegistry::default(), &ui(), false).await.is_err());
        assert!(repo.get("at.happyproto.plugin.release", "my-plugin:1.0.0").is_none());
        execute(&p, &repo, &FakeRegistry::default(), &ui(), false).await.unwrap();
        assert!(repo.get("at.happyproto.plugin.release", "my-plugin:1.0.0").is_some());
    }

    #[tokio::test]
    async fn dry_run_writes_nothing_and_cancel_writes_nothing() {
        let dir = plugin_dir("1.0.0", true);
        let p = prepare(dir.path(), &opts(), &mut no_build()).unwrap();
        let repo = FakeRepo::default();
        let Outcome::DryRun(record) = execute(&p, &repo, &FakeRegistry::default(), &ui(), true).await.unwrap() else { panic!() };
        assert_eq!(record["version"], "1.0.0");
        assert!(repo.records.lock().unwrap().is_empty() && repo.blobs.lock().unwrap().is_empty());
        let no = TestUi { answer: false, warnings: RefCell::new(vec![]) };
        assert!(execute(&p, &repo, &FakeRegistry::default(), &no, false).await.is_err());
        assert!(repo.records.lock().unwrap().is_empty());
    }
}
```

CLI test appended to `tests/cli.rs` (dry run needs a session only for repo checks; without one it exits 3 — assert that, since `--dry-run` still checks the PDS for an existing release):

```rust
#[test]
fn publish_validation_errors_exit_2_before_login() {
    let config = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    std::fs::write(plugin.path().join("manifest.json"), r#"{"id":"p","version":"1.0.0+meta","api_version":"2","plugin_type":"library","namespace":"p","capabilities":[]}"#).unwrap();
    std::fs::write(plugin.path().join("p.wasm"), b"\0asm\x01\0\0\0").unwrap();
    hpy(config.path())
        .args(["plugin", "publish", "--no-input", "--wasm"])
        .arg(plugin.path().join("p.wasm"))
        .arg("-C").arg(plugin.path())
        .assert()
        .code(2)
        .stderr(predicate::str::contains("build metadata"));
}
```

- [ ] **Step 2: Run to verify failure** — compile errors.

- [ ] **Step 3: Implement `publish.rs`**

```rust
use std::path::{Path, PathBuf};
use std::time::Duration;

use hpy_atproto::{Registry, Repo};
use hpy_plugin::artifact::{WASM_MIME, inspect_image, wasm_problem};
use hpy_plugin::checksum::same_digest;
use hpy_plugin::config::{HpyToml, ImageConfig};
use hpy_plugin::locate::locate_wasm;
use hpy_plugin::manifest::Manifest;
use hpy_plugin::profile::Profile;
use hpy_plugin::release::{Artifact, ImageArtifact, Release, requires_problems};
use hpy_plugin::validate::{is_slug, version_problem};
use hpy_plugin::{PROFILE_NSID, Problem, RELEASE_NSID};
use serde_json::{Value, json};

use crate::cli::PublishArgs;
use crate::commands::profile::create_profile_if_absent;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub struct PrepareOptions {
    pub wasm: Option<PathBuf>,
    pub version: Option<String>,
    pub no_build: bool,
}

pub struct Prepared {
    pub slug: String,
    pub version: String,
    pub release: Release,
    pub wasm: Vec<u8>,
    pub wasm_path: PathBuf,
    /// Image bytes in record order: icon, banner, screenshots.
    pub images: Vec<(Vec<u8>, &'static str)>,
    /// The profile `hpy.toml` describes, used only when the PDS has none.
    pub profile: Result<Profile, Vec<Problem>>,
}

pub enum Outcome {
    DryRun(Value),
    Published { uri: String, cid: String, created_profile: bool },
}

pub trait Ui {
    fn warn(&self, msg: &str);
    fn progress(&self, msg: &str);
    fn confirm(&self, summary: &str) -> Result<bool, Failure>;
}

fn load_image(dir: &Path, cfg: &ImageConfig, path: &str, problems: &mut Vec<Problem>) -> Option<(ImageArtifact, Vec<u8>, &'static str)> {
    let bytes = match std::fs::read(dir.join(&cfg.path)) {
        Ok(b) => b,
        Err(e) => {
            problems.push(Problem::new(path, format!("cannot read `{}`: {e}", cfg.path)));
            return None;
        }
    };
    match inspect_image(&bytes) {
        Ok(info) => Some((
            ImageArtifact { artifact: Artifact::from_bytes(&bytes, info.mime), width: info.width, height: info.height, alt: cfg.alt.clone() },
            bytes,
            info.mime,
        )),
        Err(e) => {
            problems.push(Problem::new(path, format!("`{}` {e}", cfg.path)));
            None
        }
    }
}

/// Reads and validates everything locally. Every problem is reported at once.
pub fn prepare(dir: &Path, opts: &PrepareOptions, build: &mut dyn FnMut(&str) -> Result<(), String>) -> Result<Prepared, Failure> {
    let manifest = Manifest::load(dir)?;
    let toml = HpyToml::load(dir)?.unwrap_or_default();
    let release_cfg = toml.release.clone().unwrap_or_default();
    let mut problems = manifest.extension_problems();

    let slug = toml.slug(Some(&manifest)).unwrap_or_default();
    if !is_slug(&slug) {
        problems.push(Problem::new("slug", format!("`{slug}` is not a valid slug")));
    }
    let version = opts.version.clone().or(release_cfg.version.clone()).or(manifest.version.clone());
    let version = match version {
        Some(v) => {
            if let Some(p) = version_problem(&v) {
                problems.push(Problem::new("version", p));
            }
            v
        }
        None => {
            problems.push(Problem::new("version", "none given: pass --version or set `version` in manifest.json"));
            String::new()
        }
    };
    problems.extend(requires_problems(&release_cfg.requires));
    if release_cfg.artifacts.screenshots.len() > 8 {
        problems.push(Problem::new("release.artifacts.screenshots", "at most 8 screenshots"));
    }

    let mut images = Vec::new();
    let mut load = |cfg: &ImageConfig, path: String, problems: &mut Vec<Problem>| {
        load_image(dir, cfg, &path, problems).map(|(art, bytes, mime)| {
            images.push((bytes, mime));
            art
        })
    };
    let a = &release_cfg.artifacts;
    let icon = a.icon.as_ref().and_then(|c| load(c, "release.artifacts.icon".into(), &mut problems));
    let banner = a.banner.as_ref().and_then(|c| load(c, "release.artifacts.banner".into(), &mut problems));
    let screenshots: Vec<_> = a
        .screenshots
        .iter()
        .enumerate()
        .filter_map(|(i, c)| load(c, format!("release.artifacts.screenshots[{i}]"), &mut problems))
        .collect();

    if !problems.is_empty() {
        return Err(Failure::problems("cannot publish:", &problems));
    }

    let build_cfg = toml.build.clone().unwrap_or_default();
    if let (Some(cmd), false) = (&build_cfg.command, opts.no_build) {
        build(cmd).map_err(|e| Failure::runtime(format!("build command `{cmd}` failed: {e}")))?;
    }
    let wasm_path = locate_wasm(dir, opts.wasm.as_deref(), build_cfg.wasm.as_deref(), &manifest).map_err(Failure::usage)?;
    let wasm = std::fs::read(&wasm_path).map_err(|e| Failure::runtime(format!("cannot read {}: {e}", wasm_path.display())))?;
    if let Some(p) = wasm_problem(&wasm) {
        return Err(Failure::usage(format!("{} {p}", wasm_path.display())));
    }

    let profile = match &toml.profile {
        Some(cfg) => match cfg.to_profile(dir, Some(&manifest)) {
            (p, problems) if problems.is_empty() => Ok(p),
            (_, problems) => Err(problems),
        },
        None => Err(vec![Problem::new("hpy.toml", "has no [profile] table")]),
    };

    let release = Release {
        slug: slug.clone(),
        version: version.clone(),
        repo: release_cfg.repo.clone(),
        requires: release_cfg.requires.clone(),
        extension: manifest.extension(),
        package: Artifact::from_bytes(&wasm, WASM_MIME),
        icon,
        banner,
        screenshots,
    };
    Ok(Prepared { slug, version, release, wasm, wasm_path, images, profile })
}

fn summary(p: &Prepared) -> String {
    let e = &p.release.extension;
    let mut lines = vec![
        format!("Publishing {} {}", p.slug, p.version),
        format!("  module:       {} ({} bytes)", p.wasm_path.display(), p.wasm.len()),
        format!("  checksum:     {}", p.release.package.checksum),
        format!("  type:         {} (api {})", e.plugin_type, e.api_version),
        format!("  capabilities: {}", if e.capabilities.is_empty() { "none".into() } else { e.capabilities.join(", ") }),
    ];
    if !p.release.requires.is_empty() {
        let reqs: Vec<String> = p.release.requires.iter().map(|(k, v)| format!("{k} {v}")).collect();
        lines.push(format!("  requires:     {}", reqs.join(", ")));
    }
    if !p.images.is_empty() {
        lines.push(format!("  images:       {}", p.images.len()));
    }
    lines.push("Releases are immutable: this version can never be changed or reused.".into());
    lines.join("\n")
}

async fn upload_checked(repo: &dyn Repo, bytes: &[u8], mime: &str, expected: &Artifact) -> Result<Value, Failure> {
    let blob = repo.upload_blob(bytes.to_vec(), mime).await?;
    let cid = blob["ref"]["$link"].as_str().unwrap_or_default();
    if !same_digest(cid, &expected.checksum) {
        return Err(Failure::runtime(format!(
            "your PDS stored the upload as {cid}, which does not match its checksum {}; nothing was published",
            expected.checksum
        )));
    }
    Ok(blob)
}

pub async fn execute(p: &Prepared, repo: &dyn Repo, registry: &dyn Registry, ui: &dyn Ui, dry_run: bool) -> Result<Outcome, Failure> {
    let rkey = p.release.rkey();
    if repo.get_record(RELEASE_NSID, &rkey).await?.is_some() {
        return Err(Failure::usage(format!(
            "{} {} is already published; releases are immutable, so bump the version",
            p.slug, p.version
        )));
    }
    match registry.get_release(repo.did(), &p.slug, &p.version).await {
        Ok(Some(view)) if view.status == "deleted" => {
            return Err(Failure::usage(format!(
                "{} {} was withdrawn, and withdrawn versions can never be republished; bump the version",
                p.slug, p.version
            )));
        }
        Ok(_) => {}
        Err(e) => ui.warn(&format!("could not check the registry ({e}); continuing")),
    }
    let needs_profile = repo.get_record(PROFILE_NSID, &p.slug).await?.is_none();
    if needs_profile {
        if let Err(problems) = &p.profile {
            return Err(Failure::problems(
                &format!("`{}` has no profile on your PDS, and hpy.toml cannot create one; run `hpy plugin profile init`:", p.slug),
                problems,
            ));
        }
    }

    if dry_run {
        return Ok(Outcome::DryRun(p.release.to_record()));
    }
    let mut text = summary(p);
    if needs_profile {
        text.push_str(&format!("\nThe `{}` profile will be created from hpy.toml.", p.slug));
    }
    if !ui.confirm(&text)? {
        return Err(Failure::runtime("cancelled"));
    }

    let mut created_profile = false;
    if needs_profile {
        if let Ok(profile) = &p.profile {
            created_profile = create_profile_if_absent(repo, &p.slug, profile).await?;
        }
    }

    ui.progress("Uploading module…");
    let mut release = p.release.clone();
    release.package.blob = Some(upload_checked(repo, &p.wasm, WASM_MIME, &p.release.package).await?);
    let mut image_targets: Vec<&mut ImageArtifact> = Vec::new();
    image_targets.extend(release.icon.as_mut());
    image_targets.extend(release.banner.as_mut());
    image_targets.extend(release.screenshots.iter_mut());
    for (target, (bytes, mime)) in image_targets.into_iter().zip(&p.images) {
        ui.progress("Uploading image…");
        target.artifact.blob = Some(upload_checked(repo, bytes, mime, &target.artifact).await?);
    }

    let written = repo.create_record(RELEASE_NSID, &rkey, release.to_record()).await?;
    Ok(Outcome::Published { uri: written.uri, cid: written.cid, created_profile })
}

struct TerminalUi<'a>(&'a Ctx, bool);

impl Ui for TerminalUi<'_> {
    fn warn(&self, msg: &str) {
        self.0.out.status(&format!("warning: {msg}"));
    }
    fn progress(&self, msg: &str) {
        self.0.out.status(msg);
    }
    fn confirm(&self, summary: &str) -> Result<bool, Failure> {
        self.0.out.status(summary);
        self.0.prompter.confirm("Publish?", self.1)
    }
}

fn run_build(dir: &Path) -> impl FnMut(&str) -> Result<(), String> + '_ {
    move |cmd: &str| {
        eprintln!("$ {cmd}");
        let status = if cfg!(windows) {
            std::process::Command::new("cmd").arg("/C").arg(cmd).current_dir(dir).status()
        } else {
            std::process::Command::new("sh").arg("-c").arg(cmd).current_dir(dir).status()
        }
        .map_err(|e| e.to_string())?;
        if status.success() { Ok(()) } else { Err(format!("exited with {status}")) }
    }
}

pub async fn run(ctx: &Ctx, args: PublishArgs) -> Result<(), Failure> {
    let opts = PrepareOptions { wasm: args.wasm.clone(), version: args.version.clone(), no_build: args.no_build };
    let prepared = prepare(&ctx.dir, &opts, &mut run_build(&ctx.dir))?;
    let session = ctx.session().await?;
    let registry = ctx.registry();
    let ui = TerminalUi(ctx, args.yes);
    match execute(&prepared, session.repo.as_ref(), &registry, &ui, args.dry_run).await? {
        Outcome::DryRun(record) => {
            ctx.out.status(&summary(&prepared));
            ctx.out.done(&serde_json::to_string_pretty(&record).unwrap(), json!({ "dryRun": true, "record": record }));
        }
        Outcome::Published { uri, cid, created_profile } => {
            if created_profile {
                ctx.out.status(&format!("Created the `{}` profile", prepared.slug));
            }
            ctx.out.status(&format!("Published {uri}"));
            let mut status = None;
            if args.wait {
                status = Some(wait_for_active(ctx, &registry, session.repo.did(), &prepared).await);
            }
            ctx.out.done(
                &format!("{} {} published", prepared.slug, prepared.version),
                json!({ "uri": uri, "cid": cid, "createdProfile": created_profile, "registryStatus": status }),
            );
        }
    }
    Ok(())
}

async fn wait_for_active(ctx: &Ctx, registry: &dyn Registry, did: &str, p: &Prepared) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(Some(view)) = registry.get_release(did, &p.slug, &p.version).await {
            if view.status != last {
                ctx.out.status(&format!("registry: {}", view.status));
                last = view.status.clone();
            }
            if view.status == "active" {
                return last;
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    ctx.out.status("still not active after 2 minutes; check later with `hpy plugin status`");
    if last.is_empty() { "unknown".into() } else { last }
}
```

Note: `Release` must `#[derive(Clone)]` (already in Task 5).

- [ ] **Step 4: Run tests** — `cargo test -p hpy-cli` → all pass.

- [ ] **Step 5: Commit** (only if asked)

---

### Task 11: Status and withdraw

**Files:**
- Create: `crates/hpy/src/commands/status.rs`, `crates/hpy/src/commands/withdraw.rs`

**Interfaces:**
- Consumes: `resolve_slug`, `Repo`, `Registry`, `release_rkey`, `rkey_of`.
- Produces: `status::rows(slug, mine: Vec<StoredRecord>, registry: Result<Vec<ReleaseView>, Error>) -> Vec<Row>` with `Row { version: String, registry: String, in_repo: bool }` sorted by semver, newest first; `withdraw::withdraw(repo, slug, version) -> Result<(), Failure>`.

- [ ] **Step 1: Failing tests** — `status.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use hpy_atproto::{ReleaseView, StoredRecord};

    fn mine(v: &str) -> StoredRecord {
        StoredRecord { uri: format!("at://did:plc:x/at.happyproto.plugin.release/p:{v}"), cid: None, value: serde_json::json!({}) }
    }
    fn view(v: &str, s: &str) -> ReleaseView {
        ReleaseView { uri: format!("at://did:plc:x/at.happyproto.plugin.release/p:{v}"), status: s.into(), record: serde_json::json!({}), indexed_at: None }
    }

    #[test]
    fn merges_and_sorts() {
        let rows = rows(
            "p",
            vec![mine("1.10.0"), mine("1.9.0"), mine("2.0.0-rc.1")],
            Ok(vec![view("1.9.0", "active"), view("1.8.0", "deleted")]),
        );
        let got: Vec<_> = rows.iter().map(|r| (r.version.as_str(), r.registry.as_str(), r.in_repo)).collect();
        assert_eq!(got, [
            ("2.0.0-rc.1", "not indexed", true),
            ("1.10.0", "not indexed", true),
            ("1.9.0", "active", true),
            ("1.8.0", "deleted", false),
        ]);
    }

    #[test]
    fn other_packages_are_ignored_and_unreachable_registry_is_marked() {
        let other = StoredRecord { uri: "at://did:plc:x/at.happyproto.plugin.release/q:1.0.0".into(), cid: None, value: serde_json::json!({}) };
        let rows = rows("p", vec![mine("1.0.0"), other], Err(hpy_atproto::Error::Other("down".into())));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].registry, "unknown");
    }
}
```

`withdraw.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRepo;

    #[tokio::test]
    async fn deletes_existing_and_refuses_missing() {
        let repo = FakeRepo::with(&[("at.happyproto.plugin.release", "p:1.0.0", serde_json::json!({}))]);
        withdraw(&repo, "p", "1.0.0").await.unwrap();
        assert!(repo.get("at.happyproto.plugin.release", "p:1.0.0").is_none());
        let err = withdraw(&repo, "p", "1.0.0").await.err().unwrap();
        assert!(format!("{:?}", err.report).contains("not published"));
    }
}
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `status.rs`**

```rust
use hpy_atproto::{Registry, ReleaseView, Repo, StoredRecord, rkey_of};
use hpy_plugin::RELEASE_NSID;
use serde_json::json;

use crate::cli::StatusArgs;
use crate::commands::profile::resolve_slug;
use crate::ctx::Ctx;
use crate::failure::Failure;

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub version: String,
    pub registry: String,
    pub in_repo: bool,
}

fn version_of<'a>(slug: &str, uri: &'a str) -> Option<&'a str> {
    rkey_of(uri).strip_prefix(slug)?.strip_prefix(':')
}

pub fn rows(slug: &str, mine: Vec<StoredRecord>, registry: Result<Vec<ReleaseView>, hpy_atproto::Error>) -> Vec<Row> {
    let reachable = registry.is_ok();
    let views = registry.unwrap_or_default();
    let mut out: Vec<Row> = Vec::new();
    for r in &mine {
        if let Some(v) = version_of(slug, &r.uri) {
            let status = views.iter().find(|x| version_of(slug, &x.uri) == Some(v)).map(|x| x.status.clone());
            out.push(Row {
                version: v.into(),
                registry: status.unwrap_or_else(|| if reachable { "not indexed".into() } else { "unknown".into() }),
                in_repo: true,
            });
        }
    }
    for x in &views {
        if let Some(v) = version_of(slug, &x.uri) {
            if !out.iter().any(|r| r.version == v) {
                out.push(Row { version: v.into(), registry: x.status.clone(), in_repo: false });
            }
        }
    }
    out.sort_by(|a, b| match (semver::Version::parse(&a.version), semver::Version::parse(&b.version)) {
        (Ok(x), Ok(y)) => y.cmp(&x),
        _ => b.version.cmp(&a.version),
    });
    out
}

pub async fn run(ctx: &Ctx, args: StatusArgs) -> Result<(), Failure> {
    let slug = resolve_slug(&ctx.dir, args.slug.slug)?;
    let session = ctx.session().await?;
    let registry = ctx.registry();
    let did = session.repo.did().to_string();
    let package = registry.get_package(&did, &slug).await;
    let mut rows = rows(
        &slug,
        session.repo.list_records(RELEASE_NSID).await?,
        registry.list_releases(&did, &slug).await,
    );
    if let Some(v) = &args.version {
        rows.retain(|r| &r.version == v);
        if rows.is_empty() {
            return Err(Failure::usage(format!("{slug} {v} is neither in your repo nor in the registry")));
        }
    }
    let package_status = match &package {
        Ok(Some(p)) => format!("{} (latest: {})", p.status, p.latest_version.as_deref().unwrap_or("none active")),
        Ok(None) => "not indexed".into(),
        Err(e) => format!("unknown ({e})"),
    };
    let mut human = vec![format!("{slug}: {package_status}")];
    for r in &rows {
        let note = match (r.in_repo, r.registry.as_str()) {
            (true, "not indexed") => "  ← the registry refused it or has not seen it yet",
            (true, "pending") => "  ← indexed; artifact not copied yet",
            (false, _) => "  (no longer in your repo)",
            _ => "",
        };
        human.push(format!("  {:<16} {:<12}{note}", r.version, r.registry));
    }
    if rows.is_empty() {
        human.push("  no releases".into());
    }
    let json_rows: Vec<_> = rows.iter().map(|r| json!({ "version": r.version, "registry": r.registry, "inRepo": r.in_repo })).collect();
    ctx.out.done(&human.join("\n"), json!({ "slug": slug, "package": package_status, "releases": json_rows }));
    Ok(())
}
```

Add `semver.workspace = true` to `crates/hpy/Cargo.toml`.

- [ ] **Step 4: Implement `withdraw.rs`**

```rust
use hpy_atproto::Repo;
use hpy_plugin::RELEASE_NSID;
use hpy_plugin::release::release_rkey;
use serde_json::json;

use crate::cli::WithdrawArgs;
use crate::commands::profile::resolve_slug;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub async fn withdraw(repo: &dyn Repo, slug: &str, version: &str) -> Result<(), Failure> {
    let rkey = release_rkey(slug, version);
    if repo.get_record(RELEASE_NSID, &rkey).await?.is_none() {
        return Err(Failure::usage(format!("{slug} {version} is not published from your account")));
    }
    repo.delete_record(RELEASE_NSID, &rkey).await?;
    Ok(())
}

pub async fn run(ctx: &Ctx, args: WithdrawArgs) -> Result<(), Failure> {
    let slug = resolve_slug(&ctx.dir, args.slug.slug)?;
    let session = ctx.session().await?;
    ctx.out.status(&format!(
        "Withdrawing {slug} {v} removes it from search and dependency resolution. It stays installable by exact\n\
         version, and {v} can NEVER be published again.",
        v = args.version
    ));
    if !args.yes {
        if !ctx.prompter.is_interactive() {
            return Err(Failure::usage("pass --yes to withdraw without a terminal"));
        }
        let typed = inquire::Text::new(&format!("Type {} to confirm:", args.version))
            .prompt()
            .map_err(|_| Failure::runtime("cancelled"))?;
        if typed.trim() != args.version {
            return Err(Failure::runtime("cancelled"));
        }
    }
    withdraw(session.repo.as_ref(), &slug, &args.version).await?;
    ctx.out.done(&format!("Withdrew {slug} {}", args.version), json!({ "slug": slug, "version": args.version, "withdrawn": true }));
    Ok(())
}
```

- [ ] **Step 5: Run full suite** — `cargo test --workspace` → all pass; `cargo clippy --workspace --all-targets -- -D warnings` → clean.

- [ ] **Step 6: Commit** (only if asked)

---

### Task 12: Distribution, CI, docs

**Files:**
- Create: `.github/workflows/ci.yml`, `docs/oauth-client-metadata.json`, `README.md` (replace)
- Modify: `Cargo.toml` (dist profile + metadata), generated `.github/workflows/release.yml` and `dist-workspace.toml` via `dist init`

- [ ] **Step 1: CI workflow** `.github/workflows/ci.yml`

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace
```

- [ ] **Step 2: OAuth client metadata** `docs/oauth-client-metadata.json`

```json
{
  "client_id": "https://happyproto.at/oauth/hpy/client-metadata.json",
  "client_name": "hpy",
  "client_uri": "https://happyproto.at",
  "application_type": "native",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "redirect_uris": ["http://127.0.0.1/oauth/callback", "http://[::1]/oauth/callback"],
  "scope": "atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*",
  "token_endpoint_auth_method": "none",
  "dpop_bound_access_tokens": true
}
```

- [ ] **Step 3: dist** — install `dist` (`cargo install cargo-dist --locked` or `brew install axodotdev/tap/cargo-dist`), then run non-interactively:

```bash
dist init --yes --installer shell --installer powershell --installer homebrew \
  --tap happyproto/homebrew-tap --hosting github \
  --target aarch64-apple-darwin --target x86_64-apple-darwin \
  --target x86_64-unknown-linux-gnu --target aarch64-unknown-linux-gnu \
  --target x86_64-unknown-linux-musl --target x86_64-pc-windows-msvc
```

Then `dist plan` must succeed and list `hpy-cli` with the `hpy` binary. Ensure `[profile.dist]` exists in `Cargo.toml` (dist adds it). Confirm `publish-jobs = ["homebrew"]` and `tap = "happyproto/homebrew-tap"` in the generated config.

- [ ] **Step 4: README** — sections: Install (brew/shell/cargo), Quick start (`hpy login`, `hpy plugin profile init`, `hpy plugin publish`), `hpy.toml` reference (copy of spec's example), CI publishing (`HPY_IDENTIFIER`/`HPY_APP_PASSWORD` + `--yes --no-input`), Configuration table, Production OAuth (host `docs/oauth-client-metadata.json`, set `HPY_OAUTH_CLIENT_ID`), Releasing (`git tag v0.1.0 && git push --tags`; maintainers create `happyproto/homebrew-tap` and the `HOMEBREW_TAP_TOKEN` secret), Manual verification checklist (login with OAuth against a real PDS, `whoami`, `profile init` on a scratch slug, `publish --dry-run`, `publish`, `status --wait`, `withdraw`).

- [ ] **Step 5: Verify** — `cargo build --release && ./target/release/hpy --help && cargo test --workspace && dist plan`.

- [ ] **Step 6: Commit** (only if asked)
