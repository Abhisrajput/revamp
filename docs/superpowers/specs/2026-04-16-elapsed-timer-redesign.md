# Elapsed Timer Redesign — DB-Driven Single Source of Truth

## Problem

The elapsed timer on the pipeline center panel runs forever after stage completion. Root causes:

1. **Backend catch block** never writes `"failed"` to `stage_progress` JSONB — the DB stays at `in_progress` permanently after errors.
2. **`completedAt` exists only in the Zustand store** — never persisted to the DB, lost on refresh or sync.
3. **Three independent data paths** (SSE handler, sync effect, sessionStorage restore) all manage timer state, creating race conditions where `completedAt` is null but `status` is terminal.

## Solution

Move `completedAt` into the DB's `stage_progress` JSONB. The timer derives its state from DB data via React Query. No frontend-only timer state.

## Design

### 1. Backend — `completedAt` in `stage_progress` JSONB

**File:** `apps/api/src/services/pipeline-repository.ts`

`updateStageProgress()` gains a `completedAt` field in the JSONB write. The logic is inside the function so all callers inherit it automatically:

- When status is terminal (`completed`, `failed`, `approved`, `rejected`, `awaiting_approval`): set `completedAt` to `now` ISO string.
- When status is `in_progress`: clear `completedAt` to empty string (fresh execution start).
- When status is `pending`: clear both `startedAt` and `completedAt`.

The `startedAt` logic is unchanged.

**Resulting JSONB shape:**
```json
{
  "BLUEPRINT": {
    "status": "completed",
    "progress": 100,
    "startedAt": "2026-04-15T00:30:23.428Z",
    "completedAt": "2026-04-15T01:02:45.123Z",
    "updatedAt": "2026-04-15T01:02:45.123Z",
    "confidenceScore": 87
  }
}
```

**Other backend files — no changes needed.** The route handler catch block fix (adding `updateStageProgress("failed")`) is already in place and will now automatically write `completedAt`. The `failStage()` function in `pipeline-operations.ts` only updates the run-level status, not `stage_progress`, so it needs no change.

### 2. Frontend — Timer reads from React Query, not Zustand

**Data flow:**

1. `usePipelineStatus()` polls the API, returns `stage_progress` with `startedAt`, `completedAt`, `updatedAt`.
2. The sync effect in `apps/web/.../pipeline/page.tsx` writes `startedAt` and `completedAt` from the DB into the Zustand stage object.
3. `CenterPanel` passes `stage.startedAt`, `stage.completedAt`, `stage.status` to `ElapsedTimer`.

**Sync effect changes (`apps/web/.../pipeline/page.tsx`):**

The `completedAt` branch in the sync effect simplifies. Instead of using `dbEntry.updatedAt` as a proxy:

```
if dbStatus === 'pending':
  clear startedAt and completedAt
else if dbStatus !== 'in_progress':
  set completedAt = dbEntry.completedAt || dbEntry.updatedAt || now
  (dbEntry.completedAt is the new primary source; updatedAt is fallback for legacy data)
```

The `startedAt` sync logic is unchanged.

**SSE path (optimistic updates):**

During live execution, the SSE handler in `use-stage-execution.ts` still calls `setStageStatus(idx, 'completed')` for immediate UI feedback. This sets `completedAt` in Zustand optimistically via the existing `setStageStatus` logic. The next React Query poll confirms it from the DB. The SSE path becomes a fast optimistic update rather than the only source of truth.

### 3. Timer Component — Simplified implementation

**File:** `packages/views/src/pipeline/elapsed-timer.tsx`

**Props:**
- `startedAt: string | null`
- `completedAt: string | null`
- `status: string` — stage status, used as defense-in-depth stop signal

**`isRunning` derivation (three conditions):**
```
isRunning = !!startedAt
            && !completedAt
            && (status === 'generating' || status === 'validating')
```

The timer stops if ANY of these is true:
- `completedAt` is set (normal path from DB)
- `status` is terminal (defense-in-depth for corrupted data)
- `startedAt` is absent (stage not started)

**Elapsed computation:**
- `completedAt` exists: `completedAt - startedAt` (exact frozen duration)
- Terminal + no `completedAt`: frozen at last live value via `useRef` (covers legacy corrupted data)
- Running: `Date.now() - startedAt` (live ticking, 1s interval)

**Tick mechanism:** Single `setInterval` gated on `isRunning` boolean. Unchanged from current design — only the `isRunning` derivation changes.

**`apps/web/components/pipeline/elapsed-timer.tsx`** reverts to a re-export:
```tsx
'use client';
export { ElapsedTimer } from '@revamp/views/pipeline/elapsed-timer';
```

**`apps/web/.../center-panel.tsx`** passes `status` prop:
```tsx
<ElapsedTimer
  startedAt={stage.startedAt}
  completedAt={stage.completedAt}
  status={stage.status}
/>
```

### 4. Cleanup — What gets removed

| What | Where | Why |
|------|-------|-----|
| `completedAt` hack in `loadPipelineState()` | `packages/core/src/stores/pipeline-store.ts` | DB owns `completedAt` now |
| `completedAt = new Date()` in `setStageStatus` for terminal statuses | `packages/core/src/stores/pipeline-store.ts` lines 164-166 | **Kept** — still fires for optimistic SSE updates so the timer stops instantly. No longer the source of truth; the DB confirms it on the next poll. |
| Inlined ElapsedTimer component | `apps/web/components/pipeline/elapsed-timer.tsx` | Reverts to re-export of canonical `@revamp/views` component |

**Kept as-is:**
- `setStageStatus` still manages `startedAt` (cleared on `generating`, set on fresh execution) for instant timer start without DB round-trip.
- `updateStageProgress("failed")` in the route catch block — belt-and-suspenders.
- The sync effect bridge from React Query → Zustand — it just reads `dbEntry.completedAt` (new field) instead of using `dbEntry.updatedAt` as a proxy.

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/services/pipeline-repository.ts` | Add `completedAt` to `updateStageProgress()` JSONB write |
| `apps/web/app/(dashboard)/projects/[id]/pipeline/page.tsx` | Sync effect reads `dbEntry.completedAt` as primary source |
| `packages/views/src/pipeline/elapsed-timer.tsx` | Accept `status` prop, three-condition `isRunning`, frozen ref for legacy data |
| `packages/core/src/stores/pipeline-store.ts` | Remove `completedAt` hacks from `loadPipelineState()` normalization |
| `apps/web/components/pipeline/elapsed-timer.tsx` | Revert to re-export |
| `apps/web/components/pipeline/mission-control/center-panel.tsx` | Pass `status` prop to ElapsedTimer |
