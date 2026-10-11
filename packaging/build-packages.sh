#!/usr/bin/env bash
# Builds hpy .deb and .rpm packages from already-built Linux binaries.
#
# Usage: build-packages.sh VERSION OUT_DIR ARCH:BINARY...
#   ARCH is amd64 or arm64 (nfpm names; rpm gets x86_64/aarch64).
#   RPM_SIGNING_KEY  optional armored private key file; signs the .rpm files
#   NFPM_PASSPHRASE  its passphrase, if it has one
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 VERSION OUT_DIR ARCH:BINARY..." >&2
  exit 2
fi

here="$(cd "$(dirname "$0")" && pwd)"
version="${1#v}"
out="$2"
shift 2
mkdir -p "$out"

readme="$(cd "$here/.." && pwd)/README.md"
signing_key="${RPM_SIGNING_KEY:-}"
config="$(mktemp)"
trap 'rm -f "$config"' EXIT

for pair in "$@"; do
  arch="${pair%%:*}"
  binary="$(cd "$(dirname "${pair#*:}")" && pwd)/$(basename "${pair#*:}")"
  case "$arch" in amd64 | arm64) ;; *) echo "unsupported arch $arch" >&2; exit 2 ;; esac
  [[ -f "$binary" ]] || { echo "no binary at $binary" >&2; exit 2; }

  # nfpm expands environment variables in only some fields, so render the
  # template instead. Without a key, drop the rpm signing block entirely.
  sed -e "s|@VERSION@|$version|g" -e "s|@ARCH@|$arch|g" \
      -e "s|@BINARY@|$binary|g" -e "s|@README@|$readme|g" \
      -e "s|@RPM_SIGNING_KEY@|$signing_key|g" "$here/nfpm.yaml" > "$config"
  if [[ -z "$signing_key" ]]; then
    sed -i.bak '/^rpm:/,$d' "$config" && rm -f "$config.bak"
  fi

  for format in deb rpm; do
    nfpm package --config "$config" --packager "$format" --target "$out/"
  done
done
ls -1 "$out"
