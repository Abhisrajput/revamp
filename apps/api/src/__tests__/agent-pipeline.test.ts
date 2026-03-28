/**
 * Tests for agent-pipeline integration helpers.
 *
 * Tests the stage keyword mapping and session data extractors.
 * DB-dependent functions are mocked.
 */
import { describe, it, expect, vi } from "vitest";

// Mock DB dependencies
vi.mock("@/db/index.js", () => ({
  db: {
    query: { agentPersonas: { findMany: vi.fn().mockResolvedValue([]) } },
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
  },
}));
vi.mock("@/db/schema.js", () => ({
  agentPersonas: { hidden_at: "hidden_at" },
  agentAssignments: {},
  agentSessions: {},
  costEvents: {},
  agentActivityLog: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("@/services/agent-department.js", () => ({
  assignTask: vi.fn(),
  checkoutTask: vi.fn(),
  completeTask: vi.fn(),
  recordCostEvent: vi.fn(),
  checkBudget: vi.fn().mockResolvedValue({ allowed: true, remaining: 9000 }),
}));
vi.mock("@/services/budget-enforcement.js", () => ({
  enforceBudget: vi.fn(),
}));
vi.mock("@/services/agent-sessions.js", () => ({
  buildSessionContext: vi.fn().mockResolvedValue({ contextSummary: "", totalTokens: 0, chainLength: 0 }),
  createSession: vi.fn(),
  compactSessionChain: vi.fn(),
}));

import { getStageKeywords } from "../services/agent-pipeline.js";

describe("Agent Pipeline Integration", () => {
  describe("getStageKeywords", () => {
    it("returns keywords for SCAN stage", () => {
      const keywords = getStageKeywords("SCAN");
      expect(keywords).toContain("legacy");
      expect(keywords).toContain("analysis");
      expect(keywords).toContain("scanning");
    });

    it("returns keywords for DECODE stage", () => {
      const keywords = getStageKeywords("DECODE");
      expect(keywords).toContain("business-rules");
      expect(keywords).toContain("cobol");
    });

    it("returns keywords for BLUEPRINT stage", () => {
      const keywords = getStageKeywords("BLUEPRINT");
      expect(keywords).toContain("architecture");
      expect(keywords).toContain("capability-map");
    });

    it("returns keywords for FORGE stage", () => {
      const keywords = getStageKeywords("FORGE");
      expect(keywords).toContain("code-generation");
      expect(keywords).toContain("transformation");
    });

    it("returns keywords for ARCHITECT stage", () => {
      const keywords = getStageKeywords("ARCHITECT");
      expect(keywords).toContain("microservices");
      expect(keywords).toContain("api");
    });

    it("returns empty array for unknown stage", () => {
      const keywords = getStageKeywords("nonexistent");
      expect(keywords).toEqual([]);
    });

    it("all known stages return at least 3 keywords", () => {
      const knownStages = ["SCAN", "DECODE", "BLUEPRINT", "SPEC_LOCK", "ARCHITECT", "FORGE", "SHADOW_RUN", "EVOLVE"];
      for (const stage of knownStages) {
        const keywords = getStageKeywords(stage);
        expect(keywords.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
