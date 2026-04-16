/**
 * Pipeline Execution Context — assembles everything needed to run a stage.
 *
 * Builds: project context, file analysis, BREE data, ground truth,
 * agent matching, LLM call functions, BYOK credentials.
 *
 * This is the "common setup" extracted from the executeStage preamble.
 * Each stage handler receives this context and only adds its stage-specific logic.
 */

import { db } from "@/db/index.js";
import { stageArtifacts } from "@/db/schema.js";
import { NotFoundError } from "@/errors.js";
import { eq, and } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import type { ProjectContext, StageOutput, UserFeedback, LLMCallFn, OnStageEvent, OnDelta } from "@revamp/core-engine";
import type { AgentStageContext } from "./agent-pipeline.js";
import type { StageConfig } from "./pipeline-config.js";
import type { ProjectCredentials } from "./llm-proxy.js";
import {
  updateStageProgress,
  loadPriorStageOutputs,
  loadUserFeedback,
} from "./pipeline-repository.js";
import { resolveProjectCredentials } from "./pipeline-credentials.js";
import { getStageConfig, getPipelineRun, isStageDisabled } from "./pipeline-config.js";
import { llmProxyService } from "./llm-proxy.js";
import {
  matchAndAssignAgent,
  getStageKeywords,
} from "./agent-pipeline.js";
import {
  prepareAgentExecution,
  wrapReviewerWithAgent,
} from "./agent-execution.js";
import { pipelineEventBus } from "./pipeline-event-bus.js";

// ─── PROJECT ROW TYPE ──────────────────────────────────────────
// Drizzle's inferred type omits 10X-specific columns from the relation result.
interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  organization_id: string;
  repository_url: string | null;
  status: string;
  config: Record<string, unknown> | null;
  source_type: string | null;
  source_url: string | null;
  source_branch: string | null;
  source_languages: string[] | null;
  target_stack: string | null;
  target_cloud: string | null;
  stage_prompts: Record<string, string> | null;
  validation_prompts: Record<string, string> | null;
  settings: Record<string, unknown> | null;
  created_by: string;
  [key: string]: unknown;
}

// ─── CONTEXT TYPE ──────────────────────────────────────────────

/**
 * Everything a stage handler needs to execute.
 * Built by prepareStageExecution() from the pipeline run + project data.
 */
export interface StageExecutionContext {
  pipelineRunId: string;
  run: any;
  proj: ProjectRow;
  stageConfig: StageConfig;

  projectContext: ProjectContext & {
    stagePrompts?: Record<string, string>;
    validationPrompts?: Record<string, string>;
  };
  projectCredentials?: ProjectCredentials;

  priorOutputs: StageOutput[];
  trajectoryMeta: any;
  feedback: UserFeedback[];

  agentCtx: AgentStageContext | null;
  agentExec: Awaited<ReturnType<typeof prepareAgentExecution>> | null;

  llmCallFn: LLMCallFn;
  llmEvalFn: any;
  reviewerLlmCallFn: LLMCallFn | undefined;

  modelName: string;
  effectiveModel: string;
  maxTokens: number;
  promptOverride: string | undefined;

  onEvent?: OnStageEvent;
  onDelta?: OnDelta;
  signal?: AbortSignal;
  skipLlmEval?: boolean;

  templateVars: Record<string, string>;
}

// ─── OPTIONS ───────────────────────────────────────────────────

export interface ExecuteStageOptions {
  onEvent?: OnStageEvent;
  onDelta?: OnDelta;
  signal?: AbortSignal;
  skipLlmEval?: boolean;
  model?: string;
  composerModel?: string;
  evaluatorModel?: string;
  maxTokens?: number;
  promptOverride?: string;
  validationFeedback?: Array<{ name: string; passed: boolean; score: number; feedback: string; severity?: string }>;
}

// ─── ADVISOR CONFIG ────────────────────────────────────────────

const STAGE_ADVISOR_CONFIG: Partial<Record<PipelineStageName, { enabled: boolean; max_uses: number }>> = {
  [PipelineStageName.SCAN]:       { enabled: true,  max_uses: 3 },
  [PipelineStageName.DECODE]:     { enabled: true,  max_uses: 3 },
  [PipelineStageName.BLUEPRINT]:  { enabled: true,  max_uses: 2 },
  [PipelineStageName.SPEC_LOCK]:  { enabled: false, max_uses: 0 },
  [PipelineStageName.ARCHITECT]:  { enabled: true,  max_uses: 3 },
  [PipelineStageName.FORGE]:      { enabled: true,  max_uses: 5 },
  [PipelineStageName.SHADOW_RUN]: { enabled: false, max_uses: 0 },
  [PipelineStageName.EVOLVE]:     { enabled: true,  max_uses: 2 },
};

// ─── PREPARE ───────────────────────────────────────────────────

/**
 * Build the full execution context for a pipeline stage.
 *
 * Covers: run/project loading, project context, ground truth,
 * prior outputs, agent matching, LLM function creation, BYOK credentials.
 *
 * Returns `null` if the stage is disabled (caller should return a skipped result).
 */
export async function prepareStageExecution(
  pipelineRunId: string,
  stageName: PipelineStageName,
  templateVars: Record<string, string>,
  options?: ExecuteStageOptions,
): Promise<StageExecutionContext | null> {
  // ─── 1. Load run + project ────────────────────────────────────
  const run = await getPipelineRun(pipelineRunId);
  if (!run) throw new NotFoundError("Pipeline run not found");
  if (!run.project) throw new NotFoundError("Project not found for pipeline run");

  const stageConfig = getStageConfig(stageName);
  const proj = run.project as ProjectRow;

  // ─── 2. Check if stage is disabled ────────────────────────────
  if (isStageDisabled(stageName, proj.config)) {
    options?.onEvent?.({
      phase: 'completed',
      stageName,
      stageIndex: stageConfig.index,
      timestamp: new Date().toISOString(),
      data: { skipped: true, reason: 'Stage disabled in project configuration' },
    });
    await updateStageProgress(pipelineRunId, stageName, "skipped", 100);
    return null; // Caller handles the skipped result
  }

  // ─── 3. Emit stage started event ──────────────────────────────
  pipelineEventBus.fire({
    type: "stage.started",
    timestamp: new Date().toISOString(),
    pipelineRunId,
    projectId: run.project.id,
    stageName,
    data: { stageIndex: stageConfig.index },
  });

  // ─── 4. Build project context ─────────────────────────────────
  const projectContext: ProjectContext & { stagePrompts?: Record<string, string>; validationPrompts?: Record<string, string> } = {
    projectId: proj.id,
    projectName: proj.name,
    description: proj.description || "",
    codebaseSource: proj.source_url || proj.repository_url || "uploaded",
    sourceLanguages: proj.source_languages || ["unknown"],
    targetStack: proj.target_stack || "Java/Spring Boot",
    targetCloud: proj.target_cloud || undefined,
  };
  projectContext.stagePrompts = proj.stage_prompts || {};
  projectContext.validationPrompts = proj.validation_prompts || {};

  // ─── 5. Reload ground truth from SCAN artifact (stages 2-8) ──
  if (stageName !== PipelineStageName.SCAN) {
    try {
      const scanArtifact = await db.query.stageArtifacts.findFirst({
        where: and(
          eq(stageArtifacts.pipeline_run_id, pipelineRunId),
          eq(stageArtifacts.stage_name, 'SCAN'),
          eq(stageArtifacts.artifact_type, 'cloned_codebase'),
        ),
      });
      if (scanArtifact?.metadata) {
        const meta = scanArtifact.metadata as Record<string, unknown>;
        projectContext.fileAnalysis = {
          totalFiles: (meta.totalFiles as number) || 0,
          totalLines: (meta.totalLines as number) || 0,
          detectedLanguages: (meta.detectedLanguages as string[]) || [],
          frameworkVersions: (meta.frameworkVersions as any[]) || [],
          componentCounts: (meta.componentCounts as any[]) || [],
          migrationStats: (meta.migrationStats as any) || undefined,
          largestFiles: (meta.largestFiles as any[]) || [],
          filesByExtension: (meta.filesByExtension as Record<string, number>) || {},
          linesByExtension: (meta.linesByExtension as Record<string, number>) || {},
          directoryTree: '',
          keyFiles: [],
          codeSnippets: [],
        };
        if (scanArtifact.storage_path) {
          projectContext.codebasePath = scanArtifact.storage_path;
        }
      }
    } catch { /* non-fatal — stages still work without ground truth */ }
  }

  // ─── 6. Load prior stage outputs + feedback ───────────────────
  const { outputs: priorOutputs, trajectoryMeta } = await loadPriorStageOutputs(pipelineRunId, stageName);

  if (trajectoryMeta) {
    options?.onEvent?.({
      phase: 'context_retrieval',
      stageName,
      stageIndex: stageConfig.index,
      timestamp: new Date().toISOString(),
      data: trajectoryMeta,
    });
  }

  const feedback = await loadUserFeedback(pipelineRunId, stageConfig.index);
  await updateStageProgress(pipelineRunId, stageName, "in_progress", 0);

  // ─── 7. Agent matching ────────────────────────────────────────
  let agentCtx: AgentStageContext | null = null;
  try {
    const sourceLanguages = projectContext.sourceLanguages || [];
    const targetStack = projectContext.targetStack ? [projectContext.targetStack] : [];
    agentCtx = await matchAndAssignAgent(
      pipelineRunId,
      stageName,
      getStageKeywords(stageName),
      [...sourceLanguages, ...targetStack],
    );
    if (agentCtx) {
      options?.onEvent?.({
        phase: 'agent_assigned',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: { agentId: agentCtx.agentId, agentName: agentCtx.agentName, assignmentId: agentCtx.assignmentId },
      });
    }
  } catch (matchErr: unknown) {
    const errMsg = matchErr instanceof Error ? matchErr.message : String(matchErr);
    options?.onEvent?.({
      phase: 'agent_assigned',
      stageName,
      stageIndex: stageConfig.index,
      timestamp: new Date().toISOString(),
      data: { skipped: true, reason: `Agent matching failed: ${errMsg}` },
    });
  }

  // ─── 8. Prompt override resolution ────────────────────────────
  const stagePrompts = proj.stage_prompts || {};
  let promptOverride = options?.promptOverride
    || stagePrompts[stageName]
    || stagePrompts[String(stageConfig.index)]
    || undefined;

  // Append validation feedback from previous run
  if (options?.validationFeedback?.length) {
    const failedFindings = options.validationFeedback.filter(f => !f.passed);
    if (failedFindings.length > 0) {
      const feedbackBlock = failedFindings.map(f =>
        `- [${(f.severity || 'warning').toUpperCase()}] ${f.name}: ${f.feedback}`
      ).join('\n');
      promptOverride = (promptOverride || '') + `\n\n--- VALIDATION FEEDBACK FROM PREVIOUS RUN ---\nThe previous output had the following issues. Please address ALL of them in this run:\n${feedbackBlock}\n--- END VALIDATION FEEDBACK ---`;
    }
  }

  // ─── 9. LLM function creation ─────────────────────────────────
  const projectSettings = proj.settings as Record<string, unknown> | null;
  const modelName = options?.model || process.env.LLM_DEFAULT_MODEL || agentCtx?.preferredModel || "";
  const configuredMaxTokens = options?.maxTokens || (projectSettings?.maxTokens as number) || 32768;
  const projectCredentials = resolveProjectCredentials(projectSettings);

  // Advisor tool (Anthropic-only)
  const advisorEnabled = process.env.ADVISOR_ENABLED !== 'false';
  const stageAdvisor = advisorEnabled ? STAGE_ADVISOR_CONFIG[stageName] : undefined;
  const advisorConfig = stageAdvisor?.enabled ? {
    enabled: true,
    model: 'claude-opus-4-6',
    max_uses: stageAdvisor.max_uses,
  } : undefined;

  const effectiveModel = options?.composerModel || modelName;
  const skipAdvisor = /opus/i.test(effectiveModel);
  let llmCallFn: LLMCallFn = llmProxyService.createCallFn({
    maxTokens: configuredMaxTokens,
    model: effectiveModel,
    credentials: projectCredentials,
    advisor: skipAdvisor ? undefined : advisorConfig,
  });

  const llmEvalFn = options?.skipLlmEval
    ? undefined
    : llmProxyService.createEvalFn({ model: options?.evaluatorModel, credentials: projectCredentials });

  // Reviewer LLM (different from generator to avoid self-validation bias)
  let reviewerLlmCallFn: LLMCallFn | undefined;
  const wantedEvaluatorModel = options?.evaluatorModel || agentCtx?.evaluatorModel || process.env.LLM_EVALUATOR_MODEL;
  if (wantedEvaluatorModel) {
    const hasEvalModel = await llmProxyService.hasValidationModel();
    if (hasEvalModel) {
      reviewerLlmCallFn = llmProxyService.createCallFn({
        maxTokens: 2048,
        model: wantedEvaluatorModel,
        credentials: projectCredentials,
      });
    } else {
      options?.onEvent?.({
        phase: 'reviewing',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: { skipped: true, reason: `Evaluator model "${wantedEvaluatorModel}" not available — skipping reviewer step` },
      });
    }
  }

  // ─── 10. Agent execution bridge ───────────────────────────────
  let agentExec: Awaited<ReturnType<typeof prepareAgentExecution>> | null = null;
  if (agentCtx) {
    try {
      agentExec = await prepareAgentExecution({
        agentCtx,
        baseLlmCallFn: llmCallFn,
        stageIndex: stageConfig.index,
        pipelineRunId,
        signal: options?.signal,
      });
      llmCallFn = agentExec.llmCallFn;
      if (reviewerLlmCallFn) {
        reviewerLlmCallFn = wrapReviewerWithAgent(reviewerLlmCallFn, agentCtx);
      }
      options?.onEvent?.({
        phase: 'agent_assigned',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: {
          agentEnhanced: true,
          agentName: agentCtx.agentName,
          toolCount: agentExec.tools.length,
          hasSessionContext: !!agentCtx.sessionContext,
        },
      });
    } catch (agentExecErr: unknown) {
      const errMsg = agentExecErr instanceof Error ? agentExecErr.message : String(agentExecErr);
      options?.onEvent?.({
        phase: 'agent_assigned',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: { agentEnhanced: false, reason: `Agent execution setup failed: ${errMsg}` },
      });
    }
  }

  return {
    pipelineRunId,
    run,
    proj,
    stageConfig,
    projectContext,
    projectCredentials,
    priorOutputs,
    trajectoryMeta,
    feedback,
    agentCtx,
    agentExec,
    llmCallFn,
    llmEvalFn,
    reviewerLlmCallFn,
    modelName,
    effectiveModel,
    maxTokens: configuredMaxTokens,
    promptOverride,
    onEvent: options?.onEvent,
    onDelta: options?.onDelta,
    signal: options?.signal,
    skipLlmEval: options?.skipLlmEval,
    templateVars,
  };
}
