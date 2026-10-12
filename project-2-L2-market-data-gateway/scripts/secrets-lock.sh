#!/usr/bin/env bash
# scripts/secrets-lock.sh — encrypt a plaintext secrets file so it is only
# stored encrypted on disk.
#
# Usage (Git Bash):   bash scripts/secrets-lock.sh deploy/neon.env
# Usage (PowerShell): & "C:\Program Files\Git\bin\bash.exe" scripts/secrets-lock.sh deploy/neon.env
#
# Writes <file>.enc, checks that it decrypts back to exactly the original
# bytes, then (after asking) deletes the plaintext.
#
# Encryption: AES-256-CBC, key derived from your passphrase with PBKDF2-SHA256
# (600,000 iterations) and a random salt -- OpenSSL's `enc` command, which
# ships with Git for Windows. Decrypt with scripts/neon-upload.sh, or by hand:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in deploy/neon.env.enc
#
# What this protects against: the file being read off a copied disk, a
# backup, a sync folder, a screen-share, or committed/uploaded by mistake --
# without the passphrase it's noise. What it can't protect against: a program
# running as your Windows user while you've typed the passphrase in. Nothing
# stored on one user account can hide from programs running as that user.
#
# The passphrase is never stored. Lose it and the file can't be decrypted;
# the secret itself can be re-issued from the provider (Neon: reset the role
# password), so that's an inconvenience, not a loss.
set -euo pipefail

CIPHER=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)

src="${1:?usage: bash scripts/secrets-lock.sh <secrets-file>}"
out="$src.enc"
[ -f "$src" ] || { echo "no such file: $src" >&2; exit 1; }
[ -e "$out" ] && { echo "$out already exists; delete it first if you mean to re-encrypt" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found (it ships with Git for Windows; run this from Git Bash)" >&2; exit 1; }

read -rs -p "New passphrase (12+ characters, not one you use elsewhere): " p1; echo
read -rs -p "Repeat it: " p2; echo
[ "$p1" = "$p2" ] || { echo "the two entries differ; nothing changed" >&2; exit 1; }
[ ${#p1} -ge 12 ] || { echo "use at least 12 characters; nothing changed" >&2; exit 1; }

# Passphrase via stdin (-pass stdin), never on a command line where other
# processes could list it.
printf '%s\n' "$p1" | openssl enc "${CIPHER[@]}" -salt -pass stdin -in "$src" -out "$out"

# Prove the round trip before touching the original.
if ! printf '%s\n' "$p1" | openssl enc -d "${CIPHER[@]}" -pass stdin -in "$out" | cmp -s - "$src"; then
  rm -f "$out"
  echo "verification failed; removed $out, original untouched" >&2
  exit 1
fi
unset p1 p2
echo "encrypted -> $out (verified)"

read -r -p "Delete the plaintext $src now? [y/N] " answer
if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
  # Overwrite before deleting. Best effort only: on an SSD the old blocks
  # may survive until the drive reuses them, so if this secret was ever
  # exposed, rotating it is the real fix.
  if command -v shred >/dev/null; then shred -u "$src"; else rm -f "$src"; fi
  echo "deleted $src"
else
  echo "kept $src -- delete it yourself once you've checked the .enc works"
fi
