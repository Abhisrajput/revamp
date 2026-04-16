# Token & Cost Accuracy — Design

**Date:** 2026-04-16
**Status:** Draft — awaiting user review
**Scope:** Fix six distinct defects in pipeline LLM token counting and cost calculation. Populate `cost_events` from the pipeline so project-level budgets see pipeline spend.

---

## Problem Statement

Pipeline LLM usage and cost are inaccurate. Six defects are present:

1. **Double-counting.** For orchestrated stages (SCAN, DECODE, FORGE) two separate code paths insert into `llm_usage` for the same execution: `pipeline.ts:907-935` (from actuals) and `pipeline-finalize.ts:96-121` (from estimates). Every orchestrated stage is counted twice.
2. **Estimation used where actuals exist.** `pipeline-finalize.ts:97-100` computes tokens from `content.length / 4` instead of reading `llmCallFn.tokenUsage`, which already holds the real numbers returned by the LLM provider.
3. **Chunked generation: input tokens equal output tokens.** `pipeline.ts:678-679` uses `result.output.length / 4` for *both* input and output, producing identical (and incorrect) numbers on every chunked-generation run.
4. **Refinement tokens not written to the database.** The auto-refinement loop calls the same `llmCallFn`, which accumulates usage correctly into `tokenUsage`. The accumulator is read in `pipeline.ts:911`, so refinement tokens *are* captured there — however, the estimation-based sites (defects 2 and 3) are unaware of the accumulator and therefore drop the refinement volume. The fix is the same one that eliminates estimation: route every path through the accumulator.
5. **Cached-token discount ignored.** `llm-proxy.ts:374-375` accumulates only `inputTokens` and `outputTokens`. `cached_tokens` (Anthropic's `cache_read_input_tokens`) is captured on each response but never propagated into `tokenUsage`, so the ~90% cache-read discount is never applied to cost.
6. **Cache-creation tokens not captured anywhere.** Anthropic/Bedrock responses include `cache_creation_input_tokens` (priced at 1.25× regular input). Core-engine providers discard the field entirely. Cache writes are therefore mispriced at 1.0× — a silent undercharge.

Additionally, project-level budget policies aggregate from `cost_events` (`pipeline-budget.ts:274-279`), but the pipeline writes only to `llm_usage`. Pipeline spend is **invisible to project-budget enforcement**.

## Goals

- Every token count in `llm_usage` and `cost_events` comes from the LLM provider's reported usage, never from character-count heuristics.
- Exactly one `llm_usage` row and one `cost_events` row are written per stage execution.
- Cost is computed with Anthropic's actual pricing: regular input at 1.0×, cache creation at 1.25×, cache read at 0.1×, output at output-price.
- Project-level budget queries see pipeline spend.
- Accurate cost includes refinement calls automatically — no explicit refinement-tracking logic.

## Non-Goals

- Retiring `llm_usage`. The table stays; the six routes and queries that read it are unchanged.
- Backfilling historical `llm_usage` or `cost_events` rows. Past pipeline spend data is wrong; we accept that and move forward.
- Rewriting OpenAI or Gemini cache handling. Those providers don't expose prompt caching the same way; their `cache_creation_tokens` and `cached_tokens` stay at 0 and pricing is unaffected.
- Improving the pre-flight budget check (`withPipelineBudget`). Pre-flight has to estimate — it runs before the call returns — so it keeps the length-based approximation.
- Idempotency on stage retry. If a stage is retried at the orchestrator layer after partial success, the recorder may run twice. This matches current behavior. A unique-constraint gate on `stage_executions.id` is a future task.

---

## Architecture

Every LLM token and cost record flows through one function:

```
recordStageSpend(ctx) — apps/api/src/services/pipeline-spend-recorder.ts
```

Every stage handler (SCAN, DECODE, FORGE, generic, chunked) invokes it exactly once per stage execution. No other code in the pipeline layer inserts into `llm_usage` or `cost_events`.

The source of truth for token counts is `llmCallFn.tokenUsage` — the closure-scoped accumulator attached by `LLMProxyService.createCallFn()`. This accumulator already spans the initial call and every refinement retry because they share the same `LLMCallFn` closure. For chunked generation, the chunked runner exposes a matching accumulator that the recorder reads.

Contract: **the owner of the `llmCallFn` closure records spend.** That is the orchestrator (pipeline.ts stage handlers, SCAN/DECODE/FORGE runners). `finalizeStageResult` no longer records spend; it keeps its other responsibilities (artifact storage, approval gating, events, metrics).

Recorded cost is computed via `estimateCostCents()` (renamed semantics — returns actual cents, integer) using the four-way pricing breakdown.

### Deletions

- `pipeline-finalize.ts:96-121` — estimation block (removed entirely)
- `pipeline.ts:676-691` — chunked estimation block (replaced by `recordStageSpend` call)
- `pipeline.ts:907-935` — generic estimation block (replaced by `recordStageSpend` call)

### Additions

- `pipeline-spend-recorder.ts` — the new recorder module
- `recordStageSpend(...)` calls inside SCAN/DECODE/FORGE orchestrators (one per orchestrator, immediately before `finalizeStageResult`)

---

## Data Model

### `cost_events` — one new column

```typescript
cache_creation_tokens: integer("cache_creation_tokens").notNull().default(0),
```

A single Drizzle migration adds the column with default 0. Historical rows read as zero, which is semantically correct — we were not capturing the value before.

### `llm_usage` — no changes

The table remains for existing readers. The recorder writes one row per stage execution with aggregates (`input_tokens`, `output_tokens`, `cost`). The `cost` field carries the full, correct, 3-way-priced value; the token fields carry regular input and output only.

### `ChatResponse` (core-engine `llm/types.ts`)

```typescript
interface ChatResponse {
  // existing fields unchanged
  cached_tokens?: number;          // cache_read_input_tokens (unchanged)
  cache_creation_tokens?: number;  // NEW — cache_creation_input_tokens
}
```

### `CompletionResponse` (apps/api `llm-proxy.ts`)

```typescript
interface CompletionResponse {
  // existing fields unchanged
  cached_tokens?: number;
  cache_creation_tokens?: number;  // NEW
}
```

### `LLMCallFn.tokenUsage` accumulator

```typescript
tokenUsage: {
  inputTokens: number;          // regular input (non-cached)
  outputTokens: number;
  cachedTokens: number;         // cache read
  cacheCreationTokens: number;  // NEW — cache write
}
```

`createCallFn()` initializes all four to zero and increments on each response. Existing consumers that read only `inputTokens`/`outputTokens` continue to work; the new fields are additive.

---

## Pricing

Update `estimateCostCents()` in `apps/api/src/services/pipeline-budget.ts` to the object signature and correct unit semantics:

```typescript
export function estimateCostCents(
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;         // cache read, 0.1×
    cacheCreationTokens?: number;  // cache write, 1.25×
  },
  model: string = "default",
): number {
  const modelLower = model.toLowerCase();
  let pricing = MODEL_COST_PER_1M.default;
  for (const [key, cost] of Object.entries(MODEL_COST_PER_1M)) {
    if (key !== "default" && modelLower.includes(key)) { pricing = cost; break; }
  }
  const inputCost        = (tokens.inputTokens                / 1_000_000) * pricing.input;
  const cacheWriteCost   = ((tokens.cacheCreationTokens ?? 0) / 1_000_000) * pricing.input * 1.25;
  const cacheReadCost    = ((tokens.cachedTokens        ?? 0) / 1_000_000) * pricing.input * 0.1;
  const outputCost       = (tokens.outputTokens               / 1_000_000) * pricing.output;
  return Math.round((inputCost + cacheWriteCost + cacheReadCost + outputCost) * 100); // integer ¢
}
```

(Model-lookup loop is the existing logic, preserved verbatim — only the return value semantics and signature change.)

### Unit-semantics fix (in scope)

The current `estimateCostCents` is named "Cents" but returns dollars with four-decimal precision (`Math.round((...) * 10000) / 10000`). Every caller treats the return value as cents, and the downstream `cost` and `cost_cents` integer columns expect cents. The function's behavior contradicts its name and the schema. This work corrects it: the function returns integer cents, and all ~6 call sites are migrated to the new object signature in the same pass. Leaving the unit bug in place would force the new recorder to carry forward a latent arithmetic defect — unacceptable given the goal of trustworthy cost reporting.

### Model pricing table

`MODEL_COST_PER_1M` is unchanged. Input prices there already represent "base input"; the 1.25× and 0.1× multipliers are universal and hard-coded in `estimateCostCents`.

---

## Recorder Module

New file: `apps/api/src/services/pipeline-spend-recorder.ts`

```typescript
export interface StageSpendContext {
  pipelineRunId: string;
  projectId: string;
  stageName: PipelineStageName;
  stageIndex: number;
  model: string;
  provider: string;
  operation?: string;              // free-form caller-supplied tag — typical values: "stage" (default), "chunked", "refinement", "scan-orchestration"
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  };
  onEvent?: OnStageEvent;
}

export async function recordStageSpend(ctx: StageSpendContext): Promise<void>;
```

### Behavior, in order

1. Short-circuit if all four token counts are zero. No writes, no hooks. Idempotent no-op.
2. Compute `costCents = estimateCostCents(ctx.tokens, ctx.model)`.
3. Insert one row into `llm_usage` — `input_tokens` = regular input only, `output_tokens` as-is, `cost` = `costCents`.
4. Insert one row into `cost_events` — full four-way breakdown, `provider`, `stage_name`, `operation`.
5. `await recordPipelineSpend(pipelineRunId, costCents)` — per-run counter increment.
6. `await enforceProjectBudget(projectId)` — creates warning or hard-stop incidents if thresholds crossed. Non-fatal.
7. `onEvent?.({ phase: 'usage', stageName, stageIndex, timestamp, data: { ...tokens, cost: costCents } })` — SSE payload for live UI updates.

### Error handling

Each DB / budget operation is individually wrapped in a try/catch that logs and swallows. Isolating errors per operation is required so a `cost_events` write still succeeds even if the `llm_usage` write fails (and vice versa), and so budget-hook failures don't drop the actual ledger writes. Token-accounting failures must never fail a pipeline stage.

### Call sites

Exactly four places invoke `recordStageSpend`:

1. **Generic stage handler** — `pipeline.ts`, replaces the estimation block at 907-935. Reads `llmCallFn.tokenUsage`.
2. **Chunked stage handler** — `pipeline.ts`, replaces the estimation block at 676-691. The chunked runner is modified to expose its own `tokenUsage` (same shape).
3. **SCAN / DECODE / FORGE orchestrators** — each orchestrator adds one `recordStageSpend` call immediately before `finalizeStageResult`, reading its own `llmCallFn.tokenUsage`.
4. *(removed, not added)* `finalizeStageResult` — the estimation block at `pipeline-finalize.ts:96-121` is deleted. Finalize no longer owns spend recording.

---

## Provider Changes (core-engine)

### `llm/anthropic.ts` — two sites

Streaming and non-streaming. Both capture:

```typescript
const cacheCreationTokens = (response.usage as any).cache_creation_input_tokens || 0;
const cacheReadTokens     = (response.usage as any).cache_read_input_tokens     || 0;
return {
  ...,
  cached_tokens: cacheReadTokens,
  cache_creation_tokens: cacheCreationTokens,
};
```

Anthropic's `input_tokens` in the response *excludes* both cache categories, so the three input-type counters sum to the full input — the pricing math works out without double-counting.

### `llm/bedrock.ts` — two sites

Bedrock's AnthropicCompletion surfaces `cache_creation_input_tokens` identically. Same two-site edit.

### `llm/openai.ts`, `llm/gemini.ts`

No change. `cache_creation_tokens` returns 0, `cached_tokens` already returns 0, pricing is unaffected.

### `apps/api/src/services/llm-proxy.ts`

- `CompletionResponse` gains `cache_creation_tokens?: number`.
- `complete()` and `streamCompletion()` pass the field through (two one-line additions each).
- `createCallFn()` extends the `tokenUsage` closure to four fields and accumulates all four on both the streaming and non-streaming branches.

### Build sequencing

`core-engine` must be rebuilt before the API can pick up the new field:

```
pnpm --filter @revamp/core-engine build
```

The implementation plan enforces this as a dependency step.

---

## Testing

### Unit — `pipeline-spend-recorder.test.ts` (new)

- Happy path: four non-zero token counts → one `llm_usage` row, one `cost_events` row, `recordPipelineSpend` called once, `enforceProjectBudget` called once, usage event emitted.
- All zeros → no writes, no hooks.
- DB insert throws → error logged, function resolves without throwing.
- `onEvent` omitted → no throw.
- Hand-calculated cost fixture for Sonnet and Haiku with a 3-way token mix, asserted against the recorder output. Catches pricing regressions and unit drift.

### Unit — `pipeline-budget.test.ts` (expand if present, else new)

- `estimateCostCents` returns integer cents.
- Cache read priced at 0.1×, cache write at 1.25×, output at output-price.
- Unknown model falls back to `default` pricing.
- Zero token input returns 0.

### Unit — core-engine provider adapters

- `anthropic.test.ts` — response with `cache_creation_input_tokens` and `cache_read_input_tokens` populates both fields on `ChatResponse`.
- `bedrock.test.ts` — same.

### Integration — double-write regression

One test drives a stage end-to-end through a fake `llmCallFn` and asserts exactly one `llm_usage` row exists for the run after completion. Prevents future callers from re-introducing the defect.

### Manual verification before merge

- Run a real SCAN stage (smallest, cheapest). Query `cost_events` for the run and cross-check tokens against proxy logs.
- `SELECT COUNT(*) FROM llm_usage WHERE pipeline_run_id = '...'` equals the number of stages run, not 2×.
- Deliberately trip a project-budget threshold and confirm `budget_incidents` fires with pipeline spend contributing.

### Not in scope

- Load or performance tests. Recorder is strictly additive DB work and `cost_events` already has appropriate indexes.
- Historical backfill of either table.

---

## Risks and Open Questions

- **Chunked runner seam.** The chunked generation code in `pipeline.ts:~660` currently does not surface a `tokenUsage` accumulator. The implementation plan will locate the exact seam (likely `chunkedResult.tokenUsage` returned from the runner) and validate that the chunked runner's internal calls use a single `llmCallFn` closure so the accumulator captures all chunks plus any internal retries. If the runner uses multiple closures internally, the plan will aggregate them explicitly.
- **Stage-execution retry idempotency.** Knowingly deferred. A retry after partial success can double-record. Future work: unique constraint on `(stage_execution_id, operation)` in `cost_events`.
- **`cost` column in `llm_usage` was previously populated with a dollar-rounded-to-four-decimals number coerced to int — effectively 0 for sub-dollar costs.** After this fix every new row has an accurate integer-cent value. Dashboards reading that column will show a visible jump in totals for post-fix rows. That is expected and correct.
