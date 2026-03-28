/**
 * Validation types and schemas
 * Uses a hybrid deterministic + LLM confidence scoring model
 */

import { z } from 'zod';
import { PipelineStageName } from '@revamp/shared-types/pipeline';

/**
 * Deterministic checks — fast, repeatable, no LLM cost
 */
export enum CheckType {
  SECTION_COMPLETENESS = 'SECTION_COMPLETENESS',
  BDD_SCENARIO_COUNT = 'BDD_SCENARIO_COUNT',
  CROSS_STAGE_REFERENCES = 'CROSS_STAGE_REFERENCES',
  CODE_BLOCK_PRESENCE = 'CODE_BLOCK_PRESENCE',
  BUILD_READINESS = 'BUILD_READINESS',
  FILE_ARTIFACTS = 'FILE_ARTIFACTS',
  PARALLEL_RUN_COVERAGE = 'PARALLEL_RUN_COVERAGE',
  MERMAID_VALIDITY = 'MERMAID_VALIDITY',
  OUTPUT_SUBSTANCE = 'OUTPUT_SUBSTANCE',
  TEST_COVERAGE = 'TEST_COVERAGE',
}

/**
 * LLM-based evaluation dimensions
 */
export enum EvalDimension {
  ACCURACY = 'ACCURACY',
  COMPLETENESS = 'COMPLETENESS',
  ACTIONABILITY = 'ACTIONABILITY',
  TRACEABILITY = 'TRACEABILITY',
}

export interface DeterministicCheck {
  type: CheckType;
  weight: number; // 0-1
  args?: Record<string, unknown>;
}

export interface LLMEvaluation {
  dimension: EvalDimension;
  weight: number; // 0-1
  promptFragment?: string; // custom eval prompt
}

export interface StageValidationRule {
  stageIndex: number;
  stageName: PipelineStageName;
  deterministicChecks: DeterministicCheck[];
  llmEvaluations: LLMEvaluation[];
  confidenceThreshold: number; // 0-100, default 70
}

export interface CheckResult {
  name: string;
  type: CheckType;
  score: number; // 0-1
  weight: number;
  status: 'PASS' | 'FAIL' | 'WARN';
  message: string;
  details?: Record<string, unknown>;
}

export interface EvalResult {
  dimension: EvalDimension;
  score: number; // 0-1
  weight: number;
  reasoning: string;
  suggestions: string[];
}

export interface ValidationResult {
  pipelineRunId: string;
  stageName: PipelineStageName;
  timestamp: string;
  passed: boolean;
  confidenceScore: number; // 0-100 weighted average
  deterministicResults: CheckResult[];
  llmResults: EvalResult[];
  issues: ValidationIssue[];
  recommendations: string[];
  metadata?: Record<string, unknown>;
}

export interface ValidationIssue {
  id: string;
  code: string;
  severity: 'INFO' | 'WARN' | 'ERROR';
  title: string;
  description: string;
  location?: {
    file: string;
    line?: number;
    column?: number;
  };
  remediation?: string;
}

export const ValidationConfigSchema = z.object({
  stageName: z.nativeEnum(PipelineStageName),
  enabledChecks: z.array(z.nativeEnum(CheckType)).optional(),
  enabledEvals: z.array(z.nativeEnum(EvalDimension)).optional(),
  thresholds: z.object({
    confidenceThreshold: z.number().min(0).max(100).default(70),
    minDeterministicScore: z.number().min(0).max(1).optional(),
  }).optional(),
});

export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;
