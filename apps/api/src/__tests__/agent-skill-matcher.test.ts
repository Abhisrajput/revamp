/**
 * Tests for agent skill matching algorithm.
 */
import { describe, it, expect } from "vitest";
import { matchAgentToTask } from "@revamp/core-engine";
import type { AgentPersona } from "@revamp/shared-types/agent";

// ─── FIXTURES ──────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentPersona> = {}): AgentPersona {
  return {
    id: "test-agent-1",
    name: "Test Agent",
    slug: "test-agent",
    role: "specialist",
    department: "execution",
    status: "idle",
    pauseReason: null,
    systemPrompt: "You are a test agent.",
    skills: [
      {
        name: "Java Development",
        category: "code-transformation",
        proficiency: "advanced",
        keywords: ["java", "spring", "spring boot", "jvm"],
        weight: 1.0,
      },
      {
        name: "Legacy Analysis",
        category: "legacy-analysis",
        proficiency: "intermediate",
        keywords: ["cobol", "legacy", "mainframe"],
        weight: 0.8,
      },
    ],
    techStack: ["java", "spring boot", "postgresql"],
    legacyExpertise: ["cobol"],
    modernExpertise: ["java", "spring boot"],
    toolPermissions: ["read_file", "write_file", "search_code"],
    stagePermissions: ["forge", "evolve"],
    preferredProvider: "anthropic",
    preferredModel: "claude-sonnet-4-20250514",
    evaluatorModel: null,
    maxConcurrentTasks: 3,
    reportsTo: null,
    canDelegate: false,
    escalationTarget: null,
    monthlyBudgetCents: 10000,
    lifetimeBudgetCents: 100000,
    hardStopEnabled: true,
    warningThreshold: 0.8,
    spentMonthlyCents: 1000,
    sessionCompactionThreshold: 100000,
    memoryStrategy: "full",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hiddenAt: null,
    ...overrides,
  };
}

// ─── TESTS ─────────────────────────────────────────────────────

describe("Skill Matcher", () => {
  describe("matchAgentToTask", () => {
    it("returns empty array when no agents provided", () => {
      const result = matchAgentToTask(
        { keywords: ["java"], techStack: ["java"], stageName: "forge" },
        [],
      );
      expect(result).toEqual([]);
    });

    it("scores an agent with matching skills higher", () => {
      const javaAgent = makeAgent({
        id: "java-agent",
        name: "Java Developer",
        skills: [
          { name: "Java Dev", category: "code-transformation", proficiency: "expert", keywords: ["java", "spring"], weight: 1.0 },
        ],
        techStack: ["java", "spring boot"],
        stagePermissions: ["forge"],
      });

      const pythonAgent = makeAgent({
        id: "python-agent",
        name: "Python Developer",
        skills: [
          { name: "Python Dev", category: "code-transformation", proficiency: "expert", keywords: ["python", "fastapi"], weight: 1.0 },
        ],
        techStack: ["python", "fastapi"],
        stagePermissions: ["forge"],
      });

      const results = matchAgentToTask(
        { keywords: ["java", "spring"], techStack: ["java"], stageName: "forge" },
        [javaAgent, pythonAgent],
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].agent.id).toBe("java-agent");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("excludes hidden agents", () => {
      const agent = makeAgent({ hiddenAt: new Date().toISOString() });

      const results = matchAgentToTask(
        { keywords: ["java"], techStack: ["java"], stageName: "forge" },
        [agent],
      );

      expect(results).toEqual([]);
    });

    it("penalizes disabled/paused agents in availability", () => {
      const idle = makeAgent({ id: "idle", status: "idle" });
      const paused = makeAgent({ id: "paused", status: "paused" });

      const results = matchAgentToTask(
        { keywords: ["java"], techStack: ["java"], stageName: "forge" },
        [idle, paused],
      );

      const idleScore = results.find((r) => r.agent.id === "idle");
      const pausedScore = results.find((r) => r.agent.id === "paused");

      // Paused agent should either be excluded (score 0) or have lower score
      if (pausedScore) {
        expect(idleScore!.score).toBeGreaterThan(pausedScore.score);
      }
    });

    it("gives higher score when stage permission matches", () => {
      const permitted = makeAgent({ id: "permitted", stagePermissions: ["forge"] });
      const notPermitted = makeAgent({ id: "not-permitted", stagePermissions: ["scan", "decode"] });

      const results = matchAgentToTask(
        { keywords: ["java"], techStack: ["java"], stageName: "forge" },
        [permitted, notPermitted],
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      const permittedResult = results.find((r) => r.agent.id === "permitted");
      const notPermittedResult = results.find((r) => r.agent.id === "not-permitted");

      if (permittedResult && notPermittedResult) {
        expect(permittedResult.score).toBeGreaterThan(notPermittedResult.score);
      }
    });

    it("penalizes agents over budget", () => {
      const withinBudget = makeAgent({
        id: "within",
        monthlyBudgetCents: 10000,
        spentMonthlyCents: 1000,
        hardStopEnabled: true,
      });
      const overBudget = makeAgent({
        id: "over",
        monthlyBudgetCents: 10000,
        spentMonthlyCents: 10000,
        hardStopEnabled: true,
      });

      const results = matchAgentToTask(
        { keywords: ["java"], techStack: ["java"], stageName: "forge" },
        [withinBudget, overBudget],
      );

      const withinResult = results.find((r) => r.agent.id === "within");
      const overResult = results.find((r) => r.agent.id === "over");

      // Over-budget agent should be penalized or excluded
      if (withinResult && overResult) {
        expect(withinResult.score).toBeGreaterThan(overResult.score);
      }
    });

    it("results are sorted by score descending", () => {
      const agents = [
        makeAgent({ id: "a1", stagePermissions: [] }),
        makeAgent({ id: "a2", stagePermissions: ["forge"] }),
        makeAgent({ id: "a3", stagePermissions: ["forge"], techStack: ["java", "spring boot"] }),
      ];

      const results = matchAgentToTask(
        { keywords: ["java"], techStack: ["java"], stageName: "forge" },
        agents,
      );

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("provides reasons for match", () => {
      const agent = makeAgent({
        stagePermissions: ["forge"],
        techStack: ["java"],
      });

      const results = matchAgentToTask(
        { keywords: ["java"], techStack: ["java"], stageName: "forge" },
        [agent],
      );

      expect(results.length).toBe(1);
      expect(results[0].reasons.length).toBeGreaterThan(0);
      expect(results[0].reasons.some((r) => r.includes("Stage"))).toBe(true);
    });

    it("filters by minimum proficiency", () => {
      const intermediate = makeAgent({
        id: "intermediate",
        skills: [
          { name: "Java", category: "code-transformation", proficiency: "intermediate", keywords: ["java"], weight: 1.0 },
        ],
      });
      const expert = makeAgent({
        id: "expert",
        skills: [
          { name: "Java", category: "code-transformation", proficiency: "expert", keywords: ["java"], weight: 1.0 },
        ],
      });

      const results = matchAgentToTask(
        { keywords: ["java"], techStack: [], stageName: "forge", minProficiency: "expert" },
        [intermediate, expert],
      );

      // Only the expert should pass the proficiency filter
      const ids = results.map((r) => r.agent.id);
      expect(ids).toContain("expert");
      expect(ids).not.toContain("intermediate");
    });
  });
});
