# Installs the newest hpy beta release for this machine.
#
# GitHub's `releases/latest` is the newest stable release and never a
# prerelease, so this reads the releases list, which the API answers newest
# first, and takes the first tag on this channel. The call is parenthesized
# so Windows PowerShell 5.1 passes the releases on one at a time rather than
# as a single array.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'happyproto/cli'
$tag = ((Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=100") |
  Where-Object { $_.tag_name -match '-beta(\.|$)' } |
  Select-Object -First 1).tag_name
if (-not $tag) { throw 'no hpy release on the beta channel' }
Invoke-RestMethod "https://github.com/$repo/releases/download/$tag/hpy-cli-installer.ps1" | Invoke-Expression
