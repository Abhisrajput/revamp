/**
 * Tests for agent execution bridge — pure function tests (no DB required).
 *
 * Tests system prompt building, tool filtering, and LLM call wrapping.
 * DB-dependent functions (prepareAgentExecution, executeAgentAssignment)
 * are tested via the integration test suite that runs against a real database.
 */
import { describe, it, expect, vi } from "vitest";

// We test the exported helpers by importing the module.
// Since the module has DB imports at the top, we mock them.
vi.mock("@/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    query: { agentPersonas: { findFirst: vi.fn() }, agentAssignments: { findFirst: vi.fn() } },
  },
}));
vi.mock("@/db/schema.js", () => ({
  agentPersonas: { id: "id", hidden_at: "hidden_at" },
  agentAssignments: { id: "id", status: "status" },
  agentActivityLog: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

import { wrapReviewerWithAgent } from "../services/agent-execution.js";
import { getToolsForStage } from "../services/agent-tools.js";
import type { AgentStageContext } from "../services/agent-pipeline.js";

// ─── FIXTURES ──────────────────────────────────────────────────

const mockAgentCtx: AgentStageContext = {
  agentId: "agent-123",
  agentName: "Legacy Analyzer",
  assignmentId: "assign-456",
  systemPrompt: "You are a legacy code analyst specializing in COBOL and mainframe systems.",
  preferredProvider: "anthropic",
  preferredModel: "claude-sonnet-4-20250514",
  evaluatorModel: null,
  toolPermissions: ["read_code", "search_code", "lsp_hover"],
  stagePermissions: ["scan", "decode"],
  sessionContext: "Findings: 47 COBOL programs identified; Decisions: Target Java/Spring Boot",
  evolutionContext: "",
};

// ─── TESTS ─────────────────────────────────────────────────────

describe("Agent Execution Bridge", () => {
  describe("wrapReviewerWithAgent", () => {
    it("injects agent context into reviewer's system prompt", async () => {
      const baseReviewer = vi.fn().mockResolvedValue("APPROVED");

      const wrappedReviewer = wrapReviewerWithAgent(baseReviewer, mockAgentCtx);

      await wrappedReviewer({
        systemPrompt: "Review this output.",
        userPrompt: "Generated content here...",
      });

      expect(baseReviewer).toHaveBeenCalledTimes(1);
      const call = baseReviewer.mock.calls[0][0];
      expect(call.systemPrompt).toContain("Legacy Analyzer");
      expect(call.systemPrompt).toContain("Review this output.");
      expect(call.userPrompt).toBe("Generated content here...");
    });

    it("includes session context in reviewer prompt when available", async () => {
      const baseReviewer = vi.fn().mockResolvedValue("APPROVED");

      const wrappedReviewer = wrapReviewerWithAgent(baseReviewer, mockAgentCtx);

      await wrappedReviewer({
        systemPrompt: "Review.",
        userPrompt: "Content.",
      });

      const call = baseReviewer.mock.calls[0][0];
      expect(call.systemPrompt).toContain("47 COBOL programs");
    });

    it("works without session context", async () => {
      const baseReviewer = vi.fn().mockResolvedValue("APPROVED");
      const ctxNoSession = { ...mockAgentCtx, sessionContext: "" };

      const wrappedReviewer = wrapReviewerWithAgent(baseReviewer, ctxNoSession);

      await wrappedReviewer({
        systemPrompt: "Review.",
        userPrompt: "Content.",
      });

      expect(baseReviewer).toHaveBeenCalledTimes(1);
    });
  });

  describe("Tool filtering for agent permissions", () => {
    it("read-only stage tools are returned for analysis stages", () => {
      const tools = getToolsForStage(0); // SCAN
      const names = tools.map((t) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("search_code");
      expect(names).not.toContain("write_file");
    });

    it("FORGE stage includes write tools", () => {
      const tools = getToolsForStage(5);
      const names = tools.map((t) => t.name);
      expect(names).toContain("write_file");
      expect(names).toContain("edit_file");
      expect(names).toContain("shell_exec");
    });
  });
});
