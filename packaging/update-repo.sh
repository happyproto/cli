#!/usr/bin/env bash
# Adds packages to the apt + yum repository in SITE_DIR and re-signs it.
#
# Usage: update-repo.sh SITE_DIR BASE_URL PACKAGE...
#   SITE_DIR  the GitHub Pages checkout; existing packages are kept, so every
#             published version stays installable
#   BASE_URL  where SITE_DIR is served, e.g. https://happyproto.github.io/cli
#   GPG_KEY_ID      signing key (default: the first secret key in the keyring)
#   GPG_PASSPHRASE  its passphrase, if it has one
#
# Needs apt-ftparchive (apt-utils), createrepo_c and gpg.
#
# Layout:
#   gpg.key                          public signing key
#   hpy.repo                         yum/dnf repository definition
#   install.sh                       the shell installer, for curl | sh
#   deb/dists/stable/...             apt metadata, InRelease + Release.gpg
#   deb/pool/main/h/hpy/*.deb
#   rpm/<x86_64|aarch64>/*.rpm       each with signed repodata/
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 SITE_DIR BASE_URL PACKAGE..." >&2
  exit 2
fi

site="$1"
base_url="${2%/}"
shift 2
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

pool="$site/deb/pool/main/h/hpy"
mkdir -p "$pool"
for pkg in "$@"; do
  case "$pkg" in
    *.deb) cp "$pkg" "$pool/" ;;
    *.x86_64.rpm) mkdir -p "$site/rpm/x86_64" && cp "$pkg" "$site/rpm/x86_64/" ;;
    *.aarch64.rpm) mkdir -p "$site/rpm/aarch64" && cp "$pkg" "$site/rpm/aarch64/" ;;
    *) echo "update-repo: skipping $pkg (not a .deb or x86_64/aarch64 .rpm)" >&2 ;;
  esac
done

# apt: one suite, one component, both architectures.
dists="$site/deb/dists/stable"
for arch in amd64 arm64; do
  mkdir -p "$dists/main/binary-$arch"
  (cd "$site/deb" && apt-ftparchive --arch "$arch" packages pool) > "$dists/main/binary-$arch/Packages"
  gzip -9 -n -k -f "$dists/main/binary-$arch/Packages"
done
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=HappyProto \
  -o APT::FTPArchive::Release::Label=hpy \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
  -o APT::FTPArchive::Release::Components=main \
  -o APT::FTPArchive::Release::Description="hpy, the HappyProto command line" \
  release "$dists" > "$dists/Release.tmp"
mv "$dists/Release.tmp" "$dists/Release"
sign --clearsign -o "$dists/InRelease" "$dists/Release"
sign --armor --detach-sign -o "$dists/Release.gpg" "$dists/Release"

# yum/dnf: one repository per architecture ($basearch).
for dir in "$site"/rpm/*/; do
  [[ -d "$dir" ]] || continue
  createrepo_c --quiet --update "$dir"
  sign --armor --detach-sign -o "$dir/repodata/repomd.xml.asc" "$dir/repodata/repomd.xml"
done

gpg --batch --armor --export "$key" > "$site/gpg.key"

cat > "$site/hpy.repo" <<EOF
[hpy]
name=hpy (HappyProto)
baseurl=$base_url/rpm/\$basearch
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$base_url/gpg.key
EOF

cat > "$site/install.sh" <<'EOF'
#!/bin/sh
# Installs the latest hpy release for this machine.
set -eu
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.sh | sh
EOF

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
</body>
</html>
EOF

touch "$site/.nojekyll"
echo "update-repo: $(find "$pool" -name '*.deb' | wc -l | tr -d ' ') .deb, $(find "$site/rpm" -name '*.rpm' | wc -l | tr -d ' ') .rpm in $site"
