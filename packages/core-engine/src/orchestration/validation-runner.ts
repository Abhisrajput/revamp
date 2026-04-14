/**
 * Validation Runner — prompt-derived validation with ground-truth anchoring.
 *
 * Replaces static rubrics with dynamic validation:
 *   1. Parse requirements from the stage prompt itself
 *   2. Check output against each extracted requirement
 *   3. Anchor claims against BREE static analysis (ground truth)
 *   4. Cross-reference with prior stage outputs (traceability)
 *   5. Use validation prompt as LLM-as-Judge (structured scoring)
 *   6. Compute composite confidence score
 *
 * No hardcoded rubrics. The prompt IS the contract.
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';
import { getStageContract, type ContractResult, type ContractViolation } from '../validation/stage-contracts';
import { scoreSectionCompleteness } from '../validation/deterministic-checks';
import {
  runPromptDerivedValidation,
  extractRequirementsFromPrompt,
  type PromptDerivedResult,
  type PromptDerivedValidationOptions,
  type BreeGroundTruth,
} from '../validation/prompt-derived';

// ─── RE-EXPORTED TYPES ─────────────────────────────────────────

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

  // Prompt-derived (new approach)
  stagePrompt?: string;          // execution prompt — source of truth
  validationPrompt?: string;     // validation guidance for LLM judge

  // Ground-truth anchoring
  breeGroundTruth?: BreeGroundTruth;

  // Prior-stage cross-reference
  priorStageOutputs?: Array<{ stageName: string; output: string }>;
  priorStageKeywords?: string[];
  priorStageText?: string;

  // LLM evaluation
  llmEvalFn?: LLMEvalFn;
  skipLlmEval?: boolean;
}

/**
 * Full validation result — compatible with existing consumers.
 */
export interface FullValidationResult {
  pipelineRunId: string;
  stageName: PipelineStageName;
  timestamp: string;
  passed: boolean;
  confidenceScore: number;

  // Mapped from prompt-derived checks → existing format
  deterministicResults: Array<{
    type: string;
    name: string;
    status: 'PASS' | 'WARN' | 'FAIL';
    score: number;
    message: string;
    weight: number;
  }>;

  llmResults: Array<{
    dimension: string;
    score: number;
    weight: number;
    reasoning: string;
    suggestions: string[];
  }>;

  issues: Array<{
    id: string;
    code: string;
    severity: 'ERROR' | 'WARN' | 'INFO';
    title: string;
    description: string;
  }>;

  recommendations: string[];

  // Contract-compatible (for scan-orchestrator)
  contractResult: {
    stageName: PipelineStageName;
    passed: boolean;
    completenessScore: number;
    violations: Array<{
      type: string;
      severity: 'critical' | 'major' | 'minor';
      description: string;
    }>;
    refinementPrompt: string | null;
    hardGated: boolean;
  };

  metadata: Record<string, unknown>;
}

// ─── PRIOR-STAGE CROSS-REFERENCE ────────────────────────────────

/**
 * Extract key terms from prior stage outputs and check if the current
 * output references them. Ensures traceability across stages.
 */
function crossReferencePriorStages(
  currentOutput: string,
  priorOutputs: Array<{ stageName: string; output: string }>,
): {
  score: number;
  references: Array<{ stageName: string; term: string; found: boolean }>;
} {
  if (priorOutputs.length === 0) return { score: 1, references: [] };

  const currentLower = currentOutput.toLowerCase();
  const references: Array<{ stageName: string; term: string; found: boolean }> = [];

  for (const prior of priorOutputs) {
    // Extract key terms from prior output: headings, capitalized terms, quoted terms
    const keyTerms = extractKeyTermsFromOutput(prior.output);

    // Check top 15 terms per prior stage
    for (const term of keyTerms.slice(0, 15)) {
      const found = currentLower.includes(term.toLowerCase());
      references.push({ stageName: prior.stageName, term, found });
    }
  }

  if (references.length === 0) return { score: 1, references: [] };
  const score = references.filter(r => r.found).length / references.length;
  return { score, references };
}

function extractKeyTermsFromOutput(output: string): string[] {
  const terms: string[] = [];

  // Extract markdown headings
  const headings = [...output.matchAll(/^#{1,4}\s+(.+)$/gm)];
  for (const h of headings) {
    terms.push(h[1].trim());
  }

  // Extract bold terms
  const bold = [...output.matchAll(/\*\*([^*]+)\*\*/g)];
  for (const b of bold) {
    if (b[1].length > 3 && b[1].length < 50) terms.push(b[1].trim());
  }

  // Extract backtick terms (file paths, code refs)
  const backtick = [...output.matchAll(/`([^`]+)`/g)];
  for (const bt of backtick) {
    if (bt[1].length > 3 && bt[1].length < 60) terms.push(bt[1].trim());
  }

  // Deduplicate
  return [...new Set(terms)];
}

// ─── MAIN RUNNER ────────────────────────────────────────────────

/**
 * Run prompt-derived validation with ground-truth anchoring and cross-referencing.
 *
 * Compatible with existing consumers that expect FullValidationResult.
 */
export async function runValidation(
  options: ValidationRunnerOptions,
): Promise<FullValidationResult> {
  const { pipelineRunId, stageName, stageOutput } = options;

  // If no stage prompt provided, we cannot run prompt-derived validation.
  // Return a low-confidence result that requires human approval rather than
  // silently passing with score 70.
  if (!options.stagePrompt) {
    console.warn(`[ValidationRunner] No stagePrompt for ${stageName} — validation degraded, requires approval`);
    return buildMinimalResult(pipelineRunId, stageName, stageOutput);
  }

  // Run prompt-derived validation
  const pdResult = await runPromptDerivedValidation({
    pipelineRunId,
    stageName,
    stageOutput,
    stagePrompt: options.stagePrompt,
    validationPrompt: options.validationPrompt,
    llmEvalFn: options.llmEvalFn,
    skipLlmEval: options.skipLlmEval,
    breeGroundTruth: options.breeGroundTruth,
  });

  // Run stage contract enforcement (structural requirements per stage)
  const contractResult = enforceStageContract(stageName, stageOutput);

  // Run prior-stage cross-reference
  const crossRef = crossReferencePriorStages(
    stageOutput,
    options.priorStageOutputs ?? [],
  );

  // Compose confidence score from three sources:
  //   70% prompt-derived (requirements + LLM judge + ground truth)
  //   15% contract completeness (structural section/artifact checks)
  //   15% cross-reference (prior stage continuity)
  let adjustedScore = pdResult.confidenceScore;
  const hasContractScore = contractResult.completenessScore !== undefined;
  const hasCrossRef = options.priorStageOutputs && options.priorStageOutputs.length > 0;

  if (hasContractScore || hasCrossRef) {
    const contractPct = hasContractScore ? contractResult.completenessScore : 50;
    const crossRefPct = hasCrossRef ? crossRef.score * 100 : 50;
    adjustedScore = Math.round(
      pdResult.confidenceScore * 0.70 +
      contractPct * 0.15 +
      crossRefPct * 0.15,
    );
  }

  // Add cross-reference issues
  const crossRefIssues = crossRef.references
    .filter(r => !r.found)
    .slice(0, 5) // limit noise
    .map((r, i) => ({
      id: `xref-${i}`,
      code: 'cross_stage_reference',
      severity: 'WARN' as const,
      title: `Missing reference to ${r.stageName}`,
      description: `Term "${r.term}" from ${r.stageName} not referenced in this output`,
    }));

  // Map prompt-derived requirement checks to deterministic results
  let deterministicResults = pdResult.requirementChecks.map(rc => ({
    type: 'requirement_check' as const,
    name: rc.requirement.label,
    status: rc.score >= 0.7 ? 'PASS' as const : rc.score >= 0.4 ? 'WARN' as const : 'FAIL' as const,
    score: rc.score,
    message: rc.found
      ? `${rc.requirement.label}: ${Math.round(rc.score * 100)}% coverage (${rc.contentLength} words, ${rc.keywordHits}/${rc.keywordTotal} keywords)`
      : `${rc.requirement.label}: NOT FOUND in output`,
    weight: 1 / Math.max(pdResult.requirementChecks.length, 1),
  }));

  // If prompt-derived extraction found zero requirements, degrade gracefully.
  // This forces human review instead of silently producing a low-quality score.
  if (deterministicResults.length === 0) {
    deterministicResults = [{
      type: 'requirement_check' as const,
      name: 'Prompt Extraction',
      status: 'WARN' as const,
      score: 0.5,
      message: 'Could not extract requirements from the stage prompt. Manual review required.',
      weight: 1,
    }];
    // Cap confidence to force human review
    adjustedScore = Math.min(adjustedScore, 50);
  }

  // Map LLM judge criteria → llm results
  const llmResults = pdResult.llmJudgeCriteria.map(c => ({
    dimension: c.name,
    score: c.score,
    weight: 1 / Math.max(pdResult.llmJudgeCriteria.length, 1),
    reasoning: c.feedback,
    suggestions: [],
  }));

  // When LLM eval is skipped and we have rubric-based deterministic results,
  // use the deterministic aggregate as the confidence score (don't penalize
  // for missing LLM dimensions that couldn't run).
  if (llmResults.length === 0 && deterministicResults.length > 0) {
    const detTotalWeight = deterministicResults.reduce((s, r) => s + (r.weight || 1), 0);
    const detAggregate = detTotalWeight > 0
      ? deterministicResults.reduce((s, r) => s + (r.score || 0) * (r.weight || 1), 0) / detTotalWeight
      : 0;
    const detScore = Math.round(detAggregate * 100);
    if (detScore > adjustedScore) {
      adjustedScore = detScore;
    }
  }

  // Cap score to 0-100 range
  adjustedScore = Math.max(0, Math.min(100, adjustedScore));

  // Map prompt-derived result → FullValidationResult format
  return {
    pipelineRunId,
    stageName,
    timestamp: pdResult.timestamp,
    passed: pdResult.passed && adjustedScore >= 55,
    confidenceScore: adjustedScore,

    deterministicResults,
    llmResults,

    // Combine all issues
    issues: [
      ...pdResult.issues.map((iss, i) => ({
        id: `pd-${i}`,
        code: iss.severity === 'error' ? 'missing_requirement' : 'weak_coverage',
        severity: iss.severity === 'error' ? 'ERROR' as const : iss.severity === 'warn' ? 'WARN' as const : 'INFO' as const,
        title: iss.message.split(':')[0] || iss.message,
        description: iss.message,
      })),
      ...crossRefIssues,
      // Contract violations — structural requirements not met
      ...(contractResult.violations || []).map((v: any, i: number) => ({
        id: `contract-${i}`,
        code: `contract_${v.type}`,
        severity: v.severity === 'critical' ? 'ERROR' as const : 'WARN' as const,
        title: `Contract: ${v.section || v.artifact || v.type}`,
        description: v.message || `${v.type}: ${v.section || v.artifact || 'unknown'}`,
      })),
      // Ground-truth mismatches
      ...pdResult.groundTruthAnchors
        .filter(a => !a.match)
        .map((a, i) => ({
          id: `gt-${i}`,
          code: 'ground_truth_mismatch',
          severity: 'WARN' as const,
          title: `Ground-truth: ${a.type}`,
          description: `Expected ${a.expected}, found ${a.actual ?? 'not mentioned'}`,
        })),
    ],

    recommendations: pdResult.recommendations,

    // Stage contract enforcement — checks structural requirements per stage
    contractResult: {
      ...contractResult,
      // Merge prompt-derived refinement prompt if contract doesn't generate one
      refinementPrompt: contractResult.refinementPrompt || pdResult.refinementPrompt,
    },

    metadata: {
      approach: 'prompt-derived',
      requirementsExtracted: pdResult.requirementsExtracted,
      groundTruthAnchors: pdResult.groundTruthAnchors.length,
      groundTruthScore: Math.round(pdResult.groundTruthScore * 100),
      crossRefScore: Math.round(crossRef.score * 100),
      crossRefTermsChecked: crossRef.references.length,
      llmJudgeUsed: pdResult.llmJudgeScore !== null,
      llmJudgeScore: pdResult.llmJudgeScore !== null ? Math.round(pdResult.llmJudgeScore * 100) : null,
    },
  };
}

// ─── CONTRACT ENFORCEMENT ───────────────────────────────────────

/**
 * Enforce stage contract — checks that required sections exist, meet
 * minimum word counts, and contain required patterns. Returns a
 * ContractResult with violations and hard-gate status.
 */
function enforceStageContract(stageName: PipelineStageName, output: string): ContractResult {
  const contract = getStageContract(stageName);
  if (!contract) {
    return {
      stageName,
      passed: true,
      completenessScore: 100,
      violations: [],
      refinementPrompt: null,
      hardGated: false,
    };
  }

  const violations: ContractViolation[] = [];

  // Check required sections
  if (contract.requiredSections.length > 0) {
    const sectionCheck = scoreSectionCompleteness(output, {
      requiredHeadings: contract.requiredSections.map(s => s.heading),
      minWordsPerSection: contract.requiredSections[0]?.minWordCount ?? 40,
    });
    if (sectionCheck.details?.missing) {
      for (const heading of sectionCheck.details.missing as string[]) {
        const req = contract.requiredSections.find(s => s.heading === heading);
        violations.push({
          type: 'missing_section',
          severity: req?.required ? 'critical' : 'minor',
          description: `Missing required section: "${heading}"`,
          section: heading,
        });
      }
    }
    if (sectionCheck.details?.thin) {
      for (const desc of sectionCheck.details.thin as string[]) {
        violations.push({
          type: 'thin_section',
          severity: 'major',
          description: `Section too thin: ${desc}`,
        });
      }
    }
  }

  // Check required patterns
  if (contract.requiredPatterns) {
    for (const pat of contract.requiredPatterns) {
      const matches = output.match(pat.pattern);
      const count = matches?.length ?? 0;
      if (count < pat.minOccurrences) {
        violations.push({
          type: 'missing_pattern',
          severity: 'major',
          description: `Pattern "${pat.description}" found ${count} time(s), need ${pat.minOccurrences}+`,
          actual: count,
          expected: pat.minOccurrences,
        });
      }
    }
  }

  // Check minimum total word count
  if (contract.minTotalWords) {
    const wordCount = output.split(/\s+/).filter(Boolean).length;
    if (wordCount < contract.minTotalWords) {
      violations.push({
        type: 'too_short',
        severity: 'critical',
        description: `Output is ${wordCount} words, minimum is ${contract.minTotalWords}`,
        actual: wordCount,
        expected: contract.minTotalWords,
      });
    }
  }

  const criticalViolations = violations.filter(v => v.severity === 'critical').length;
  const passed = criticalViolations === 0;
  const completenessScore = violations.length === 0
    ? 100
    : Math.max(0, 100 - violations.reduce((sum, v) =>
        sum + (v.severity === 'critical' ? 25 : v.severity === 'major' ? 10 : 3), 0));

  // Generate refinement prompt from violations
  let refinementPrompt: string | null = null;
  if (violations.length > 0) {
    refinementPrompt = `The following contract violations were found:\n` +
      violations.map((v, i) => `${i + 1}. [${v.severity.toUpperCase()}] ${v.description}`).join('\n') +
      `\n\nPlease address these violations in your next revision.`;
  }

  return {
    stageName,
    passed,
    completenessScore,
    violations,
    refinementPrompt,
    hardGated: contract.hardGate === true && !passed,
  };
}

// ─── HELPERS ────────────────────────────────────────────────────

function buildMinimalResult(
  pipelineRunId: string,
  stageName: PipelineStageName,
  output: string,
): FullValidationResult {
  const wordCount = output.split(/\s+/).filter(w => w.length > 0).length;
  const hasSubstance = wordCount > 100;

  // Without a stage prompt, we can't validate structural requirements.
  // Cap at 45 (below typical pass threshold of 50-60) so the stage
  // requires human approval rather than silently advancing.
  return {
    pipelineRunId,
    stageName,
    timestamp: new Date().toISOString(),
    passed: false,
    confidenceScore: hasSubstance ? 45 : 20,
    deterministicResults: [{
      type: 'output_substance',
      name: 'Output Substance',
      status: hasSubstance ? 'PASS' : 'FAIL',
      score: Math.min(1, wordCount / 200),
      message: `${wordCount} words (no stagePrompt — structural validation skipped)`,
      weight: 1,
    }],
    llmResults: [],
    issues: [{
      id: 'min-0',
      code: 'no_stage_prompt',
      severity: 'WARN' as const,
      title: 'Validation degraded — no stage prompt',
      description: 'Stage prompt unavailable — prompt-derived validation was skipped. Human approval required.',
    }, ...(hasSubstance ? [] : [{
      id: 'min-1',
      code: 'insufficient_output',
      severity: 'ERROR' as any,
      title: 'Output too short',
      description: `Only ${wordCount} words — expected at least 100`,
    }])],
    recommendations: [],
    contractResult: {
      stageName,
      passed: hasSubstance,
      completenessScore: hasSubstance ? 70 : 30,
      violations: [],
      refinementPrompt: null,
      hardGated: false,
    },
    metadata: { approach: 'minimal', wordCount },
  };
}

// Re-export for backward compatibility
export { extractRequirementsFromPrompt, type BreeGroundTruth } from '../validation/prompt-derived';
