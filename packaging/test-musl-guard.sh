#!/usr/bin/env bash
# Tests the musl runtime check packaging/patch-installer.sh adds to dist's
# shell installer, in containers:
#   - Alpine without libstdc++: the installer refuses, says `apk add
#     libstdc++` (even with --quiet), and installs nothing;
#   - Alpine with libstdc++: it installs the musl build, which runs;
#   - Debian 10 (glibc 2.28, too old for the gnu build, so dist falls back to
#     musl): it refuses, naming glibc 2.31, and installs nothing.
#
# Usage: packaging/test-musl-guard.sh ASSETS
#   ASSETS  a directory holding a patched hpy-cli-installer.sh and the
#           Docker host architecture's hpy-cli-<arch>-unknown-linux-musl.tar.xz
#           (with its .sha256), e.g. target/distrib after `dist build`.
# Needs Docker; the Alpine case with libstdc++ needs the network for apk.
set -euo pipefail

fail() {
  printf 'test-musl-guard: FAIL: %s\n' "$*" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$*"; }

[[ $# -eq 1 ]] || fail "usage: $0 ASSETS"
assets="$(cd "$1" && pwd)"
[[ -f "$assets/hpy-cli-installer.sh" ]] || fail "no hpy-cli-installer.sh in $assets"
grep -qF '# --- hpy: musl runtime check' "$assets/hpy-cli-installer.sh" \
  || fail "$assets/hpy-cli-installer.sh is not patched (packaging/patch-installer.sh)"
case "$(docker version --format '{{.Server.Arch}}')" in
  arm64 | aarch64) arch=aarch64 ;;
  *) arch=x86_64 ;;
esac
archive="hpy-cli-$arch-unknown-linux-musl.tar.xz"

# Runs the installer in a fresh container of IMAGE, after SETUP (run as root),
# with downloads from /assets. Prints its stderr; returns its exit status.
# `curl` is a stand-in that copies file:// URLs, so the refusing cases need no
# network: they must stop before downloading anything anyway.
run_installer() { # image setup
  docker run --rm -i -v "$assets:/assets:ro" "$1" sh -c "
    set -e
    $2
    cat > /usr/local/bin/curl <<'CURL'
#!/bin/sh
# A stand-in curl: the installer's \`curl -sSfL URL -o FILE\` for file:// URLs.
out=; url=
while [ \$# -gt 0 ]; do
  case \"\$1\" in
    -o) out=\"\$2\"; shift ;;
    file://*) url=\"\${1#file://}\" ;;
  esac
  shift
done
[ -n \"\$url\" ] || exit 0
cp \"\$url\" \"\$out\"
CURL
    chmod +x /usr/local/bin/curl
    export HOME=/root CARGO_HOME=/root/cargo HPY_CLI_DOWNLOAD_URL=file:///assets HPY_CLI_NO_MODIFY_PATH=1
    set +e
    sh /assets/hpy-cli-installer.sh --quiet 2>/tmp/err
    status=\$?
    cat /tmp/err >&2
    if [ \$status -eq 0 ]; then
      HPY_NO_UPDATE_CHECK=1 /root/cargo/bin/hpy --version >&2 || exit 99
    elif [ -e /root/cargo/bin/hpy ]; then
      echo 'an hpy was installed anyway' >&2
      exit 98
    fi
    exit \$status
  " 2>&1
}

step "Alpine without libstdc++: refuses"
set +e
out="$(run_installer alpine:3.22 ":")"
status=$?
set -e
printf '%s\n' "$out"
[[ $status -eq 1 ]] || fail "expected exit 1, got $status"
[[ "$out" == *"needs libstdc++"*"apk add libstdc++"* ]] || fail "the refusal does not say to install libstdc++"

step "Debian 10 (glibc 2.28): refuses the musl fallback"
set +e
out="$(run_installer debian:10-slim ":")"
status=$?
set -e
printf '%s\n' "$out"
[[ $status -eq 1 ]] || fail "expected exit 1, got $status"
[[ "$out" == *"needs glibc 2.31 or newer"* ]] || fail "the refusal does not name glibc 2.31"

step "Alpine with libstdc++: installs the musl build"
[[ -f "$assets/$archive" ]] || fail "no $archive in $assets"
set +e
out="$(run_installer alpine:3.22 "apk add -q --no-cache libstdc++ >/dev/null")"
status=$?
set -e
printf '%s\n' "$out"
[[ $status -eq 0 ]] || fail "expected the install to succeed, got $status"
[[ "$out" == *"hpy "[0-9]* ]] || fail "the installed hpy did not print its version"

step "all musl guard cases passed"
