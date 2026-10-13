# hpy

The HappyProto command line. One tool for the HappyProto ecosystem. It
publishes and manages **HappyView plugins** in the HappyProto registry, and
builds **HappyView apps** from a project directory. Commands for managing
HappyView instances and OAuth clients will be added later (see
[docs/roadmap/happyview-admin.md](docs/roadmap/happyview-admin.md)).

```sh
hpy registry login                  # sign in to the registry with your atproto account
hpy registry plugin init            # describe your plugin for the registry
hpy registry plugin publish         # publish the plugin in this directory
hpy registry plugin status          # see what the registry has picked up

hpy happyview create --name my-app  # start a HappyView app
hpy happyview dev                   # run it, from anywhere inside it
```

## Install

**macOS, Linux (Homebrew)**

```sh
brew install happyproto/tap/hpy
```

**Debian, Ubuntu**

```sh
curl -fsSL https://happyproto.github.io/cli/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/hpy.gpg
echo "deb [signed-by=/usr/share/keyrings/hpy.gpg] https://happyproto.github.io/cli/deb stable main" | sudo tee /etc/apt/sources.list.d/hpy.list
sudo apt update && sudo apt install hpy
```

**Fedora, RHEL, CentOS**

```sh
sudo curl -fsSL https://happyproto.github.io/cli/hpy.repo -o /etc/yum.repos.d/hpy.repo
sudo dnf install hpy
```

Upgrades then come with `apt upgrade` / `dnf upgrade`. Each release's `.deb`
and `.rpm` files are also attached to its GitHub Release, for installing
without the repository.

**Anything else (Linux, macOS)**

```sh
curl -fsSL https://happyproto.github.io/cli/install.sh | sh
```

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.ps1 | iex"
```

**From source**

```sh
cargo install --git https://github.com/happyproto/cli hpy-cli
```

**Prereleases**

These install the stable channel. For the `beta` or `alpha` channel (see
[Updates](#updates)):

- Homebrew: `brew install happyproto/tap/hpy-beta` (or `hpy-alpha`).
- apt: write `beta` (or `alpha`) in place of `stable` in `hpy.list`.
- dnf: download `hpy-beta.repo` (or `hpy-alpha.repo`) in place of `hpy.repo`.
- The install script: run the `hpy-cli-installer.sh` attached to the
  [release](https://github.com/happyproto/cli/releases) you want. After that,
  `hpy update` keeps you on its channel.

The Linux packages contain a static (musl) binary, so they install on any
glibc or musl distribution, on x86_64 and arm64.

## How publishing works

Your plugin lives in **your own atproto repo**, as two kinds of record that
the registry indexes:

| Record | Key | What it is |
| --- | --- | --- |
| `at.happyproto.plugin.profile` | `<slug>` | The package: license, authors, security contacts, description. |
| `at.happyproto.plugin.release` | `<slug>:<version>` | One version: the `.wasm` (uploaded as a blob), its checksum, its manifest, its dependencies. |

`hpy` signs you in through the registry's HappyView
(`https://api.happyproto.at`). It publishes with the registry's
`publishProfile` and `publishRelease` procedures, which check a record against
the indexer's rules, explain any refusal, and then write the record to your
repo for you. `hpy` checks the same rules locally first, so most mistakes show
up before anything leaves your machine. It then asks the registry for its
verdict before uploading a single byte. Once a release is written, the
registry copies the module and marks the release `active`.

**Releases are immutable.** A published version can never be changed. A
withdrawn version can never be published again.

## Quick start

From a plugin directory, meaning one with a `manifest.json`:

```sh
hpy registry login alice.bsky.social
hpy registry plugin init            # prompts; writes hpy.toml and creates the profile
cargo build --release --target wasm32-unknown-unknown
hpy registry plugin publish --wait  # validates, uploads, writes the release, waits for "active"
```

Every prompt has a flag equivalent, so this also works without a terminal:

```sh
hpy registry plugin init --no-input --license MIT \
  --author "Ada <ada@example.com> (https://ada.dev)" \
  --security security@example.com --keyword atproto --yes
```

## Commands

| Command | Does |
| --- | --- |
| `hpy registry login [handle]` | Signs in through your browser. `--no-browser` prints the URL instead of opening it. `--export` signs in for CI and prints a credential instead of saving it (see below). |
| `hpy registry logout` | Revokes the session and deletes stored credentials. |
| `hpy registry whoami` | Shows the account you're signed in as. |
| `hpy registry plugin init` | Writes `[profile]` in `hpy.toml` and creates the profile record, but only if one doesn't exist yet (`--local-only` skips the record). |
| `hpy registry plugin show` | Shows the profile on your PDS. |
| `hpy registry plugin edit` | Edits the profile on your PDS: with flags (`--name`, `--license`, `--author`, `--keyword`, `--remove-keyword` …) or in `$EDITOR`. |
| `hpy registry plugin pull` | Copies the PDS profile into `hpy.toml`. |
| `hpy registry plugin publish` | Publishes a new release. `--dry-run` prints the record without publishing, `--wait` polls until the release is active, `--version` overrides the version, `--wasm` points at the module. |
| `hpy registry plugin status [version]` | Lists releases from your repo and from the registry, with the registry's status for each. |
| `hpy registry plugin withdraw <version>` | Deletes a release record. The release stays installable by its exact version, but that version can never be reused. |
| `hpy update` | Updates `hpy` to the newest release on your channel (see [Updates](#updates)). |
| `hpy channel [stable\|beta\|alpha]` | Shows your release channel, or switches to another. `--yes` skips the confirmation. |

Global flags: `--json` (machine-readable output on stdout), `--no-input`
(never prompt), and `-C <dir>`.

Exit codes: `0` ok, `1` runtime or remote failure, `2` usage or validation
error, `3` not logged in.

## HappyView projects

A HappyView app can be a directory: lexicons and scripts under `src/`,
configuration in `happyview.toml`, exact plugin versions in `happyview.lock`.

| Command | Does |
| --- | --- |
| `hpy happyview create --name <dir>` | Scaffolds a project: `happyview.toml`, `.gitignore`, `.env.example`, and one query lexicon with its handler. Prompts for the superadmin (default: the account `hpy registry login` holds), interpreters (Lua preselected), libraries and app name; `--superadmin`, `--interpreter`, `--library`, `--app-name` and `--happyview-version` answer them without a terminal, and `--package <at-uri>` picks between packages with one name. Each plugin is pinned to its newest stable release, or its newest prerelease when it has nothing else. Writes the lock but downloads nothing. |
| `hpy happyview dev` | Runs the project with its pinned HappyView, in the foreground. |
| `hpy happyview add <plugin>[@version]` | Adds interpreters or libraries to `happyview.toml` and the lock, keeping the file's comments and order. `--package <at-uri>` picks between packages with one name. With no plugin (or as `install`), brings the lock up to date and downloads it. |
| `hpy happyview check` | Builds the project without serving it; non-zero on any error. What CI runs. |
| `hpy happyview test [--watch] [filter]` | Runs the project's tests. |

`hv` is short for `happyview`. `dev`, `check` and `test` take `--locked`,
which fails instead of updating a lock that no longer matches
`happyview.toml`; use it in CI. They exit with HappyView's own exit code.

A range in `happyview.toml` such as `"1.4"` or `"*"` never matches a
prerelease. A plugin that has published only prereleases needs a range that
names one, such as `"^0.1.0-alpha.3"`.

HappyView binaries are cached at `~/.cache/hpy/happyview/<version>/`
(`HPY_CACHE_DIR` moves the cache) and checked against the `.sha256`
published with each release. Plugins come from the registry into
`~/.cache/hpy/plugins/<id>/<version>/`, checked against the checksum in
their release record and in `happyview.lock`; a registry that ever states a
different checksum for a locked version is refused. `dev` links them into
the project's `.happyview/plugins/`, which `hpy` owns: anything else placed
there is removed.

## `hpy.toml`

This file sits next to `manifest.json`. `manifest.json` stays the file
HappyView's loader reads, and `hpy` takes the plugin's type, version,
capabilities and allowed hosts from it. `hpy.toml` holds what the registry
needs on top of that.

The profile on your PDS is the source of truth. `hpy.toml` seeds it the first
time, and `publish` creates the profile from `hpy.toml` only when none
exists yet. After that, change it with `profile edit`, and use `profile pull`
to sync it back into the file.

```toml
[profile]
slug = "happyview-atproto"          # default: manifest id
name = "Atproto"                    # default: manifest name
description = "AT Protocol service resolution, blob download, labels, signing."
license = "MIT"
keywords = ["atproto", "library"]
authors = [{ name = "Ada", url = "https://ada.dev", email = "ada@example.com" }]
security = [{ email = "security@example.com" }]

[profile.sections]                  # Markdown file paths, or { text = "…" }
description = "README.md"
changelog = "CHANGELOG.md"

[release]
repo = "https://github.com/example/happyview-atproto"
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

If `[build] wasm` and `--wasm` are both absent, `hpy` uses the manifest's
`wasm_file`. Failing that, it looks for `<cargo target dir>/wasm32-*/release/<crate>.wasm`,
which also works in a workspace with a shared `target/`. If it finds more than
one candidate, it lists them and asks you to choose with `--wasm`.

## Publishing from CI

CI can't open a browser, so you sign in once for it:

```sh
hpy registry login --export      # prints a credential; store it as a secret, e.g. HPY_CREDENTIAL
```

In CI, `HPY_CREDENTIAL` takes the place of a login:

```sh
HPY_CREDENTIAL=${{ secrets.HPY_CREDENTIAL }} \
  hpy registry plugin publish --no-input --yes --no-build --wasm path/to/plugin.wasm
```

The credential acts as you, so treat it like a password. It is a session of
its own: revoking it doesn't sign you out anywhere else, and signing out
locally doesn't break CI. Revoke it with `HPY_CREDENTIAL=… hpy registry logout`, or
from the HappyView dashboard.

On GitHub Actions, [`happyproto/actions/plugin-publish`](https://github.com/happyproto/actions)
installs `hpy` and does the above in one step:

```yaml
- uses: happyproto/actions/plugin-publish@v1
  with:
    version: 1.2.0
    credential: ${{ secrets.HPY_CREDENTIAL }}
    hpy-channel: alpha   # until hpy 1.0.0 is out
```

## Updates

Every release is on one channel:

| Channel | Versions | Cut from |
| --- | --- | --- |
| `stable` | `1.2.0` | `main` |
| `beta` | `1.3.0-beta.1` | `beta` |
| `alpha` | `1.3.0-alpha.4` | `alpha` |

Channels are strict: `hpy` only ever offers the newest release on the channel
you follow, never a newer one from another channel. Until you choose one with
`hpy channel`, you follow the channel your installed version came from.

`hpy channel alpha` (or `beta`, or `stable`, which `main` also names) switches
channel and installs that channel's newest release. It asks first when the
channel is a prerelease channel, which can be unstable, or when its newest
release is older than the one you have. Without a terminal, pass `--yes`.

`hpy update` updates to the newest release on your channel now. Otherwise, on
the first command of each day (UTC), `hpy` checks GitHub for one. The check
runs alongside the command and never delays it by more than about two
seconds.

- **Installed with the install script:** `hpy` updates itself in place, and
  `hpy channel` installs the new channel's release itself.
- **Installed with Homebrew, apt, dnf or cargo:** that package manager owns
  the binary, so `hpy` prints the commands to run instead, e.g.
  `brew upgrade hpy`. Each channel has its own Homebrew formula (`hpy`,
  `hpy-beta`, `hpy-alpha`) and its own apt suite and yum repository.

The daily check is skipped in CI, when there's no terminal, and when
`HPY_NO_UPDATE_CHECK=1` is set.

## Configuration

`~/.config/hpy/config.toml` (`$XDG_CONFIG_HOME/hpy` if that's set,
`%APPDATA%\hpy` on Windows). Precedence: flag > environment > file > default.

| Key | Environment | Default |
| --- | --- | --- |
| `registry.url` | `HPY_REGISTRY_URL` | `https://api.happyproto.at` |
| `registry.client_key` | `HPY_CLIENT_KEY` | `hpy`'s API client on `api.happyproto.at` |
| `oauth.client_id` | `HPY_OAUTH_CLIENT_ID` | `https://happyproto.at/oauth/hpy/client-metadata.json` |
| `oauth.scope` | `HPY_OAUTH_SCOPE` | `atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*` |
| `oauth.redirect` | `HPY_OAUTH_REDIRECT` | `https://happyproto.at/oauth/hpy/callback` (the relay); or `loopback` |
| `oauth.client_auth` | `HPY_OAUTH_CLIENT_AUTH` | `assertion` (confidential, signed by HappyView); or `none` (public) |
| `credentials.store` | `HPY_CREDENTIAL_STORE` | `auto` (the OS keychain, falling back to the file); also `keychain` or `file` |

These are read from the environment only:

| Environment | Default |
| --- | --- |
| `HPY_CACHE_DIR` | `~/.cache/hpy` (`%LOCALAPPDATA%\hpy` on Windows): HappyView binaries and plugins |
| `HPY_HAPPYVIEW_REPO` | `gamesgamesgamesgamesgames/happyview`: the GitHub repository HappyView releases come from |
| `HPY_GITHUB_API` | `https://api.github.com`: where `create` looks for the newest HappyView release |
| `HPY_HAPPYVIEW_DOWNLOAD` | `https://github.com/<HPY_HAPPYVIEW_REPO>/releases/download`: where binaries and their `.sha256` are downloaded from |

### Signing in: how the browser gets back to `hpy`

`hpy` signs in to your PDS as a *confidential* OAuth client, which the PDS
trusts with a long session (up to two years, versus two weeks for a public
client). HappyView signs the client assertion that proves it.

A confidential client must use an `https` redirect. So the PDS sends your
browser to `https://happyproto.at/oauth/hpy/callback`, a static page
(served by the `happyproto.at` site: `src/pages/oauth/hpy/callback.astro`, with its logic in `src/lib/hpy-relay.ts`). That page forwards the response to `hpy`
listening on `127.0.0.1`, at the port carried in the OAuth `state`. The page
never sees anything usable on its own: the code needs the PKCE verifier and
signing key that only the waiting `hpy` holds.

To run against an OAuth client of your own that is registered as a public
native app instead, set `HPY_OAUTH_REDIRECT=loopback` and
`HPY_OAUTH_CLIENT_AUTH=none`.

### Where your login is kept

Signing in gives `hpy` a signing key (a DPoP key) that the registry's
HappyView recognises you by; HappyView holds and refreshes your PDS session
itself. That key is the secret part:

- **The key** goes in the OS keychain: macOS Keychain, Windows Credential
  Manager, or the Secret Service (GNOME Keyring, KWallet) on Linux. It is
  stored under the service `hpy`.
- **Everything else** goes in `credentials.json` in the config directory,
  readable only by you. That's your DID, your handle, your PDS, and an access
  token that is useless without the key.

If there is no usable keychain, as on a headless server or in a container,
the key goes in `credentials.json` too, and `hpy registry login` tells you so. Set
`HPY_CREDENTIAL_STORE=keychain` to make that an error instead, or `file` to
skip the keychain entirely.

On macOS, after `hpy` updates itself, Keychain may ask once whether the new
`hpy` may use its key. Choose **Always Allow**. The binaries aren't
code-signed, so macOS sees each update as a new app.

## Development

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p hpy-cli -- --help
```

| Crate | Responsibility |
| --- | --- |
| `crates/hpy-plugin` | No network: reads `manifest.json` and `hpy.toml`, validates against the registry's rules, computes checksums, builds records. |
| `crates/hpy-atproto` | Signing in through HappyView: DPoP keys, PKCE, atproto OAuth with HappyView-signed client assertions, identity resolution via [jacquard](https://crates.io/crates/jacquard). Also the credential and keychain storage, the `Repo` trait (reads from your PDS, writes through HappyView), and the `Registry` trait (queries and publish procedures). |
| `crates/hpy` | The `hpy` binary: commands, prompts, output. |

### Manual verification

The automated tests use in-memory fakes for the PDS and the registry. Before
a release, run through the real flow once, using a scratch slug:

1. `hpy registry login <handle>` with a bsky.social account: the browser opens, you
   approve, and `whoami` shows you with "key in the OS keychain". Keychain
   Access (or your OS's equivalent) shows an `hpy` item. Repeat with an account
   on a self-hosted PDS.
2. `hpy registry login --export`, then
   `HPY_CREDENTIAL=<it> hpy registry whoami` shows "from HPY_CREDENTIAL".
3. In a scratch plugin directory: `hpy registry plugin init`, then `hpy registry plugin show`.
4. `hpy registry plugin edit --keyword test`, then `hpy registry plugin show`.
5. `hpy registry plugin publish --dry-run`, then `hpy registry plugin publish --wait`.
6. `hpy registry plugin status` shows the version as `active`.
7. `hpy registry plugin withdraw <version>`, then `status` shows `deleted`.
8. `hpy registry logout`: the keychain item is gone, and `whoami` exits with code 3.
   `HPY_CREDENTIAL=<it> hpy registry logout` revokes the exported session.

### Releasing

Versions come from the commit history. This works the same way as HappyView.
On every push to `main` (stable), `beta` or `alpha` (prereleases), once the
tests pass, CI runs [semantic-release](https://semantic-release.gitbook.io).
It reads the [Conventional Commits](https://www.conventionalcommits.org) since
the last release:

- `fix:` makes a patch release.
- `feat:` makes a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer makes a major release.
- Anything else makes no release.

semantic-release then sets the version in `Cargo.toml`, updates `Cargo.lock`
and `CHANGELOG.md`, commits and tags `vX.Y.Z`, and dispatches `release.yml`.

[dist](https://opensource.axo.dev/cargo-dist/) then builds every platform on
[Depot](https://depot.dev) runners, creates the GitHub Release and updates the
Homebrew formula. After that, `publish-linux-packages.yml` builds the
`.deb`/`.rpm` packages, attaches them to the release, and publishes them to the
apt/yum repository on the `gh-pages` branch. Every release goes to its own
channel only: the `hpy`, `hpy-beta` or `hpy-alpha` formula, and the `stable`,
`beta` or `alpha` apt suite and yum repository (`packaging/channel.sh` decides
which). A prerelease no channel ships, such as `-rc.1`, gets packages attached
to its release and is published nowhere else.

Never edit the version by hand. If `main` is ever protected, add a
`RELEASE_TOKEN` secret: a token that can push to it.

Repository setup:

- **Homebrew:** `publish-homebrew.yml` pushes the formula to
  `happyproto/homebrew-tap` as the `happyproto-infra-bump` GitHub App, using a
  short-lived token it mints each release. The app must be installed on the
  tap with Contents: read and write. This repository needs the
  `INFRA_APP_CLIENT_ID` variable and the `INFRA_APP_PRIVATE_KEY` secret, the
  same pair `happyproto/provisioner` uses.
- **Depot:** the `happyproto` organization must be connected to Depot.
- **Package signing key:** this is done. The key "HappyProto Packages
  <packages@happyproto.at>" has fingerprint
  `63B93CEDA23E09CFC42AE8A18B83C3B38ACAB74C`, and its public half is
  `packaging/hpy-packages.asc`. It is stored in the `LINUX_PACKAGES_GPG_KEY`
  and `LINUX_PACKAGES_GPG_PASSPHRASE` secrets. Keep an offline backup:
  replacing the key means every user re-imports `gpg.key`.
- **GitHub Pages:** after the first release (of any channel) creates the
  `gh-pages` branch, enable Pages for it (Settings → Pages → Deploy from a
  branch → `gh-pages` / root). To serve it from your own domain, set the custom domain there, set
  the repository variable `LINUX_PACKAGES_URL` (e.g. `https://pkg.happyproto.at`),
  and update the URLs in the Install section.

To re-publish packages for an existing release, run the *Publish Linux
packages* workflow by hand with its tag.

`packaging/test-repo.sh` tests the whole Linux path in Docker: it builds a
static `hpy`, packages and publishes it to a local repository with a
throwaway key, installs it with `apt` on Debian and `dnf` on Fedora, then
publishes an alpha and a newer stable version and checks both upgrade within
their channel, then switches both to the alpha channel with the commands
`hpy channel` prints.
