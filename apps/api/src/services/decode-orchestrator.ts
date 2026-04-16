/**
 * Decode Orchestrator — multi-agent delegation for Stage 2 (DECODE / Intent Extraction).
 *
 * Follows the same pattern as scan-orchestrator but:
 *   1. No scout triage — Stage 1 SCAN output IS the assessment
 *   2. Director Planning (Sonnet) — plans subtasks based on SCAN output
 *   3. Subtask Execution (sequential) — specialists extract intent
 *   4. Composition (Sonnet) — merges into single DECODE document
 *
 * The SCAN output is loaded from stage artifacts and passed to the Director
 * and each specialist as primary context.
 *
 * No silent fallbacks — every failure is surfaced to the user with re-run capability.
 */

import crypto from "crypto";
// Advisor tool: enable Opus guidance for strategic calls (director, composition)
const DECODE_ADVISOR_ENABLED = process.env.ADVISOR_ENABLED !== 'false';
const DECODE_ADVISOR_CONFIG = DECODE_ADVISOR_ENABLED ? { enabled: true, model: 'claude-opus-4-6', max_uses: 2 } as const : undefined;

import { db } from "@/db/index.js";
import { stageArtifacts, agentSubtasks, agentPersonas } from "@/db/schema.js";
import { eq, isNull, and } from "drizzle-orm";
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
  validateSubtaskOutput,
  DECODE_DIRECTOR_PLAN,
  DECODE_SUBTASK_TEMPLATES,
  DECODE_COMPOSITION,
  DEFAULT_DECODE_SUBTASKS,
  type DecodeSubtaskType,
} from "@revamp/core-engine";
import { llmProxyService, type ProjectCredentials, type StageTokenUsage } from "./llm-proxy.js";
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
  type SessionData,
} from "./agent-sessions.js";
import {
  runQuickReview,
} from "./two-stage-review.js";
// Budget enforcement removed — cost tracking retained in pipeline.ts

// ─── TYPES ──────────────────────────────────────────────────────

export interface DecodeOrchestrationOptions {
  pipelineRunId: string;
  projectContext: ProjectContext;
  scanOutput: string; // Stage 1 SCAN output — primary context
  priorOutputs: StageOutput[];
  feedback: UserFeedback[];
  onEvent?: OnStageEvent;
  onDelta?: OnDelta;
  signal?: AbortSignal;
  model?: string;
  /** Director/composition model override (e.g. Opus for high-quality composition) */
  composerModel?: string;
  maxTokens?: number;
  /** BYOK credentials from project settings */
  credentials?: ProjectCredentials;
}

interface SubtaskPlan {
  type: DecodeSubtaskType;
  title: string;
  description: string;
  assignToAgent?: string;
  priority: number;
  requiredSkills: string[];
  requiredTechStack: string[];
}

interface SubtaskResult {
  subtaskId: string;
  type: DecodeSubtaskType;
  title: string;
  agentName: string;
  output: string;
  duration: number;
  status: "completed" | "failed";
  error?: string;
}

// ─── MAIN ORCHESTRATOR ──────────────────────────────────────────

export async function orchestrateDecodeStage(
  opts: DecodeOrchestrationOptions,
): Promise<StageRunResult> {
  const startTime = Date.now();
  const phases: StageEvent[] = [];

  // ── SHARED TOKEN ACCUMULATOR ──────────────────────────────────
  // All sub-agent createCallFn calls share this accumulator so the
  // orchestrator can report a single aggregate token spend to the recorder.
  const stageTokenUsage: StageTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
  };

  const emit = (phase: StagePhase, data?: Record<string, unknown>) => {
    const event: StageEvent = {
      phase,
      stageName: PipelineStageName.DECODE,
      stageIndex: 1,
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

  // ── STEP 1: DIRECTOR PLANNING ─────────────────────────────────
  let subtaskPlans: SubtaskPlan[];
  try {
    emit("director_planning", { message: "Director planning DECODE subtask delegation..." });
    checkAbort();
    subtaskPlans = await runDirectorPlanning(opts, stageTokenUsage);
    emit("director_planning", {
      message: `Director planned ${subtaskPlans.length} subtasks`,
      subtaskCount: subtaskPlans.length,
      subtasks: subtaskPlans.map((s) => ({ type: s.type, title: s.title, priority: s.priority })),
    });
  } catch (err) {
    // Director parse fail — use default subtask set (graceful degradation)
    const errMsg = err instanceof Error ? err.message : String(err);
    opts.onEvent?.({
      phase: "director_planning",
      stageName: PipelineStageName.DECODE,
      stageIndex: 1,
      timestamp: new Date().toISOString(),
      data: {
        warning: "Director plan unparseable, using default subtask set",
        error: errMsg,
      },
    });

    subtaskPlans = DEFAULT_DECODE_SUBTASKS.map((d) => ({
      type: d.type,
      title: d.title,
      description: `Default: ${d.title}`,
      priority: d.priority,
      requiredSkills: [],
      requiredTechStack: [],
    }));
  }

  // ── STEP 2: SUBTASK EXECUTION ─────────────────────────────────
  const createdSubtasks: Array<{ plan: SubtaskPlan; subtask: SubtaskView }> = [];
  const directorAgentId = await findDirectorAgentId();

  for (const plan of subtaskPlans) {
    try {
      const subtask = await createSubtask(directorAgentId, {
        pipelineRunId: opts.pipelineRunId,
        stageName: PipelineStageName.DECODE,
        title: plan.title,
        description: plan.description,
        requiredSkills: plan.requiredSkills,
        requiredTechStack: plan.requiredTechStack,
        priority: plan.priority,
      });

      createdSubtasks.push({ plan, subtask });

      opts.onEvent?.({
        phase: "subtask_executing",
        stageName: PipelineStageName.DECODE,
        stageIndex: 1,
        timestamp: new Date().toISOString(),
        data: {
          event: "subtask_created",
          subtaskId: subtask.id,
          title: plan.title,
          type: plan.type,
          priority: plan.priority,
        },
      });
    } catch (createErr) {
      console.warn(`[DECODE] Failed to create subtask ${plan.type}:`, createErr instanceof Error ? createErr.message : createErr);
    }
  }

  // ── STEP 2: SUBTASK EXECUTION ──────────────────────────────────
  //
  // Sliding-window concurrency pool for extraction. All DECODE subtasks are
  // independent (same SCAN input, no cross-dependencies). As soon as one slot
  // frees up, the next subtask starts immediately.

  const CONCURRENCY = 3;
  const SUBTASK_TIMEOUT_MS = 5 * 60 * 1000;
  const subtaskResults: SubtaskResult[] = [];

  // Worker function: execute a single subtask with retry + review
  async function runSubtaskWorker({ plan, subtask }: typeof createdSubtasks[number]): Promise<void> {
    const subtaskStart = Date.now();
    const origSignal = opts.signal;

    opts.onEvent?.({
      phase: "subtask_executing",
      stageName: PipelineStageName.DECODE,
      stageIndex: 1,
      timestamp: new Date().toISOString(),
      data: {
        event: "subtask_started",
        subtaskId: subtask.id,
        title: plan.title,
        type: plan.type,
        agentName: subtask.assignedAgentName || "pending",
      },
    });

    let finalResult: SubtaskResult | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const subtaskController = new AbortController();
      const subtaskTimer = setTimeout(() => subtaskController.abort(), SUBTASK_TIMEOUT_MS);
      if (origSignal) {
        origSignal.addEventListener("abort", () => subtaskController.abort(), { once: true });
      }

      try {
        let result: SubtaskResult;
        try {
          result = await executeSubtask(
            { ...opts, signal: subtaskController.signal },
            plan, subtask, subtaskResults, stageTokenUsage,
          );
        } catch (timeoutErr: any) {
          if (subtaskController.signal.aborted && !origSignal?.aborted) {
            throw new Error(`Subtask timed out after ${SUBTASK_TIMEOUT_MS / 1000}s: ${plan.title}`);
          }
          throw timeoutErr;
        } finally {
          clearTimeout(subtaskTimer);
        }

        if (result.status === "completed" && result.output) {
          try {
            const review = await runQuickReview({
              pipelineRunId: opts.pipelineRunId,
              stageName: PipelineStageName.DECODE,
              subtaskType: plan.type,
              output: result.output,
              referenceInput: opts.scanOutput?.slice(0, 6000),
              credentials: opts.credentials,
            });
            (result as any).reviewScore = review.overallScore;
            (result as any).reviewVerdict = review.overallVerdict;
          } catch { /* Review failure is non-fatal */ }
        }

        finalResult = result;
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt === 0) {
          opts.onEvent?.({
            phase: "subtask_executing",
            stageName: PipelineStageName.DECODE,
            stageIndex: 1,
            timestamp: new Date().toISOString(),
            data: { event: "subtask_retrying", subtaskId: subtask.id, title: plan.title, type: plan.type, error: errMsg, attempt: 2 },
          });
          continue;
        }
        await failSubtask(subtask.id, errMsg);
        finalResult = { subtaskId: subtask.id, type: plan.type, title: plan.title, agentName: "none", output: "", duration: Date.now() - subtaskStart, status: "failed" as const, error: errMsg };
      }
    }

    if (finalResult) {
      subtaskResults.push(finalResult);
      const completedCount = subtaskResults.filter(r => r.status === "completed").length;
      const subtaskProgress = Math.round((completedCount / subtaskPlans.length) * 70);

      opts.onEvent?.({
        phase: finalResult.status === "failed" ? "subtask_failed" : "subtask_completed",
        stageName: PipelineStageName.DECODE,
        stageIndex: 1,
        timestamp: new Date().toISOString(),
        data: {
          event: finalResult.status === "failed" ? "subtask_failed" : "subtask_completed",
          subtaskId: subtask.id, title: plan.title, type: plan.type,
          agentName: finalResult.agentName, duration: Date.now() - subtaskStart,
          progress: subtaskProgress,
          ...(finalResult.error ? { error: finalResult.error } : {}),
        },
      });
    }
  }

  // Sliding window: maintain CONCURRENCY active workers
  {
    let nextIdx = 0;
    const active = new Set<Promise<void>>();
    while (nextIdx < createdSubtasks.length || active.size > 0) {
      checkAbort();
      while (active.size < CONCURRENCY && nextIdx < createdSubtasks.length) {
        const item = createdSubtasks[nextIdx++];
        const p = runSubtaskWorker(item).catch((err) => {
          console.error(`[DECODE] subtask worker failed for ${item.plan.type}:`, err instanceof Error ? err.message : err);
        });
        active.add(p);
        p.finally(() => active.delete(p));
      }
      if (active.size > 0) await Promise.race(active);
    }
  }

  // Check if ALL subtasks failed
  const successfulResults = subtaskResults.filter((r) => r.status === "completed");
  if (successfulResults.length === 0) {
    emit("failed", { message: "All DECODE subtasks failed. Please re-run the stage.", errors: subtaskResults.map((r) => ({ type: r.type, error: r.error })) });
    const failedValidation: import("@revamp/core-engine").FullValidationResult = {
      pipelineRunId: opts.pipelineRunId, stageName: PipelineStageName.DECODE, timestamp: new Date().toISOString(),
      passed: false, confidenceScore: 0, deterministicResults: [], llmResults: [],
      issues: [{ id: "decode-all-failed", code: "ALL_SUBTASKS_FAILED", severity: "ERROR" as const, title: "All DECODE subtasks failed", description: subtaskResults.map((r) => `${r.type}: ${r.error}`).join("; ") }],
      recommendations: ["Re-run the DECODE stage after checking LLM connectivity"],
      contractResult: { stageName: PipelineStageName.DECODE, passed: false, completenessScore: 0, violations: [], refinementPrompt: null, hardGated: false },
      metadata: {},
    };
    return { stageName: PipelineStageName.DECODE, stageIndex: 1, output: "", validation: failedValidation, refinementCount: 0, duration: Date.now() - startTime, phases, aborted: false, tokenUsage: stageTokenUsage };
  }

  // ── STEP 3: SMART COMPOSITION ───────────────────────────────────
  //
  // Context-aware single-call composition. Adapts to model capability:
  //
  //   Opus 4.6 (1M context): Feed ALL subtask outputs verbatim. Zero truncation.
  //     The model deduplicates, cross-references, and structures in one pass.
  //
  //   Sonnet 4.6 / Haiku (200K context): Priority-pack structured data first
  //     (BRs, tables, diagrams, code blocks), then fill with prose.
  //
  // Composer model can be upgraded from the executor model via env var
  // DECODE_COMPOSER_MODEL (e.g., "us.anthropic.claude-opus-4-6-v1:0").

  // Determine the composition model — priority: UI override > env var > executor model
  const executorModel = opts.model || "";
  const composerModel = opts.composerModel || process.env.DECODE_COMPOSER_MODEL || executorModel;
  // Detect large-context models by name patterns. Context window:
  //   Opus 4.6: 1M tokens  |  Gemini Pro: 1M+  |  Sonnet 4.6: 200K
  // Models with >500K token context can take all subtask outputs verbatim.
  const isLargeContext = /opus/i.test(composerModel)
    || /gemini.*pro/i.test(composerModel)
    || /gemini.*1\.5/i.test(composerModel);

  emit("composing", {
    message: `Composing with ${isLargeContext ? "large-context" : "standard"} model: ${composerModel || "default"}`,
    progress: 75,
  });

  // ── Build composition input based on context capacity ─────────

  let compositionInput: string;
  let inputStats: { totalBRs: number; totalDiagrams: number; truncated: boolean };

  if (isLargeContext) {
    // ── LARGE CONTEXT (Opus 1M, Gemini Pro 1M+) ──
    // Feed all subtask outputs verbatim — zero truncation.
    compositionInput = successfulResults.map((r, i) => {
      return [
        `═══ SUBTASK ${i + 1}: ${r.title} (${r.type}) ═══`,
        `Agent: ${r.agentName}`,
        `Duration: ${Math.round(r.duration / 1000)}s`,
        "",
        r.output,
        "",
      ].join("\n");
    }).join("\n");

    const totalBRs = (compositionInput.match(/BR-\d+/gi) || []).length;
    const totalDiagrams = (compositionInput.match(/```mermaid/gi) || []).length;
    inputStats = { totalBRs, totalDiagrams, truncated: false };

    emit("composing", {
      message: `Full context: ${Math.round(compositionInput.length / 1000)}K chars, ${totalBRs} BRs, ${totalDiagrams} diagrams — zero truncation`,
      progress: 78,
    });
  } else {
    // ── STANDARD CONTEXT (Sonnet/Haiku 200K) ──
    // Priority-pack: structured data first (always included), prose fills remainder.
    const AVAILABLE_CHARS = 620_000; // (190K - 35K overhead) × 4 chars/token

    /** Separate structured data (high priority) from prose (trimmable). */
    function splitPriority(output: string): { structured: string; prose: string } {
      const lines = output.split("\n");
      const high: string[] = [];
      const low: string[] = [];
      let inFenced = false;

      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("```")) { inFenced = !inFenced; high.push(line); continue; }
        if (inFenced) { high.push(line); continue; }
        if (/BR-\d+/i.test(line) || t.startsWith("|") || t.startsWith("#")) { high.push(line); continue; }
        low.push(line);
      }
      return { structured: high.join("\n"), prose: low.join("\n") };
    }

    const packed = successfulResults.map((r) => {
      const { structured, prose } = splitPriority(r.output);
      return { title: r.title, type: r.type, structured, prose };
    });

    const totalStructuredChars = packed.reduce((s, p) => s + p.structured.length + 150, 0);
    const proseBudgetPerSubtask = Math.floor(
      Math.max(0, AVAILABLE_CHARS - totalStructuredChars) / Math.max(packed.length, 1)
    );

    compositionInput = packed.map((sp, i) => {
      const prose = sp.prose.length > proseBudgetPerSubtask
        ? sp.prose.slice(0, proseBudgetPerSubtask) + `\n[... ${sp.prose.length - proseBudgetPerSubtask} chars trimmed ...]`
        : sp.prose;
      return [`═══ SUBTASK ${i + 1}: ${sp.title} (${sp.type}) ═══`, "", sp.structured, "", prose, ""].join("\n");
    }).join("\n");

    const totalBRs = (compositionInput.match(/BR-\d+/gi) || []).length;
    const totalDiagrams = (compositionInput.match(/```mermaid/gi) || []).length;
    inputStats = { totalBRs, totalDiagrams, truncated: proseBudgetPerSubtask < 50000 };

    emit("composing", {
      message: `Priority-packed: ${Math.round(compositionInput.length / 1000)}K chars, ${totalBRs} BRs, ${totalDiagrams} diagrams${inputStats.truncated ? " (prose trimmed)" : ""}`,
      progress: 78,
    });
  }

  const failedResults = subtaskResults.filter((r) => r.status === "failed");
  const failedNote = failedResults.length > 0
    ? `\n\nNOTE: The following subtasks failed:\n${failedResults.map((r) => `- ${r.title}: ${r.error}`).join("\n")}\n`
    : "";

  emit("composing", { message: `Composing final document (${Math.round(compositionInput.length / 1000)}K chars input)...`, progress: 80 });

  // ── Single composition call ───────────────────────────────────

  // Skip advisor when composer IS already Opus (redundant and doubles cost)
  const useAdvisor = DECODE_ADVISOR_CONFIG && !/opus/i.test(composerModel);

  const composerCallFn = llmProxyService.createCallFn({
    maxTokens: opts.maxTokens || 32768,
    model: composerModel,
    credentials: opts.credentials,
    advisor: useAdvisor ? DECODE_ADVISOR_CONFIG : undefined,
    tokenUsage: stageTokenUsage,
  });

  opts.onDelta?.("");

  const compositionSystemPrompt = [
    "You are a lead architect composing a comprehensive DECODE / Intent Extraction document from specialist analysis reports.",
    "",
    "## STRUCTURE RULE (HIGHEST PRIORITY — READ THIS FIRST)",
    "You MUST produce EXACTLY these 10 H2 sections in EXACTLY this order. No more, no fewer.",
    "Do NOT organize by file type (.twig, .vue, .css, .xml, etc.) — that is a SCAN-stage concern, not DECODE.",
    "DECODE extracts BUSINESS INTENT: rules, workflows, data flows, entities, integrations.",
    "If you produce sections like '## Twig Templates' or '## CSV Data Files', you have FAILED.",
    "Strategy: Write ALL 10 section headings first, then fill each with appropriate detail.",
    "If you are running low on output space, make early sections more concise — do NOT skip later sections.",
    "",
    "## REQUIRED H2 SECTIONS (in this order, with word budget guide):",
    "",
    "1. ## Executive Summary (~300-500 words)",
    "   System overview, top 5 modernization concerns, key metrics from verified ground truth.",
    "",
    "2. ## Business Rules (~3000-5000 words)",
    "   BR-ID inventory TABLE with columns: ID, Name, Description, Type, Trigger, Source File, Confidence.",
    "   Include ONLY genuine business rules — NOT config files, build tools, CI/CD, SCSS compilation, or documentation.",
    "   A business rule defines domain behavior: transactions, accounts, budgets, authentication, authorization, workflows.",
    "   Deduplicate across specialists. Renumber sequentially (BR-001, BR-002, ...).",
    "",
    "3. ## Key Workflows (~1000-2000 words)",
    "   End-to-end workflows with Mermaid sequence/state diagrams. Max 5-7 key workflows.",
    "",
    "4. ## Data Flows (~800-1500 words)",
    "   ER diagram, data transformation points, storage architecture.",
    "",
    "5. ## Domain Entities (~500-1000 words)",
    "   Entity inventory table with relationships and aggregate boundaries.",
    "",
    "6. ## Integration Points (~500-800 words)",
    "   TABLE: every external API, email, queue, cache, webhook, OAuth provider, file storage.",
    "   | Integration | Type | Protocol | Direction | Config Location |",
    "",
    "7. ## Constraints & Assumptions (~300-500 words)",
    "   Technology lock-ins, licensing (AGPL, etc.), compliance flags, SLAs, deployment requirements.",
    "",
    "8. ## Technical Debt (~500-800 words)",
    "   Standalone section — NOT embedded in Executive Summary.",
    "   TABLE: dead code, god classes, duplicated logic, deprecated deps, missing tests, hardcoded values.",
    "   | Item | Type | Severity | Location | Impact |",
    "",
    "9. ## Open Questions (~300-500 words)",
    "   5-15 specific questions needing SME clarification before modernization.",
    "   Every codebase has unknowns. If you found none, you didn't look hard enough.",
    "",
    "10. ## Migration Readiness Assessment (~200-400 words)",
    "    Ready/Conditional/Not Ready. Blockers, risks, recommended next steps for Stage 3.",
    "",
    "## COMPOSITION RULES:",
    "1. DEDUPLICATE business rules across specialists — one BR per unique rule.",
    "2. PRESERVE Mermaid diagrams verbatim (skip exact duplicates).",
    "3. PRESERVE file path citations — but do NOT fabricate file paths that don't exist.",
    "4. Use verified ground truth for all version numbers, component counts, line counts.",
    "5. Do NOT paraphrase verified versions (e.g. if ground truth says PHP >=8.5, write >=8.5 not 8.2+).",
    "6. Cross-reference across sections (e.g. 'BR-042 relates to the data flow in Section 4').",
    "7. Every component from SCAN must appear somewhere with extracted business rules.",
  ].join("\n");

  let composedOutput: string;
  try {
    composedOutput = await composerCallFn({
      systemPrompt: compositionSystemPrompt,
      userPrompt: DECODE_COMPOSITION.replace("{{subtaskResults}}", compositionInput + failedNote),
      onDelta: opts.onDelta,
      signal: opts.signal,
    });
  } catch (firstErr) {
    const firstErrMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const isContextError = /context.length|too.long|token.limit|max.tokens/i.test(firstErrMsg);

    emit("composing", {
      message: `Composition failed (${firstErrMsg}), retrying${isContextError ? " with reduced input" : ""}...`,
      progress: 82,
    });

    // On context-length errors, aggressively truncate input.
    // On other errors, retry with same input (may be transient).
    const retryInput = isContextError
      ? compositionInput.slice(0, Math.floor(compositionInput.length * 0.6)) +
        "\n\n[... input truncated to fit model context window. Prioritize structured data (BRs, tables, diagrams) over prose ...]"
      : compositionInput;

    try {
      composedOutput = await composerCallFn({
        systemPrompt: compositionSystemPrompt,
        userPrompt: DECODE_COMPOSITION.replace("{{subtaskResults}}", retryInput + failedNote),
        onDelta: opts.onDelta,
        signal: opts.signal,
      });
    } catch (retryErr) {
      const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      emit("failed", { message: `DECODE composition failed after retry: ${errMsg}`, error: errMsg });
      const compositionFailedValidation: import("@revamp/core-engine").FullValidationResult = {
        pipelineRunId: opts.pipelineRunId, stageName: PipelineStageName.DECODE, timestamp: new Date().toISOString(),
        passed: false, confidenceScore: 0, deterministicResults: [], llmResults: [],
        issues: [{ id: "decode-composition-failed", code: "COMPOSITION_FAILED", severity: "ERROR" as const, title: "DECODE composition failed", description: errMsg }],
        recommendations: ["Re-run the DECODE stage"],
        contractResult: { stageName: PipelineStageName.DECODE, passed: false, completenessScore: 0, violations: [], refinementPrompt: null, hardGated: false },
        metadata: {},
      };
      return { stageName: PipelineStageName.DECODE, stageIndex: 1, output: "", validation: compositionFailedValidation, refinementCount: 0, duration: Date.now() - startTime, phases, aborted: false, tokenUsage: stageTokenUsage };
    }
  }

  const outputBRs = (composedOutput.match(/BR-\d+/gi) || []).length;
  const outputDiagrams = (composedOutput.match(/```mermaid/gi) || []).length;

  emit("composing", {
    message: `Composition complete — ${composedOutput.length} chars, ${outputBRs} BRs, ${outputDiagrams} diagrams (from ${inputStats.totalBRs} input BRs)`,
    progress: 88,
    docLength: composedOutput.length,
    outputBRs,
    outputDiagrams,
    inputBRs: inputStats.totalBRs,
  });

  // ── EARLY SAVE: persist composition output immediately ─────────
  // The SSE connection can drop during long-running validation/refinement.
  // By saving the artifact now, the output is preserved even if later phases fail.
  try {
    await db.insert(stageArtifacts).values({
      pipeline_run_id: opts.pipelineRunId,
      stage_name: PipelineStageName.DECODE,
      artifact_type: "stage_output",
      storage_path: `decode/${opts.pipelineRunId}/output.md`,
      file_size: composedOutput.length,
      metadata: { content: composedOutput, output: composedOutput },
    });
  } catch (saveErr) {
    // Non-fatal — the pipeline route's finally block will also try to save
    console.warn("[DECODE] Early artifact save failed:", saveErr instanceof Error ? saveErr.message : saveErr);
  }

  // ── STEP 4: COVERAGE CHECK — targeted refinement on gaps ────────
  //
  // Legacy production apps have dozens of components. If DECODE misses even a
  // few, the modernized system silently drops functionality. Coverage must be
  // measured and enforced — not just reported.
  let refinementCount = 0;
  const scanComponents = extractScanComponents(opts.scanOutput);
  const COVERAGE_THRESHOLD = 0.65; // Minimum 65% component coverage

  if (scanComponents.length > 0) {
    let coverage = measureDecodeCoverage(composedOutput, scanComponents);
    emit("coverage_check" as StagePhase, {
      message: `DECODE coverage: ${Math.round(coverage.percentage * 100)}% (${coverage.covered}/${coverage.total} components)`,
      coverage: Math.round(coverage.percentage * 100),
      covered: coverage.covered,
      total: coverage.total,
      uncovered: coverage.uncovered.slice(0, 10),
      progress: 88,
    });

    // If coverage is below threshold, run a targeted refinement pass that
    // explicitly names the missing components and asks the composer to address them.
    if (coverage.percentage < COVERAGE_THRESHOLD && coverage.uncovered.length > 0) {
      emit("refining" as StagePhase, {
        message: `Coverage ${Math.round(coverage.percentage * 100)}% is below ${Math.round(COVERAGE_THRESHOLD * 100)}% — refining with ${coverage.uncovered.length} uncovered components`,
        progress: 89,
      });

      try {
        const uncoveredList = coverage.uncovered.slice(0, 20).map((c, i) => `${i + 1}. ${c}`).join("\n");
        const coverageRefinementPrompt = [
          "## Coverage Gap",
          "",
          `The DECODE output only covers ${Math.round(coverage.percentage * 100)}% of the components discovered in SCAN.`,
          "",
          "The following components from SCAN are NOT addressed in the DECODE output:",
          uncoveredList,
          "",
          "## Required Action",
          "For EACH uncovered component above, add a section that extracts:",
          "- Business rules (with BR-IDs)",
          "- Data flows (inputs, outputs, storage)",
          "- Integration points",
          "- Key workflows",
          "",
          "Integrate these into the existing document structure. Do NOT remove any existing content.",
        ].join("\n");

        composedOutput = await refineComposition(opts, composedOutput, coverageRefinementPrompt, stageTokenUsage);
        refinementCount++;

        // Re-measure coverage after refinement
        coverage = measureDecodeCoverage(composedOutput, scanComponents);
        emit("coverage_check" as StagePhase, {
          message: `Post-refinement coverage: ${Math.round(coverage.percentage * 100)}% (${coverage.covered}/${coverage.total})`,
          coverage: Math.round(coverage.percentage * 100),
          covered: coverage.covered,
          total: coverage.total,
          uncovered: coverage.uncovered.slice(0, 5),
          progress: 91,
        });

        // Update early artifact with refined version
        try {
          await db.insert(stageArtifacts).values({
            pipeline_run_id: opts.pipelineRunId,
            stage_name: PipelineStageName.DECODE,
            artifact_type: "stage_output",
            storage_path: `decode/${opts.pipelineRunId}/output.md`,
            file_size: composedOutput.length,
            metadata: { content: composedOutput, output: composedOutput },
          }).onConflictDoUpdate({
            target: [stageArtifacts.pipeline_run_id, stageArtifacts.stage_name, stageArtifacts.artifact_type],
            set: { file_size: composedOutput.length, metadata: { content: composedOutput, output: composedOutput } },
          });
        } catch {
          // Non-fatal — original artifact still exists
        }
      } catch (refineErr) {
        // Refinement failed — keep original composition but log the gap
        console.warn("[DECODE] Coverage refinement failed:", refineErr instanceof Error ? refineErr.message : refineErr);
      }
    }
  }

  // ── STEP 5: CONTRACT VALIDATION ──────────────────────────────
  const contractResult = await enforceContract(PipelineStageName.DECODE, composedOutput);

  if (!contractResult.passed && contractResult.refinementPrompt) {
    emit("refining" as StagePhase, { message: "Refining composition to meet DECODE contract...", progress: 92 });
    try {
      const refinedOutput = await refineComposition(opts, composedOutput, contractResult.refinementPrompt, stageTokenUsage);
      composedOutput = refinedOutput;
      refinementCount++;

      const revalidation = await enforceContract(PipelineStageName.DECODE, composedOutput);
      if (!revalidation.passed) {
        emit("completed", {
          message: "DECODE validation has gaps but output is usable",
          validationScore: revalidation.completenessScore,
          violations: revalidation.violations.length,
        });
      }
    } catch (contractRefineErr) {
      console.warn("[DECODE] Contract refinement failed, keeping original:", contractRefineErr instanceof Error ? contractRefineErr.message : contractRefineErr);
    }
  }

  // Build FullValidationResult — single LLM-based validation pass
  // One agent function handles both contract enforcement and section validation.
  const validationAgentFn = llmProxyService.createCallFn({
    maxTokens: 2048,
    model: opts.model || "",
    credentials: opts.credentials,
    tokenUsage: stageTokenUsage,
  });
  let finalContractResult = await enforceContract(PipelineStageName.DECODE, composedOutput, undefined, validationAgentFn as any);

  // Upgrade section checks with LLM agent (replaces regex with semantic understanding)
  try {
    emit("validating" as StagePhase, { message: "Agent validating section completeness...", progress: 95 });
    // Dynamic import to avoid circular dependency — validateSectionsWithAgent is async
    const stageContractsMod = await import("@revamp/core-engine") as any;
    const agentValidateFn = stageContractsMod.validateSectionsWithAgent;
    if (!agentValidateFn) throw new Error("validateSectionsWithAgent not available");
    const agentResult = await agentValidateFn(
      PipelineStageName.DECODE,
      composedOutput,
      validationAgentFn,
    ) as { sectionResults: Array<{ heading: string; found: boolean; quality: string; matchedHeading?: string; wordCount?: number; reasoning: string }>; score: number };

    if (agentResult.sectionResults.length > 0) {
      // Override deterministic section violations with agent results
      const agentMissing = agentResult.sectionResults.filter((r: { found: boolean }) => !r.found);
      const agentThin = agentResult.sectionResults.filter((r: { found: boolean; quality: string }) => r.found && r.quality === 'thin');

      // Remove all deterministic missing_section violations and replace with agent findings
      const nonSectionViolations = finalContractResult.violations.filter(v => v.type !== 'missing_section' && v.type !== 'thin_section');
      const agentViolations = [
        ...agentMissing.map((r: any) => ({
          type: 'missing_section' as const,
          severity: 'critical' as const,
          description: `Missing required section: "${r.heading}" — ${r.reasoning}`,
          section: r.heading,
        })),
        ...agentThin.map((r: any) => ({
          type: 'thin_section' as const,
          severity: 'major' as const,
          description: `Section "${r.heading}" is thin (${r.wordCount ?? 0} words) — ${r.reasoning}`,
          section: r.heading,
          actual: r.wordCount,
          expected: 100,
        })),
      ];

      const allViolations = [...nonSectionViolations, ...agentViolations];
      const agentScore = agentResult.score;
      const patternScore = finalContractResult.completenessScore;
      // Blend: 60% agent section score + 40% deterministic pattern score
      const blendedScore = Math.min(100, Math.round(agentScore * 0.6 + patternScore * 0.4));

      const hasCriticalViolations = allViolations.some(v => v.severity === 'critical');
      const passesThreshold = blendedScore >= 70;

      finalContractResult = {
        ...finalContractResult,
        violations: allViolations,
        completenessScore: blendedScore,
        passed: !hasCriticalViolations && passesThreshold,
        // Hard-gate when contract says so OR when critical sections are missing.
        // Score threshold alone doesn't trigger hard-gate — that's what the
        // approval gate's confidence threshold is for.
        hardGated: finalContractResult.hardGated || hasCriticalViolations,
      };
    }
  } catch (agentValErr) {
    console.warn("[DECODE] Agent section validation failed, using deterministic results:", agentValErr instanceof Error ? agentValErr.message : agentValErr);
  }

  const validationResult: import("@revamp/core-engine").FullValidationResult = {
    pipelineRunId: opts.pipelineRunId,
    stageName: PipelineStageName.DECODE,
    timestamp: new Date().toISOString(),
    passed: finalContractResult.passed,
    confidenceScore: Math.max(0, Math.min(100, finalContractResult.completenessScore)),
    deterministicResults: finalContractResult.violations.map((v) => ({
      name: v.type,
      type: "SECTION_COMPLETENESS" as any,
      score: v.severity === "critical" ? 0 : v.severity === "major" ? 0.4 : 0.7,
      weight: v.severity === "critical" ? 0.3 : 0.15,
      status: (v.severity === "critical" ? "FAIL" : "WARN") as "FAIL" | "WARN",
      message: v.description,
      details: { section: v.section, actual: v.actual, expected: v.expected },
    })),
    llmResults: [],
    issues: finalContractResult.violations.map((v, i) => ({
      id: `decode-v-${i}`,
      code: v.type,
      severity: (v.severity === "critical" ? "ERROR" : v.severity === "major" ? "WARN" : "INFO") as "ERROR" | "WARN" | "INFO",
      title: v.description,
      description: v.description,
    })),
    recommendations: finalContractResult.violations
      .filter((v) => v.severity === "critical")
      .map((v) => `Fix: ${v.description}`),
    contractResult: finalContractResult,
    metadata: {},
  };

  emit("completed", {
    message: "DECODE intent extraction complete",
    subtasksCompleted: successfulResults.length,
    subtasksFailed: subtaskResults.length - successfulResults.length,
    duration: Date.now() - startTime,
  });

  return {
    stageName: PipelineStageName.DECODE,
    stageIndex: 1,
    output: composedOutput,
    validation: validationResult,
    refinementCount,
    duration: Date.now() - startTime,
    phases,
    aborted: false,
    tokenUsage: stageTokenUsage,
  };
}

// ─── DIRECTOR PLANNING ─────────────────────────────────────────

async function runDirectorPlanning(
  opts: DecodeOrchestrationOptions,
  tokenUsage: StageTokenUsage,
): Promise<SubtaskPlan[]> {
  // Use composer model for director planning (higher quality = better subtask design)
  const directorModel = opts.composerModel || opts.model || "";
  const useAdvisorForDirector = DECODE_ADVISOR_CONFIG && !/opus/i.test(directorModel);
  const directorCallFn = llmProxyService.createCallFn({
    maxTokens: 4096,
    model: directorModel,
    credentials: opts.credentials,
    advisor: useAdvisorForDirector ? DECODE_ADVISOR_CONFIG : undefined,
    tokenUsage,
  });

  const agentRoster = await buildAgentRoster();

  // Truncate SCAN output for the director prompt — increased from 8K to 16K to preserve
  // frontend component discovery that was being silently dropped at lower limits
  const scanSummary = opts.scanOutput.length > 16000
    ? opts.scanOutput.slice(0, 16000) + "\n\n[... SCAN output truncated for planning ...]"
    : opts.scanOutput;

  const prompt = DECODE_DIRECTOR_PLAN
    .replace("{{scanOutput}}", scanSummary)
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

  const validTypes: Set<string> = new Set([
    // Mandatory
    "business-rules-extraction",
    "data-flow-analysis",
    "workflow-extraction",
    "constraints-debt-analysis",
    // Conditional — Director adds these based on SCAN complexity
    "domain-entity-modeling",
    "integration-mapping",
    "security-auth-analysis",
    "batch-job-analysis",
    "ui-frontend-analysis",
    "event-driven-analysis",
  ]);

  return plan
    .filter((s: any) => validTypes.has(s.type))
    .sort((a: any, b: any) => (a.priority || 5) - (b.priority || 5))
    .map((s: any) => ({
      type: s.type as DecodeSubtaskType,
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
  opts: DecodeOrchestrationOptions,
  plan: SubtaskPlan,
  subtask: SubtaskView,
  priorResults: SubtaskResult[],
  tokenUsage: StageTokenUsage,
): Promise<SubtaskResult> {
  const startTime = Date.now();

  const template = DECODE_SUBTASK_TEMPLATES[plan.type];
  if (!template) {
    throw new Error(`No template for DECODE subtask type: ${plan.type}`);
  }

  // Match an agent for this subtask
  let agentCtx: AgentStageContext | null = null;
  try {
    agentCtx = await matchAndAssignAgent(
      opts.pipelineRunId,
      PipelineStageName.DECODE,
      plan.requiredSkills.length > 0 ? plan.requiredSkills : [plan.type],
      plan.requiredTechStack,
    );
  } catch {
    // Non-fatal — run without agent identity
  }

  if (agentCtx) {
    try {
      await assignSubtask(subtask.id, agentCtx.agentId, agentCtx.agentId);
    } catch {
      // Non-fatal
    }
  }

  // Build context for the subtask prompt
  const codebaseContext = buildCodebaseContext(opts);
  const priorFindings = formatPriorFindings(priorResults);

  // Provide SCAN output as primary context — increased from 12K to 20K to preserve
  // all discovered components (backend + frontend + infrastructure)
  const scanContext = opts.scanOutput.length > 20000
    ? opts.scanOutput.slice(0, 20000) + "\n\n[... SCAN output truncated ...]"
    : opts.scanOutput;

  const filledPrompt = template
    .replace("{{codebaseContext}}", codebaseContext)
    .replace("{{scanOutput}}", scanContext)
    .replace("{{priorFindings}}", priorFindings);

  // Create LLM call function — use project-configured maxTokens
  const decodeMaxTokens = opts.maxTokens || 32768;
  let llmCallFn: LLMCallFn = llmProxyService.createCallFn({
    maxTokens: decodeMaxTokens,
    model: opts.model || "",
    credentials: opts.credentials,
    tokenUsage,
  });

  let agentExec: Awaited<ReturnType<typeof prepareAgentExecution>> | null = null;

  if (agentCtx) {
    try {
      agentExec = await prepareAgentExecution({
        agentCtx,
        baseLlmCallFn: llmCallFn,
        stageIndex: 1,
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
  // IMPORTANT: Do NOT pass onDelta — subtask output is internal and should NOT
  // use the streaming SSE path. When onDelta is omitted, the llmCallFn uses the
  // non-streaming /chat/completions endpoint which is a simple POST → JSON response.
  // This avoids the browser SSE timeout bug: the outer SSE connection from the browser
  // has no keepalive pings, so if the first Bedrock response takes 30+ seconds with no
  // data flowing, the browser closes the connection → context canceled → hung subtask.

  // Wrap in try/finally to ensure agent is always released, even on errors.
  // Without this, a failed runStage() leaves the agent in 'working' state forever.
  try {
    const result = await runStage({
      project: opts.projectContext,
      stageName: PipelineStageName.DECODE,
      stageIndex: 1,
      pipelineRunId: opts.pipelineRunId,
      templateVars: {},
      llmCallFn,
      priorOutputs: opts.priorOutputs,
      feedback: opts.feedback,
      // onDelta intentionally omitted → uses non-streaming path
      signal: opts.signal,
      skipValidation: true,
      promptOverride: filledPrompt,
      model: opts.model,
    });

    const effectiveOutput = result.output;

    // Lightweight validation
    const validation = validateSubtaskOutput(plan.type, effectiveOutput);
    if (!validation.passed) {
      console.warn(
        `[DecodeOrchestrator] Subtask ${plan.type} validation issues:`,
        validation.issues,
      );
    }

    // Complete subtask in DB
    try {
      await completeSubtask(subtask.id, { output: effectiveOutput, validation }, 0);
    } catch {
      // Non-fatal
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
          taskId: `${opts.pipelineRunId}:${PipelineStageName.DECODE}:${plan.type}`,
          pipelineRunId: opts.pipelineRunId,
          sessionData,
          tokenCount: Math.round(effectiveOutput.length / 4),
        });
      } catch {
        // Non-fatal
      }

      try {
        await recordAgentCompletion(
          agentCtx,
          {
            costCents: 0,
            tokensUsed: 0,
            refinementCount: result.refinementCount,
            result: { subtaskType: plan.type },
          },
          opts.pipelineRunId,
          "auto",
          opts.model || "default",
          0,
          0,
          PipelineStageName.DECODE,
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
    if (agentExec) {
      try { await agentExec.complete(); } catch (e) { console.error("[DecodeOrchestrator] Agent completion failed:", e); }
    }
  }
}

// ─── REFINEMENT ─────────────────────────────────────────────────

async function refineComposition(
  opts: DecodeOrchestrationOptions,
  output: string,
  refinementPrompt: string,
  tokenUsage: StageTokenUsage,
): Promise<string> {
  // Use composer model for refinement (same tier that composed the output)
  const refineModel = opts.composerModel || opts.model || "";
  const isLargeCtx = /opus/i.test(refineModel) || /gemini.*pro/i.test(refineModel);
  const callFn = llmProxyService.createCallFn({
    maxTokens: opts.maxTokens || 32768,
    model: refineModel,
    credentials: opts.credentials,
    tokenUsage,
  });

  opts.onDelta?.("");

  // Large-context models see the full output; standard models get truncated
  const outputBudget = isLargeCtx ? output.length : Math.min(output.length, 500000);
  const includedOutput = output.slice(0, outputBudget);
  const wasTruncated = outputBudget < output.length;

  const prompt = [
    "# Refinement Required",
    "",
    "Your previous DECODE output needs specific improvements.",
    "",
    "## Your Previous Output",
    includedOutput,
    wasTruncated ? `\n[... truncated from ${output.length} to ${outputBudget} chars ...]` : "",
    "",
    "## Required Improvements",
    refinementPrompt,
    "",
    "## Instructions",
    "Output the COMPLETE corrected document. Preserve all valid content, all code citations, all diagrams.",
  ].join("\n");

  return callFn({
    systemPrompt: "You are refining a DECODE intent extraction document. Address every listed issue. Preserve all business rule citations.",
    userPrompt: prompt,
    onDelta: opts.onDelta,
    signal: opts.signal,
  });
}

// ─── HELPERS ────────────────────────────────────────────────────

function buildCodebaseContext(opts: DecodeOrchestrationOptions): string {
  const parts: string[] = [];
  const p = opts.projectContext;

  if (p.projectName) parts.push(`**Project**: ${p.projectName}`);
  if (p.description) parts.push(`**Description**: ${p.description}`);
  if (p.sourceLanguages?.length) parts.push(`**Source Languages**: ${p.sourceLanguages.join(", ")}`);
  if (p.targetStack) parts.push(`**Target Stack**: ${p.targetStack}`);

  return parts.join("\n") || "No additional project context available.";
}

function formatPriorFindings(priorResults: SubtaskResult[]): string {
  if (priorResults.length === 0) {
    return "No prior DECODE subtask findings yet (this is the first subtask).";
  }

  const parts: string[] = [];
  for (const r of priorResults) {
    if (r.status !== "completed" || !r.output) continue;
    parts.push(`\n--- ${r.title} (${r.agentName}) ---`);
    parts.push(r.output.slice(0, 3000));
    if (r.output.length > 3000) parts.push("[... truncated ...]");
  }

  return parts.join("\n") || "No prior findings available.";
}

async function buildAgentRoster(): Promise<string> {
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
        stage_permissions: true,
      },
    });

    // Filter to agents that have DECODE permission
    const decodeAgents = agents.filter((a) => {
      const perms = (a.stage_permissions as string[]) || [];
      return perms.includes(PipelineStageName.DECODE) || perms.includes("*");
    });

    if (decodeAgents.length === 0) {
      return "No agents currently available. Use default assignments.";
    }

    return decodeAgents
      .map((a) => {
        const skills = (a.skills as Array<{ name: string }>) || [];
        const skillNames = skills.map((s) => s.name).join(", ");
        const techStack = (a.tech_stack as string[]) || [];
        return `- **${a.name}** (${a.slug}) — ${a.role}, ${a.department}. Skills: ${skillNames}. Tech: ${techStack.join(", ")}`;
      })
      .join("\n");
  } catch {
    return "Agent roster unavailable. Use default assignments.";
  }
}

async function findDirectorAgentId(): Promise<string> {
  try {
    const director = await db.query.agentPersonas.findFirst({
      where: isNull(agentPersonas.hidden_at),
      columns: { id: true },
    });

    return director?.id || "system";
  } catch {
    return "system";
  }
}

// ─── SCAN OUTPUT LOADER ─────────────────────────────────────────

/**
 * Load the Stage 1 SCAN output from artifacts.
 * Returns the composed SCAN document that was approved by the user.
 */
export async function loadScanOutput(pipelineRunId: string): Promise<string | null> {
  try {
    const artifact = await db.query.stageArtifacts.findFirst({
      where: and(
        eq(stageArtifacts.pipeline_run_id, pipelineRunId),
        eq(stageArtifacts.stage_name, PipelineStageName.SCAN),
        eq(stageArtifacts.artifact_type, "stage_output"),
      ),
      columns: {
        metadata: true,
      },
    });

    if (!artifact?.metadata) return null;

    const meta = artifact.metadata as Record<string, unknown>;
    return (meta.output as string) || (meta.content as string) || null;
  } catch {
    return null;
  }
}

// ─── DECODE COVERAGE HELPERS ──────────────────────────────────

/**
 * Extract component/module names from SCAN output for coverage measurement.
 * Looks for table rows in component inventory, file references, and module names.
 */
function extractScanComponents(scanOutput: string): string[] {
  const components = new Set<string>();

  // Extract from markdown table rows (component inventory)
  // Pattern: | name | path | type | ... |
  const tableRows = scanOutput.match(/^\|[^|]+\|[^|]+\|/gm) || [];
  for (const row of tableRows) {
    const cells = row.split('|').filter(Boolean).map(c => c.trim());
    if (cells.length >= 2 && !cells[0].includes('---') && cells[0].toLowerCase() !== 'name' && cells[0].toLowerCase() !== 'component') {
      components.add(cells[0]);
    }
  }

  // Extract file references (backtick-quoted paths)
  const fileRefs = scanOutput.match(/`([a-zA-Z0-9_/\\.-]+\.[a-zA-Z]+)`/g) || [];
  for (const ref of fileRefs) {
    const name = ref.replace(/`/g, '').split('/').pop()?.replace(/\.\w+$/, '') || '';
    if (name.length > 2) components.add(name);
  }

  // Extract module/class names from headings
  const moduleHeadings = scanOutput.match(/#{2,3}\s+(?:Module|Component|Service|Class):\s*(.+)/gi) || [];
  for (const h of moduleHeadings) {
    const name = h.replace(/^#{2,3}\s+(?:Module|Component|Service|Class):\s*/i, '').trim();
    if (name) components.add(name);
  }

  // Filter out generic noise
  const noise = new Set(['id', 'name', 'type', 'path', 'status', 'description', 'version', 'table', 'index', 'key']);
  return Array.from(components).filter(c => !noise.has(c.toLowerCase()) && c.length > 2);
}

/**
 * Measure what percentage of SCAN components are referenced in DECODE output.
 */
function measureDecodeCoverage(
  decodeOutput: string,
  scanComponents: string[],
): { percentage: number; covered: number; total: number; uncovered: string[] } {
  const outputLower = decodeOutput.toLowerCase();
  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const component of scanComponents) {
    const lower = component.toLowerCase();
    // Check for exact match, camelCase-to-words match, and snake_case match
    // Split on uppercase BEFORE lowercasing — otherwise .toLowerCase() removes all uppercase
    const camelWords = component.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    const snakeWords = lower.replace(/_/g, ' ');

    if (outputLower.includes(lower) || outputLower.includes(camelWords) || outputLower.includes(snakeWords)) {
      covered.push(component);
    } else {
      uncovered.push(component);
    }
  }

  return {
    percentage: scanComponents.length > 0 ? covered.length / scanComponents.length : 1,
    covered: covered.length,
    total: scanComponents.length,
    uncovered,
  };
}
