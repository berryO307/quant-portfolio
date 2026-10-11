#!/usr/bin/env bash
# scripts/dev-down.sh — stop exactly what dev-up.sh started (tracked via
# .run/*.pid, containing real Windows PIDs — see dev-up.sh's note on why
# bash's $! can't be trusted for this), in reverse order. Anything already
# running before dev-up.sh ran (no .pid file) is left alone.
#
# This is a hard stop (taskkill /T /F, killing the process tree) rather
# than a graceful one: signal delivery from an MSYS shell to a background
# native Windows console process isn't reliable enough to depend on here,
# so there's no guarantee quant_day1.exe's own SIGTERM handler runs before
# it dies — data/ticks.bin and the in-flight cold-path export segment for
# that run may end up incomplete.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"

stop_pid() {
  local name="$1" pidfile="$2"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  rm -f "$pidfile"
  [ -n "$pid" ] || return 0
  if tasklist //FI "PID eq $pid" 2>/dev/null | grep -q "$pid"; then
    echo "[dev-down] stopping $name (pid $pid)"
    taskkill //PID "$pid" //T //F >/dev/null 2>&1
  else
    echo "[dev-down] $name (pid $pid) already gone"
  fi
}

stop_pid "gateway xyz:CL"     "$RUN_DIR/gateway-cl.pid"
stop_pid "gateway BTC"        "$RUN_DIR/gateway-btc.pid"
stop_pid "web :3000"          "$RUN_DIR/web.pid"
stop_pid "relay :8080"        "$RUN_DIR/relay-8080.pid"

echo "[dev-down] done — anything not started by dev-up.sh (no .pid file) was left alone"
