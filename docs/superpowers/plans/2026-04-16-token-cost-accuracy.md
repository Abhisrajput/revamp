# Token & Cost Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every estimation-based token count in the pipeline with the provider's reported actuals, apply correct 3-way cache pricing, dual-write to `llm_usage` + `cost_events`, and centralize recording in a single `recordStageSpend` helper.

**Architecture:** Each `LLMCallFn` accumulator grows to four fields (regular input, output, cache read, cache write). Orchestrators (SCAN/DECODE/FORGE) create a shared accumulator and pass it to every `createCallFn` they spawn, surfacing the total in `StageRunResult.tokenUsage`. A new module `pipeline-spend-recorder.ts` is the sole path that inserts into `llm_usage` and `cost_events`. Spec: `docs/superpowers/specs/2026-04-16-token-cost-accuracy-design.md`.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM + PostgreSQL, Anthropic SDK, Bedrock SDK, monorepo (`pnpm`, `turbo`).

**Context note on the "double-counting" defect:** On close inspection of `pipeline.ts`, the generic stage path is the only one that currently double-writes (estimation via `finalizeStageResult` + actuals via the `907-935` block). Orchestrated and chunked paths return early before `907-935`, so they are single-source but entirely estimation-based. The fix in this plan (delete estimation from `finalize`, route everything through `recordStageSpend`) addresses all three paths correctly.

---

## File Structure

### Create

- `apps/api/src/services/pipeline-spend-recorder.ts` — single recording helper
- `apps/api/src/__tests__/pipeline-spend-recorder.test.ts` — unit tests for the recorder
- `apps/api/src/db/migrations/<generated>_add_cache_creation_tokens_to_cost_events.sql` — Drizzle migration
- `packages/core-engine/src/llm/__tests__/anthropic-cache-tokens.test.ts` — provider unit test
- `packages/core-engine/src/llm/__tests__/bedrock-cache-tokens.test.ts` — provider unit test
- `apps/api/src/__tests__/pipeline-double-write-regression.test.ts` — integration test

### Modify

- `packages/core-engine/src/llm/types.ts` — add `cache_creation_tokens` to `LLMResponse`; add `tokenUsage` optional to `StageRunResult`; extend `LLMCallFn.tokenUsage` shape contract
- `packages/core-engine/src/llm/anthropic.ts` — capture `cache_creation_input_tokens` in both streaming + non-streaming branches
- `packages/core-engine/src/llm/bedrock.ts` — same
- `apps/api/src/services/llm-proxy.ts` — propagate `cache_creation_tokens`; extend accumulator to 4 fields; optional external accumulator param
- `apps/api/src/db/schema.ts` — add `cache_creation_tokens` column to `cost_events`
- `apps/api/src/services/pipeline-budget.ts` — rewrite `estimateCostCents` signature + unit semantics; update `withPipelineBudget` to new signature
- `apps/api/src/services/scan-orchestrator.ts` — shared accumulator; populate `result.tokenUsage`
- `apps/api/src/services/decode-orchestrator.ts` — same
- `apps/api/src/services/forge-orchestrator.ts` — same
- `apps/api/src/services/pipeline.ts` — replace estimation blocks with recorder calls; add recorder calls after orchestrator returns
- `apps/api/src/services/pipeline-finalize.ts` — delete spend-recording block (96-121)

---

## Task 1: Extend `LLMResponse` type with `cache_creation_tokens`

**Files:**
- Modify: `packages/core-engine/src/llm/types.ts`

- [ ] **Step 1: Read the current type file**

Run: `sed -n '1,60p' packages/core-engine/src/llm/types.ts` to confirm the existing shape before editing.

- [ ] **Step 2: Add `cache_creation_tokens?: number` to `LLMResponse`**

Locate the `LLMResponse` interface (look for the existing `cached_tokens?: number` field) and add, immediately below it:

```typescript
  /** Tokens written to prompt cache this call (Anthropic: cache_creation_input_tokens). Priced at 1.25× base input. */
  cache_creation_tokens?: number;
```

- [ ] **Step 3: Add `cache_creation_tokens?: number` to any provider-response sub-type that already has `cached_tokens`**

Search within the same file for every occurrence of `cached_tokens?: number;` and add a sibling `cache_creation_tokens?: number;` to each (keep them grouped together for readability).

- [ ] **Step 4: Extend `StageRunResult` with optional `tokenUsage`**

Locate the `StageRunResult` interface. Add at the end:

```typescript
  /** Aggregated token usage across every LLM call made by this stage (including refinements and orchestrator sub-agents). Populated by orchestrators and by runStage. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  };
```

- [ ] **Step 5: Type-check core-engine**

Run: `pnpm --filter @revamp/core-engine type-check`
Expected: clean (no errors).

- [ ] **Step 6: Commit**

```bash
git add packages/core-engine/src/llm/types.ts
git commit -m "feat(core-engine): add cache_creation_tokens to LLMResponse, tokenUsage to StageRunResult"
```

---

## Task 2: Anthropic provider captures `cache_creation_input_tokens`

**Files:**
- Create: `packages/core-engine/src/llm/__tests__/anthropic-cache-tokens.test.ts`
- Modify: `packages/core-engine/src/llm/anthropic.ts`

- [ ] **Step 1: Scaffold the test file**

Create `packages/core-engine/src/llm/__tests__/anthropic-cache-tokens.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK before importing the provider
vi.mock("@anthropic-ai/sdk", () => {
  const create = vi.fn();
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create, stream: create },
  }));
  return { default: Anthropic, Anthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../anthropic.js";

describe("AnthropicProvider — cache_creation_tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("non-streaming: populates cache_creation_tokens from response.usage", async () => {
    const mockCreate = (new (Anthropic as any)()).messages.create as ReturnType<typeof vi.fn>;
    mockCreate.mockResolvedValueOnce({
      id: "msg_1",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 50,
      },
    });

    const provider = new AnthropicProvider({ apiKey: "test" });
    const response = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4",
      max_tokens: 100,
    });

    expect(response.cache_creation_tokens).toBe(400);
    expect(response.cached_tokens).toBe(50);
    expect(response.input_tokens).toBe(100);
    expect(response.output_tokens).toBe(20);
  });

  it("non-streaming: defaults cache_creation_tokens to 0 when absent", async () => {
    const mockCreate = (new (Anthropic as any)()).messages.create as ReturnType<typeof vi.fn>;
    mockCreate.mockResolvedValueOnce({
      id: "msg_2",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new AnthropicProvider({ apiKey: "test" });
    const response = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4",
      max_tokens: 100,
    });

    expect(response.cache_creation_tokens).toBe(0);
    expect(response.cached_tokens).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @revamp/core-engine test -- anthropic-cache-tokens`
Expected: FAIL — the provider does not yet return `cache_creation_tokens`, so the assertions miss.

Note: if the existing mocking pattern in the repo's other `llm/__tests__/*.test.ts` differs from the scaffold above, align this test to the established pattern before running — a `Read packages/core-engine/src/llm/__tests__` listing will surface the convention. If no tests exist yet in `packages/core-engine/src/llm/__tests__`, verify vitest is wired to pick files up from `packages/core-engine/src/**/__tests__/*.test.ts` via `packages/core-engine/vitest.config.ts` or the package's `test` script — adjust the file location to match before running.

- [ ] **Step 3: Add `cache_creation_tokens` capture in `anthropic.ts`**

Open `packages/core-engine/src/llm/anthropic.ts`. Two sites need editing — the non-streaming completion path and the streaming path. Locate each existing line of the form:

```typescript
cached_tokens: (response.usage as any).cache_read_input_tokens || 0,
```

and add a sibling immediately below:

```typescript
cache_creation_tokens: (response.usage as any).cache_creation_input_tokens || 0,
```

For the streaming path, the `finalMessage.usage` object is the equivalent — add the same field alongside the existing `cached_tokens` line.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm --filter @revamp/core-engine test -- anthropic-cache-tokens`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-engine/src/llm/anthropic.ts packages/core-engine/src/llm/__tests__/anthropic-cache-tokens.test.ts
git commit -m "feat(core-engine): capture cache_creation_input_tokens from Anthropic responses"
```

---

## Task 3: Bedrock provider captures `cache_creation_input_tokens`

**Files:**
- Create: `packages/core-engine/src/llm/__tests__/bedrock-cache-tokens.test.ts`
- Modify: `packages/core-engine/src/llm/bedrock.ts`

- [ ] **Step 1: Scaffold the test**

Create `packages/core-engine/src/llm/__tests__/bedrock-cache-tokens.test.ts`. Mirror the shape of the Anthropic test from Task 2, but mock the Bedrock SDK client used in `bedrock.ts` (check the import at the top of `bedrock.ts` to see what needs mocking — typically `@anthropic-ai/bedrock-sdk`). Assert the same two cases: (a) populated `cache_creation_input_tokens` surfaces as `cache_creation_tokens` on the response; (b) missing field defaults to 0. Use response payload with the same `usage` shape as the Anthropic test — Bedrock's AnthropicCompletion passes it through unchanged.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @revamp/core-engine test -- bedrock-cache-tokens`
Expected: FAIL.

- [ ] **Step 3: Edit `bedrock.ts`**

Open `packages/core-engine/src/llm/bedrock.ts`. Locate each line:

```typescript
cached_tokens: (response.usage as any).cache_read_input_tokens || 0,
```

(There are two — non-streaming and streaming.) Add a sibling line on the next line in each location:

```typescript
cache_creation_tokens: (response.usage as any).cache_creation_input_tokens || 0,
```

- [ ] **Step 4: Run and verify pass**

Run: `pnpm --filter @revamp/core-engine test -- bedrock-cache-tokens`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core-engine/src/llm/bedrock.ts packages/core-engine/src/llm/__tests__/bedrock-cache-tokens.test.ts
git commit -m "feat(core-engine): capture cache_creation_input_tokens from Bedrock responses"
```

---

## Task 4: Build core-engine so API can resolve the new fields

**Files:** none modified (compilation only)

- [ ] **Step 1: Build core-engine**

Run: `pnpm --filter @revamp/core-engine build`
Expected: no TypeScript errors; `packages/core-engine/dist/` regenerated.

- [ ] **Step 2: Confirm the new field lands in the compiled `d.ts`**

Run: `grep -n "cache_creation_tokens" packages/core-engine/dist/llm/types.d.ts`
Expected: at least one match.

No commit — build artifacts are `.gitignore`d.

---

## Task 5: Extend `CompletionResponse` and `createCallFn` accumulator in llm-proxy.ts

**Files:**
- Modify: `apps/api/src/services/llm-proxy.ts`

This task has no new unit test because `llm-proxy.ts` is an integration-level adapter; Task 2/3 cover the underlying capture, and Task 6 covers the downstream consumer with a hand-calculated fixture.

- [ ] **Step 1: Add `cache_creation_tokens` to `CompletionResponse`**

Locate the `CompletionResponse` interface at the top of `llm-proxy.ts`. Add:

```typescript
  /** Tokens written to prompt cache this call (1.25× input pricing). */
  cache_creation_tokens?: number;
```

Place it immediately after the existing `cached_tokens?: number;` line.

- [ ] **Step 2: Pass the field through in `complete()` and `streamCompletion()`**

Locate each `return { ... }` block inside `complete()` and `streamCompletion()` that currently contains `cached_tokens: response.cached_tokens,`. Add a sibling:

```typescript
cache_creation_tokens: response.cache_creation_tokens,
```

- [ ] **Step 3: Extend `createCallFn` accumulator to four fields with optional external accumulator**

Locate the existing signature and body:

```typescript
createCallFn(options?: { model?: string; maxTokens?: number; credentials?: ProjectCredentials; advisor?: { enabled: boolean; model?: string; max_uses?: number } }): LLMCallFn & { tokenUsage: { inputTokens: number; outputTokens: number } } {
  const tokenUsage = { inputTokens: 0, outputTokens: 0 };
  ...
}
```

Replace with:

```typescript
export interface StageTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

createCallFn(options?: {
  model?: string;
  maxTokens?: number;
  credentials?: ProjectCredentials;
  advisor?: { enabled: boolean; model?: string; max_uses?: number };
  tokenUsage?: StageTokenUsage; // optional: share one accumulator across multiple callFns in the same stage
}): LLMCallFn & { tokenUsage: StageTokenUsage } {
  const tokenUsage = options?.tokenUsage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
  };
  // ... existing body unchanged except for accumulator increments below
}
```

Export `StageTokenUsage` at module top level (one export statement, placed near the existing interface exports).

- [ ] **Step 4: Update every accumulator write inside the function body**

Locate the two sites inside `createCallFn` that do:

```typescript
tokenUsage.inputTokens += response.input_tokens || 0;
tokenUsage.outputTokens += response.output_tokens || 0;
```

(One in the streaming branch, one in the non-streaming branch.) Replace each with:

```typescript
tokenUsage.inputTokens          += response.input_tokens          || 0;
tokenUsage.outputTokens         += response.output_tokens         || 0;
tokenUsage.cachedTokens         += response.cached_tokens         || 0;
tokenUsage.cacheCreationTokens  += response.cache_creation_tokens || 0;
```

- [ ] **Step 5: Type-check the API package**

Run: `pnpm --filter @revamp/api type-check`
Expected: at this point `pipeline.ts:911` still destructures only `{ inputTokens, outputTokens }` — that's fine because the new fields are additive. Clean type-check expected. If `type-check` surfaces any existing consumer that destructures the old accumulator, add the new fields with default 0 where necessary, but expect no changes needed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/llm-proxy.ts
git commit -m "feat(api): extend tokenUsage accumulator with cache read/creation fields; allow sharing across callFns"
```

---

## Task 6: Drizzle migration — add `cache_creation_tokens` to `cost_events`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/migrations/<generated>_add_cache_creation_tokens_to_cost_events.sql` (generated)

- [ ] **Step 1: Add the column to the schema**

In `apps/api/src/db/schema.ts`, locate the `costEvents` table definition (around line 765). Inside the columns block, add directly after the existing `cached_tokens` line:

```typescript
cache_creation_tokens: integer("cache_creation_tokens").notNull().default(0),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @revamp/api db:generate`
Expected: a new file appears in `apps/api/src/db/migrations/` with a filename ending `_add_cache_creation_tokens...` (Drizzle may pick a different suffix; check what landed). Open it and confirm it contains an `ALTER TABLE cost_events ADD COLUMN cache_creation_tokens integer NOT NULL DEFAULT 0;` statement.

- [ ] **Step 3: Apply the migration to the local database**

Run: `pnpm --filter @revamp/api db:migrate`
Expected: Drizzle reports the migration applied. Confirm with:

```bash
psql "$DATABASE_URL" -c "\d cost_events" | grep cache_creation_tokens
```

Expected: one row showing the new column with default 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/migrations/
git commit -m "feat(db): add cache_creation_tokens column to cost_events"
```

---

## Task 7: Rewrite `estimateCostCents` with object signature, 3-way pricing, integer cents

**Files:**
- Modify: `apps/api/src/services/pipeline-budget.ts`
- Create/modify: `apps/api/src/__tests__/pipeline-budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/pipeline-budget.test.ts` (or append to an existing file if present — check first with `ls apps/api/src/__tests__`):

```typescript
import { describe, it, expect } from "vitest";
import { estimateCostCents } from "@/services/pipeline-budget.js";

describe("estimateCostCents (4-way pricing)", () => {
  it("returns integer cents (not dollars)", () => {
    const result = estimateCostCents(
      { inputTokens: 1_000_000, outputTokens: 0 },
      "sonnet-4-6",
    );
    // Sonnet input: $3/M → 300¢ for 1M tokens
    expect(result).toBe(300);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("cache read priced at 0.1× input", () => {
    const result = estimateCostCents(
      { inputTokens: 0, outputTokens: 0, cachedTokens: 1_000_000 },
      "sonnet-4-6",
    );
    // $3/M × 0.1 = $0.30 = 30¢
    expect(result).toBe(30);
  });

  it("cache write priced at 1.25× input", () => {
    const result = estimateCostCents(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000 },
      "sonnet-4-6",
    );
    // $3/M × 1.25 = $3.75 = 375¢
    expect(result).toBe(375);
  });

  it("output uses output pricing", () => {
    const result = estimateCostCents(
      { inputTokens: 0, outputTokens: 1_000_000 },
      "sonnet-4-6",
    );
    // Sonnet output: $15/M = 1500¢
    expect(result).toBe(1500);
  });

  it("combined mix sums correctly (Sonnet)", () => {
    // 100k regular + 20k output + 50k cache read + 400k cache write
    // = 100k/1M × 300 + 20k/1M × 1500 + 50k/1M × 30 + 400k/1M × 375
    // = 30 + 30 + 1.5 + 150 = 211.5¢ → 212 after round
    const result = estimateCostCents(
      {
        inputTokens: 100_000,
        outputTokens: 20_000,
        cachedTokens: 50_000,
        cacheCreationTokens: 400_000,
      },
      "sonnet-4-6",
    );
    expect(result).toBe(212);
  });

  it("zero tokens returns 0", () => {
    expect(estimateCostCents({ inputTokens: 0, outputTokens: 0 }, "default")).toBe(0);
  });

  it("unknown model falls back to default pricing", () => {
    const r1 = estimateCostCents({ inputTokens: 1_000_000, outputTokens: 0 }, "model-that-does-not-exist");
    const r2 = estimateCostCents({ inputTokens: 1_000_000, outputTokens: 0 }, "default");
    expect(r1).toBe(r2);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @revamp/api test -- pipeline-budget`
Expected: FAIL — every case (old signature takes positional args, returns dollars).

- [ ] **Step 3: Rewrite `estimateCostCents`**

Open `apps/api/src/services/pipeline-budget.ts`. Locate the existing function (around lines 88-106). Replace it with:

```typescript
/**
 * Compute LLM cost in integer cents using Anthropic's 4-way pricing model:
 *   - regular input           × 1.0
 *   - cache_creation_tokens   × 1.25
 *   - cached_tokens (read)    × 0.1
 *   - output tokens           × output rate
 *
 * Returns integer cents (matches `cost_events.cost_cents` and `llm_usage.cost`).
 */
export function estimateCostCents(
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  },
  model: string = "default",
): number {
  const modelLower = model.toLowerCase();
  let pricing = MODEL_COST_PER_1M.default;
  for (const [key, cost] of Object.entries(MODEL_COST_PER_1M)) {
    if (key !== "default" && modelLower.includes(key)) {
      pricing = cost;
      break;
    }
  }

  const inputUsd        = (tokens.inputTokens                / 1_000_000) * pricing.input;
  const cacheWriteUsd   = ((tokens.cacheCreationTokens ?? 0) / 1_000_000) * pricing.input * 1.25;
  const cacheReadUsd    = ((tokens.cachedTokens        ?? 0) / 1_000_000) * pricing.input * 0.1;
  const outputUsd       = (tokens.outputTokens               / 1_000_000) * pricing.output;

  return Math.round((inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd) * 100); // USD → ¢
}
```

- [ ] **Step 4: Update in-file callers**

Still in `pipeline-budget.ts`, find `withPipelineBudget()` (around line 225). It currently calls `estimateCostCents(estimatedInputTokens, estimatedOutputTokens, model)` twice. Replace both with the object form:

```typescript
const estimatedCost = estimateCostCents(
  { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens },
  model,
);
```

and

```typescript
const actualCost = estimateCostCents(
  { inputTokens: estimatedInputTokens, outputTokens: actualOutputTokens },
  model,
);
```

- [ ] **Step 5: Update external callers (temporary — they'll be deleted in later tasks)**

There are three positional-args callers still in the codebase that would block the build:
- `pipeline.ts:681` (chunked estimation block — deleted in Task 9)
- `pipeline.ts:919` (generic estimation block — deleted in Task 8)
- `pipeline-finalize.ts:102` (estimation block — deleted in Task 11)

For *this* task, update each call site to the new object signature using the existing local variable names:

```typescript
// e.g. pipeline.ts:681
const cost = estimateCostCents(
  { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens },
  modelName,
);
```

These edits will be fully removed in Tasks 8/9/11 — the intent here is only to keep the build green between tasks.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @revamp/api test -- pipeline-budget`
Expected: PASS (all 7 cases).

Run: `pnpm --filter @revamp/api type-check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/pipeline-budget.ts apps/api/src/services/pipeline.ts apps/api/src/services/pipeline-finalize.ts apps/api/src/__tests__/pipeline-budget.test.ts
git commit -m "fix(api): estimateCostCents returns integer cents with 4-way pricing (regular/cache-write/cache-read/output)"
```

---

## Task 8: Write `pipeline-spend-recorder.ts` with unit tests (TDD)

**Files:**
- Create: `apps/api/src/services/pipeline-spend-recorder.ts`
- Create: `apps/api/src/__tests__/pipeline-spend-recorder.test.ts`

- [ ] **Step 1: Write the failing unit-test file**

Create `apps/api/src/__tests__/pipeline-spend-recorder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertValuesMock = vi.fn(async () => {});
const insertMock       = vi.fn(() => ({ values: insertValuesMock }));
const dbMock           = { insert: insertMock };

const recordPipelineSpendMock = vi.fn(async () => {});
const enforceProjectBudgetMock = vi.fn(async () => {});

vi.mock("@/db/index.js", () => ({ db: dbMock }));
vi.mock("@/db/schema.js", () => ({
  llmUsage:   { __table: "llm_usage" },
  costEvents: { __table: "cost_events" },
}));
vi.mock("@/services/pipeline-budget.js", () => ({
  estimateCostCents: (tokens: any, model: string) => {
    // deterministic fixture: 1¢ per 1000 regular-input tokens,
    // 0.1¢ per 1000 cache-read, 1.25¢ per 1000 cache-write, 2¢ per 1000 output
    return Math.round(
      tokens.inputTokens              / 1000 * 1 +
      (tokens.cachedTokens         ?? 0) / 1000 * 0.1 +
      (tokens.cacheCreationTokens  ?? 0) / 1000 * 1.25 +
      tokens.outputTokens             / 1000 * 2,
    );
  },
  recordPipelineSpend:   recordPipelineSpendMock,
  enforceProjectBudget:  enforceProjectBudgetMock,
}));

import { recordStageSpend } from "@/services/pipeline-spend-recorder.js";
import { PipelineStageName } from "@revamp/shared-types/pipeline";

const baseCtx = {
  pipelineRunId: "run-1",
  projectId: "proj-1",
  stageName: PipelineStageName.SCAN,
  stageIndex: 1,
  model: "claude-sonnet-4",
  provider: "anthropic",
  tokens: {
    inputTokens: 10_000,
    outputTokens: 2_000,
    cachedTokens: 5_000,
    cacheCreationTokens: 40_000,
  },
};

describe("recordStageSpend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes one llm_usage row, one cost_events row, and calls budget hooks on happy path", async () => {
    const onEvent = vi.fn();
    await recordStageSpend({ ...baseCtx, onEvent });

    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(recordPipelineSpendMock).toHaveBeenCalledTimes(1);
    expect(enforceProjectBudgetMock).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);

    const usageEventArg = onEvent.mock.calls[0][0];
    expect(usageEventArg.phase).toBe("usage");
    expect(usageEventArg.stageName).toBe(PipelineStageName.SCAN);
    expect(usageEventArg.data.cost).toBeGreaterThan(0);
  });

  it("short-circuits when all token counts are zero", async () => {
    await recordStageSpend({
      ...baseCtx,
      tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 },
    });

    expect(insertMock).not.toHaveBeenCalled();
    expect(recordPipelineSpendMock).not.toHaveBeenCalled();
    expect(enforceProjectBudgetMock).not.toHaveBeenCalled();
  });

  it("swallows DB errors without throwing", async () => {
    insertValuesMock.mockRejectedValueOnce(new Error("db offline"));
    await expect(recordStageSpend(baseCtx)).resolves.toBeUndefined();
  });

  it("swallows enforceProjectBudget errors without throwing", async () => {
    enforceProjectBudgetMock.mockRejectedValueOnce(new Error("budget service unavailable"));
    await expect(recordStageSpend(baseCtx)).resolves.toBeUndefined();
    // But main writes still happened
    expect(insertMock).toHaveBeenCalledTimes(2);
  });

  it("tolerates missing onEvent", async () => {
    await expect(
      recordStageSpend({ ...baseCtx, onEvent: undefined }),
    ).resolves.toBeUndefined();
  });

  it("passes correct field breakdown to cost_events insert", async () => {
    await recordStageSpend(baseCtx);
    // Second insert is cost_events (first is llm_usage)
    const costEventsValues = insertValuesMock.mock.calls[1][0];
    expect(costEventsValues).toMatchObject({
      pipeline_run_id: "run-1",
      project_id: "proj-1",
      provider: "anthropic",
      model: "claude-sonnet-4",
      stage_name: PipelineStageName.SCAN,
      input_tokens: 10_000,
      output_tokens: 2_000,
      cached_tokens: 5_000,
      cache_creation_tokens: 40_000,
    });
    expect(costEventsValues.cost_cents).toBeGreaterThan(0);
  });

  it("writes llm_usage with regular input only (not summed)", async () => {
    await recordStageSpend(baseCtx);
    const llmUsageValues = insertValuesMock.mock.calls[0][0];
    expect(llmUsageValues).toMatchObject({
      pipeline_run_id: "run-1",
      project_id: "proj-1",
      model: "claude-sonnet-4",
      input_tokens: 10_000,   // regular only — not 10_000 + 5_000 + 40_000
      output_tokens: 2_000,
    });
    expect(llmUsageValues.cost).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail (module not yet created)**

Run: `pnpm --filter @revamp/api test -- pipeline-spend-recorder`
Expected: FAIL — `Cannot find module '@/services/pipeline-spend-recorder.js'`.

- [ ] **Step 3: Create the recorder module**

Create `apps/api/src/services/pipeline-spend-recorder.ts`:

```typescript
/**
 * Pipeline Spend Recorder — single source of truth for LLM token + cost accounting.
 *
 * Writes one row to llm_usage (legacy schema) and one row to cost_events (with full
 * 4-way token breakdown and project-budget visibility). Calls per-run and per-project
 * budget hooks. Every error is logged and swallowed — accounting must never fail a stage.
 */

import { db } from "@/db/index.js";
import { llmUsage, costEvents } from "@/db/schema.js";
import {
  estimateCostCents,
  recordPipelineSpend,
  enforceProjectBudget,
} from "./pipeline-budget.js";
import type { OnStageEvent } from "@revamp/core-engine";
import type { PipelineStageName } from "@revamp/shared-types/pipeline";
import crypto from "crypto";

export interface StageSpendContext {
  pipelineRunId: string;
  projectId: string;
  stageName: PipelineStageName;
  stageIndex: number;
  model: string;
  provider: string;
  /** Free-form caller tag — typical values: "stage" (default), "chunked", "refinement", "scan-orchestration". */
  operation?: string;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  };
  onEvent?: OnStageEvent;
}

export async function recordStageSpend(ctx: StageSpendContext): Promise<void> {
  const { tokens } = ctx;
  const totalTokens =
    tokens.inputTokens + tokens.outputTokens + tokens.cachedTokens + tokens.cacheCreationTokens;
  if (totalTokens === 0) return;

  const costCents = estimateCostCents(tokens, ctx.model);

  // 1) llm_usage — legacy table, aggregates only
  try {
    await db.insert(llmUsage).values({
      id: crypto.randomUUID(),
      project_id: ctx.projectId,
      pipeline_run_id: ctx.pipelineRunId,
      model: ctx.model,
      input_tokens: tokens.inputTokens,   // regular input only (matches schema's historical semantics)
      output_tokens: tokens.outputTokens,
      cost: costCents,
    });
  } catch (err) {
    console.warn("[recordStageSpend] llm_usage insert failed:", err instanceof Error ? err.message : err);
  }

  // 2) cost_events — new source of truth for budgets
  try {
    await db.insert(costEvents).values({
      project_id: ctx.projectId,
      pipeline_run_id: ctx.pipelineRunId,
      provider: ctx.provider,
      model: ctx.model,
      input_tokens: tokens.inputTokens,
      output_tokens: tokens.outputTokens,
      cached_tokens: tokens.cachedTokens,
      cache_creation_tokens: tokens.cacheCreationTokens,
      cost_cents: costCents,
      stage_name: ctx.stageName,
      operation: ctx.operation ?? "stage",
    });
  } catch (err) {
    console.warn("[recordStageSpend] cost_events insert failed:", err instanceof Error ? err.message : err);
  }

  // 3) per-run counter
  try {
    await recordPipelineSpend(ctx.pipelineRunId, costCents);
  } catch (err) {
    console.warn("[recordStageSpend] recordPipelineSpend failed:", err instanceof Error ? err.message : err);
  }

  // 4) project-level budget incidents (non-fatal)
  try {
    await enforceProjectBudget(ctx.projectId);
  } catch (err) {
    console.warn("[recordStageSpend] enforceProjectBudget failed:", err instanceof Error ? err.message : err);
  }

  // 5) SSE / UI event
  try {
    ctx.onEvent?.({
      phase: "usage" as any,
      stageName: ctx.stageName,
      stageIndex: ctx.stageIndex,
      timestamp: new Date().toISOString(),
      data: {
        input_tokens: tokens.inputTokens,
        output_tokens: tokens.outputTokens,
        cached_tokens: tokens.cachedTokens,
        cache_creation_tokens: tokens.cacheCreationTokens,
        cost: costCents,
      },
    });
  } catch { /* non-fatal */ }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @revamp/api test -- pipeline-spend-recorder`
Expected: PASS (all 7 cases). If the DB-error or budget-error cases fail because the test expects no throw but the implementation catches one at a time, double-check that each try/catch block in the implementation is individually wrapped (as in the code above, not a single outer try/catch).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pipeline-spend-recorder.ts apps/api/src/__tests__/pipeline-spend-recorder.test.ts
git commit -m "feat(api): add pipeline-spend-recorder — single recording path for LLM token + cost accounting"
```

---

## Task 9: Rewire generic stage path to use the recorder

**Files:**
- Modify: `apps/api/src/services/pipeline.ts` (delete block at 907-935, add recorder call)

- [ ] **Step 1: Locate the block**

Re-read `pipeline.ts` around lines 900-940 to confirm the current structure. The block starts with `// Record pipeline-level spend from token usage.` and ends just after the `try { await enforceProjectBudget(...) } catch { /* non-fatal */ }` inside it.

- [ ] **Step 2: Replace the block with a single recorder call**

Replace the entire `try { ... } catch { ... }` block (currently lines 907-938) with:

```typescript
// Record pipeline spend — single recording path (see pipeline-spend-recorder.ts).
{
  const proxyTokens = (llmCallFn as any).tokenUsage as {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  } | undefined;
  if (proxyTokens) {
    const { resolveProviderName } = await import("./pipeline-spend-recorder-helpers.js");
    await recordStageSpend({
      pipelineRunId,
      projectId: run.project.id,
      stageName,
      stageIndex: stageConfig.index,
      model: modelName,
      provider: resolveProviderName(modelName),
      operation: "stage",
      tokens: proxyTokens,
      onEvent: options?.onEvent,
    });
  }
}
```

Add the import at the top of `pipeline.ts`:

```typescript
import { recordStageSpend } from "./pipeline-spend-recorder.js";
```

- [ ] **Step 3: Create the helper module for provider inference**

Create `apps/api/src/services/pipeline-spend-recorder-helpers.ts`:

```typescript
/**
 * Resolve a provider name from a model id. Used by recorder call sites that
 * don't already know which provider served a request.
 */
export function resolveProviderName(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.includes("anthropic") || m.includes("claude")) {
    // Bedrock IDs look like "us.anthropic.claude-sonnet-4-6..." — treat as bedrock when prefixed
    if (m.startsWith("us.") || m.startsWith("eu.") || m.startsWith("ap.") || m.includes("bedrock")) {
      return "bedrock";
    }
    return "anthropic";
  }
  if (m.includes("gpt") || m.includes("openai")) return "openai";
  if (m.includes("gemini") || m.includes("flash")) return "gemini";
  return "unknown";
}
```

No test file for this helper — it's trivial string matching and the behavior is covered implicitly when the recorder's `cost_events` rows are manually verified in Task 14.

- [ ] **Step 4: Type-check and run the existing test suite**

Run: `pnpm --filter @revamp/api type-check`
Expected: clean.

Run: `pnpm --filter @revamp/api test`
Expected: all existing tests plus the new recorder tests pass. If anything fails, investigate before proceeding.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pipeline.ts apps/api/src/services/pipeline-spend-recorder-helpers.ts
git commit -m "refactor(api): generic stage path records spend via pipeline-spend-recorder"
```

---

## Task 10: Rewire chunked stage path to use the recorder

**Files:**
- Modify: `apps/api/src/services/pipeline.ts` (replace block at 676-691)

The chunked runner (`runChunkedStage` in core-engine) already receives the orchestrator's `llmCallFn` by reference (pipeline.ts:643). Every chunk call + gap-fill call + composition call routes through the same closure, so `llmCallFn.tokenUsage` is authoritative after `runChunkedStage` returns. No core-engine changes are needed for the chunked path.

- [ ] **Step 1: Locate the block**

Re-read `pipeline.ts` lines 676-691 to confirm the exact structure (the estimation block under the chunked branch).

- [ ] **Step 2: Replace the block**

Replace the entire `try { ... } catch { /* non-fatal */ }` block at 676-691 with:

```typescript
// Record chunked-stage spend from llmCallFn.tokenUsage (same closure runChunkedStage uses internally).
{
  const proxyTokens = (llmCallFn as any).tokenUsage as {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  } | undefined;
  if (proxyTokens) {
    const { resolveProviderName } = await import("./pipeline-spend-recorder-helpers.js");
    await recordStageSpend({
      pipelineRunId,
      projectId: run.project.id,
      stageName,
      stageIndex: stageConfig.index,
      model: modelName,
      provider: resolveProviderName(modelName),
      operation: "chunked",
      tokens: proxyTokens,
      onEvent: options?.onEvent,
    });
  }
}
```

- [ ] **Step 3: Type-check and test**

Run: `pnpm --filter @revamp/api type-check && pnpm --filter @revamp/api test`
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/pipeline.ts
git commit -m "refactor(api): chunked stage path records spend via pipeline-spend-recorder"
```

---

## Task 11: Delete spend-recording block from `finalizeStageResult`

**Files:**
- Modify: `apps/api/src/services/pipeline-finalize.ts`

- [ ] **Step 1: Delete lines 95-121**

In `apps/api/src/services/pipeline-finalize.ts`, delete the entire block starting with the comment `// 3. Record token usage (estimated from content sizes)` down to and including the closing `} catch { /* non-fatal */ }`.

Renumber the surrounding step comments if you want — `// 4. Complete stage execution` becomes `// 3.`, etc. (not strictly required; clean diff is enough).

- [ ] **Step 2: Prune the unused imports**

At the top of `pipeline-finalize.ts`, delete:

```typescript
import {
  recordPipelineSpend,
  estimateCostCents,
} from "./pipeline-budget.js";
```

and also delete the `import { llmUsage } from "@/db/schema.js";` if it's no longer referenced — check whether the file uses `llmUsage` anywhere else first.

Also delete the unused `crypto` import if it's no longer used, but keep it if any remaining code in the file still uses `crypto.randomUUID()`.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @revamp/api type-check`
Expected: clean.

- [ ] **Step 4: Run all tests**

Run: `pnpm --filter @revamp/api test`
Expected: all pass. Existing tests that referenced `finalizeStageResult`'s DB-write behavior — if any — should be checked and updated if they asserted on the now-deleted write. Search for them first: `grep -rn "finalizeStageResult" apps/api/src/__tests__`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pipeline-finalize.ts
git commit -m "refactor(api): finalizeStageResult no longer records spend — that's the recorder's job"
```

---

## Task 12: SCAN orchestrator — shared accumulator and `result.tokenUsage`

**Files:**
- Modify: `apps/api/src/services/scan-orchestrator.ts`
- Modify: `apps/api/src/services/pipeline.ts` (add recorder call after orchestrator returns)

- [ ] **Step 1: Create the shared accumulator at the top of `orchestrateScanStage`**

In `scan-orchestrator.ts`, locate the function signature `export async function orchestrateScanStage(...)` (around line 129). Immediately after the opening brace and any early setup, add:

```typescript
const stageTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
};
```

- [ ] **Step 2: Pass the accumulator to every `createCallFn` call in the file**

Find every `llmProxyService.createCallFn({ ... })` in `scan-orchestrator.ts` (expected locations from the grep at plan time: lines 748, 778, 951, 1278, 1460, 1764 — verify with `grep -n "createCallFn" apps/api/src/services/scan-orchestrator.ts` before editing). For each call, add `tokenUsage: stageTokenUsage` to the options object:

```typescript
const scoutCallFn = llmProxyService.createCallFn({
  // ... existing options
  tokenUsage: stageTokenUsage,
});
```

- [ ] **Step 3: Populate `result.tokenUsage` before returning**

Find every `return` statement in `orchestrateScanStage` that returns a `StageRunResult` (most likely a single return near the end of the function). Immediately before the return, attach the accumulator:

```typescript
result.tokenUsage = stageTokenUsage;
return result;
```

If there are multiple return statements (e.g., early returns on error), attach to each one that returns a full `StageRunResult`.

- [ ] **Step 4: Add the recorder call in `pipeline.ts` after SCAN orchestrator returns**

In `pipeline.ts` around line 416, the current code calls `orchestrateScanStage` and then `finalizeStageResult`. Add a `recordStageSpend` call between them:

```typescript
const scanResult = await orchestrateScanStage({ ... });

// NEW — record spend before finalize
if (scanResult.tokenUsage) {
  const { resolveProviderName } = await import("./pipeline-spend-recorder-helpers.js");
  await recordStageSpend({
    pipelineRunId,
    projectId: run.project.id,
    stageName,
    stageIndex: stageConfig.index,
    model: modelName,
    provider: resolveProviderName(modelName),
    operation: "scan-orchestration",
    tokens: scanResult.tokenUsage,
    onEvent: options?.onEvent,
  });
}

await finalizeStageResult({ ... });
```

- [ ] **Step 5: Type-check and test**

Run: `pnpm --filter @revamp/api type-check && pnpm --filter @revamp/api test`
Expected: clean, all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scan-orchestrator.ts apps/api/src/services/pipeline.ts
git commit -m "feat(api): SCAN orchestrator aggregates tokenUsage; pipeline records SCAN spend via recorder"
```

---

## Task 13: DECODE orchestrator — shared accumulator and `result.tokenUsage`

**Files:**
- Modify: `apps/api/src/services/decode-orchestrator.ts`
- Modify: `apps/api/src/services/pipeline.ts` (add recorder call after DECODE returns)

- [ ] **Step 1: Mirror Task 12 steps 1-3 for `decode-orchestrator.ts`**

The `createCallFn` sites in DECODE are (at plan time) lines 464, 718, 843, 963, 1107 — verify with `grep -n "createCallFn" apps/api/src/services/decode-orchestrator.ts` before editing. Add the shared `stageTokenUsage` accumulator at the top of `orchestrateDecodeStage`, pass it to every `createCallFn`, attach it to `result.tokenUsage` before returning.

- [ ] **Step 2: Add the recorder call in `pipeline.ts` after DECODE orchestrator returns**

Around line 543 in `pipeline.ts`, after `orchestrateDecodeStage` returns and before `finalizeStageResult` is called:

```typescript
if (decodeResult.tokenUsage) {
  const { resolveProviderName } = await import("./pipeline-spend-recorder-helpers.js");
  await recordStageSpend({
    pipelineRunId,
    projectId: run.project.id,
    stageName,
    stageIndex: stageConfig.index,
    model: modelName,
    provider: resolveProviderName(modelName),
    operation: "decode-orchestration",
    tokens: decodeResult.tokenUsage,
    onEvent: options?.onEvent,
  });
}
```

- [ ] **Step 3: Type-check, test, commit**

```bash
pnpm --filter @revamp/api type-check && pnpm --filter @revamp/api test
```

```bash
git add apps/api/src/services/decode-orchestrator.ts apps/api/src/services/pipeline.ts
git commit -m "feat(api): DECODE orchestrator aggregates tokenUsage; pipeline records DECODE spend via recorder"
```

---

## Task 14: FORGE orchestrator — shared accumulator and `result.tokenUsage`

**Files:**
- Modify: `apps/api/src/services/forge-orchestrator.ts`
- Modify: `apps/api/src/services/pipeline.ts` (add recorder call after FORGE returns)

- [ ] **Step 1: Mirror Task 12 steps 1-3 for `forge-orchestrator.ts`**

FORGE's `createCallFn` sites are fewer — verify with `grep -n "createCallFn" apps/api/src/services/forge-orchestrator.ts` before editing. Follow the same pattern: shared accumulator, pass to every `createCallFn`, attach to `result.tokenUsage`.

- [ ] **Step 2: Add the recorder call in `pipeline.ts` after FORGE orchestrator returns**

Around line 567 in `pipeline.ts`, after `orchestrateForgeStage`:

```typescript
if (forgeResult.tokenUsage) {
  const { resolveProviderName } = await import("./pipeline-spend-recorder-helpers.js");
  await recordStageSpend({
    pipelineRunId,
    projectId: run.project.id,
    stageName,
    stageIndex: stageConfig.index,
    model: modelName,
    provider: resolveProviderName(modelName),
    operation: "forge-orchestration",
    tokens: forgeResult.tokenUsage,
    onEvent: options?.onEvent,
  });
}
```

- [ ] **Step 3: Type-check, test, commit**

```bash
pnpm --filter @revamp/api type-check && pnpm --filter @revamp/api test
```

```bash
git add apps/api/src/services/forge-orchestrator.ts apps/api/src/services/pipeline.ts
git commit -m "feat(api): FORGE orchestrator aggregates tokenUsage; pipeline records FORGE spend via recorder"
```

---

## Task 15: Double-write regression integration test

**Files:**
- Create: `apps/api/src/__tests__/pipeline-double-write-regression.test.ts`

This test asserts that after a single stage execution, `llm_usage` and `cost_events` each receive exactly one row. It's an integration test in spirit but mock-driven for isolation.

- [ ] **Step 1: Write the test**

Create `apps/api/src/__tests__/pipeline-double-write-regression.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertedRows: Record<string, any[]> = { llm_usage: [], cost_events: [] };
const insertValuesMock = vi.fn(async (row: any) => {
  // The tableName is stashed on the table object by the schema mock below
  const tableName = (insertValuesMock as any).__lastTable;
  insertedRows[tableName]?.push(row);
});
const insertMock = vi.fn((table: any) => {
  (insertValuesMock as any).__lastTable = table.__name;
  return { values: insertValuesMock };
});

vi.mock("@/db/index.js", () => ({ db: { insert: insertMock } }));
vi.mock("@/db/schema.js", () => ({
  llmUsage:   { __name: "llm_usage" },
  costEvents: { __name: "cost_events" },
}));

vi.mock("@/services/pipeline-budget.js", () => ({
  estimateCostCents: () => 42,
  recordPipelineSpend: vi.fn(async () => {}),
  enforceProjectBudget: vi.fn(async () => {}),
}));

import { recordStageSpend } from "@/services/pipeline-spend-recorder.js";
import { PipelineStageName } from "@revamp/shared-types/pipeline";

describe("pipeline double-write regression", () => {
  beforeEach(() => {
    insertedRows.llm_usage = [];
    insertedRows.cost_events = [];
    vi.clearAllMocks();
  });

  it("one stage execution yields exactly one llm_usage row and one cost_events row", async () => {
    await recordStageSpend({
      pipelineRunId: "run-abc",
      projectId: "proj-xyz",
      stageName: PipelineStageName.SCAN,
      stageIndex: 1,
      model: "claude-sonnet-4",
      provider: "anthropic",
      tokens: {
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      },
    });

    expect(insertedRows.llm_usage).toHaveLength(1);
    expect(insertedRows.cost_events).toHaveLength(1);
    expect(insertedRows.llm_usage[0].pipeline_run_id).toBe("run-abc");
    expect(insertedRows.cost_events[0].pipeline_run_id).toBe("run-abc");
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `pnpm --filter @revamp/api test -- pipeline-double-write-regression`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/pipeline-double-write-regression.test.ts
git commit -m "test(api): regression test asserting single llm_usage + cost_events write per stage"
```

---

## Task 16: End-to-end build verification and manual smoke test

**Files:** none modified.

- [ ] **Step 1: Full-monorepo build**

Run: `pnpm build`
Expected: every package builds cleanly. Investigate any error before proceeding.

- [ ] **Step 2: Full-monorepo type-check (belt & braces)**

Run: `pnpm type-check` (if defined at root) or `turbo type-check` — whichever the repo uses; otherwise run `pnpm --filter @revamp/api type-check && pnpm --filter @revamp/core-engine type-check`.
Expected: clean.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: every package's tests pass.

- [ ] **Step 4: Start the API and trigger a SCAN stage end-to-end**

Start the dev stack:

```bash
pnpm docker:dev    # postgres, redis, minio
pnpm dev:api       # Fastify on :8787
```

Trigger SCAN for a small test project (use an existing pipeline run or create one through the web app). Then verify:

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) AS n, SUM(cost) AS total_cents FROM llm_usage WHERE pipeline_run_id = '<run-id>';"
```
Expected: `n = 1` and `total_cents > 0`.

```bash
psql "$DATABASE_URL" -c "SELECT provider, stage_name, operation, input_tokens, output_tokens, cached_tokens, cache_creation_tokens, cost_cents FROM cost_events WHERE pipeline_run_id = '<run-id>';"
```
Expected: one row with non-zero tokens and `cost_cents > 0`. If the request hit the prompt cache, `cached_tokens > 0` too. If it populated the cache, `cache_creation_tokens > 0`.

- [ ] **Step 5: Trigger a generic stage (e.g., BLUEPRINT or ARCHITECT with few enough entities to skip chunking) and repeat the check**

Same queries — confirm `n = 1` for that run.

- [ ] **Step 6: Trigger a chunked stage (ARCHITECT with many entities) and repeat**

Same queries — confirm `n = 1` and `input_tokens != output_tokens` in `cost_events`.

- [ ] **Step 7: Deliberately exercise project-budget enforcement**

Set a tight project budget via the admin route or directly:

```bash
psql "$DATABASE_URL" -c "INSERT INTO budget_policies (scope_type, scope_id, limit_cents, window, hard_stop, active, warn_percent) VALUES ('project', '<project-id>', 5, 'lifetime', true, true, '0.8') ON CONFLICT DO NOTHING;"
```

Run a stage, then:

```bash
psql "$DATABASE_URL" -c "SELECT incident_type, current_spend_cents, limit_cents, percent_used FROM budget_incidents ORDER BY created_at DESC LIMIT 5;"
```
Expected: a new `warning` or `hard_stop` row that reflects the stage's spend. Clean up the test policy afterward:

```bash
psql "$DATABASE_URL" -c "DELETE FROM budget_policies WHERE scope_id = '<project-id>' AND limit_cents = 5;"
```

- [ ] **Step 8: Update the auto-memory**

Once all six manual checks are green, update memory to record the fix:

Edit `/Users/abhishek.singh/.claude/projects/-Users-abhishek-singh-LocalBin-abhishek2-singh-Revamp/memory/project_token_cost_bugs.md` — replace the contents with a short summary noting the issue is resolved, the spec + plan paths, and that `cost_events` is now the source of truth for project-level budget visibility.

Update the `MEMORY.md` index line for this entry accordingly.

- [ ] **Step 9: Final commit (if any lingering doc changes)**

```bash
git status
# Only commit if there are docs/memory updates or minor follow-ups
```

No code changes should remain uncommitted at this point.

---

## Execution Order Summary

1. Task 1 — types
2. Task 2 — Anthropic provider
3. Task 3 — Bedrock provider
4. Task 4 — build core-engine
5. Task 5 — llm-proxy accumulator
6. Task 6 — DB migration
7. Task 7 — `estimateCostCents` rewrite
8. Task 8 — recorder module (TDD)
9. Task 9 — generic path
10. Task 10 — chunked path
11. Task 11 — delete from finalize
12. Task 12 — SCAN orchestrator
13. Task 13 — DECODE orchestrator
14. Task 14 — FORGE orchestrator
15. Task 15 — regression test
16. Task 16 — build + manual verification

Tasks 2 and 3 are independent and can run in parallel on a multi-agent workflow; all others have sequential dependencies.
