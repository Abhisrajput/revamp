# Stage Decoupling Phase 1: `stage_executions` Table + Dual-Write

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `stage_executions` table and dual-write to it alongside the existing `stage_progress` JSONB, so the new table accumulates correct data while the frontend still reads from the old system.

**Architecture:** New Drizzle table definition → migration → repository functions for CRUD → dual-write hooks in the pipeline execution service, route handler, and approval operations. The existing system is untouched — this phase is purely additive.

**Tech Stack:** PostgreSQL, Drizzle ORM, Fastify, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-16-stage-decoupling-design.md` (Phase 1)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/api/src/db/schema.ts` | Modify | Add `stageExecutions` table + relations |
| `apps/api/src/services/stage-execution-repository.ts` | Create | CRUD functions for `stage_executions` |
| `apps/api/src/services/pipeline.ts` | Modify | Dual-write on stage completion |
| `apps/api/src/services/pipeline-operations.ts` | Modify | Dual-write on approval/rejection |
| `apps/api/src/routes/pipeline.ts` | Modify | Create execution row on stage start, update on complete/fail |
| `apps/api/src/__tests__/stage-execution-repository.test.ts` | Create | Tests for the new repository functions |

---

### Task 1: Define `stageExecutions` table in Drizzle schema

**Files:**
- Modify: `apps/api/src/db/schema.ts`

- [ ] **Step 1: Add the `stageExecutions` table definition**

Add after the existing `stageRuns` table definition (after line ~359) in `apps/api/src/db/schema.ts`:

```typescript
// Stage executions — independent stage lifecycle with versioned outputs
// This is the future source of truth for stage state (replaces stage_progress JSONB in Phase 2).
export const stageExecutions = pgTable(
  "stage_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipeline_run_id: uuid("pipeline_run_id").notNull().references(() => pipelineRuns.id, { onDelete: "cascade" }),
    stage_name: varchar("stage_name", { length: 100 }).notNull(),
    version: integer("version").notNull(),

    // Lifecycle
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    started_at: timestamp("started_at"),
    completed_at: timestamp("completed_at"),
    error_message: text("error_message"),

    // Output
    output: text("output"),
    output_length: integer("output_length").default(0),

    // Validation (inline JSONB)
    validation: jsonb("validation"),

    // Approval (inline — replaces approval_gates in Phase 3)
    approval_status: varchar("approval_status", { length: 30 }).notNull().default("not_required"),
    approved_by: uuid("approved_by"),
    approved_at: timestamp("approved_at"),
    approval_comment: text("approval_comment"),

    // Provenance — which prior executions were consumed as input
    input_refs: jsonb("input_refs").notNull().default({}),

    // Execution metadata
    model: varchar("model", { length: 200 }),
    token_usage: jsonb("token_usage"),

    // Timestamps
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdx: index("stage_exec_run_idx").on(table.pipeline_run_id),
    lookupIdx: index("stage_exec_lookup_idx").on(table.pipeline_run_id, table.stage_name, table.version),
    approvedIdx: index("stage_exec_approved_idx").on(table.pipeline_run_id, table.stage_name, table.approval_status),
    runStageVersionUniq: unique("stage_exec_run_stage_version_uniq").on(table.pipeline_run_id, table.stage_name, table.version),
  })
);
```

- [ ] **Step 2: Add relations**

Add after the existing `stageRunsRelations` block (around line ~465):

```typescript
export const stageExecutionsRelations = relations(stageExecutions, ({ one }) => ({
  pipelineRun: one(pipelineRuns, {
    fields: [stageExecutions.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  approvedByUser: one(users, {
    fields: [stageExecutions.approved_by],
    references: [users.id],
  }),
}));
```

Also add `stageExecutions` to the `pipelineRunsRelations` block (around line ~433). Find:

```typescript
export const pipelineRunsRelations = relations(pipelineRuns, ({ many, one }) => ({
```

Add inside the relation object:

```typescript
  stageExecutions: many(stageExecutions),
```

- [ ] **Step 3: Type-check**

Run:
```bash
pnpm --filter @revamp/api exec tsc --noEmit
```
Expected: Clean output (no errors)

- [ ] **Step 4: Generate migration**

Run:
```bash
pnpm db:generate
```
Expected: Creates a migration file in `apps/api/drizzle/` for the new `stage_executions` table.

- [ ] **Step 5: Run migration**

Run:
```bash
pnpm db:migrate
```
Expected: Migration applies successfully. Verify with:
```bash
psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -c "\d stage_executions"
```
Expected: Table exists with all columns.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/
git commit -m "feat: add stage_executions table for independent stage lifecycle"
```

---

### Task 2: Create stage execution repository

**Files:**
- Create: `apps/api/src/services/stage-execution-repository.ts`

- [ ] **Step 1: Create the repository file**

Create `apps/api/src/services/stage-execution-repository.ts`:

```typescript
/**
 * Stage Execution Repository — CRUD for the stage_executions table.
 *
 * This is the future source of truth for stage lifecycle (Phase 2).
 * During Phase 1, these functions are called as dual-writes alongside
 * the existing stage_progress JSONB updates.
 */

import { db, type DbConnection } from "@/db/index.js";
import { stageExecutions } from "@/db/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import type { PipelineStageName } from "@revamp/shared-types/pipeline";
import crypto from "crypto";

// ─── Types ──────────────────────────────────────────────────────

export interface CreateExecutionParams {
  pipelineRunId: string;
  stageName: PipelineStageName;
  model?: string;
}

export interface CompleteExecutionParams {
  executionId: string;
  output: string;
  validation?: Record<string, unknown>;
  tokenUsage?: { input: number; output: number; cost: number };
  conn?: DbConnection;
}

export interface FailExecutionParams {
  executionId: string;
  errorMessage: string;
  conn?: DbConnection;
}

// ─── Queries ────────────────────────────────────────────────────

/**
 * Get the latest approved execution for a stage within a pipeline run.
 */
export async function getLatestApproved(
  pipelineRunId: string,
  stageName: string,
  conn: DbConnection = db,
): Promise<{ id: string; version: number; output: string | null } | null> {
  const row = await conn.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.pipeline_run_id, pipelineRunId),
      eq(stageExecutions.stage_name, stageName),
      eq(stageExecutions.approval_status, "approved"),
    ),
    orderBy: [desc(stageExecutions.version)],
    columns: { id: true, version: true, output: true },
  });
  return row ?? null;
}

/**
 * Resolve input_refs for a stage — find the latest approved execution
 * of each prior stage in the pipeline.
 */
export async function resolveInputRefs(
  pipelineRunId: string,
  priorStageNames: string[],
  conn: DbConnection = db,
): Promise<Record<string, string>> {
  if (priorStageNames.length === 0) return {};

  const refs: Record<string, string> = {};
  for (const stageName of priorStageNames) {
    const approved = await getLatestApproved(pipelineRunId, stageName, conn);
    if (approved) {
      refs[stageName] = approved.id;
    }
  }
  return refs;
}

/**
 * Get the next version number for a stage within a pipeline run.
 */
export async function getNextVersion(
  pipelineRunId: string,
  stageName: string,
  conn: DbConnection = db,
): Promise<number> {
  const result = await conn.execute(sql`
    SELECT COALESCE(MAX(version), 0) + 1 as next_version
    FROM stage_executions
    WHERE pipeline_run_id = ${pipelineRunId}
      AND stage_name = ${stageName}
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  return rows[0]?.next_version ?? 1;
}

// ─── Mutations ──────────────────────────────────────────────────

/**
 * Create a new stage execution (status = 'running').
 * Called when a stage starts executing.
 */
export async function createExecution(
  params: CreateExecutionParams,
  conn: DbConnection = db,
): Promise<{ id: string; version: number }> {
  const { pipelineRunId, stageName, model } = params;
  const id = crypto.randomUUID();
  const version = await getNextVersion(pipelineRunId, stageName, conn);

  // Resolve input refs from prior approved stages
  const { getStageOrder } = await import("@revamp/core-engine");
  const order = getStageOrder();
  const currentIdx = order.indexOf(stageName);
  const priorStages = currentIdx > 0 ? order.slice(0, currentIdx) : [];
  const inputRefs = await resolveInputRefs(pipelineRunId, priorStages, conn);

  await conn.insert(stageExecutions).values({
    id,
    pipeline_run_id: pipelineRunId,
    stage_name: stageName,
    version,
    status: "running",
    started_at: new Date(),
    input_refs: inputRefs,
    model: model || null,
  });

  return { id, version };
}

/**
 * Mark an execution as completed with output and validation.
 */
export async function completeExecution(
  params: CompleteExecutionParams,
): Promise<void> {
  const conn = params.conn ?? db;
  await conn.update(stageExecutions).set({
    status: "completed",
    completed_at: new Date(),
    output: params.output,
    output_length: params.output.length,
    validation: params.validation ?? null,
    token_usage: params.tokenUsage ?? null,
    updated_at: new Date(),
  }).where(eq(stageExecutions.id, params.executionId));
}

/**
 * Mark an execution as failed.
 */
export async function failExecution(
  params: FailExecutionParams,
): Promise<void> {
  const conn = params.conn ?? db;
  await conn.update(stageExecutions).set({
    status: "failed",
    completed_at: new Date(),
    error_message: params.errorMessage,
    updated_at: new Date(),
  }).where(eq(stageExecutions.id, params.executionId));
}

/**
 * Set approval status on an execution.
 */
export async function setApprovalStatus(
  pipelineRunId: string,
  stageName: string,
  status: "approved" | "rejected" | "pending",
  approvedBy?: string,
  comment?: string,
  conn: DbConnection = db,
): Promise<void> {
  // Find the latest execution for this stage
  const latest = await conn.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.pipeline_run_id, pipelineRunId),
      eq(stageExecutions.stage_name, stageName),
    ),
    orderBy: [desc(stageExecutions.version)],
    columns: { id: true },
  });
  if (!latest) return;

  await conn.update(stageExecutions).set({
    approval_status: status,
    approved_by: approvedBy || null,
    approved_at: status === "approved" || status === "rejected" ? new Date() : null,
    approval_comment: comment || null,
    status: status === "approved" ? "approved" : status === "rejected" ? "rejected" : "completed",
    updated_at: new Date(),
  }).where(eq(stageExecutions.id, latest.id));
}

/**
 * Get the latest execution for a stage (any status).
 */
export async function getLatestExecution(
  pipelineRunId: string,
  stageName: string,
  conn: DbConnection = db,
): Promise<typeof stageExecutions.$inferSelect | null> {
  const row = await conn.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.pipeline_run_id, pipelineRunId),
      eq(stageExecutions.stage_name, stageName),
    ),
    orderBy: [desc(stageExecutions.version)],
  });
  return row ?? null;
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
pnpm --filter @revamp/api exec tsc --noEmit
```
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/stage-execution-repository.ts
git commit -m "feat: add stage execution repository with CRUD functions"
```

---

### Task 3: Dual-write in the route handler (stage start + complete + fail)

**Files:**
- Modify: `apps/api/src/routes/pipeline.ts`

- [ ] **Step 1: Add imports**

At the top of `apps/api/src/routes/pipeline.ts`, add:

```typescript
import {
  createExecution,
  completeExecution,
  failExecution,
} from "@/services/stage-execution-repository.js";
```

- [ ] **Step 2: Create execution on stage start**

In the route handler for `POST /pipeline/:pipelineRunId/stage/:stageName`, find where `stageRunId` is created (around line 742):

```typescript
      const stageRunId = crypto.randomUUID();
      await db.insert(stageRuns).values({
```

Add after the `stageRuns` insert (after line ~750):

```typescript
      // Dual-write: create stage execution record
      let stageExecId: string | null = null;
      try {
        const exec = await createExecution({
          pipelineRunId,
          stageName: stageName as any,
          model: modelOverride || process.env.LLM_DEFAULT_MODEL || undefined,
        });
        stageExecId = exec.id;
      } catch (execErr) {
        console.warn(`[Pipeline] Failed to create stage execution: ${execErr instanceof Error ? execErr.message : execErr}`);
      }
```

- [ ] **Step 3: Complete execution on success**

Find the `publish(topic, "complete", {` block (around line 962). Add before it:

```typescript
        // Dual-write: complete stage execution
        if (stageExecId) {
          try {
            await completeExecution({
              executionId: stageExecId,
              output: result.output,
              validation: validationPayload ? {
                passed: validationPayload.passed,
                confidenceScore: validationPayload.confidenceScore,
                criteria: validationPayload.criteria,
                summary: validationPayload.summary,
              } : undefined,
            });
          } catch (execErr) {
            console.warn(`[Pipeline] Failed to complete stage execution: ${execErr instanceof Error ? execErr.message : execErr}`);
          }
        }
```

- [ ] **Step 4: Fail execution in catch block**

Find the catch block (around line 1005). Add after the `updateStageProgress("failed")` call:

```typescript
        // Dual-write: fail stage execution
        if (stageExecId) {
          try {
            await failExecution({ executionId: stageExecId, errorMessage: rawMessage });
          } catch (execErr) {
            console.warn(`[Pipeline] Failed to fail stage execution: ${execErr instanceof Error ? execErr.message : execErr}`);
          }
        }
```

- [ ] **Step 5: Type-check**

Run:
```bash
pnpm --filter @revamp/api exec tsc --noEmit
```
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/pipeline.ts
git commit -m "feat: dual-write stage executions in route handler (start/complete/fail)"
```

---

### Task 4: Dual-write in pipeline service (completion path)

**Files:**
- Modify: `apps/api/src/services/pipeline.ts`

- [ ] **Step 1: Add import**

Add at the top of `apps/api/src/services/pipeline.ts`:

```typescript
import {
  getLatestExecution,
  completeExecution as completeStageExecution,
  failExecution as failStageExecution,
} from "./stage-execution-repository.js";
```

- [ ] **Step 2: Dual-write on standard completion (around line 1026-1074)**

The pipeline service's `executeStage` method has two completion paths:
1. Contract hard-gated → failed (line 1026-1033)
2. Normal completion → completed/awaiting_approval (line 1034-1074)

Find the hard-gate block (line 1026):
```typescript
    if (contractHardGated) {
```

Add after `emitValidationFailed(...)` (around line 1033):

```typescript
      // Dual-write: fail the execution
      const latestExec = await getLatestExecution(pipelineRunId, stageName);
      if (latestExec && latestExec.status === 'running') {
        await failStageExecution({ executionId: latestExec.id, errorMessage: `Contract hard-gated: ${result.validation?.contractResult?.violations?.length ?? 0} violations` }).catch(() => {});
      }
```

Find the normal completion transaction (line 1040):
```typescript
      await db.transaction(async (tx) => {
        await updateStageProgress(pipelineRunId, stageName, "completed", ...
```

Add after the transaction closes (after `});` around line 1055):

```typescript
      // Dual-write: complete the execution and set awaiting_approval if needed
      const latestExec = await getLatestExecution(pipelineRunId, stageName);
      if (latestExec && latestExec.status === 'running') {
        await completeStageExecution({
          executionId: latestExec.id,
          output: result.output,
          validation: result.validation ? {
            passed: result.validation.passed,
            confidenceScore: result.validation.confidenceScore,
            issues: result.validation.issues,
            recommendations: result.validation.recommendations,
          } : undefined,
          tokenUsage: result.tokenUsage,
        }).catch(() => {});
      }
```

- [ ] **Step 3: Dual-write on chunked completion (around line 700-715)**

Find the chunked completion block (around line 700):
```typescript
      if (result.output) {
        const score = chunkedResult.coverage.percentage;
```

Add after `emitStageCompleted(...)` (around line 711):

```typescript
        // Dual-write: complete the execution
        const latestExecChunk = await getLatestExecution(pipelineRunId, stageName);
        if (latestExecChunk && latestExecChunk.status === 'running') {
          await completeStageExecution({
            executionId: latestExecChunk.id,
            output: result.output,
            validation: result.validation ? {
              passed: result.validation.passed,
              confidenceScore: result.validation.confidenceScore,
            } : undefined,
          }).catch(() => {});
        }
```

And after the `emitStageFailed(...)` for empty output (around line 714):

```typescript
        // Dual-write: fail the execution
        const latestExecFail = await getLatestExecution(pipelineRunId, stageName);
        if (latestExecFail && latestExecFail.status === 'running') {
          await failStageExecution({ executionId: latestExecFail.id, errorMessage: `${stageName} chunked generation produced no output` }).catch(() => {});
        }
```

- [ ] **Step 4: Type-check**

Run:
```bash
pnpm --filter @revamp/api exec tsc --noEmit
```
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pipeline.ts
git commit -m "feat: dual-write stage executions in pipeline service completion paths"
```

---

### Task 5: Dual-write approvals and rejections

**Files:**
- Modify: `apps/api/src/services/pipeline-operations.ts`

- [ ] **Step 1: Add import**

Add at the top of `apps/api/src/services/pipeline-operations.ts`:

```typescript
import { setApprovalStatus } from "./stage-execution-repository.js";
```

- [ ] **Step 2: Dual-write in approveGate**

In the `approveGate` function, find the line (around line 105):
```typescript
    await updateStageProgress(pipelineRunId, stageName, "approved", 100, { conn: tx });
```

Add after it:

```typescript
    // Dual-write: approve the stage execution
    await setApprovalStatus(pipelineRunId, stageName, "approved", approvedBy, comment, tx);
```

- [ ] **Step 3: Dual-write in rejectGate**

In the `rejectGate` function, find the line (around line 132):
```typescript
    await updateStageProgress(pipelineRunId, stageName, "rejected", 0, { conn: tx });
```

Add after it:

```typescript
    // Dual-write: reject the stage execution
    await setApprovalStatus(pipelineRunId, stageName, "rejected", rejectedBy, reason, tx);
```

- [ ] **Step 4: Type-check**

Run:
```bash
pnpm --filter @revamp/api exec tsc --noEmit
```
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pipeline-operations.ts
git commit -m "feat: dual-write stage execution approvals and rejections"
```

---

### Task 6: Validation — verify dual-write works end-to-end

- [ ] **Step 1: Restart the API server**

```bash
lsof -iTCP:8787 -sTCP:LISTEN -P | awk 'NR>1{print $2}' | sort -u | xargs kill -9
sleep 1 && pnpm dev:api &
```

Wait for "Server listening on http://0.0.0.0:8787".

- [ ] **Step 2: Execute a stage through the UI**

Navigate to the pipeline page and execute Stage 1 (SCAN) or whichever stage is pending. Wait for it to complete.

- [ ] **Step 3: Verify the `stage_executions` table has data**

```bash
psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -c "
SELECT id, pipeline_run_id, stage_name, version, status,
       started_at, completed_at, approval_status,
       output_length, input_refs,
       LEFT(model, 30) as model
FROM stage_executions
ORDER BY created_at DESC
LIMIT 5;
"
```

Expected: At least one row with:
- `status` = `completed` (or `approved` if auto-approved)
- `started_at` and `completed_at` both non-null
- `output_length` > 0
- `input_refs` = `{}` for SCAN, or has entries for later stages
- `version` = 1

- [ ] **Step 4: Approve the stage and verify dual-write**

Approve the stage in the UI, then:

```bash
psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -c "
SELECT id, stage_name, version, status, approval_status, approved_at
FROM stage_executions
ORDER BY created_at DESC
LIMIT 3;
"
```

Expected: `approval_status` = `approved`, `status` = `approved`, `approved_at` non-null.

- [ ] **Step 5: Re-run the stage and verify versioning**

Re-run the same stage, then:

```bash
psql "postgresql://revamp:revamp_local_dev@127.0.0.1:5432/revamp" -c "
SELECT stage_name, version, status, approval_status
FROM stage_executions
WHERE pipeline_run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1)
ORDER BY stage_name, version;
"
```

Expected: Two rows for the same stage — version 1 (approved) and version 2 (completed or running).

- [ ] **Step 6: Commit validation notes**

No code to commit — this is a verification step. If everything passes, Phase 1 is complete. If issues are found, fix them in the relevant tasks above and re-verify.
