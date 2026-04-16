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
import { pipelineRuns, stageArtifacts, llmUsage, projects } from "@/db/schema.js";
import { NotFoundError, ValidationError } from "@/errors.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import {
  runStage,
  type StageRunResult,
  type OnStageEvent,
  type OnDelta,
  type ProjectContext,
  type LLMCallFn,
  type StageOutput,
  type UserFeedback,
  getStageOrder,
} from "@revamp/core-engine";
import { enforceContract } from "@revamp/core-engine";
import {
  storeStageOutput,
  loadPriorStageOutputs,
  loadUserFeedback,
  updateProjectMetrics,
} from "./pipeline-repository.js";
import { finalizeStageResult } from "./pipeline-finalize.js";
import {
  advanceStage as advanceStageOp,
  approveGate as approveGateOp,
  rejectGate as rejectGateOp,
  resetRunStatus as resetRunStatusOp,
  failStage as failStageOp,
  addArtifact as addArtifactOp,
  refineSection as refineSectionOp,
  chat as chatOp,
} from "./pipeline-operations.js";
import {
  type StageConfig,
  PIPELINE_STAGES,
  getStageConfig,
  getNextStage,
  getPreviousStage,
  getPipelineRun,
  isStageDisabled,
} from "./pipeline-config.js";
import { llmProxyService } from "./llm-proxy.js";
import { prepareStageExecution, type StageExecutionContext, type ExecuteStageOptions } from "./pipeline-execution-context.js";
import {
  recordAgentCompletion,
  type AgentStageContext,
} from "./agent-pipeline.js";
import { orchestrateScanStage } from "./scan-orchestrator.js";
import { orchestrateForgeStage } from "./forge-orchestrator.js";
import { orchestrateDecodeStage, loadScanOutput } from "./decode-orchestrator.js";
import {
  checkPipelineBudget,
  recordPipelineSpend,
  estimateCostCents,
  PipelineBudgetExceededError,
  ProjectBudgetExceededError,
  enforceProjectBudget,
} from "./pipeline-budget.js";
import {
  pipelineEventBus,
  emitStageCompleted,
  emitStageFailed,
  emitValidationFailed,
  emitMemoryExtracted,
  emitPipelineBudgetWarning,
} from "./pipeline-event-bus.js";
import {
  getLatestExecution,
  completeExecution as completeStageExecution,
  failExecution as failStageExecution,
  setApprovalStatus as setExecApprovalStatus,
} from "./stage-execution-repository.js";

// Stage configuration, utilities, and isStageDisabled now in pipeline-config.ts
export type { StageConfig, ProjectStageConfig } from "./pipeline-config.js";
export { isStageDisabled } from "./pipeline-config.js";

// ─── SERVICE ────────────────────────────────────────────────────

export class PipelineService {
  // Config/lookup methods delegated to pipeline-config.ts standalone functions.
  // Routes that call pipelineService.getPipelineRun() etc. should migrate to
  // importing from pipeline-config.ts directly.
  getStageConfig = getStageConfig;
  getNextStage = getNextStage;
  getPreviousStage = getPreviousStage;
  getPipelineRun = getPipelineRun;

  /**
   * Create a new pipeline run for a project, or return existing active run.
   */
  async createRun(
    projectId: string,
    initiatedBy: string,
    options?: { budgetCents?: number },
  ): Promise<string> {
    // Return most recent active or completed run (prevents duplicate runs on page refresh).
    // Priority: running/pending first, then completed (so the UI shows results).
    const existingRun = await db.query.pipelineRuns.findFirst({
      where: and(
        eq(pipelineRuns.project_id, projectId),
        inArray(pipelineRuns.status, ["pending", "running"]),
      ),
      orderBy: (table, { desc }) => [desc(table.started_at)],
    });

    if (existingRun) {
      return existingRun.id;
    }

    // If no active run, return the most recent completed run
    // so the UI can display previous results instead of creating an empty run.
    const completedRun = await db.query.pipelineRuns.findFirst({
      where: and(
        eq(pipelineRuns.project_id, projectId),
        inArray(pipelineRuns.status, ["completed"]),
      ),
      orderBy: (table, { desc }) => [desc(table.started_at)],
    });

    if (completedRun) {
      return completedRun.id;
    }

    const runId = crypto.randomUUID();
    const stageProgress: Record<string, unknown> = {};

    for (const stage of PIPELINE_STAGES) {
      stageProgress[stage.name] = {
        status: "pending",
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

    // Housekeeping: keep only the last 5 runs per project, delete older ones.
    // This prevents unbounded data growth from repeated pipeline runs.
    try {
      const allRuns = await db.query.pipelineRuns.findMany({
        where: eq(pipelineRuns.project_id, projectId),
        orderBy: (table, { desc }) => [desc(table.created_at)],
        columns: { id: true },
      });
      if (allRuns.length > 5) {
        const idsToDelete = allRuns.slice(5).map(r => r.id);
        // Delete related data first, then the runs themselves.
        // Uses raw SQL for tables that may or may not exist yet (safe with IF EXISTS).
        for (const oldId of idsToDelete) {
          await db.execute(sql`DELETE FROM stage_artifacts WHERE pipeline_run_id = ${oldId}`);
          await db.execute(sql`DELETE FROM approval_gates WHERE pipeline_run_id = ${oldId}`);
          await db.execute(sql`DELETE FROM llm_usage WHERE pipeline_run_id = ${oldId}`);
          await db.execute(sql`DELETE FROM stage_runs WHERE pipeline_run_id = ${oldId}`);
          await db.execute(sql`DELETE FROM stage_execution_logs WHERE pipeline_run_id = ${oldId}`);
          await db.execute(sql`DELETE FROM agent_subtasks WHERE pipeline_run_id = ${oldId}`);
          await db.execute(sql`DELETE FROM pipeline_runs WHERE id = ${oldId}`);
        }
        console.log(`[Pipeline] Cleaned up ${idsToDelete.length} old runs for project ${projectId}`);
      }
    } catch (cleanupErr) {
      // Non-fatal — don't block run creation
      console.warn('[Pipeline] Run cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    }

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
    options?: ExecuteStageOptions,
  ): Promise<StageRunResult> {
    // ─── Common setup (project context, agents, LLM fns, BYOK) ──
    const ctx = await prepareStageExecution(pipelineRunId, stageName, templateVars, options);

    if (!ctx) {
      // Stage is disabled — return skipped result
      const stageConfig = getStageConfig(stageName);
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

    const { run, proj, stageConfig, projectContext, projectCredentials,
      priorOutputs, feedback, agentCtx, agentExec, modelName, maxTokens: configuredMaxTokens,
      promptOverride, effectiveModel } = ctx;
    let { llmCallFn, reviewerLlmCallFn } = ctx;
    const llmEvalFn = ctx.llmEvalFn;

    // For SCAN stage — run real file analysis on the codebase
    if (stageName === PipelineStageName.SCAN) {
      const sourceType = proj.source_type;
      const sourceUrl = proj.source_url || proj.repository_url;

      if (sourceType && sourceUrl) {
        const stageIdx = stageConfig.index;
        // Read access token from project settings (for private repos)
        const projectSettings = proj.settings;
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
                  // Ground truth data for downstream stages
                  frameworkVersions: fileAnalysis.frameworkVersions || [],
                  componentCounts: fileAnalysis.componentCounts || [],
                  migrationStats: fileAnalysis.migrationStats || null,
                  largestFiles: fileAnalysis.largestFiles?.slice(0, 15) || [],
                  filesByExtension: fileAnalysis.filesByExtension || {},
                  linesByExtension: fileAnalysis.linesByExtension || {},
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
          // language detection, complexity analysis, and component discovery.
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

              console.log(`[Pipeline] BREE input: ${fileAnalysis.codebasePath ? `path=${fileAnalysis.codebasePath}` : `${(fileAnalysis.codeSnippets || []).length} code snippets`}`);
              const breeCtx = await breeFullContext(breeInput);
              console.log(`[Pipeline] BREE result: online=${breeCtx.online}, requirements=${breeCtx.requirements?.documents?.length || 0}, scan=${breeCtx.scanResult ? 'yes' : 'no'}, graph=${breeCtx.graphAnalysis ? 'yes' : 'no'}`);

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

    // ─── SCAN MULTI-AGENT ORCHESTRATION ─────────────────────────
    // For SCAN stage with file analysis available, use the multi-agent
    // orchestrator: Scout → Director → Specialists → Composition.
    if (stageName === PipelineStageName.SCAN && projectContext.fileAnalysis) {
      const scanResult = await orchestrateScanStage({
        pipelineRunId,
        projectContext,
        fileAnalysis: projectContext.fileAnalysis as any,
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: options?.onDelta,
        signal: options?.signal,
        model: modelName,
        composerModel: options?.composerModel || modelName,
        maxTokens: options?.maxTokens,
        credentials: projectCredentials,
      });

      // Finalize: store output, record agent, track usage, update progress, emit events
      await finalizeStageResult({
        pipelineRunId, projectId: run.project.id, stageName, stageIndex: stageConfig.index,
        result: scanResult, modelName, agentCtx, agentExec, onEvent: options?.onEvent,
      });

      if (scanResult.output) {
        // Auto-populate tailored prompts for stages 2-8 based on SCAN + BREE output.
        // These prompts reference specific components, patterns, and risks found in SCAN,
        // making subsequent stages contextual to this codebase instead of generic.
        try {
          const { generateAndSaveProjectPrompts } = await import("./prompt-generator.js");
          const { stagesPopulated } = await generateAndSaveProjectPrompts(run.project.id, pipelineRunId);
          console.log(`[Pipeline] Auto-generated tailored prompts for ${stagesPopulated} stages based on SCAN findings`);
          options?.onEvent?.({
            phase: 'phase' as any,
            stageName,
            stageIndex: stageConfig.index,
            timestamp: new Date().toISOString(),
            data: { phase: 'prompts_generated', message: `Generated tailored prompts for ${stagesPopulated} stages based on SCAN findings`, stagesPopulated },
          });
        } catch (err: unknown) {
          console.warn("[Pipeline] Prompt auto-generation failed (non-fatal):", err instanceof Error ? err.message : err);
          options?.onEvent?.({
            phase: 'phase' as any,
            stageName,
            stageIndex: stageConfig.index,
            timestamp: new Date().toISOString(),
            data: { phase: 'prompts_generation_failed', message: `Prompt generation failed: ${err instanceof Error ? err.message : 'unknown error'}`, warning: true },
          });
        }
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
        throw new ValidationError("Cannot execute DECODE: Stage 1 (SCAN) output not found. Please run and approve SCAN first.");
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
        composerModel: options?.composerModel,
        maxTokens: configuredMaxTokens,
        credentials: projectCredentials,
      });

      // Finalize: store output, record agent, track usage, update progress, emit events
      await finalizeStageResult({
        pipelineRunId, projectId: run.project.id, stageName, stageIndex: stageConfig.index,
        result: decodeResult, modelName, agentCtx, agentExec, onEvent: options?.onEvent,
      });

      return decodeResult;
    }

    // ─── FORGE CODE GENERATION ORCHESTRATION ────────────────────
    if (stageName === PipelineStageName.FORGE) {
      const forgeResult = await orchestrateForgeStage({
        pipelineRunId,
        projectContext,
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: options?.onDelta,
        signal: options?.signal,
        model: modelName,
        maxTokens: configuredMaxTokens,
        credentials: projectCredentials,
      });

      // Finalize: store output, record agent, track usage, update progress, emit events
      await finalizeStageResult({
        pipelineRunId, projectId: run.project.id, stageName, stageIndex: stageConfig.index,
        result: forgeResult, modelName, agentCtx, agentExec, onEvent: options?.onEvent,
      });

      return forgeResult;
    }

    // Auto-enrich templateVars with source/scan context so ARCHITECT and other
    // stages can see ALL discovered components (prevents frontend dropout).
    const enrichedTemplateVars = { ...templateVars };
    if (!enrichedTemplateVars.sourceLanguages) {
      enrichedTemplateVars.sourceLanguages = projectContext.sourceLanguages.join(", ");
    }
    if (!enrichedTemplateVars.scanOutput) {
      const scanPrior = priorOutputs.find(o => o.stageName === "SCAN");
      if (scanPrior?.output) {
        // Include enough of SCAN output to preserve component discovery
        enrichedTemplateVars.scanOutput = scanPrior.output.length > 16000
          ? scanPrior.output.slice(0, 16000) + "\n\n[... SCAN output truncated ...]"
          : scanPrior.output;
      }
    }

    // ── CHUNKED MULTI-PASS GENERATION ──────────────────────────────
    // Always use chunked generation with gap-fill for BLUEPRINT, SPEC_LOCK, ARCHITECT
    // to ensure comprehensive coverage of all entities/components.
    const entityPattern = /ALL\s+(\d+)\s+(?:Database\s+)?Entities|(\d+)\s+total/i;
    const entityMatch = (promptOverride || '').match(entityPattern);

    // Extract entity names from the prompt for chunking
    const entityListMatch = (promptOverride || '').match(/## ALL \d+ (?:Database )?Entities[^:]*:\s*\n([^#]+)/i);
    let promptEntities = entityListMatch
      ? entityListMatch[1].split(/[,\n]/).map(e => e.trim()).filter(e => e.length > 2 && !e.startsWith('-'))
      : [];

    // Also extract BR-{ids} and CAP-{ids} from prior stage outputs as entities to cover
    if (promptEntities.length === 0) {
      const priorText = priorOutputs.map(p => p.output).join('\n');
      const brIds = [...new Set((priorText.match(/BR-\d+/g) || []))];
      const capIds = [...new Set((priorText.match(/CAP-\d+/g) || []))];
      // Extract entity names from DECODE tables
      const entityNames = [...new Set((priorText.match(/(?:^|\|)\s*([A-Z][a-zA-Z]+(?:Service|Controller|Model|Entity|Module|Manager|Handler|Repository))\s*(?:\||$)/gm) || [])
        .map(m => m.replace(/\|/g, '').trim())
        .filter(n => n.length > 3))];
      promptEntities = [...brIds, ...capIds, ...entityNames];
    }

    // Always use chunked runner when we have entities to cover (no minimum threshold)
    if (promptEntities.length > 0) {
      // Use chunked runner for comprehensive coverage
      options?.onEvent?.({
        phase: 'generating',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: { message: `Using chunked generation for ${promptEntities.length} entities`, chunked: true },
      });

      const { runChunkedStage } = await import("@revamp/core-engine");

      // Build chunk-specific prompt template
      const stagePrompts = (run.project as any).stage_prompts as Record<string, string> || {};
      // Support both stage-name keys (new) and numeric-index keys (legacy DB data)
      const basePrompt = stagePrompts[stageName] || stagePrompts[String(stageConfig.index)] || promptOverride || '';

      const priorContext = priorOutputs.map(p => `## ${p.stageName} Output (excerpt):\n${p.output.slice(0, 8000)}`).join('\n\n');

      const chunkedResult = await runChunkedStage({
        stageName,
        systemPrompt: `You are performing ${stageName} analysis for a legacy application modernization. Be thorough — cover EVERY entity listed.`,
        userPromptTemplate: `${basePrompt}\n\n## FOCUS: Analyze ONLY these specific entities in this chunk:\n{{CHUNK_ENTITIES}}\n\n{{CHUNK_CONTEXT}}\n\n## Prior Stage Context:\n{{SHARED_CONTEXT}}`,
        compositionPrompt: `Compose the final ${stageName} document from the following analysis chunks. CONSOLIDATE duplicates. Use tables. Ensure EVERY entity is covered.\n\nCoverage: {{COVERAGE_PERCENT}}% ({{COVERED_ENTITIES}}/{{TOTAL_ENTITIES}} entities)\n\n{{CHUNK_RESULTS}}`,
        allEntities: promptEntities,
        sharedContext: priorContext,
        chunkSize: 8,
        llmCallFn,
        coverageTarget: 0.85,
        maxGapFillRounds: 2,
        onProgress: (phase, message, data) => {
          options?.onEvent?.({
            phase: phase as any,
            stageName,
            stageIndex: stageConfig.index,
            timestamp: new Date().toISOString(),
            data: { message, ...data },
          });
        },
        onDelta: options?.onDelta,
        signal: options?.signal,
      });

      // Convert to StageRunResult format
      const result: StageRunResult = {
        stageName,
        stageIndex: stageConfig.index,
        output: chunkedResult.output,
        validation: null,
        refinementCount: 0,
        duration: chunkedResult.duration,
        phases: [],
        aborted: false,
      };

      // Store result
      if (result.output) {
        await storeStageOutput(pipelineRunId, stageName, result);
      }

      // Record token usage (estimated from content sizes)
      try {
        const estimatedInputTokens = Math.round((result.output?.length || 0) / 4);
        const estimatedOutputTokens = Math.round((result.output?.length || 0) / 4);
        if (estimatedOutputTokens > 0) {
          const cost = estimateCostCents(estimatedInputTokens, estimatedOutputTokens, modelName);
          await recordPipelineSpend(pipelineRunId, cost);
          await db.insert(llmUsage).values({
            id: crypto.randomUUID(), project_id: run.project.id, pipeline_run_id: pipelineRunId,
            model: modelName || "unknown", input_tokens: estimatedInputTokens, output_tokens: estimatedOutputTokens, cost: Math.round(cost),
          });
          options?.onEvent?.({ phase: 'usage' as any, stageName, stageIndex: stageConfig.index, timestamp: new Date().toISOString(),
            data: { input_tokens: estimatedInputTokens, output_tokens: estimatedOutputTokens, cost },
          });
        }
      } catch { /* non-fatal */ }

      // Update stage progress via stage_executions
      if (result.output) {
        const score = chunkedResult.coverage.percentage;
        const config = getStageConfig(stageName);
        emitStageCompleted({ pipelineRunId, projectId: run.project.id, stageName, duration: chunkedResult.duration, confidenceScore: score });
        // Complete the execution in stage_executions
        const latestExecChunk = await getLatestExecution(pipelineRunId, stageName);
        if (latestExecChunk && latestExecChunk.status === 'running') {
          await completeStageExecution({
            executionId: latestExecChunk.id,
            output: result.output,
            validation: result.validation ? {
              passed: result.validation.passed,
              confidenceScore: result.validation.confidenceScore,
            } : undefined,
          }).catch(() => {});
          // If stage requires approval, set execution to pending approval
          if (config.requiresApproval) {
            await setExecApprovalStatus(pipelineRunId, stageName, "pending").catch(() => {});
          }
        }
      } else {
        emitStageFailed({ pipelineRunId, projectId: run.project.id, stageName, error: `${stageName} chunked generation produced no output` });
        // Fail the execution in stage_executions
        const latestExecFail = await getLatestExecution(pipelineRunId, stageName);
        if (latestExecFail && latestExecFail.status === 'running') {
          await failStageExecution({ executionId: latestExecFail.id, errorMessage: `${stageName} chunked generation produced no output` }).catch(() => {});
        }
      }

      return result;
    }

    // ── STANDARD SINGLE-PASS GENERATION ─────────────────────────────
    // Execute stage — with fallback chain.
    // Safety net: accumulate all streamed text in case result.output is empty
    let serviceAccumulatedOutput = "";
    const wrappedOnDelta = (text: string) => {
      serviceAccumulatedOutput += text;
      options?.onDelta?.(text);
    };

    let result: StageRunResult;
    try {
      result = await runStage({
        project: projectContext,
        stageName,
        stageIndex: stageConfig.index,
        pipelineRunId,
        templateVars: enrichedTemplateVars,
        llmCallFn,
        llmEvalFn,
        reviewerLlmCallFn,
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: wrappedOnDelta,
        signal: options?.signal,
        skipLlmEval: options?.skipLlmEval,
        promptOverride,
        model: modelName,
      });

      // If output is empty but we streamed text, use the accumulated text
      if (!result.output && serviceAccumulatedOutput.length > 20) {
        console.warn(`[PipelineService] result.output empty but ${serviceAccumulatedOutput.length} chars streamed — recovering`);
        // Re-run deterministic validation on recovered output
        let recoveredValidation = result.validation;
        try {
          const { runAllDeterministicChecks, stageValidationRules } = await import("@revamp/core-engine");
          const rule = stageValidationRules.find((r: any) => r.stageName === stageName);
          if (rule) {
            const { results: detResults, aggregateScore } = runAllDeterministicChecks(serviceAccumulatedOutput, rule.deterministicChecks);
            const recoveredScore = Math.round(aggregateScore * 100);
            recoveredValidation = {
              ...result.validation,
              passed: recoveredScore >= 60,
              confidenceScore: recoveredScore,
              deterministicResults: detResults,
              llmResults: [],
              issues: [],
              recommendations: [],
            } as any;
            console.log(`[PipelineService] Recovered validation score: ${recoveredScore}%`);
          }
        } catch { /* non-fatal */ }
        result = { ...result, output: serviceAccumulatedOutput, validation: recoveredValidation };
      }
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
        templateVars: enrichedTemplateVars,
        llmCallFn,
        // Fallback retry — keep validation and review active
        llmEvalFn: undefined,
        reviewerLlmCallFn: undefined,
        priorOutputs,
        feedback,
        onEvent: options?.onEvent,
        onDelta: options?.onDelta,
        signal: options?.signal,
        skipLlmEval: false,
        skipReview: false,
        promptOverride,
        model: modelName,
      });
    }

    // ─── Contract enforcement + auto-refinement ───────────────────
    if (result.output) {
      // Pass LLM function for agent-based section validation (all stages)
      const contractResult = await enforceContract(stageName, result.output, undefined, llmCallFn as any);

      if (!contractResult.passed && contractResult.refinementPrompt) {
        const maxPasses = contractResult.violations.some((v) => v.severity === 'critical') ? 2 : 1;

        for (let pass = 0; pass < maxPasses; pass++) {
          options?.onEvent?.({
            phase: 'contract_refinement',
            stageName,
            stageIndex: stageConfig.index,
            timestamp: new Date().toISOString(),
            data: {
              pass: pass + 1,
              maxPasses,
              violations: contractResult.violations.map((v) => v.description),
              completenessScore: contractResult.completenessScore,
            },
          });

          try {
            const refinedResult = await runStage({
              project: projectContext,
              stageName,
              stageIndex: stageConfig.index,
              pipelineRunId,
              templateVars: enrichedTemplateVars,
              llmCallFn,
              priorOutputs,
              feedback,
              onEvent: options?.onEvent,
              onDelta: options?.onDelta,
              signal: options?.signal,
              skipLlmEval: true,
              skipReview: true,
              promptOverride: `The previous output was incomplete. Fix ONLY the following gaps — keep all existing content and append the missing sections:\n\n${contractResult.refinementPrompt}\n\nPrevious output (keep and extend):\n${result.output}`,
              model: modelName,
            });

            if (refinedResult.output && refinedResult.output.length > result.output.length) {
              result = refinedResult;
              const recheck = await enforceContract(stageName, result.output);
              if (recheck.passed) break;
            } else {
              break; // Refinement didn't improve — stop
            }
          } catch {
            break; // Refinement failed — use what we have
          }
        }
      }

      // Log contract result
      if (!contractResult.passed) {
        console.warn(
          `[PipelineService] Contract violations for ${stageName}:`,
          contractResult.violations.map((v) => `[${v.severity}] ${v.description}`),
        );
      }
    }

    // Store result
    if (result.output) {
      await storeStageOutput(pipelineRunId, stageName, result);
    }

    // Record pipeline-level spend from token usage.
    // Primary source: llmCallFn.tokenUsage (accumulated from actual LLM responses).
    // Fallback: phase event data (may be empty for stages that don't emit token phases).
    try {
      const proxyTokens = (llmCallFn as any).tokenUsage as { inputTokens: number; outputTokens: number } | undefined;
      const stageInputTokens = proxyTokens?.inputTokens
        || result.phases?.reduce((s, p) => s + (Number(p.data?.inputTokens) || 0), 0)
        || 0;
      const stageOutputTokens = proxyTokens?.outputTokens
        || result.phases?.reduce((s, p) => s + (Number(p.data?.outputTokens) || 0), 0)
        || 0;
      if (stageInputTokens > 0 || stageOutputTokens > 0) {
        const cost = estimateCostCents(stageInputTokens, stageOutputTokens, modelName);
        await recordPipelineSpend(pipelineRunId, cost);

        // Enforce project-level budget (create incidents if thresholds crossed)
        try { await enforceProjectBudget(run.project.id); } catch { /* non-fatal */ }

        // Write to llmUsage table so dashboard/usage endpoints can display it
        await db.insert(llmUsage).values({
          id: crypto.randomUUID(),
          project_id: run.project.id,
          pipeline_run_id: pipelineRunId,
          model: modelName || "unknown",
          input_tokens: stageInputTokens,
          output_tokens: stageOutputTokens,
          cost: Math.round(cost),
        });
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
          try { await agentExec.complete(); } catch (e) { console.error("[PipelineService] Agent completion failed:", e); }
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
    await updateProjectMetrics(run.project.id, pipelineRunId, result);

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

    // Update stage progress based on validation results
    const validationPassed = result.validation?.passed ?? true;
    const confidenceScore = result.validation?.confidenceScore ?? 100;
    const contractHardGated = result.validation?.contractResult?.hardGated === true;
    const APPROVAL_THRESHOLD = 60; // Only create approval gate if score >= 60%

    // Contract hard-gate: if structural requirements are critically missing,
    // block the stage regardless of LLM confidence score.
    if (contractHardGated) {
      const violations = result.validation?.contractResult?.violations?.length ?? 0;
      console.warn(`[Pipeline] ${stageName} hard-gated by contract: ${violations} violations`);
    }

    // Every stage that produces output gets an approval gate — even with low confidence.
    // The confidence score tells the reviewer "this needs extra scrutiny" but the output
    // still exists and might be useful. Only contract hard-gates block completely.
    if (contractHardGated) {
      // Hard-gated: critical structural requirements missing. Stage FAILS, no approval gate.
      emitValidationFailed({
        pipelineRunId, projectId: run.project.id, stageName,
        violations: result.validation?.issues?.length || 0,
        hardGated: true,
      });
      // Fail the execution in stage_executions
      const latestExec = await getLatestExecution(pipelineRunId, stageName);
      if (latestExec && latestExec.status === 'running') {
        await failStageExecution({ executionId: latestExec.id, errorMessage: `Contract hard-gated: ${result.validation?.contractResult?.violations?.length ?? 0} violations` }).catch(() => {});
      }
    } else {
      // Stage completed — create approval gate regardless of confidence score.
      // Low confidence = reviewer must scrutinize. High confidence = routine approval.
      const currentConfig = getStageConfig(stageName);
      const nextStage = getNextStage(stageName);

      // Mark pipeline as completed if this was the last stage
      if (!nextStage) {
        await db.update(pipelineRuns).set({
          status: "completed",
          completed_at: new Date(),
          updated_at: new Date(),
        }).where(eq(pipelineRuns.id, pipelineRunId));
      }

      emitStageCompleted({
        pipelineRunId,
        projectId: run.project.id,
        stageName,
        duration: 0,
        confidenceScore,
      });

      // Complete the execution in stage_executions
      const latestExec = await getLatestExecution(pipelineRunId, stageName);
      if (latestExec && latestExec.status === 'running') {
        await completeStageExecution({
          executionId: latestExec.id,
          output: result.output,
          validation: result.validation ? {
            passed: result.validation.passed,
            confidenceScore: result.validation.confidenceScore,
            issues: result.validation.issues,
            recommendations: result.validation.recommendations,
          } : undefined,
        }).catch(() => {});
        // If stage requires approval, set execution to pending approval
        if (currentConfig.requiresApproval) {
          await setExecApprovalStatus(pipelineRunId, stageName, "pending").catch(() => {});
        }
      }

      if (!nextStage) {
        pipelineEventBus.fire({
          type: "pipeline.completed",
          timestamp: new Date().toISOString(),
          pipelineRunId,
          projectId: run.project.id,
          data: { finalStage: stageName },
        });
      }
    }

    return result;
  }

  // ─── Operations delegated to pipeline-operations.ts ────────────
  advanceStage = advanceStageOp;
  approveGate = approveGateOp;
  rejectGate = rejectGateOp;
  resetRunStatus = resetRunStatusOp;
  failStage = failStageOp;
  addArtifact = addArtifactOp;
  refineSection = refineSectionOp;
  chat = chatOp;
}

export const pipelineService = new PipelineService();
