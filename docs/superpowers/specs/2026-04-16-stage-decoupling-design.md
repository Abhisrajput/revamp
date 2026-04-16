# Stage Decoupling — Independent Stage Executions with Progressive Dependency Chain

## Problem

All 8 pipeline stages are coupled through a single `stage_progress` JSONB blob on `pipeline_runs`. This causes:

1. **Timer corruption** — any write to the JSONB can overwrite another stage's timestamps, causing the elapsed timer to run forever.
2. **Output disappearing** — the Zustand sync effect, sessionStorage persistence, and React Query polling all fight over the same data, creating race conditions that lose stage outputs.
3. **No re-run isolation** — re-running stage 3 touches the same JSONB that stages 1-2 and 4-8 depend on.
4. **No version history** — re-running a stage replaces the previous output with no ability to compare.
5. **Four-hop data path** — DB → React Query → sync effect → Zustand → sessionStorage → component. Each hop is a failure point.

## Solution

Decouple stages into independent executions with their own lifecycle. Each stage execution is a row in a new `stage_executions` table with its own status, timestamps, output, validation, and approval. Stages form a progressive dependency chain — each reads the latest approved output from prior stages, anchored by Stage 1 (SCAN) ground truth. The pipeline run becomes a lightweight grouping container.

## Design

### 1. `stage_executions` Table

```sql
CREATE TABLE stage_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_name      VARCHAR(50) NOT NULL,
  version         INT NOT NULL,

  -- Lifecycle
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,

  -- Output
  output          TEXT,
  output_length   INT DEFAULT 0,

  -- Validation (inline — no separate table)
  validation      JSONB,

  -- Approval (inline — replaces approval_gates table)
  approval_status VARCHAR(20) NOT NULL DEFAULT 'not_required',
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  approval_comment TEXT,

  -- Provenance
  input_refs      JSONB NOT NULL DEFAULT '{}',

  -- Execution metadata
  model           VARCHAR(100),
  token_usage     JSONB,

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(pipeline_run_id, stage_name, version)
);

CREATE INDEX idx_stage_exec_run ON stage_executions(pipeline_run_id);
CREATE INDEX idx_stage_exec_lookup ON stage_executions(pipeline_run_id, stage_name, version DESC);
CREATE INDEX idx_stage_exec_approved ON stage_executions(pipeline_run_id, stage_name, approval_status)
  WHERE approval_status = 'approved';
```

**Status values:** `pending`, `running`, `completed`, `failed`, `approved`, `rejected`

**Approval status values:** `not_required`, `pending`, `approved`, `rejected`

**Version:** auto-incremented per `(pipeline_run_id, stage_name)`. Version 1 is the first run, version 2 is the first re-run, etc. Computed at execution time: `SELECT COALESCE(MAX(version), 0) + 1 FROM stage_executions WHERE pipeline_run_id = :runId AND stage_name = :stage`.

**Output is stored inline.** No separate `stage_artifacts` lookup needed for the primary markdown output. Binary/structured data (BREE cloned_codebase, file trees) stays in `stage_artifacts`.

**Validation is inline JSONB.** Structure: `{ passed, confidenceScore, criteria: [{ name, passed, score, feedback }], summary }`.

**`input_refs`** records which prior executions were consumed:
```json
{
  "SCAN": "exec-uuid-abc",
  "DECODE": "exec-uuid-def"
}
```
This creates an immutable provenance chain — you can always trace what inputs produced any output.

**Retention:** a background job runs hourly and deletes executions where `version < (max_version - 2)` per `(pipeline_run_id, stage_name)`, keeping the latest 3 versions. It never deletes an execution referenced by another execution's `input_refs`.

### 2. Dependency Chain — How Stages Read Prior Outputs

**Rule:** when stage N executes, it reads the latest approved execution of each prior stage within the same pipeline run.

**Resolution query:**
```sql
SELECT DISTINCT ON (stage_name) *
FROM stage_executions
WHERE pipeline_run_id = :runId
  AND stage_name = ANY(:priorStageNames)
  AND approval_status = 'approved'
ORDER BY stage_name, version DESC
```

The resolved execution IDs are stored in the new execution's `input_refs` at execution time. Even if upstream stages are re-run later, this execution's `input_refs` are immutable — it always records what it actually consumed.

**Stage 1 (SCAN) is special:**
- Has no `input_refs` (it's the root of the chain)
- Its output + BREE engine analysis form the ground truth
- Ground truth is injected into every downstream stage's prompt via the existing `context-builders.ts` system (unchanged)
- BREE output stays in `stage_artifacts` as `cloned_codebase` artifact (binary/structured data)

**Execution guard:** a stage cannot execute unless all prior stages have at least one approved execution. The frontend disables the Execute button and shows: "Waiting for [STAGE_NAME] approval."

### 3. Re-run and Staleness

**Re-running a stage:**

1. User clicks Re-run on stage N
2. Backend creates a new `stage_executions` row: `version = max(version) + 1`, `status = 'running'`
3. `input_refs` resolved at execution time — grabs latest approved outputs from prior stages
4. Stage executes, produces output
5. User reviews and approves (or rejects and re-runs again)
6. Previous versions stay in the table for comparison until retention cleanup

**Staleness detection:**

When stage N gets a new approved execution, downstream stages may be stale. Detection:

```
For each downstream stage's latest approved execution:
  Check if its input_refs[stage_N] matches the current latest approved stage_N execution ID
  If not → that downstream stage is stale
```

The API computes staleness on the `/status` endpoint and returns a `stale` boolean + `stale_reason` per stage.

**What staleness does NOT do:**
- Does not change the downstream stage's status (stays `approved`)
- Does not prevent the user from approving other stages
- Does not auto-trigger re-runs
- Does not invalidate the downstream stage's output
- The user decides what to do — sometimes stale is fine

**Frontend display:** a warning badge on stale stages:
> "SPEC_LOCK was built from BLUEPRINT v1. BLUEPRINT v2 is now approved. Re-run to refresh."

### 4. Pipeline Run (Slim)

The `pipeline_runs` table becomes a lightweight grouping container.

**Columns kept:** `id`, `project_id`, `status`, `created_by`, `created_at`, `updated_at`

**Columns removed:**
- `stage_progress` JSONB — gone entirely (replaced by `stage_executions` table)
- `current_stage` — derived from which stages have executions
- `error_message` — lives on individual stage executions
- `completed_at` — derived from last stage's `approved_at`

**`status` is derived at query time** (or cached and updated on stage transitions). Computed from stage executions:
- `completed` = all 8 stages have at least one approved execution
- `running` = any stage has a `running` execution
- `in_progress` = at least one stage approved, not all done
- `pending` = no stages executed yet

**New `/status` endpoint response:**
```json
{
  "id": "run-uuid",
  "project_id": "proj-uuid",
  "stages": {
    "SCAN": {
      "latest": {
        "id": "exec-1",
        "version": 2,
        "status": "approved",
        "started_at": "2026-04-15T00:30:23Z",
        "completed_at": "2026-04-15T00:45:12Z",
        "approval_status": "approved",
        "output_length": 21914,
        "validation": { "passed": true, "confidenceScore": 87 }
      },
      "versions": [2, 1],
      "stale": false
    },
    "DECODE": {
      "latest": { "id": "exec-2", "version": 1, "status": "approved", "..." : "..." },
      "versions": [1],
      "stale": false
    },
    "BLUEPRINT": {
      "latest": null,
      "versions": [],
      "stale": false
    }
  }
}
```

### 5. Frontend State Management

**New pattern:** React Query → component. Two hops instead of four.

**React Query hooks (server state):**
- `usePipelineStatus(runId)` — returns the structured stages response from Section 4. The only query needed for stage state.
- `useStageOutput(executionId)` — fetches full output content for a specific execution. Called on demand when user views a stage.
- `useStageHistory(runId, stageName)` — fetches version list for comparison UI. Called on demand.

**Zustand keeps (UI-only state):**
- `activeStageIndex` — which tab is selected
- `streamingText` — live SSE text during execution
- `isGenerating` — whether any stage is currently executing locally

**Zustand loses:**
- `stages[]` array with status, output, startedAt, completedAt, validation, approval
- `setStageStatus`, `setStageOutput`, `setStageValidation` — SSE handler invalidates React Query cache instead
- sessionStorage persistence of stage state — React Query is the cache, DB is source of truth

**Timer becomes trivial:**
```tsx
const stageData = pipelineStatus.stages[activeStage.name]?.latest;

<ElapsedTimer
  startedAt={stageData?.started_at}
  completedAt={stageData?.completed_at}
  status={stageData?.status}
/>
```

Three props, straight from the API. No Zustand. No sessionStorage. No sync effect.

**Output becomes trivial:**
```tsx
const { data: output } = useStageOutput(stageData?.id);
// output is the markdown content, fetched on demand, cached by React Query
```

**SSE during execution:**
- SSE still streams text into Zustand (`streamingText`) for live display
- On `complete` event: `queryClient.invalidateQueries(['pipeline-status', runId])` — React Query refetches, component re-renders with DB truth
- No manual `setStageStatus` needed

### 6. Migration Path

**Phase 1: Build new table, dual-write (no frontend changes)**
- Create `stage_executions` table via Drizzle migration
- Modify `executeStage` to write to BOTH `stage_executions` AND old `stage_progress` JSONB
- Modify approval/rejection handlers to write to both
- Frontend still reads from old JSONB — nothing breaks
- Validate new table has correct data

**Phase 2: New status endpoint + frontend migration**
- Build new `/status` endpoint that reads from `stage_executions`
- Create new React Query hooks
- Migrate pipeline page to read from new hooks
- Remove Zustand `stages[]` array and sync effect
- Timer and output come from React Query directly
- Old endpoint stays for other consumers

**Phase 3: Cleanup**
- Drop `stage_progress` JSONB column from `pipeline_runs`
- Drop `approval_gates` table
- Remove old sync effect, sessionStorage stage persistence
- Remove `current_stage`, `completed_at`, `error_message` from `pipeline_runs`
- Retention job for keeping latest 3 versions
- Backfill: migrate existing `stage_artifacts` output content into `stage_executions.output` for historical runs

Each phase is independently deployable. Phase 1 is zero-risk (additive). Phase 2 is the big swing but can be feature-flagged. Phase 3 is cleanup after Phase 2 is stable.

## Files Affected

### Phase 1 (Backend dual-write)
| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add `stageExecutions` table definition |
| `apps/api/src/db/migrations/` | New migration for `stage_executions` |
| `apps/api/src/services/pipeline.ts` | Dual-write to `stage_executions` on completion |
| `apps/api/src/services/pipeline-repository.ts` | New functions: `createStageExecution`, `resolveInputRefs`, `getLatestApproved` |
| `apps/api/src/services/pipeline-operations.ts` | Dual-write approval/rejection |
| `apps/api/src/routes/pipeline.ts` | Dual-write in execute route handler |

### Phase 2 (Frontend migration)
| File | Change |
|------|--------|
| `apps/api/src/routes/pipeline.ts` | New `/status/v2` endpoint reading from `stage_executions` |
| `packages/core/src/hooks/use-pipeline-queries.ts` | New hooks: `usePipelineStatusV2`, `useStageOutput`, `useStageHistory` |
| `apps/web/app/(dashboard)/projects/[id]/pipeline/page.tsx` | Rewrite: remove sync effect, read from new hooks |
| `packages/core/src/stores/pipeline-store.ts` | Slim down: remove `stages[]`, keep only UI state |
| `apps/web/components/pipeline/mission-control/center-panel.tsx` | Read stage data from props (React Query), not Zustand |
| `apps/web/components/pipeline/elapsed-timer.tsx` | Simplified: props from React Query, no Zustand |

### Phase 3 (Cleanup)
| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Remove `stage_progress`, `current_stage`, `completed_at` from `pipeline_runs`; drop `approval_gates` |
| `apps/api/src/db/migrations/` | Migration to drop columns/table |
| `apps/api/src/services/cleanup-scheduler.ts` | Remove `stage_progress` resets, add retention job |
| `apps/api/src/server.ts` | Remove startup `stage_progress` recovery |
| `packages/core/src/stores/pipeline-store.ts` | Remove sessionStorage persistence for stages |
