/**
 * Scan Orchestrator — multi-agent delegation for Stage 1 (SCAN).
 *
 * Replaces the single-shot runStage() call with a controlled multi-step process:
 *   1. Scout Triage (Haiku/Flash) — fast JSON assessment of file analysis
 *   2. Director Planning (Sonnet) — chooses subtasks and assigns agents
 *   3. Subtask Execution (sequential) — specialists run focused analysis
 *   4. Composition (Sonnet) — merges all results into single SCAN document
 *
 * No silent fallbacks — every failure is surfaced to the user with re-run capability.
 */

import crypto from "crypto";
import { db } from "@/db/index.js";
import { stageArtifacts, agentSubtasks, agentPersonas } from "@/db/schema.js";
import { eq, and, or, isNull, inArray, asc } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import {
  type StageRunResult,
  type StagePhase,
  type StageEvent,
  type OnStageEvent,
  type OnDelta,
  type ProjectContext,
  type LLMCallFn,
  type StageOutput,
  type UserFeedback,
  runStage,
  enforceContract,
  runValidation,
  validateSubtaskOutput,
  SCAN_SCOUT_ASSESSMENT,
  SCAN_DIRECTOR_PLAN,
  SCAN_SUBTASK_TEMPLATES,
  SCAN_COMPOSITION,
  DEFAULT_SCAN_SUBTASKS,
  type ScanSubtaskType,
  type FullValidationResult,
} from "@revamp/core-engine";
import { llmProxyService } from "./llm-proxy.js";
import {
  matchAndAssignAgent,
  recordAgentCompletion,
  type AgentStageContext,
} from "./agent-pipeline.js";
import {
  prepareAgentExecution,
} from "./agent-execution.js";
import {
  createSubtask,
  assignSubtask,
  completeSubtask,
  failSubtask,
  type SubtaskView,
} from "./agent-delegation.js";
import {
  createSession,
  createWorkingMemory,
  createPersistentMemory,
  clearWorkingMemory,
  deterministicUUID,
  SYSTEM_AGENT_ID,
  type SessionData,
} from "./agent-sessions.js";
import { runQuickReview } from "./two-stage-review.js";
import { PipelineMessageBus, type SubtaskMessage } from "./agent-message-bus.js";
import {
  checkPipelineBudget,
  PipelineBudgetExceededError,
  ProjectBudgetExceededError,
} from "./pipeline-budget.js";
import type { FileAnalysisResult } from "./file-analyzer.js";

// ─── TYPES ──────────────────────────────────────────────────────

export interface ScanOrchestrationOptions {
  pipelineRunId: string;
  projectContext: ProjectContext;
  fileAnalysis: FileAnalysisResult;
  priorOutputs: StageOutput[];
  feedback: UserFeedback[];
  onEvent?: OnStageEvent;
  onDelta?: OnDelta;
  signal?: AbortSignal;
  model?: string;
}

interface SubtaskPlan {
  type: ScanSubtaskType;
  title: string;
  description: string;
  assignToAgent?: string;
  priority: number;
  requiredSkills: string[];
  requiredTechStack: string[];
}

interface SubtaskResult {
  subtaskId: string;
  type: ScanSubtaskType;
  title: string;
  agentName: string;
  output: string;
  duration: number;
  status: "completed" | "failed";
  error?: string;
  /** Quality review score (0.0-1.0), set after review */
  reviewScore?: number;
  /** Quality review verdict */
  reviewVerdict?: string;
  /** Whether the output was revised after review */
  revised?: boolean;
}

/** Hard cap on subtasks to prevent unbounded plan growth from react-mode revisions */
const MAX_SUBTASKS = 8;

// ─── MAIN ORCHESTRATOR ──────────────────────────────────────────

export async function orchestrateScanStage(
  opts: ScanOrchestrationOptions,
): Promise<StageRunResult> {
  const startTime = Date.now();
  const phases: StageEvent[] = [];

  const emit = (phase: StagePhase, data?: Record<string, unknown>) => {
    const event: StageEvent = {
      phase,
      stageName: PipelineStageName.SCAN,
      stageIndex: 0,
      timestamp: new Date().toISOString(),
      data,
    };
    phases.push(event);
    opts.onEvent?.(event);
  };

  const checkAbort = () => {
    if (opts.signal?.aborted) {
      throw new Error("Stage execution aborted");
    }
  };

  // ── PATTERN 1: MESSAGE BUS (Watch/Subscribe) ────────────────
  // Replaces manual context-threading between subtasks.
  const messageBus = new PipelineMessageBus(opts.pipelineRunId);

  // ── STEP 1: SCOUT TRIAGE ──────────────────────────────────────
  let scoutAssessment: Record<string, unknown>;
  try {
    emit("scout_assessment", { message: "Scout agent triaging codebase..." });
    checkAbort();
    scoutAssessment = await runScoutTriage(opts);

    // Store scout assessment as artifact
    try {
      await db.insert(stageArtifacts).values({
        id: crypto.randomUUID(),
        pipeline_run_id: opts.pipelineRunId,
        stage_name: PipelineStageName.SCAN,
        artifact_type: "scout_assessment",
        storage_path: `inline:scout_assessment:${opts.pipelineRunId}`,
        metadata: {
          completedAt: new Date().toISOString(),
          assessment: scoutAssessment,
        },
      });
    } catch {
      // Non-fatal
    }

    emit("scout_assessment", {
      message: "Scout triage complete",
      assessment: scoutAssessment,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : "";
    console.error("[SCAN] Scout triage failed:", errMsg, errStack);
    emit("scout_failed", { error: errMsg, message: "Scout triage failed. Please re-run the stage." });

    return {
      stageName: PipelineStageName.SCAN,
      stageIndex: 0,
      output: "",
      validation: null,
      refinementCount: 0,
      duration: Date.now() - startTime,
      phases,
      aborted: opts.signal?.aborted ?? false,
    };
  }

  // ── STEP 2: DIRECTOR PLANNING ─────────────────────────────────
  let subtaskPlans: SubtaskPlan[];
  try {
    emit("director_planning", { message: "Director planning subtask delegation..." });
    checkAbort();
    subtaskPlans = await runDirectorPlanning(opts, scoutAssessment);
    emit("director_planning", {
      message: `Director planned ${subtaskPlans.length} subtasks`,
      subtaskCount: subtaskPlans.length,
      subtasks: subtaskPlans.map((s) => ({ type: s.type, title: s.title, priority: s.priority })),
    });
  } catch (err) {
    // Director parse fail is graceful degradation — use default subtask set
    const errMsg = err instanceof Error ? err.message : String(err);
    opts.onEvent?.({
      phase: "director_planning",
      stageName: PipelineStageName.SCAN,
      stageIndex: 0,
      timestamp: new Date().toISOString(),
      data: {
        warning: "Director plan unparseable, using default subtask set",
        error: errMsg,
      },
    });

    // Apply same complexity-based cap to defaults
    const defaultMaxBySize = opts.fileAnalysis.totalLines < 5000 ? 2
      : opts.fileAnalysis.totalLines < 50000 ? 4 : 6;

    subtaskPlans = DEFAULT_SCAN_SUBTASKS.slice(0, defaultMaxBySize).map((d) => ({
      type: d.type,
      title: d.title,
      description: `Default: ${d.title}`,
      priority: d.priority,
      requiredSkills: [],
      requiredTechStack: [],
    }));
  }

  // ── STEP 3: SUBTASK EXECUTION ─────────────────────────────────
  // Create subtask rows in DB + emit SSE events
  const createdSubtasks: Array<{ plan: SubtaskPlan; subtask: SubtaskView }> = [];

  // Find a director agent to act as the subtask creator
  const directorAgentId = await findDirectorAgentId();

  for (const plan of subtaskPlans) {
    try {
      const subtask = await createSubtask(directorAgentId, {
        pipelineRunId: opts.pipelineRunId,
        stageName: PipelineStageName.SCAN,
        title: plan.title,
        description: plan.description,
        requiredSkills: plan.requiredSkills,
        requiredTechStack: plan.requiredTechStack,
        priority: plan.priority,
      });

      createdSubtasks.push({ plan, subtask });

      // Emit subtask_created for frontend timeline
      opts.onEvent?.({
        phase: "subtask_executing",
        stageName: PipelineStageName.SCAN,
        stageIndex: 0,
        timestamp: new Date().toISOString(),
        data: {
          event: "subtask_created",
          subtaskId: subtask.id,
          title: plan.title,
          type: plan.type,
          priority: plan.priority,
        },
      });
    } catch {
      // Non-fatal — skip this subtask
    }
  }

  // Execute each subtask sequentially (8GB RAM constraint + session chaining)
  const subtaskResults: SubtaskResult[] = [];
  let remainingSubtasks = [...createdSubtasks];

  while (remainingSubtasks.length > 0) {
    const { plan, subtask } = remainingSubtasks.shift()!;
    checkAbort();

    // ── PATTERN 1: Register watch subscriptions for this subtask
    messageBus.registerSubtaskWatches(plan.type);

    const subtaskStart = Date.now();
    opts.onEvent?.({
      phase: "subtask_executing",
      stageName: PipelineStageName.SCAN,
      stageIndex: 0,
      timestamp: new Date().toISOString(),
      data: {
        event: "subtask_started",
        subtaskId: subtask.id,
        title: plan.title,
        type: plan.type,
        agentName: subtask.assignedAgentName || "pending",
      },
    });

    try {
      // Budget pre-check before each subtask
      try {
        await checkPipelineBudget(opts.pipelineRunId);
      } catch (budgetErr) {
        if (budgetErr instanceof PipelineBudgetExceededError || budgetErr instanceof ProjectBudgetExceededError) {
          emit("failed", { message: (budgetErr as Error).message, budgetExceeded: true });
          break;
        }
        throw budgetErr;
      }

      const result = await executeSubtask(opts, plan, subtask, subtaskResults, scoutAssessment, messageBus);

      // ── PATTERN 2: REVIEW-REVISE — if review says NEEDS_REVISION, revise once
      if (result.status === "completed" && result.output) {
        try {
          const review = await runQuickReview({
            pipelineRunId: opts.pipelineRunId,
            stageName: PipelineStageName.SCAN,
            subtaskType: plan.type,
            output: result.output,
          });

          result.reviewScore = review.overallScore;
          result.reviewVerdict = review.overallVerdict;

          // REVIEW-REVISE: If needs revision and we have a revision prompt, do one pass
          if (review.overallVerdict === "NEEDS_REVISION" && review.revisionPrompt) {
            // Budget check before revision to avoid double-spending
            let budgetOk = true;
            try {
              await checkPipelineBudget(opts.pipelineRunId);
            } catch {
              budgetOk = false;
            }

            if (budgetOk) {
              opts.onEvent?.({
                phase: "subtask_executing",
                stageName: PipelineStageName.SCAN,
                stageIndex: 0,
                timestamp: new Date().toISOString(),
                data: {
                  event: "subtask_revising",
                  subtaskId: subtask.id,
                  reviewScore: review.overallScore,
                  concerns: review.dimensions.flatMap((d) => d.concerns).slice(0, 3),
                },
              });

              try {
                const revised = await reviseSubtaskOutput(opts, result.output, review.revisionPrompt, plan.type);
                result.output = revised;
                result.revised = true;
              } catch {
                // Revision failed — keep original output
              }
            }
          }

          opts.onEvent?.({
            phase: "subtask_executing",
            stageName: PipelineStageName.SCAN,
            stageIndex: 0,
            timestamp: new Date().toISOString(),
            data: {
              event: "subtask_reviewed",
              subtaskId: subtask.id,
              reviewScore: review.overallScore,
              reviewVerdict: review.overallVerdict,
              revised: result.revised || false,
              concerns: review.dimensions.flatMap((d) => d.concerns).slice(0, 3),
            },
          });
        } catch {
          // Review failure is non-fatal
        }
      }

      subtaskResults.push(result);

      // ── PATTERN 1: Publish to message bus for downstream subtasks
      if (result.status === "completed" && result.output) {
        messageBus.publish({
          subtaskId: result.subtaskId,
          type: result.type,
          agentId: "",
          agentName: result.agentName,
          output: result.output,
          reviewScore: result.reviewScore,
          findings: extractSubtaskFindings(result.output),
          timestamp: new Date().toISOString(),
        });

        // ── PATTERN 4: Store as working memory for current pipeline
        try {
          await createWorkingMemory({
            agentId: "system", // or actual agent ID
            pipelineRunId: opts.pipelineRunId,
            subtaskType: result.type,
            findings: extractSubtaskFindings(result.output),
            tokenCount: Math.round(result.output.length / 4),
          });
        } catch {
          // Non-fatal
        }
      }

      opts.onEvent?.({
        phase: "subtask_executing",
        stageName: PipelineStageName.SCAN,
        stageIndex: 0,
        timestamp: new Date().toISOString(),
        data: {
          event: "subtask_completed",
          subtaskId: subtask.id,
          title: plan.title,
          type: plan.type,
          agentName: result.agentName,
          duration: Date.now() - subtaskStart,
        },
      });

      // ── PATTERN 3: REACT MODE — Director re-evaluates plan after each subtask
      // Only trigger if there are remaining subtasks, findings suggest change, and under cap
      const totalSubtaskCount = subtaskResults.length + remainingSubtasks.length;
      if (remainingSubtasks.length > 0 && result.status === "completed" && totalSubtaskCount < MAX_SUBTASKS) {
        try {
          const planRevision = await checkPlanRevision(opts, scoutAssessment, subtaskResults, remainingSubtasks.map((s) => s.plan));
          if (planRevision) {
            emit("director_planning", {
              message: `Director revised plan: ${planRevision.reason}`,
              action: planRevision.action,
            });

            if (planRevision.action === "add" && planRevision.newSubtask) {
              // Create and append new subtask
              const newSubtask = await createSubtask(directorAgentId, {
                pipelineRunId: opts.pipelineRunId,
                stageName: PipelineStageName.SCAN,
                title: planRevision.newSubtask.title,
                description: planRevision.newSubtask.description,
                requiredSkills: planRevision.newSubtask.requiredSkills || [],
                requiredTechStack: planRevision.newSubtask.requiredTechStack || [],
                priority: planRevision.newSubtask.priority || 5,
              });

              remainingSubtasks.push({ plan: planRevision.newSubtask, subtask: newSubtask });

              opts.onEvent?.({
                phase: "subtask_executing",
                stageName: PipelineStageName.SCAN,
                stageIndex: 0,
                timestamp: new Date().toISOString(),
                data: {
                  event: "subtask_created",
                  subtaskId: newSubtask.id,
                  title: planRevision.newSubtask.title,
                  type: planRevision.newSubtask.type,
                  priority: planRevision.newSubtask.priority,
                  reason: `Director added: ${planRevision.reason}`,
                },
              });
            } else if (planRevision.action === "skip" && planRevision.skipType) {
              // Remove a remaining subtask
              remainingSubtasks = remainingSubtasks.filter(
                (s) => s.plan.type !== planRevision.skipType,
              );
            }
          }
        } catch {
          // Plan revision failed — continue with original plan
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await failSubtask(subtask.id, errMsg);

      subtaskResults.push({
        subtaskId: subtask.id,
        type: plan.type,
        title: plan.title,
        agentName: "none",
        output: "",
        duration: Date.now() - subtaskStart,
        status: "failed",
        error: errMsg,
      });

      opts.onEvent?.({
        phase: "subtask_executing",
        stageName: PipelineStageName.SCAN,
        stageIndex: 0,
        timestamp: new Date().toISOString(),
        data: {
          event: "subtask_failed",
          subtaskId: subtask.id,
          title: plan.title,
          type: plan.type,
          error: errMsg,
        },
      });
    }
  }

  // Check if ALL subtasks failed
  const successfulResults = subtaskResults.filter((r) => r.status === "completed");
  if (successfulResults.length === 0) {
    emit("failed", {
      message: "All subtasks failed. Please re-run the stage.",
      errors: subtaskResults.map((r) => ({ type: r.type, error: r.error })),
    });

    return {
      stageName: PipelineStageName.SCAN,
      stageIndex: 0,
      output: "",
      validation: null,
      refinementCount: 0,
      duration: Date.now() - startTime,
      phases,
      aborted: false,
    };
  }

  // ── STEP 4: COMPOSITION ───────────────────────────────────────
  emit("composing", { message: "Composing subtask results into final analysis..." });
  checkAbort();

  let composedOutput: string;
  try {
    composedOutput = await composeResults(opts, subtaskResults);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    emit("failed", {
      message: "Composition failed. Please re-run the stage.",
      error: errMsg,
    });

    return {
      stageName: PipelineStageName.SCAN,
      stageIndex: 0,
      output: "",
      validation: null,
      refinementCount: 0,
      duration: Date.now() - startTime,
      phases,
      aborted: false,
    };
  }

  // ── STEP 5: VALIDATE COMPOSED OUTPUT ──────────────────────────
  // Run the full three-tier validation (deterministic + contract + optional LLM eval)
  // so the frontend gets proper scoring criteria — not just contract violations.
  emit("validating" as StagePhase, { message: "Validating composed output..." });
  let refinementCount = 0;

  // Create LLM eval function for validation scoring (uses evaluator model if available).
  // Check if evaluator model is resolvable before creating the function.
  const wantEvalModel = process.env.LLM_EVALUATOR_MODEL;
  const hasEvalModel = wantEvalModel
    ? await llmProxyService.hasValidationModel().catch(() => false)
    : false;
  const llmEvalFn = hasEvalModel
    ? llmProxyService.createEvalFn({ model: wantEvalModel })
    : undefined;

  // Build BREE ground truth for anchoring
  const breeGroundTruth = opts.fileAnalysis ? {
    totalFiles: opts.fileAnalysis.totalFiles,
    totalLines: opts.fileAnalysis.totalLines,
    languages: opts.fileAnalysis.detectedLanguages?.map((lang: string) => ({ id: lang, fileCount: 0 })) ?? [],
  } : undefined;

  // Get stage prompt from project context for prompt-derived validation
  const stagePrompt = (opts.projectContext as any)?.stagePrompts?.['0'] || '';
  const validationPrompt = (opts.projectContext as any)?.validationPrompts?.['0'] || '';

  let validationResult: FullValidationResult = await runValidation({
    pipelineRunId: opts.pipelineRunId,
    stageName: PipelineStageName.SCAN,
    stageOutput: composedOutput,
    stagePrompt,
    validationPrompt,
    llmEvalFn,
    skipLlmEval: !hasEvalModel,
    breeGroundTruth,
  });

  // Auto-refine once if contract check failed
  if (!validationResult.contractResult.passed && validationResult.contractResult.refinementPrompt) {
    emit("refining" as StagePhase, { message: "Refining composition to meet stage contract..." });
    try {
      const refinedOutput = await refineComposition(opts, composedOutput, validationResult.contractResult.refinementPrompt);
      composedOutput = refinedOutput;
      refinementCount = 1;

      // Re-validate after refinement (skip LLM eval on retry to save cost)
      validationResult = await runValidation({
        pipelineRunId: opts.pipelineRunId,
        stageName: PipelineStageName.SCAN,
        stageOutput: composedOutput,
        stagePrompt,
        validationPrompt,
        skipLlmEval: true,
        breeGroundTruth,
      });

      if (!validationResult.contractResult.passed) {
        emit("log" as StagePhase, {
          message: `Composition validation has gaps (${validationResult.contractResult.violations.length} violations) but output is usable`,
        });
      }
    } catch {
      // Refinement failed — keep original composition with original validation
    }
  }

  // NOTE: The primary stage_output artifact is stored by pipeline.ts via storeStageOutput().
  // We store only a summary artifact here to avoid duplicates in the artifact table.
  try {
    await db.insert(stageArtifacts).values({
      id: crypto.randomUUID(),
      pipeline_run_id: opts.pipelineRunId,
      stage_name: PipelineStageName.SCAN,
      artifact_type: "scan_orchestration_summary",
      storage_path: `inline:scan_summary:${opts.pipelineRunId}`,
      file_size: 0,
      metadata: {
        completedAt: new Date().toISOString(),
        subtasksCompleted: successfulResults.length,
        subtasksFailed: subtaskResults.length - successfulResults.length,
        validationPassed: validationResult.passed,
        confidenceScore: validationResult.confidenceScore,
        refinementCount,
      },
    });
  } catch {
    // Non-fatal
  }

  // ── PATTERN 4: Persist key learnings as persistent memory for future runs
  try {
    const keyFindings = subtaskResults
      .filter((r) => r.status === "completed")
      .flatMap((r) => extractSubtaskFindings(r.output))
      .slice(0, 20);

    if (keyFindings.length > 0) {
      await createPersistentMemory({
        agentId: "system",
        pipelineRunId: opts.pipelineRunId,
        learnings: keyFindings,
        tokenCount: Math.round(keyFindings.join(" ").length / 4),
      });
    }
  } catch {
    // Non-fatal
  }

  // Clean up working memory + message bus
  try {
    await clearWorkingMemory(opts.pipelineRunId);
  } catch {
    // Non-fatal
  }
  messageBus.clear();

  emit("completed", {
    message: "SCAN analysis complete",
    subtasksCompleted: successfulResults.length,
    subtasksFailed: subtaskResults.length - successfulResults.length,
    duration: Date.now() - startTime,
  });

  return {
    stageName: PipelineStageName.SCAN,
    stageIndex: 0,
    output: composedOutput,
    validation: validationResult,
    refinementCount,
    duration: Date.now() - startTime,
    phases,
    aborted: false,
  };
}

// ─── SCOUT TRIAGE ───────────────────────────────────────────────

async function runScoutTriage(
  opts: ScanOrchestrationOptions,
): Promise<Record<string, unknown>> {
  // Use a fast/cheap model for scout
  const scoutCallFn = llmProxyService.createCallFn({
    maxTokens: 4096,
    model: pickScoutModel(),
  });

  const fileAnalysisData = formatFileAnalysisForPrompt(opts.fileAnalysis);
  const prompt = SCAN_SCOUT_ASSESSMENT.replace("{{fileAnalysisData}}", fileAnalysisData);

  const raw = await scoutCallFn({
    systemPrompt: "You are a codebase scout. Output ONLY valid JSON.",
    userPrompt: prompt,
  });

  // Parse JSON from the response
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Scout assessment did not produce valid JSON");
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  return JSON.parse(jsonStr);
}

// ─── DIRECTOR PLANNING ─────────────────────────────────────────

async function runDirectorPlanning(
  opts: ScanOrchestrationOptions,
  scoutAssessment: Record<string, unknown>,
): Promise<SubtaskPlan[]> {
  const directorCallFn = llmProxyService.createCallFn({
    maxTokens: 4096,
    model: opts.model || "",
  });

  // Build agent roster from available agents
  const agentRoster = await buildAgentRoster(opts);

  // Build codebase size context for complexity-aware planning
  const totalFiles = opts.fileAnalysis.totalFiles;
  const totalLines = opts.fileAnalysis.totalLines;
  const sizeLabel = totalLines < 5000 ? "SMALL" : totalLines < 50000 ? "MEDIUM" : "LARGE";
  const codebaseSize = `Total files: ${totalFiles}, Total LOC: ${totalLines.toLocaleString()}, Size category: **${sizeLabel}**`;

  const prompt = SCAN_DIRECTOR_PLAN
    .replace("{{scoutAssessment}}", JSON.stringify(scoutAssessment, null, 2))
    .replace("{{codebaseSize}}", codebaseSize)
    .replace("{{agentRoster}}", agentRoster);

  const raw = await directorCallFn({
    systemPrompt: "You are the Department Director. Output ONLY valid JSON.",
    userPrompt: prompt,
  });

  // Parse JSON
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Director plan did not produce valid JSON");
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  const parsed = JSON.parse(jsonStr);
  const plan = parsed.plan || parsed;

  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("Director plan is empty or not an array");
  }

  // Validate each subtask has a valid type
  const validTypes: Set<string> = new Set([
    "architecture-analysis",
    "tech-stack-deepdive",
    "legacy-patterns",
    "data-layer",
    "security-scan",
    "business-capabilities",
  ]);

  // Hard cap: enforce complexity-based subtask limits.
  // LLMs frequently ignore the "1-2 subtasks MAX" prompt instruction for SMALL codebases.
  const maxBySize = totalLines < 5000 ? 2 : totalLines < 50000 ? 4 : 6;

  return plan
    .filter((s: any) => validTypes.has(s.type))
    .sort((a: any, b: any) => (a.priority || 5) - (b.priority || 5))
    .slice(0, maxBySize)
    .map((s: any) => ({
      type: s.type as ScanSubtaskType,
      title: s.title || s.type,
      description: s.description || "",
      assignToAgent: s.assignToAgent,
      priority: s.priority || 5,
      requiredSkills: s.requiredSkills || [],
      requiredTechStack: s.requiredTechStack || [],
    }));
}

// ─── SUBTASK EXECUTION ──────────────────────────────────────────

async function executeSubtask(
  opts: ScanOrchestrationOptions,
  plan: SubtaskPlan,
  subtask: SubtaskView,
  priorResults: SubtaskResult[],
  scoutAssessment: Record<string, unknown>,
  messageBus?: PipelineMessageBus,
): Promise<SubtaskResult> {
  const startTime = Date.now();

  // Get the prompt template for this subtask type
  const template = SCAN_SUBTASK_TEMPLATES[plan.type];
  if (!template) {
    throw new Error(`No template for subtask type: ${plan.type}`);
  }

  // Match an agent for this subtask.
  // Merge the plan's requiredTechStack with the actual detected languages
  // from file analysis so the matcher weighs codebase reality (30% of score),
  // not just whatever the Director LLM hallucinated.
  const detectedLangs = opts.fileAnalysis.detectedLanguages.map((l) => l.toLowerCase());
  const mergedTechStack = [
    ...new Set([...detectedLangs, ...(plan.requiredTechStack || []).map((t) => t.toLowerCase())]),
  ];

  let agentCtx: AgentStageContext | null = null;
  try {
    agentCtx = await matchAndAssignAgent(
      opts.pipelineRunId,
      PipelineStageName.SCAN,
      plan.requiredSkills.length > 0 ? plan.requiredSkills : [plan.type],
      mergedTechStack,
    );
  } catch {
    // Non-fatal — run without agent identity
  }

  // If no matching agent found, Director spawns a specialist on-the-fly
  if (!agentCtx) {
    try {
      const spawned = await spawnSpecialistAgent(opts, plan, detectedLangs);
      if (spawned) {
        // Now try matching again — the new agent should score highest
        agentCtx = await matchAndAssignAgent(
          opts.pipelineRunId,
          PipelineStageName.SCAN,
          plan.requiredSkills.length > 0 ? plan.requiredSkills : [plan.type],
          mergedTechStack,
        );

        opts.onEvent?.({
          phase: "subtask_executing",
          stageName: PipelineStageName.SCAN,
          stageIndex: 0,
          timestamp: new Date().toISOString(),
          data: {
            event: "agent_spawned",
            agentName: spawned.name,
            agentSlug: spawned.slug,
            reason: `No existing agent matched for ${plan.type} with ${detectedLangs.join(", ")}`,
          },
        });
      }
    } catch {
      // Non-fatal — proceed without agent identity
    }
  }

  // Assign subtask to agent in DB
  if (agentCtx) {
    try {
      await assignSubtask(subtask.id, agentCtx.agentId, agentCtx.agentId);
    } catch {
      // Non-fatal
    }
  }

  // Build context for the subtask prompt
  const codebaseContext = buildCodebaseContext(opts);
  const fileAnalysisData = formatFileAnalysisForPrompt(opts.fileAnalysis);

  // ── PATTERN 1: Use message bus for prior findings (watch/subscribe)
  // Falls back to legacy formatPriorFindings if no bus or no watched messages
  let priorFindings: string;
  if (messageBus && messageBus.size > 0) {
    const busContext = messageBus.buildContextForSubtask(plan.type);
    priorFindings = busContext || formatPriorFindings(priorResults, scoutAssessment);
  } else {
    priorFindings = formatPriorFindings(priorResults, scoutAssessment);
  }

  const filledPrompt = template
    .replace("{{codebaseContext}}", codebaseContext)
    .replace("{{fileAnalysisData}}", fileAnalysisData)
    .replace("{{priorFindings}}", priorFindings);

  // Create LLM call function (with or without agent identity)
  // Subtask maxTokens scaled by codebase size to prevent bloat.
  // Small codebases (<5K LOC) get tight limits — there's less to analyze.
  const subtaskMaxTokens = opts.fileAnalysis.totalLines < 5000 ? 2048
    : opts.fileAnalysis.totalLines < 50000 ? 3072
    : 4096;
  let llmCallFn = llmProxyService.createCallFn({
    maxTokens: subtaskMaxTokens,
    model: opts.model || "",
  });

  let agentExec: Awaited<ReturnType<typeof prepareAgentExecution>> | null = null;

  if (agentCtx) {
    try {
      agentExec = await prepareAgentExecution({
        agentCtx,
        baseLlmCallFn: llmCallFn,
        stageIndex: 0,
        pipelineRunId: opts.pipelineRunId,
        signal: opts.signal,
      });
      llmCallFn = agentExec.llmCallFn;
    } catch {
      // Non-fatal — use base call fn
    }
  }

  // Mark subtask as in_progress
  try {
    await db
      .update(agentSubtasks)
      .set({ status: "in_progress", updated_at: new Date() })
      .where(eq(agentSubtasks.id, subtask.id));
  } catch {
    // Non-fatal
  }

  // Execute via core-engine runStage with subtask-specific prompt.
  // IMPORTANT: Do NOT stream subtask deltas to the frontend — the user
  // should only see the composed final document. We accumulate silently
  // and emit phase events for the subtask progress panel instead.
  let subtaskOutput = "";
  const subtaskDelta = (text: string) => {
    if (text) subtaskOutput += text;
    // Intentionally NOT calling opts.onDelta — subtask output is internal.
    // The composed final document streams via onDelta in composeResults().
  };

  // Wrap in try/finally to ensure agent is always released, even on errors.
  // Without this, a failed runStage() leaves the agent in 'working' state forever.
  try {
    const result = await runStage({
      project: opts.projectContext,
      stageName: PipelineStageName.SCAN,
      stageIndex: 0,
      pipelineRunId: opts.pipelineRunId,
      templateVars: {},
      llmCallFn,
      priorOutputs: opts.priorOutputs,
      feedback: opts.feedback,
      onDelta: subtaskDelta,
      signal: opts.signal,
      skipValidation: true, // Subtask validation is lightweight, not full contract
      skipReview: true, // Subtasks don't need reviewer — composition handles quality
      promptOverride: filledPrompt,
      model: opts.model,
    });

    // Use fallback: if runStage returned empty output but our accumulator has content,
    // prefer the accumulated output (guards against stream resolution issues).
    const effectiveOutput = result.output || subtaskOutput;

    // Lightweight validation
    const validation = validateSubtaskOutput(plan.type, effectiveOutput);
    if (!validation.passed) {
      // Log but don't fail — composition handles gaps
      console.warn(
        `[ScanOrchestrator] Subtask ${plan.type} validation issues:`,
        validation.issues,
      );
    }

    // Complete subtask in DB
    try {
      await completeSubtask(subtask.id, { output: effectiveOutput, validation }, 0);
    } catch {
      // Non-fatal
    }

    // Store subtask result as a stage artifact so the frontend can list it
    try {
      await db.insert(stageArtifacts).values({
        id: crypto.randomUUID(),
        pipeline_run_id: opts.pipelineRunId,
        stage_name: PipelineStageName.SCAN,
        artifact_type: `subtask_${plan.type}`,
        storage_path: `inline:subtask:${subtask.id}`,
        file_size: effectiveOutput.length,
        metadata: {
          subtaskId: subtask.id,
          subtaskType: plan.type,
          title: plan.title,
          agentName: agentCtx?.agentName || "direct-llm",
          duration: Date.now() - startTime,
          completedAt: new Date().toISOString(),
        },
      });
    } catch {
      // Non-fatal — subtask result still in agentSubtasks table
    }

    // Create session entry for context chain
    if (agentCtx) {
      try {
        const sessionData: SessionData = {
          stageContext: { subtaskType: plan.type, subtaskId: subtask.id },
          findings: [effectiveOutput.slice(0, 4000)],
        };
        await createSession({
          agentId: agentCtx.agentId,
          taskId: deterministicUUID(`${opts.pipelineRunId}:${PipelineStageName.SCAN}:${plan.type}`),
          pipelineRunId: opts.pipelineRunId,
          sessionData,
          tokenCount: Math.round(effectiveOutput.length / 4),
        });
      } catch {
        // Non-fatal
      }

      // Record agent completion with estimated token usage.
      // LLMCallFn returns only a string — usage data stays in the Go orchestrator.
      // Estimate tokens from content lengths for agent-level cost attribution.
      try {
        const estimatedInputTokens = Math.round(filledPrompt.length / 4);
        const estimatedOutputTokens = Math.round(effectiveOutput.length / 4);
        const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
        // Rough cost estimate: ~$3/M input + ~$15/M output tokens (Sonnet-class)
        const estimatedCostCents = Math.round(
          (estimatedInputTokens * 0.0003 + estimatedOutputTokens * 0.0015) * 100,
        ) / 100;

        await recordAgentCompletion(
          agentCtx,
          {
            costCents: estimatedCostCents,
            tokensUsed: estimatedTotalTokens,
            refinementCount: result.refinementCount,
            result: { subtaskType: plan.type },
          },
          opts.pipelineRunId,
          agentCtx.preferredProvider || "auto",
          opts.model || agentCtx.preferredModel || "default",
          estimatedInputTokens,
          estimatedOutputTokens,
          PipelineStageName.SCAN,
        );
      } catch {
        // Non-fatal
      }
    }

    return {
      subtaskId: subtask.id,
      type: plan.type,
      title: plan.title,
      agentName: agentCtx?.agentName || "direct-llm",
      output: effectiveOutput,
      duration: Date.now() - startTime,
      status: "completed",
    };
  } finally {
    // Always release the agent, even if runStage() threw.
    // Without this, the agent stays in 'working' state in the DB.
    if (agentExec) {
      try {
        await agentExec.complete();
      } catch {
        // Non-fatal
      }
    }
  }
}

// ─── COMPOSITION ────────────────────────────────────────────────

async function composeResults(
  opts: ScanOrchestrationOptions,
  results: SubtaskResult[],
): Promise<string> {
  const successfulResults = results.filter((r) => r.status === "completed" && r.output);

  // Format all subtask outputs for the composition prompt
  const subtaskResultsText = successfulResults
    .map((r, i) => {
      return [
        `═══ SUBTASK ${i + 1}: ${r.title} (${r.type}) ═══`,
        `Agent: ${r.agentName}`,
        `Duration: ${Math.round(r.duration / 1000)}s`,
        "",
        r.output,
        "",
      ].join("\n");
    })
    .join("\n");

  // Note failed subtasks
  const failedResults = results.filter((r) => r.status === "failed");
  const failedNote = failedResults.length > 0
    ? `\n\nNOTE: The following subtasks failed and are not included:\n${failedResults.map((r) => `- ${r.title}: ${r.error}`).join("\n")}\nAddress these gaps in the composition if possible.\n`
    : "";

  const prompt = SCAN_COMPOSITION.replace(
    "{{subtaskResults}}",
    subtaskResultsText + failedNote,
  );

  // Composition output target: 1500-3000 words (~6K-12K tokens).
  // Scale by codebase size — small codebases need shorter documents.
  const totalLines = opts.fileAnalysis.totalLines;
  const compositionMaxTokens = totalLines < 5000 ? 4096
    : totalLines < 50000 ? 6144
    : 8192;
  const composerCallFn = llmProxyService.createCallFn({
    maxTokens: compositionMaxTokens,
    model: opts.model || "",
  });

  // Clear delta before composition — signals fresh start to frontend
  opts.onDelta?.("");

  const wordLimit = totalLines < 5000 ? "1000-2000" : totalLines < 50000 ? "1500-3000" : "2000-4000";

  return composerCallFn({
    systemPrompt: [
      "You are composing the Stage 1 (SCAN) analysis document from specialist reports.",
      "This is an INVENTORY stage — observe and catalog, do NOT propose fixes or modernization plans.",
      "Produce clean, well-structured markdown that a stakeholder can read in 5-10 minutes.",
      "",
      "CRITICAL RULES:",
      "1. CONSOLIDATE — never concatenate. Your output must be SHORTER than the sum of inputs.",
      "2. Each file, technology, and finding appears in exactly ONE table row. No duplicates.",
      "3. If two specialists mention the same thing, merge into one entry.",
      "4. Use TABLES for data. One Mermaid diagram max per section.",
      "5. Keep findings tables to top 10 items max, prioritized by severity.",
      `6. HARD LIMIT: ${wordLimit} words total. Count before finalizing. If over, cut.`,
      "7. Every finding must cite file:line evidence. No generic advice. No remediation steps.",
      "8. Skip sections that have no data (e.g., no data-layer subtask ran → omit Data Layer section).",
      "9. Do NOT reproduce specialist reports verbatim — synthesize.",
    ].join("\n"),
    userPrompt: prompt,
    onDelta: opts.onDelta,
    signal: opts.signal,
  });
}

// ─── REFINEMENT ─────────────────────────────────────────────────

async function refineComposition(
  opts: ScanOrchestrationOptions,
  output: string,
  refinementPrompt: string,
): Promise<string> {
  // Match refinement maxTokens to composition limits (not 16K)
  const refineTotalLines = opts.fileAnalysis.totalLines;
  const refineMaxTokens = refineTotalLines < 5000 ? 4096
    : refineTotalLines < 50000 ? 6144
    : 8192;
  const callFn = llmProxyService.createCallFn({
    maxTokens: refineMaxTokens,
    model: opts.model || "",
  });

  opts.onDelta?.("");

  const prompt = [
    "# Refinement Required",
    "",
    "Your previous output needs specific improvements.",
    "",
    "## Your Previous Output",
    output.slice(0, 12000),
    output.length > 12000 ? "\n[... truncated ...]" : "",
    "",
    "## Required Improvements",
    refinementPrompt,
    "",
    "## Instructions",
    "Output the COMPLETE corrected document. Preserve all valid content.",
  ].join("\n");

  return callFn({
    systemPrompt: "You are refining a SCAN analysis document. Address every listed issue.",
    userPrompt: prompt,
    onDelta: opts.onDelta,
    signal: opts.signal,
  });
}

// ─── HELPERS ────────────────────────────────────────────────────

function pickScoutModel(): string {
  // Prefer fast/cheap models for scout: env override > Haiku (Bedrock)
  return process.env.LLM_SCOUT_MODEL
    || process.env.LLM_EVALUATOR_MODEL
    || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
}

function formatFileAnalysisForPrompt(fa: FileAnalysisResult): string {
  const parts: string[] = [];
  parts.push(`**Total Files**: ${fa.totalFiles}`);
  parts.push(`**Total Lines**: ${fa.totalLines.toLocaleString()}`);
  parts.push(`**Detected Languages**: ${fa.detectedLanguages.join(", ")}`);

  parts.push("\n**Files by Extension**:");
  for (const [ext, count] of Object.entries(fa.filesByExtension).sort(
    (a, b) => b[1] - a[1],
  )) {
    parts.push(`  .${ext}: ${count} files (${fa.linesByExtension[ext]?.toLocaleString() || "?"} lines)`);
  }

  if (fa.largestFiles.length > 0) {
    parts.push("\n**Largest Files**:");
    for (const f of fa.largestFiles.slice(0, 10)) {
      parts.push(`  ${f.path} (${f.lines} lines, .${f.extension})`);
    }
  }

  if (fa.keyFiles.length > 0) {
    parts.push("\n**Key Files**: " + fa.keyFiles.join(", "));
  }

  if (fa.directoryTree) {
    parts.push("\n**Directory Structure**:");
    parts.push("```");
    parts.push(fa.directoryTree.slice(0, 3000));
    parts.push("```");
  }

  if (fa.codeSnippets.length > 0) {
    parts.push("\n**Sample Code Snippets**:");
    for (const snippet of fa.codeSnippets.slice(0, 5)) {
      parts.push(`\n--- ${snippet.path} (${snippet.language}) ---`);
      parts.push("```" + snippet.language);
      parts.push(snippet.content.slice(0, 1500));
      parts.push("```");
    }
  }

  return parts.join("\n");
}

function buildCodebaseContext(opts: ScanOrchestrationOptions): string {
  const parts: string[] = [];
  const p = opts.projectContext;

  if (p.projectName) parts.push(`**Project**: ${p.projectName}`);
  if (p.description) parts.push(`**Description**: ${p.description}`);
  if (p.sourceLanguages?.length) parts.push(`**Source Languages**: ${p.sourceLanguages.join(", ")}`);
  if (p.targetStack) parts.push(`**Target Stack**: ${p.targetStack}`);

  return parts.join("\n") || "No additional project context available.";
}

function formatPriorFindings(
  priorResults: SubtaskResult[],
  scoutAssessment: Record<string, unknown>,
): string {
  if (priorResults.length === 0) {
    return `Scout Assessment:\n${JSON.stringify(scoutAssessment, null, 2).slice(0, 3000)}`;
  }

  const parts = [`Scout Assessment (summary):\n${JSON.stringify(scoutAssessment, null, 2).slice(0, 1500)}`];

  for (const r of priorResults) {
    if (r.status !== "completed" || !r.output) continue;
    parts.push(`\n--- ${r.title} (${r.agentName}) ---`);
    parts.push(r.output.slice(0, 2000));
    if (r.output.length > 2000) parts.push("[... truncated ...]");
  }

  return parts.join("\n");
}

async function buildAgentRoster(_opts: ScanOrchestrationOptions): Promise<string> {
  try {
    const agents = await db.query.agentPersonas.findMany({
      where: isNull(agentPersonas.hidden_at),
      columns: {
        slug: true,
        name: true,
        role: true,
        department: true,
        skills: true,
        tech_stack: true,
        legacy_expertise: true,
        stage_permissions: true,
      },
    });

    // Filter to agents that have SCAN permission
    const scanAgents = agents.filter((a) => {
      const perms = (a.stage_permissions as string[]) || [];
      return perms.includes(PipelineStageName.SCAN) || perms.includes("*");
    });

    if (scanAgents.length === 0) {
      return "No agents currently available. Use default assignments.";
    }

    return scanAgents
      .map((a) => {
        const skills = (a.skills as Array<{ name: string }>) || [];
        const skillNames = skills.map((s) => s.name).join(", ");
        const techStack = (a.tech_stack as string[]) || [];
        const legacyExpertise = (a.legacy_expertise as string[]) || [];
        const expertiseStr = legacyExpertise.length > 0 ? ` Legacy expertise: ${legacyExpertise.join(", ")}.` : "";
        return `- **${a.name}** (${a.slug}) — ${a.role}, ${a.department}. Skills: ${skillNames}. Tech: ${techStack.join(", ")}.${expertiseStr}`;
      })
      .join("\n");
  } catch {
    return "Agent roster unavailable. Use default assignments.";
  }
}

// ─── AGENT SPAWNING ─────────────────────────────────────────────
// When no existing specialist matches a subtask's requirements, the Director
// creates one dynamically. The new agent is persisted to agent_personas so
// it's available for future pipeline runs on similar codebases.

interface SpawnedAgent {
  id: string;
  name: string;
  slug: string;
}

async function spawnSpecialistAgent(
  opts: ScanOrchestrationOptions,
  plan: SubtaskPlan,
  detectedLangs: string[],
): Promise<SpawnedAgent | null> {
  // Build a slug from detected languages + subtask type
  const langKey = detectedLangs.slice(0, 2).join("-").replace(/[^a-z0-9-]/g, "") || "general";
  const subtaskKey = plan.type.replace(/[^a-z0-9-]/g, "");
  const slug = `auto-${langKey}-${subtaskKey}`;

  // Check if this auto-agent already exists (from a prior run)
  const existing = await db.query.agentPersonas.findFirst({
    where: eq(agentPersonas.slug, slug),
    columns: { id: true, name: true, slug: true, hidden_at: true },
  });

  if (existing && !existing.hidden_at) {
    return { id: existing.id, name: existing.name, slug: existing.slug };
  }

  // If it was hidden, un-hide it
  if (existing?.hidden_at) {
    await db.update(agentPersonas)
      .set({ hidden_at: null, updated_at: new Date() })
      .where(eq(agentPersonas.id, existing.id));
    return { id: existing.id, name: existing.name, slug: existing.slug };
  }

  // Build a concise, readable name for the auto-spawned agent.
  // Old pattern produced "Cobol/Python COBOL/CICS/VSAM Legacy Pattern Analysis Specialist"
  // which is unreadable in org charts and dashboards.
  const langLabel = detectedLangs.slice(0, 2).map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join("/");
  // Extract a short focus label from the subtask type (slug-like) rather than the full title
  const focusLabel = plan.type
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+(Analysis|Assessment|Review|Mapping|Deepdive)$/i, "");
  const name = `${langLabel} ${focusLabel} Specialist`.slice(0, 60);

  // Build skills from plan requirements + detected languages
  const skills = [
    {
      name: `${langLabel} Analysis`,
      category: "legacy-analysis" as const,
      proficiency: "advanced" as const,
      keywords: [...detectedLangs, ...plan.requiredSkills, plan.type],
      weight: 90,
    },
  ];

  // Find who this agent should report to — discovery director, then any lead/director
  const lead = await db.query.agentPersonas.findFirst({
    where: and(
      isNull(agentPersonas.hidden_at),
      or(
        eq(agentPersonas.slug, "aria-discovery-director"),
        eq(agentPersonas.slug, "architect-lead"),
        and(eq(agentPersonas.department, "discovery"), inArray(agentPersonas.role, ["director", "lead"])),
      ),
    ),
    columns: { id: true },
    orderBy: [asc(agentPersonas.role)], // director first
  });

  const systemPrompt = [
    `You are the ${name} — a dynamically created specialist for analyzing ${langLabel} codebases.`,
    `Your expertise covers: ${detectedLangs.join(", ")}.`,
    `Focus on: ${plan.description || plan.title}.`,
    `Be thorough but structured. Use markdown with clear sections and tables.`,
    `Cite file:line evidence for every finding. No generic advice.`,
  ].join("\n");

  const [inserted] = await db.insert(agentPersonas).values({
    id: crypto.randomUUID(),
    name,
    slug,
    role: "specialist",
    department: "discovery",
    status: "idle",
    system_prompt: systemPrompt,
    skills,
    tech_stack: plan.requiredTechStack || [],
    legacy_expertise: detectedLangs,
    modern_expertise: [],
    tool_permissions: ["read_file", "search_code", "list_files"],
    stage_permissions: ["SCAN", "DECODE"],
    preferred_provider: "anthropic",
    preferred_model: "claude-sonnet-4-20250514",
    max_concurrent_tasks: 2,
    reports_to: lead?.id || null,
    can_delegate: false,
    monthly_budget_cents: 15000,
    hard_stop_enabled: true,
    warning_threshold: "0.80",
    session_compaction_threshold: 80000,
    memory_strategy: "summary",
  }).returning({ id: agentPersonas.id });

  return { id: inserted.id, name, slug };
}

async function findDirectorAgentId(): Promise<string> {
  try {
    // Look for a director first, then fall back to any lead, then any agent
    const director = await db.query.agentPersonas.findFirst({
      where: and(
        isNull(agentPersonas.hidden_at),
        eq(agentPersonas.role, "director"),
      ),
      columns: { id: true },
    });

    if (director) return director.id;

    // Fall back to any non-hidden agent (better than an invalid "system" UUID)
    const anyAgent = await db.query.agentPersonas.findFirst({
      where: isNull(agentPersonas.hidden_at),
      columns: { id: true },
    });

    return anyAgent?.id || SYSTEM_AGENT_ID;
  } catch {
    return SYSTEM_AGENT_ID;
  }
}

// ─── PATTERN 2: SUBTASK REVISION ────────────────────────────────
// When review says NEEDS_REVISION, feed revision prompt back for one pass.

async function reviseSubtaskOutput(
  opts: ScanOrchestrationOptions,
  originalOutput: string,
  revisionPrompt: string,
  subtaskType: string,
): Promise<string> {
  const callFn = llmProxyService.createCallFn({
    maxTokens: opts.fileAnalysis.totalLines < 5000 ? 2048 : 3072,
    model: opts.model || "",
  });

  const prompt = [
    `# Revision Required for ${subtaskType}`,
    "",
    "Your previous output needs specific improvements.",
    "",
    "## Your Previous Output",
    originalOutput.slice(0, 8000),
    originalOutput.length > 8000 ? "\n[... truncated ...]" : "",
    "",
    "## Required Improvements",
    revisionPrompt,
    "",
    "## Instructions",
    "Output the COMPLETE corrected document. Preserve all valid content.",
    "Do NOT add new sections — only fix the issues listed above.",
  ].join("\n");

  return callFn({
    systemPrompt: `You are revising a ${subtaskType} analysis. Address every listed issue concisely.`,
    userPrompt: prompt,
  });
}

// ─── PATTERN 3: PLAN REVISION (React Mode) ─────────────────────
// After each subtask, Director can add/skip subtasks based on findings.

interface PlanRevision {
  action: "add" | "skip" | "none";
  reason: string;
  newSubtask?: SubtaskPlan;
  skipType?: string;
}

/**
 * Check if the Director should revise the remaining plan based on
 * findings from completed subtasks. Uses a lightweight LLM call.
 *
 * Only triggers when completed results contain "unexpected" signals:
 * - Languages not in scout assessment
 * - Security severity higher than expected
 * - Missing coverage areas
 */
async function checkPlanRevision(
  opts: ScanOrchestrationOptions,
  scoutAssessment: Record<string, unknown>,
  completedResults: SubtaskResult[],
  remainingPlans: SubtaskPlan[],
): Promise<PlanRevision | null> {
  // Only check after at least 1 completed subtask
  const successful = completedResults.filter((r) => r.status === "completed");
  if (successful.length === 0) return null;

  // Quick heuristic: check if any subtask found something the scout missed
  const latestResult = successful[successful.length - 1];
  const scoutLanguages = (scoutAssessment as any)?.languages?.primary || [];
  const remainingTypes = new Set(remainingPlans.map((p) => p.type));

  // Heuristic 1: If output mentions languages not in scout, consider adding legacy-patterns
  const mentionsNewLangs = ["cobol", "fortran", "delphi", "powerbuilder", "vb6"].some(
    (lang) =>
      latestResult.output.toLowerCase().includes(lang) &&
      !scoutLanguages.map((l: string) => l.toLowerCase()).includes(lang),
  );

  if (mentionsNewLangs && !remainingTypes.has("legacy-patterns")) {
    return {
      action: "add",
      reason: "Subtask discovered legacy languages not in scout assessment",
      newSubtask: {
        type: "legacy-patterns" as ScanSubtaskType,
        title: "Legacy Code Pattern Analysis (auto-added)",
        description: "Analyze newly discovered legacy language patterns",
        priority: 4,
        requiredSkills: ["legacy-analysis"],
        requiredTechStack: opts.fileAnalysis.detectedLanguages.map((l) => l.toLowerCase()),
      },
    };
  }

  // Heuristic 2: If output mentions database/schema but no data-layer planned
  const mentionsData = ["database", "schema", "migration", "erd", "table", "vsam", "sequel"].some(
    (term) => latestResult.output.toLowerCase().includes(term),
  );

  if (mentionsData && !remainingTypes.has("data-layer")) {
    // Only add if we haven't already completed a data-layer subtask
    const alreadyDone = completedResults.some((r) => r.type === "data-layer");
    if (!alreadyDone) {
      return {
        action: "add",
        reason: "Subtask revealed data layer concerns not in original plan",
        newSubtask: {
          type: "data-layer" as ScanSubtaskType,
          title: "Data Layer Assessment (auto-added)",
          description: "Analyze data storage patterns discovered during analysis",
          priority: 5,
          requiredSkills: ["data-architecture"],
          requiredTechStack: [],
        },
      };
    }
  }

  // Heuristic 3: Skip security-scan if codebase is trivially small and already covered
  if (
    remainingTypes.has("security-scan") &&
    opts.fileAnalysis.totalLines < 500 &&
    successful.some((r) => r.output.toLowerCase().includes("security"))
  ) {
    return {
      action: "skip",
      reason: "Security already covered in prior subtask for this small codebase",
      skipType: "security-scan",
    };
  }

  return null; // No revision needed
}

// ─── FINDINGS EXTRACTION ────────────────────────────────────────

/**
 * Extract key findings from subtask output for memory storage.
 * Looks for markdown headers and table rows as structured findings.
 */
function extractSubtaskFindings(output: string): string[] {
  const findings: string[] = [];

  // Extract lines that look like key findings (headers, bullet points, table rows with severity)
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();

    // Severity indicators in table rows
    if (trimmed.includes("🔴") || trimmed.includes("CRITICAL")) {
      findings.push(trimmed.replace(/\|/g, " ").replace(/\s+/g, " ").trim());
    }
    // Key observation bullets
    if (trimmed.startsWith("- ") && trimmed.length > 20 && trimmed.length < 200) {
      findings.push(trimmed.slice(2));
    }

    if (findings.length >= 15) break; // Cap at 15 findings
  }

  return findings;
}
