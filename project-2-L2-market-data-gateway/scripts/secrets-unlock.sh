#!/usr/bin/env bash
# scripts/secrets-unlock.sh — the reverse of secrets-lock.sh: decrypts
# <file>.enc back to <file>, then (after asking) deletes the encrypted copy.
#
# Usage (Git Bash):   bash scripts/secrets-unlock.sh deploy/neon.env.enc
# Usage (PowerShell): & "C:\Program Files\Git\bin\bash.exe" scripts/secrets-unlock.sh deploy/neon.env.enc
#
# Use it to go back to a plaintext file, or to re-lock with a different
# passphrase (unlock, then run secrets-lock.sh again).
set -euo pipefail

CIPHER=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)

enc="${1:?usage: bash scripts/secrets-unlock.sh <file>.enc}"
case "$enc" in *.enc) ;; *) echo "expected a .enc file" >&2; exit 1 ;; esac
out="${enc%.enc}"
[ -f "$enc" ] || { echo "no such file: $enc" >&2; exit 1; }
[ -e "$out" ] && { echo "$out already exists; nothing changed" >&2; exit 1; }

read -rs -p "Passphrase for $(basename "$enc"): " p; echo
if ! printf '%s\n' "$p" | openssl enc -d "${CIPHER[@]}" -pass stdin -in "$enc" -out "$out" 2>/dev/null; then
  rm -f "$out"; unset p
  echo "could not decrypt: wrong passphrase or damaged file; nothing changed" >&2
  exit 1
fi
unset p
# CBC can occasionally accept a wrong passphrase and produce garbage instead
# of an error. A secrets file is plain text, so binary output means wrong.
if LC_ALL=C grep -q '[^[:print:][:space:]]' "$out"; then
  rm -f "$out"
  echo "could not decrypt: wrong passphrase; nothing changed" >&2
  exit 1
fi
echo "restored -> $out"

read -r -p "Delete the encrypted copy $enc? [y/N] " answer
if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
  rm -f "$enc"
  echo "deleted $enc"
else
  echo "kept $enc"
fi
