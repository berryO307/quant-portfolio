#!/usr/bin/env bash
# scripts/dev-up.sh — bring up the whole local stack: both relays (:8080
# BTC, :8085 xyz:CL), the web viewer (:3000), and both gateway processes.
# Idempotent: anything already listening/running is left alone, not
# restarted. Real Win32 PIDs of whatever THIS script starts are recorded in
# .run/ so dev-down.sh can stop exactly those and nothing else.
#
# Usage: bash scripts/dev-up.sh [run_minutes]   (default 1440 = 24h)
#
# NOTE on PID tracking: bash's $! after `native.exe &` under MSYS gives
# MSYS's own internal PID, not the real Windows PID of the spawned process
# (MSYS can't exec() into a native PE binary in place the way it does for
# other MSYS processes — it always launches a genuinely new Win32 process
# and the shell's $! refers to its own wrapper). Confirmed by hand: $! said
# 19305, tasklist showed the real gateway running as 12556. So PIDs here
# are captured by diffing `tasklist` for the target image name immediately
# before/after each launch, not by trusting $!.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

RUN_MINUTES="${1:-1440}"
FAILED=0

port_listening() {
  netstat -ano 2>/dev/null | grep ":$1 " | grep -q LISTENING
}

gateway_running() {
  tasklist //FI "IMAGENAME eq quant_day1.exe" 2>/dev/null | grep -qi quant_day1
}

image_pids() {
  tasklist //FI "IMAGENAME eq $1" //NH //FO CSV 2>/dev/null \
    | sed -E 's/^"[^"]*","([0-9]+)".*/\1/' | grep -E '^[0-9]+$' | sort
}

# start_bg <name> <workdir> <image-name-to-track> <logfile> <pidfile> <port-or-empty> <cmd...>
#
# port (when non-empty): polled for up to 10s after launch. A missing PID
# (image_pids diffing failed — see this file's header note) only means
# dev-down.sh can't stop this process on its own; a missing PORT means the
# thing never actually started, which is a real failure, not a cosmetic
# one — surfaced by printing the log's own tail (the actual error, e.g.
# "npm: command not found") rather than a generic warning, and by setting
# FAILED so the final summary doesn't claim success it didn't earn.
start_bg() {
  local name="$1" dir="$2" image="$3" log="$4" pidfile="$5" port="$6"; shift 6
  echo "[dev-up] starting $name (log: $log)"
  local before after new
  before="$(image_pids "$image")"
  ( cd "$dir" && "$@" > "$log" 2>&1 & )
  sleep 1
  after="$(image_pids "$image")"
  new="$(comm -13 <(echo "$before") <(echo "$after") | head -1)"
  if [ -n "$new" ]; then
    echo "$new" > "$pidfile"
  else
    echo "[dev-up]   WARNING: couldn't identify $name's real PID — dev-down.sh won't be able to stop it on its own (kill it by hand)" >&2
  fi

  if [ -n "$port" ]; then
    local waited=0
    while ! port_listening "$port" && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if ! port_listening "$port"; then
      echo "[dev-up]   FAILED: $name never started listening on :$port — last lines of $log:" >&2
      sed 's/^/[dev-up]     /' "$log" | tail -10 >&2
      FAILED=1
    fi
  fi
}

# Checked up front, loudly, rather than letting a missing npm/node surface
# 30 lines deep inside a backgrounded subshell's redirected log — that
# failure mode looked like a cosmetic PID-tracking warning (the real
# "npm: command not found" line was sitting unread in .run/relay-8080.log)
# while the script still printed "[dev-up] done" and pointed at a web
# viewer that was never actually listening. A common cause on Windows: a
# terminal window opened before PATH picked up node's install directory —
# closing and reopening the terminal (or restarting the parent shell) is
# usually enough; a new terminal inherits the current PATH, an already-open
# one does not.
if ! command -v npm >/dev/null 2>&1; then
  echo "[dev-up] FATAL: npm not found on PATH in this shell." >&2
  echo "[dev-up]   If npm works when you type it directly at this same prompt, this" >&2
  echo "[dev-up]   terminal's PATH is probably stale from before node was on it —" >&2
  echo "[dev-up]   close this window and open a fresh one, then re-run dev-up.sh." >&2
  exit 1
fi

if [ ! -f "$ROOT/build/quant_day1.exe" ]; then
  echo "[dev-up] build/quant_day1.exe not found — building"
  bash "$ROOT/build.sh"
fi

if port_listening 8080; then
  echo "[dev-up] relay :8080 (BTC) already up — leaving it alone"
else
  start_bg "relay :8080 (BTC)" "$ROOT/relay" node.exe "$RUN_DIR/relay-8080.log" "$RUN_DIR/relay-8080.pid" 8080 \
    npm run dev
fi

if port_listening 8085; then
  echo "[dev-up] relay :8085 (xyz:CL) already up — leaving it alone"
else
  start_bg "relay :8085 (xyz:CL)" "$ROOT/relay" node.exe "$RUN_DIR/relay-8085.log" "$RUN_DIR/relay-8085.pid" 8085 \
    env PORT=8085 npm run dev
fi

if port_listening 3000; then
  echo "[dev-up] web :3000 already up — leaving it alone"
else
  start_bg "web :3000" "$ROOT/web" node.exe "$RUN_DIR/web.log" "$RUN_DIR/web.pid" 3000 \
    npm run dev
fi

if gateway_running; then
  echo "[dev-up] quant_day1.exe already running — leaving it alone (restart manually if only one instrument's process died)"
else
  # quant_day1.exe dynamically loads libsimdjson/libssl/libcrypto/libz from
  # MSYS2's mingw64 — build.sh puts this on PATH for the build step only;
  # the same is needed at runtime here.
  export PATH="/c/msys64/mingw64/bin:$PATH"

  # Each instance writes a hardcoded "data/ticks.bin" (relative to its own
  # cwd, CreateFileA'd without FILE_SHARE_WRITE — see include/mmap_writer.hpp)
  # — two instances sharing one cwd collide on that handle and the second
  # one throws. Give each its own working directory/data folder instead.
  # (CreateFileA won't create a missing parent dir, so "data/" must exist
  # up front; data/export is auto-created by ColdPathExporter itself.)
  mkdir -p "$RUN_DIR/btc/data" "$RUN_DIR/cl/data"

  # No port argument: a gateway connects OUT to a relay, it doesn't listen
  # on one itself, so there's no port here for start_bg to poll. Its actual
  # connectivity already shows up in each relay's own log/health endpoint.
  start_bg "gateway BTC -> :8080" "$RUN_DIR/btc" quant_day1.exe "$RUN_DIR/gateway-btc.log" "$RUN_DIR/gateway-btc.pid" "" \
    env RELAY_WS_PORT=8080 "$ROOT/build/quant_day1.exe" "$RUN_MINUTES" BTC

  start_bg "gateway xyz:CL -> :8085" "$RUN_DIR/cl" quant_day1.exe "$RUN_DIR/gateway-cl.log" "$RUN_DIR/gateway-cl.pid" "" \
    env RELAY_WS_PORT=8085 "$ROOT/build/quant_day1.exe" "$RUN_MINUTES" "xyz:CL"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "[dev-up] one or more services failed to start — see the FAILED lines above. Not everything is up." >&2
  exit 1
fi

echo "[dev-up] done — web viewer: http://localhost:3000"
