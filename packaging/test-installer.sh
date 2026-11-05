#!/usr/bin/env bash
# Tests the shell installer (install.sh, install-beta.sh and install-alpha.sh,
# all generated from packaging/install-wrapper.sh) against a real release's
# installer and archive, served from this machine.
#
# Every case runs the installer as `cat install-alpha.sh | sh`, as `curl | sh`
# would, with its own temporary HOME, XDG_CONFIG_HOME, CARGO_HOME and TMPDIR,
# and HPY_CLI_SYSTEM_DIR in place of /usr/local/bin. A case that needs a
# terminal runs in a pseudo-terminal, which also answers its prompts; one that
# must have none runs in a new session, without a controlling terminal.
#
# It never runs the real sudo where it runs: a stand-in `sudo` comes first on
# PATH, records its arguments, and runs the command as you, making the
# directories in SUDO_SHIM_UNLOCK writable for just that command, as root
# would find them. HPY_TEST_REAL_SUDO=1 hands the command to the real sudo
# after recording it instead; that is only for the Linux container (--docker)
# and is refused anywhere else.
#
# Usage:
#   packaging/test-installer.sh           here, with the stand-in sudo
#   packaging/test-installer.sh --docker  in an ubuntu:24.04 container, as a
#       non-root user with a NOPASSWD sudoers entry and the real sudo (and
#       /usr/local/bin); then as root, and as a user whose sudo asks for a
#       password, which the pseudo-terminal types
#
# Environment:
#   HPY_TEST_RELEASE   the release whose installer and archive are used
#                      (default v1.0.0-alpha.30)
#   HPY_TEST_ASSETS    a directory already holding them, instead of downloading
#   HPY_TEST_WORK      where to work (default target/installer-test)
#   HPY_TEST_ONLY      run only these cases (space-separated)
#   HPY_TEST_CONTAINER the container's name, with --docker
#   HPY_TEST_UPDATE_BINARY  with --docker: a Linux hpy built with an older
#                      version number than the newest alpha. A real
#                      `hpy update` then replaces it in /usr/local/bin, with
#                      the real sudo, from GitHub.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
release="${HPY_TEST_RELEASE:-v1.0.0-alpha.30}"
work="${HPY_TEST_WORK:-$root/target/installer-test}"
pages=https://pages.invalid

step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'test-installer: FAIL: %s\n' "$*" >&2
  exit 1
}

target_for() { # uname -s, uname -m
  case "$1/$2" in
    Darwin/arm64 | Darwin/aarch64) echo aarch64-apple-darwin ;;
    Darwin/x86_64) echo x86_64-apple-darwin ;;
    Linux/arm64 | Linux/aarch64) echo aarch64-unknown-linux-musl ;;
    Linux/x86_64) echo x86_64-unknown-linux-musl ;;
    *) fail "no release archive for $1/$2" ;;
  esac
}

fetch_assets() { # dir target
  mkdir -p "$1"
  local base="https://github.com/happyproto/cli/releases/download/$release"
  for f in hpy-cli-installer.sh "hpy-cli-$2.tar.xz"; do
    [[ -f "$1/$f" ]] || curl --proto '=https' --tlsv1.2 -fsSL "$base/$f" -o "$1/$f"
  done
}

# --- In a container ---------------------------------------------------------

if [[ "${1:-}" == --docker ]]; then
  container="${HPY_TEST_CONTAINER:-hpy-installer-test-$$}"
  arch="$(docker version --format '{{.Server.Arch}}')"
  case "$arch" in
    arm64 | aarch64) linux_target=aarch64-unknown-linux-musl ;;
    *) linux_target=x86_64-unknown-linux-musl ;;
  esac
  assets="${HPY_TEST_ASSETS:-$work/assets-linux}"
  fetch_assets "$assets" "$linux_target"
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  mounts=(-v "$root:/src:ro" -v "$assets:/assets:ro")
  if [[ -n "${HPY_TEST_UPDATE_BINARY:-}" ]]; then
    mounts+=(-v "$HPY_TEST_UPDATE_BINARY:/old-hpy:ro")
  fi
  step "starting $container (ubuntu:24.04)"
  docker run -d --name "$container" "${mounts[@]}" ubuntu:24.04 sleep infinity >/dev/null
  docker exec "$container" bash -c '
    set -e
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates python3 sudo xz-utils >/dev/null
    useradd -m -s /bin/bash tester
    echo "tester ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/tester
    useradd -m -s /bin/bash pwuser
    echo "pwuser:secret-pw" | chpasswd
    echo "pwuser ALL=(ALL) ALL" > /etc/sudoers.d/pwuser
    chmod 440 /etc/sudoers.d/tester /etc/sudoers.d/pwuser
  '
  run_in() { # user, then env assignments
    local user="$1"
    shift
    local home
    home="$(docker exec "$container" sh -c "getent passwd $user | cut -d: -f6")"
    docker exec -u "$user" -w "$home" -e HOME="$home" -e HPY_TEST_REAL_SUDO=1 \
      -e HPY_TEST_ASSETS=/assets -e HPY_TEST_WORK="$home/work" -e HPY_TEST_RELEASE="$release" \
      "$@" "$container" /src/packaging/test-installer.sh
  }
  step "as tester, with the real sudo (NOPASSWD)"
  if [[ -n "${HPY_TEST_UPDATE_BINARY:-}" ]]; then
    run_in tester -e HPY_TEST_UPDATE_BINARY=/old-hpy
  else
    run_in tester
  fi
  step "as root"
  run_in root -e HPY_TEST_ONLY=root
  step "as pwuser, whose sudo asks for a password"
  run_in pwuser -e HPY_TEST_ONLY=password -e HPY_TEST_SUDO_PASSWORD=secret-pw
  step "ok: the installer in ubuntu:24.04 with the real sudo"
  exit 0
fi

# --- The cases ----------------------------------------------------------------

real_sudo=""
if [[ "${HPY_TEST_REAL_SUDO:-}" == 1 ]]; then
  if [[ "$(uname -s)" != Linux || ! -f /.dockerenv ]]; then
    fail "HPY_TEST_REAL_SUDO=1 is only for the Linux container (--docker)"
  fi
  real_sudo="$(command -v sudo)" || fail "no sudo to hand commands to"
fi

target="$(target_for "$(uname -s)" "$(uname -m)")"
assets="${HPY_TEST_ASSETS:-$work/assets}"
fetch_assets "$assets" "$target"
version="$(sed -n 's/^APP_VERSION="\(.*\)"$/\1/p' "$assets/hpy-cli-installer.sh")"
[[ -n "$version" ]] || fail "$assets/hpy-cli-installer.sh has no APP_VERSION"

rm -rf "${work:?}/cases" "${work:?}/bin"
mkdir -p "$work/cases" "$work/bin"
work="$(cd "$work" && pwd -P)"

# The installer as update-repo.sh writes it, for the alpha channel.
wrapper="$work/install-alpha.sh"
sed -e "s/@CHANNEL@/alpha/g" -e "s#@BASE_URL@#$pages#g" "$root/packaging/install-wrapper.sh" > "$wrapper"
sh -n "$wrapper" || fail "$wrapper is not valid sh"

cat > "$work/bin/sudo" <<'EOF'
#!/bin/sh
# A stand-in for sudo (packaging/test-installer.sh).
printf '%s\n' "$*" >> "$SUDO_SHIM_LOG"
if [ "$1" = -n ] && [ -n "${SUDO_SHIM_N_FAILS:-}" ]; then
  echo "sudo: a password is required" >&2
  exit 1
fi
if [ -n "${SUDO_SHIM_REAL:-}" ]; then
  exec "$SUDO_SHIM_REAL" "$@"
fi
[ "$1" = -n ] && shift
old_ifs=$IFS
IFS=:
for d in ${SUDO_SHIM_UNLOCK:-}; do [ -d "$d" ] && chmod u+w "$d"; done
IFS=$old_ifs
"$@"
rc=$?
IFS=:
for d in ${SUDO_SHIM_UNLOCK:-}; do [ -d "$d" ] && chmod 555 "$d"; done
exit $rc
EOF
chmod 755 "$work/bin/sudo"

# Runs a command with or without a terminal. With one, it answers each
# PROMPT=ANSWER pair once, in order, when PROMPT appears.
cat > "$work/term.py" <<'EOF'
import os, pty, select, sys
mode = sys.argv[1]
sep = sys.argv.index("--")
pairs = [a.split("=", 1) for a in sys.argv[2:sep]]
argv = sys.argv[sep + 1:]
if mode == "notty":
    pid = os.fork()
    if pid == 0:
        os.setsid()  # no controlling terminal: /dev/tty does not open
        os.execvp(argv[0], argv)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
seen = b""
while True:
    ready, _, _ = select.select([fd], [], [], 120)
    if not ready:
        os.kill(pid, 9)
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    seen += data
    if pairs and pairs[0][0].encode() in seen:
        seen = seen.split(pairs[0][0].encode(), 1)[1]
        os.write(fd, (pairs.pop(0)[1] + "\n").encode())
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
EOF

step "serving $release's installer and archive"
python3 -I -u -m http.server --bind 127.0.0.1 --directory "$assets" 0 > "$work/server.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
port=""
for _ in $(seq 1 100); do
  port="$(sed -n 's/.*port \([0-9]*\).*/\1/p' "$work/server.log" | head -n 1)"
  [[ -n "$port" ]] && break
  sleep 0.1
done
[[ -n "$port" ]] || fail "the HTTP server did not start: $(cat "$work/server.log")"
url="http://127.0.0.1:$port"

# A fresh case: its directories, and the environment it runs in.
case_dir=""
new_case() { # name
  step "$1"
  case_dir="$work/cases/$1"
  mkdir -p "$case_dir/home" "$case_dir/tmp" "$case_dir/sys"
  : > "$case_dir/sudo.log"
}

# run MODE SYSDIR [PROMPT=ANSWER...] [-- VAR=VALUE...]: runs the installer,
# leaving its output in $case_dir/out and its exit status in $rc.
rc=0
run() {
  local mode="$1" sysdir="$2"
  shift 2
  local answers=() extra=()
  while [[ $# -gt 0 && "$1" != -- ]]; do answers+=("$1"); shift; done
  [[ "${1:-}" == -- ]] && shift
  extra=("$@")
  local envs=(
    PATH="$work/bin:${CASE_PATH:-$sysdir}:/usr/bin:/bin:/usr/sbin:/sbin"
    HOME="$case_dir/home"
    XDG_CONFIG_HOME="$case_dir/home/.config"
    TMPDIR="$case_dir/tmp"
    HPY_CLI_INSTALLER_URL="$url/hpy-cli-installer.sh"
    HPY_CLI_DOWNLOAD_URL="$url"
    HPY_CLI_SYSTEM_DIR="$sysdir"
    SUDO_SHIM_LOG="$case_dir/sudo.log"
    SUDO_SHIM_REAL="$real_sudo"
  )
  set +e
  # shellcheck disable=SC2016 # expanded by that sh
  env -i "${envs[@]}" ${extra[@]+"${extra[@]}"} \
    python3 -I "$work/term.py" "$mode" ${answers[@]+"${answers[@]}"} -- \
    /bin/sh -c 'cat "$1" | sh' sh "$wrapper" > "$case_dir/out" 2>&1
  rc=$?
  set -e
  sed 's/^/    | /' "$case_dir/out"
}

expect_rc() { [[ "$rc" == "$1" ]] || fail "exit status $rc, expected $1"; }
expect_out() { grep -qF -- "$1" "$case_dir/out" || fail "output lacks: $1"; }
expect_sudo_calls() { # expected lines, as patterns
  local got
  got="$(cat "$case_dir/sudo.log")"
  local n
  n="$(grep -c '' "$case_dir/sudo.log" || true)"
  [[ "$n" == "$#" ]] || fail "sudo was called $n times, expected $#:"$'\n'"$got"
  local i=1
  for pattern in "$@"; do
    sed -n "${i}p" "$case_dir/sudo.log" | grep -qE -- "^$pattern\$" \
      || fail "sudo call $i was: $(sed -n "${i}p" "$case_dir/sudo.log"), expected /$pattern/"
    i=$((i + 1))
  done
}
expect_installed() { # dir
  [[ -f "$1/hpy" && ! -L "$1/hpy" ]] || fail "$1/hpy was not installed"
  [[ -n "$(find "$1/hpy" -prune -perm 755)" ]] || fail "$1/hpy is not mode 0755"
  "$1/hpy" --version | grep -qF "$version" || fail "$1/hpy --version is not $version"
}
receipt() { echo "$case_dir/home/.config/hpy-cli/hpy-cli-receipt.json"; }
expect_receipt() { # prefix layout
  local r
  r="$(receipt)"
  [[ -f "$r" ]] || fail "no receipt at $r"
  [[ -O "$r" ]] || fail "the receipt is not owned by $(id -un)"
  grep -qF "\"install_prefix\":\"$1\"" "$r" || fail "the receipt's prefix is not $1: $(cat "$r")"
  grep -qF "\"install_layout\":\"$2\"" "$r" || fail "the receipt's layout is not $2: $(cat "$r")"
  grep -qF "\"version\":\"$version\"" "$r" || fail "the receipt's version is not $version: $(cat "$r")"
}
expect_clean_tmp() {
  [[ -z "$(ls -A "$case_dir/tmp")" ]] || fail "the temporary directory was left: $(ls -A "$case_dir/tmp")"
}
# A sysdir only root can write to: here, one that is locked (with the stand-in
# unlocking it); in the container, the real /usr/local/bin.
locked_sysdir() {
  if [[ -n "$real_sudo" ]]; then
    echo /usr/local/bin
  else
    chmod 555 "$case_dir/sys"
    echo "$case_dir/sys"
  fi
}
# An old copy in the case's ~/.cargo/bin, beside things that must survive.
old_cargo_copy() {
  local cargo="$case_dir/home/.cargo"
  mkdir -p "$cargo/bin" "$cargo/registry/cache"
  printf '#!/bin/sh\necho old hpy\n' > "$cargo/bin/hpy"
  chmod 755 "$cargo/bin/hpy"
  printf 'other\n' > "$cargo/bin/cargo-other"
  printf 'env\n' > "$cargo/env"
  printf 'crate\n' > "$cargo/registry/cache/some.crate"
}
dist_receipt() { # prefix
  mkdir -p "$case_dir/home/.config/hpy-cli"
  printf '{"binaries":["hpy"],"binary_aliases":{},"cdylibs":[],"cstaticlibs":[],"install_layout":"cargo-home","install_prefix":"%s","modify_path":true,"provider":{"source":"cargo-dist","version":"0.32.0"},"source":{"app_name":"hpy-cli","name":"cli","owner":"happyproto","release_type":"github"},"version":"1.0.0-alpha.20"}\n' "$1" \
    > "$(receipt)"
}
listing() { (cd "$1" && find . | LC_ALL=C sort); }

selected() { # name
  if [[ -n "${HPY_TEST_ONLY:-}" ]]; then
    [[ " $HPY_TEST_ONLY " == *" $1 "* ]]
  else
    [[ "$1" != root && "$1" != password && "$1" != update ]] \
      || { [[ "$1" == update && -n "${HPY_TEST_UPDATE_BINARY:-}" ]]; }
  fi
}

if selected fresh-writable; then
  new_case fresh-writable
  run notty "$case_dir/sys"
  expect_rc 0
  expect_sudo_calls
  expect_installed "$case_dir/sys"
  expect_receipt "$case_dir/sys" flat
  expect_clean_tmp
  [[ ! -e "$case_dir/home/.cargo" ]] || fail "something was put in ~/.cargo"
  [[ -z "$(find "$case_dir/home" -mindepth 1 -maxdepth 1 ! -name .config)" ]] \
    || fail "the home directory was changed: $(ls -A "$case_dir/home")"
fi

if selected fresh-unwritable; then
  new_case fresh-unwritable
  sys="$(locked_sysdir)"
  run tty "$sys" -- SUDO_SHIM_UNLOCK="$sys"
  [[ -z "$real_sudo" ]] && chmod 755 "$case_dir/sys"
  expect_rc 0
  expect_out "so sudo will ask for your password once to copy hpy there."
  expect_sudo_calls "install -m 0755 $case_dir/tmp/hpy-install\.[A-Za-z0-9]+/stage/hpy $sys/hpy"
  expect_installed "$sys"
  expect_receipt "$sys" flat
  expect_clean_tmp
  if [[ -n "$real_sudo" ]]; then
    [[ "$(stat -c %U "$sys/hpy")" == root ]] || fail "$sys/hpy is not root's"
  fi
fi

if selected fresh-absent; then
  new_case fresh-absent
  if [[ -n "$real_sudo" ]]; then
    sys=/opt/hpy-installer-test/bin
    unlock=""
  else
    mkdir -p "$case_dir/locked"
    chmod 555 "$case_dir/locked"
    sys="$case_dir/locked/sys/bin"
    unlock="$case_dir/locked"
  fi
  run tty "$sys" -- SUDO_SHIM_UNLOCK="$unlock"
  [[ -z "$real_sudo" ]] && chmod 755 "$case_dir/locked"
  expect_rc 0
  expect_out "does not exist and only root can create it, so sudo will ask for your password once to create it and copy hpy there."
  expect_sudo_calls "mkdir -p $sys" "install -m 0755 $case_dir/tmp/hpy-install\.[A-Za-z0-9]+/stage/hpy $sys/hpy"
  expect_installed "$sys"
  expect_receipt "$sys" flat
fi

if selected install-dir; then
  new_case install-dir
  run notty "$case_dir/sys" -- HPY_CLI_INSTALL_DIR="$case_dir/home/.local"
  expect_rc 0
  expect_sudo_calls
  expect_installed "$case_dir/home/.local/bin"
  [[ ! -e "$case_dir/sys/hpy" ]] || fail "the system directory was used"
  expect_receipt "$case_dir/home/.local" cargo-home
fi

if selected migrate-yes; then
  new_case migrate-yes
  old_cargo_copy
  dist_receipt "$case_dir/home/.cargo"
  before="$(listing "$case_dir/home/.cargo" | grep -v '^\./bin/hpy$')"
  run tty "$case_dir/sys" "Remove the old copy in ~/.cargo/bin/hpy? [Y/n]=y"
  expect_rc 0
  expect_out "Remove the old copy in ~/.cargo/bin/hpy? [Y/n]"
  expect_out "Removed ~/.cargo/bin/hpy."
  [[ ! -e "$case_dir/home/.cargo/bin/hpy" ]] || fail "the old copy was not removed"
  [[ "$(listing "$case_dir/home/.cargo")" == "$before" ]] \
    || fail "something else under ~/.cargo changed:"$'\n'"$(diff <(echo "$before") <(listing "$case_dir/home/.cargo"))"
  expect_sudo_calls
  expect_receipt "$case_dir/sys" flat
fi

if selected migrate-declined; then
  new_case migrate-declined
  old_cargo_copy
  dist_receipt "$case_dir/home/.cargo"
  run tty "$case_dir/sys" "[Y/n]=n"
  expect_rc 0
  [[ -f "$case_dir/home/.cargo/bin/hpy" ]] || fail "the old copy was removed after no"
  expect_out "Kept ~/.cargo/bin/hpy."
fi

if selected migrate-no-tty; then
  new_case migrate-no-tty
  old_cargo_copy
  dist_receipt "$case_dir/home/.cargo"
  run notty "$case_dir/sys"
  expect_rc 0
  [[ -f "$case_dir/home/.cargo/bin/hpy" ]] || fail "the old copy was removed without asking"
  expect_out "rm $case_dir/home/.cargo/bin/hpy"
fi

if selected migrate-no-receipt; then
  new_case migrate-no-receipt
  old_cargo_copy
  # ~/.cargo/bin first on PATH, as rustup puts it.
  CASE_PATH="$case_dir/home/.cargo/bin:$case_dir/sys" run tty "$case_dir/sys" "[Y/n]=y"
  expect_rc 0
  [[ -f "$case_dir/home/.cargo/bin/hpy" ]] || fail "a copy cargo install put there was removed"
  expect_out "was not put there by this installer"
  expect_out "\`hpy\` runs $case_dir/home/.cargo/bin/hpy, which comes before $case_dir/sys on your PATH"
  if grep -qF "[Y/n]" "$case_dir/out"; then fail "offered to remove a copy without a receipt"; fi
fi

if selected migrate-other-receipt; then
  new_case migrate-other-receipt
  old_cargo_copy
  dist_receipt "$case_dir/elsewhere"
  run tty "$case_dir/sys" "[Y/n]=y"
  expect_rc 0
  [[ -f "$case_dir/home/.cargo/bin/hpy" ]] || fail "removed a copy the receipt does not name"
  expect_out "was not put there by this installer"
fi

if selected no-tty-unwritable; then
  new_case no-tty-unwritable
  # sudo -n fails as it does when sudo needs a password: the stand-in says so
  # without asking the real one, even in the container.
  chmod 555 "$case_dir/sys"
  run notty "$case_dir/sys" -- SUDO_SHIM_N_FAILS=1 SUDO_SHIM_REAL=
  chmod 755 "$case_dir/sys"
  expect_rc 1
  expect_out "curl -fsSL $pages/install-alpha.sh | sh"
  expect_out "curl -fsSL $pages/install-alpha.sh | HPY_CLI_INSTALL_DIR=\"\$HOME/.local\" sh"
  expect_sudo_calls "-n install -m 0755 $case_dir/tmp/hpy-install\.[A-Za-z0-9]+/stage/hpy $case_dir/sys/hpy"
  [[ ! -e "$case_dir/sys/hpy" ]] || fail "hpy was installed anyway"
  [[ ! -e "$(receipt)" ]] || fail "a receipt was written for a failed install"
  expect_clean_tmp
fi

if selected no-tty-nopasswd && [[ -n "$real_sudo" ]]; then
  new_case no-tty-nopasswd
  sys=/opt/hpy-installer-test-n/bin
  sudo -n mkdir -p "$sys"
  run notty "$sys"
  expect_rc 0
  expect_sudo_calls "-n install -m 0755 $case_dir/tmp/hpy-install\.[A-Za-z0-9]+/stage/hpy $sys/hpy"
  expect_installed "$sys"
  expect_receipt "$sys" flat
fi

if selected root; then
  [[ "$(id -u)" == 0 ]] || fail "the root case runs as root"
  new_case root
  # HOME is someone else's: the receipt must not be written there as root.
  chown nobody "$case_dir/home"
  run notty /opt/hpy-installer-root/bin
  expect_rc 0
  expect_out "Running as root"
  expect_out "Not writing hpy's install receipt as root"
  expect_sudo_calls
  expect_installed /opt/hpy-installer-root/bin
  [[ ! -e "$(receipt)" ]] || fail "a receipt was written as root into another user's home"
fi

if selected password; then
  [[ -n "$real_sudo" && -n "${HPY_TEST_SUDO_PASSWORD:-}" ]] || fail "the password case is for the container"
  new_case password
  run tty /usr/local/bin "password for=$HPY_TEST_SUDO_PASSWORD"
  expect_rc 0
  expect_out "[sudo] password for $(id -un)"
  expect_sudo_calls "install -m 0755 $case_dir/tmp/hpy-install\.[A-Za-z0-9]+/stage/hpy /usr/local/bin/hpy"
  expect_installed /usr/local/bin
  expect_receipt /usr/local/bin flat
  [[ "$(stat -c %U /usr/local/bin/hpy)" == root ]] || fail "/usr/local/bin/hpy is not root's"
fi

# A real `hpy update`, from GitHub: a copy in /usr/local/bin with an older
# version number than the newest alpha, recorded as the installer records it.
if selected update; then
  [[ -n "$real_sudo" && -n "${HPY_TEST_UPDATE_BINARY:-}" ]] || fail "the update case is for the container"
  new_case update
  run tty /usr/local/bin
  expect_rc 0
  expect_receipt /usr/local/bin flat
  sudo install -m 0755 "$HPY_TEST_UPDATE_BINARY" /usr/local/bin/hpy
  old_version="$(/usr/local/bin/hpy --version)"
  echo "    installed $old_version over it"
  update_env=(
    PATH="$work/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    HOME="$case_dir/home"
    XDG_CONFIG_HOME="$case_dir/home/.config"
    TMPDIR="$case_dir/tmp"
    SUDO_SHIM_LOG="$case_dir/sudo.log"
    SUDO_SHIM_REAL="$real_sudo"
    HPY_NO_UPDATE_CHECK=1
  )
  : > "$case_dir/sudo.log"

  step "update: hpy update with no terminal"
  set +e
  env -i "${update_env[@]}" python3 -I "$work/term.py" notty -- /usr/local/bin/hpy update > "$case_dir/out" 2>&1
  rc=$?
  set -e
  sed 's/^/    | /' "$case_dir/out"
  expect_rc 1
  expect_out "sudo install -m 0755 "
  expect_out "This copy of hpy was left as it was."
  expect_sudo_calls
  cmp -s "$HPY_TEST_UPDATE_BINARY" /usr/local/bin/hpy || fail "the binary was changed"
  rm -rf "${case_dir:?}/tmp/"*

  step "update: hpy update in a terminal"
  set +e
  env -i "${update_env[@]}" python3 -I "$work/term.py" tty -- /usr/local/bin/hpy update > "$case_dir/out" 2>&1
  rc=$?
  set -e
  sed 's/^/    | /' "$case_dir/out"
  expect_rc 0
  expect_out "is not writable by you, so sudo will ask for your password"
  expect_sudo_calls "install -m 0755 $case_dir/tmp/hpy-update-[A-Za-z0-9]+/bin/hpy /usr/local/bin/hpy"
  new_version="$(/usr/local/bin/hpy --version)"
  [[ "$new_version" != "$old_version" ]] || fail "hpy update did not replace $old_version"
  [[ "$(stat -c %U /usr/local/bin/hpy)" == root ]] || fail "/usr/local/bin/hpy is not root's"
  grep -qF "\"version\":\"${new_version##* }\"" "$(receipt)" \
    || fail "the receipt does not record ${new_version##* }: $(cat "$(receipt)")"
  [[ -O "$(receipt)" ]] || fail "the receipt is not $(id -un)'s"
  expect_clean_tmp
  echo "    $old_version -> $new_version"
fi

step "ok: the shell installer (as $(id -un)$([[ -n "$real_sudo" ]] && echo ", real sudo" || echo ", stand-in sudo"))"
