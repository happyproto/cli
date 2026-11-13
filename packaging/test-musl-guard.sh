#!/usr/bin/env bash
# Tests the musl runtime check packaging/patch-installer.sh adds to dist's
# shell installer, in containers:
#   - Alpine without libstdc++: the installer refuses, says `apk add
#     libstdc++` (even with --quiet), and installs nothing;
#   - Alpine with libstdc++: it installs the musl build, which runs;
#   - Debian 10 (glibc 2.28, too old for the gnu build, so dist falls back to
#     musl): it refuses, naming glibc 2.31, and installs nothing;
#   - Debian 12 and Ubuntu 22.04 (glibc 2.36, 2.35): it installs the gnu build,
#     which runs (only when ASSETS has the gnu archive). dist once required the
#     build host's glibc (2.39) for it.
#
# Usage: packaging/test-musl-guard.sh ASSETS
#   ASSETS  a directory holding a patched hpy-cli-installer.sh and the
#           Docker host architecture's hpy-cli-<arch>-unknown-linux-musl.tar.xz
#           (with its .sha256), and optionally the gnu one, e.g.
#           target/distrib after `dist build`.
# Needs Docker; the cases that install need the network (apk, apt).
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
gnu_archive="hpy-cli-$arch-unknown-linux-gnu.tar.xz"

# Pinned by digest (multi-arch indexes), so a re-tagged image can't change
# what these cases test.
ALPINE=alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
DEBIAN10=debian:10-slim@sha256:bb3dc79fddbca7e8903248ab916bb775c96ec61014b3d02b4f06043b604726dc
DEBIAN12=debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
UBUNTU22=ubuntu:22.04@sha256:74b12b11ffa550fba1929ad4d8d16533c34f6612728469671afba1b03b66881c

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
out="$(run_installer "$ALPINE" ":")"
status=$?
set -e
printf '%s\n' "$out"
[[ $status -eq 1 ]] || fail "expected exit 1, got $status"
[[ "$out" == *"needs libstdc++"*"apk add libstdc++"* ]] || fail "the refusal does not say to install libstdc++"

step "Debian 10 (glibc 2.28): refuses the musl fallback"
set +e
out="$(run_installer "$DEBIAN10" ":")"
status=$?
set -e
printf '%s\n' "$out"
[[ $status -eq 1 ]] || fail "expected exit 1, got $status"
[[ "$out" == *"needs glibc 2.31 or newer"* ]] || fail "the refusal does not name glibc 2.31"

step "Alpine with libstdc++: installs the musl build"
[[ -f "$assets/$archive" ]] || fail "no $archive in $assets"
set +e
out="$(run_installer "$ALPINE" "apk add -q --no-cache libstdc++ >/dev/null")"
status=$?
set -e
printf '%s\n' "$out"
[[ $status -eq 0 ]] || fail "expected the install to succeed, got $status"
[[ "$out" == *"hpy "[0-9]* ]] || fail "the installed hpy did not print its version"

for image in "$DEBIAN12" "$UBUNTU22"; do
  step "${image%%@*}: installs the gnu build"
  if [[ ! -f "$assets/$gnu_archive" ]]; then
    echo "skipped: no $gnu_archive in $assets"
    continue
  fi
  set +e
  # dist's archives are .tar.xz, and the slim images have no xz.
  out="$(run_installer "$image" "apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xz-utils >/dev/null")"
  status=$?
  set -e
  printf '%s\n' "$out"
  [[ $status -eq 0 ]] || fail "expected the install to succeed, got $status"
  [[ "$out" == *"hpy "[0-9]* ]] || fail "the installed hpy did not print its version"
  [[ "$out" != *"too old"* ]] || fail "the installer turned ${image%%@*} away from the gnu build"
done

step "all musl guard cases passed"
