#!/usr/bin/env bash
# Sets the workspace version (every crate inherits it) and updates Cargo.lock.
# Called by semantic-release (.releaserc.json) with the version it decided.
#
# Usage: scripts/set-version.sh VERSION
set -euo pipefail

version="${1#v}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "set-version: \`$version\` is not a semver version" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$root/Cargo.toml"

# Only the [workspace.package] table has a bare `version = "…"` line; every
# dependency carries its version inline.
awk -v v="$version" '
  /^\[/ { table = $0 }
  table == "[workspace.package]" && /^version = "/ { $0 = "version = \"" v "\"" }
  { print }
' "$manifest" > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"

grep -q "^version = \"$version\"" "$manifest" || {
  echo "set-version: did not find [workspace.package] version in $manifest" >&2
  exit 1
}
cargo update --workspace --manifest-path "$manifest" --quiet
echo "set-version: $version"
