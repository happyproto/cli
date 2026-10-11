# `hpy` — publishing through HappyView

Date: 2026-10-10
Status: approved 2026-10-10 (with OS keychain storage added); amended after review —
see *Amendment: web client with a relay* at the end.
Supersedes: the *Authentication* section and the write paths of
`2026-10-09-hpy-plugin-registry-design.md`.

## Why

The registry now exposes `at.happyproto.registry.publishProfile` and
`at.happyproto.registry.publishRelease` on its HappyView instance
(`https://api.happyproto.at`). They validate a record against the same rules
the indexer applies, return a real error (`InvalidRecord`, `VersionExists`,
`ProfileMissing`, …) and write it to the caller's repo. Publishing through them
replaces writing records directly to the PDS, where a bad record was silently
ignored.

Calling them means authenticating to HappyView as the user. HappyView's
mechanism for a third-party client is **DPoP key provisioning**: HappyView
issues the DPoP key, the client runs atproto OAuth with the user's PDS using
it, then registers the resulting session with HappyView, which from then on
holds and refreshes the PDS tokens and acts on the user's behalf.

## Identities (already set up)

| What | Value |
| --- | --- |
| HappyView API client | public, key `hvc_f4b41f1b8ca045b291488098e010f5ea`, id `5d3a2a47-028c-4615-98db-a577490e57ce`, no allowed origins |
| atproto OAuth client id | `https://happyproto.at/oauth/hpy/client-metadata.json` |
| Client metadata | `application_type: native`, loopback redirect URIs `http://127.0.0.1/oauth/callback`, `http://[::1]/oauth/callback`, `token_endpoint_auth_method: private_key_jwt`, `jwks_uri` → HappyView's key for this client |
| Scope | `atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*` |

The client key and client id are compiled into `hpy` as defaults and are not
secrets. Both can be overridden (`HPY_CLIENT_KEY`, `HPY_OAUTH_CLIENT_ID`,
`HPY_REGISTRY_URL`) for other HappyView instances and local testing.

`hpy` is a *public* HappyView client (it cannot hold a secret) and a
*confidential* atproto client to the PDS: HappyView holds the signing key and
signs a client assertion for `hpy` on request. A confidential client gets
long-lived PDS sessions, so users rarely log in again.

## Login (`hpy login [handle]`)

1. Generate a PKCE pair for HappyView (`hv_verifier`, `hv_challenge`).
2. `POST {hv}/oauth/dpop-keys` with `X-Client-Key` and
   `{"pkce_challenge": hv_challenge}` → `provision_id`, `dpop_key` (P-256
   private JWK). This key is the DPoP key for everything below.
3. Resolve the identifier: handle → DID → DID document → PDS → protected
   resource metadata → authorization server → its metadata (`issuer`,
   `pushed_authorization_request_endpoint`, `authorization_endpoint`,
   `token_endpoint`). Done with `jacquard-identity`'s resolver and plain HTTP.
4. Start a one-shot loopback server on `127.0.0.1:<random port>`; redirect URI
   `http://127.0.0.1:<port>/oauth/callback`.
5. Client assertion: `POST {hv}/oauth/client-assertion` with `X-Client-Key` and
   `{"issuer", "provision_id", "pkce_verifier": hv_verifier}` → a 60-second
   `client_assertion`.
6. PAR to the authorization server: `client_id`, `redirect_uri`, `scope`,
   `state`, PKCE (a second, separate pair for the PDS), `login_hint`,
   `client_assertion_type` + `client_assertion`, with a DPoP proof. On
   `use_dpop_nonce`, retry once with the `DPoP-Nonce` it returned.
7. Open the browser at `authorization_endpoint?client_id=…&request_uri=…`
   (and print the URL). Wait for the callback (5-minute timeout); check
   `state` and `iss`.
8. A fresh client assertion (step 5 again), then the token exchange with the
   code, PDS PKCE verifier, assertion and a DPoP proof (nonce retry as in 6).
   Check the response's `sub` is the resolved DID and its `scope` includes
   `atproto`.
9. `POST {hv}/oauth/sessions` with `provision_id`, `pkce_verifier: hv_verifier`,
   `did`, `access_token`, `refresh_token`, `expires_at`, `scopes`, `pds_url`,
   `issuer` → registered.
10. Store the credential (below) and print who is logged in.

Logging in again replaces the stored credential and first revokes the old
session (`DELETE /oauth/sessions/{did}` with its DPoP proof; best effort).

### The stored credential

HappyView looks a session up by the DPoP key's thumbprint and checks the
proof's `ath` against whatever token is presented, so the client needs only
the key, not fresh tokens — HappyView refreshes the PDS tokens itself. The
credential is:

```json
{ "v": 1, "registry": "https://api.happyproto.at", "client_key": "hvc_…",
  "did": "did:plc:…", "handle": "alice.example", "pds": "https://…",
  "dpop_key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "d": "…" },
  "access_token": "…", "scopes": "…" }
```

It is a secret, and its secret part is the DPoP private key: the access
token is DPoP-bound and useless without it.

**Storage.** The DPoP private key goes in the OS keychain (macOS Keychain,
Windows Credential Manager, the Secret Service on Linux, via `keyring` 4),
under service `hpy`, account `<registry host>/<did>`. Everything else —
including the access token — goes in `$CONFIG/hpy/credentials.json` (0600,
created 0600, written atomically), with `"dpop_key": {"keychain": true}`.
Keeping the keychain item to the ~250-byte key keeps it well under Windows
Credential Manager's 2560-byte limit, and lets `whoami` read the file without
touching the keychain.

When no keychain is usable (a headless Linux box with no Secret Service, a
container), or `HPY_CREDENTIAL_STORE=file`, the key is stored inline in the
same 0600 file instead, and `login` says so once. `HPY_CREDENTIAL_STORE=keychain`
makes an unusable keychain an error instead of a fallback. `session.toml` is
removed; `whoami` reads the file.

On macOS the keychain item's access list names the binary that created it, so
after `hpy` updates itself macOS may ask once to allow access ("Always
Allow"); the binaries are not code-signed. Documented in the README.

`access_token` is kept only to compute `ath`; it is never refreshed by `hpy`.

### CI (`hpy login --export`)

Runs the full login, but prints the credential — base64url of the JSON above —
to stdout instead of storing it. Because it is a separate login, it is a
separate HappyView session with its own key: revoking it (or the local one)
does not affect the other. In CI, `HPY_CREDENTIAL=<that string>` is used in
place of the credentials file. The README says plainly that it is a
credential to store as a secret, and how to revoke it (`hpy logout` with
`HPY_CREDENTIAL` set, or the HappyView dashboard).

`--app-password` and `HPY_IDENTIFIER`/`HPY_APP_PASSWORD` are removed: an
app-password session cannot become a HappyView session.

### Logout

`DELETE {hv}/oauth/sessions/{did}` with `X-Client-Key`, `Authorization: DPoP
<access_token>` and a proof whose `htu` is the URL exactly as sent (the DID
percent-encoded). Then delete the credentials file. Idempotent; a corrupt
credentials file is removed without the remote call.

## Calling HappyView

Every authenticated call sends `X-Client-Key`, `Authorization: DPoP
<access_token>` and a `DPoP` proof: ES256, header `{typ: "dpop+jwt", alg:
"ES256", jwk: <public jwk>}`, claims `{htm, htu (scheme+host+path, no query),
iat, jti (random), ath (base64url SHA-256 of the access token)}`. HappyView
uses no DPoP nonce.

| Operation | Call |
| --- | --- |
| upload a blob | `POST /xrpc/com.atproto.repo.uploadBlob` (HappyView proxies it to the PDS) |
| create/validate a profile | `POST /xrpc/at.happyproto.registry.publishProfile` `{slug, record, validateOnly?}` |
| create/validate a release | `POST /xrpc/at.happyproto.registry.publishRelease` `{record, validateOnly?}` |
| edit a profile | `POST /xrpc/at.happyproto.registry.updateProfile` `{slug, record, swapCid?}` |
| withdraw a release | `POST /xrpc/at.happyproto.registry.withdrawRelease` `{slug, version}` |
| read the user's records | `com.atproto.repo.getRecord` / `listRecords` on the PDS directly (public, unauthenticated) |
| registry state | `getPackage` / `getRelease` / `listReleases`, unauthenticated, as today |

Errors are XRPC `{error, message}` bodies. Mapping to exit codes:
`AuthRequired`, a 401, or an unknown/revoked session → 3 ("run `hpy login`");
`InvalidRecord`, `VersionExists` → 2 with the registry's message;
`ProfileMissing` → handled in publish (below); `Upstream`, `NotConfigured`,
5xx, network → 1. A 429 is retried once after `Retry-After` (≤ 10 s), then
reported.

## Command changes

**`plugin publish`**, after local validation (unchanged — fast and offline):

1. Repo and registry pre-checks as today (already published, withdrawn,
   registry already holds the version).
2. If the profile is not on the PDS: `publishProfile {validateOnly: true}`,
   then (after confirmation) `publishProfile`.
3. `publishRelease {validateOnly: true}` with the record built from the
   *predicted* blob refs. This is the registry's verdict before any bytes move.
   `ProfileMissing` here right after step 2 means the profile has not been
   indexed yet: poll `getPackage` every 2 s for up to 60 s, then retry; if it
   never appears, fail with a message saying so.
4. Upload the module and images; check each returned CID against its
   checksum (as today).
5. `publishRelease` with the record carrying the returned blob refs.

`--dry-run` stops after step 3 and so now reports the registry's real verdict
(it requires login, as it already did).

**`plugin profile init`**: `publishProfile {validateOnly}` then
`publishProfile`. **`profile edit`**: `updateProfile` with the CID the profile
was read at as `swapCid`; it applies the registry's rules and answers
`InvalidSwap` if the profile changed. **`plugin withdraw`**: `withdrawRelease`;
`ReleaseNotFound` means the version is not published from this account.
**`status`**, **`profile show`/`pull`**: unchanged reads.

Every write is a registry procedure, never a raw `com.atproto.repo.*` call.
HappyView proxies a method it does not host according to the instance's
proxy routing. Under the default (`authority`), that sends the call,
unauthenticated, to the method's lexicon authority rather than to the user's
PDS. `uploadBlob` is the one exception: HappyView handles it itself.

## Architecture

`hpy-atproto` is rebuilt around HappyView:

```
crates/hpy-atproto/src/
  dpop.rs        DPoP key (P-256 JWK ⇄ p256), proof signing, thumbprint, ath
  pkce.rs        PKCE pairs
  resolve.rs     identifier → DID, PDS, authorization server metadata
  oauth.rs       PAR, loopback callback, token exchange (+ nonce retry)
  happyview.rs   HappyView client: provisioning, assertions, sessions, XRPC
  credential.rs  the credential: load/store (file or HPY_CREDENTIAL), export
  keystore.rs    KeyStore trait; keychain (keyring) and in-file implementations
  repo.rs        Repo trait (reads + put/delete/upload) — HappyView-backed impl
  registry.rs    Registry trait — reads as today + publish_profile/publish_release
  settings.rs    + client_key, oauth_client_id defaults
  error.rs       + XRPC error-name mapping above
```

`jacquard` is reduced to `jacquard-identity` (resolution). `session.rs` and
`jacquard_repo.rs` are deleted. New dependencies: `p256` (ecdsa, jwk),
`base64` (url-safe, no pad), `rand`, `url`, plus the existing `sha2`,
`reqwest`, `serde_json`. The loopback server is a small `tokio` TCP listener
that parses one `GET /oauth/callback?…` request and answers a "you can close
this tab" page.

Command code keeps depending on the `Repo` and `Registry` traits, so the
existing fakes extend to the new methods and the command tests keep working.

## Testing

- `dpop`: a generated key signs a proof that verifies with `p256`; header,
  claims, `ath` and RFC 7638 thumbprint match known vectors; `htu` drops the
  query and keeps percent-encoding.
- `oauth`: against `wiremock` fakes of HappyView and an authorization server —
  PAR carries the assertion, PKCE, DPoP; `use_dpop_nonce` is retried once with
  the nonce; a second assertion is fetched for the token exchange; a `sub`
  mismatch and a `state` mismatch are refused; the callback parser handles
  `error=access_denied`.
- `happyview`: provisioning, session registration, publish calls and XRPC
  error mapping against `wiremock`; every request carries `X-Client-Key` and a
  proof whose `htu`/`htm`/`ath` match the request.
- `credential`: round trip with an in-memory key store, 0600 on create,
  `HPY_CREDENTIAL` beats the file, corrupt file → "run `hpy login`", a key
  missing from the keychain → "run `hpy login`", fallback to the file when the
  key store reports it is unavailable, `HPY_CREDENTIAL_STORE` honored.
- `keystore`: the keychain implementation round-trips against the real OS
  keychain in an `#[ignore]`d test, run by hand on macOS (CI runners have no
  unlocked keychain).
- Commands: publish with fakes for `ProfileMissing`-then-indexed, a timeout,
  `InvalidRecord` (no upload happens), `VersionExists`.
- Manual (README checklist, done before release): real login against a
  bsky.social account and a self-hosted PDS, `profile init`, `publish
  --dry-run`, `publish --wait`, `withdraw`, `login --export` used from a
  shell with `HPY_CREDENTIAL`, `logout`.

## Risks

- **A PDS refusing a native confidential client.** HappyView supports it, but
  a PDS may restrict `private_key_jwt` to `web` clients or reject a varying
  loopback port. First thing verified, by the manual login. Fallback: switch
  the metadata to `token_endpoint_auth_method: none` (public) — shorter
  sessions, no code change beyond skipping the assertion.
- **`ProfileMissing` timing.** Indexing is asynchronous; a slow firehose makes
  first publishes wait. Bounded at 60 s with a clear message.
- **The exported CI credential is long-lived.** Documented as a secret;
  revocable per session.

## Amendment: web client with a relay (2026-10-10, after review)

The reference authorization server (`@atproto/oauth-provider`, used by
bsky.social) rejects a native client that is not public ("Native clients must
authenticate using \"none\" method") and only allows loopback redirects for
native clients. Its public-client sessions last at most two weeks; confidential
ones up to two years.

So `hpy` is a confidential **web** client:

- Metadata: `application_type: web`, `redirect_uris:
  ["https://happyproto.at/oauth/hpy/callback"]`, `private_key_jwt` with
  HappyView's `jwks_uri` (as before).
- The redirect URI is a static relay page (served by the `happyproto.at` site: `src/pages/oauth/hpy/callback.astro`, with its logic in `src/lib/hpy-relay.ts`) that
  forwards the browser to `http://127.0.0.1:<port>/oauth/callback` with the
  query unchanged. `hpy` puts `<port>.` at the front of `state`; the page only
  ever forwards to `127.0.0.1` and only for a numeric port. The `redirect_uri`
  sent in PAR and in the token request is the relay URL.
- `oauth.redirect` (`HPY_OAUTH_REDIRECT`: relay URL | `loopback`) and
  `oauth.client_auth` (`HPY_OAUTH_CLIENT_AUTH`: `assertion` | `none`) select
  the mode; `loopback` + `none` is a public native client, for anyone using
  their own client id registered that way.

Also from review: HappyView returns a Lua procedure's `{ error, message }`
with **200 OK**, so any 2xx body carrying a string `error` is treated as that
error; a 401 during the sign-in handshake reports HappyView's refusal rather
than "session expired"; registry reads send `X-Client-Key`; and a profile that
is on the PDS but unindexed stops `publish` before any upload, putting the
profile to `publishProfile {validateOnly}` to surface the registry's reason.
