#!/usr/bin/env bash
# End-to-end test of the Linux packages and the apt/yum repository, in Docker.
#
#   1. builds a static Linux `hpy` (musl, for the host's architecture)
#   2. packages it as 0.0.1 with build-packages.sh, publishes it with
#      update-repo.sh using a throwaway signing key
#   3. checks the shell and PowerShell installers resolve their own channel,
#      then serves the site and installs `hpy` from it on Debian (apt) and
#      Fedora (dnf), exactly as the README tells users to
#   4. publishes 0.0.2-alpha.1 to the alpha channel and checks stable
#      ignores it, then publishes 0.0.2 and checks both upgrade
#   5. switches both to the alpha channel with the commands `hpy channel`
#      prints (crates/hpy/src/update.rs `switch_hint`), which downgrades
#      0.0.2 to 0.0.2-alpha.1
#
# The signing key has a passphrase, as the release workflow's may.
#
# Usage: packaging/test-repo.sh
#   HPY_TEST_BINARY=path/to/linux/hpy  skip step 1 and use this binary
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$root/target/packaging-test"
net="hpy-repo-test-$$"
containers=()

cleanup() {
  for c in ${containers[@]+"${containers[@]}"}; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }

case "$(uname -m)" in
  arm64 | aarch64) musl=aarch64-unknown-linux-musl ;;
  *) musl=x86_64-unknown-linux-musl ;;
esac

rm -rf "$work/site" "$work/dist"
mkdir -p "$work/site" "$work/dist"

if [[ -n "${HPY_TEST_BINARY:-}" ]]; then
  [[ "$HPY_TEST_BINARY" -ef "$work/hpy" ]] || cp "$HPY_TEST_BINARY" "$work/hpy"
else
  step "building a static Linux hpy ($musl)"
  docker run --rm \
    -v "$root:/src" -v hpy-cargo-registry:/usr/local/cargo/registry \
    -e CARGO_TARGET_DIR=/src/target/linux \
    -w /src rust:1-bookworm bash -c "
      apt-get update -qq && apt-get install -y -qq musl-tools >/dev/null &&
      rustup target add $musl >/dev/null &&
      cargo build --release --locked -p hpy-cli --target $musl"
  cp "$root/target/linux/$musl/release/hpy" "$work/hpy"
fi

# The publisher: the same tools the release workflow installs on ubuntu.
step "packaging and publishing 0.0.1"
publisher="hpy-publisher-$$"
containers+=("$publisher")
docker run -d --name "$publisher" -v "$root:/src" -w /src ubuntu:22.04 sleep infinity >/dev/null
docker exec "$publisher" bash -c '
  set -e
  apt-get update -qq && apt-get install -y -qq apt-utils createrepo-c gnupg curl ca-certificates >/dev/null
  packaging/install-nfpm.sh /usr/local/bin
  export GNUPGHOME=$(mktemp -d)
  gpg --batch --quiet --pinentry-mode loopback --passphrase test-pass \
    --quick-gen-key "hpy test <test@example.com>" rsa3072 sign never
  gpg --batch --pinentry-mode loopback --passphrase test-pass --armor --export-secret-keys > /tmp/key.asc
'
publish() { # version channel
  docker exec -e VERSION="$1" -e CHANNEL="$2" -e GPG_PASSPHRASE=test-pass -e NFPM_PASSPHRASE=test-pass "$publisher" bash -c '
    set -e
    export GNUPGHOME=$(mktemp -d)
    gpg --batch --quiet --import /tmp/key.asc
    rm -rf target/packaging-test/dist/*
    RPM_SIGNING_KEY=/tmp/key.asc packaging/build-packages.sh "$VERSION" target/packaging-test/dist \
      "'"$(arch_pair)"'"
    packaging/update-repo.sh target/packaging-test/site http://repo:8000 "$CHANNEL" target/packaging-test/dist/*
  '
}
arch_pair() {
  case "$musl" in
    aarch64-*) echo "arm64:target/packaging-test/hpy" ;;
    *) echo "amd64:target/packaging-test/hpy" ;;
  esac
}
publish 0.0.1 stable

# The shell installers install from GitHub rather than from this repository,
# so what can be checked here is that each one is written, parses, and
# resolves its own channel. Running one would install a real release over the
# machine's hpy.
step "checking the shell installers"
for c in "" -beta -alpha; do
  f="$work/site/install$c.sh"
  [[ -f "$f" ]] || { echo "test-repo: $f was not written" >&2; exit 1; }
  sh -n "$f" || { echo "test-repo: $f is not valid sh" >&2; exit 1; }
done
if ! grep -q 'releases/latest/download' "$work/site/install.sh"; then
  echo "test-repo: the stable installer should use releases/latest" >&2
  exit 1
fi
# A copy/paste between the two channels is invisible until someone on one of
# them installs the other's release. `if !` rather than `&&`, which under
# `set -e` would end the run on the passing case.
for c in beta alpha; do
  if [[ "$c" == beta ]]; then other=alpha; else other=beta; fi
  for f in "$work/site/install-$c.sh" "$work/site/install-$c.ps1"; do
    if ! grep -q -- "-$c(" "$f"; then
      echo "test-repo: $(basename "$f") does not select the $c channel" >&2
      exit 1
    fi
    if grep -q -- "-$other(" "$f"; then
      echo "test-repo: $(basename "$f") also selects $other" >&2
      exit 1
    fi
  done
done

# The PowerShell installers get the same checks a `sh -n` cannot give them:
# this image has no pwsh, so what is checked is that each one is written and
# points at the .ps1 asset rather than the shell one.
step "checking the PowerShell installers"
for c in "" -beta -alpha; do
  f="$work/site/install$c.ps1"
  [[ -f "$f" ]] || { echo "test-repo: $f was not written" >&2; exit 1; }
  if ! grep -q 'hpy-cli-installer\.ps1' "$f"; then
    echo "test-repo: install$c.ps1 does not install the .ps1 asset" >&2
    exit 1
  fi
done
if ! grep -q 'releases/latest/download' "$work/site/install.ps1"; then
  echo "test-repo: the stable PowerShell installer should use releases/latest" >&2
  exit 1
fi

step "serving the repository"
docker network create "$net" >/dev/null
containers+=("hpy-repo-$$")
docker run -d --name "hpy-repo-$$" --network "$net" --network-alias repo \
  -v "$work/site:/site:ro" -w /site python:3-alpine python -m http.server 8000 >/dev/null

step "installing with apt on Debian 12"
debian="hpy-debian-$$"
containers+=("$debian")
docker run -d --name "$debian" --network "$net" debian:12 sleep infinity >/dev/null
docker exec "$debian" bash -c '
  set -e
  apt-get update -qq && apt-get install -y -qq curl gpg ca-certificates >/dev/null
  curl -fsSL http://repo:8000/gpg.key | gpg --dearmor -o /usr/share/keyrings/hpy.gpg
  echo "deb [signed-by=/usr/share/keyrings/hpy.gpg] http://repo:8000/deb stable main" > /etc/apt/sources.list.d/hpy.list
  apt-get update -qq
  apt-get install -y -qq hpy >/dev/null
  hpy --version
  test "$(dpkg-query -W -f="\${Version}" hpy)" = 0.0.1
'

step "installing with dnf on Fedora"
fedora="hpy-fedora-$$"
containers+=("$fedora")
docker run -d --name "$fedora" --network "$net" fedora:latest sleep infinity >/dev/null
docker exec "$fedora" bash -c '
  set -e
  curl -fsSL http://repo:8000/hpy.repo -o /etc/yum.repos.d/hpy.repo
  dnf install -y -q hpy
  hpy --version
  test "$(rpm -q --qf "%{VERSION}" hpy)" = 0.0.1
'

step "publishing 0.0.2-alpha.1, which stable ignores"
publish 0.0.2-alpha.1 alpha
docker exec "$debian" bash -c '
  set -e
  apt-get update -qq && apt-get install -y -qq --only-upgrade hpy >/dev/null
  test "$(dpkg-query -W -f="\${Version}" hpy)" = 0.0.1
'
docker exec "$fedora" bash -c '
  set -e
  dnf upgrade -y -q --refresh hpy
  test "$(rpm -q --qf "%{VERSION}" hpy)" = 0.0.1
'

step "publishing 0.0.2 and upgrading"
publish 0.0.2 stable
docker exec "$debian" bash -c '
  set -e
  apt-get update -qq && apt-get install -y -qq --only-upgrade hpy >/dev/null
  test "$(dpkg-query -W -f="\${Version}" hpy)" = 0.0.2
  ls /var/lib/apt/lists | grep -q repo
'
docker exec "$fedora" bash -c '
  set -e
  dnf upgrade -y -q --refresh hpy
  test "$(rpm -q --qf "%{VERSION}" hpy)" = 0.0.2
'
test -f "$work/site/deb/pool/stable/h/hpy/hpy_0.0.1_$(arch_pair | cut -d: -f1).deb" # old versions stay installable

step "switching to the alpha channel, back to 0.0.2-alpha.1"
docker exec "$debian" bash -c '
  set -e
  sed -i "s#/deb [a-z]* main#/deb alpha main#" /etc/apt/sources.list.d/hpy.list
  apt-get update -qq
  apt-get install -y -qq --allow-downgrades hpy=0.0.2~alpha.1 >/dev/null
  hpy --version
  test "$(dpkg-query -W -f="\${Version}" hpy)" = 0.0.2~alpha.1
'
docker exec "$fedora" bash -c '
  set -e
  curl -fsSL http://repo:8000/hpy-alpha.repo -o /etc/yum.repos.d/hpy.repo
  dnf distro-sync -y -q hpy
  hpy --version
  test "$(rpm -q --qf "%{VERSION}" hpy)" = 0.0.2~alpha.1
'

step "ok: apt and dnf install, upgrade and switch channels from the repository"
