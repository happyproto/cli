# Installs the newest stable hpy release for this machine.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-RestMethod https://github.com/happyproto/cli/releases/latest/download/hpy-cli-installer.ps1 | Invoke-Expression
