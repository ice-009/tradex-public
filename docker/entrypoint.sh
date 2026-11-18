#!/bin/sh
# Tradex container start: prepare the data volume, load the secrets, bring the
# accounts database up to the current schema, then run the server ("$@").
set -eu

mkdir -p /data/cache

# NEXTAUTH_SECRET signs sign-in sessions. Use the one given; otherwise generate
# one on first start and keep it on the volume, so sessions survive restarts.
if [ -z "${NEXTAUTH_SECRET:-}" ]; then
  if [ ! -s /data/nextauth-secret ]; then
    (umask 077 && node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" > /data/nextauth-secret)
    echo "Generated NEXTAUTH_SECRET (kept in /data/nextauth-secret)."
  fi
  NEXTAUTH_SECRET=$(cat /data/nextauth-secret)
  export NEXTAUTH_SECRET
fi

# HUB_KEY: use the one given; otherwise read HUB_KEY_FILE (compose.yaml points
# it at the key its hub-key service created). The key is never printed.
if [ -z "${HUB_KEY:-}" ] && [ -n "${HUB_KEY_FILE:-}" ]; then
  if [ -s "$HUB_KEY_FILE" ]; then
    HUB_KEY=$(cat "$HUB_KEY_FILE")
    export HUB_KEY
  else
    echo "HUB_KEY_FILE ($HUB_KEY_FILE) is missing or empty: running without a Market Data Hub." >&2
  fi
fi

# Create the accounts database, or add new tables and columns after an
# upgrade. `db push` refuses changes that would lose data, so a start that
# needs one fails here instead.
(cd /opt/prisma && node node_modules/prisma/build/index.js db push)

exec "$@"
