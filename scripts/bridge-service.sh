#!/usr/bin/env bash
# Small supervisor for the DeepAI bridge (start / stop / status / logs).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${TMPDIR:-/tmp}/deepai-bridge.pid"
LOG_FILE="${TMPDIR:-/tmp}/deepai-bridge.log"
PORT="${DEEPAI_BRIDGE_PORT:-8787}"

running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-start}" in
  start)
    if running; then
      echo "already running (pid $(cat "$PID_FILE")) on port $PORT"
      exit 0
    fi
    cd "$ROOT"
    nohup node bridge.mjs --port "$PORT" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    sleep 1
    if running; then
      echo "started (pid $(cat "$PID_FILE")), log: $LOG_FILE"
      curl -s "http://127.0.0.1:${PORT}/healthz" || true
      echo
    else
      echo "failed to start, see $LOG_FILE" >&2
      tail -20 "$LOG_FILE" >&2
      exit 1
    fi
    ;;
  stop)
    if running; then
      kill "$(cat "$PID_FILE")"
      rm -f "$PID_FILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if running; then
      echo "running (pid $(cat "$PID_FILE"))"
      curl -s "http://127.0.0.1:${PORT}/healthz"
      echo
    else
      echo "not running"
      exit 1
    fi
    ;;
  logs)
    tail -n "${2:-50}" -f "$LOG_FILE"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
