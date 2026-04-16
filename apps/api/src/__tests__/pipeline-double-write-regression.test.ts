import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture inserted rows per table
const insertedRows = vi.hoisted(() => ({
  llm_usage: [] as any[],
  cost_events: [] as any[],
}));

const insertValuesMock = vi.hoisted(() =>
  vi.fn(async (row: any) => {
    const tableName = (insertValuesMock as any).__lastTable;
    if (insertedRows[tableName as keyof typeof insertedRows]) {
      insertedRows[tableName as keyof typeof insertedRows].push(row);
    }
  }),
);

const insertMock = vi.hoisted(() =>
  vi.fn((table: any) => {
    (insertValuesMock as any).__lastTable = table.__name;
    return { values: insertValuesMock };
  }),
);

vi.mock("@/db/index.js", () => ({ db: { insert: insertMock } }));
vi.mock("@/db/schema.js", () => ({
  llmUsage: { __name: "llm_usage" },
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
    insertedRows.llm_usage.length = 0;
    insertedRows.cost_events.length = 0;
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

  it("two separate stage executions yield exactly two rows in each table (no aggregation bug)", async () => {
    await recordStageSpend({
      pipelineRunId: "run-1",
      projectId: "proj-1",
      stageName: PipelineStageName.SCAN,
      stageIndex: 1,
      model: "claude-sonnet-4",
      provider: "anthropic",
      tokens: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, cacheCreationTokens: 0 },
    });

    await recordStageSpend({
      pipelineRunId: "run-2",
      projectId: "proj-1",
      stageName: PipelineStageName.DECODE,
      stageIndex: 2,
      model: "claude-sonnet-4",
      provider: "anthropic",
      tokens: { inputTokens: 200, outputTokens: 100, cachedTokens: 0, cacheCreationTokens: 0 },
    });

    expect(insertedRows.llm_usage).toHaveLength(2);
    expect(insertedRows.cost_events).toHaveLength(2);
    expect(insertedRows.llm_usage.map((r) => r.pipeline_run_id)).toEqual(["run-1", "run-2"]);
  });
});
