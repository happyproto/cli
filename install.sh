#!/bin/sh
# Installs the newest stable hpy release for this machine.
set -eu
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.sh | sh
