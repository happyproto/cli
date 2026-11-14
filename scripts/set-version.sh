#!/usr/bin/env bash
# Sets hpy's version (D9): package.json and package-lock.json, which the build
# reads it from (scripts/build.mjs defines HPY_VERSION), and dist.toml, which
# dist names the release's archives and installers from.
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
cd "$root"

# Rewrites package.json's and package-lock.json's version fields, and nothing
# else: no git commit or tag (semantic-release makes those), no scripts.
npm version "$version" --no-git-tag-version --allow-same-version --ignore-scripts >/dev/null

# Only dist.toml's [package] table has a bare `version = "…"` line.
manifest="$root/dist.toml"
awk -v v="$version" '
  /^\[/ { table = $0 }
  table == "[package]" && /^version = "/ { $0 = "version = \"" v "\"" }
  { print }
' "$manifest" > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"

grep -q "^version = \"$version\"" "$manifest" || {
  echo "set-version: did not find [package] version in $manifest" >&2
  exit 1
}
# shellcheck disable=SC2016 # a Node script, expanded by Node
node -e '
  const v = process.argv[1];
  const pkg = require("./package.json");
  const lock = require("./package-lock.json");
  if (pkg.version !== v || lock.version !== v || lock.packages[""].version !== v) {
    console.error(`set-version: package.json or package-lock.json is not at ${v}`);
    process.exit(1);
  }
' "$version"
echo "set-version: $version"
