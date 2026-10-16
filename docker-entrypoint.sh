#!/bin/sh
set -e

# Unraid convention: run as nobody:users (99:100) unless PUID/PGID say otherwise.
PUID="${PUID:-99}"
PGID="${PGID:-100}"
CONFIG_DIR="${CONFIG_DIR:-/config}"

umask "${UMASK:-022}"
mkdir -p "$CONFIG_DIR"

if [ "$(id -u)" = "0" ]; then
  # Host-mounted appdata folders are often owned by root or a different UID:
  # hand /config (spinseek.db + WAL files) to PUID:PGID, then drop privileges.
  chown -R "$PUID:$PGID" "$CONFIG_DIR" 2>/dev/null \
    || echo "[spinseek] warning: could not chown $CONFIG_DIR to $PUID:$PGID (read-only or root-squashed share?)"
  if ! su-exec "$PUID:$PGID" sh -c 'test -w "$1"' _ "$CONFIG_DIR"; then
    echo "[spinseek] ERROR: $CONFIG_DIR is not writable by $PUID:$PGID. Fix the host folder permissions or PUID/PGID." >&2
    exit 1
  fi
  echo "[spinseek] running as $PUID:$PGID, config in $CONFIG_DIR"
  exec su-exec "$PUID:$PGID" "$@"
fi

# Started with --user: no chown possible, just verify access.
if [ ! -w "$CONFIG_DIR" ]; then
  echo "[spinseek] ERROR: $CONFIG_DIR is not writable by uid $(id -u). Fix the host folder permissions." >&2
  exit 1
fi
exec "$@"
