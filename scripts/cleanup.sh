#!/usr/bin/env bash
# Revamp Platform — Cleanup Script
# Kills orphaned dev server processes, clears build caches, and frees resources.
#
# Usage:
#   ./scripts/cleanup.sh          # Full cleanup (processes + caches)
#   ./scripts/cleanup.sh procs    # Kill orphaned processes only
#   ./scripts/cleanup.sh cache    # Clear build caches only
#   ./scripts/cleanup.sh restart  # Kill ALL dev servers and restart fresh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-full}"

# ─── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[cleanup]${NC} $*"; }
warn() { echo -e "${YELLOW}[cleanup]${NC} $*"; }
err()  { echo -e "${RED}[cleanup]${NC} $*"; }

# ─── Kill orphaned dev server processes ──────────────────
kill_orphans() {
  log "Scanning for orphaned Node.js processes..."

  # Find all revamp-related node processes
  local pids
  pids=$(ps aux | grep -E "node.*revamp-platform" | grep -v grep | awk '{print $2}' | sort -n)

  if [ -z "$pids" ]; then
    log "No revamp Node.js processes found."
    return
  fi

  local count
  count=$(echo "$pids" | wc -l | tr -d ' ')
  log "Found $count revamp Node.js processes."

  # In normal operation: 3 API processes + 4 Web processes = 7
  # Anything beyond that is orphaned
  if [ "$count" -le 7 ]; then
    log "Process count looks normal (<=7). No orphans detected."
    return
  fi

  # Keep the most recent 7 processes (highest PIDs), kill the rest
  local keep_count=7
  local to_kill
  to_kill=$(echo "$pids" | head -n -${keep_count})
  local kill_count
  kill_count=$(echo "$to_kill" | wc -l | tr -d ' ')

  warn "Killing $kill_count orphaned processes..."
  echo "$to_kill" | while read -r pid; do
    kill "$pid" 2>/dev/null && log "  Killed PID $pid" || true
  done

  sleep 1

  # Force kill any that didn't exit gracefully
  echo "$to_kill" | while read -r pid; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null && warn "  Force-killed PID $pid" || true
  done

  log "Orphan cleanup complete."
}

# ─── Kill ALL dev servers ────────────────────────────────
kill_all_servers() {
  warn "Killing ALL revamp dev server processes..."

  local pids
  pids=$(ps aux | grep -E "node.*revamp-platform" | grep -v grep | awk '{print $2}')

  if [ -z "$pids" ]; then
    log "No running servers found."
    return
  fi

  echo "$pids" | xargs kill 2>/dev/null || true
  sleep 2
  # Force kill stragglers
  pids=$(ps aux | grep -E "node.*revamp-platform" | grep -v grep | awk '{print $2}')
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi

  log "All servers stopped."
}

# ─── Clear build caches ─────────────────────────────────
clear_caches() {
  log "Clearing build caches..."

  # Next.js cache
  if [ -d "$ROOT/apps/web/.next" ]; then
    local size
    size=$(du -sh "$ROOT/apps/web/.next" 2>/dev/null | awk '{print $1}')
    rm -rf "$ROOT/apps/web/.next"
    log "  Removed .next cache ($size)"
  fi

  # Turbo cache
  if [ -d "$ROOT/.turbo" ]; then
    local size
    size=$(du -sh "$ROOT/.turbo" 2>/dev/null | awk '{print $1}')
    rm -rf "$ROOT/.turbo"
    log "  Removed .turbo cache ($size)"
  fi

  # TypeScript build info
  find "$ROOT" -name "tsconfig.tsbuildinfo" -not -path "*/node_modules/*" -delete 2>/dev/null
  log "  Removed tsconfig.tsbuildinfo files"

  # Temp logs
  rm -f /tmp/revamp-*.log 2>/dev/null
  log "  Removed temp log files"

  log "Cache cleanup complete."
}

# ─── Restart servers ─────────────────────────────────────
restart_servers() {
  kill_all_servers

  log "Starting API server..."
  cd "$ROOT"
  WATCHPACK_POLLING=true nohup pnpm --filter @revamp/api dev > /tmp/revamp-api.log 2>&1 &
  local api_pid=$!
  log "  API started (PID: $api_pid)"

  sleep 3

  log "Starting Web server..."
  WATCHPACK_POLLING=true NEXT_PUBLIC_API_URL=http://localhost:3002 nohup pnpm --filter @revamp/web dev > /tmp/revamp-web.log 2>&1 &
  local web_pid=$!
  log "  Web started (PID: $web_pid)"

  sleep 10

  # Health checks
  if curl -s -o /dev/null -w '' --max-time 5 http://localhost:3002/health; then
    log "  API: healthy"
  else
    err "  API: not responding"
  fi

  if curl -s -o /dev/null -w '' --max-time 10 http://localhost:3001/login; then
    log "  Web: healthy"
  else
    err "  Web: not responding (may still be compiling)"
  fi
}

# ─── Main ────────────────────────────────────────────────
case "$MODE" in
  procs|processes)
    kill_orphans
    ;;
  cache|caches)
    clear_caches
    ;;
  restart)
    clear_caches
    restart_servers
    ;;
  full|all)
    kill_orphans
    clear_caches
    ;;
  *)
    echo "Usage: $0 [full|procs|cache|restart]"
    exit 1
    ;;
esac

log "Done."
