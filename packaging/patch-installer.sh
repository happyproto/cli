#!/usr/bin/env bash
# Patches dist's shell installer (hpy-cli-installer.sh) in place so that it
# refuses hpy's musl archive where that build cannot start.
#
# Rust's musl build was static. Bun's is dynamically linked against musl's
# loader and libstdc++, and dist's installer still treats it as static: it
# picks it on any musl system (a bare Alpine has no libstdc++), and on glibc
# older than 2.31 as the fallback for the gnu build (where there is no musl
# loader at all). The hpy it installs then fails at its first run. That
# includes a Rust hpy (up to 1.0.0-alpha.32) updating itself, which runs the
# new release's installer, so the check has to be in the installer.
#
# release.yml runs this on the installer `dist build --artifacts=global`
# makes, before it is uploaded (hence dist's `allow-dirty = ["ci"]`), and
# packaging/test-installer.sh --local and the packaging CI job test the
# result. It edits two anchors in dist's template and fails if either is not
# there exactly once: when dist (pinned in dist-workspace.toml) is upgraded,
# check this still applies.
#
# Usage: packaging/patch-installer.sh path/to/hpy-cli-installer.sh
set -euo pipefail

fail() {
  printf 'patch-installer: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "usage: $0 hpy-cli-installer.sh"
file="$1"
[[ -f "$file" ]] || fail "$file: no such file"

marker='# --- hpy: musl runtime check (packaging/patch-installer.sh) ---'

# dist takes the gnu build's minimum glibc from the build host unless
# dist-workspace.toml's [dist.min-glibc-version] says otherwise. Bun's gnu
# build needs 2.31; any other minimum turns supported systems away from it
# (and then, with this patch, away from the musl fallback too).
want='check_glibc "2" "31"'
found=$(grep -o 'check_glibc "[0-9]*" "[0-9]*"' "$file" | sort -u || true)
[[ -n "$found" ]] || fail "dist's installer checks no glibc version; update this script for the new dist"
[[ "$found" == "$want" ]] \
  || fail "the installer requires $(echo "$found" | tr '\n' ' ')for the gnu build, not 2.31: check [dist.min-glibc-version] in dist-workspace.toml"
grep -qF "$marker" "$file" && fail "$file is already patched"

define='select_archive_for_arch() {'
call='download_binary_and_run_installer "$@" || exit 1'
[[ "$(grep -cxF "$define" "$file")" == 1 ]] \
  || fail "dist's installer no longer defines select_archive_for_arch() once; update this script for the new dist"
[[ "$(grep -cxF "$call" "$file")" == 1 ]] \
  || fail "dist's installer no longer ends by calling download_binary_and_run_installer once; update this script for the new dist"

# read, not $(cat <<…): bash mis-parses the case patterns' `)` inside $(…).
IFS= read -r -d '' check <<'EOF' || true
# The archive dist's own select_archive_for_arch picks, unless it is the musl
# one and this system cannot run it. It runs in a subshell, so refusing exits
# that and the installer stops before downloading anything. The message is
# printed even with --quiet, which only hides dist's own errors.
select_archive_for_arch() {
    _hpy_archive="$(dist_select_archive_for_arch "$1")" || return 1
    case "$_hpy_archive" in
        *-unknown-linux-musl.*) hpy_check_musl_runtime "$_hpy_archive" ;;
    esac
    echo "$_hpy_archive"
}

hpy_check_musl_runtime() {
    case "$1" in
        *aarch64-*) _hpy_arch=aarch64 ;;
        *) _hpy_arch=x86_64 ;;
    esac
    if [ ! -e "/lib/ld-musl-$_hpy_arch.so.1" ]; then
        hpy_refuse "hpy needs glibc 2.31 or newer on Linux, and this system's glibc is older. (hpy's other Linux build is for musl systems such as Alpine.) Install hpy on a newer distribution, or with npm and Node 22.20 or newer: npm install -g hpy"
    fi
    for _hpy_dir in /usr/lib /lib /usr/local/lib /usr/lib64 /lib64 "/usr/lib/$_hpy_arch-linux-musl"; do
        if [ -e "$_hpy_dir/libstdc++.so.6" ]; then
            return 0
        fi
    done
    hpy_refuse "hpy's build for musl Linux needs libstdc++, which this system does not have. Install it (on Alpine: apk add libstdc++), then run the installer again. Nothing was installed."
}

hpy_refuse() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}
EOF

tmp="$(mktemp "$file.XXXXXX")"
block="$(mktemp)"
trap 'rm -f "$tmp" "$block"' EXIT
# awk -v cannot carry newlines, so the block goes through a file.
printf '%s\n%s# --- end of the hpy patch ---\n\n' "$marker" "$check" > "$block"
awk -v define="$define" -v call="$call" -v block="$block" '
  $0 == define { print "dist_select_archive_for_arch() {"; next }
  $0 == call { while ((getline line < block) > 0) print line; print; next }
  { print }
' "$file" > "$tmp"
chmod --reference="$file" "$tmp" 2>/dev/null || chmod "$(stat -f %Lp "$file")" "$tmp"
mv "$tmp" "$file"
rm -f "$block"
trap - EXIT
echo "patched $file"
