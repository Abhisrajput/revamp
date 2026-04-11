/**
 * Stage Runner — orchestrates the Generate → Validate → Refine loop.
 *
 * Ported from legacy-bridge runMultiAgentGeneration() with improvements:
 *   - Typed phases with event emitter pattern for UI updates
 *   - Contract-based auto-refinement (targeted, not full re-run)
 *   - Configurable max refinement passes per stage
 *   - Graceful degradation: LLM eval → deterministic-only → pass-through
 *   - Prompt caching support (cacheable prefix stays constant across refinements)
 *
 * Research basis:
 *   - Constitutional AI self-refinement pattern (Bai et al. 2022)
 *   - Reflexion: iterative refinement with verbal feedback (Shinn et al. 2023)
 *   - Anthropic extended thinking for complex reasoning stages
 *   - OpenAI structured outputs for evaluation response parsing
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';
import {
  assembleStagePrompt,
  ProjectContext,
  StageOutput,
  UserFeedback,
  AssembledPrompt,
} from './context-builders';
import {
  runValidation,
  LLMEvalFn,
  FullValidationResult,
} from './validation-runner';
import { getPromptTemplate, interpolateTemplate } from '../prompts/templates';
import { getStageContract } from '../validation/stage-contracts';
import {
  withRetry,
  classifyError,
  checkTokenBudget,
  isReasoningModel,
  type ClassifiedError,
} from './error-classifier';

// ─── TYPES ──────────────────────────────────────────────────────

export type StagePhase =
  | 'assembling'           // Building prompt from context
  | 'scanning_codebase'   // Analyzing codebase files
  | 'context_retrieval'   // Tiered context assembled (OpenViking)
  | 'agent_assigned'      // Agent matched and assigned to stage
  | 'generating'           // LLM is producing output
  | 'reviewing'            // Reviewer agent evaluating output
  | 'validating'           // Running validation checks
  | 'refining'             // LLM is fixing gaps
  | 'scout_assessment'    // Scout agent triaging codebase (multi-agent SCAN)
  | 'director_planning'   // Director planning subtask delegation (multi-agent SCAN)
  | 'subtask_executing'   // Specialist executing a subtask (multi-agent SCAN)
  | 'subtask_completed'   // Specialist subtask finished successfully
  | 'subtask_failed'      // Specialist subtask failed
  | 'composing'           // Composing subtask results into final output (multi-agent SCAN)
  | 'scout_failed'        // Scout triage failed (multi-agent SCAN)
  | 'bree_analysis'       // BREE Engine running static analysis
  | 'contract_refinement' // Auto-refining to meet stage contract
  | 'completed'            // Stage done successfully
  | 'failed';              // Stage failed

export interface StageEvent {
  phase: StagePhase;
  stageName: PipelineStageName;
  stageIndex: number;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type OnStageEvent = (event: StageEvent) => void;
export type OnDelta = (text: string) => void;

export interface LLMCallRequest {
  systemPrompt: string;
  userPrompt: string;
  onDelta?: OnDelta;
  signal?: AbortSignal;
  cacheablePrefix?: string; // for Anthropic prompt caching
  useExtendedThinking?: boolean; // for complex reasoning stages
}

export type LLMCallFn = (req: LLMCallRequest) => Promise<string>;

export interface StageRunnerOptions {
  // Required
  project: ProjectContext;
  stageName: PipelineStageName;
  stageIndex: number;
  pipelineRunId: string;
  templateVars: Record<string, string>;

  // LLM integration
  llmCallFn: LLMCallFn;
  llmEvalFn?: LLMEvalFn; // separate model for evaluation
  /** Separate LLM for reviewer agent. When provided, enables full multi-agent loop. */
  reviewerLlmCallFn?: LLMCallFn;

  // Prior context
  priorOutputs: StageOutput[];
  feedback: UserFeedback[];

  // Callbacks
  onEvent?: OnStageEvent;
  onDelta?: OnDelta;

  // Control
  signal?: AbortSignal;
  maxRefinements?: number; // override stage contract default
  skipValidation?: boolean;
  skipLlmEval?: boolean;
  /** Skip the reviewer agent step (still runs validation). */
  skipReview?: boolean;

  // Overrides
  promptOverride?: string; // project-specific prompt template (from DB)
  model?: string; // model name for token budget check
}

// ─── REVIEWER AGENT ─────────────────────────────────────────────

/**
 * Verdict from the reviewer agent. Determines whether the generated
 * output is acceptable or needs refinement.
 */
export interface ReviewerVerdict {
  approved: boolean;
  issues: string[];
  suggestions: string;
}

/**
 * Build a semi-formal reasoning prompt for the reviewer agent.
 *
 * Based on "Semi-Formal Reasoning" (2025): instead of letting the reviewer
 * reason freely, we force it to fill a structured certificate template with
 * explicit premises, per-requirement evidence traces, and a formal verdict.
 * This prevents rubber-stamping by requiring documented evidence before any
 * conclusion is reached.
 *
 * Ported from legacy-bridge stageAI.ts buildAgentReviewerPrompt(), enhanced
 * with semi-formal certificate structure.
 */
function buildReviewerPrompt(output: string, originalPrompt: string, stageName: string): string {
  return [
    `You are a review agent for "${stageName}" in a legacy code modernization pipeline.`,
    'You MUST follow the semi-formal reasoning protocol below. Do not skip any section.',
    '',
    '═══════════════════════════════════════════════════',
    '  SEMI-FORMAL REVIEW CERTIFICATE',
    '═══════════════════════════════════════════════════',
    '',
    '## SECTION 1: PREMISES',
    'List 3-7 concrete requirements that the original task demands.',
    'Extract these directly from the task prompt — do NOT invent requirements.',
    'Format: P1: <requirement>, P2: <requirement>, ...',
    '',
    '## SECTION 2: EVIDENCE AUDIT',
    'For EACH premise, trace through the generated output and document:',
    '- Whether the output addresses it (FOUND / MISSING / PARTIAL)',
    '- The specific section heading or content that addresses it (quote 1-2 lines)',
    '- If PARTIAL: what is missing or insufficient',
    '',
    'Format:',
    'P1: [FOUND] Section "## Architecture Overview" — "The system uses a 3-tier..."',
    'P2: [PARTIAL] Section "## Services" — lists 4 services but missing data store mapping',
    'P3: [MISSING] No section addresses error handling strategy',
    '',
    '## SECTION 3: QUALITY CHECKS',
    'Evaluate these structural quality signals:',
    '- SUBSTANCE: Is the output substantive (>500 words of technical content, not filler)?',
    '- ACCURACY: Are code references, file paths, and technology claims verifiable?',
    '- SPECIFICITY: Does it reference actual codebase elements (not generic advice)?',
    '- COMPLETENESS: Does it address all required sections per the stage contract?',
    '',
    '## SECTION 4: COUNTEREXAMPLE OR PROOF',
    'If rejecting: State the SPECIFIC counterexample — which requirement is unmet and why.',
    'If approving: Briefly confirm that all premises are satisfied with evidence.',
    '',
    '## SECTION 5: FORMAL VERDICT',
    'Based ONLY on the evidence documented above, return your verdict as STRICT JSON:',
    '{"approved":true|false,"issues":["issue referencing specific premise"],"suggestions":"concrete improvement steps"}',
    '',
    '═══════════════════════════════════════════════════',
    '',
    'RULES:',
    '- You MUST complete all 5 sections before rendering a verdict.',
    '- Approve if ≥80% of premises are FOUND and no critical requirement is MISSING.',
    '- Reject ONLY for clear omissions, factual errors, or stub/placeholder content.',
    '- Do NOT reject for style, formatting, or minor wording preferences.',
    '- Your final line MUST be the JSON verdict and nothing else.',
    '',
    '═══ ORIGINAL TASK ═══',
    originalPrompt.slice(0, 2000),
    '',
    '═══ GENERATED OUTPUT ═══',
    output.slice(0, 8000),
  ].join('\n');
}

/**
 * Build a semi-formal refinement prompt based on reviewer feedback.
 *
 * Uses structured issue-tracing to force the generator to explicitly address
 * each reviewer issue with documented changes, rather than vaguely "improving"
 * the output.
 *
 * Ported from legacy-bridge stageAI.ts buildAgentRefinementPrompt(), enhanced
 * with semi-formal tracing.
 */
function buildReviewerRefinementPrompt(
  originalPrompt: string,
  output: string,
  issues: string[],
  suggestions: string,
): string {
  return [
    '# Targeted Refinement Required',
    '',
    'A reviewer agent identified specific issues with your output.',
    'You MUST address each issue below with a documented fix.',
    '',
    '## REVIEWER ISSUES (must fix each one)',
    ...issues.map((issue, i) => `  I${i + 1}: ${issue}`),
    '',
    suggestions ? `## REVIEWER SUGGESTIONS\n${suggestions}` : '',
    '',
    '## REFINEMENT PROTOCOL',
    'For each issue above, you must:',
    '1. State which section of your output is affected',
    '2. Describe what you are changing and why',
    '3. Provide the corrected content',
    '',
    'Then output the complete corrected document incorporating all fixes.',
    '',
    '## ORIGINAL TASK',
    originalPrompt.slice(0, 2000),
    '',
    '## YOUR PREVIOUS OUTPUT (to improve)',
    output.slice(0, 6000),
    '',
    '## INSTRUCTIONS',
    'Generate the complete corrected output. Preserve all valid content.',
    'Address every I1, I2, ... issue. Do not leave any issue unresolved.',
  ].filter(Boolean).join('\n');
}

/**
 * Parse the reviewer's JSON verdict from raw LLM output.
 * Gracefully falls back to "approved" if parsing fails.
 */
function parseReviewerVerdict(raw: string): ReviewerVerdict {
  const fallback: ReviewerVerdict = { approved: true, issues: [], suggestions: '' };

  // Try to extract JSON from the response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ReviewerVerdict>;
    return {
      approved: typeof parsed.approved === 'boolean' ? parsed.approved : true,
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((i): i is string => typeof i === 'string').slice(0, 5)
        : [],
      suggestions: typeof parsed.suggestions === 'string' ? parsed.suggestions : '',
    };
  } catch {
    return fallback;
  }
}

export interface StageRunResult {
  stageName: PipelineStageName;
  stageIndex: number;
  output: string;
  validation: FullValidationResult | null;
  refinementCount: number;
  duration: number; // ms
  phases: StageEvent[];
  aborted: boolean;
}

// Stages that benefit from extended thinking (complex reasoning).
const EXTENDED_THINKING_STAGES = new Set([
  PipelineStageName.DECODE,
  PipelineStageName.BLUEPRINT,
  PipelineStageName.ARCHITECT,
]);

// ─── MAIN RUNNER ────────────────────────────────────────────────

/**
 * Execute a single pipeline stage with the full Generate → Validate → Refine loop.
 *
 * Flow:
 *   1. Assemble prompt (project context + prior stages + template + feedback)
 *   2. Generate output via LLM
 *   3. Validate output (deterministic + contract + LLM eval)
 *   4. If validation fails and refinement budget remains:
 *      a. Build targeted refinement prompt from contract violations
 *      b. Re-generate only the missing/incomplete parts
 *      c. Merge refined output with original
 *      d. Re-validate
 *   5. Return final output + validation result
 */
export async function runStage(options: StageRunnerOptions): Promise<StageRunResult> {
  const startTime = Date.now();
  const phases: StageEvent[] = [];
  let aborted = false;

  const emit = (phase: StagePhase, data?: Record<string, unknown>) => {
    const event: StageEvent = {
      phase,
      stageName: options.stageName,
      stageIndex: options.stageIndex,
      timestamp: new Date().toISOString(),
      data,
    };
    phases.push(event);
    options.onEvent?.(event);
  };

  // Check abort
  const checkAbort = () => {
    if (options.signal?.aborted) {
      aborted = true;
      throw new Error('Stage execution aborted');
    }
  };

  try {
    // ── PHASE 1: ASSEMBLE ────────────────────────────────────────
    emit('assembling');
    checkAbort();

    const template = getPromptTemplate(options.stageName);
    const templateString = options.promptOverride || template.template;
    const assembled = assembleStagePrompt(
      options.project,
      options.stageName,
      options.stageIndex,
      options.priorOutputs,
      templateString,
      options.templateVars,
      options.feedback,
    );

    // ── PRE-FLIGHT: TOKEN BUDGET CHECK ───────────────────────────
    const model = options.model || 'claude-sonnet-4-20250514';
    const budget = checkTokenBudget(assembled.systemPrompt, assembled.userPrompt, model);
    if (budget.shouldTruncate) {
      emit('assembling', {
        warning: 'token_budget_high',
        usageRatio: budget.usageRatio,
        estimatedTokens: budget.estimatedInputTokens,
        contextWindow: budget.contextWindow,
      });
      // Truncate the user prompt to fit within 80% of available budget
      const safeCharLimit = Math.floor((budget.contextWindow - 8192) * 0.8 * 4); // chars
      if (assembled.userPrompt.length > safeCharLimit) {
        assembled.userPrompt = assembled.userPrompt.slice(0, safeCharLimit) +
          '\n\n[... content truncated to fit model context window ...]';
        // Re-derive cacheablePrefix from truncated content to avoid stale cache.
        // The prefix is used for Anthropic prompt caching — if it doesn't match
        // what the LLM actually sees, the cache serves inconsistent context.
        if (assembled.cacheablePrefix.length > safeCharLimit) {
          assembled.cacheablePrefix = assembled.cacheablePrefix.slice(0, safeCharLimit);
        }
      }
    }

    // ── PHASE 2: GENERATE (with intelligent retry) ───────────────
    emit('generating');
    checkAbort();

    // OpenAI reasoning models (o1, o3) reject system prompts.
    // Convert to a user-prefixed message instead.
    let effectiveSystemPrompt = assembled.systemPrompt;
    let effectiveUserPrompt = assembled.userPrompt;
    if (isReasoningModel(model)) {
      effectiveUserPrompt = `[System Instructions]\n${assembled.systemPrompt}\n\n[Task]\n${assembled.userPrompt}`;
      effectiveSystemPrompt = '';
    }

    let output = await withRetry(
      () => options.llmCallFn({
        systemPrompt: effectiveSystemPrompt,
        userPrompt: effectiveUserPrompt,
        onDelta: options.onDelta,
        signal: options.signal,
        cacheablePrefix: assembled.cacheablePrefix,
        useExtendedThinking: EXTENDED_THINKING_STAGES.has(options.stageName),
      }),
      {
        maxAttempts: 3,
        onRetry: (attempt, classified) => {
          emit('generating', {
            retry: true,
            attempt,
            errorCategory: classified.category,
            delayMs: classified.suggestedDelayMs,
          });
          // On context_length error, aggressively truncate for retry
          if (classified.category === 'context_length') {
            const currentLen = assembled.userPrompt.length;
            assembled.userPrompt = assembled.userPrompt.slice(0, Math.floor(currentLen * 0.6)) +
              '\n\n[... content truncated due to context length error ...]';
          }
        },
      },
    );

    // ── PHASE 2.5: REVIEW (multi-agent reviewer step) ─────────────
    // If a reviewer LLM is available and review is not skipped, run the
    // reviewer agent to evaluate the generated output before validation.
    // This implements the Generate -> Review -> Refine -> Validate loop
    // from legacy-bridge runMultiAgentGeneration().
    if (options.reviewerLlmCallFn && !options.skipReview) {
      checkAbort();
      emit('reviewing');

      try {
        const reviewerPrompt = buildReviewerPrompt(
          output,
          assembled.userPrompt,
          options.stageName,
        );

        const reviewerRaw = await withRetry(
          () => options.reviewerLlmCallFn!({
            systemPrompt: [
              'You are a meticulous technical reviewer using semi-formal reasoning.',
              'You MUST complete all certificate sections before rendering a JSON verdict.',
              'Your final output line must be the JSON verdict object.',
            ].join(' '),
            userPrompt: reviewerPrompt,
            cacheablePrefix: undefined,
          }),
          { maxAttempts: 2, onRetry: () => {} },
        );

        const verdict = parseReviewerVerdict(reviewerRaw);

        if (!verdict.approved && verdict.issues.length > 0) {
          // Reviewer rejected — run targeted refinement
          emit('refining', {
            source: 'reviewer',
            issues: verdict.issues,
            suggestions: verdict.suggestions,
          });
          checkAbort();

          const refinementPrompt = buildReviewerRefinementPrompt(
            assembled.userPrompt,
            output,
            verdict.issues,
            verdict.suggestions,
          );

          // Clear streaming state before refinement
          options.onDelta?.('');

          output = await withRetry(
            () => options.llmCallFn({
              systemPrompt: assembled.systemPrompt,
              userPrompt: refinementPrompt,
              onDelta: options.onDelta,
              signal: options.signal,
              cacheablePrefix: assembled.cacheablePrefix,
            }),
            {
              maxAttempts: 2,
              onRetry: (attempt, classified) => {
                emit('refining', { retry: true, attempt, errorCategory: classified.category });
              },
            },
          );
        }
      } catch (reviewErr) {
        // Reviewer failed — log and continue with the original output.
        // The validation step will still catch quality issues.
        const reviewErrMsg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
        emit('reviewing', { error: reviewErrMsg, fallback: 'skipped' });
      }
    }

    // ── PHASE 3: VALIDATE ────────────────────────────────────────
    if (options.skipValidation) {
      emit('completed', { skippedValidation: true });
      return {
        stageName: options.stageName,
        stageIndex: options.stageIndex,
        output,
        validation: null,
        refinementCount: 0,
        duration: Date.now() - startTime,
        phases,
        aborted: false,
      };
    }

    emit('validating');
    checkAbort();

    let validation = await runValidation({
      pipelineRunId: options.pipelineRunId,
      stageName: options.stageName,
      stageOutput: output,
      stagePrompt: assembled.userPrompt || options.promptOverride || '',
      validationPrompt: (options.project as any)?.validationPrompts?.[String(options.stageIndex)] || '',
      priorStageKeywords: assembled.priorStageKeywords,
      priorStageOutputs: options.priorOutputs?.map(po => ({ stageName: po.stageName, output: po.output })),
      llmEvalFn: options.llmEvalFn,
      skipLlmEval: options.skipLlmEval,
    });

    // ── PHASE 4: REFINE (if needed) ──────────────────────────────
    const contract = getStageContract(options.stageName);
    const maxPasses = options.maxRefinements ?? contract?.maxRefinementPasses ?? 1;
    let refinementCount = 0;

    while (
      !validation.passed &&
      refinementCount < maxPasses &&
      validation.contractResult.refinementPrompt
    ) {
      checkAbort();
      emit('refining', { pass: refinementCount + 1, maxPasses });

      // Build targeted refinement prompt
      const refinementPrompt = buildRefinementRequest(
        assembled,
        output,
        validation.contractResult.refinementPrompt,
      );

      // Generate refinement (only missing parts) — with retry
      const refinedParts = await withRetry(
        () => options.llmCallFn({
          systemPrompt: assembled.systemPrompt,
          userPrompt: refinementPrompt,
          onDelta: options.onDelta,
          signal: options.signal,
          cacheablePrefix: assembled.cacheablePrefix,
        }),
        {
          maxAttempts: 2,
          onRetry: (attempt, classified) => {
            emit('refining', { retry: true, attempt, errorCategory: classified.category });
          },
        },
      );

      // Merge refined parts into original output
      output = mergeRefinement(output, refinedParts);
      refinementCount++;

      // Re-validate
      emit('validating', { afterRefinement: refinementCount });
      validation = await runValidation({
        pipelineRunId: options.pipelineRunId,
        stageName: options.stageName,
        stageOutput: output,
        stagePrompt: assembled.userPrompt || options.promptOverride || '',
        validationPrompt: (options.project as any)?.validationPrompts?.[String(options.stageIndex)] || '',
        priorStageKeywords: assembled.priorStageKeywords,
        priorStageOutputs: options.priorOutputs?.map(po => ({ stageName: po.stageName, output: po.output })),
        llmEvalFn: options.llmEvalFn,
        skipLlmEval: options.skipLlmEval,
      });
    }

    emit('completed', {
      passed: validation.passed,
      confidenceScore: validation.confidenceScore,
      refinementCount,
    });

    return {
      stageName: options.stageName,
      stageIndex: options.stageIndex,
      output,
      validation,
      refinementCount,
      duration: Date.now() - startTime,
      phases,
      aborted: false,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const classified = classifyError(err);

    if (aborted) {
      emit('failed', { reason: 'aborted' });
    } else {
      emit('failed', {
        reason: error.message,
        errorCategory: classified.category,
        shouldRetry: classified.shouldRetry,
      });
    }

    return {
      stageName: options.stageName,
      stageIndex: options.stageIndex,
      output: '',
      validation: null,
      refinementCount: 0,
      duration: Date.now() - startTime,
      phases,
      aborted,
    };
  }
}

// ─── REFINEMENT ─────────────────────────────────────────────────

/**
 * Build a refinement prompt that asks the LLM to fill specific gaps.
 * This is NOT a full re-run — it asks for only the missing/incomplete sections.
 *
 * Key insight from Reflexion (Shinn et al. 2023): providing the model with
 * its own output + specific criticism produces much better refinements than
 * just re-running the original prompt.
 */
function buildRefinementRequest(
  assembled: AssembledPrompt,
  originalOutput: string,
  refinementInstructions: string,
): string {
  return [
    '# Refinement Required',
    '',
    'Your previous output needs specific improvements. Below is your original output,',
    'followed by the specific gaps that need to be addressed.',
    '',
    '## Your Previous Output',
    '```',
    originalOutput.slice(0, 8000), // cap to avoid huge context
    originalOutput.length > 8000 ? '\n[... truncated ...]' : '',
    '```',
    '',
    '## Required Improvements',
    refinementInstructions,
    '',
    '## Instructions',
    'Output ONLY the missing or incomplete sections using the same heading structure.',
    'Do not repeat content that was already complete.',
    'Be thorough — this is your final opportunity to fix these gaps.',
  ].join('\n');
}

/**
 * Merge refined sections back into the original output.
 * If the refinement includes headings that exist in the original,
 * replace those sections. Otherwise, append new sections.
 */
function mergeRefinement(original: string, refined: string): string {
  const refinedSections = parseMarkdownSections(refined);

  if (refinedSections.length === 0) {
    // No structured sections — append as addendum
    return original + '\n\n' + refined;
  }

  const originalSections = parseMarkdownSections(original);
  if (originalSections.length === 0) {
    return original + '\n\n' + refined;
  }

  // Build lookup of refined sections by normalized heading
  const refinedMap = new Map(
    refinedSections.map((s) => [s.heading.trim().toLowerCase(), s.content]),
  );

  // Preserve preamble (text before first heading)
  const firstHeadingMatch = original.match(/^#{1,3}\s+/m);
  const preamble = firstHeadingMatch?.index && firstHeadingMatch.index > 0
    ? original.slice(0, firstHeadingMatch.index).trimEnd()
    : '';

  // Rebuild: keep original section order, replace content where refined
  const parts: string[] = [];
  if (preamble) parts.push(preamble);

  for (const section of originalSections) {
    const key = section.heading.trim().toLowerCase();
    const replacement = refinedMap.get(key);

    // Detect heading level from original text
    const hMatch = original.match(new RegExp(`^(#{1,3})\\s+${escapeRegex(section.heading)}`, 'm'));
    const prefix = hMatch ? hMatch[1] : '##';

    parts.push(`${prefix} ${section.heading}\n${replacement ?? section.content}`);
    refinedMap.delete(key);
  }

  // Append new sections from refinement not present in original
  for (const section of refinedSections) {
    if (refinedMap.has(section.heading.trim().toLowerCase())) {
      // Section still in refinedMap means it was NOT matched/consumed above — it's new
      parts.push(`## ${section.heading}\n${section.content}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Parse markdown into sections by heading.
 */
function parseMarkdownSections(md: string): Array<{ heading: string; content: string }> {
  const sections: Array<{ heading: string; content: string }> = [];
  const headingPattern = /^(#{1,3})\s+(.+)$/gm;
  let lastMatch: { heading: string; start: number } | null = null;
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(md)) !== null) {
    if (lastMatch) {
      sections.push({
        heading: lastMatch.heading,
        content: md.slice(lastMatch.start, match.index).trim(),
      });
    }
    lastMatch = {
      heading: match[2],
      start: match.index + match[0].length,
    };
  }

  // Last section
  if (lastMatch) {
    sections.push({
      heading: lastMatch.heading,
      content: md.slice(lastMatch.start).trim(),
    });
  }

  return sections;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
