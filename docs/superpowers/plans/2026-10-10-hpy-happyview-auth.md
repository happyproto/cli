# Publishing through HappyView — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `hpy`'s direct-to-PDS login and record writes with HappyView DPoP key provisioning, the registry's `publishProfile`/`publishRelease` procedures, and OS-keychain storage of the DPoP key.

**Architecture:** `hpy-atproto` is rebuilt as small units — DPoP/PKCE primitives, a key store (keychain or file), the credential, an atproto OAuth client (PAR + token exchange with HappyView-signed client assertions), and a HappyView XRPC client — behind the existing `Repo`/`Registry` traits, which gain the publish procedures. Commands change only where the flow changes (login, publish, profile init/edit, withdraw).

**Tech Stack:** Rust 2024; `p256` 0.13 (`ecdsa`, `jwk`), `sha2` 0.10, `base64` 0.22, `url` 2, `keyring` 4 (`v1`), `jacquard` 0.12.2 (identity + OAuth resolver only), `reqwest` 0.12, `tokio`; tests: `wiremock`, `tempfile`.

**Spec:** `docs/superpowers/specs/2026-10-10-hpy-happyview-auth-design.md` (with `2026-10-09-hpy-plugin-registry-design.md` for everything it does not supersede).

## Global Constraints

- HappyView API client key default `hvc_f4b41f1b8ca045b291488098e010f5ea`; OAuth client id default `https://happyproto.at/oauth/hpy/client-metadata.json`; registry/HappyView default `https://api.happyproto.at`. Overrides: `HPY_CLIENT_KEY`, `HPY_OAUTH_CLIENT_ID`, `HPY_REGISTRY_URL`.
- Scope: `atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*`.
- Redirect URI `http://127.0.0.1:<port>/oauth/callback`.
- Every HappyView call: `X-Client-Key`; authenticated calls add `Authorization: DPoP <access_token>` and a `DPoP` proof `{typ:"dpop+jwt", alg:"ES256", jwk}` / `{htm, htu (no query), iat, jti, ath}`.
- Keychain: service `hpy`, account `<registry host>/<did>`; only the DPoP private JWK is stored there. `HPY_CREDENTIAL_STORE` = `auto` (default) | `keychain` | `file`.
- `HPY_CREDENTIAL` (base64url credential JSON) takes precedence over stored credentials.
- Exit codes unchanged: 1 runtime, 2 usage/validation (incl. `InvalidRecord`, `VersionExists`), 3 auth.
- No git commands (user's global instruction): no commits; changes stay uncommitted.

## Review Focus

1. **A PDS that answers PAR or token with `use_dpop_nonce`** — expect one retry with the nonce, not a failure. Pinned in Task 4.
2. **Keychain present but locked/denied, or absent (headless Linux)** — expect fallback to the file under `auto` with a one-line notice, an error under `keychain`, never a panic. Pinned in Task 2.
3. **Credential file present but keychain item deleted** (user cleared Keychain) — expect exit 3 "run `hpy login`". Pinned in Task 2.
4. **First publish of a brand-new package** — `publishRelease` returns `ProfileMissing` until the profile is indexed; expect a bounded wait then success. Pinned in Task 6.
5. **Registry rejects the release (`InvalidRecord`)** — expect exit 2 with the registry's message and **no blob upload**. Pinned in Task 6.

---

### Task 1: DPoP and PKCE primitives

**Files:** Create `crates/hpy-atproto/src/dpop.rs`, `crates/hpy-atproto/src/pkce.rs`; modify `crates/hpy-atproto/Cargo.toml`, `src/lib.rs`, workspace `Cargo.toml`.

**Interfaces — Produces:**
- `pkce::Pkce { verifier: String, challenge: String }`, `Pkce::new() -> Pkce` (43-char base64url verifier from 32 random bytes; `challenge = b64url(sha256(verifier))`).
- `dpop::DpopKey` wrapping `p256::SecretKey`: `DpopKey::from_jwk(&serde_json::Value) -> Result<DpopKey>`, `to_jwk(&self) -> Value` (private, with `d`), `public_jwk(&self) -> Value` (`kty, crv, x, y` only), `thumbprint(&self) -> String` (RFC 7638: SHA-256 of `{"crv","kty","x","y"}` in that order, b64url), `proof(&self, method: &str, url: &str, access_token: Option<&str>, nonce: Option<&str>) -> String`.
- `dpop::htu(url: &str) -> String` — scheme + host(+port) + path, no query/fragment, path kept exactly as given (percent-encoding preserved).
- `dpop::b64url(&[u8]) -> String`, `dpop::random_token(bytes: usize) -> String`.

- [ ] **Step 1: Failing tests** (`dpop.rs`)

```rust
#[test]
fn proof_verifies_and_carries_the_claims() {
    let key = DpopKey::generate();
    let jwt = key.proof("post", "https://hv.example/xrpc/x.y?q=1#f", Some("tok"), Some("n1"));
    let (header, claims) = verify(&jwt, &key); // test helper: splits, checks ES256 sig with p256 VerifyingKey from header jwk
    assert_eq!(header["typ"], "dpop+jwt");
    assert_eq!(header["alg"], "ES256");
    assert!(header["jwk"].get("d").is_none());
    assert_eq!(claims["htm"], "POST");
    assert_eq!(claims["htu"], "https://hv.example/xrpc/x.y");
    assert_eq!(claims["ath"], b64url(&sha2::Sha256::digest(b"tok")));
    assert_eq!(claims["nonce"], "n1");
    assert!(claims["jti"].as_str().unwrap().len() >= 16);
}

#[test]
fn jwk_round_trip_and_rfc7638_thumbprint() {
    // RFC 7638 §3.1 is RSA; use a fixed P-256 JWK and its independently computed thumbprint.
    let jwk = serde_json::json!({"kty":"EC","crv":"P-256",
        "x":"MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4","y":"4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM",
        "d":"870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE"});
    let key = DpopKey::from_jwk(&jwk).unwrap();
    assert_eq!(key.to_jwk(), jwk);
    assert_eq!(key.thumbprint(), "<computed with Python in Step 2>");
}

#[test]
fn htu_keeps_percent_encoding_and_port() {
    assert_eq!(htu("http://127.0.0.1:3000/oauth/sessions/did%3Aplc%3Aabc?x=1"),
               "http://127.0.0.1:3000/oauth/sessions/did%3Aplc%3Aabc");
}
```

`pkce.rs`:
```rust
#[test]
fn challenge_is_s256_of_verifier() {
    let p = Pkce::new();
    assert_eq!(p.verifier.len(), 43);
    assert_eq!(p.challenge, crate::dpop::b64url(&sha2::Sha256::digest(p.verifier.as_bytes())));
    assert_ne!(Pkce::new().verifier, p.verifier);
}
```

- [ ] **Step 2:** Compute the thumbprint vector independently (Python: `hashlib.sha256(json.dumps({"crv":…,"kty":…,"x":…,"y":…}, separators=(',',':'))).digest()` → base64url) and put it in the test. Run → compile failure (RED).
- [ ] **Step 3:** Implement with `p256::ecdsa::{SigningKey, Signature}` (`sign` → fixed 64-byte r‖s), `SecretKey::from_jwk`/`to_jwk_string`, `elliptic_curve::rand_core::OsRng` for randomness. JWT = `b64url(header) . b64url(claims) . b64url(sig)`, claims `iat` = now (unix secs).
- [ ] **Step 4:** `cargo test -p hpy-atproto dpop pkce` → GREEN.

---

### Task 2: Key store and credential

**Files:** Create `src/keystore.rs`, `src/credential.rs`; modify `src/settings.rs` (add `client_key`, `oauth_client_id: String` default, `credential_store: StoreChoice`).

**Interfaces — Produces:**
- `keystore::KeyStore` trait: `fn get(&self, account: &str) -> Result<Option<String>, KeyStoreError>; fn set(&self, account: &str, secret: &str) -> Result<(), KeyStoreError>; fn delete(&self, account: &str) -> Result<(), KeyStoreError>;` where `KeyStoreError::{Unavailable(String), Other(String)}`.
- `keystore::Keychain` (keyring `Entry::new("hpy", account)`; `NoEntry` → `Ok(None)`/no-op; `NoStorageAccess`/`PlatformFailure`/`NoDefaultStore` → `Unavailable`), and `keystore::MemoryStore` (`#[cfg(test)]`-friendly, `Mutex<HashMap>`; public so `hpy` tests can use it).
- `credential::Credential { registry, client_key, did, handle: Option<String>, pds, scopes, access_token, dpop_key: DpopKey }`.
- `credential::Stored` enum for the on-disk `dpop_key` field: `{"keychain": true}` or the JWK inline.
- `credential::save(settings, &Credential, store: &dyn KeyStore) -> Result<Saved>` where `Saved::{Keychain, File}` (fallback reason surfaced to the caller for the one-line notice); `credential::load(settings, store, env) -> Result<Option<Credential>>` (`HPY_CREDENTIAL` first); `credential::remove(settings, store) -> Result<Option<Credential>>` (tolerates a corrupt file: deletes it, returns `None`); `credential::export(&Credential) -> String` / `credential::import(&str) -> Result<Credential>` (base64url of the full JSON with the key inline); `credential::account(registry, did) -> String` = `"<host>/<did>"`.

- [ ] **Step 1: Failing tests** (`credential.rs`, with `MemoryStore` and a `FailingStore` returning `Unavailable`):
  - `saves_key_in_keychain_and_rest_in_file`: after save, file JSON has `"dpop_key": {"keychain": true}` and no `"d"`; store holds the JWK under `account()`; file mode is 0600 (unix); `load` returns an equal credential.
  - `falls_back_to_file_when_keychain_unavailable`: `Auto` + `FailingStore` → `Saved::File`, file has the inline JWK, `load` works.
  - `keychain_choice_makes_unavailable_an_error`: `StoreChoice::Keychain` + `FailingStore` → error mentioning `HPY_CREDENTIAL_STORE`.
  - `file_choice_never_touches_the_keychain`: a store that panics on use is never called.
  - `missing_keychain_item_is_an_auth_error`: file says keychain, store empty → `Err(e)` with `e.is_auth()`.
  - `env_credential_wins`: `HPY_CREDENTIAL=export(c2)` → `load` returns `c2` even with a file present.
  - `export_import_round_trip` and `import_rejects_garbage` (error says it is not an `hpy login --export` credential).
  - `remove_tolerates_corruption`: garbage file → `Ok(None)`, file gone.
  - `#[ignore] real_keychain_round_trip` in `keystore.rs`: set/get/delete on `Keychain` with a random account.
- [ ] **Step 2:** RED. **Step 3:** Implement (atomic write: write `credentials.json.tmp` created with mode 0600 via `OpenOptions::mode`, then `rename`). **Step 4:** GREEN.

---

### Task 3: HappyView client

**Files:** Create `src/happyview.rs`.

**Interfaces — Produces:** `HappyView { base: Url, client_key: String, http }`:
- `provision(&self, pkce_challenge) -> Result<Provision { provision_id, dpop_key: DpopKey }>` — `POST /oauth/dpop-keys`.
- `client_assertion(&self, issuer, provision_id, pkce_verifier) -> Result<String>` — `POST /oauth/client-assertion`.
- `register_session(&self, &SessionRegistration) -> Result<()>` — `POST /oauth/sessions` (fields per spec, public-client form).
- `revoke(&self, cred: &Credential) -> Result<()>` — `DELETE /oauth/sessions/{did}` (DID percent-encoded with `url::form_urlencoded::byte_serialize`; proof `htu` = that exact URL).
- `procedure(&self, cred, nsid, body: Value) -> Result<Value>`; `upload_blob(&self, cred, bytes, mime) -> Result<Value>` (returns `blob`).
- `xrpc_error(status, body) -> Error`: maps `AuthRequired`, 401 → `Error::SessionExpired`; `InvalidRecord`/`VersionExists`/`ProfileMissing` → `Error::Registry { name, message }`; others → `Error::Xrpc`. 429: sleep `min(Retry-After, 10)` and retry once.
- `error.rs` gains `Error::Registry { name: String, message: String }` (Display = message) and `Error::is_usage()` (true for `InvalidRecord`, `VersionExists`).

- [ ] **Step 1: Failing tests** (wiremock):
  - `provision_sends_client_key_and_challenge` (matcher on header + JSON body) and parses the JWK.
  - `procedure_sends_dpop_auth_with_matching_proof`: a custom wiremock `Match` that decodes the `DPoP` header and checks `htm == "POST"`, `htu == "{server}/xrpc/at.happyproto.registry.publishRelease"`, `ath == b64url(sha256(access_token))`, and `Authorization == "DPoP <token>"`.
  - `registry_errors_keep_their_name_and_message` (400 `InvalidRecord` → `Error::Registry`, `is_usage()`), `auth_required_is_session_expired`, `retries_429_once`.
  - `revoke_proof_htu_is_the_encoded_url`.
- [ ] **Step 2–4:** RED → implement → GREEN.

---

### Task 4: Resolution and the OAuth flow

**Files:** Create `src/resolve.rs`, `src/oauth.rs`, `src/login.rs`.

**Interfaces — Produces:**
- `resolve::Resolved { did, handle: Option<String>, pds: String, auth: AuthServer { issuer, par_endpoint, authorization_endpoint, token_endpoint } }`; `#[async_trait] trait Resolver { async fn resolve(&self, identifier: &str) -> Result<Resolved>; }`; `JacquardResolver` impl using `jacquard::oauth::resolver::OAuthResolver::resolve_oauth` (DID doc → `id`, PDS service endpoint, `alsoKnownAs` handle).
- `oauth::Callback { code, state, iss: Option<String> }`; `oauth::listen() -> Result<(u16, impl Future<Output = Result<Callback>>)>` — binds `127.0.0.1:0`, accepts one `GET /oauth/callback?…`, replies with a small HTML page, parses the query; `error=…` → `Err` with `error_description`.
- `oauth::par(http, auth, &ParParams, key: &DpopKey) -> Result<String /*request_uri*/>` and `oauth::exchange(http, auth, &TokenParams, key) -> Result<TokenSet { access_token, refresh_token, expires_in, scope, sub }>` — form-encoded, DPoP proof (no `ath`), on 400 `{"error":"use_dpop_nonce"}` retry once with the `DPoP-Nonce` response header; the nonce from PAR is reused for the token request.
- `login::login(settings, resolver: &dyn Resolver, hv: &HappyView, identifier, open_browser: bool, show_url: &dyn Fn(&str)) -> Result<Credential>` — the 10 steps of the spec. Checks: `state` equal, `iss == auth.issuer` when present, `sub == resolved.did`, scope contains `atproto`.

- [ ] **Step 1: Failing tests:**
  - `oauth.rs`: `par_sends_assertion_pkce_and_dpop` and `par_retries_once_with_dpop_nonce` (first response 400 `use_dpop_nonce` + `DPoP-Nonce: n1`, second asserts proof carries `nonce: n1`), `exchange_returns_tokens`, `callback_parses_code_and_rejects_access_denied` (drive `listen()` with a raw `reqwest` GET).
  - `login.rs`: end-to-end against wiremock HappyView + wiremock authorization server + a `FakeResolver`, with `open_browser=false` and `show_url` spawning a task that GETs the callback URL with the expected `state` and a `code` (read `state` from the authorize URL's PAR response — the fake PAR echoes `state` into a `request_uri` it records). Asserts: two client assertions fetched (PAR and token), `register_session` received the HappyView `pkce_verifier` and the tokens, returned `Credential` has the provisioned key. Plus `login_refuses_sub_mismatch` and `login_refuses_state_mismatch`.
- [ ] **Step 2–4:** RED → implement → GREEN.

---

### Task 5: Repo/Registry over HappyView; remove the old session layer

**Files:** Modify `src/repo.rs`, `src/registry.rs`, `src/lib.rs`, `src/settings.rs`; create `src/session.rs` (new, small: `Session { credential, repo: Box<dyn Repo> }`, `current(settings) -> Result<Option<Session>>`); delete old `session.rs` contents and `jacquard_repo.rs`.

**Interfaces:**
- `Repo` drops `create_record`; keeps `did`, `get_record`, `list_records`, `put_record`, `delete_record`, `upload_blob`. Impl `HappyViewRepo { hv, cred, pds_http }`: reads via `GET {pds}/xrpc/com.atproto.repo.getRecord|listRecords` (unauthenticated; `RecordNotFound` → `None`); writes via `hv.procedure("com.atproto.repo.putRecord"|"deleteRecord", {repo: did, …})`; `upload_blob` via `hv.upload_blob`.
- `Registry` gains `async fn publish_profile(&self, slug, record, validate_only) -> Result<Option<WriteResult>>` and `async fn publish_release(&self, record, validate_only) -> Result<Option<WriteResult>>` (`None` when validate-only). `HttpRegistry` gets an optional `(HappyView, Credential)` for these; without it they return `Error::NotLoggedIn`.
- `Settings`: `client_key`, `oauth_client_id` (now `String`, default the hosted URL), `credential_store`.

- [ ] **Step 1: Failing tests:** wiremock tests for `HappyViewRepo` reads (`RecordNotFound` → `None`, cursor pagination) and writes (procedure called with `repo == did`); `Registry::publish_release` validate-only returns `None` and sends `validateOnly: true`.
- [ ] **Step 2–4:** RED → implement → GREEN; `cargo build -p hpy-atproto` with `jacquard` features reduced to `["dns"]` plus what `OAuthResolver` needs.

---

### Task 6: Commands

**Files:** Modify `crates/hpy/src/{cli.rs, ctx.rs, testing.rs, commands/auth.rs, commands/publish.rs, commands/profile.rs, commands/withdraw.rs}`, `crates/hpy/tests/cli.rs`.

- `login [identifier] [--export] [--no-browser]` (no `--app-password`): runs `login::login`; without `--export`, revokes any existing credential then `credential::save` (prints a notice when it fell back to the file); with `--export`, prints `credential::export` to stdout and stores nothing. `logout`: `hv.revoke` (best effort) then `credential::remove`. `whoami`: from `credential::load` without needing the keychain when the file is enough — read the file's non-secret fields directly (new `credential::peek(settings, env)`).
- `FakeRegistry` gains `publish_*` with scripted outcomes (`profile_missing_times: usize`, `reject: Option<(name, message)>`, `indexed_after: usize` for `get_package`).
- `publish::execute`: replaces `create_profile_if_absent` + `create_record` with the spec's steps 2–5; `ProfileMissing` → poll `get_package` (interval and limit injectable for tests: `PublishTiming { poll: Duration, limit: Duration }`).
- `profile init`: `publish_profile(validate_only=true)` then `publish_profile(false)`. `profile edit`: validate via `publish_profile(true)` then `put_record` with swap. `withdraw`: unchanged call path (`delete_record`) — now through HappyView.

- [ ] **Step 1: Failing tests** (command level, fakes):
  - `publish_waits_for_a_new_profile_to_be_indexed` (`profile_missing_times = 2`, `indexed_after = 2`, tiny timing) → success.
  - `publish_gives_up_when_the_profile_never_indexes` → error mentioning "indexed".
  - `registry_rejection_uploads_nothing` (`reject = InvalidRecord`) → exit 2, message passed through, `blobs` empty.
  - `version_exists_is_a_usage_error`.
  - `dry_run_reports_the_registry_verdict` (validate-only called, nothing written).
  - CLI: `login --help` lists `--export`, no `--app-password`; `whoami` with `HPY_CREDENTIAL` set to an exported test credential prints its DID without touching the keychain; `whoami` with a corrupt credentials file exits 3.
- [ ] **Step 2–4:** RED → implement → GREEN; whole workspace green, clippy clean.

---

### Task 7: Docs and manual verification

**Files:** `README.md`, `docs/superpowers/specs/2026-10-09-hpy-plugin-registry-design.md` (note at top: auth/writes superseded), `docs/oauth-client-metadata.json` (replace with the published document).

- README: install unchanged; Quick start login text; **Publishing from CI** rewritten for `hpy login --export` + `HPY_CREDENTIAL`; **Configuration** gains `HPY_CLIENT_KEY`, `HPY_OAUTH_CLIENT_ID`, `HPY_CREDENTIAL_STORE`; credentials paragraph describes keychain + file + macOS "Always Allow" prompt; manual checklist updated (bsky.social login, `--export` round trip, keychain item visible in Keychain Access, logout removes it).
- [ ] **Step:** run the `#[ignore]` keychain test on this Mac: `cargo test -p hpy-atproto real_keychain -- --ignored`.
- [ ] **Step:** attempt a real `hpy login` against the user's account only if run interactively by the user — it opens a browser and needs their approval; otherwise leave it as the first item of the manual checklist.
