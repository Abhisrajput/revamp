#!/usr/bin/env bash
# End-to-end pipeline execution script.
# Runs all 8 stages sequentially, auto-approves, reports progress.
# Usage: ./scripts/run-pipeline-e2e.sh [pipeline_run_id]

set -euo pipefail

API="http://localhost:8787"
PROJECT_ID="b2b811d5-ba8b-40b8-b7d9-227596d9ce94"
RUN_ID="${1:-dee3c2ca-8270-4453-9be4-8d4862814468}"
STAGES=("SCAN" "DECODE" "BLUEPRINT" "SPEC_LOCK" "ARCHITECT" "FORGE" "SHADOW_RUN" "EVOLVE")

# ── Auth ──────────────────────────────────────────────────
echo "=== Authenticating ==="
TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@revamp.ai","password":"Demo1234!"}' | jq -r '.token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "FATAL: Auth failed"
  exit 1
fi
echo "Auth OK (token: ${TOKEN:0:20}...)"
AUTH="Authorization: Bearer $TOKEN"

# ── Helper: get stage status from DB ──────────────────────
get_stage_status() {
  local stage=$1
  PGPASSWORD=revamp_local_dev psql -h 127.0.0.1 -U revamp -d revamp -tAc \
    "SELECT stage_progress->'$stage'->>'status' FROM pipeline_runs WHERE id = '$RUN_ID';" 2>/dev/null | tr -d ' '
}

# ── Helper: approve a stage ───────────────────────────────
approve_stage() {
  local stage=$1
  echo "  → Approving $stage..."
  local resp
  resp=$(curl -sf -X POST "$API/pipeline/$RUN_ID/approve/$stage" \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"comment":"Auto-approved by e2e script"}' 2>&1) || true
  echo "  → Approve response: $resp"
}

# ── Helper: execute a stage via SSE ───────────────────────
# POSTs to the stage endpoint, reads the SSE stream until complete/error.
execute_stage() {
  local stage=$1
  local start_time=$(date +%s)
  echo "  → Executing $stage..."

  # Start execution — SSE stream
  local tmpfile=$(mktemp)
  curl -sN -X POST "$API/pipeline/$RUN_ID/stage/$stage" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{}' \
    --max-time 3600 \
    > "$tmpfile" 2>&1 &
  local curl_pid=$!

  # Poll status every 15s until complete/failed/awaiting_approval
  local status=""
  local poll_count=0
  while true; do
    sleep 15
    poll_count=$((poll_count + 1))

    # Check stage status from API
    local api_resp
    api_resp=$(curl -sf "$API/pipeline/$RUN_ID/status" -H "$AUTH" 2>/dev/null || echo '{}')
    status=$(echo "$api_resp" | jq -r ".stage_progress.${stage}.status // \"unknown\"" 2>/dev/null || echo "unknown")

    # Check subtask progress
    local subs
    subs=$(echo "$api_resp" | jq -r '
      .current_stage_progress // {} |
      "\(.completed // 0)/\(.total // 0) done, \(.running // 0) running"
    ' 2>/dev/null || echo "?")

    local elapsed=$(( $(date +%s) - start_time ))
    echo "  [$stage] ${elapsed}s — status=$status subtasks=$subs"

    case "$status" in
      completed|awaiting_approval|approved)
        echo "  ✓ $stage completed in ${elapsed}s"
        kill $curl_pid 2>/dev/null || true
        rm -f "$tmpfile"
        return 0
        ;;
      failed)
        echo "  ✗ $stage FAILED after ${elapsed}s"
        # Show last few lines of SSE for debugging
        echo "  --- Last SSE output ---"
        tail -20 "$tmpfile" 2>/dev/null | grep -E "event:|data:" | tail -10
        kill $curl_pid 2>/dev/null || true
        rm -f "$tmpfile"
        return 1
        ;;
    esac

    # Safety: abort after 30 minutes
    if [ $elapsed -gt 1800 ]; then
      echo "  ✗ $stage TIMEOUT after 30 minutes"
      kill $curl_pid 2>/dev/null || true
      rm -f "$tmpfile"
      return 1
    fi

    # Check if curl died
    if ! kill -0 $curl_pid 2>/dev/null; then
      echo "  ⚠ SSE connection dropped. Checking if stage still completed..."
      sleep 5
      status=$(get_stage_status "$stage")
      if [ "$status" = "completed" ] || [ "$status" = "awaiting_approval" ] || [ "$status" = "approved" ]; then
        echo "  ✓ $stage completed (SSE dropped but stage finished)"
        rm -f "$tmpfile"
        return 0
      fi
      echo "  ✗ $stage SSE dropped and stage status=$status"
      rm -f "$tmpfile"
      return 1
    fi
  done
}

# ── Main: run pipeline ────────────────────────────────────
echo ""
echo "=== Pipeline E2E: run=$RUN_ID ==="
echo ""

for stage in "${STAGES[@]}"; do
  status=$(get_stage_status "$stage")
  echo "[$stage] Current status: $status"

  case "$status" in
    approved)
      echo "  ⏭ Already approved — skipping"
      ;;
    awaiting_approval)
      # Check if stage has output
      has_output=$(PGPASSWORD=revamp_local_dev psql -h 127.0.0.1 -U revamp -d revamp -tAc \
        "SELECT COUNT(*) FROM stage_artifacts WHERE pipeline_run_id = '$RUN_ID' AND stage_name = '$stage' AND artifact_type = 'stage_output';" 2>/dev/null | tr -d ' ')
      if [ "$has_output" -gt 0 ]; then
        approve_stage "$stage"
      else
        echo "  ⚠ awaiting_approval but no output — re-executing..."
        execute_stage "$stage" || { echo "FATAL: $stage failed"; exit 1; }
        approve_stage "$stage"
      fi
      ;;
    completed)
      approve_stage "$stage"
      ;;
    pending|failed|""|unknown)
      execute_stage "$stage" || { echo "FATAL: $stage failed"; exit 1; }
      # Check if approval is needed
      new_status=$(get_stage_status "$stage")
      if [ "$new_status" = "awaiting_approval" ] || [ "$new_status" = "completed" ]; then
        approve_stage "$stage"
      fi
      ;;
    in_progress)
      echo "  ⏳ Already running — waiting for completion..."
      execute_stage "$stage" || { echo "FATAL: $stage failed"; exit 1; }
      new_status=$(get_stage_status "$stage")
      if [ "$new_status" = "awaiting_approval" ] || [ "$new_status" = "completed" ]; then
        approve_stage "$stage"
      fi
      ;;
  esac

  echo ""
done

echo "=== Pipeline E2E COMPLETE ==="
echo ""
# Final status
echo "Final stage statuses:"
for stage in "${STAGES[@]}"; do
  status=$(get_stage_status "$stage")
  echo "  $stage: $status"
done
