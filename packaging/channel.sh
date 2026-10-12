#!/usr/bin/env bash
# Prints the release channel a version or tag belongs to: stable, beta or
# alpha. Prints nothing for a prerelease no channel ships (e.g. -rc.1), which
# is published nowhere. Matches `Channel::of` in crates/hpy/src/channel.rs.
#
# Usage: channel.sh VERSION   (v1.2.0, 1.3.0-beta.1, ...)
set -euo pipefail

version="${1#v}"
case "$version" in
  *-*) pre="${version#*-}" ;;
  *) echo stable; exit 0 ;;
esac
case "${pre%%.*}" in
  beta) echo beta ;;
  alpha) echo alpha ;;
esac
