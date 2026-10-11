#!/usr/bin/env bash
# Installs a pinned, checksum-verified nfpm into DIR (default /usr/local/bin).
set -euo pipefail

version=2.47.0
dir="${1:-/usr/local/bin}"
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 sha=0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783 ;;
  aarch64 | arm64) arch=arm64 sha=1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c ;;
  *) echo "install-nfpm: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tarball="nfpm_${version}_Linux_${arch}.tar.gz"
curl -fsSL -o "$tmp/$tarball" "https://github.com/goreleaser/nfpm/releases/download/v${version}/${tarball}"
echo "$sha  $tmp/$tarball" | sha256sum -c --quiet -
tar -xzf "$tmp/$tarball" -C "$tmp" nfpm
install -m 0755 "$tmp/nfpm" "$dir/nfpm"
