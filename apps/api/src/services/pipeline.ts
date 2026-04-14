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

import { db, type DbConnection } from "@/db/index.js";
import { pipelineRuns, approvalGates, stageArtifacts, llmUsage, projects } from "@/db/schema.js";
import { NotFoundError, ForbiddenError, ValidationError } from "@/errors.js";
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
  updateStageProgress,
  createApprovalGate,
  storeStageOutput,
  loadPriorStageOutputs,
  loadUserFeedback,
  updateProjectMetrics,
} from "./pipeline-repository.js";
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
// context-tiering now used by pipeline-repository.ts
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

// ─── PROJECT ROW TYPE (from Drizzle `with: { project: true }`) ──
// Drizzle's inferred type omits 10X-specific columns from the relation result.
// This interface matches the actual DB row shape returned by the query.
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
  [key: string]: unknown; // allow additional fields
}

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
    options?: {
      onEvent?: OnStageEvent;
      onDelta?: OnDelta;
      signal?: AbortSignal;
      skipLlmEval?: boolean;
      /** Override execution model */
      model?: string;
      /** Override director/composition model */
      composerModel?: string;
      /** Override evaluator model */
      evaluatorModel?: string;
      /** Max output tokens (scales depth for larger codebases) */
      maxTokens?: number;
      /** Override stage prompt for this execution (re-run with edited prompt) */
      promptOverride?: string;
      /** Validation feedback from previous run — appended to prompt context */
      validationFeedback?: Array<{ name: string; passed: boolean; score: number; feedback: string; severity?: string }>;
    },
  ): Promise<StageRunResult> {
    const run = await getPipelineRun(pipelineRunId);
    if (!run) throw new NotFoundError("Pipeline run not found");
    if (!run.project) throw new NotFoundError("Project not found for pipeline run");

    const stageConfig = getStageConfig(stageName);

    // Check if stage is disabled in project config
    const proj = run.project as ProjectRow;
    const projectConfig = proj.config;
    if (isStageDisabled(stageName, projectConfig)) {
      options?.onEvent?.({
        phase: 'completed',
        stageName,
        stageIndex: stageConfig.index,
        timestamp: new Date().toISOString(),
        data: { skipped: true, reason: 'Stage disabled in project configuration' },
      });

      await updateStageProgress(pipelineRunId, stageName, "skipped", 100);

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
    const projectContext: ProjectContext & { stagePrompts?: Record<string, string>; validationPrompts?: Record<string, string> } = {
      projectId: proj.id,
      projectName: proj.name,
      description: proj.description || "",
      codebaseSource: proj.source_url || proj.repository_url || "uploaded",
      sourceLanguages: proj.source_languages || ["unknown"],
      targetStack: proj.target_stack || "Java/Spring Boot",
      targetCloud: proj.target_cloud || undefined,
    };
    // Attach stage prompts for validation (prompt-derived validation needs these)
    const rawStagePrompts = proj.stage_prompts || {};
    const rawValidationPrompts = proj.validation_prompts || {};
    projectContext.stagePrompts = rawStagePrompts;
    projectContext.validationPrompts = rawValidationPrompts;

    // For stages 2-8: reload SCAN's file analysis ground truth from stored artifact
    // so downstream stages have verified versions, component counts, and migration stats.
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

    // Load prior stage outputs from artifacts (tiered context with observable trajectory)
    const { outputs: priorOutputs, trajectoryMeta } = await loadPriorStageOutputs(pipelineRunId, stageName);

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
    const feedback = await loadUserFeedback(pipelineRunId, stageConfig.index);

    // Update stage progress
    await updateStageProgress(pipelineRunId, stageName, "in_progress", 0);

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

    // Load prompt override: prefer per-request override (re-run with edited prompt),
    // then fall back to project-level override (set via Settings page).
    const stagePrompts = (run.project as any).stage_prompts as Record<string, string> | null;
    // Support both stage-name keys (new) and numeric-index keys (prompt-generator uses numeric)
    let promptOverride = options?.promptOverride
      || stagePrompts?.[stageName]
      || stagePrompts?.[String(stageConfig.index)]
      || undefined;

    // Append validation feedback from previous run to the prompt so the LLM can address issues
    if (options?.validationFeedback && options.validationFeedback.length > 0) {
      const failedFindings = options.validationFeedback.filter(f => !f.passed);
      if (failedFindings.length > 0) {
        const feedbackBlock = failedFindings.map(f =>
          `- [${(f.severity || 'warning').toUpperCase()}] ${f.name}: ${f.feedback}`
        ).join('\n');
        const feedbackPrompt = `\n\n--- VALIDATION FEEDBACK FROM PREVIOUS RUN ---\nThe previous output had the following issues. Please address ALL of them in this run:\n${feedbackBlock}\n--- END VALIDATION FEEDBACK ---`;
        promptOverride = (promptOverride || '') + feedbackPrompt;
      }
    }

    // Create LLM call and eval functions — with optional model overrides.
    // If an agent was assigned, prefer the agent's model configuration.
    const modelName = options?.model
      || process.env.LLM_DEFAULT_MODEL
      || agentCtx?.preferredModel
      || "";
    // Read maxTokens: per-request override > project settings > default 32768
    const projectSettings = (run.project as any).settings as Record<string, unknown> | null;
    const configuredMaxTokens = options?.maxTokens || (projectSettings?.maxTokens as number) || 32768;

    // BYOK: extract per-project LLM provider credentials.
    // The frontend saves providers under camelCase key "llmProviders" with credentials
    // in the "api_key_encrypted" field. For Bedrock, this is a JSON string containing
    // {accessKeyId, secretAccessKey, sessionToken, region}.
    let projectCredentials: import("@/services/llm-proxy.js").ProjectCredentials | undefined;
    const llmProviders = (
      (projectSettings?.llmProviders as Record<string, unknown>[])
      || (projectSettings?.llm_providers as Record<string, unknown>[])
      || []
    );
    if (llmProviders.length > 0) {
      // Find the default provider, or the first one
      const defaultProvider = llmProviders.find((p: any) => p.is_default) || llmProviders[0];
      const ptype = (defaultProvider as any).provider_type as string;
      const apiKeyField = (defaultProvider as any).api_key_encrypted as string || "";

      projectCredentials = { provider: ptype };
      if (ptype === "bedrock") {
        // Bedrock credentials can be:
        //   1. Bearer token as JSON: {"bearerToken":"...", "region":"us-east-2"}
        //   2. IAM keys JSON: {accessKeyId, secretAccessKey, region}
        //   3. SSO profile JSON: {"ssoProfile":"my-profile", "region":"us-east-2"}
        //   4. Empty/none — uses AWS default credential chain (SSO, instance role, env)
        let bearerToken: string | undefined;
        let parsed: Record<string, string> | undefined;

        if (typeof apiKeyField === "string" && apiKeyField.startsWith("{")) {
          try {
            parsed = JSON.parse(apiKeyField);
            bearerToken = parsed?.bearerToken || parsed?.bearer_token || parsed?.apiKey || parsed?.api_key;
          } catch {
            console.warn("[Pipeline] Failed to parse Bedrock credentials from api_key_encrypted");
          }
        } else if (typeof apiKeyField === "string" && apiKeyField.length > 10) {
          bearerToken = apiKeyField;
        }

        if (bearerToken) {
          projectCredentials.aws_bearer_token = bearerToken;
          projectCredentials.aws_region = parsed?.region || parsed?.aws_region || "us-east-2";
        } else if (parsed?.ssoProfile || parsed?.sso_profile) {
          // SSO profile — Go orchestrator uses AWS default credential chain with this profile
          projectCredentials.aws_sso_profile = parsed.ssoProfile || parsed.sso_profile || "";
          projectCredentials.aws_region = parsed.region || parsed.aws_region || "us-east-2";
        } else if (parsed?.accessKeyId || parsed?.aws_access_key_id) {
          projectCredentials.aws_access_key_id = parsed.accessKeyId || parsed.aws_access_key_id || "";
          projectCredentials.aws_secret_access_key = parsed.secretAccessKey || parsed.aws_secret_access_key || "";
          projectCredentials.aws_session_token = parsed.sessionToken || parsed.aws_session_token || "";
          projectCredentials.aws_region = parsed.region || parsed.aws_region || "us-east-2";
        } else {
          // No explicit credentials — let Go orchestrator use default credential chain
          projectCredentials.aws_region = parsed?.region || parsed?.aws_region || "us-east-2";
        }
      } else if (ptype === "anthropic") {
        projectCredentials.anthropic_api_key = apiKeyField;
      } else if (ptype === "openai") {
        projectCredentials.openai_api_key = apiKeyField;
        const baseUrl = (defaultProvider as any).base_url as string;
        if (baseUrl) projectCredentials.openai_endpoint = baseUrl;
      } else if (ptype === "gemini") {
        projectCredentials.gemini_api_key = apiKeyField;
      } else if (ptype === "vertexai") {
        try {
          const parsed = JSON.parse(apiKeyField);
          projectCredentials.vertex_ai_project_id = parsed.projectId || parsed.project_id || "";
          projectCredentials.vertex_ai_location = parsed.location || "us-central1";
          if (parsed.serviceAccountJson || parsed.service_account_json) {
            const saJson = parsed.serviceAccountJson || parsed.service_account_json;
            projectCredentials.vertex_ai_service_account_json =
              typeof saJson === "string" ? saJson : JSON.stringify(saJson);
          }
          if (parsed.accessToken || parsed.access_token) {
            projectCredentials.vertex_ai_access_token = parsed.accessToken || parsed.access_token;
          }
        } catch {
          // Non-JSON — treat as access token
          projectCredentials.vertex_ai_access_token = apiKeyField;
        }
      } else if (ptype === "azure") {
        try {
          const parsed = JSON.parse(apiKeyField);
          projectCredentials.azure_endpoint = parsed.endpoint || "";
          projectCredentials.azure_api_version = parsed.apiVersion || parsed.api_version || "2024-12-01-preview";
          projectCredentials.azure_deployments = parsed.deployments || "";
          if (parsed.apiKey || parsed.api_key) {
            projectCredentials.azure_api_key = parsed.apiKey || parsed.api_key;
          }
          if (parsed.adToken || parsed.ad_token) {
            projectCredentials.azure_ad_token = parsed.adToken || parsed.ad_token;
          }
        } catch {
          // Non-JSON — treat as API key (endpoint must be in base_url)
          projectCredentials.azure_api_key = apiKeyField;
          const baseUrl = (defaultProvider as any).base_url as string;
          if (baseUrl) projectCredentials.azure_endpoint = baseUrl;
        }
      }
    }

    // ─── ADVISOR TOOL (Anthropic-only; Bedrock/OpenAI silently ignore) ──
    // Per-stage config: enable Opus advisor for strategic/synthesis phases.
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
    const advisorEnabled = process.env.ADVISOR_ENABLED !== 'false';
    const stageAdvisor = advisorEnabled ? STAGE_ADVISOR_CONFIG[stageName] : undefined;
    const advisorConfig = stageAdvisor?.enabled ? {
      enabled: true,
      model: 'claude-opus-4-6',
      max_uses: stageAdvisor.max_uses,
    } : undefined;

    // For generic stages (BLUEPRINT through EVOLVE), the composer model
    // is used as the main generation model for higher quality output.
    // For orchestrated stages (SCAN, DECODE, FORGE), the composer model
    // is passed separately to the orchestrator.
    const effectiveModel = options?.composerModel || modelName;
    const skipAdvisor = /opus/i.test(effectiveModel); // Don't double-pay if already Opus
    let llmCallFn: LLMCallFn = llmProxyService.createCallFn({
      maxTokens: configuredMaxTokens,
      model: effectiveModel,
      credentials: projectCredentials,
      advisor: skipAdvisor ? undefined : advisorConfig,
    });
    const llmEvalFn = options?.skipLlmEval
      ? undefined
      : llmProxyService.createEvalFn({ model: options?.evaluatorModel, credentials: projectCredentials });

    // Reviewer LLM — uses the evaluator model (different from generator to avoid
    // self-validation bias). This enables the full multi-agent loop:
    // Generate -> Review -> Refine -> Validate
    //
    // hasValidationModel() check: verify the evaluator model resolves to a
    // configured provider with credentials before attempting dual-model flow.
    // Without this, the reviewer step fails silently. Ported from legacy-bridge.
    let reviewerLlmCallFn: LLMCallFn | undefined;
    const wantedEvaluatorModel = options?.evaluatorModel
      || agentCtx?.evaluatorModel
      || process.env.LLM_EVALUATOR_MODEL;
    if (wantedEvaluatorModel) {
      const hasEvalModel = await llmProxyService.hasValidationModel();
      if (hasEvalModel) {
        reviewerLlmCallFn = llmProxyService.createCallFn({
          maxTokens: 2048,
          model: wantedEvaluatorModel,
          credentials: projectCredentials,
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

      // Store result + record agent completion (reuse existing flow below)
      if (scanResult.output) {
        await storeStageOutput(pipelineRunId, stageName, scanResult);
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
          try { await agentExec.complete(); } catch (e) { console.error("[PipelineService] Agent completion failed:", e); }
        }
      }

      // Record token usage from SCAN orchestration (estimated from content sizes)
      try {
        const estimatedInputTokens = Math.round((scanResult.phases?.reduce((s: number, p: any) => s + (JSON.stringify(p.data || '').length), 0) || 4000) / 4);
        const estimatedOutputTokens = Math.round((scanResult.output?.length || 0) / 4);
        if (estimatedOutputTokens > 0) {
          const cost = estimateCostCents(estimatedInputTokens, estimatedOutputTokens, modelName);
          await recordPipelineSpend(pipelineRunId, cost);
          await db.insert(llmUsage).values({
            id: crypto.randomUUID(),
            project_id: run.project.id,
            pipeline_run_id: pipelineRunId,
            model: modelName || "unknown",
            input_tokens: estimatedInputTokens,
            output_tokens: estimatedOutputTokens,
            cost: Math.round(cost),
          });
          // Emit usage event for frontend
          options?.onEvent?.({
            phase: 'usage' as any,
            stageName,
            stageIndex: stageConfig.index,
            timestamp: new Date().toISOString(),
            data: { input_tokens: estimatedInputTokens, output_tokens: estimatedOutputTokens, cost },
          });
        }
      } catch { /* non-fatal */ }

      // Update stage progress + create approval gate
      if (scanResult.output) {
        const scanScore = scanResult.validation?.confidenceScore ?? 70;
        const scanConfig = getStageConfig(stageName);
        await db.transaction(async (tx) => {
          await updateStageProgress(pipelineRunId, stageName, "completed", 100, { conn: tx, confidenceScore: scanScore });
          if (scanConfig.requiresApproval) {
            await createApprovalGate(pipelineRunId, stageName, scanConfig.requiredRole || "admin", tx);
            await updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100, { conn: tx, confidenceScore: scanScore });
          }
        });
        emitStageCompleted({ pipelineRunId, projectId: run.project.id, stageName, duration: scanResult.duration, confidenceScore: scanScore });

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
      } else {
        await updateStageProgress(pipelineRunId, stageName, "failed", 0);
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

      // Store result
      if (decodeResult.output) {
        await storeStageOutput(pipelineRunId, stageName, decodeResult);
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
          try { await agentExec.complete(); } catch (e) { console.error("[PipelineService] Agent completion failed:", e); }
        }
      }

      // Record token usage from DECODE orchestration (estimated from content sizes)
      try {
        const estimatedInputTokens = Math.round((decodeResult.phases?.reduce((s: number, p: any) => s + (JSON.stringify(p.data || '').length), 0) || 4000) / 4);
        const estimatedOutputTokens = Math.round((decodeResult.output?.length || 0) / 4);
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

      // Update stage progress + create approval gate
      if (decodeResult.output) {
        const decodeScore = decodeResult.validation?.confidenceScore ?? 70;
        const decodeConfig = getStageConfig(stageName);
        await db.transaction(async (tx) => {
          await updateStageProgress(pipelineRunId, stageName, "completed", 100, { conn: tx, confidenceScore: decodeScore });
          if (decodeConfig.requiresApproval) {
            await createApprovalGate(pipelineRunId, stageName, decodeConfig.requiredRole || "admin", tx);
            await updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100, { conn: tx, confidenceScore: decodeScore });
          }
        });
        emitStageCompleted({ pipelineRunId, projectId: run.project.id, stageName, duration: decodeResult.duration, confidenceScore: decodeScore });
      } else {
        await updateStageProgress(pipelineRunId, stageName, "failed", 0);
        emitStageFailed({ pipelineRunId, projectId: run.project.id, stageName, error: "DECODE produced no output" });
      }

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

      if (forgeResult.output) {
        await storeStageOutput(pipelineRunId, stageName, forgeResult);
      }

      if (agentCtx && forgeResult.output) {
        try {
          await recordAgentCompletion(
            agentCtx,
            {
              costCents: 0,
              tokensUsed: 0,
              refinementCount: forgeResult.refinementCount,
              result: { orchestrated: true },
            },
            pipelineRunId,
            "auto",
            modelName || "default",
            0,
            0,
            PipelineStageName.FORGE,
          );
        } catch { /* non-fatal */ }
      }

      // Record token usage from FORGE orchestration (estimated from content sizes)
      try {
        const estimatedInputTokens = Math.round((forgeResult.phases?.reduce((s: number, p: any) => s + (JSON.stringify(p.data || '').length), 0) || 4000) / 4);
        const estimatedOutputTokens = Math.round((forgeResult.output?.length || 0) / 4);
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

      if (forgeResult.output) {
        const forgeScore = forgeResult.validation?.confidenceScore ?? 70;
        const forgeConfig = getStageConfig(stageName);
        await db.transaction(async (tx) => {
          await updateStageProgress(pipelineRunId, stageName, "completed", 100, { conn: tx, confidenceScore: forgeScore });
          if (forgeConfig.requiresApproval) {
            await createApprovalGate(pipelineRunId, stageName, forgeConfig.requiredRole || "admin", tx);
            await updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100, { conn: tx, confidenceScore: forgeScore });
          }
        });
        emitStageCompleted({ pipelineRunId, projectId: run.project.id, stageName, duration: forgeResult.duration, confidenceScore: forgeScore });
      } else {
        await updateStageProgress(pipelineRunId, stageName, "failed", 0);
        emitStageFailed({ pipelineRunId, projectId: run.project.id, stageName, error: "FORGE produced no output" });
      }

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

      // Update stage progress
      if (result.output) {
        const score = chunkedResult.coverage.percentage;
        const config = getStageConfig(stageName);
        await db.transaction(async (tx) => {
          await updateStageProgress(pipelineRunId, stageName, "completed", 100, { conn: tx, confidenceScore: score });
          if (config.requiresApproval) {
            await createApprovalGate(pipelineRunId, stageName, config.requiredRole || "admin", tx);
            await updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100, { conn: tx, confidenceScore: score });
          }
        });
        emitStageCompleted({ pipelineRunId, projectId: run.project.id, stageName, duration: chunkedResult.duration, confidenceScore: score });
      } else {
        await updateStageProgress(pipelineRunId, stageName, "failed", 0);
        emitStageFailed({ pipelineRunId, projectId: run.project.id, stageName, error: `${stageName} chunked generation produced no output` });
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
      await updateStageProgress(pipelineRunId, stageName, "failed", Math.round(confidenceScore));
      emitValidationFailed({
        pipelineRunId, projectId: run.project.id, stageName,
        violations: result.validation?.issues?.length || 0,
        hardGated: true,
      });
    } else {
      // Stage completed — create approval gate regardless of confidence score.
      // Low confidence = reviewer must scrutinize. High confidence = routine approval.
      const currentConfig = getStageConfig(stageName);
      const nextStage = getNextStage(stageName);

      await db.transaction(async (tx) => {
        await updateStageProgress(pipelineRunId, stageName, "completed", 100, { conn: tx, confidenceScore });

        if (currentConfig.requiresApproval) {
          await createApprovalGate(pipelineRunId, stageName, currentConfig.requiredRole || "admin", tx);
          await updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100, { conn: tx, confidenceScore });
        }

        if (!nextStage) {
          await tx.update(pipelineRuns).set({
            status: "completed",
            completed_at: new Date(),
            updated_at: new Date(),
          }).where(eq(pipelineRuns.id, pipelineRunId));
        }
      });

      emitStageCompleted({
        pipelineRunId,
        projectId: run.project.id,
        stageName,
        duration: 0,
        confidenceScore,
      });

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

  // ─── Repository methods moved to pipeline-repository.ts ─────────
  // loadPriorStageOutputs, loadUserFeedback, storeStageOutput,
  // updateStageProgress, createApprovalGate, updateProjectMetrics
  // are now standalone functions imported at the top of this file.

  /**
   * PLACEHOLDER — methods below this line are still in the class.
   */

  /** Delegate to standalone function for backward compat with route callers */
  async updateStageProgress(
    pipelineRunId: string, stageName: PipelineStageName, status: string, progress: number,
    options?: { conn?: DbConnection; confidenceScore?: number },
  ): Promise<void> {
    return updateStageProgress(pipelineRunId, stageName, status, progress, options);
  }

  /**
   * Advance pipeline to the next stage.
   */
  async advanceStage(pipelineRunId: string): Promise<void> {
    const run = await getPipelineRun(pipelineRunId);
    if (!run) throw new NotFoundError("Pipeline run not found");
    if (run.status !== "running") throw new ValidationError(`Cannot advance pipeline in ${run.status} state`);

    const currentStage = run.current_stage as PipelineStageName;
    const nextStage = getNextStage(currentStage);

    await db.transaction(async (tx) => {
      if (!nextStage) {
        await tx.update(pipelineRuns).set({
          status: "completed",
          completed_at: new Date(),
          updated_at: new Date(),
        }).where(eq(pipelineRuns.id, pipelineRunId));
        return;
      }

      await updateStageProgress(pipelineRunId, currentStage, "approved", 100, { conn: tx });
      await updateStageProgress(pipelineRunId, nextStage, "in_progress", 0, { conn: tx });

      await tx.update(pipelineRuns).set({
        current_stage: nextStage,
        updated_at: new Date(),
      }).where(eq(pipelineRuns.id, pipelineRunId));
    });
  }

  /**
   * Approve an approval gate and advance the pipeline.
   */
  async approveGate(
    pipelineRunId: string,
    stageName: PipelineStageName,
    approvedBy: string,
    comment?: string,
    /** Admin force-approve: bypass confidence threshold check */
    force?: boolean,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const gate = await tx.query.approvalGates.findFirst({
        where: and(
          eq(approvalGates.pipeline_run_id, pipelineRunId),
          eq(approvalGates.stage_name, stageName),
        ),
      });

      if (!gate) throw new NotFoundError("Approval gate not found");
      if (gate.status !== "pending") throw new ValidationError(`Gate already ${gate.status}`);

      // Confidence threshold check — block approval if validation score is below threshold
      const run = await tx.query.pipelineRuns.findFirst({
        where: eq(pipelineRuns.id, pipelineRunId),
        columns: { project_id: true, stage_progress: true },
      });
      if (run) {
        const project = await tx.query.projects.findFirst({
          where: eq(projects.id, run.project_id),
          columns: { settings: true },
        });
        const threshold = (project?.settings as any)?.confidenceThreshold ?? 75;
        const stageProgress = (run.stage_progress as Record<string, any>) || {};
        let stageScore = stageProgress[stageName]?.confidenceScore;

        if (typeof stageScore !== 'number' || stageScore === 0) {
          const valArtifact = await tx.query.stageArtifacts.findFirst({
            where: and(
              eq(stageArtifacts.pipeline_run_id, pipelineRunId),
              eq(stageArtifacts.stage_name, stageName),
              eq(stageArtifacts.artifact_type, "validation_result"),
            ),
          });
          if (valArtifact?.metadata) {
            stageScore = (valArtifact.metadata as any).confidenceScore ?? stageScore;
          }
        }

        if (typeof stageScore === 'number' && stageScore > 0 && stageScore < threshold && !force) {
          throw new ValidationError(
            `Cannot approve: confidence score ${stageScore}% is below the threshold of ${threshold}%. Re-run the stage to improve the score.`
          );
        }
      }

      await tx.update(approvalGates).set({
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

      await updateStageProgress(pipelineRunId, stageName, "approved", 100, { conn: tx });

      const nextStage = getNextStage(stageName);
      if (nextStage) {
        await tx.update(pipelineRuns).set({
          current_stage: nextStage,
        }).where(eq(pipelineRuns.id, pipelineRunId));
      } else {
        await tx.update(pipelineRuns).set({
          status: "completed",
          completed_at: new Date(),
        }).where(eq(pipelineRuns.id, pipelineRunId));
      }
    });
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
    await db.transaction(async (tx) => {
      await tx.update(approvalGates).set({
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

      await updateStageProgress(pipelineRunId, stageName, "rejected", 0, { conn: tx });
    });
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
   * Now in pipeline-repository.ts — standalone function.
   */

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
    const run = await getPipelineRun(pipelineRunId);
    if (!run) throw new NotFoundError("Pipeline run not found");

    // Load prior stage outputs using tiered context (L0/L1/L2)
    const order = getStageOrder();
    const { outputs: priorOutputs } = await loadPriorStageOutputs(
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
