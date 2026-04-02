#!/usr/bin/env bash
# ─── Run Pipeline Stages sequentially from a given stage onwards ───
# Usage: ./scripts/run-stages.sh [start_stage]
# Example: ./scripts/run-stages.sh DECODE

set -euo pipefail

API_URL="http://localhost:8787"
PIPELINE_ID="dee3c2ca-8270-4453-9be4-8d4862814468"
MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0"
DB_URL="postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp"

STAGES=("SCAN" "DECODE" "BLUEPRINT" "SPEC_LOCK" "ARCHITECT" "FORGE" "SHADOW_RUN" "EVOLVE")
START_STAGE="${1:-DECODE}"

# ─── Get auth token ───
echo "🔑 Logging in..."
TOKEN=$(curl -sf "$API_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@revamp.ai","password":"demo1234"}' | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "❌ Login failed"; exit 1
fi
echo "✅ Authenticated"

# ─── Find start index ───
START_IDX=0
for i in "${!STAGES[@]}"; do
  if [ "${STAGES[$i]}" = "$START_STAGE" ]; then START_IDX=$i; break; fi
done

LAST_IDX=$(( ${#STAGES[@]} - 1 ))
echo ""
echo "🚀 Running stages ${START_STAGE} → ${STAGES[$LAST_IDX]} with model: $MODEL"
echo "   Pipeline: $PIPELINE_ID"
echo ""

# ─── Execute each stage ───
for i in $(seq $START_IDX $LAST_IDX); do
  STAGE="${STAGES[$i]}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ Stage $((i+1))/8: $STAGE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Ensure pipeline is in running state
  psql "$DB_URL" -qc "UPDATE pipeline_runs SET status = 'running', current_stage = '$STAGE' WHERE id = '$PIPELINE_ID';" 2>/dev/null

  # Fire the SSE request in background, kill after stage completes
  curl -s -N "$API_URL/pipeline/$PIPELINE_ID/stage/$STAGE" \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"evaluator_model\":\"$MODEL\"}" \
    --max-time 900 > /dev/null 2>&1 &
  CURL_PID=$!

  # Poll DB for stage_output artifact
  echo "   ⏳ Waiting for $STAGE to complete..."
  ELAPSED=0
  while true; do
    DONE=$(psql "$DB_URL" -qtAc \
      "SELECT COUNT(*) FROM stage_artifacts WHERE pipeline_run_id = '$PIPELINE_ID' AND stage_name = '$STAGE' AND artifact_type = 'stage_output' AND created_at > now() - interval '30 minutes';" 2>/dev/null)

    if [ "${DONE:-0}" -ge 1 ]; then
      # Kill the curl if still running
      kill $CURL_PID 2>/dev/null || true
      wait $CURL_PID 2>/dev/null || true

      # Get validation score
      SCORE=$(psql "$DB_URL" -qtAc \
        "SELECT (metadata->>'completenessScore')::text FROM stage_artifacts WHERE pipeline_run_id = '$PIPELINE_ID' AND stage_name = '$STAGE' AND artifact_type = 'validation_result' ORDER BY created_at DESC LIMIT 1;" 2>/dev/null)

      echo "   ✅ $STAGE completed! (score: ${SCORE:-N/A}, time: ${ELAPSED}s)"

      # Auto-approve any pending gates for this stage
      psql "$DB_URL" -qc \
        "UPDATE approval_gates SET status = 'approved', approved_by = '00000000-0000-0000-0000-000000000010' WHERE pipeline_run_id = '$PIPELINE_ID' AND stage_name = '$STAGE' AND status = 'pending';" 2>/dev/null
      break
    fi

    # Timeout after 15 minutes
    if [ $ELAPSED -ge 900 ]; then
      echo "   ❌ $STAGE timed out after 15 minutes"
      kill $CURL_PID 2>/dev/null || true
      wait $CURL_PID 2>/dev/null || true
      exit 1
    fi

    sleep 10
    ELAPSED=$((ELAPSED + 10))
    # Progress dots every 30 seconds
    if [ $((ELAPSED % 30)) -eq 0 ]; then
      echo "   ... ${ELAPSED}s elapsed"
    fi
  done
  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 All stages complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
