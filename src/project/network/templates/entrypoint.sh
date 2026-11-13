#!/bin/sh
set -eu
# The sandbox CA is only in /ca. HappyView's HTTP client reads the system
# bundle, so the two are joined into one file and it is pointed there.
cat /etc/ssl/certs/ca-certificates.crt /ca/root.crt > /tmp/ca-bundle.crt
export SSL_CERT_FILE=/tmp/ca-bundle.crt
# Everything below runs as the developer's uid, so the files HappyView writes
# into the bind-mounted project belong to them and its ownership check on
# `.happyview` passes. The directories are created here, as that user, so the
# database path exists and `.happyview` is private. The new shell does not
# inherit `set -e`, so it sets its own: a failed mkdir must stop here rather
# than surface later as a database error.
exec setpriv --reuid="$HV_UID" --regid="$HV_GID" --clear-groups sh -c '
  set -eu
  [ -d /project/.happyview ] || mkdir -m 0700 /project/.happyview
  mkdir -p /project/.happyview/local-network
  exec /opt/happyview/happyview "$@"
' happyview "$@"
