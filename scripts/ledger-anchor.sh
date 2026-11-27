#!/bin/sh
# Publish a sealed plan's hash outside the ledger (issue #33): an example for
# PLAN_LEDGER_PUBLISH_CMD, which the server runs after each new seal with
# SEAL_SEQ, SEAL_DAY, SEAL_KIND, SEAL_HASH, SEAL_PREV_HASH and SEAL_LINE (one
# JSON line) in the environment. Off unless you set the variable.
#
# This one appends SEAL_LINE to ledger.jsonl in a separate git checkout of a
# `ledger` branch (or any repository you own), commits and pushes it. The
# remote's record of each push is the outside timestamp; the file is what
# `npm run ledger -- verify --anchors <checkout>/ledger.jsonl` checks against.
#
#   git clone --branch ledger --single-branch git@github.com:<you>/<repo>.git ~/tradex-ledger
#   PLAN_LEDGER_PUBLISH_CMD="sh scripts/ledger-anchor.sh $HOME/tradex-ledger"
#
# A gist works the same way: clone it instead and push to its default branch.
set -eu

dir="${1:?usage: ledger-anchor.sh <git checkout>}"
cd "$dir"
printf '%s\n' "$SEAL_LINE" >> ledger.jsonl
git add ledger.jsonl
git commit -q -m "Seal #$SEAL_SEQ: $SEAL_DAY $SEAL_KIND $SEAL_HASH"
git push -q origin HEAD
echo "published #$SEAL_SEQ"
