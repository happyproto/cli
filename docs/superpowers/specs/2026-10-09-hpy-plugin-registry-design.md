# `hpy` — HappyProto CLI, milestone 1: plugin registry

Date: 2026-10-09
Status: implemented. Authentication and the write paths are superseded by
`2026-10-10-hpy-happyview-auth-design.md`; the rest stands.
Original status: approved for implementation (user delegated review: "get as far as you can without my intervention")

## Goal

`hpy` is one Rust CLI for the whole HappyProto ecosystem — HappyView instances,
HappyView OAuth clients, HappyProto-hosted projects, HappyView plugins, and
whatever comes after. Milestone 1 ships only the **plugin registry** slice:
a plugin author can log in, create and maintain a registry profile, and publish
releases of the plugin in the current directory. The command tree, crate layout
and auth layer are built so the other groups slot in without restructuring.

It must be easy to install: prebuilt binaries via GitHub Releases, a Homebrew
tap, and a shell installer.

### Success criteria

- `hpy login` signs a user into their atproto PDS (OAuth in a browser, or an app
  password for headless/CI use) and survives across invocations.
- `hpy plugin profile init` produces a valid `at.happyproto.plugin.profile`
  record in the user's repo, interactively or entirely from flags.
- `hpy plugin publish`, run in a plugin directory, uploads the WASM (and any
  images) as blobs and writes an `at.happyproto.plugin.release` record that the
  registry will accept — every rule the registry enforces silently is enforced
  loudly by the CLI first.
- `hpy plugin status` shows whether the registry has picked a release up
  (`pending` / `active` / `deleted`).
- Every prompt has a flag equivalent; with no TTY (or `--no-input`), a missing
  value is an error naming the flag, never a hang.
- `brew install happyproto/tap/hpy` works once the release pipeline runs.

### Non-goals (milestone 1)

- `hpy happyview …` and `hpy happyproto …` commands. Their shape is reserved
  (see Command tree) but nothing is implemented or stubbed in the binary.
- Building WASM ourselves beyond running a user-configured build command.
- Multiple simultaneous logged-in accounts (one active session; `login` again
  to switch).
- Searching/installing plugins from the registry.

## Background: how the registry works

The registry has **no upload API**. Publishers write records into their *own*
atproto repo; HappyView (at `https://api.happyproto.at`) indexes them off the
firehose and a job copies the artifact bytes:

| Collection | Record key | Meaning |
| --- | --- | --- |
| `at.happyproto.plugin.profile` | `<slug>` | The package: license, authors, security contacts, name, description, keywords, long-form sections. `type` is the const `"happyview-plugin"`. |
| `at.happyproto.plugin.release` | `<slug>:<version>` | One version: `package`, `version`, `artifacts` (`package` WASM required; `icon`, `banner`, `screenshots` optional), `requires`, `repo`, `extensions["at.happyproto.plugin.releaseExtension"]` (the manifest). |

Rules the registry enforces by **silently refusing to index** (a log line the
publisher never sees), which the CLI must therefore check before writing:

- slug: `^[A-Za-z][A-Za-z0-9.-]*$`, 1–128 chars (no `:`).
- version: semver 2.0, **no build metadata** (`+`), no leading `v`; must equal
  the rkey halves; `package` must equal the slug.
- releases are immutable: an `update` is ignored, and a **deleted version can
  never be republished**.
- `requires`: keys `env:<name>` or `at://<did>/at.happyproto.plugin.profile/<slug>`;
  values Cargo `VersionReq` ranges, comma-separated, `||` refused.
- artifact: `checksum` required, plus `blob` or `url`. `checksum` is a
  lowercase base32 multibase (`b…`) sha2-256 multihash (`0x12 0x20 <digest>`),
  and for a blob it must equal the multihash in the blob CID. The copy job
  rejects a mismatch, leaving the release `pending` forever.
- `package` blob: `application/wasm`, ≤ 16 MiB. Image blobs: png/jpeg/webp/gif/avif
  (no SVG), ≤ 1 MiB, ≤ 8 screenshots.
- releaseExtension: `pluginType` ∈ {auth, library, interpreter}; `apiVersion`
  major ≥ 2; `capabilities` present (may be empty); `namespace` required for
  library; `languageId` required for interpreter.
- profile: `license`, ≥1 author (with `name`), ≥1 security contact (with `url`
  or `email`); length limits per the lexicon (name ≤64 graphemes, description
  ≤300, keywords ≤20 × ≤32 graphemes, each section ≤2000 graphemes).

The registry is read back through XRPC queries on the registry host:
`at.happyproto.registry.getPackage {actor, slug}`,
`getRelease {did, slug, version}`, `listReleases {did, slug, cursor, limit}`.
A `releaseView.status` is `pending` until the artifact is copied, then `active`.

## Command tree

```
hpy login [<handle|did|pds-url>] [--app-password[=<pw>]] [--no-browser]
hpy logout
hpy whoami

hpy plugin profile init  [--slug --name --description --license --author ...
                          --security ... --keyword ... --local-only --yes]
hpy plugin profile show  [--slug]          # the record on the PDS
hpy plugin profile edit  [--slug] [field flags]   # edits the PDS record
hpy plugin profile pull  [--slug]          # PDS → hpy.toml
hpy plugin publish       [--wasm <path>] [--version <v>] [--dry-run] [--wait] [--yes]
hpy plugin status        [<version>] [--slug]
hpy plugin withdraw      <version> [--slug] [--yes]

# Reserved for later milestones (not in the binary yet):
hpy happyview client new | redirect add --id <client-id> <uri> | ...
hpy happyproto project create --name <n> | open [<name|id>] | ...
```

Global flags: `--json` (machine output on stdout, human messages to stderr),
`--no-input` (never prompt; implied when stdin is not a TTY), `-C <dir>`
(run as if in `<dir>`), `-v/--verbose`.

`--slug` defaults to the slug in `./hpy.toml`, then `manifest.json`'s `id`.

### Command behaviour

**`login`** — With no arguments, prompts for a handle. Default path is atproto
OAuth (below). `--app-password` uses `com.atproto.server.createSession` with
an app password (prompted, or from `HPY_APP_PASSWORD`). Prints the resolved
handle and DID. Re-running replaces the stored session.

**`logout`** — Revokes the OAuth session where possible, then deletes stored
credentials. Idempotent.

**`whoami`** — Prints handle, DID, PDS, and auth method; exits 1 with
"not logged in" otherwise.

**`plugin profile init`** — Gathers fields (flags first, then prompts for
anything missing and required; optional fields are prompted only when
interactive). Defaults come from `manifest.json` (`id` → slug, `name`,
`description`) and from `hpy.toml` if it exists. Writes/updates `hpy.toml`,
then creates the profile record with `putRecord` **only if no record exists at
that slug**. If one exists, it stops with: "a profile for `<slug>` already
exists on your PDS; use `hpy plugin profile edit` or `profile pull`."
`--local-only` skips the PDS write.

**`plugin profile show`** — `getRecord` from the user's repo, printed as a
readable summary (or the raw record with `--json`).

**`plugin profile edit`** — The PDS record is canonical once it exists. With
field flags (`--name`, `--add-author`, `--license`, …) it applies them
directly; with none, it opens the record as TOML in `$VISUAL`/`$EDITOR`,
re-validates on save (looping on error, like `git commit`), and `putRecord`s
with `swapRecord` set to the CID it read, so a concurrent edit fails rather
than being clobbered. Sets `lastUpdated`.

**`plugin profile pull`** — Overwrites the `[profile]` table of `hpy.toml`
with the PDS record (sections are written to the files named in `hpy.toml`,
or inlined if none).

**`plugin publish`** — In order, stopping at the first failure:

1. Load `hpy.toml` (optional) and `manifest.json` (required). Determine slug
   and version (`--version` > `hpy.toml [release] version` > manifest `version`).
2. Validate everything locally (rules above). All problems are reported
   together, not one at a time.
3. Run `[build] command` if configured. Locate the WASM: `--wasm` >
   `hpy.toml [build] wasm` > manifest `wasm_file` relative to the plugin dir >
   `<cargo target dir>/wasm32-*/release/<crate_name>.wasm` (from
   `cargo metadata`, so a workspace's shared `target/` is found). Ambiguity is
   an error listing the candidates.
4. Check the WASM is a WASM module (magic bytes), ≤16 MiB; read images, sniff
   their type, check ≤1 MiB and get width/height.
5. Check the registry state: `getRecord` for the release rkey in the user's
   repo — if it exists, stop ("<version> is already published; releases are
   immutable — bump the version"). `getRelease` on the registry — if it reports
   `deleted`, stop ("withdrawn versions cannot be republished").
6. If no profile record exists, create it from `hpy.toml [profile]` (or stop
   and point at `profile init` if that's missing). An existing profile is
   never modified by publish (PDS wins).
7. Show a summary (package, version, size, checksum, capabilities, requires)
   and confirm unless `--yes`. Without a terminal (or with `--no-input`) and
   without `--yes`, publish stops with exit 2: an irreversible release needs
   explicit consent. `--dry-run` stops here and prints
   the record JSON.
8. `uploadBlob` the WASM and images; verify each returned CID's multihash
   equals the locally computed checksum.
9. `createRecord` (not put — fails if the rkey appeared in the meantime).
10. Print the AT URI. With `--wait`, poll `getRelease` until `active` (or
    timeout, default 2 min), surfacing `pending` progress.

**`plugin status`** — `getPackage` plus `listReleases` (or `getRelease` for a
single version) from the registry; table of version / status / indexed-at,
highlighting versions present in the user's repo but unknown to the registry
("not indexed — the registry refused or hasn't seen it").

**`plugin withdraw`** — Deletes the release record. Requires typing the
version to confirm (or `--yes`), and explains the release will still be served
by exact version and can never be republished.

## `hpy.toml`

Lives beside `manifest.json`. Everything is optional except what `publish`
needs that the manifest doesn't carry (license, authors, security — and those
only until the profile exists on the PDS).

```toml
[profile]
slug = "happyview-atproto"          # default: manifest id
name = "Atproto"                    # default: manifest name
description = "AT Protocol service resolution, blob download, labels, signing."
license = "MIT"
keywords = ["atproto", "library"]
authors = [{ name = "Trezy", url = "https://trezy.com", email = "tre@trezy.com" }]
security = [{ email = "security@happyproto.at" }]

[profile.sections]                  # paths relative to hpy.toml
description = "README.md"
changelog = "CHANGELOG.md"

[release]
repo = "https://github.com/gamesgamesgamesgamesgames/happyview-plugins"
# version = "0.1.0"                 # default: manifest version

[release.requires]
"env:happyview" = ">=3.0.0"
# "at://did:plc:…/at.happyproto.plugin.profile/happyview-http" = "^0.1"

[release.artifacts]
icon = { path = "assets/icon.png", alt = "Atproto logo" }
banner = { path = "assets/banner.png" }
screenshots = [{ path = "assets/shot1.png", alt = "…" }]

[build]
command = "cargo build --release --target wasm32-unknown-unknown -p happyview-atproto"
wasm = "../../target/wasm32-unknown-unknown/release/happyview_atproto.wasm"
```

`manifest.json` → `releaseExtension` mapping: `plugin_type` → `pluginType`,
`api_version` → `apiVersion`, `namespace`, `language_id` → `languageId`,
`capabilities`, `allowed_hosts` → `allowedHosts`. Unknown manifest keys are
ignored.

## Authentication

### OAuth (default)

atproto OAuth as a **native public client** using `jacquard-oauth`:
identity resolution (handle → DID → PDS → authorization server), PAR, PKCE,
DPoP-bound tokens with nonce retry, refresh. The redirect lands on an
ephemeral loopback server at `http://127.0.0.1:<port>/oauth/callback`
(`one_shot_server`); the browser is opened automatically, and the URL is also
printed for `--no-browser`/SSH use.

Scopes (granular, least privilege):
`atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*`.

Client identity is configurable, because production needs a hosted document:

- **Default for now:** the atproto localhost development client
  (`client_id = http://localhost/?redirect_uri=…&scope=…`). Works against any
  PDS today with no hosting; PDSes may shorten its session lifetime.
- **Production:** set `oauth.client_id` (config file, `HPY_OAUTH_CLIENT_ID`,
  or the compiled-in default once it exists) to a hosted metadata document,
  e.g. `https://happyproto.at/oauth/hpy/client-metadata.json`, with
  `application_type: "native"`, `token_endpoint_auth_method: "none"`,
  `dpop_bound_access_tokens: true`, the scopes above, and redirect URIs
  `http://127.0.0.1/oauth/callback` and `http://[::1]/oauth/callback`
  (loopback port is variable per RFC 8252 §7.3). `hpy` ships a
  `docs/oauth-client-metadata.json` to host. **External dependency:** someone
  must host it; switching the compiled-in default is a one-line change.

### App password

`--app-password` (or `HPY_IDENTIFIER` + `HPY_APP_PASSWORD` in the environment,
which bypasses stored sessions entirely — the CI path) uses a `jacquard`
credential session.

### Storage

Session data (OAuth tokens + DPoP key, or app-password JWTs) is stored by
jacquard's `FileAuthStore` in `$CONFIG/hpy/credentials.json`, created with
`0600` permissions (the same model as `gh`'s and `aws`'s fallback stores).
A small non-secret pointer file, `$CONFIG/hpy/session.toml`, records the
active DID, handle, PDS, auth method, session id and — for OAuth — the exact
`client_id`, redirect URI and scope used at login. Token refresh must present
the same `client_id`, so restoring a session rebuilds the OAuth client from
the pointer, not from current config.

OS keychain storage is deferred: jacquard's store is two async traits plus
session selectors, and a keychain-backed implementation is a self-contained
follow-up behind the same pointer file.

## Configuration

`$CONFIG/hpy/config.toml`, where `$CONFIG` is `$XDG_CONFIG_HOME` or
`~/.config` on every Unix including macOS (CLI convention, not
`~/Library/Application Support`), and `%APPDATA%` on Windows.

| Key | Env | Default |
| --- | --- | --- |
| `registry.url` | `HPY_REGISTRY_URL` | `https://api.happyproto.at` |
| `oauth.client_id` | `HPY_OAUTH_CLIENT_ID` | localhost dev client |
| `oauth.scope` | `HPY_OAUTH_SCOPE` | the granular scope string above |

Precedence: flag > env > config file > default.

## Architecture

Cargo workspace:

```
crates/
  hpy/            binary: clap command tree, prompts (inquire), output, exit codes
  hpy-atproto/    sessions (OAuth + app password + env), credential store,
                  repo operations (getRecord/putRecord/createRecord/deleteRecord/
                  uploadBlob), registry XRPC client
  hpy-plugin/     hpy.toml + manifest.json loading, validation, checksum/CID,
                  WASM + image inspection, profile/release record building
```

- `hpy-plugin` is pure (no network, no prompts): input files in, typed records
  and `Vec<Problem>` out. Fully unit-testable.
- `hpy-atproto` exposes a small `Repo` trait (`get_record`, `put_record`,
  `create_record`, `delete_record`, `upload_blob`) and a `Registry` trait
  (`get_package`, `get_release`, `list_releases`). Commands depend on the
  traits, so command logic is tested with in-memory fakes; the jacquard-backed
  implementations are thin.
- `hpy` owns all interaction. A `Prompter` abstraction answers "get value for
  field X": flag value if given, else prompt if interactive, else error
  `missing --x (no TTY to prompt)`.
- Later milestones add `hpy-happyview`, `hpy-happyproto` crates and
  subcommand modules; they reuse `hpy-atproto` sessions.

Records are built as `serde_json::Value` against hand-written structs mirroring
the lexicons (no codegen dependency); `requires` and `extensions` are maps.

## Error handling and output

- `miette` diagnostics: every error says what failed and what to do next.
  Validation problems are collected and printed as a list with the field path
  (`release.requires["env:happyview"]: uses ||, which …`).
- Exit codes: 0 ok, 1 runtime/remote failure, 2 usage/validation error,
  3 not logged in.
- `--json`: commands print one JSON document to stdout; progress and prompts
  go to stderr.
- Network failures from the PDS are reported with the XRPC error name and
  message; an expired/revoked session says "run `hpy login`".

## Testing

- `hpy-plugin`: unit tests for every validation rule (mirroring the Lua
  prelude's cases), checksum against known vectors (a CID produced by a PDS for
  known bytes), manifest→extension mapping, WASM/image sniffing, hpy.toml
  parsing; golden tests for built records.
- Command logic: tests against in-memory `Repo`/`Registry` fakes — publish
  happy path, already-published, withdrawn version, missing profile creates
  it, existing profile untouched, CID mismatch aborts before `createRecord`.
- CLI: `assert_cmd` tests for help output, `--no-input` missing-flag errors,
  `--dry-run` output, exit codes.
- Live auth/PDS is verified manually (documented in the README); not in CI.

## Distribution

`dist` (axodotdev) generates the GitHub Actions release workflow: on a `v*`
tag it builds `aarch64/x86_64` macOS, `x86_64/aarch64` Linux (gnu + musl) and
`x86_64` Windows, uploads archives + checksums to the GitHub Release, publishes
a Homebrew formula to `happyproto/homebrew-tap`, and provides a shell/PowerShell
installer. **External dependencies:** the tap repository and a
`HOMEBREW_TAP_TOKEN` secret must be created by a maintainer. The binary name
is `hpy`; the crate/package name is `hpy-cli` (crates.io `hpy` is not
assumed available).

Linux packages (added 2026-10-09): a dist `post-announce-jobs` workflow builds
`.deb` and `.rpm` packages with nfpm from the static musl binaries
(x86_64 and aarch64), attaches them to the release, and publishes a signed
apt + yum repository to the `gh-pages` branch (GitHub Pages). Prereleases are
attached but not published to the repository. `packaging/test-repo.sh`
verifies install and upgrade with apt (Debian 12) and dnf (Fedora) in Docker.

## Risks

- **Loopback redirect with a hosted native client:** relies on the PDS
  accepting a variable loopback port for registered `http://127.0.0.1` redirect
  URIs (RFC 8252). The localhost dev client avoids this until verified.
- **Granular scope support:** older PDSes may not understand `repo:`/`blob:`
  scopes. Fallback: `oauth.scope` / `HPY_OAUTH_SCOPE` can be set to
  `atproto transition:generic`; the error for a rejected scope says so.
- **jacquard 0.12 API churn:** pinned to an exact minor; isolated behind
  `hpy-atproto`, so a swap to atrium is contained.
