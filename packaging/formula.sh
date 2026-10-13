#!/usr/bin/env bash
# Turns dist's generated formula into the formula for a release channel:
# `hpy` for stable, `hpy-beta` and `hpy-alpha` for prereleases. Every channel's
# formula installs the same `hpy` binary, so each conflicts with the others.
#
# Usage: formula.sh DIST_FORMULA CHANNEL TAP_DIR
#   writes TAP_DIR/Formula/<name>.rb and prints its path
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 DIST_FORMULA CHANNEL TAP_DIR" >&2
  exit 2
fi
source="$1"
channel="$2"
tap="$3"

case "$channel" in
  stable) name=hpy class=Hpy ;;
  beta) name=hpy-beta class=HpyBeta ;;
  alpha) name=hpy-alpha class=HpyAlpha ;;
  *) echo "formula: unknown channel $channel" >&2; exit 2 ;;
esac
others=""
for n in hpy hpy-beta hpy-alpha; do
  [[ "$n" == "$name" ]] || others="${others:+$others, }\"$n\""
done
conflicts="  conflicts_with $others, because: \"each release channel installs the same hpy\""

grep -q '^class Hpy < Formula$' "$source" || { echo "formula: $source is not dist's hpy formula" >&2; exit 1; }
grep -q '^  license ' "$source" || { echo "formula: no license line in $source to follow" >&2; exit 1; }

mkdir -p "$tap/Formula"
out="$tap/Formula/$name.rb"
awk -v class="$class" -v conflicts="$conflicts" '
  /^class Hpy < Formula$/ { print "class " class " < Formula"; next }
  /^  license / { print; print conflicts; next }
  { print }
' "$source" > "$out"
echo "$out"
