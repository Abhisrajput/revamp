# Elapsed Timer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the elapsed timer derive its state from the DB's `stage_progress` JSONB so it never gets stuck running after stage completion.

**Architecture:** Add `completedAt` to the `stage_progress` JSONB written by `updateStageProgress()`. The timer component reads `startedAt`, `completedAt`, and `status` — three conditions to stop, one source of truth (DB). The sync effect bridges DB → Zustand using the new `completedAt` field. `setStageStatus` in Zustand keeps its optimistic `completedAt` for instant SSE feedback.

**Tech Stack:** PostgreSQL JSONB, Fastify/Drizzle, React/Zustand, React Query

**Spec:** `docs/superpowers/specs/2026-04-16-elapsed-timer-redesign.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/api/src/services/pipeline-repository.ts` | Modify | Add `completedAt` to JSONB write in `updateStageProgress()` |
| `packages/views/src/pipeline/elapsed-timer.tsx` | Modify | Canonical timer: accept `status` prop, three-condition stop, frozenRef fallback |
| `apps/web/components/pipeline/elapsed-timer.tsx` | Modify | Revert to re-export of `@revamp/views` |
| `apps/web/components/pipeline/mission-control/center-panel.tsx` | Verify | Already passes `status` prop (done during debugging) |
| `apps/web/app/(dashboard)/projects/[id]/pipeline/page.tsx` | Modify | Sync effect reads `dbEntry.completedAt` as primary source |
| `packages/core/src/stores/pipeline-store.ts` | Modify | Clean up sessionStorage normalization comment |

---

### Task 1: Add `completedAt` to `updateStageProgress()` JSONB write

**Files:**
- Modify: `apps/api/src/services/pipeline-repository.ts:25-59`

- [ ] **Step 1: Modify `updateStageProgress` to write `completedAt`**

Open `apps/api/src/services/pipeline-repository.ts`. Replace the `updateStageProgress` function (lines 25-59) with:

```typescript
export async function updateStageProgress(
  pipelineRunId: string,
  stageName: PipelineStageName,
  status: string,
  progress: number,
  options?: { conn?: DbConnection; confidenceScore?: number },
): Promise<void> {
  const conn = options?.conn ?? db;
  const now = new Date().toISOString();
  const isRunning = status === 'in_progress' || status === 'generating' || status === 'validating';
  const isTerminal = status === 'completed' || status === 'failed' || status === 'approved'
    || status === 'rejected' || status === 'awaiting_approval';
  const confidenceScore = options?.confidenceScore ?? progress;

  await conn.execute(sql`
    UPDATE ${pipelineRuns}
    SET
      current_stage = ${stageName},
      stage_progress = jsonb_set(
        COALESCE(stage_progress, '{}'::jsonb),
        ${sql.raw(`'{${stageName}}'`)},
        COALESCE(stage_progress -> ${stageName}, '{}'::jsonb) || jsonb_build_object(
          'status', ${status}::text,
          'progress', ${progress}::int,
          'confidenceScore', ${confidenceScore}::int,
          'updatedAt', ${now}::text,
          'startedAt', CASE
            WHEN ${isRunning} AND (COALESCE(stage_progress -> ${stageName} ->> 'startedAt', '') = '')
            THEN ${now}::text
            ELSE COALESCE(stage_progress -> ${stageName} ->> 'startedAt', '')
          END,
          'completedAt', CASE
            WHEN ${isTerminal} THEN ${now}::text
            WHEN ${isRunning} THEN ''
            ELSE COALESCE(stage_progress -> ${stageName} ->> 'completedAt', '')
          END
        )
      ),
      updated_at = NOW()
    WHERE id = ${pipelineRunId}
  `);
}
```

Key changes:
- Added `isTerminal` boolean for terminal status detection
- Added `completedAt` CASE in the `jsonb_build_object`: set to `now` when terminal, cleared to `''` when running (fresh execution), preserved otherwise

- [ ] **Step 2: Type-check the API**

Run:
```bash
pnpm --filter @revamp/api exec tsc --noEmit
```
Expected: No errors (clean output)

- [ ] **Step 3: Verify with a direct DB test**

Run the API dev server and use psql to check that existing `updateStageProgress` calls still work:
```bash
psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -c "
SELECT stage_progress->'SCAN'->>'completedAt' as scan_completed,
       stage_progress->'SCAN'->>'status' as scan_status
FROM pipeline_runs
WHERE id = '238b5533-6547-4bf5-9721-3be01867760c';
"
```
Expected: `scan_completed` is either empty or null (field doesn't exist yet for old data), `scan_status` is `approved`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/pipeline-repository.ts
git commit -m "feat: write completedAt to stage_progress JSONB on terminal status"
```

---

### Task 2: Update sync effect to read `completedAt` from DB

**Files:**
- Modify: `apps/web/app/(dashboard)/projects/[id]/pipeline/page.tsx:144-158`

- [ ] **Step 1: Update the sync effect completedAt logic**

In `apps/web/app/(dashboard)/projects/[id]/pipeline/page.tsx`, find the timer sync block (around line 144). Replace:

```typescript
        // Timer: pending clears, finished sets completedAt
        if (dbStatus === 'pending') {
          if (stages[i].startedAt || stages[i].completedAt) {
            updates.startedAt = null;
            updates.completedAt = null;
          }
        } else if (dbStatus !== 'in_progress') {
          // Stage is in a terminal state — ensure completedAt is set so the
          // elapsed timer stops. Prefer the DB's updatedAt timestamp; fall
          // back to the current time if the DB entry somehow lacks it.
          const completedTs = dbEntry.updatedAt || new Date().toISOString();
          if (stages[i].completedAt !== completedTs) {
            updates.completedAt = completedTs;
          }
        }
```

With:

```typescript
        // Timer: pending clears, finished sets completedAt from DB
        if (dbStatus === 'pending') {
          if (stages[i].startedAt || stages[i].completedAt) {
            updates.startedAt = null;
            updates.completedAt = null;
          }
        } else if (dbStatus !== 'in_progress') {
          // Stage is terminal — read completedAt from DB (primary source).
          // Fall back to updatedAt for legacy data, then current time.
          const completedTs = dbEntry.completedAt || dbEntry.updatedAt || new Date().toISOString();
          if (stages[i].completedAt !== completedTs) {
            updates.completedAt = completedTs;
          }
        }
```

The only change: `dbEntry.completedAt ||` is prepended as the primary source.

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/\(dashboard\)/projects/\[id\]/pipeline/page.tsx
git commit -m "feat: sync effect reads completedAt from DB as primary source"
```

---

### Task 3: Update canonical ElapsedTimer component in `@revamp/views`

**Files:**
- Modify: `packages/views/src/pipeline/elapsed-timer.tsx`

- [ ] **Step 1: Replace the ElapsedTimer component**

Replace the entire content of `packages/views/src/pipeline/elapsed-timer.tsx` with:

```typescript


import { useState, useEffect, useRef } from 'react';
import { Clock } from 'lucide-react';

// --- Types ---

interface ElapsedTimerProps {
  startedAt: string | null;
  completedAt: string | null;
  /** Stage status — used as a fallback stop signal when completedAt is missing */
  status?: string;
}

// --- Helpers ---

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// --- Component ---

/**
 * Elapsed timer — DB-driven, single source of truth.
 *
 * Stops when ANY of these is true:
 *   - completedAt is set (normal path, from DB)
 *   - status is terminal (defense-in-depth for legacy/corrupted data)
 *   - startedAt is absent (stage not started)
 *
 * When terminal without completedAt, freezes the display at the last
 * live value via useRef to avoid jumps.
 */
export function ElapsedTimer({ startedAt, completedAt, status }: ElapsedTimerProps) {
  const isTerminal = status === 'completed' || status === 'failed' || status === 'approved';
  const isRunning = !!startedAt && !completedAt && !isTerminal;
  const [, setTick] = useState(0);

  // Freeze the displayed time when the stage becomes terminal without
  // completedAt. Captures the last live value so we don't jump to 0:00.
  const frozenRef = useRef<string | null>(null);
  if (isRunning) {
    frozenRef.current = null;
  } else if (isTerminal && !completedAt && !frozenRef.current && startedAt) {
    frozenRef.current = formatElapsed(Date.now() - new Date(startedAt).getTime());
  }

  // Single interval — only depends on isRunning (boolean).
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  if (!startedAt) return null;

  const start = new Date(startedAt).getTime();
  let elapsed: string;
  if (completedAt) {
    // Normal path: exact duration from DB timestamps
    elapsed = formatElapsed(new Date(completedAt).getTime() - start);
  } else if (isTerminal) {
    // Fallback: terminal without completedAt (legacy data) — show frozen value
    elapsed = frozenRef.current || formatElapsed(Date.now() - start);
  } else {
    // Running: live ticking
    elapsed = formatElapsed(Date.now() - start);
  }

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
      <Clock className={`h-3.5 w-3.5 ${isRunning ? 'animate-spin' : ''}`} />
      <span>{elapsed}</span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/views/src/pipeline/elapsed-timer.tsx
git commit -m "feat: ElapsedTimer uses status as fallback stop signal, frozen ref for legacy data"
```

---

### Task 4: Revert `apps/web` ElapsedTimer to re-export

**Files:**
- Modify: `apps/web/components/pipeline/elapsed-timer.tsx`

- [ ] **Step 1: Replace the inlined component with a re-export**

Replace the entire content of `apps/web/components/pipeline/elapsed-timer.tsx` with:

```typescript
'use client';
export { ElapsedTimer } from '@revamp/views/pipeline/elapsed-timer';
```

- [ ] **Step 2: Verify center-panel already passes `status` prop**

Open `apps/web/components/pipeline/mission-control/center-panel.tsx` and confirm lines 205-209 have:

```tsx
<ElapsedTimer
  startedAt={stage.startedAt}
  completedAt={stage.completedAt}
  status={stage.status}
/>
```

This was already done during the debugging session. No change needed.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/pipeline/elapsed-timer.tsx
git commit -m "refactor: revert ElapsedTimer to re-export from @revamp/views"
```

---

### Task 5: Clean up sessionStorage normalization

**Files:**
- Modify: `packages/core/src/stores/pipeline-store.ts:79-91`

- [ ] **Step 1: Remove the debug-era comment and simplify normalization**

In `packages/core/src/stores/pipeline-store.ts`, find the `loadPipelineState()` normalization block (lines 79-91). Replace:

```typescript
    // Normalize transient statuses that can't survive refresh.
    // 'generating'/'validating' are in-flight states — if the page refreshed,
    // the execution is gone. Map them to 'completed' (the sync effect will
    // correct to the DB value on the next poll). This prevents the ApprovalGate
    // from unmounting/remounting which resets the countdown timer.
    for (const stage of parsed.stages) {
      if (stage.status === 'generating' || stage.status === 'validating') {
        stage.status = stage.output ? 'completed' : 'pending';
      }
      // Don't fabricate completedAt here — the sync effect will set it from
      // the DB's updatedAt on the first poll. The ElapsedTimer component uses
      // the status prop as a fallback stop signal when completedAt is missing.
    }
```

With:

```typescript
    // Normalize transient statuses that can't survive refresh.
    // 'generating'/'validating' are in-flight states — if the page refreshed,
    // the execution is gone. Map them to 'completed' (the sync effect will
    // correct to the DB value on the next poll). This prevents the ApprovalGate
    // from unmounting/remounting which resets the countdown timer.
    // completedAt is NOT fabricated here — the DB owns it. The ElapsedTimer
    // uses the status prop as a fallback stop signal until the sync effect
    // delivers completedAt from the DB on the first poll.
    for (const stage of parsed.stages) {
      if (stage.status === 'generating' || stage.status === 'validating') {
        stage.status = stage.output ? 'completed' : 'pending';
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/stores/pipeline-store.ts
git commit -m "refactor: clean up sessionStorage normalization, DB owns completedAt"
```

---

### Task 6: Fix existing DB data and verify end-to-end

- [ ] **Step 1: Backfill `completedAt` for existing completed stages**

Run this SQL to add `completedAt` to all terminal stages that are missing it, using `updatedAt` as the best available proxy:

```bash
psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -c "
UPDATE pipeline_runs
SET stage_progress = (
  SELECT jsonb_object_agg(
    key,
    CASE
      WHEN value->>'status' IN ('completed', 'failed', 'approved', 'rejected', 'awaiting_approval')
           AND COALESCE(value->>'completedAt', '') = ''
      THEN value || jsonb_build_object('completedAt', value->>'updatedAt')
      ELSE value
    END
  )
  FROM jsonb_each(stage_progress)
)
WHERE stage_progress IS NOT NULL
RETURNING id, current_stage;
"
```

Expected: Returns all pipeline run IDs that were updated.

- [ ] **Step 2: Verify the BLUEPRINT stage has completedAt**

```bash
psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -c "
SELECT stage_progress->'BLUEPRINT'->>'status' as status,
       stage_progress->'BLUEPRINT'->>'startedAt' as started,
       stage_progress->'BLUEPRINT'->>'completedAt' as completed
FROM pipeline_runs
WHERE id = '238b5533-6547-4bf5-9721-3be01867760c';
"
```

Expected: `status = failed`, `completed` is a non-empty ISO timestamp.

- [ ] **Step 3: Restart servers and verify in browser**

```bash
# Kill and restart API
lsof -iTCP:8787 -sTCP:LISTEN -P | awk 'NR>1{print $2}' | xargs kill -9
sleep 1 && pnpm dev:api &

# Kill and restart web (clear cache)
lsof -iTCP:3001 -sTCP:LISTEN -P | awk 'NR>1{print $2}' | xargs kill -9
rm -rf apps/web/.next/dev
sleep 1 && pnpm dev:web &
```

Wait for both servers to start, then hard refresh the browser (`Cmd+Shift+R`).

Expected:
- BLUEPRINT shows "Failed" status badge
- Timer shows a frozen elapsed time (not ticking, no spinning clock icon)
- Other completed/approved stages show their correct duration

- [ ] **Step 4: Commit the backfill as a note**

No code commit needed — this is a one-time data fix. But verify all stages across the pipeline show correct timer behavior.
