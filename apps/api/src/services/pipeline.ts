/**
 * Pipeline Service — manages 8-stage modernization pipeline lifecycle.
 *
 * Integrates:
 *   - core-engine stage runner (Generate → Validate → Refine loop)
 *   - LLM proxy service (Go orchestrator bridge)
 *   - Database persistence (Drizzle/PostgreSQL)
 *   - WebSocket/SSE events for real-time UI updates
 *   - BullMQ for async stage execution
 *
 * Architecture:
 *   Client → API Route → PipelineService.executeStage()
 *     → core-engine runStage() → LLM Proxy → Go Orchestrator → LLM Provider
 *     → Validation → Auto-refinement (if needed) → Store artifacts → Emit events
 */

import { db } from "@/db/index.js";
import { pipelineRuns, approvalGates, stageArtifacts, llmUsage, projects } from "@/db/schema.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import {
  runStage,
  type StageRunResult,
  type OnStageEvent,
  type OnDelta,
  type ProjectContext,
  type StageOutput,
  type UserFeedback,
  getStageOrder,
} from "@revamp/core-engine";
import { llmProxyService } from "./llm-proxy.js";
import {
  matchAndAssignAgent,
  recordAgentCompletion,
  getStageKeywords,
  type AgentStageContext,
} from "./agent-pipeline.js";
import {
  prepareAgentExecution,
  wrapReviewerWithAgent,
} from "./agent-execution.js";
import {
  generateTierSummaries,
  loadTieredPriorContext,
} from "./context-tiering.js";
import { orchestrateScanStage } from "./scan-orchestrator.js";
import { orchestrateDecodeStage, loadScanOutput } from "./decode-orchestrator.js";
import {
  checkPipelineBudget,
  recordPipelineSpend,
  estimateCostCents,
  PipelineBudgetExceededError,
} from "./pipeline-budget.js";
import {
  pipelineEventBus,
  emitStageCompleted,
  emitStageFailed,
  emitValidationFailed,
  emitMemoryExtracted,
  emitPipelineBudgetWarning,
} from "./pipeline-event-bus.js";

// ─── STAGE CONFIGURATION ────────────────────────────────────────

export interface StageConfig {
  name: PipelineStageName;
  index: number;
  requiresApproval: boolean;
  requiredRole?: "architect" | "admin" | "sme";
  timeout: number; // ms
}

// Every stage requires human review and approval before the next stage can execute.
// This ensures quality gates are enforced — no auto-progression.
const PIPELINE_STAGES: StageConfig[] = [
  { name: PipelineStageName.SCAN, index: 0, requiresApproval: true, timeout: 1800000 },
  { name: PipelineStageName.DECODE, index: 1, requiresApproval: true, timeout: 2400000 },
  { name: PipelineStageName.BLUEPRINT, index: 2, requiresApproval: true, requiredRole: "architect", timeout: 2400000 },
  { name: PipelineStageName.SPEC_LOCK, index: 3, requiresApproval: true, requiredRole: "architect", timeout: 3600000 },
  { name: PipelineStageName.ARCHITECT, index: 4, requiresApproval: true, requiredRole: "architect", timeout: 3600000 },
  { name: PipelineStageName.FORGE, index: 5, requiresApproval: true, timeout: 7200000 },
  { name: PipelineStageName.SHADOW_RUN, index: 6, requiresApproval: true, requiredRole: "admin", timeout: 3600000 },
  { name: PipelineStageName.EVOLVE, index: 7, requiresApproval: true, timeout: 1800000 },
];

// ─── STAGE DISABLE/SKIP ──────────────────────────────────────────
//
// Ported from legacy-bridge isStageDisabled() / skipStage() in useProjectStore.ts.
// Allows projects to skip specific pipeline stages via configuration.

export interface ProjectStageConfig {
  /** Map of stage name to enabled/disabled status. Missing = enabled. */
  disabled_stages?: Record<string, boolean>;
  /** Per-stage model overrides */
  stage_models?: Record<string, string>;
}

/**
 * Check if a pipeline stage is disabled for a project.
 * Reads from project.config.disabled_stages or project.settings.disabled_stages.
 */
export function isStageDisabled(
  stageName: PipelineStageName,
  projectConfig: Record<string, unknown> | null | undefined,
): boolean {
  if (!projectConfig) return false;

  // Check config.disabled_stages
  const disabledStages = (projectConfig.disabled_stages as Record<string, boolean>) ?? {};
  if (disabledStages[stageName] === true) return true;

  // Also check nested settings for backward compat
  const settings = projectConfig.settings as Record<string, unknown> | undefined;
  if (settings) {
    const settingsDisabled = (settings.disabled_stages as Record<string, boolean>) ?? {};
    if (settingsDisabled[stageName] === true) return true;
  }

  return false;
}

// ─── SERVICE ────────────────────────────────────────────────────

export class PipelineService {
  getStageConfig(stage: PipelineStageName): StageConfig {
    const config = PIPELINE_STAGES.find((s) => s.name === stage);
    if (!config) throw new Error(`Unknown stage: ${stage}`);
    return config;
  }

  getNextStage(currentStage: PipelineStageName): PipelineStageName | null {
    const order = getStageOrder();
    const idx = order.indexOf(currentStage);
    if (idx === -1 || idx === order.length - 1) return null;
    return order[idx + 1];
  }

  getPreviousStage(currentStage: PipelineStageName): PipelineStageName | null {
    const order = getStageOrder();
    const idx = order.indexOf(currentStage);
    if (idx <= 0) return null;
    return order[idx - 1];
  }

  async getPipelineRun(pipelineRunId: string) {
    return db.query.pipelineRuns.findFirst({
      where: eq(pipelineRuns.id, pipelineRunId),
      with: {
        project: true,
        artifacts: true,
        approvalGates: true,
      },
    });
  }

  /**
   * Create a new pipeline run for a project, or return existing active run.
   */
  async createRun(
    projectId: string,
    initiatedBy: string,
    options?: { budgetCents?: number },
  ): Promise<string> {
    // Return most recent existing run (prevents duplicate runs on page refresh)
    // Returns running/pending first, then completed — only creates new if none exist
    const existingRun = await db.query.pipelineRuns.findFirst({
      where: eq(pipelineRuns.project_id, projectId),
      orderBy: (table, { desc }) => [desc(table.started_at)],
    });

    if (existingRun) {
      return existingRun.id;
    }

    const runId = crypto.randomUUID();
    const stageProgress: Record<string, unknown> = {};

    for (const stage of PIPELINE_STAGES) {
      stageProgress[stage.name] = {
        status: stage.index === 0 ? "in_progress" : "pending",
        progress: 0,
      };
    }

    await db.insert(pipelineRuns).values({
      id: runId,
      project_id: projectId,
      initiated_by: initiatedBy,
      status: "running",
      current_stage: PipelineStageName.SCAN,
      stage_progress: stageProgress,
      budget_cents: options?.budgetCents ?? null,
      started_at: new Date(),
    });

    return runId;
  }

  /**
   * Execute a pipeline stage using the core-engine stage runner.
   *
   * This is the main integration point that wires:
   *   - Project context from DB
   *   - Prior stage outputs from DB
   *   - User feedback from approval history
   *   - LLM call/eval functions from proxy service
   *   - Real-time events via callbacks
   */
  async executeStage(
    pipelineRunId: string,
    stageName: PipelineStageName,
    templateVars: Record<string, string>,
    options?: {
      onEvent?: OnStageEvent;
      onDelta?: OnDelta;
      signal?: AbortSignal;
      skipLlmEval?: boolean;
      /** Override execution model */
      model?: string;
      /** Override evaluator model */
      evaluatorModel?: string;
    },
  ): Promise<StageRunResult> {
    const run = await this.getPipelineRun(pipelineRunId);
    if (!run) throw new Error("Pipeline run not found");
    if (!run.project) throw new Error("Project not found for pipeline run");

    const stageConfig = this.getStageConfig(stageName);

    // Check if stage is disabled in project config
    const projectConfig = (run.project as any).config as Record<string, unknown> | null;
    if (isStageDisabled(stageName, projectConfig)) {
      options?.onEvent?.({
        phase: 'completed',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: { skipped: true, reason: 'Stage disabled in project configuration' },
      });

      await this.updateStageProgress(pipelineRunId, stageName, "skipped", 100);

      return {
        stageName,
        stageIndex: stageConfig.index,
        output: '',
        validation: null,
        refinementCount: 0,
        duration: 0,
        phases: [],
        aborted: false,
      };
    }

    // Emit stage started event
    pipelineEventBus.fire({
      type: "stage.started",
      timestamp: new Date().toISOString(),
      pipelineRunId,
      projectId: run.project.id,
      stageName,
      data: { stageIndex: stageConfig.index },
    });

    // Build project context from DB
    const projectContext: ProjectContext = {
      projectId: run.project.id,
      projectName: run.project.name,
      description: run.project.description || "",
      codebaseSource: (run.project as any).source_url || (run.project as any).repository_url || "uploaded",
      sourceLanguages: ((run.project as any).source_languages as string[]) || ["unknown"],
      targetStack: ((run.project as any).target_stack as string) || "Java/Spring Boot",
      targetCloud: ((run.project as any).target_cloud as string) || undefined,
    };

    // For SCAN stage — run real file analysis on the codebase
    if (stageName === PipelineStageName.SCAN) {
      const sourceType = (run.project as any).source_type as string | undefined;
      const sourceUrl = (run.project as any).source_url || (run.project as any).repository_url;

      if (sourceType && sourceUrl) {
        const stageIdx = stageConfig.index;
        // Read access token from project settings (for private repos)
        const projectSettings = (run.project as any).settings as Record<string, unknown> | null;
        const accessToken = (projectSettings?.access_token as string) || undefined;
        try {
          options?.onEvent?.({
            phase: 'scanning_codebase',
            stageName,
            stageIndex: stageIdx,
            timestamp: new Date().toISOString(),
            data: { message: 'Analyzing codebase files...' },
          });
          const { analyzeCodebase } = await import('./file-analyzer.js');
          const fileAnalysis = await analyzeCodebase(
            sourceType,
            sourceUrl,
            (run.project as any).source_branch || (run.project as any).repository_branch || 'main',
            accessToken,
          );
          projectContext.fileAnalysis = fileAnalysis;

          // If detected languages are richer than what's in the DB, use them
          if (fileAnalysis.detectedLanguages.length > 0) {
            projectContext.sourceLanguages = fileAnalysis.detectedLanguages;
          }

          // Store the cloned codebase path as an artifact for future reference
          if (fileAnalysis.codebasePath) {
            projectContext.codebasePath = fileAnalysis.codebasePath;
            try {
              await db.insert(stageArtifacts).values({
                id: crypto.randomUUID(),
                pipeline_run_id: pipelineRunId,
                stage_name: stageName,
                artifact_type: 'cloned_codebase',
                storage_path: fileAnalysis.codebasePath,
                metadata: {
                  sourceType,
                  sourceUrl,
                  branch: (run.project as any).source_branch || 'main',
                  totalFiles: fileAnalysis.totalFiles,
                  totalLines: fileAnalysis.totalLines,
                  detectedLanguages: fileAnalysis.detectedLanguages,
                },
              });
            } catch (artifactErr: any) {
              // Non-fatal
              console.warn('Failed to store codebase artifact:', artifactErr.message);
            }
          }

          // Save folder structure to the project for UI display
          if (fileAnalysis.folderStructure?.length > 0) {
            try {
              await db.update(projects)
                .set({ folder_structure: fileAnalysis.folderStructure })
                .where(eq(projects.id, run.project.id));
            } catch (fsErr: any) {
              console.warn('Failed to save folder structure:', fsErr.message);
            }
          }

          options?.onEvent?.({
            phase: 'scanning_codebase',
            stageName,
            stageIndex: stageIdx,
            timestamp: new Date().toISOString(),
            data: { message: `Scanned ${fileAnalysis.totalFiles} files, ${fileAnalysis.totalLines.toLocaleString()} lines` },
          });

          // ─── BREE Engine Integration (SCAN stage) ─────────────
          // Run BREE static analysis on the codebase for ground-truth
          // language detection, requirements extraction, and deep analysis.
          try {
            const { isBreeOnline, breeFullContext, formatBreeContextForPrompt } = await import('./bree-client.js');
            if (await isBreeOnline()) {
              options?.onEvent?.({
                phase: 'bree_analysis',
                stageName,
                stageIndex: stageIdx,
                timestamp: new Date().toISOString(),
                data: { message: 'Running BREE Engine static analysis...' },
              });

              const breeInput = fileAnalysis.codebasePath
                ? { path: fileAnalysis.codebasePath }
                : { files: (fileAnalysis.codeSnippets || []).map((s: any) => ({ path: s.path, content: s.content })) };

              const breeCtx = await breeFullContext(breeInput);

              // Store BREE analysis as a stage artifact for downstream stages
              if (breeCtx.requirements || breeCtx.graphAnalysis) {
                try {
                  await db.insert(stageArtifacts).values({
                    id: crypto.randomUUID(),
                    pipeline_run_id: pipelineRunId,
                    stage_name: stageName,
                    artifact_type: 'bree_analysis',
                    storage_path: '',
                    metadata: {
                      bree_online: true,
                      requirements_count: breeCtx.requirements?.documents?.length || 0,
                      business_rules_count: breeCtx.graphAnalysis?.business_rules?.total_rules || 0,
                      complexity_avg: breeCtx.graphAnalysis?.complexity?.average_complexity || 0,
                      dead_code_pct: breeCtx.graphAnalysis?.dead_code?.dead_code_pct || 0,
                    },
                  });
                } catch { /* non-fatal */ }
              }

              // Attach BREE context to project context for prompt injection
              (projectContext as any).breeContext = breeCtx;
              (projectContext as any).breeContextText = formatBreeContextForPrompt(breeCtx);

              // Improve language detection with BREE's more accurate results
              if (breeCtx.scanResult?.language_profile?.primary?.length) {
                const breeLanguages = breeCtx.scanResult.language_profile.primary.map((l: any) => l.language_id);
                if (breeLanguages.length > 0) {
                  projectContext.sourceLanguages = breeLanguages;
                }
              }

              const reqCount = breeCtx.requirements?.documents?.reduce((s: number, d: any) => s + d.functional_requirements.length, 0) || 0;
              const rulesCount = breeCtx.graphAnalysis?.business_rules?.total_rules || 0;

              options?.onEvent?.({
                phase: 'bree_analysis',
                stageName,
                stageIndex: stageIdx,
                timestamp: new Date().toISOString(),
                data: { message: `BREE: ${reqCount} requirements, ${rulesCount} business rules extracted` },
              });
            }
          } catch (breeErr: any) {
            // BREE is non-fatal — pipeline continues without it
            options?.onEvent?.({
              phase: 'bree_analysis',
              stageName,
              stageIndex: stageIdx,
              timestamp: new Date().toISOString(),
              data: { message: `BREE analysis skipped: ${breeErr.message}` },
            });
          }

        } catch (err: any) {
          // Non-fatal — proceed without file analysis
          options?.onEvent?.({
            phase: 'scanning_codebase',
            stageName,
            stageIndex: stageIdx,
            timestamp: new Date().toISOString(),
            data: { message: `File analysis skipped: ${err.message}` },
          });
        }
      }
    }

    // Load prior stage outputs from artifacts (tiered context with observable trajectory)
    const { outputs: priorOutputs, trajectoryMeta } = await this.loadPriorStageOutputs(pipelineRunId, stageName);

    // Emit trajectory SSE event if available
    if (trajectoryMeta) {
      options?.onEvent?.({
        phase: 'context_retrieval',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: trajectoryMeta,
      });
    }

    // Load user feedback from approval history
    const feedback = await this.loadUserFeedback(pipelineRunId, stageConfig.index);

    // Update stage progress
    await this.updateStageProgress(pipelineRunId, stageName, "in_progress", 0);

    // ─── AGENT MATCHING ─────────────────────────────────────────
    // Attempt to find and assign the best agent for this stage.
    // Falls back to direct LLM execution if no agent is available.
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
          data: {
            agentId: agentCtx.agentId,
            agentName: agentCtx.agentName,
            assignmentId: agentCtx.assignmentId,
          },
        });
      }
    } catch (matchErr: unknown) {
      // Non-fatal — proceed without agent
      const errMsg = matchErr instanceof Error ? matchErr.message : String(matchErr);
      options?.onEvent?.({
        phase: 'agent_assigned',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: { skipped: true, reason: `Agent matching failed: ${errMsg}` },
      });
    }

    // Load project-specific prompt override (if set via Settings)
    const stagePrompts = (run.project as any).stage_prompts as Record<string, string> | null;
    const promptOverride = stagePrompts?.[stageName] || undefined;

    // Create LLM call and eval functions — with optional model overrides.
    // If an agent was assigned, prefer the agent's model configuration.
    const modelName = options?.model
      || process.env.LLM_DEFAULT_MODEL
      || agentCtx?.preferredModel
      || "";
    let llmCallFn = llmProxyService.createCallFn({
      maxTokens: 8192,
      model: modelName,
    });
    const llmEvalFn = options?.skipLlmEval
      ? undefined
      : llmProxyService.createEvalFn({ model: options?.evaluatorModel });

    // Reviewer LLM — uses the evaluator model (different from generator to avoid
    // self-validation bias). This enables the full multi-agent loop:
    // Generate -> Review -> Refine -> Validate
    //
    // hasValidationModel() check: verify the evaluator model resolves to a
    // configured provider with credentials before attempting dual-model flow.
    // Without this, the reviewer step fails silently. Ported from legacy-bridge.
    let reviewerLlmCallFn: ReturnType<typeof llmProxyService.createCallFn> | undefined;
    const wantedEvaluatorModel = options?.evaluatorModel
      || agentCtx?.evaluatorModel
      || process.env.LLM_EVALUATOR_MODEL;
    if (wantedEvaluatorModel) {
      const hasEvalModel = await llmProxyService.hasValidationModel();
      if (hasEvalModel) {
        reviewerLlmCallFn = llmProxyService.createCallFn({
          maxTokens: 2048,
          model: wantedEvaluatorModel,
        });
      } else {
        // Evaluator model is not resolvable — skip reviewer, rely on validation only
        options?.onEvent?.({
          phase: 'reviewing',
          stageName,
          stageIndex: stageConfig.index,
          timestamp: new Date().toISOString(),
          data: {
            skipped: true,
            reason: `Evaluator model "${wantedEvaluatorModel}" not available — skipping reviewer step`,
          },
        });
      }
    }

    // ─── AGENT EXECUTION BRIDGE ─────────────────────────────────
    // When an agent is assigned, wrap the LLM call function with the agent's
    // identity (system prompt, session context, tool permissions). This makes
    // every LLM call operate under the agent's persona.
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

        // Replace the LLM call function with the agent-enhanced version
        llmCallFn = agentExec.llmCallFn;

        // Also wrap the reviewer if available
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
        // Non-fatal — proceed with base LLM call (no agent identity)
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

    // ─── BUDGET CHECK ───────────────────────────────────────────
    // Pre-flight budget check before any LLM calls.
    // Throws PipelineBudgetExceededError if budget is exhausted.
    try {
      await checkPipelineBudget(pipelineRunId);
    } catch (budgetErr) {
      if (budgetErr instanceof PipelineBudgetExceededError) {
        options?.onEvent?.({
          phase: 'failed' as any,
          stageName,
          stageIndex: stageConfig.index,
          timestamp: new Date().toISOString(),
          data: {
            error: budgetErr.message,
            budgetExceeded: true,
            usedCents: budgetErr.usedCents,
            budgetCents: budgetErr.budgetCents,
          },
        });
        throw budgetErr;
      }
      // Non-budget errors pass through
      throw budgetErr;
    }

    // ─── SCAN MULTI-AGENT ORCHESTRATION ─────────────────────────
    // For SCAN stage with file analysis available, use the multi-agent
    // orchestrator: Scout → Director → Specialists → Composition.
    if (stageName === PipelineStageName.SCAN && projectContext.fileAnalysis) {
      const scanResult = await orchestrateScanStage({
        pipelineRunId,
        projectContext,
        fileAnalysis: projectContext.fileAnalysis as any, // FileAnalysis → FileAnalysisResult compatible
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: options?.onDelta,
        signal: options?.signal,
        model: modelName,
      });

      // Store result + record agent completion (reuse existing flow below)
      if (scanResult.output) {
        await this.storeStageOutput(pipelineRunId, stageName, scanResult);
      }

      if (agentCtx && scanResult.output) {
        try {
          await recordAgentCompletion(
            agentCtx,
            {
              costCents: 0,
              tokensUsed: 0,
              refinementCount: scanResult.refinementCount,
              result: { orchestrated: true, subtaskCount: scanResult.phases.length },
            },
            pipelineRunId,
            "auto",
            modelName || "default",
            0,
            0,
            PipelineStageName.SCAN,
          );
        } catch {
          // Non-fatal
        }
        if (agentExec) {
          try { await agentExec.complete(); } catch { /* swallow */ }
        }
      }

      // Update stage progress + create approval gate
      if (scanResult.output) {
        await this.updateStageProgress(pipelineRunId, stageName, "completed", 100);
        emitStageCompleted({ pipelineRunId, projectId: run.project.id, stageName, duration: scanResult.duration, confidenceScore: scanResult.validation?.confidenceScore });

        // Create approval gate for SCAN stage (same logic as normal path)
        const scanConfig = this.getStageConfig(stageName);
        if (scanConfig.requiresApproval) {
          await this.createApprovalGate(pipelineRunId, stageName, scanConfig.requiredRole || "admin");
          await this.updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100);
        }
      } else {
        await this.updateStageProgress(pipelineRunId, stageName, "failed", 0);
        emitStageFailed({ pipelineRunId, projectId: run.project.id, stageName, error: "SCAN produced no output" });
      }

      return scanResult;
    }

    // ─── DECODE MULTI-AGENT ORCHESTRATION ────────────────────────
    // For DECODE stage, use the multi-agent orchestrator:
    // Director plans → Specialists extract intent → Composition.
    // Requires Stage 1 SCAN output as primary input (loaded from artifacts).
    if (stageName === PipelineStageName.DECODE) {
      const scanOutput = await loadScanOutput(pipelineRunId);
      if (!scanOutput) {
        throw new Error("Cannot execute DECODE: Stage 1 (SCAN) output not found. Please run and approve SCAN first.");
      }

      // ─── BREE Engine Integration (DECODE stage) ─────────────
      // Load BREE analysis from SCAN artifact, or run fresh analysis.
      // BREE provides deterministic ground truth that anchors the LLM.
      let breeContextText = '';
      try {
        const { isBreeOnline, breeFullContext, formatBreeContextForPrompt } = await import('./bree-client.js');
        if (await isBreeOnline()) {
          options?.onEvent?.({
            phase: 'bree_analysis',
            stageName,
            stageIndex: stageConfig.index,
            timestamp: new Date().toISOString(),
            data: { message: 'Running BREE Engine intent extraction...' },
          });

          // Try to load codebase path from SCAN artifact
          const codebaseArtifact = await db.query.stageArtifacts.findFirst({
            where: and(
              eq(stageArtifacts.pipeline_run_id, pipelineRunId),
              eq(stageArtifacts.artifact_type, 'cloned_codebase'),
            ),
          });
          const codebasePath = codebaseArtifact?.storage_path;

          if (codebasePath) {
            const breeCtx = await breeFullContext({ path: codebasePath });
            breeContextText = formatBreeContextForPrompt(breeCtx, 12000);
            (projectContext as any).breeContext = breeCtx;
            (projectContext as any).breeContextText = breeContextText;

            // Store BREE decode analysis artifact
            try {
              await db.insert(stageArtifacts).values({
                id: crypto.randomUUID(),
                pipeline_run_id: pipelineRunId,
                stage_name: stageName,
                artifact_type: 'bree_requirements',
                storage_path: '',
                metadata: {
                  requirements_docs: breeCtx.requirements?.total_files || 0,
                  business_rules: breeCtx.graphAnalysis?.business_rules?.total_rules || 0,
                  call_graph_nodes: breeCtx.graphAnalysis?.call_graph?.stats?.total_nodes || 0,
                },
              });
            } catch { /* non-fatal */ }

            const ruleCount = breeCtx.graphAnalysis?.business_rules?.total_rules || 0;
            options?.onEvent?.({
              phase: 'bree_analysis',
              stageName,
              stageIndex: stageConfig.index,
              timestamp: new Date().toISOString(),
              data: { message: `BREE: ${ruleCount} business rules, requirements document ready` },
            });
          }
        }
      } catch (breeErr: any) {
        options?.onEvent?.({
          phase: 'bree_analysis',
          stageName,
          stageIndex: stageConfig.index,
          timestamp: new Date().toISOString(),
          data: { message: `BREE skipped: ${breeErr.message}` },
        });
      }

      const decodeResult = await orchestrateDecodeStage({
        pipelineRunId,
        projectContext,
        scanOutput,
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: options?.onDelta,
        signal: options?.signal,
        model: modelName,
      });

      // Store result
      if (decodeResult.output) {
        await this.storeStageOutput(pipelineRunId, stageName, decodeResult);
      }

      if (agentCtx && decodeResult.output) {
        try {
          await recordAgentCompletion(
            agentCtx,
            {
              costCents: 0,
              tokensUsed: 0,
              refinementCount: decodeResult.refinementCount,
              result: { orchestrated: true, subtaskCount: decodeResult.phases.length },
            },
            pipelineRunId,
            "auto",
            modelName || "default",
            0,
            0,
            PipelineStageName.DECODE,
          );
        } catch {
          // Non-fatal
        }
        if (agentExec) {
          try { await agentExec.complete(); } catch { /* swallow */ }
        }
      }

      // Update stage progress + create approval gate
      if (decodeResult.output) {
        await this.updateStageProgress(pipelineRunId, stageName, "completed", 100);
        emitStageCompleted({ pipelineRunId, projectId: run.project.id, stageName, duration: decodeResult.duration, confidenceScore: decodeResult.validation?.confidenceScore });

        // Create approval gate for DECODE stage (same logic as normal path)
        const decodeConfig = this.getStageConfig(stageName);
        if (decodeConfig.requiresApproval) {
          await this.createApprovalGate(pipelineRunId, stageName, decodeConfig.requiredRole || "admin");
          await this.updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100);
        }
      } else {
        await this.updateStageProgress(pipelineRunId, stageName, "failed", 0);
        emitStageFailed({ pipelineRunId, projectId: run.project.id, stageName, error: "DECODE produced no output" });
      }

      return decodeResult;
    }

    // Execute stage — with fallback chain.
    // If the Go orchestrator is unreachable or overloaded, we retry with
    // degraded settings (no reviewer, no LLM eval) to maximize the chance
    // of returning a useful result. Ported from legacy-bridge stageAI.ts
    // runStageAgent() fallback logic.
    let result: StageRunResult;
    try {
      result = await runStage({
        project: projectContext,
        stageName,
        stageIndex: stageConfig.index,
        pipelineRunId,
        templateVars,
        llmCallFn,
        llmEvalFn,
        reviewerLlmCallFn,
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: options?.onDelta,
        signal: options?.signal,
        skipLlmEval: options?.skipLlmEval,
        promptOverride,
        model: modelName,
      });
    } catch (primaryErr: unknown) {
      // Abort errors should not be retried
      if (primaryErr instanceof Error && primaryErr.message === 'Stage execution aborted') {
        if (agentExec) { try { await agentExec.fail(primaryErr); } catch { /* swallow */ } }
        throw primaryErr;
      }

      const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const isFallbackEligible = /econnrefused|network|timeout|503|502|529|overloaded|rate.?limit|too many requests/i.test(errMsg);

      if (!isFallbackEligible) {
        if (agentExec) { try { await agentExec.fail(primaryErr); } catch { /* swallow */ } }
        throw primaryErr;
      }

      // Fallback: retry without reviewer and without LLM eval.
      // This maximizes chance of success when the orchestrator is partially degraded.
      console.warn(
        `[PipelineService] Primary execution failed (${errMsg}), retrying with degraded settings...`,
      );

      options?.onEvent?.({
        phase: 'generating',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: {
          fallback: true,
          reason: errMsg,
          message: 'Retrying with fallback settings (no reviewer, deterministic validation only)',
        },
      });

      // Clear streaming state before retry
      options?.onDelta?.('');

      result = await runStage({
        project: projectContext,
        stageName,
        stageIndex: stageConfig.index,
        pipelineRunId,
        templateVars,
        llmCallFn,
        // Omit reviewer and LLM eval — reduce external calls
        llmEvalFn: undefined,
        reviewerLlmCallFn: undefined,
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: options?.onDelta,
        signal: options?.signal,
        skipLlmEval: true,
        skipReview: true,
        promptOverride,
        model: modelName,
      });
    }

    // Store result
    if (result.output) {
      await this.storeStageOutput(pipelineRunId, stageName, result);
    }

    // Record pipeline-level spend from token usage
    try {
      const stageInputTokens = result.phases?.reduce(
        (s, p) => s + (Number(p.data?.inputTokens) || 0), 0,
      ) || 0;
      const stageOutputTokens = result.phases?.reduce(
        (s, p) => s + (Number(p.data?.outputTokens) || 0), 0,
      ) || 0;
      if (stageInputTokens > 0 || stageOutputTokens > 0) {
        const cost = estimateCostCents(stageInputTokens, stageOutputTokens, modelName);
        await recordPipelineSpend(pipelineRunId, cost);
      }
    } catch {
      // Non-fatal — budget tracking failure shouldn't break pipeline
    }

    // Record agent completion and lifecycle hooks (if an agent was assigned)
    if (agentCtx && result.output) {
      try {
        // Extract token counts from phase event data
        const inputTokens = result.phases?.reduce(
          (s, p) => s + (Number(p.data?.inputTokens) || 0), 0,
        ) || 0;
        const outputTokens = result.phases?.reduce(
          (s, p) => s + (Number(p.data?.outputTokens) || 0), 0,
        ) || 0;

        await recordAgentCompletion(
          agentCtx,
          {
            costCents: 0, // Populated by token-based pricing later
            tokensUsed: inputTokens + outputTokens,
            refinementCount: result.refinementCount,
            result: { output: result.output.slice(0, 1000), validation: result.validation },
          },
          pipelineRunId,
          modelName.split("/")[0] || "unknown",
          modelName,
          inputTokens,
          outputTokens,
          stageName,
        );

        // Signal agent execution lifecycle: success
        if (agentExec) {
          await agentExec.complete();
        }
      } catch {
        // Non-fatal — cost tracking failure shouldn't break pipeline
        // Still try to release the agent
        if (agentExec) {
          try { await agentExec.complete(); } catch { /* swallow */ }
        }
      }
    } else if (agentExec) {
      // Agent was prepared but stage produced no output — still release the agent
      try {
        if (result.output) {
          await agentExec.complete();
        } else {
          await agentExec.fail(new Error("Stage produced no output"));
        }
      } catch { /* swallow */ }
    }

    // Track project-level metrics after stage completion
    await this.updateProjectMetrics(run.project.id, pipelineRunId, result);

    // Extract memories from stage output (non-blocking, non-fatal)
    if (result.output) {
      try {
        const { extractMemories } = await import("./memory-extraction.js");
        const memResult = await extractMemories({
          projectId: run.project.id,
          pipelineRunId,
          stageName,
          stageOutput: result.output,
        });
        if (memResult && memResult.stored > 0) {
          emitMemoryExtracted({
            pipelineRunId,
            projectId: run.project.id,
            stageName,
            memoriesStored: memResult.stored,
            method: memResult.extractionMethod || "unknown",
          });
        }
      } catch {
        // Memory extraction failure is non-fatal
      }
    }

    // Update stage progress
    if (result.validation?.passed || !result.validation) {
      await this.updateStageProgress(pipelineRunId, stageName, "completed", 100);

      // Emit stage completed event
      emitStageCompleted({
        pipelineRunId,
        projectId: run.project.id,
        stageName,
        duration: 0,
        confidenceScore: result.validation?.confidenceScore,
      });

      // Create approval gate for the CURRENT stage so user must review its output
      // before the next stage can run. The frontend shows the gate on the completed stage.
      const currentConfig = this.getStageConfig(stageName);
      if (currentConfig.requiresApproval) {
        await this.createApprovalGate(pipelineRunId, stageName, currentConfig.requiredRole || "admin");
        await this.updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100);
      }

      const nextStage = this.getNextStage(stageName);
      if (!nextStage) {
        // Pipeline complete
        await db.update(pipelineRuns).set({
          status: "completed",
          completed_at: new Date(),
          updated_at: new Date(),
        }).where(eq(pipelineRuns.id, pipelineRunId));

        // Emit pipeline completed event
        pipelineEventBus.fire({
          type: "pipeline.completed",
          timestamp: new Date().toISOString(),
          pipelineRunId,
          projectId: run.project.id,
          data: { finalStage: stageName },
        });
      }
    } else {
      // Stage failed validation — don't auto-advance
      await this.updateStageProgress(pipelineRunId, stageName, "needs_review", result.validation.confidenceScore);

      // Emit validation failed event
      emitValidationFailed({
        pipelineRunId,
        projectId: run.project.id,
        stageName,
        violations: result.validation.issues?.length || 0,
        hardGated: false,
      });
    }

    return result;
  }

  /**
   * Load outputs from all prior stages for context building.
   * Uses tiered context (L0/L1/L2) when available, with observable retrieval trajectory.
   */
  private async loadPriorStageOutputs(
    pipelineRunId: string,
    currentStage: PipelineStageName,
    agentId?: string,
  ): Promise<{ outputs: StageOutput[]; trajectoryMeta?: { tokensUsed: number; totalTokenBudget: number; trajectory: unknown[]; evolutionMemoriesLoaded: number; buildDurationMs: number } }> {
    // Default token budget: 12K tokens (~48K chars) for prior context
    const tokenBudget = 12000;

    try {
      const { outputs, trajectory, tokensUsed } = await loadTieredPriorContext(
        pipelineRunId,
        currentStage,
        tokenBudget,
        agentId,
      );
      return {
        outputs,
        trajectoryMeta: {
          tokensUsed,
          totalTokenBudget: tokenBudget,
          trajectory,
          evolutionMemoriesLoaded: 0,
          buildDurationMs: 0,
        },
      };
    } catch {
      // Fallback to raw loading if tiered context fails
      const order = getStageOrder();
      const currentIdx = order.indexOf(currentStage);
      const priorStages = order.slice(0, currentIdx);

      if (priorStages.length === 0) return { outputs: [] };

      const artifacts = await db.query.stageArtifacts.findMany({
        where: and(
          eq(stageArtifacts.pipeline_run_id, pipelineRunId),
          eq(stageArtifacts.artifact_type, "stage_output"),
          inArray(stageArtifacts.stage_name, priorStages),
        ),
      });

      const artifactMap = new Map<string, typeof artifacts[0]>();
      for (const artifact of artifacts) {
        if (!artifactMap.has(artifact.stage_name)) {
          artifactMap.set(artifact.stage_name, artifact);
        }
      }

      return {
        outputs: priorStages
          .filter((stage) => artifactMap.has(stage))
          .map((stage) => {
            const artifact = artifactMap.get(stage)!;
            const metadata = artifact.metadata as Record<string, unknown>;
            return {
              stageName: stage as PipelineStageName,
              stageIndex: order.indexOf(stage),
              output: (metadata?.content as string) || "",
              completedAt: artifact.created_at?.toISOString() || new Date().toISOString(),
            };
          }),
      };
    }
  }

  /**
   * Load user feedback from approval rejections and direct feedback.
   */
  private async loadUserFeedback(
    pipelineRunId: string,
    stageIndex: number,
  ): Promise<UserFeedback[]> {
    const gates = await db.query.approvalGates.findMany({
      where: and(
        eq(approvalGates.pipeline_run_id, pipelineRunId),
        eq(approvalGates.status, "rejected"),
      ),
    });

    return gates
      .filter((g) => g.approval_comment)
      .map((g) => ({
        stageIndex,
        feedback: g.approval_comment!,
        source: "approval_rejection" as const,
        timestamp: g.approved_at?.toISOString() || new Date().toISOString(),
      }));
  }

  /**
   * Store stage output as an artifact in the database.
   */
  private async storeStageOutput(
    pipelineRunId: string,
    stageName: PipelineStageName,
    result: StageRunResult,
  ): Promise<void> {
    const artifactId = crypto.randomUUID();
    await db.insert(stageArtifacts).values({
      id: artifactId,
      pipeline_run_id: pipelineRunId,
      stage_name: stageName,
      artifact_type: "stage_output",
      storage_path: `pipeline/${pipelineRunId}/${stageName}/output.md`,
      file_size: Buffer.byteLength(result.output, "utf-8"),
      metadata: {
        content: result.output,
        validation: result.validation ? {
          passed: result.validation.passed,
          confidenceScore: result.validation.confidenceScore,
          issueCount: result.validation.issues.length,
        } : null,
        refinementCount: result.refinementCount,
        duration: result.duration,
      },
    });

    // Fire-and-forget: generate L0/L1 tier summaries (OpenViking pattern)
    generateTierSummaries(artifactId, stageName, result.output).catch(() => {});

    // Store validation result as separate artifact
    if (result.validation) {
      await db.insert(stageArtifacts).values({
        id: crypto.randomUUID(),
        pipeline_run_id: pipelineRunId,
        stage_name: stageName,
        artifact_type: "validation_result",
        storage_path: `pipeline/${pipelineRunId}/${stageName}/validation.json`,
        file_size: 0,
        metadata: {
          passed: result.validation.passed,
          confidenceScore: result.validation.confidenceScore,
          deterministicResults: result.validation.deterministicResults.map((r: { name: string; score: number; status: string; message: string }) => ({
            name: r.name,
            score: r.score,
            status: r.status,
            message: r.message,
          })),
          llmResults: result.validation.llmResults.map((r: { dimension: string; score: number; reasoning: string }) => ({
            dimension: r.dimension,
            score: r.score,
            reasoning: r.reasoning,
          })),
          contractViolations: result.validation.contractResult.violations,
          issues: result.validation.issues,
          recommendations: result.validation.recommendations,
        },
      });
    }
  }

  /**
   * Update stage progress in the pipeline run's JSONB column.
   */
  private async updateStageProgress(
    pipelineRunId: string,
    stageName: PipelineStageName,
    status: string,
    progress: number,
  ): Promise<void> {
    // Read current progress, merge the new stage entry, then write back.
    // This avoids raw SQL jsonb_build_object which has parameter-binding
    // issues with Drizzle's sql template literal + ::jsonb casts.
    const [run] = await db
      .select({ stage_progress: pipelineRuns.stage_progress })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, pipelineRunId))
      .limit(1);

    const current = (run?.stage_progress as Record<string, unknown>) || {};
    const updated = {
      ...current,
      [stageName]: { status, progress, updatedAt: new Date().toISOString() },
    };

    await db.update(pipelineRuns).set({
      current_stage: stageName,
      stage_progress: updated,
      updated_at: new Date(),
    }).where(eq(pipelineRuns.id, pipelineRunId));
  }

  /**
   * Create an approval gate for a stage.
   */
  private async createApprovalGate(
    pipelineRunId: string,
    stageName: PipelineStageName,
    requiredRole: string,
  ): Promise<void> {
    await db.insert(approvalGates).values({
      id: crypto.randomUUID(),
      pipeline_run_id: pipelineRunId,
      stage_name: stageName,
      required_role: requiredRole,
      status: "pending",
    });
  }

  /**
   * Advance pipeline to the next stage.
   */
  async advanceStage(pipelineRunId: string): Promise<void> {
    const run = await this.getPipelineRun(pipelineRunId);
    if (!run) throw new Error("Pipeline run not found");
    if (run.status !== "running") throw new Error(`Cannot advance pipeline in ${run.status} state`);

    const currentStage = run.current_stage as PipelineStageName;
    const nextStage = this.getNextStage(currentStage);

    if (!nextStage) {
      await db.update(pipelineRuns).set({
        status: "completed",
        completed_at: new Date(),
        updated_at: new Date(),
      }).where(eq(pipelineRuns.id, pipelineRunId));
      return;
    }

    await this.updateStageProgress(pipelineRunId, currentStage, "approved", 100);
    await this.updateStageProgress(pipelineRunId, nextStage, "in_progress", 0);

    await db.update(pipelineRuns).set({
      current_stage: nextStage,
      updated_at: new Date(),
    }).where(eq(pipelineRuns.id, pipelineRunId));
  }

  /**
   * Approve an approval gate and advance the pipeline.
   */
  async approveGate(
    pipelineRunId: string,
    stageName: PipelineStageName,
    approvedBy: string,
    comment?: string,
  ): Promise<void> {
    const gate = await db.query.approvalGates.findFirst({
      where: and(
        eq(approvalGates.pipeline_run_id, pipelineRunId),
        eq(approvalGates.stage_name, stageName),
      ),
    });

    if (!gate) throw new Error("Approval gate not found");
    if (gate.status !== "pending") throw new Error(`Gate already ${gate.status}`);

    await db.update(approvalGates).set({
      status: "approved",
      approved_by: approvedBy,
      approval_comment: comment,
      approved_at: new Date(),
    }).where(
      and(
        eq(approvalGates.pipeline_run_id, pipelineRunId),
        eq(approvalGates.stage_name, stageName),
      ),
    );

    // Mark stage as approved (gate is on the completed stage, not the next one)
    await this.updateStageProgress(pipelineRunId, stageName, "approved", 100);

    // Advance current_stage to the next stage in the pipeline
    const nextStage = this.getNextStage(stageName);
    if (nextStage) {
      await db.update(pipelineRuns).set({
        current_stage: nextStage,
      }).where(eq(pipelineRuns.id, pipelineRunId));
    } else {
      // All stages approved — mark pipeline as completed
      await db.update(pipelineRuns).set({
        status: "completed",
        completed_at: new Date(),
      }).where(eq(pipelineRuns.id, pipelineRunId));
    }
  }

  /**
   * Reject an approval gate.
   */
  async rejectGate(
    pipelineRunId: string,
    stageName: PipelineStageName,
    rejectedBy: string,
    reason: string,
  ): Promise<void> {
    await db.update(approvalGates).set({
      status: "rejected",
      approved_by: rejectedBy,
      approval_comment: reason,
      approved_at: new Date(),
    }).where(
      and(
        eq(approvalGates.pipeline_run_id, pipelineRunId),
        eq(approvalGates.stage_name, stageName),
      ),
    );

    // Mark stage as needing re-work (don't fail the whole pipeline)
    await this.updateStageProgress(pipelineRunId, stageName, "rejected", 0);
  }

  /**
   * Fail a stage and stop the pipeline.
   */
  async resetRunStatus(pipelineRunId: string): Promise<void> {
    await db.update(pipelineRuns).set({
      status: "running",
      error_message: null,
      completed_at: null,
      updated_at: new Date(),
    }).where(eq(pipelineRuns.id, pipelineRunId));
  }

  async failStage(pipelineRunId: string, errorMessage: string): Promise<void> {
    await db.update(pipelineRuns).set({
      status: "failed",
      error_message: errorMessage,
      completed_at: new Date(),
      updated_at: new Date(),
    }).where(eq(pipelineRuns.id, pipelineRunId));
  }

  /**
   * Add an artifact to a stage.
   */
  async addArtifact(
    pipelineRunId: string,
    stageName: string,
    artifactType: string,
    storagePath: string,
    metadata?: Record<string, unknown>,
    fileSize?: number,
  ): Promise<void> {
    await db.insert(stageArtifacts).values({
      id: crypto.randomUUID(),
      pipeline_run_id: pipelineRunId,
      stage_name: stageName,
      artifact_type: artifactType,
      storage_path: storagePath,
      file_size: fileSize,
      metadata: metadata || {},
    });
  }

  /**
   * Update project-level metrics after a stage completes.
   *
   * Aggregates files_processed, lines_analyzed, total_tokens, and total_cost
   * from the pipeline run into the project's metrics JSONB column.
   *
   * Ported from legacy-bridge metrics tracking during agent runs.
   */
  private async updateProjectMetrics(
    projectId: string,
    pipelineRunId: string,
    result: StageRunResult,
  ): Promise<void> {
    try {
      // Fetch current project metrics
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { metrics: true },
      });

      const currentMetrics = (project?.metrics as Record<string, unknown>) || {};

      // Aggregate LLM usage for this pipeline run
      const usageRecords = await db.query.llmUsage.findMany({
        where: eq(llmUsage.pipeline_run_id, pipelineRunId),
      });

      let runTokens = 0;
      let runCost = 0;
      for (const record of usageRecords) {
        runTokens += record.input_tokens + record.output_tokens;
        runCost += record.cost;
      }

      // Merge with existing metrics
      const updatedMetrics: Record<string, unknown> = {
        ...currentMetrics,
        total_pipeline_runs: ((currentMetrics.total_pipeline_runs as number) || 0) + 1,
        total_tokens: ((currentMetrics.total_tokens as number) || 0) + runTokens,
        total_cost_cents: ((currentMetrics.total_cost_cents as number) || 0) + runCost,
        last_run_duration_ms: result.duration,
        last_run_at: new Date().toISOString(),
        stages_completed: ((currentMetrics.stages_completed as number) || 0) + 1,
        total_refinements: ((currentMetrics.total_refinements as number) || 0) + result.refinementCount,
      };

      // If validation was run, track validation stats
      if (result.validation) {
        updatedMetrics.last_confidence_score = result.validation.confidenceScore;
        updatedMetrics.total_validation_issues =
          ((currentMetrics.total_validation_issues as number) || 0) +
          result.validation.issues.length;
      }

      await db
        .update(projects)
        .set({ metrics: updatedMetrics, updated_at: new Date() })
        .where(eq(projects.id, projectId));
    } catch (err: any) {
      // Non-fatal — don't fail the stage because metrics failed
      console.warn(`[PipelineService] Failed to update project metrics: ${err.message}`);
    }
  }

  /**
   * Refine a section of stage output using LLM.
   */
  async refineSection(
    pipelineRunId: string,
    stageName: string,
    sectionTitle: string,
    sectionContent: string,
    userFeedback: string,
    fullText: string,
  ): Promise<string> {
    const systemPrompt = `You are an expert technical writer helping refine a section of a modernization analysis document.
You will receive a section from a stage output along with user feedback on how to improve it.
Return ONLY the refined markdown content for that section — no explanations, no meta-commentary.
Preserve the markdown formatting, heading level, and structure.
Make the improvements the user requested while keeping the content accurate and professional.`;

    const userPrompt = `## Section to Refine
**Title:** ${sectionTitle}

**Current Content:**
${sectionContent}

---

## User Feedback
${userFeedback}

---

## Full Document Context (for reference only — do not reproduce the entire document)
${fullText.slice(0, 4000)}

---

Please provide the refined version of the "${sectionTitle}" section only.`;

    const callFn = llmProxyService.createCallFn({ maxTokens: 4096 });
    const refined = await callFn({
      systemPrompt,
      userPrompt,
      cacheablePrefix: undefined,
      onDelta: undefined,
      signal: undefined,
    });

    return refined;
  }

  /**
   * Interactive chat for the Evolve stage.
   * Streams LLM response with pipeline context.
   */
  async chat(
    pipelineRunId: string,
    message: string,
    history: Array<{ role: string; content: string }>,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const run = await this.getPipelineRun(pipelineRunId);
    if (!run) throw new Error("Pipeline run not found");

    // Load prior stage outputs using tiered context (L0/L1/L2)
    const order = getStageOrder();
    const { outputs: priorOutputs } = await this.loadPriorStageOutputs(
      pipelineRunId,
      order[order.length - 1] as PipelineStageName, // Load all prior stages
    );

    const contextSummary = priorOutputs
      .map((o) => `### ${o.stageName}\n${o.output}`)
      .join('\n\n---\n\n');

    const systemPrompt = `You are an AI modernization advisor helping with the ongoing evolution of a legacy-to-modern migration project.
You have access to the full pipeline context from all completed stages.
Provide actionable, specific guidance. Reference the actual codebase, architecture decisions, and BDD specs from the pipeline outputs when relevant.
Be concise but thorough.

## Pipeline Context (completed stages):
${contextSummary}`;

    const userPrompt = history.length > 0
      ? `Previous conversation:\n${history.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\nUser: ${message}`
      : message;

    const callFn = llmProxyService.createCallFn({ maxTokens: 4096 });
    const response = await callFn({
      systemPrompt,
      userPrompt,
      cacheablePrefix: contextSummary,
      onDelta,
      signal,
    });

    return response;
  }
}

export const pipelineService = new PipelineService();
