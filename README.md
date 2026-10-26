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

That installs the newest **stable** release, of which there is none until
`1.0.0` is cut — for now use the `beta` channel's installer, below.

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.ps1 | iex"
```

**From source**

```sh
cargo install --git https://github.com/happyproto/cli --locked hpy-cli
```

`--locked` builds the dependency versions this release was tested with.
Without it cargo resolves them afresh, which builds something nobody tested
and fails outright whenever one of them has been yanked. Prefer one of the
options above: they install a prebuilt binary, and `hpy update` can then
replace it in place.

**Prereleases**

These install the stable channel. For the `beta` or `alpha` channel (see
[Updates](#updates)):

- Homebrew: `brew install happyproto/tap/hpy-beta` (or `hpy-alpha`).
- apt: write `beta` (or `alpha`) in place of `stable` in `hpy.list`.
- dnf: download `hpy-beta.repo` (or `hpy-alpha.repo`) in place of `hpy.repo`.
- The install script: `install-beta.sh` or `install-alpha.sh` in place of
  `install.sh`, which is the whole difference:

  ```sh
  curl -fsSL https://happyproto.github.io/cli/install-beta.sh | sh
  ```

After installing, `hpy update` keeps you on the channel you installed from, and
`hpy channel` moves you between them.

The Linux packages contain a static (musl) binary, so they install on any
glibc or musl distribution, on x86_64 and arm64.

## How publishing works

Your plugin lives in **your own atproto repo**, as `software.release`
records that the registry indexes:

| Record | Key | What it is |
| --- | --- | --- |
| `software.release.project` | `<name>` | The plugin as a whole. |
| `site.standard.publication` | `<name>` | Its display name, description and icon. |
| `at.happyproto.registry.project` | `<name>` | What the registry adds: plugin type, keywords, authors, security contacts. |
| `software.release.manifest` | TID | One build: the `.wasm` and its `manifest.json` (uploaded as blobs), images, license, sections and `requires`. |
| `software.release.version` | `<name>:<version>` | A version, pointing at its manifest. |
| `software.release.channel` | `<name>:<channel>` | Where `latest`, `beta` or `alpha` points. |
| `software.release.status` | TID | A lifecycle event: end of support, end of life, … |
| `site.standard.document` | TID | A version's changelog. |

`hpy` signs you in through the registry's HappyView
(`https://api.happyproto.at`). It writes through the registry's gateway
procedures, which check what you send against the indexer's rules, explain
any refusal, and then write the records to your repo for you:

| Procedure | Used by |
| --- | --- |
| `putProject` | `init`, `edit` and `publish`: the project, its publication and the registry's sidecar. |
| `publishRelease` | `publish`: the manifest, the version, the channel it moves and the changelog. |
| `promoteRelease` | `publish --promote`: a new version of an existing version's build. |
| `putStatus` | `lifecycle`: a lifecycle event, or the withdrawal of one. |

`hpy` checks the same rules locally first, so most mistakes show up before
anything leaves your machine. It then asks the registry for its verdict
before uploading a single byte. Every upload is checked against the CID the record names it by, and an image a previous
version or the project already holds isn't sent again. Once a version is
written, the registry copies its blobs and marks it `available`.

**Versions are immutable.** A published version can never be changed. If a
publish is cut off partway, run it again: the registry finishes the version
it started rather than refusing it.

**Channels** (`latest`, `beta`, `alpha`) say which version to install by
default. A publish moves one channel to the new version (`--track` picks it).
Installing from a channel, or `hpy happyview add`, resolves it to an exact
version.

**Signing in again.** The default `oauth.scope` covers the `software.release`
collections, which an older `hpy` login does not. After updating `hpy`, run
`hpy registry login` again, and export a new `HPY_CREDENTIAL` for CI with
`hpy registry login --export`.

## Quick start

From a plugin directory, meaning one with a `manifest.json`:

```sh
hpy registry login alice.bsky.social
hpy registry plugin init            # prompts; writes [project] in hpy.toml and creates the project
cargo build --release --target wasm32-unknown-unknown
hpy registry plugin publish --wait  # validates, uploads, writes the version, waits for "available"
```

Every prompt has a flag equivalent, so this also works without a terminal:

```sh
hpy registry plugin init --no-input \
  --author "Ada <ada@example.com> (https://ada.dev)" \
  --security security@example.com --keyword atproto --yes
```

## Commands

| Command | Does |
| --- | --- |
| `hpy registry login [handle]` | Signs in through your browser. `--no-browser` prints the URL instead of opening it. `--export` signs in for CI and prints a credential instead of saving it (see below). |
| `hpy registry logout` | Revokes the session and deletes stored credentials. |
| `hpy registry whoami` | Shows the account you're signed in as. |
| `hpy registry plugin init` | Writes `[project]` in `hpy.toml` and creates the project, but only if the registry doesn't have it yet (`--local-only` skips that). `--name` sets the project name; `--display-name`, `--description`, `--author`, `--security` and `--keyword` fill in the rest. |
| `hpy registry plugin show` | Shows the project as the registry has it. |
| `hpy registry plugin edit` | Edits the project: with flags (`--display-name`, `--description`, `--author`, `--security`, `--keyword`, `--remove-keyword`; `--name` picks the project) or in `$EDITOR`. `hpy.toml` follows only when its `[project]` is this project. |
| `hpy registry plugin pull` | Copies the registry's project into `[project]` in `hpy.toml`. |
| `hpy registry plugin publish` | Publishes a new version. `--track latest\|beta\|alpha` picks the channel it moves (default: `latest` for a stable version, else the prerelease's name, `beta` or `alpha`); `--promote <from>` republishes an existing version's build as `--version` instead of building; `--dry-run` prints what would be published; `--wait` polls until the version is available; `--version` overrides the version; `--wasm` points at the module. |
| `hpy registry plugin status [version]` | Lists versions from your repo and from the registry, with each one's availability and lifecycle state. |
| `hpy registry plugin lifecycle <version> <event>` | Records a lifecycle event for a version: `endOfDevelopment`, `endOfSupport`, `supersededBy` (with `--superseded-by <version>`), `endOfDistribution` or `endOfLife`, with an optional `--kind` and `--reason`. `--project <event>` records it for the whole project. `--withdraw <status at-uri>` withdraws one recorded in error. A version at `endOfDistribution` or `endOfLife` is no longer offered for install. |
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
| `hpy happyview create --name <dir>` | Scaffolds a project: `happyview.toml`, `.gitignore`, `.env.example`, and one query lexicon with its handler. Prompts for the superadmin (default: the account `hpy registry login` holds), interpreters (Lua preselected), libraries and app name; `--superadmin`, `--interpreter`, `--library`, `--app-name` and `--happyview-version` answer them without a terminal, and `--project <at-uri>` picks between projects that answer to one name. Each plugin follows its project's `latest` channel, or the only channel it has. Writes the lock but downloads nothing. |
| `hpy happyview dev` | Runs the project with its pinned HappyView, in the foreground. |
| `hpy happyview add <plugin>` | Adds interpreters or libraries to `happyview.toml` and the lock, keeping the file's comments and order. Each follows a channel (`--channel`, default `latest`) or is pinned to `--version`; `--project <at-uri>` picks between projects that answer to one name. Adding a plugin again moves it to its channel's current version. With no plugin (or as `install`), brings the lock up to date and downloads it. |
| `hpy happyview check` | Builds the project without serving it; non-zero on any error. What CI runs. |
| `hpy happyview test [--watch] [filter]` | Runs the project's tests. Needs a HappyView that has `happyview test`, which no release has yet; until one does, HappyView refuses it as an unknown command. |

`hv` is short for `happyview`. `dev`, `check` and `test` take `--locked`,
which fails instead of updating a lock that no longer matches
`happyview.toml`; use it in CI. They exit with HappyView's own exit code.

Each plugin in `happyview.toml` names its project by its publisher's DID and
its name, and follows a channel or is pinned to one version:

```toml
[interpreters]
lua = { did = "did:plc:mo7vq4jbioxwafy5zkcc3eux", name = "happyview-lua", channel = "latest" }

[libraries]
"happyview.db" = { did = "did:plc:mo7vq4jbioxwafy5zkcc3eux", name = "happyview-db", version = "1.2.0" }
```

A channel is resolved when the lock is written. The lock records the channel
it followed (`channel = "latest"`, left out for a pinned version) and keeps
that version until you `add` the plugin again, so `check` and `dev` stay
reproducible as the channel moves on; changing an entry's channel or version
in `happyview.toml` makes the lock out of date. A channel pointing at a
version its publisher has ended distribution of is refused. A pinned version
is used even then, with a warning, since pinning it was your call. A plain
version string (`lua = "^1"`), from before the `software.release` registry, is
refused with the table form to use instead, and so is a `happyview.lock` from
then: delete it and run `hpy happyview check`.

A library a plugin requires is resolved to the highest installable version in
the range it asks for. Such a range never matches a prerelease unless it names
one, such as `"^0.1.0-alpha.3"`.

HappyView binaries are cached at `~/.cache/hpy/happyview/<version>/`
(`HPY_CACHE_DIR` moves the cache) and checked against the `.sha256`
published with each release. Plugins come from the registry into
`~/.cache/hpy/plugins/<id>/<version>/`. Their module and `manifest.json` are
checked against the blob CIDs in `happyview.lock`, and a registry whose
version no longer matches the manifest record the lock names is refused.
`dev`, `check` and `test` link them into the project's `.happyview/plugins/`
(on Windows they copy them), which `hpy` owns: anything else placed there is
removed.

### A local network

`hpy happyview dev --network local` runs the project against a private
atproto network on this computer instead of the real one, so test writes
never reach your real PDS or anyone's Jetstream. It needs Docker (with
Compose v2) and Deno 2.8 or later, on macOS or Linux.

The network is [Atmosphere in a Box](https://tangled.org/kandake.africa/atmosphereinabox)
v0.7.1 with its `full-stack` preset: a PLC directory, a PDS, a relay and
Jetstream, with private DNS and TLS. `hpy` downloads it once per project into
its data directory (`~/.local/share/hpy/networks/`, or `HPY_DATA_DIR`) and runs
HappyView inside it at `https://happyview.atmosbox.internal`, with your project
directory mounted, so saving a file works as it does natively. Sign in as
`user1.pds1.atmosbox.test`, which is the superadmin; `dev` prints its
password when it starts in a terminal.

The first run walks you through two things `hpy` never does for you: adding
the sandbox's hostnames to `/etc/hosts`, and trusting its certificate
authority in your browser or OS. Later runs check both and reuse the
network's accounts and records. Ctrl-C stops the network and keeps its data;
`--reset` discards it (with confirmation, or `--yes`). The local network keeps
its own database in `.happyview/local-network/`, apart from the one `dev` uses
against the real network.

Only one local network can run at a time, since its browser relay holds
`127.0.0.1:443`.

Each project's network gets a `/24` under `172.30.0.0/16`, chosen from the
project's path. If that range is already in use on your computer, by a VPN or
another Docker network, `dev` refuses to start and names what holds it. Pick
another range with `--subnet`, such as `--subnet 10.40.0.0/24`. It must be a
private IPv4 network, from `/16` to `/28`. The network keeps that range, even
through `--reset`, until you give another. A network that already exists can
move only by being recreated, so use `--reset --subnet <CIDR>` for that.

## `hpy.toml`

This file sits next to `manifest.json`. `manifest.json` stays the file
HappyView's loader reads, and `hpy` takes the plugin's type, version,
capabilities and allowed hosts from it. `hpy.toml` holds what the registry
needs on top of that: `[project]` describes the plugin as a whole, and
`[release]` what every version carries.

`publish` creates the project from `[project]` when the registry doesn't
have it, and updates it when `[project]` has changed. `edit` changes it
directly, and `pull` copies it back into the file.

```toml
[project]
name = "happyview-atproto"          # default: manifest id
display_name = "Atproto"            # default: manifest name
description = "AT Protocol service resolution, blob download, labels, signing."
icon = { path = "assets/icon.png" }
keywords = ["atproto", "library"]
authors = [{ name = "Ada", url = "https://ada.dev", email = "ada@example.com" }]
security = [{ email = "security@example.com" }]

[release]
license = "MIT"
changelog = "CHANGELOG.md"          # this version's entry becomes its changelog

[release.sections]                  # Markdown file paths, or { text = "…" }
description = "README.md"
installation = { text = "Add it with `hpy happyview add happyview.atproto`." }

[release.requires]
"env:happyview" = ">=3.0.0"
# "at://did:plc:…/software.release.project/happyview-http" = "^0.1"

[release.artifacts]
banner = { path = "assets/banner.png" }
screenshots = [{ path = "assets/shot1.png", alt = "…" }]

[build]
command = "cargo build --release --target wasm32-unknown-unknown -p happyview-atproto"
wasm = "../../target/wasm32-unknown-unknown/release/happyview_atproto.wasm"
```

An `hpy.toml` written by an older `hpy`, with a `[profile]` table, is refused
until its fields move to `[project]` and `[release]`.

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
    hpy-channel: beta    # until hpy 1.0.0 is out
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

- **Installed with the install script, with cargo, or by hand:** `hpy`
  downloads the release's own binary and puts it where this one is, and
  `hpy channel` does the same for the channel you switch to. After replacing a
  copy `cargo install` built, cargo still records the version it compiled, so
  installing hpy with cargo again rebuilds from source over it.
- **Installed with Homebrew, apt or dnf:** those track the files they own, and
  their next upgrade would revert a binary swapped underneath them, so `hpy`
  prints the command to run instead, e.g. `brew upgrade hpy`. Each channel has
  its own Homebrew formula (`hpy`, `hpy-beta`, `hpy-alpha`) and its own apt
  suite and yum repository.

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
| `oauth.scope` | `HPY_OAUTH_SCOPE` | `atproto repo:software.release.project repo:software.release.manifest repo:software.release.version repo:software.release.channel repo:software.release.status repo:at.happyproto.registry.project repo:site.standard.publication repo:site.standard.document blob:application/wasm blob:application/json blob:image/*` |
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
| `crates/hpy-plugin` | No network: reads `manifest.json` and `hpy.toml`, validates against the registry's rules, computes blob CIDs, builds what the gateway is sent. |
| `crates/hpy-atproto` | Signing in through HappyView: DPoP keys, PKCE, atproto OAuth with HappyView-signed client assertions, identity resolution via [jacquard](https://crates.io/crates/jacquard). Also the credential and keychain storage, the `Repo` trait (reads from your PDS, writes through HappyView), and the `Registry` trait (queries and publish procedures). |
| `crates/hpy` | The `hpy` binary: commands, prompts, output. |

### Manual verification

The automated tests use in-memory fakes for the PDS and the registry. Before
a release, run through the real flow once, using a scratch project name:

1. `hpy registry login <handle>` with a bsky.social account: the browser opens, you
   approve, and `whoami` shows you with "key in the OS keychain". Keychain
   Access (or your OS's equivalent) shows an `hpy` item. Repeat with an account
   on a self-hosted PDS.
2. `hpy registry login --export`, then
   `HPY_CREDENTIAL=<it> hpy registry whoami` shows "from HPY_CREDENTIAL".
3. In a scratch plugin directory: `hpy registry plugin init`, then `hpy registry plugin show`.
4. `hpy registry plugin edit --keyword test`, then `hpy registry plugin show`.
5. `hpy registry plugin publish --dry-run`, then `hpy registry plugin publish --wait`.
6. `hpy registry plugin status` shows the version as `available`.
7. `hpy registry plugin lifecycle <version> endOfDistribution`, then `status`
   shows it `unavailable` and not installable; `lifecycle --withdraw <its uri>`
   undoes it.
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
