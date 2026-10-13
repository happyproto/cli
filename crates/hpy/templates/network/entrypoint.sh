#!/bin/sh
set -eu
# The sandbox CA is only in /ca. HappyView's HTTP client reads the system
# bundle, so the two are joined into one file and it is pointed there.
cat /etc/ssl/certs/ca-certificates.crt /ca/root.crt > /tmp/ca-bundle.crt
export SSL_CERT_FILE=/tmp/ca-bundle.crt
# Everything below runs as the developer's uid, so the files HappyView writes
# into the bind-mounted project belong to them and its ownership check on
# `.happyview` passes. The directories are created here, as that user, so the
# database path exists and `.happyview` is private.
exec setpriv --reuid="$HV_UID" --regid="$HV_GID" --clear-groups sh -c '
  [ -d /project/.happyview ] || mkdir -m 0700 /project/.happyview
  mkdir -p /project/.happyview/local-network
  exec /opt/happyview/happyview "$@"
' happyview "$@"
