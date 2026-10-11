#!/usr/bin/env bash
# scripts/gateway-hosted.sh — run this desktop's C++ gateways (BTC, xyz:CL)
# against the HOSTED relay, so the live website switches from Replay to Live.
# Stop them and the relay falls back to its Neon replay within ~5s.
#
# Usage: bash scripts/gateway-hosted.sh up [run_minutes]   (default 1440 = 24h)
#        bash scripts/gateway-hosted.sh down
#
# Transport: wss:// on 443 through Railway's normal HTTPS domain (TLS with
# certificate + hostname verification, see src/relay_push_client.cpp). No
# Railway TCP proxy is involved -- that would be a plain, unencrypted port.
#
# Secret: INGEST_TOKEN comes from ~/.quant-secrets/relay-ingest.env, OUTSIDE
# the repo. It's parsed (not `source`d, so the file is never run as code) and
# handed to the gateway as an environment variable, never a command-line
# argument: any process can list other processes' command lines.
#
# One gateway per instrument on this machine: `up` stops the local-relay
# gateways that dev-up.sh started. Re-run dev-up.sh after `down` to get
# them back.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
EXE="$ROOT/build/quant_day1.exe"
SECRETS="$HOME/.quant-secrets/relay-ingest.env"
RELAY_HOST="${RELAY_HOST:-quant-portfolio-production-8c93.up.railway.app}"

stop_gateways() {
  taskkill //IM quant_day1.exe //F >/dev/null 2>&1 && echo "[hosted] stopped running gateways" || true
}

case "${1:-}" in
  down)
    stop_gateways
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: bash scripts/gateway-hosted.sh up [run_minutes] | down" >&2
    exit 1
    ;;
esac

RUN_MINUTES="${2:-1440}"

if [ ! -f "$SECRETS" ]; then
  echo "[hosted] FATAL: $SECRETS not found" >&2
  exit 1
fi
# tr -d '\r': a file saved by a Windows editor ends lines in CRLF, and a
# stray \r on the token makes it silently not match the relay's.
TOKEN="$(grep -E '^INGEST_TOKEN=' "$SECRETS" | head -1 | cut -d= -f2- | tr -d '\r')"
if [ -z "$TOKEN" ]; then
  echo "[hosted] FATAL: INGEST_TOKEN is empty in $SECRETS" >&2
  exit 1
fi

stop_gateways
sleep 1

export PATH="/c/msys64/mingw64/bin:$PATH" # runtime DLLs, as in dev-up.sh

# Separate cwds per instrument (each writes data/ticks.bin, see dev-up.sh).
# data/export is created up front: the exporter's own mkdir can lose a race
# on first run and abort the process.
for sym in BTC "xyz:CL"; do
  dir="$RUN_DIR/hosted-${sym//:/_}"
  mkdir -p "$dir/data/export"
  echo "[hosted] starting gateway $sym -> wss://$RELAY_HOST/ingest (log: $dir/gateway.log)"
  ( cd "$dir" && INGEST_TOKEN="$TOKEN" RELAY_WS_TLS=1 RELAY_WS_HOST="$RELAY_HOST" \
      "$EXE" "$RUN_MINUTES" "$sym" > gateway.log 2>&1 & )
done

sleep 10
# "connected" in the gateway log only proves TLS worked; a wrong token also
# connects and is then dropped. The relay saying isReplay=false is the
# proof the token was accepted and the live feed holds the channel.
echo "[hosted] relay says: $(curl -s --max-time 10 "https://$RELAY_HOST/symbols")"
for sym in BTC "xyz:CL"; do
  log="$RUN_DIR/hosted-${sym//:/_}/gateway.log"
  if ! tr '\r' '\n' < "$log" | grep -q "relay-push\] connected to wss://"; then
    echo "[hosted] $sym: never connected, last relay lines:" >&2
    tr '\r' '\n' < "$log" | grep -E "relay|what" | tail -3 | sed 's/^/[hosted]   /' >&2
  fi
done
