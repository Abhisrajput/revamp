/**
 * Stage validation rules — hybrid deterministic + LLM confidence scoring
 *
 * Each stage defines:
 *   - Deterministic checks: fast, repeatable, no LLM cost (section counts, BDD patterns, code blocks, etc.)
 *   - LLM evaluations: accuracy, completeness, actionability, traceability scored by a validation LLM
 *   - Confidence threshold: weighted average must exceed this to auto-pass (default 70)
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';
import {
  StageValidationRule,
  CheckType,
  EvalDimension,
} from './types';

export const stageValidationRules: StageValidationRule[] = [
  // ── Stage 0: SCAN ──────────────────────────────────────────────
  {
    stageIndex: 0,
    stageName: PipelineStageName.SCAN,
    confidenceThreshold: 60,
    deterministicChecks: [
      { type: CheckType.SECTION_COMPLETENESS, weight: 0.15, args: { expectedSections: ['Architecture', 'Technology Stack', 'Risk', 'Data'] } },
      { type: CheckType.OUTPUT_SUBSTANCE, weight: 0.10, args: { minWords: 300 } },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACCURACY, weight: 0.30 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.25 },
      { dimension: EvalDimension.ACTIONABILITY, weight: 0.20 },
    ],
  },

  // ── Stage 1: DECODE ────────────────────────────────────────────
  {
    stageIndex: 1,
    stageName: PipelineStageName.DECODE,
    confidenceThreshold: 70,
    deterministicChecks: [
      { type: CheckType.SECTION_COMPLETENESS, weight: 0.15, args: { expectedSections: ['Business Rules', 'Workflows', 'Entities', 'Dependencies'] } },
      { type: CheckType.CROSS_STAGE_REFERENCES, weight: 0.10 },
      { type: CheckType.OUTPUT_SUBSTANCE, weight: 0.10, args: { minWords: 400 } },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACCURACY, weight: 0.30 },
      { dimension: EvalDimension.TRACEABILITY, weight: 0.15 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.20 },
    ],
  },

  // ── Stage 2: BLUEPRINT ─────────────────────────────────────────
  {
    stageIndex: 2,
    stageName: PipelineStageName.BLUEPRINT,
    confidenceThreshold: 70,
    deterministicChecks: [
      { type: CheckType.SECTION_COMPLETENESS, weight: 0.15, args: { expectedSections: ['Capabilities', 'Dependencies', 'Service Boundaries'] } },
      { type: CheckType.MERMAID_VALIDITY, weight: 0.10 },
      { type: CheckType.CROSS_STAGE_REFERENCES, weight: 0.10 },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACCURACY, weight: 0.25 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.20 },
      { dimension: EvalDimension.ACTIONABILITY, weight: 0.20 },
    ],
  },

  // ── Stage 3: SPEC_LOCK ─────────────────────────────────────────
  {
    stageIndex: 3,
    stageName: PipelineStageName.SPEC_LOCK,
    confidenceThreshold: 75,
    deterministicChecks: [
      { type: CheckType.BDD_SCENARIO_COUNT, weight: 0.20, args: { minScenarios: 5 } },
      { type: CheckType.CROSS_STAGE_REFERENCES, weight: 0.10 },
      { type: CheckType.OUTPUT_SUBSTANCE, weight: 0.05, args: { minWords: 500 } },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACCURACY, weight: 0.25 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.20 },
      { dimension: EvalDimension.TRACEABILITY, weight: 0.20 },
    ],
  },

  // ── Stage 4: ARCHITECT ─────────────────────────────────────────
  {
    stageIndex: 4,
    stageName: PipelineStageName.ARCHITECT,
    confidenceThreshold: 70,
    deterministicChecks: [
      { type: CheckType.SECTION_COMPLETENESS, weight: 0.15, args: { expectedSections: ['Strategy', 'Technology', 'Roadmap', 'Risks'] } },
      { type: CheckType.MERMAID_VALIDITY, weight: 0.10 },
      { type: CheckType.CROSS_STAGE_REFERENCES, weight: 0.10 },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACCURACY, weight: 0.20 },
      { dimension: EvalDimension.ACTIONABILITY, weight: 0.25 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.20 },
    ],
  },

  // ── Stage 5: FORGE ─────────────────────────────────────────────
  {
    stageIndex: 5,
    stageName: PipelineStageName.FORGE,
    confidenceThreshold: 75,
    deterministicChecks: [
      { type: CheckType.CODE_BLOCK_PRESENCE, weight: 0.12 },
      { type: CheckType.BUILD_READINESS, weight: 0.12 },
      { type: CheckType.FILE_ARTIFACTS, weight: 0.08 },
      { type: CheckType.TEST_COVERAGE, weight: 0.08 },
      { type: CheckType.CROSS_STAGE_REFERENCES, weight: 0.05 },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACCURACY, weight: 0.25 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.15 },
      { dimension: EvalDimension.TRACEABILITY, weight: 0.15 },
    ],
  },

  // ── Stage 6: SHADOW_RUN ────────────────────────────────────────
  {
    stageIndex: 6,
    stageName: PipelineStageName.SHADOW_RUN,
    confidenceThreshold: 80,
    deterministicChecks: [
      { type: CheckType.PARALLEL_RUN_COVERAGE, weight: 0.15 },
      { type: CheckType.TEST_COVERAGE, weight: 0.08 },
      { type: CheckType.CROSS_STAGE_REFERENCES, weight: 0.07 },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACCURACY, weight: 0.25 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.25 },
      { dimension: EvalDimension.ACTIONABILITY, weight: 0.20 },
    ],
  },

  // ── Stage 7: EVOLVE ────────────────────────────────────────────
  {
    stageIndex: 7,
    stageName: PipelineStageName.EVOLVE,
    confidenceThreshold: 65,
    deterministicChecks: [
      { type: CheckType.SECTION_COMPLETENESS, weight: 0.15, args: { expectedSections: ['KPIs', 'Roadmap', 'Operational Plan'] } },
      { type: CheckType.OUTPUT_SUBSTANCE, weight: 0.10, args: { minWords: 300 } },
    ],
    llmEvaluations: [
      { dimension: EvalDimension.ACTIONABILITY, weight: 0.35 },
      { dimension: EvalDimension.COMPLETENESS, weight: 0.20 },
      { dimension: EvalDimension.ACCURACY, weight: 0.20 },
    ],
  },
];

/**
 * Get validation rule for a specific stage
 */
export function getValidationRule(stageName: PipelineStageName): StageValidationRule | undefined {
  return stageValidationRules.find((r) => r.stageName === stageName);
}

/**
 * Get validation rule by stage index
 */
export function getValidationRuleByIndex(stageIndex: number): StageValidationRule | undefined {
  return stageValidationRules.find((r) => r.stageIndex === stageIndex);
}
