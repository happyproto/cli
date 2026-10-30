#!/usr/bin/env bash
# Adds packages to a release channel's apt suite and yum repository in
# SITE_DIR and re-signs them.
#
# Usage: update-repo.sh SITE_DIR BASE_URL CHANNEL PACKAGE...
#   SITE_DIR  the GitHub Pages checkout; existing packages are kept, so every
#             published version stays installable
#   BASE_URL  where SITE_DIR is served, e.g. https://happyproto.github.io/cli
#   CHANNEL   stable, beta or alpha (packaging/channel.sh); each channel is
#             its own suite and repository, holding only its own releases
#   GPG_KEY_ID      signing key (default: the first secret key in the keyring)
#   GPG_PASSPHRASE  its passphrase, if it has one
#
# Needs apt-ftparchive (apt-utils), createrepo_c and gpg.
#
# Layout:
#   gpg.key                                  public signing key
#   hpy.repo, hpy-beta.repo, hpy-alpha.repo  yum/dnf repository definitions
#   install.sh                               the shell installer, for curl | sh
#   install.ps1                              the PowerShell installer, for irm | iex
#   deb/dists/<channel>/...                  apt metadata, InRelease + Release.gpg
#   deb/pool/<channel>/h/hpy/*.deb
#   rpm/<channel>/<x86_64|aarch64>/*.rpm     each with signed repodata/
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 SITE_DIR BASE_URL CHANNEL PACKAGE..." >&2
  exit 2
fi

site="$1"
base_url="${2%/}"
channel="$3"
shift 3
case "$channel" in
  stable | beta | alpha) ;;
  *) echo "update-repo: unknown channel $channel" >&2; exit 2 ;;
esac
key="${GPG_KEY_ID:-$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')}"
if [[ -z "$key" ]]; then
  echo "update-repo: no signing key in the keyring" >&2
  exit 1
fi
sign() {
  if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
    gpg --batch --yes --pinentry-mode loopback --passphrase "$GPG_PASSPHRASE" --local-user "$key" "$@"
  else
    gpg --batch --yes --pinentry-mode loopback --local-user "$key" "$@"
  fi
}

pool="$site/deb/pool/$channel/h/hpy"
rpms="$site/rpm/$channel"
mkdir -p "$pool"
for pkg in "$@"; do
  case "$pkg" in
    *.deb) cp "$pkg" "$pool/" ;;
    *.x86_64.rpm) mkdir -p "$rpms/x86_64" && cp "$pkg" "$rpms/x86_64/" ;;
    *.aarch64.rpm) mkdir -p "$rpms/aarch64" && cp "$pkg" "$rpms/aarch64/" ;;
    *) echo "update-repo: skipping $pkg (not a .deb or x86_64/aarch64 .rpm)" >&2 ;;
  esac
done

# apt: a suite per channel, one component, both architectures.
dists="$site/deb/dists/$channel"
for arch in amd64 arm64; do
  mkdir -p "$dists/main/binary-$arch"
  (cd "$site/deb" && apt-ftparchive --arch "$arch" packages "pool/$channel") > "$dists/main/binary-$arch/Packages"
  gzip -9 -n -k -f "$dists/main/binary-$arch/Packages"
done
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=HappyProto \
  -o APT::FTPArchive::Release::Label=hpy \
  -o APT::FTPArchive::Release::Suite="$channel" \
  -o APT::FTPArchive::Release::Codename="$channel" \
  -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
  -o APT::FTPArchive::Release::Components=main \
  -o APT::FTPArchive::Release::Description="hpy, the HappyProto command line" \
  release "$dists" > "$dists/Release.tmp"
mv "$dists/Release.tmp" "$dists/Release"
sign --clearsign -o "$dists/InRelease" "$dists/Release"
sign --armor --detach-sign -o "$dists/Release.gpg" "$dists/Release"

# yum/dnf: a repository per channel and architecture ($basearch).
for dir in "$rpms"/*/; do
  [[ -d "$dir" ]] || continue
  createrepo_c --quiet --update "$dir"
  sign --armor --detach-sign -o "$dir/repodata/repomd.xml.asc" "$dir/repodata/repomd.xml"
done

gpg --batch --armor --export "$key" > "$site/gpg.key"

for c in stable beta alpha; do
  if [[ "$c" == stable ]]; then id=hpy; else id="hpy-$c"; fi
  cat > "$site/$id.repo" <<EOF
[$id]
name=hpy $c (HappyProto)
baseurl=$base_url/rpm/$c/\$basearch
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$base_url/gpg.key
EOF
done

# One installer per channel, so a shell install is the same command
# everywhere and only the URL differs. Stable rides GitHub's own
# `releases/latest`; a prerelease channel cannot, because GitHub excludes
# prereleases from it, so those read the releases list instead. Resolving at
# install time rather than baking in the tag being published keeps a
# re-publish of an older release (this script run by hand) from moving a
# channel backwards.
cat > "$site/install.sh" <<'EOF'
#!/bin/sh
# Installs the newest stable hpy release for this machine.
set -eu
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.sh | sh
EOF

for c in beta alpha; do
  # A quoted heredoc through sed: the script is written exactly as it runs,
  # with no shell of this script's expanding anything inside it.
  sed "s/@CHANNEL@/$c/g" > "$site/install-$c.sh" <<'EOF'
#!/bin/sh
# Installs the newest hpy @CHANNEL@ release for this machine.
#
# GitHub's `releases/latest` is the newest stable release and never a
# prerelease, so this reads the releases list, which the API answers newest
# first, and takes the first tag on this channel.
set -eu
repo=happyproto/cli
tag=$(curl --proto '=https' --tlsv1.2 -fsSL \
  "https://api.github.com/repos/$repo/releases?per_page=100" \
  | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | grep -E -- '-@CHANNEL@(\.|$)' \
  | head -n 1)
if [ -z "$tag" ]; then
  echo "no hpy release on the @CHANNEL@ channel" >&2
  exit 1
fi
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://github.com/$repo/releases/download/$tag/hpy-cli-installer.sh" | sh
EOF
done

# The same per channel for Windows, which has the same problem: a
# `releases/latest` PowerShell command 404s while every release is a
# prerelease.
cat > "$site/install.ps1" <<'EOF'
# Installs the newest stable hpy release for this machine.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-RestMethod https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.ps1 | Invoke-Expression
EOF

for c in beta alpha; do
  sed "s/@CHANNEL@/$c/g" > "$site/install-$c.ps1" <<'EOF'
# Installs the newest hpy @CHANNEL@ release for this machine.
#
# GitHub's `releases/latest` is the newest stable release and never a
# prerelease, so this reads the releases list, which the API answers newest
# first, and takes the first tag on this channel. The call is parenthesized
# so Windows PowerShell 5.1 passes the releases on one at a time rather than
# as a single array.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'happyproto/cli'
$tag = ((Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=100") |
  Where-Object { $_.tag_name -match '-@CHANNEL@(\.|$)' } |
  Select-Object -First 1).tag_name
if (-not $tag) { throw 'no hpy release on the @CHANNEL@ channel' }
Invoke-RestMethod "https://github.com/$repo/releases/download/$tag/hpy-cli-installer.ps1" | Invoke-Expression
EOF
done

cat > "$site/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hpy packages</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
  pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; border-radius: 6px; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #141414; } pre { background: #222; } }
</style>
</head>
<body>
<h1>hpy</h1>
<p>Package repositories for <a href="https://github.com/happyproto/cli">hpy</a>, the HappyProto command line.</p>
<h2>Debian, Ubuntu</h2>
<pre>curl -fsSL $base_url/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/hpy.gpg
echo "deb [signed-by=/usr/share/keyrings/hpy.gpg] $base_url/deb stable main" | sudo tee /etc/apt/sources.list.d/hpy.list
sudo apt update &amp;&amp; sudo apt install hpy</pre>
<h2>Fedora, RHEL, CentOS</h2>
<pre>sudo curl -fsSL $base_url/hpy.repo -o /etc/yum.repos.d/hpy.repo
sudo dnf install hpy</pre>
<h2>Anything else</h2>
<pre>curl -fsSL $base_url/install.sh | sh</pre>
<p>For a prerelease channel, the same command with
<code>install-beta.sh</code> or <code>install-alpha.sh</code>.
<code>hpy update</code> then keeps you on the channel you installed from.</p>
<h2>Windows</h2>
<pre>powershell -ExecutionPolicy Bypass -c "irm $base_url/install.ps1 | iex"</pre>
<p>Or <code>install-beta.ps1</code> or <code>install-alpha.ps1</code> for a
prerelease channel.</p>
<h2>Prereleases</h2>
<p>The <code>beta</code> and <code>alpha</code> channels hold only their own releases. For apt, put the channel in place of <code>stable</code> in <code>hpy.list</code>; for dnf, download <code>hpy-beta.repo</code> or <code>hpy-alpha.repo</code> in place of <code>hpy.repo</code>; for the shell installer, <code>install-beta.sh</code> or <code>install-alpha.sh</code> in place of <code>install.sh</code>, and likewise <code>install-beta.ps1</code> or <code>install-alpha.ps1</code> for PowerShell. <code>hpy channel</code> prints the commands for switching an installed <code>hpy</code>.</p>
</body>
</html>
EOF

touch "$site/.nojekyll"
echo "update-repo: $channel has $(find "$pool" -name '*.deb' | wc -l | tr -d ' ') .deb, $(find "$rpms" -name '*.rpm' | wc -l | tr -d ' ') .rpm in $site"
