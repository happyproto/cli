#!/bin/sh
# Installs the latest hpy release for this machine.
set -eu
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.sh | sh
