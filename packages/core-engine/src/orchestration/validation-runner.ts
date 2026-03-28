/**
 * Validation Runner — orchestrates deterministic checks + LLM evaluations.
 *
 * Flow:
 *   1. Run deterministic checks (fast, free)
 *   2. Run stage contract enforcement (structural completeness)
 *   3. Run LLM evaluation (accuracy, actionability, traceability)
 *   4. Compute composite confidence score
 *   5. Return ValidationResult with pass/fail + refinement prompt if needed
 *
 * Research basis:
 *   - "LLM-as-Judge" pattern (Zheng et al. 2023, "Judging LLM-as-a-Judge")
 *     Uses a secondary LLM to evaluate output quality on structured dimensions.
 *   - Anthropic's evaluation best practices: separate evaluator from generator
 *     to avoid self-validation bias.
 *   - OpenAI structured outputs: force JSON schema compliance in eval responses.
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';
import {
  CheckType,
  EvalDimension,
  CheckResult,
  EvalResult,
  ValidationResult,
  StageValidationRule,
} from '../validation/types';
import { runAllDeterministicChecks } from '../validation/deterministic-checks';
import { enforceContract, ContractResult } from '../validation/stage-contracts';
import { stageValidationRules } from '../validation/rubrics';
import { extractKeyTerms } from '../validation/utils';

// ─── TYPES ──────────────────────────────────────────────────────

export interface LLMEvalRequest {
  systemPrompt: string;
  userPrompt: string;
  responseFormat?: 'json' | 'text';
}

export type LLMEvalFn = (req: LLMEvalRequest) => Promise<string>;

export interface ValidationRunnerOptions {
  pipelineRunId: string;
  stageName: PipelineStageName;
  stageOutput: string;
  priorStageKeywords?: string[];
  priorStageText?: string; // raw text from prior stages — auto-extracts keywords if priorStageKeywords empty
  llmEvalFn?: LLMEvalFn; // optional — degrades to deterministic-only if absent
  skipLlmEval?: boolean;
}

export interface FullValidationResult extends ValidationResult {
  contractResult: ContractResult;
}

// ─── MAIN RUNNER ────────────────────────────────────────────────

/**
 * Run complete validation pipeline for a stage output.
 *
 * 1. Deterministic checks (per stageValidationRules)
 * 2. Contract enforcement (per stageContracts)
 * 3. LLM evaluation (if llmEvalFn provided)
 * 4. Composite scoring
 */
export async function runValidation(
  options: ValidationRunnerOptions,
): Promise<FullValidationResult> {
  const { pipelineRunId, stageName, stageOutput } = options;

  // Auto-extract keywords from prior stage text if none provided explicitly
  const priorStageKeywords = options.priorStageKeywords?.length
    ? options.priorStageKeywords
    : options.priorStageText
      ? extractKeyTerms(options.priorStageText, 30)
      : [];

  // 1. Find validation rule for this stage
  const rule = stageValidationRules.find((r) => r.stageName === stageName);
  if (!rule) {
    return buildPassResult(pipelineRunId, stageName);
  }

  // 2. Run deterministic checks
  const checksWithArgs = rule.deterministicChecks.map((check) => ({
    type: check.type,
    weight: check.weight,
    args: enrichCheckArgs(check.type, check.args, priorStageKeywords, stageName),
  }));

  const { results: deterministicResults, aggregateScore: detScore } =
    runAllDeterministicChecks(stageOutput, checksWithArgs);

  // 3. Run contract enforcement
  const contractResult = enforceContract(stageName, stageOutput);

  // 4. Run LLM evaluation (if available)
  let llmResults: EvalResult[] = [];
  let llmScore = 0;

  if (options.llmEvalFn && !options.skipLlmEval && rule.llmEvaluations.length > 0) {
    try {
      llmResults = await runLlmEvaluations(
        options.llmEvalFn,
        stageName,
        stageOutput,
        rule.llmEvaluations,
      );
      const totalLlmWeight = llmResults.reduce((s, r) => s + r.weight, 0);
      llmScore = totalLlmWeight > 0
        ? llmResults.reduce((s, r) => s + r.score * r.weight, 0) / totalLlmWeight
        : 0;
    } catch {
      // LLM eval failed — degrade to deterministic-only
      llmResults = [];
      llmScore = 0;
    }
  }

  // 5. Compute composite confidence score
  // Weights: deterministic 40%, contract 30%, LLM 30% (if available)
  const hasLlm = llmResults.length > 0;
  const contractScore = contractResult.completenessScore / 100;

  let confidenceScore: number;
  if (hasLlm) {
    confidenceScore = Math.round(
      (detScore * 0.35 + contractScore * 0.30 + llmScore * 0.35) * 100,
    );
  } else {
    // No LLM eval — redistribute weight
    confidenceScore = Math.round(
      (detScore * 0.50 + contractScore * 0.50) * 100,
    );
  }

  // 6. Determine pass/fail
  const passed = confidenceScore >= rule.confidenceThreshold
    && contractResult.violations.filter((v) => v.severity === 'critical').length === 0;

  // 7. Build issues list
  const issues = [
    ...deterministicResults
      .filter((r) => r.status !== 'PASS')
      .map((r, i) => ({
        id: `det-${i}`,
        code: r.type,
        severity: r.status === 'FAIL' ? 'ERROR' as const : 'WARN' as const,
        title: r.name,
        description: r.message,
      })),
    ...contractResult.violations.map((v, i) => ({
      id: `contract-${i}`,
      code: v.type,
      severity: v.severity === 'critical' ? 'ERROR' as const : v.severity === 'major' ? 'WARN' as const : 'INFO' as const,
      title: v.type.replace(/_/g, ' '),
      description: v.description,
    })),
  ];

  // 8. Build recommendations
  const recommendations: string[] = [];
  if (!passed && contractResult.refinementPrompt) {
    recommendations.push('Auto-refinement available — contract violations can be addressed with targeted prompt');
  }
  for (const llmResult of llmResults) {
    recommendations.push(...llmResult.suggestions);
  }

  return {
    pipelineRunId,
    stageName,
    timestamp: new Date().toISOString(),
    passed,
    confidenceScore,
    deterministicResults,
    llmResults,
    issues,
    recommendations,
    contractResult,
    metadata: {
      detScore: Math.round(detScore * 100),
      contractScore: Math.round(contractScore * 100),
      llmScore: hasLlm ? Math.round(llmScore * 100) : null,
      hasLlmEval: hasLlm,
      threshold: rule.confidenceThreshold,
    },
  };
}

// ─── LLM EVALUATION ─────────────────────────────────────────────

/**
 * Run LLM-based evaluations across all configured dimensions.
 *
 * Uses the "LLM-as-Judge" pattern with structured JSON output:
 * - Each dimension gets a dedicated eval prompt
 * - The evaluator LLM returns { score: 0-1, reasoning: string, suggestions: string[] }
 * - Uses a different model from the generator to avoid self-validation bias
 */
async function runLlmEvaluations(
  evalFn: LLMEvalFn,
  stageName: PipelineStageName,
  output: string,
  evals: Array<{ dimension: EvalDimension; weight: number; promptFragment?: string }>,
): Promise<EvalResult[]> {
  // Run all dimensions in parallel
  const results = await Promise.allSettled(
    evals.map((ev) => runSingleEval(evalFn, stageName, output, ev)),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<EvalResult> => r.status === 'fulfilled')
    .map((r) => r.value);
}

async function runSingleEval(
  evalFn: LLMEvalFn,
  stageName: PipelineStageName,
  output: string,
  ev: { dimension: EvalDimension; weight: number; promptFragment?: string },
): Promise<EvalResult> {
  const systemPrompt = buildEvalSystemPrompt(ev.dimension);
  const userPrompt = buildEvalUserPrompt(stageName, output, ev.dimension, ev.promptFragment);

  const response = await evalFn({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
  });

  // Parse structured response
  const parsed = parseEvalResponse(response);

  return {
    dimension: ev.dimension,
    score: parsed.score,
    weight: ev.weight,
    reasoning: parsed.reasoning,
    suggestions: parsed.suggestions,
  };
}

/**
 * Build a semi-formal evaluation system prompt for a specific dimension.
 *
 * Based on "Semi-Formal Reasoning" (2025): forces the evaluator to trace
 * evidence for each claim before scoring. Prevents superficial "looks good, 0.8"
 * evaluations by requiring per-claim verification with cited evidence.
 */
function buildEvalSystemPrompt(dimension: EvalDimension): string {
  const dimensionCriteria: Record<EvalDimension, { description: string; checkpoints: string[] }> = {
    [EvalDimension.ACCURACY]: {
      description: 'Evaluate factual correctness, technical soundness, and absence of hallucinated information.',
      checkpoints: [
        'Code references: Do file paths, function names, and class names match real codebase elements?',
        'Technology claims: Are framework versions, API signatures, and library capabilities correct?',
        'Architecture decisions: Are the proposed patterns appropriate for the stated constraints?',
        'Data flows: Do described data flows match the actual code structure?',
      ],
    },
    [EvalDimension.COMPLETENESS]: {
      description: 'Evaluate whether all task aspects are addressed without gaps or shallow analysis.',
      checkpoints: [
        'Section coverage: Are all required sections present per stage contract?',
        'Depth: Does each section contain substantive analysis (not placeholder/filler)?',
        'Edge cases: Are error paths, failure modes, and boundary conditions addressed?',
        'Requirements: Is every requirement from the task prompt addressed somewhere?',
      ],
    },
    [EvalDimension.ACTIONABILITY]: {
      description: 'Evaluate whether a development team could implement from this output without significant clarification.',
      checkpoints: [
        'Specificity: Are recommendations concrete (not "consider using X" but "use X because Y")?',
        'Steps: Are implementation steps ordered and dependency-aware?',
        'Code examples: Are code snippets syntactically valid and contextually appropriate?',
        'Decisions: Are technology choices justified with trade-off analysis?',
      ],
    },
    [EvalDimension.TRACEABILITY]: {
      description: 'Evaluate whether the output maintains clear links to source material and prior stages.',
      checkpoints: [
        'Source links: Do business rules reference specific source code locations?',
        'Prior stages: Does the output reference and build on prior stage outputs?',
        'Decision trails: Can each architectural decision be traced to a stated requirement?',
        'Coverage mapping: Can each requirement be traced to a proposed component?',
      ],
    },
  };

  const criteria = dimensionCriteria[dimension];

  return [
    'You are an expert technical reviewer using semi-formal evaluation.',
    `Evaluation dimension: **${dimension}**`,
    '',
    criteria.description,
    '',
    '═══ SEMI-FORMAL EVALUATION PROTOCOL ═══',
    '',
    'You MUST complete these sections IN ORDER before scoring:',
    '',
    '## STEP 1: CHECKPOINTS',
    'Evaluate each checkpoint below. For each, cite specific evidence from the output.',
    ...criteria.checkpoints.map((cp, i) => `  C${i + 1}. ${cp}`),
    '',
    'For each checkpoint, write:',
    '  C1: [PASS|PARTIAL|FAIL] — "<quoted evidence or explanation of gap>"',
    '',
    '## STEP 2: EVIDENCE SUMMARY',
    'Count: X/4 checkpoints passed, Y/4 partial, Z/4 failed.',
    'List the most critical gap (if any).',
    '',
    '## STEP 3: SCORE AND VERDICT',
    'Based ONLY on the checkpoint evidence above, assign a score.',
    'Scoring guide: 4/4 PASS → 0.85-1.0, 3/4 PASS → 0.7-0.85, 2/4 → 0.5-0.7, ≤1/4 → 0.0-0.5',
    '',
    'Return your final verdict as valid JSON on the LAST line:',
    '{"score": <0.0-1.0>, "reasoning": "<2-3 sentences referencing checkpoints>", "suggestions": ["<specific improvement>"]}',
    '',
    'A score of 0.7+ means production-ready quality. Be rigorous.',
  ].join('\n');
}

function buildEvalUserPrompt(
  stageName: PipelineStageName,
  output: string,
  dimension: EvalDimension,
  customFragment?: string,
): string {
  const parts = [
    `## Stage: ${stageName}`,
    `## Evaluation Dimension: ${dimension}`,
    '',
    'Complete the semi-formal evaluation protocol from the system prompt.',
    'You MUST fill in all checkpoint assessments with cited evidence before scoring.',
    '',
  ];

  if (customFragment) {
    parts.push(`## Additional Context`, customFragment, '');
  }

  // Provide section headings as anchor points for the evaluator to trace evidence
  const headings = output.match(/^#{1,3}\s+.+$/gm);
  if (headings && headings.length > 0) {
    parts.push(
      '## Output Section Map (for evidence tracing)',
      ...headings.map((h, i) => `  ${i + 1}. ${h.trim()}`),
      '',
    );
  }

  parts.push('## Full Output to Evaluate:', '', output);

  return parts.join('\n');
}

function parseEvalResponse(response: string): {
  score: number;
  reasoning: string;
  suggestions: string[];
} {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: Math.max(0, Math.min(1, Number(parsed.score) || 0)),
        reasoning: String(parsed.reasoning || ''),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
      };
    }
  } catch {
    // Parse failed — return low score
  }

  return {
    score: 0.3,
    reasoning: 'Failed to parse evaluation response',
    suggestions: ['Re-run evaluation with structured output format'],
  };
}

// ─── HELPERS ────────────────────────────────────────────────────

/**
 * Enrich check args with stage-specific context.
 * For example, CROSS_STAGE_REFERENCES needs priorStageKeywords,
 * SECTION_COMPLETENESS needs the required headings from the stage contract.
 */
function enrichCheckArgs(
  type: CheckType,
  args: Record<string, unknown> | undefined,
  priorStageKeywords: string[],
  _stageName: PipelineStageName,
): Record<string, unknown> {
  const base = args ?? {};

  switch (type) {
    case CheckType.CROSS_STAGE_REFERENCES:
      return { ...base, priorStageKeywords };
    default:
      return base;
  }
}

function buildPassResult(pipelineRunId: string, stageName: PipelineStageName): FullValidationResult {
  return {
    pipelineRunId,
    stageName,
    timestamp: new Date().toISOString(),
    passed: true,
    confidenceScore: 100,
    deterministicResults: [],
    llmResults: [],
    issues: [],
    recommendations: [],
    contractResult: {
      stageName,
      passed: true,
      completenessScore: 100,
      violations: [],
      refinementPrompt: null,
      hardGated: false,
    },
  };
}
