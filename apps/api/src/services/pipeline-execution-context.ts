/**
 * Pipeline Execution Context — assembles everything needed to run a stage.
 *
 * Builds: project context, file analysis, BREE data, ground truth,
 * agent matching, LLM call functions, BYOK credentials.
 *
 * This is the "common setup" extracted from the 570-line executeStage preamble.
 * Each stage handler receives this context and only adds its stage-specific logic.
 */

import { PipelineStageName } from "@revamp/shared-types/pipeline";
import type { ProjectContext, StageOutput, UserFeedback, LLMCallFn, OnStageEvent, OnDelta } from "@revamp/core-engine";
import type { AgentStageContext } from "./agent-pipeline.js";
import type { StageConfig, ProjectStageConfig } from "./pipeline-config.js";
import type { ProjectCredentials } from "./llm-proxy.js";

/**
 * Everything a stage handler needs to execute.
 * Built by prepareStageExecution() from the pipeline run + project data.
 */
export interface StageExecutionContext {
  // Pipeline run
  pipelineRunId: string;
  run: any; // TODO: type properly when pipeline-run type is extracted
  stageConfig: StageConfig;

  // Project context
  projectContext: ProjectContext & {
    stagePrompts?: Record<string, string>;
    validationPrompts?: Record<string, string>;
  };
  projectCredentials?: ProjectCredentials;

  // Prior stage data
  priorOutputs: StageOutput[];
  feedback: UserFeedback[];

  // Agent
  agentCtx: AgentStageContext | null;
  agentExec: Awaited<ReturnType<typeof import("./agent-execution.js").prepareAgentExecution>> | null;

  // LLM functions
  llmCallFn: LLMCallFn;
  llmEvalFn: any; // evaluation function
  reviewerLlmCallFn: LLMCallFn | undefined;

  // Model names
  modelName: string;
  composerModel: string;

  // Execution options (pass-through)
  onEvent?: OnStageEvent;
  onDelta?: OnDelta;
  signal?: AbortSignal;
  skipLlmEval?: boolean;
  maxTokens?: number;
  promptOverride?: string;
  validationFeedback?: Array<{ name: string; passed: boolean; score: number; feedback: string; severity?: string }>;

  // Template vars
  templateVars: Record<string, string>;
}
