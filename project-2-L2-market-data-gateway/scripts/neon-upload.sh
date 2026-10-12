#!/usr/bin/env bash
# scripts/neon-upload.sh — load replay sessions into Neon, using the
# connection string encrypted by scripts/secrets-lock.sh.
#
# Usage (Git Bash, from project-2-L2-market-data-gateway/):
#   bash scripts/neon-upload.sh --cpu-ghz=3.80001 \
#     BTC=data/replay-upload/BTC/session_1791756300000.ndjson.gz \
#     xyz:CL=data/replay-upload/xyz_CL/session_1791756300000.ndjson.gz
#
# Encrypted credentials are read from deploy/neon.env.enc (override with
# NEON_SECRETS=<path>). The file must contain a DATABASE_URL=... line; use
# Neon's POOLED connection string.
#
# The connection string is decrypted into this script's memory only, handed
# to each migration process through its environment (not its command line,
# which other processes can list), never printed, never written to disk,
# and unset before exit.
#
# Every upload runs with --replace: once a session has fully loaded, that
# symbol's older sessions are deleted in the same transaction (a failed load
# deletes nothing). Neon keeps exactly one session per symbol.
#
# Railway's replay workers load their session at startup, so restart or
# redeploy the relay afterwards (raising a paused usage limit does that).
set -euo pipefail

CIPHER=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENC="${NEON_SECRETS:-$ROOT/deploy/neon.env.enc}"

ghz=""
pairs=()
for arg in "$@"; do
  case "$arg" in
    --cpu-ghz=*) ghz="${arg#--cpu-ghz=}" ;;
    *=*) pairs+=("$arg") ;;
    *) echo "unrecognized argument: $arg" >&2; exit 1 ;;
  esac
done
[ -n "$ghz" ] && [ ${#pairs[@]} -gt 0 ] || {
  echo "usage: bash scripts/neon-upload.sh --cpu-ghz=<GHZ> <SYMBOL>=<session.ndjson.gz> [...]" >&2
  exit 1
}
[ -f "$ENC" ] || { echo "encrypted credentials not found: $ENC (run scripts/secrets-lock.sh first)" >&2; exit 1; }

# Resolve every file before asking for anything, so a typo fails fast.
files=()
for pair in "${pairs[@]}"; do
  file="${pair#*=}"
  [ -f "$file" ] || { echo "no such session file: $file" >&2; exit 1; }
  files+=("$(cd "$(dirname "$file")" && pwd)/$(basename "$file")")
done

read -rs -p "Passphrase for $(basename "$ENC"): " pass; echo
plain="$(printf '%s\n' "$pass" | openssl enc -d "${CIPHER[@]}" -pass stdin -in "$ENC" 2>/dev/null)" || {
  unset pass
  echo "could not decrypt $(basename "$ENC"): wrong passphrase or damaged file" >&2
  exit 1
}
unset pass
url="$(printf '%s\n' "$plain" | sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' | head -1 | tr -d '\r')"
unset plain
url="${url%\"}"; url="${url#\"}"; url="${url%\'}"; url="${url#\'}"
[ -n "$url" ] || { echo "no DATABASE_URL= line in the decrypted file" >&2; exit 1; }
trap 'unset url' EXIT

for i in "${!pairs[@]}"; do
  symbol="${pairs[$i]%%=*}"
  echo "== $symbol <- $(basename "${files[$i]}")"
  ( cd "$ROOT/relay" && DATABASE_URL="$url" node scripts/migrate-to-neon.mjs "${files[$i]}" --symbol="$symbol" --cpu-ghz="$ghz" --replace )
done
echo "done. Restart or redeploy the Railway relay so its replay workers load the new sessions."
