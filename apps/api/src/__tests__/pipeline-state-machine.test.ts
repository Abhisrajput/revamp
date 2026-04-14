/**
 * Tests for pipeline stage ordering, prerequisites, and state transitions.
 *
 * These validate the business logic that determines:
 *   - Can a stage be executed? (prerequisite check)
 *   - What stages require approval?
 *   - Is stage ordering enforced correctly?
 *
 * Uses shared-types as the single source of truth for stage definitions.
 */
import { describe, it, expect } from "vitest";
import {
  PipelineStageName,
  PIPELINE_STAGE_ORDER,
  STAGE_DISPLAY_LABELS,
  STAGES_REQUIRING_APPROVAL,
  stageRequiresApproval,
} from "@revamp/shared-types";

describe("Pipeline Stage Definitions", () => {
  it("should define exactly 8 stages", () => {
    expect(PIPELINE_STAGE_ORDER).toHaveLength(8);
  });

  it("should have correct stage order", () => {
    expect(PIPELINE_STAGE_ORDER).toEqual([
      PipelineStageName.SCAN,
      PipelineStageName.DECODE,
      PipelineStageName.BLUEPRINT,
      PipelineStageName.SPEC_LOCK,
      PipelineStageName.ARCHITECT,
      PipelineStageName.FORGE,
      PipelineStageName.SHADOW_RUN,
      PipelineStageName.EVOLVE,
    ]);
  });

  it("should have display labels for every stage", () => {
    for (const stage of PIPELINE_STAGE_ORDER) {
      expect(STAGE_DISPLAY_LABELS[stage]).toBeDefined();
      expect(STAGE_DISPLAY_LABELS[stage].length).toBeGreaterThan(0);
    }
  });

  it("should require approval for all stages", () => {
    // Current policy: every stage requires human review
    for (const stage of PIPELINE_STAGE_ORDER) {
      expect(stageRequiresApproval(stage)).toBe(true);
    }
  });

  it("stageRequiresApproval should return false for unknown stages", () => {
    expect(stageRequiresApproval("NONEXISTENT")).toBe(false);
  });

  it("STAGES_REQUIRING_APPROVAL should match PIPELINE_STAGE_ORDER", () => {
    // All stages require approval — the two sets should be identical
    for (const stage of PIPELINE_STAGE_ORDER) {
      expect(STAGES_REQUIRING_APPROVAL.has(stage)).toBe(true);
    }
    expect(STAGES_REQUIRING_APPROVAL.size).toBe(PIPELINE_STAGE_ORDER.length);
  });
});

describe("Stage Prerequisite Logic", () => {
  // Simulate the prerequisite check from pipeline route
  function canExecuteStage(
    stageProgress: Record<string, { status?: string }>,
    targetStage: PipelineStageName,
  ): { allowed: boolean; reason?: string } {
    const targetIdx = PIPELINE_STAGE_ORDER.indexOf(targetStage);
    if (targetIdx === 0) return { allowed: true };

    for (let i = 0; i < targetIdx; i++) {
      const priorStage = PIPELINE_STAGE_ORDER[i];
      const priorStatus = stageProgress[priorStage]?.status;
      const doneStatuses = new Set(["approved", "skipped", "completed", "awaiting_approval"]);
      if (!doneStatuses.has(priorStatus || "")) {
        return {
          allowed: false,
          reason: `${priorStage} must be completed first (status: ${priorStatus || "pending"})`,
        };
      }
    }
    return { allowed: true };
  }

  it("SCAN can always execute (no prerequisites)", () => {
    const result = canExecuteStage({}, PipelineStageName.SCAN);
    expect(result.allowed).toBe(true);
  });

  it("DECODE requires SCAN to be completed", () => {
    const noScan = canExecuteStage({}, PipelineStageName.DECODE);
    expect(noScan.allowed).toBe(false);
    expect(noScan.reason).toContain("SCAN");

    const scanDone = canExecuteStage(
      { SCAN: { status: "completed" } },
      PipelineStageName.DECODE,
    );
    expect(scanDone.allowed).toBe(true);
  });

  it("FORGE requires all 5 prior stages completed", () => {
    const partial = canExecuteStage(
      {
        SCAN: { status: "approved" },
        DECODE: { status: "approved" },
        BLUEPRINT: { status: "approved" },
        // SPEC_LOCK missing
      },
      PipelineStageName.FORGE,
    );
    expect(partial.allowed).toBe(false);
    expect(partial.reason).toContain("SPEC_LOCK");
  });

  it("should accept awaiting_approval as a done status", () => {
    // Approval is a review gate, not an execution gate (matches legacy-bridge)
    const result = canExecuteStage(
      { SCAN: { status: "awaiting_approval" } },
      PipelineStageName.DECODE,
    );
    expect(result.allowed).toBe(true);
  });

  it("should reject in_progress as a done status", () => {
    const result = canExecuteStage(
      { SCAN: { status: "in_progress" } },
      PipelineStageName.DECODE,
    );
    expect(result.allowed).toBe(false);
  });
});

describe("Preset Template Stage Keys", () => {
  it("preset templates should use stage name keys, not numeric indices", async () => {
    const { PRESET_TEMPLATES, DEFAULT_STAGE_PROMPTS } = await import("@revamp/core-engine");

    for (const template of PRESET_TEMPLATES) {
      const keys = Object.keys(template.prompts);
      // All keys should be valid stage names
      for (const key of keys) {
        expect(
          PIPELINE_STAGE_ORDER.includes(key as PipelineStageName),
          `Template "${template.id}" has invalid key "${key}" — expected a stage name`,
        ).toBe(true);
      }
      // No numeric keys
      for (const key of keys) {
        expect(
          /^\d+$/.test(key),
          `Template "${template.id}" still has numeric key "${key}"`,
        ).toBe(false);
      }
    }

    // Same check for default prompts
    const defaultKeys = Object.keys(DEFAULT_STAGE_PROMPTS);
    for (const key of defaultKeys) {
      expect(
        PIPELINE_STAGE_ORDER.includes(key as PipelineStageName),
        `DEFAULT_STAGE_PROMPTS has invalid key "${key}"`,
      ).toBe(true);
    }
  });

  it("BLUEPRINT prompt should describe capability mapping, not BDD", async () => {
    const { DEFAULT_STAGE_PROMPTS } = await import("@revamp/core-engine");
    const blueprint = DEFAULT_STAGE_PROMPTS["BLUEPRINT"];

    expect(blueprint).toBeDefined();
    // BLUEPRINT should talk about capabilities, not BDD scenarios
    const lower = blueprint.toLowerCase();
    expect(lower).toContain("capability");
    // Should NOT be dominated by BDD language
    expect(lower).not.toMatch(/^you are a qa/); // QA is SPEC_LOCK's job
  });

  it("SPEC_LOCK prompt should describe BDD specs, not capabilities", async () => {
    const { DEFAULT_STAGE_PROMPTS } = await import("@revamp/core-engine");
    const specLock = DEFAULT_STAGE_PROMPTS["SPEC_LOCK"];

    expect(specLock).toBeDefined();
    const lower = specLock.toLowerCase();
    // SPEC_LOCK should talk about BDD, scenarios, Gherkin
    expect(lower).toMatch(/bdd|scenario|gherkin|behavior/);
  });
});
