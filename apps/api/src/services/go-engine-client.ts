/**
 * Go Engine Client — bridges Fastify API → Go LLM Orchestrator v2 API.
 *
 * Instead of running orchestrators locally (scan-orchestrator, forge-orchestrator),
 * the API delegates to the Go engine which handles:
 *   - Stage execution (generate → validate → refine)
 *   - Agentic tool loops (tool_use with Bedrock Converse API)
 *   - Budget enforcement
 *   - Context management (L0/L1/L2 tiering)
 *
 * The Go engine streams results back via SSE which this client
 * parses and forwards to the frontend.
 */

import axios, { AxiosInstance } from "axios";
import type { PipelineStageName } from "@revamp/shared-types/pipeline";

// ─── TYPES ──────────────────────────────────────────────────────

export interface StageExecutionRequest {
  pipeline_run_id: string;
  project_id: string;
  stage_name: string;
  stage_index: number;
  model: string;
  evaluator_model?: string;
  max_tokens?: number;
  stage_prompt: string;
  validation_prompt?: string;
  prior_outputs: Array<{ stage_name: string; output: string }>;
  workspace_path?: string;
  target_stack: string;
  target_cloud: string;
  budget_cents?: number;
  skip_validation?: boolean;
  stream: boolean;
}

export interface StageExecutionResult {
  stage_name: string;
  stage_index: number;
  output: string;
  validation?: {
    passed: boolean;
    confidence_score: number;
    issues?: Array<{ severity: string; description: string }>;
  };
  duration_ms: number;
  tokens_used: number;
  cost_cents: number;
  files_generated?: number;
}

export interface ToolExecutionRequest {
  workspace_path: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ToolLoopRequest {
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  workspace_path: string;
  model: string;
  max_tokens?: number;
  max_tool_rounds?: number;
  budget_cents?: number;
  stream: boolean;
}

export interface BudgetCheckResult {
  allowed: boolean;
  spent_cents: number;
  limit_cents: number;
  remaining_cents: number;
  hard_stop: boolean;
}

// ─── SSE Event Types ────────────────────────────────────────────

export interface EngineSSEEvent {
  event: string;
  data: Record<string, unknown>;
}

export type OnEngineEvent = (event: EngineSSEEvent) => void;

// ─── CLIENT ─────────────────────────────────────────────────────

export class GoEngineClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.LLM_ORCHESTRATOR_URL || "http://localhost:8080";

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: { "Content-Type": "application/json" },
      timeout: 600000, // 10 min for long stages
    });
  }

  /**
   * Execute a pipeline stage via the Go engine.
   * Non-streaming — returns the full result.
   */
  async executeStage(request: StageExecutionRequest): Promise<StageExecutionResult> {
    const response = await this.client.post<StageExecutionResult>(
      "/api/v2/tasks/execute",
      { ...request, stream: false },
    );
    return response.data;
  }

  /**
   * Execute a pipeline stage with SSE streaming.
   * Returns an async iterable of events.
   */
  async executeStageStreaming(
    request: StageExecutionRequest,
    onEvent: OnEngineEvent,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<StageExecutionResult> {
    const response = await this.client.post(
      "/api/v2/tasks/execute",
      { ...request, stream: true },
      { responseType: "stream", signal },
    );

    return new Promise((resolve, reject) => {
      let result: StageExecutionResult | null = null;
      let buffer = "";
      let currentEvent = "";

      const stream = response.data;

      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);

              if (currentEvent === "phase") {
                onEvent({ event: "phase", data: parsed });
              } else if (currentEvent === "message") {
                // SSE text delta
                if (onDelta) onDelta(data);
              } else if (currentEvent === "complete") {
                result = {
                  stage_name: parsed.stageName,
                  stage_index: parsed.stageIndex,
                  output: parsed.output || "",
                  validation: parsed.validation,
                  duration_ms: parsed.duration || 0,
                  tokens_used: parsed.tokensUsed || 0,
                  cost_cents: parsed.costCents || 0,
                  files_generated: parsed.filesGenerated,
                };
                onEvent({ event: "complete", data: parsed });
              } else if (currentEvent === "error") {
                onEvent({ event: "error", data: parsed });
              }
            } catch {
              // Not JSON — raw text delta
              if (currentEvent === "message" && onDelta) {
                onDelta(data);
              }
            }
            currentEvent = "";
          }
        }
      });

      stream.on("end", () => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error("Stream ended without complete event"));
        }
      });

      stream.on("error", (err: Error) => reject(err));
    });
  }

  /**
   * Execute a single tool in the Go engine sandbox.
   */
  async executeTool(request: ToolExecutionRequest) {
    const response = await this.client.post("/api/v2/tools/execute", request);
    return response.data;
  }

  /**
   * Run an agentic tool loop via the Go engine.
   */
  async runToolLoop(request: ToolLoopRequest) {
    const response = await this.client.post("/api/v2/tools/loop", {
      ...request,
      stream: false,
    });
    return response.data;
  }

  /**
   * Check budget before an operation.
   */
  async checkBudget(
    pipelineRunId: string,
    estimatedCostCents: number,
  ): Promise<BudgetCheckResult> {
    const response = await this.client.post<BudgetCheckResult>(
      "/api/v2/budget/check",
      { pipeline_run_id: pipelineRunId, estimated_cost_cents: estimatedCostCents },
    );
    return response.data;
  }

  /**
   * Record spending after an operation.
   */
  async recordSpend(params: {
    pipelineRunId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    stageName: string;
  }) {
    await this.client.post("/api/v2/budget/record", {
      pipeline_run_id: params.pipelineRunId,
      model: params.model,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cost_cents: params.costCents,
      stage_name: params.stageName,
    });
  }

  /**
   * Build tiered context for a stage execution.
   */
  async buildContext(params: {
    pipelineRunId: string;
    targetStage: string;
    maxTokens: number;
    priorArtifacts: Array<{
      stage_name: string;
      l0_summary: string;
      l1_summary: string;
      l2_content: string;
    }>;
  }) {
    const response = await this.client.post("/api/v2/context/build", {
      pipeline_run_id: params.pipelineRunId,
      target_stage: params.targetStage,
      max_context_tokens: params.maxTokens,
      prior_artifacts: params.priorArtifacts,
    });
    return response.data;
  }

  /**
   * Generate L0/L1 summaries for a stage output.
   */
  async summarizeContext(stageName: string, content: string, model?: string) {
    const response = await this.client.post("/api/v2/context/summarize", {
      stage_name: stageName,
      content,
      model,
    });
    return response.data as { l0: string; l1: string };
  }

  /**
   * Health check the Go engine.
   */
  async healthCheck() {
    const response = await this.client.get("/health");
    return response.data;
  }

  /**
   * List available models from the Go engine.
   */
  async listModels() {
    const response = await this.client.get("/api/v1/models");
    const raw = response.data.models;
    if (raw && !Array.isArray(raw)) {
      return Object.values(raw) as Array<{ id: string; provider: string }>;
    }
    return raw || [];
  }
}

// Lazy singleton
let _instance: GoEngineClient | null = null;
export function getGoEngineClient(): GoEngineClient {
  if (!_instance) {
    _instance = new GoEngineClient();
  }
  return _instance;
}
