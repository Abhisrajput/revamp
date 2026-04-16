import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  insertValuesMock,
  insertMock,
  dbMock,
  recordPipelineSpendMock,
  enforceProjectBudgetMock,
} = vi.hoisted(() => {
  const insertValuesMock = vi.fn(async () => {});
  const insertMock       = vi.fn(() => ({ values: insertValuesMock }));
  const dbMock           = { insert: insertMock };

  const recordPipelineSpendMock = vi.fn(async () => {});
  const enforceProjectBudgetMock = vi.fn(async () => {});

  return { insertValuesMock, insertMock, dbMock, recordPipelineSpendMock, enforceProjectBudgetMock };
});

vi.mock("@/db/index.js", () => ({ db: dbMock }));
vi.mock("@/db/schema.js", () => ({
  llmUsage:   { __table: "llm_usage" },
  costEvents: { __table: "cost_events" },
}));
vi.mock("@/services/pipeline-budget.js", () => ({
  estimateCostCents: (tokens: any, _model: string) => {
    // deterministic fixture for tests: 1¢ per 1000 regular-input tokens,
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

    const usageEventArg = (onEvent.mock.calls as any[][])[0][0];
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
    const costEventsValues = (insertValuesMock.mock.calls as any[][])[1][0];
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
    const llmUsageValues = (insertValuesMock.mock.calls as any[][])[0][0];
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
