import { describe, it, expect, vi } from "vitest";

// Mock DB and external dependencies — estimateCostCents is pure, but the module
// imports db at module-level which requires DATABASE_URL at import time.
vi.mock("@/db/index.js", () => ({
  db: { query: {}, insert: vi.fn(), select: vi.fn(), execute: vi.fn(), update: vi.fn() },
}));
vi.mock("@/db/schema.js", () => ({
  pipelineRuns: {}, budgetPolicies: {}, budgetIncidents: {}, costEvents: {}, llmUsage: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), sql: vi.fn(), gte: vi.fn(),
}));

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
    // regular:     100k/1M × 300  =  30.0
    // output:      20k/1M × 1500  =  30.0
    // cache-read:  50k/1M × 30    =   1.5
    // cache-write: 400k/1M × 375  = 150.0
    // total = 211.5¢ → 212 after round
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
