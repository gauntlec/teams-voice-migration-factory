#!/bin/sh
# Starts as root only long enough to make the files volume writable by the app user, then runs the command as that user.
# Releases before 2026.10 ran as root, so an existing volume can hold root-owned files: fix that once (a no-op afterwards).
set -e
if [ "$(id -u)" = "0" ]; then
  dir="${FILES_DIR:-/data/files}"
  mkdir -p "$dir"
  if [ "$(stat -c %u "$dir")" != "$(id -u node)" ]; then
    chown -R node:node "$dir"
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
