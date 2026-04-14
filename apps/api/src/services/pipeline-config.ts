/**
 * Pipeline Configuration — stage definitions, utilities, and project config.
 *
 * Pure functions and constants. Zero database access, zero side effects.
 */

import { db } from "@/db/index.js";
import { pipelineRuns } from "@/db/schema.js";
import { eq } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { getStageOrder } from "@revamp/core-engine";
import { ValidationError } from "@/errors.js";

// ─── Stage Configuration ────────────────────────────────────────

export interface StageConfig {
  name: PipelineStageName;
  index: number;
  requiresApproval: boolean;
  requiredRole?: "architect" | "admin" | "sme";
  timeout: number; // ms
}

export const PIPELINE_STAGES: StageConfig[] = [
  { name: PipelineStageName.SCAN, index: 0, requiresApproval: true, timeout: 1800000 },
  { name: PipelineStageName.DECODE, index: 1, requiresApproval: true, timeout: 2400000 },
  { name: PipelineStageName.BLUEPRINT, index: 2, requiresApproval: true, requiredRole: "architect", timeout: 2400000 },
  { name: PipelineStageName.SPEC_LOCK, index: 3, requiresApproval: true, requiredRole: "architect", timeout: 3600000 },
  { name: PipelineStageName.ARCHITECT, index: 4, requiresApproval: true, requiredRole: "architect", timeout: 3600000 },
  { name: PipelineStageName.FORGE, index: 5, requiresApproval: true, timeout: 7200000 },
  { name: PipelineStageName.SHADOW_RUN, index: 6, requiresApproval: true, requiredRole: "admin", timeout: 3600000 },
  { name: PipelineStageName.EVOLVE, index: 7, requiresApproval: true, timeout: 1800000 },
];

export function getStageConfig(stage: PipelineStageName): StageConfig {
  const config = PIPELINE_STAGES.find((s) => s.name === stage);
  if (!config) throw new ValidationError(`Unknown stage: ${stage}`);
  return config;
}

export function getNextStage(currentStage: PipelineStageName): PipelineStageName | null {
  const order = getStageOrder();
  const idx = order.indexOf(currentStage);
  if (idx === -1 || idx === order.length - 1) return null;
  return order[idx + 1];
}

export function getPreviousStage(currentStage: PipelineStageName): PipelineStageName | null {
  const order = getStageOrder();
  const idx = order.indexOf(currentStage);
  if (idx <= 0) return null;
  return order[idx - 1];
}

// ─── Pipeline Run Lookup ─────────────────────────────────────────

export async function getPipelineRun(pipelineRunId: string) {
  return db.query.pipelineRuns.findFirst({
    where: eq(pipelineRuns.id, pipelineRunId),
    with: {
      project: true,
      artifacts: true,
      approvalGates: true,
    },
  });
}

// ─── Stage Disable/Skip ──────────────────────────────────────────

export interface ProjectStageConfig {
  disabled_stages?: Record<string, boolean>;
  stage_models?: Record<string, string>;
}

export function isStageDisabled(
  stageName: PipelineStageName,
  projectConfig: Record<string, unknown> | null | undefined,
): boolean {
  if (!projectConfig) return false;
  const disabledStages = (projectConfig.disabled_stages as Record<string, boolean>) ?? {};
  if (disabledStages[stageName] === true) return true;
  const settings = projectConfig.settings as Record<string, unknown> | undefined;
  if (settings) {
    const settingsDisabled = (settings.disabled_stages as Record<string, boolean>) ?? {};
    if (settingsDisabled[stageName] === true) return true;
  }
  return false;
}
