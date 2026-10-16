#!/bin/sh
# Installs the newest hpy beta release for this machine.
#
# GitHub's `releases/latest` is the newest stable release and never a
# prerelease, so this reads the releases list, which the API answers newest
# first, and takes the first tag on this channel.
set -eu
repo=happyproto/cli
tag=$(curl --proto '=https' --tlsv1.2 -fsSL \
  "https://api.github.com/repos/$repo/releases?per_page=100" \
  | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | grep -E -- '-beta(\.|$)' \
  | head -n 1)
if [ -z "$tag" ]; then
  echo "no hpy release on the beta channel" >&2
  exit 1
fi
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://github.com/$repo/releases/download/$tag/hpy-cli-installer.sh" | sh
