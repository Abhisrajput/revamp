# Stage Decoupling Phase 2: New Status Endpoint + Frontend Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the frontend to read stage state from `stage_executions` table instead of the `stage_progress` JSONB, eliminating the Zustand sync effect and sessionStorage persistence for stage data.

**Architecture:** New `/pipeline/:id/status/v2` endpoint reads from `stage_executions` → new React Query hooks consume it → pipeline page reads directly from React Query → Zustand slimmed to UI-only state (active tab, streaming text). The old endpoint stays for backward compatibility.

**Tech Stack:** PostgreSQL, Drizzle ORM, Fastify, React Query, Zustand, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-16-stage-decoupling-design.md` (Phase 2)

**Depends on:** Phase 1 (stage_executions table + dual-write) must be complete.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/api/src/services/stage-execution-repository.ts` | Modify | Add `getStatusForRun` query that builds the v2 response |
| `apps/api/src/routes/pipeline.ts` | Modify | Add `GET /pipeline/:id/status/v2` endpoint |
| `packages/core/src/types/pipeline.ts` | Modify | Add `StageExecutionEntry` and `PipelineStatusV2` types |
| `packages/core/src/hooks/use-pipeline-queries.ts` | Modify | Add `usePipelineStatusV2`, `useStageExecutionOutput` hooks |
| `apps/web/app/(dashboard)/projects/[id]/pipeline/page.tsx` | Modify | Replace old hooks + sync effect with new v2 hooks |
| `packages/core/src/stores/pipeline-store.ts` | Modify | Slim down: remove `stages[]`, keep UI-only state |
| `apps/web/components/pipeline/elapsed-timer.tsx` | Modify | Simplify: pure props from React Query |
| `apps/web/components/pipeline/mission-control/center-panel.tsx` | Modify | Read from v2 props instead of Zustand stage |

---

### Task 1: Add `getStatusForRun` to the repository

**Files:**
- Modify: `apps/api/src/services/stage-execution-repository.ts`

- [ ] **Step 1: Add the query function**

Add at the end of `apps/api/src/services/stage-execution-repository.ts`:

```typescript
// ─── Status Query (Phase 2) ─────────────────────────────────────

export interface StageExecutionSummary {
  id: string;
  version: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  output_length: number;
  approval_status: string;
  approved_at: string | null;
  validation: Record<string, unknown> | null;
  model: string | null;
  token_usage: Record<string, unknown> | null;
  input_refs: Record<string, string>;
  error_message: string | null;
}

export interface StageStatusEntry {
  latest: StageExecutionSummary | null;
  versions: number[];
  stale: boolean;
  stale_reason: string | null;
}

/**
 * Build the full pipeline status from stage_executions.
 * Returns one entry per stage with the latest execution and staleness info.
 */
export async function getStatusForRun(
  pipelineRunId: string,
  stageOrder: string[],
  conn: DbConnection = db,
): Promise<Record<string, StageStatusEntry>> {
  // Fetch all executions for this run
  const allExecs = await conn.query.stageExecutions.findMany({
    where: eq(stageExecutions.pipeline_run_id, pipelineRunId),
    orderBy: [desc(stageExecutions.version)],
  });

  // Group by stage
  const byStage = new Map<string, typeof allExecs>();
  for (const exec of allExecs) {
    const list = byStage.get(exec.stage_name) || [];
    list.push(exec);
    byStage.set(exec.stage_name, list);
  }

  // Build latest approved map for staleness detection
  const latestApprovedMap = new Map<string, string>();
  for (const [stageName, execs] of byStage) {
    const approved = execs.find(e => e.approval_status === 'approved');
    if (approved) latestApprovedMap.set(stageName, approved.id);
  }

  const result: Record<string, StageStatusEntry> = {};

  for (const stageName of stageOrder) {
    const execs = byStage.get(stageName) || [];
    const latest = execs[0] || null; // Already sorted desc by version

    // Staleness: check if any input_ref points to an older execution
    // than the current latest approved for that stage
    let stale = false;
    let staleReason: string | null = null;
    if (latest && latest.input_refs && typeof latest.input_refs === 'object') {
      const refs = latest.input_refs as Record<string, string>;
      for (const [refStage, refExecId] of Object.entries(refs)) {
        const currentApproved = latestApprovedMap.get(refStage);
        if (currentApproved && currentApproved !== refExecId) {
          stale = true;
          const currentVersion = byStage.get(refStage)?.find(e => e.id === currentApproved)?.version;
          const refVersion = byStage.get(refStage)?.find(e => e.id === refExecId)?.version;
          staleReason = `Built from ${refStage} v${refVersion ?? '?'}, but v${currentVersion ?? '?'} is now approved`;
          break;
        }
      }
    }

    result[stageName] = {
      latest: latest ? {
        id: latest.id,
        version: latest.version,
        status: latest.status,
        started_at: latest.started_at?.toISOString() ?? null,
        completed_at: latest.completed_at?.toISOString() ?? null,
        output_length: latest.output_length ?? 0,
        approval_status: latest.approval_status,
        approved_at: latest.approved_at?.toISOString() ?? null,
        validation: latest.validation as Record<string, unknown> | null,
        model: latest.model,
        token_usage: latest.token_usage as Record<string, unknown> | null,
        input_refs: (latest.input_refs as Record<string, string>) ?? {},
        error_message: latest.error_message,
      } : null,
      versions: execs.map(e => e.version),
      stale,
      stale_reason: staleReason,
    };
  }

  return result;
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @revamp/api exec tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/stage-execution-repository.ts
git commit -m "feat: add getStatusForRun query for v2 status endpoint"
```

---

### Task 2: Add `/pipeline/:id/status/v2` endpoint

**Files:**
- Modify: `apps/api/src/routes/pipeline.ts`

- [ ] **Step 1: Add import**

Add `getStatusForRun` to the existing stage-execution-repository import:

```typescript
import {
  createExecution,
  completeExecution,
  failExecution,
  getStatusForRun,
} from "@/services/stage-execution-repository.js";
```

- [ ] **Step 2: Add the v2 status endpoint**

Add after the existing `/pipeline/:pipelineRunId/status` route (around line 570, before the next route):

```typescript
  /**
   * GET /pipeline/:pipelineRunId/status/v2 — Stage-executions-based status
   *
   * Reads from stage_executions table instead of stage_progress JSONB.
   * Returns per-stage latest execution, version history, and staleness info.
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/status/v2",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Get pipeline status from stage_executions (v2)",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId } = request.params;
      const run = await pipelineService.getPipelineRun(pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      const { PIPELINE_STAGE_ORDER } = await import("@revamp/shared-types/pipeline");
      const stages = await getStatusForRun(pipelineRunId, PIPELINE_STAGE_ORDER);

      // Derive run status from stage states
      const stageEntries = Object.values(stages);
      const allApproved = stageEntries.every(s => s.latest?.approval_status === 'approved');
      const anyRunning = stageEntries.some(s => s.latest?.status === 'running');
      const anyStarted = stageEntries.some(s => s.latest !== null);
      const derivedStatus = allApproved ? 'completed'
        : anyRunning ? 'running'
        : anyStarted ? 'in_progress'
        : 'pending';

      return reply.send({
        id: run.id,
        project_id: run.project_id,
        status: derivedStatus,
        stages,
      });
    },
  );
```

- [ ] **Step 3: Add output endpoint for individual executions**

Add after the v2 status route:

```typescript
  /**
   * GET /pipeline/execution/:executionId/output — Get execution output content
   */
  fastify.get<{ Params: { executionId: string } }>(
    "/pipeline/execution/:executionId/output",
    {
      schema: buildRouteSchema({
        params: z.object({ executionId: z.string().uuid() }),
        tags: ["Pipeline"],
        summary: "Get stage execution output content",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { executionId } = request.params;
      const exec = await db.query.stageExecutions.findFirst({
        where: eq(stageExecutions.id, executionId),
        columns: { id: true, output: true, stage_name: true, version: true },
      });
      if (!exec) {
        return reply.status(404).send({ error: "Execution not found" });
      }
      return reply.send({
        id: exec.id,
        stage_name: exec.stage_name,
        version: exec.version,
        output: exec.output,
      });
    },
  );
```

- [ ] **Step 4: Ensure `stageExecutions` is imported from schema**

Check the imports at the top of the file. If `stageExecutions` is not already imported from `@/db/schema.js`, add it:

```typescript
import { ..., stageExecutions } from "@/db/schema.js";
```

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @revamp/api exec tsc --noEmit`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/pipeline.ts
git commit -m "feat: add /status/v2 and /execution/:id/output endpoints"
```

---

### Task 3: Add frontend types and React Query hooks

**Files:**
- Modify: `packages/core/src/types/pipeline.ts`
- Modify: `packages/core/src/hooks/use-pipeline-queries.ts`

- [ ] **Step 1: Add types**

At the end of `packages/core/src/types/pipeline.ts`, add:

```typescript
/** Stage execution summary from GET /pipeline/:id/status/v2 */
export interface StageExecutionEntry {
  id: string;
  version: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  output_length: number;
  approval_status: string;
  approved_at: string | null;
  validation: { passed?: boolean; confidenceScore?: number; criteria?: unknown[]; summary?: string } | null;
  model: string | null;
  token_usage: { input?: number; output?: number; cost?: number } | null;
  input_refs: Record<string, string>;
  error_message: string | null;
}

/** Per-stage status from v2 endpoint */
export interface StageStatusV2 {
  latest: StageExecutionEntry | null;
  versions: number[];
  stale: boolean;
  stale_reason: string | null;
}

/** Full pipeline status from GET /pipeline/:id/status/v2 */
export interface PipelineStatusV2 {
  id: string;
  project_id: string;
  status: string;
  stages: Record<string, StageStatusV2>;
}
```

- [ ] **Step 2: Add React Query hooks**

At the end of `packages/core/src/hooks/use-pipeline-queries.ts` (before the `// ─── Derived selectors` section), add:

```typescript
// ─── V2 Hooks (stage_executions based) ──────────────────────────

export function usePipelineStatusV2(runId: string | null) {
  const api = getApiClient();
  return useQuery<PipelineStatusV2 | null>({
    queryKey: ['pipeline-status-v2', runId || ''],
    queryFn: async () => {
      if (!runId) return null;
      const res = await api.get(`/pipeline/${runId}/status/v2`);
      return res.data;
    },
    enabled: !!runId,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'running' || status === 'pending') return 5_000;
      if (status === 'completed' || status === 'failed') return 30_000;
      return 10_000;
    },
  });
}

export function useStageExecutionOutput(executionId: string | null) {
  const api = getApiClient();
  return useQuery<string | null>({
    queryKey: ['stage-execution-output', executionId || ''],
    queryFn: async () => {
      if (!executionId) return null;
      const res = await api.get(`/pipeline/execution/${executionId}/output`);
      return res.data?.output ?? null;
    },
    enabled: !!executionId,
    staleTime: 300_000, // Output doesn't change once written
    retry: 1,
  });
}
```

Also add the import for the new types at the top of the file:

```typescript
import type { PipelineStatus, PipelineStatusV2, ValidationResult } from '../types/pipeline';
```

- [ ] **Step 3: Export from barrel**

Check `packages/core/src/index.ts` exports `usePipelineStatusV2` and `useStageExecutionOutput`. If not, add them.

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @revamp/api exec tsc --noEmit`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/pipeline.ts packages/core/src/hooks/use-pipeline-queries.ts packages/core/src/index.ts
git commit -m "feat: add PipelineStatusV2 types and React Query hooks"
```

---

### Task 4: Migrate pipeline page to v2 hooks

**Files:**
- Modify: `apps/web/app/(dashboard)/projects/[id]/pipeline/page.tsx`

This is the biggest task. The pipeline page currently uses `usePipelineStatus` (v1) + a sync effect to bridge React Query → Zustand. We replace this with `usePipelineStatusV2` + `useStageExecutionOutput` and pass data directly to components.

- [ ] **Step 1: Add v2 imports**

At the top of the file, add to the existing imports from `@revamp/core`:

```typescript
import { usePipelineStatusV2, useStageExecutionOutput } from '@revamp/core';
```

- [ ] **Step 2: Add v2 hook call alongside v1**

After the existing `usePipelineStatus` call (around line 58), add:

```typescript
  // V2: stage-executions-based status (replaces stage_progress JSONB)
  const { data: statusV2 } = usePipelineStatusV2(effectiveRunId);
```

- [ ] **Step 3: Derive active stage data from v2**

After the `activeStage` declaration (around line 326), add:

```typescript
  // V2: derive stage execution data from the new endpoint
  const activeStageV2 = statusV2?.stages?.[activeStage?.name ?? ''] ?? null;
  const activeExecId = activeStageV2?.latest?.id ?? null;
  const { data: activeStageOutput } = useStageExecutionOutput(activeExecId);
```

- [ ] **Step 4: Pass v2 data to CenterPanel**

In the CenterPanel render (around line 1070), update `dbStageProgress` to use v2 data:

Replace:
```typescript
              dbStageProgress={pipelineStatusData?.stage_progress?.[activeStage.name] as any}
```

With:
```typescript
              dbStageProgress={activeStageV2?.latest ? {
                startedAt: activeStageV2.latest.started_at ?? undefined,
                completedAt: activeStageV2.latest.completed_at ?? undefined,
                status: activeStageV2.latest.status,
              } : undefined}
```

- [ ] **Step 5: Update the output sync effect to prefer v2 data**

Find the output sync effect (around line 213). Update it to also consider v2 output:

Replace:
```typescript
  // Sync stage outputs from React Query → store
  // React Query is the source of truth — always overwrite Zustand with DB data.
  useEffect(() => {
    if (!allOutputs) return;
    usePipelineStore.setState((state) => {
      const stages = [...state.stages];
      let changed = false;
      for (const [stageName, output] of Object.entries(allOutputs)) {
        if (!output) continue;
        const idx = stages.findIndex(s => s.name === stageName);
        if (idx >= 0 && stages[idx].output !== output) {
          stages[idx] = { ...stages[idx], output };
          changed = true;
        }
      }
      return changed ? { stages } : state;
    });
  }, [allOutputs]);
```

With:
```typescript
  // Sync stage outputs from React Query → store
  // React Query is the source of truth — always overwrite Zustand with DB data.
  // Also sync v2 execution output for the active stage.
  useEffect(() => {
    if (!allOutputs && !activeStageOutput) return;
    usePipelineStore.setState((state) => {
      const stages = [...state.stages];
      let changed = false;
      // V1: bulk output sync
      if (allOutputs) {
        for (const [stageName, output] of Object.entries(allOutputs)) {
          if (!output) continue;
          const idx = stages.findIndex(s => s.name === stageName);
          if (idx >= 0 && stages[idx].output !== output) {
            stages[idx] = { ...stages[idx], output };
            changed = true;
          }
        }
      }
      // V2: active stage output from stage_executions (takes priority)
      if (activeStageOutput && activeStage) {
        const idx = stages.findIndex(s => s.name === activeStage.name);
        if (idx >= 0 && stages[idx].output !== activeStageOutput) {
          stages[idx] = { ...stages[idx], output: activeStageOutput };
          changed = true;
        }
      }
      return changed ? { stages } : state;
    });
  }, [allOutputs, activeStageOutput, activeStage?.name]);
```

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @revamp/api exec tsc --noEmit`
Expected: Clean (or pre-existing errors only)

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/\(dashboard\)/projects/\[id\]/pipeline/page.tsx
git commit -m "feat: pipeline page uses v2 status for timer and output data"
```

---

### Task 5: Simplify ElapsedTimer

**Files:**
- Modify: `apps/web/components/pipeline/elapsed-timer.tsx`

- [ ] **Step 1: Simplify the timer**

Replace the entire content of `apps/web/components/pipeline/elapsed-timer.tsx`:

```typescript
'use client';

import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';

interface ElapsedTimerProps {
  startedAt: string | null;
  completedAt: string | null;
  status?: string;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function ElapsedTimer({ startedAt, completedAt, status }: ElapsedTimerProps) {
  const isTerminal = status === 'completed' || status === 'failed' || status === 'approved';
  const isRunning = !!startedAt && !completedAt && !isTerminal;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  if (!startedAt) return null;

  const start = new Date(startedAt).getTime();
  const elapsed = completedAt
    ? formatElapsed(new Date(completedAt).getTime() - start)
    : formatElapsed(Date.now() - start);

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
      <Clock className={`h-3.5 w-3.5 ${isRunning ? 'animate-spin' : ''}`} />
      <span>{elapsed}</span>
    </div>
  );
}
```

No more frozenRef hack. With v2 data, `completedAt` is always set for terminal stages. The `status` prop is a belt-and-suspenders fallback that stops the interval — but the display uses `Date.now()` only while actually running.

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/pipeline/elapsed-timer.tsx
git commit -m "refactor: simplify ElapsedTimer — v2 provides completedAt reliably"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1: Restart servers**

```bash
# Kill and restart API
lsof -iTCP:8787 -sTCP:LISTEN -P | awk 'NR>1{print $2}' | xargs kill -9
sleep 1 && pnpm dev:api &

# Kill and restart web
lsof -iTCP:3001 -sTCP:LISTEN -P | awk 'NR>1{print $2}' | xargs kill -9
rm -rf apps/web/.next
sleep 1 && pnpm dev:web &
```

- [ ] **Step 2: Verify v2 endpoint**

```bash
# Get a valid run ID
RUN_ID=$(psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -tAc "SELECT id FROM pipeline_runs ORDER BY updated_at DESC LIMIT 1")

# Hit the v2 endpoint (use a valid auth token or test via the browser network tab)
curl -s "http://localhost:8787/pipeline/$RUN_ID/status/v2" \
  -H "Authorization: Bearer YOUR_TOKEN" | python3 -m json.tool | head -40
```

Expected: JSON with `stages` object, each stage has `latest` (or null), `versions`, `stale`, `stale_reason`.

- [ ] **Step 3: Verify in browser**

Hard refresh the pipeline page. Check:
1. Stage outputs load correctly (from v2 execution output)
2. Timer shows correct elapsed time (from v2 `started_at`/`completed_at`)
3. Timer stops for completed/approved stages
4. Timer ticks for running stages
5. Stale badges appear if upstream was re-run (future test)

- [ ] **Step 4: Execute a new stage and verify**

Run DECODE (or whichever stage is next). Verify:
1. Timer starts when execution begins
2. Timer stops when stage completes
3. Output appears after completion
4. Approval works
5. `stage_executions` row has correct `started_at`, `completed_at`, `output`

- [ ] **Step 5: Commit any fixes**

If issues found, fix and commit with descriptive message.
