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
import { llmProxyService, type ProjectCredentials } from "./llm-proxy.js";
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
import {
  checkPipelineBudget,
  PipelineBudgetExceededError,
  ProjectBudgetExceededError,
} from "./pipeline-budget.js";

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
    subtaskPlans = await runDirectorPlanning(opts);
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
    } catch {
      // Non-fatal — skip this subtask
    }
  }

  // Execute each subtask sequentially
  const subtaskResults: SubtaskResult[] = [];

  for (const { plan, subtask } of createdSubtasks) {
    checkAbort();

    const subtaskStart = Date.now();
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

      const result = await executeSubtask(opts, plan, subtask, subtaskResults);

      // Quick quality review on successful subtask output (non-blocking)
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

          opts.onEvent?.({
            phase: "subtask_executing",
            stageName: PipelineStageName.DECODE,
            stageIndex: 1,
            timestamp: new Date().toISOString(),
            data: {
              event: "subtask_reviewed",
              subtaskId: subtask.id,
              reviewScore: review.overallScore,
              reviewVerdict: review.overallVerdict,
              concerns: review.dimensions.flatMap((d) => d.concerns).slice(0, 3),
            },
          });
        } catch {
          // Review failure is non-fatal
        }
      }

      subtaskResults.push(result);

      opts.onEvent?.({
        phase: "subtask_executing",
        stageName: PipelineStageName.DECODE,
        stageIndex: 1,
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
        stageName: PipelineStageName.DECODE,
        stageIndex: 1,
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
      message: "All DECODE subtasks failed. Please re-run the stage.",
      errors: subtaskResults.map((r) => ({ type: r.type, error: r.error })),
    });

    const failedValidation: import("@revamp/core-engine").FullValidationResult = {
      pipelineRunId: opts.pipelineRunId,
      stageName: PipelineStageName.DECODE,
      timestamp: new Date().toISOString(),
      passed: false,
      confidenceScore: 0,
      deterministicResults: [],
      llmResults: [],
      issues: [{
        id: "decode-all-failed",
        code: "ALL_SUBTASKS_FAILED",
        severity: "ERROR" as const,
        title: "All DECODE subtasks failed",
        description: subtaskResults.map((r) => `${r.type}: ${r.error}`).join("; "),
      }],
      recommendations: ["Re-run the DECODE stage after checking LLM connectivity"],
      contractResult: { stageName: PipelineStageName.DECODE, passed: false, completenessScore: 0, violations: [], refinementPrompt: null, hardGated: false },
      metadata: {},
    };

    return {
      stageName: PipelineStageName.DECODE,
      stageIndex: 1,
      output: "",
      validation: failedValidation,
      refinementCount: 0,
      duration: Date.now() - startTime,
      phases,
      aborted: false,
    };
  }

  // ── STEP 3: COMPOSITION ───────────────────────────────────────
  emit("composing", { message: "Composing subtask results into final intent document..." });
  checkAbort();

  let composedOutput: string;
  try {
    composedOutput = await composeResults(opts, subtaskResults);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    emit("failed", {
      message: "DECODE composition failed. Please re-run the stage.",
      error: errMsg,
    });

    const compositionFailedValidation: import("@revamp/core-engine").FullValidationResult = {
      pipelineRunId: opts.pipelineRunId,
      stageName: PipelineStageName.DECODE,
      timestamp: new Date().toISOString(),
      passed: false,
      confidenceScore: 0,
      deterministicResults: [],
      llmResults: [],
      issues: [{
        id: "decode-composition-failed",
        code: "COMPOSITION_FAILED",
        severity: "ERROR" as const,
        title: "DECODE composition failed",
        description: errMsg,
      }],
      recommendations: ["Re-run the DECODE stage"],
      contractResult: { stageName: PipelineStageName.DECODE, passed: false, completenessScore: 0, violations: [], refinementPrompt: null, hardGated: false },
      metadata: {},
    };

    return {
      stageName: PipelineStageName.DECODE,
      stageIndex: 1,
      output: "",
      validation: compositionFailedValidation,
      refinementCount: 0,
      duration: Date.now() - startTime,
      phases,
      aborted: false,
    };
  }

  // ── STEP 4: COVERAGE GAP-FILL LOOP ─────────────────────────────
  // Extract components from SCAN output to measure DECODE coverage.
  // Every module/file/component from SCAN should map to at least one BR in DECODE.
  const COVERAGE_TARGET = 0.90;
  const MAX_GAP_FILL_ROUNDS = 3;

  const scanComponents = extractScanComponents(opts.scanOutput);
  let refinementCount = 0;

  if (scanComponents.length > 0) {
    for (let round = 0; round < MAX_GAP_FILL_ROUNDS; round++) {
      if (opts.signal?.aborted) break;

      const coverage = measureDecodeCoverage(composedOutput, scanComponents);
      emit("coverage_check" as StagePhase, {
        message: `DECODE coverage: ${Math.round(coverage.percentage * 100)}% (${coverage.covered}/${coverage.total} components)`,
        coverage: Math.round(coverage.percentage * 100),
        covered: coverage.covered,
        total: coverage.total,
        uncovered: coverage.uncovered.slice(0, 10),
        round: round + 1,
      });

      if (coverage.percentage >= COVERAGE_TARGET) {
        emit("coverage_check" as StagePhase, {
          message: `Coverage target met: ${Math.round(coverage.percentage * 100)}% ≥ ${Math.round(COVERAGE_TARGET * 100)}%`,
        });
        break;
      }

      // Gap-fill: ask LLM to extract business rules for uncovered components
      emit("gap_fill" as StagePhase, {
        message: `Gap-fill round ${round + 1}: extracting rules for ${coverage.uncovered.length} uncovered components...`,
        uncoveredCount: coverage.uncovered.length,
      });

      try {
        const gapPrompt = `The DECODE output is missing business rules for these components from SCAN:

${coverage.uncovered.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For EACH missing component, extract:
- Business Rule ID (BR-{number}, continue from existing highest)
- Rule description in business terms
- Source file location
- Data entities involved
- Complexity (Low/Medium/High)

Add a "## Workflows" section if missing.
Add a "## Technical Debt" section if missing.
Add a "## Open Questions" section if missing.

Output ONLY the new sections to append — do NOT repeat existing content.`;

        const gapOutput = await refineComposition(opts, composedOutput, gapPrompt);
        if (gapOutput && gapOutput.trim().length > 100) {
          composedOutput = composedOutput + "\n\n" + gapOutput;
          refinementCount++;
        }
      } catch {
        // Gap-fill failed — continue with current output
        break;
      }
    }
  }

  // ── STEP 5: CONTRACT VALIDATION ──────────────────────────────
  const contractResult = await enforceContract(PipelineStageName.DECODE, composedOutput);

  if (!contractResult.passed && contractResult.refinementPrompt) {
    emit("refining" as StagePhase, { message: "Refining composition to meet DECODE contract..." });
    try {
      const refinedOutput = await refineComposition(opts, composedOutput, contractResult.refinementPrompt);
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
    } catch {
      // Refinement failed — keep original composition
    }
  }

  // Build FullValidationResult — use agent-based section validation for accuracy
  // Pass LLM function for agent-based section validation (all stages)
  const validationAgentFn = llmProxyService.createCallFn({
    maxTokens: 2048,
    model: opts.model || "",
    credentials: opts.credentials,
  });
  let finalContractResult = await enforceContract(PipelineStageName.DECODE, composedOutput, undefined, validationAgentFn as any);

  // Upgrade section checks with LLM agent (replaces regex with semantic understanding)
  try {
    emit("validating" as StagePhase, { message: "Agent validating section completeness..." });
    const agentFn = llmProxyService.createCallFn({
      maxTokens: 2048,
      model: opts.model || "",
      credentials: opts.credentials,
    });
    // Dynamic import to avoid circular dependency — validateSectionsWithAgent is async
    const stageContractsMod = await import("@revamp/core-engine") as any;
    const agentValidateFn = stageContractsMod.validateSectionsWithAgent;
    if (!agentValidateFn) throw new Error("validateSectionsWithAgent not available");
    const agentResult = await agentValidateFn(
      PipelineStageName.DECODE,
      composedOutput,
      agentFn,
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
      const blendedScore = Math.round(agentScore * 0.6 + patternScore * 0.4);

      finalContractResult = {
        ...finalContractResult,
        violations: allViolations,
        completenessScore: blendedScore,
        passed: allViolations.filter(v => v.severity === 'critical').length === 0 && blendedScore >= 70,
        hardGated: finalContractResult.hardGated || !(allViolations.filter(v => v.severity === 'critical').length === 0 && blendedScore >= 70),
      };
    }
  } catch {
    // Agent validation failed — keep deterministic results
  }

  const validationResult: import("@revamp/core-engine").FullValidationResult = {
    pipelineRunId: opts.pipelineRunId,
    stageName: PipelineStageName.DECODE,
    timestamp: new Date().toISOString(),
    passed: finalContractResult.passed,
    confidenceScore: finalContractResult.completenessScore,
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
  };
}

// ─── DIRECTOR PLANNING ─────────────────────────────────────────

async function runDirectorPlanning(
  opts: DecodeOrchestrationOptions,
): Promise<SubtaskPlan[]> {
  const directorCallFn = llmProxyService.createCallFn({
    maxTokens: 4096,
    model: opts.model || "",
    credentials: opts.credentials,
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
  // IMPORTANT: Do NOT stream subtask deltas to the frontend — the user
  // should only see the composed final document.
  let subtaskOutput = "";
  const subtaskDelta = (text: string) => {
    if (text) subtaskOutput += text;
    // Intentionally NOT calling opts.onDelta — subtask output is internal.
  };

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
      onDelta: subtaskDelta,
      signal: opts.signal,
      skipValidation: true,
      promptOverride: filledPrompt,
      model: opts.model,
    });

    const effectiveOutput = result.output || subtaskOutput;

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

// ─── COMPOSITION ────────────────────────────────────────────────

async function composeResults(
  opts: DecodeOrchestrationOptions,
  results: SubtaskResult[],
): Promise<string> {
  const successfulResults = results.filter((r) => r.status === "completed" && r.output);

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

  const failedResults = results.filter((r) => r.status === "failed");
  const failedNote = failedResults.length > 0
    ? `\n\nNOTE: The following subtasks failed and are not included:\n${failedResults.map((r) => `- ${r.title}: ${r.error}`).join("\n")}\nAddress these gaps in the composition if possible.\n`
    : "";

  const prompt = DECODE_COMPOSITION.replace(
    "{{subtaskResults}}",
    subtaskResultsText + failedNote,
  );

  // Use maximum output tokens — this is the SOLE output the user sees
  const composerCallFn = llmProxyService.createCallFn({
    maxTokens: opts.maxTokens || 32768,
    model: opts.model || "",
    credentials: opts.credentials,
  });

  // Clear delta before composition — signals fresh start to frontend
  opts.onDelta?.("");

  return composerCallFn({
    systemPrompt: [
      "You are a lead architect composing a comprehensive DECODE / Intent Extraction document.",
      "CRITICAL: This document is the SOLE output the user will see from the entire DECODE analysis.",
      "You MUST preserve the full depth and detail from each specialist report.",
      "Every business rule must keep its Rule ID, source citation, and code snippet.",
      "Produce thorough, well-structured markdown with clear H2/H3 headings.",
      "Include ALL Mermaid diagrams, ALL tables, ALL file path references verbatim.",
      "The output should be AT LEAST 8000 words. Do NOT summarize — merge and organize.",
    ].join(" "),
    userPrompt: prompt,
    onDelta: opts.onDelta,
    signal: opts.signal,
  });
}

// ─── REFINEMENT ─────────────────────────────────────────────────

async function refineComposition(
  opts: DecodeOrchestrationOptions,
  output: string,
  refinementPrompt: string,
): Promise<string> {
  const callFn = llmProxyService.createCallFn({
    maxTokens: opts.maxTokens || 32768,
    model: opts.model || "",
    credentials: opts.credentials,
  });

  opts.onDelta?.("");

  const prompt = [
    "# Refinement Required",
    "",
    "Your previous DECODE output needs specific improvements.",
    "",
    "## Your Previous Output",
    output.slice(0, 16000),
    output.length > 16000 ? "\n[... truncated ...]" : "",
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
    const camelWords = lower.replace(/([A-Z])/g, ' $1').trim();
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
