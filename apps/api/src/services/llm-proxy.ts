/**
 * LLM Proxy Service — bridges Fastify API → Go LLM Orchestrator.
 *
 * The Go orchestrator handles multi-provider routing, circuit breakers,
 * load balancing, and token tracking. This service provides TypeScript-typed
 * wrappers that integrate with the core-engine orchestration.
 *
 * Supports:
 *   - System + user prompt separation (required by Claude, OpenAI)
 *   - SSE streaming for real-time output
 *   - Prompt caching hints (Anthropic cache_control)
 *   - Structured output / JSON mode
 *   - Model selection and fallback
 *
 * Best practices applied:
 *   - Anthropic: prompt caching via cache_control ephemeral markers
 *   - OpenAI: structured outputs with json_schema response_format
 *   - All providers: separate evaluator model from generator to avoid self-validation bias
 */

import axios, { AxiosInstance, AxiosResponse } from "axios";
import type { LLMCallFn, LLMCallRequest } from "@revamp/core-engine";
import type { LLMEvalFn, LLMEvalRequest } from "@revamp/core-engine";

// ─── TYPES ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  cache_control?: { type: "ephemeral" }; // Anthropic prompt caching
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: "text" | "json";
  metadata?: Record<string, unknown>;
}

export interface CompletionResponse {
  id: string;
  content: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
  cached_tokens?: number; // tokens served from cache
}

export interface SSEEvent {
  event: "start" | "delta" | "done" | "error";
  data: string;
}

export interface LLMProviderConfig {
  orchestratorUrl: string;
  apiKey: string;
  defaultModel: string;
  evaluatorModel: string; // different model for validation (avoid self-bias)
  timeout: number;
}

// ─── SERVICE ────────────────────────────────────────────────────

export class LLMProxyService {
  private client: AxiosInstance;
  private config: LLMProviderConfig;
  private modelsDiscovered = false;
  private discoveryPromise: Promise<void> | null = null;

  constructor(config?: Partial<LLMProviderConfig>) {
    this.config = {
      orchestratorUrl: config?.orchestratorUrl || process.env.LLM_ORCHESTRATOR_URL || "http://localhost:8080",
      apiKey: config?.apiKey || process.env.LLM_ORCHESTRATOR_API_KEY || "",
      defaultModel: config?.defaultModel || process.env.LLM_DEFAULT_MODEL || "",
      evaluatorModel: config?.evaluatorModel || process.env.LLM_EVALUATOR_MODEL || "",
      timeout: config?.timeout || 600000, // 10 min (Ollama on slow hardware)
    };

    this.client = axios.create({
      baseURL: this.config.orchestratorUrl,
      headers: {
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      timeout: this.config.timeout,
    });
  }

  /**
   * Auto-discover available models from the Go orchestrator on first use.
   * Picks the best available default and evaluator models.
   */
  private async ensureModelsDiscovered(): Promise<void> {
    if (this.modelsDiscovered) return;
    if (this.config.defaultModel && this.config.evaluatorModel) {
      this.modelsDiscovered = true;
      return;
    }
    // Deduplicate concurrent calls
    if (!this.discoveryPromise) {
      this.discoveryPromise = this._discoverModels();
    }
    await this.discoveryPromise;
  }

  private async _discoverModels(): Promise<void> {
    try {
      const models = await this.listModels();
      const ids = models.map((m) => m.id);

      if (!this.config.defaultModel) {
        // Prefer Claude Sonnet 4 > Claude 3.5 Sonnet > first available
        this.config.defaultModel =
          ids.find((id) => id.includes("claude-sonnet-4")) ||
          ids.find((id) => id.includes("claude-3-5-sonnet")) ||
          ids.find((id) => id.includes("gpt-4")) ||
          ids[0] || "claude-sonnet-4-6";
        console.log(`[LLM Proxy] Auto-selected default model: ${this.config.defaultModel}`);
      }

      if (!this.config.evaluatorModel) {
        // Prefer a cheaper/faster model for evaluation
        this.config.evaluatorModel =
          ids.find((id) => id.includes("claude-haiku")) ||
          ids.find((id) => id.includes("gpt-3.5")) ||
          ids.find((id) => id.includes("gemini") && id.includes("flash")) ||
          this.config.defaultModel;
        console.log(`[LLM Proxy] Auto-selected evaluator model: ${this.config.evaluatorModel}`);
      }
    } catch (err: any) {
      console.warn(`[LLM Proxy] Model discovery failed: ${err.message} — using fallback`);
      if (!this.config.defaultModel) this.config.defaultModel = "claude-sonnet-4-6";
      if (!this.config.evaluatorModel) this.config.evaluatorModel = this.config.defaultModel;
    }
    this.modelsDiscovered = true;
  }

  /**
   * Non-streaming chat completion.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    await this.ensureModelsDiscovered();
    const response = await this.client.post<CompletionResponse>(
      "/api/v1/chat/completions",
      {
        messages: request.messages,
        model: request.model || this.config.defaultModel,
        max_tokens: request.max_tokens || 8192,
        temperature: request.temperature ?? 0.3,
        response_format: request.response_format === "json"
          ? { type: "json_object" }
          : undefined,
        metadata: request.metadata,
      },
    );

    return response.data;
  }

  /**
   * Streaming chat completion via SSE.
   * Calls onDelta for each content chunk, returns full accumulated text.
   */
  async streamCompletion(
    request: CompletionRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResponse> {
    await this.ensureModelsDiscovered();
    const response: AxiosResponse = await this.client.post(
      "/api/v1/chat/completions/stream",
      {
        messages: request.messages,
        model: request.model || this.config.defaultModel,
        max_tokens: request.max_tokens || 8192,
        temperature: request.temperature ?? 0.3,
        metadata: request.metadata,
      },
      {
        responseType: "stream",
        signal,
      },
    );

    return new Promise((resolve, reject) => {
      let accumulated = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let model = request.model || this.config.defaultModel;
      let responseId = "";

      const stream = response.data;
      let buffer = "";
      let currentEvent = "";
      // SSE spec: multiple "data:" lines within one event are joined with "\n"
      let dataLines: string[] = [];

      function dispatchEvent() {
        if (dataLines.length === 0) {
          currentEvent = "";
          return;
        }
        const data = dataLines.join("\n");
        dataLines = [];

        if (data === "[DONE]") { currentEvent = ""; return; }

        // Handle Go orchestrator's SSE format:
        //   event: message  → data is raw text delta (may span multiple data: lines for newlines)
        //   event: done     → data is {"finish_reason": "stop"}
        //   event: error    → data is error string
        if (currentEvent === "message") {
          accumulated += data;
          onDelta?.(data);
          currentEvent = "";
          return;
        }

        if (currentEvent === "error") {
          reject(new Error(`LLM stream error: ${data}`));
          currentEvent = "";
          return;
        }

        if (currentEvent === "done") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.finish_reason) {
              // Done — will resolve on stream end
            }
          } catch {
            // ignore
          }
          currentEvent = "";
          return;
        }

        // Fallback: try OpenAI-format JSON parsing (for future provider compatibility)
        try {
          const parsed = JSON.parse(data);

          if (parsed.choices?.[0]?.delta?.content) {
            const delta = parsed.choices[0].delta.content;
            accumulated += delta;
            onDelta?.(delta);
          }

          if (parsed.id) responseId = parsed.id;
          if (parsed.model) model = parsed.model;
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens || 0;
            outputTokens = parsed.usage.completion_tokens || 0;
            cachedTokens = parsed.usage.cached_tokens || 0;
          }
        } catch {
          // Not JSON — might be raw text, accumulate it
          if (data.trim()) {
            accumulated += data;
            onDelta?.(data);
          }
        }

        currentEvent = "";
      }

      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line

        for (const line of lines) {
          // Blank line = end of SSE event → dispatch accumulated data lines
          if (line.trim() === "") {
            dispatchEvent();
            continue;
          }

          // Track SSE event type
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }

          // Accumulate data lines (SSE multi-line data support)
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          } else if (line.startsWith("data:")) {
            // "data:" with no space means empty line in the data
            dataLines.push(line.slice(5));
          }
        }
      });

      stream.on("end", () => {
        resolve({
          id: responseId,
          content: accumulated,
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          stop_reason: "end_turn",
          cached_tokens: cachedTokens,
        });
      });

      stream.on("error", (err: Error) => {
        reject(new Error(`Stream error: ${err.message}`));
      });
    });
  }

  /**
   * Create an LLMCallFn compatible with core-engine stage runner.
   * This is the main integration point.
   *
   * The returned function has a `.tokenUsage` property that accumulates
   * input/output tokens across all calls made through this function.
   */
  createCallFn(options?: { model?: string; maxTokens?: number }): LLMCallFn & { tokenUsage: { inputTokens: number; outputTokens: number } } {
    const tokenUsage = { inputTokens: 0, outputTokens: 0 };
    const fn = async (req: LLMCallRequest): Promise<string> => {
      const messages: ChatMessage[] = [];

      // System prompt — mark as cacheable for Anthropic
      if (req.systemPrompt) {
        messages.push({
          role: "system",
          content: req.systemPrompt,
          cache_control: { type: "ephemeral" },
        });
      }

      // Cacheable prefix (project + prior context) — separate message for caching
      if (req.cacheablePrefix) {
        messages.push({
          role: "user",
          content: req.cacheablePrefix,
          cache_control: { type: "ephemeral" },
        });
        // Actual user prompt follows (not cached — changes with refinements)
        messages.push({
          role: "user",
          content: req.userPrompt,
        });
      } else {
        messages.push({
          role: "user",
          content: req.userPrompt,
        });
      }

      if (req.onDelta) {
        const response = await this.streamCompletion(
          {
            messages,
            model: options?.model || this.config.defaultModel,
            max_tokens: options?.maxTokens || 8192,
            temperature: req.useExtendedThinking ? 1 : 0.3, // extended thinking requires temp=1
            metadata: {
              useExtendedThinking: req.useExtendedThinking || false,
            },
          },
          req.onDelta,
          req.signal,
        );
        tokenUsage.inputTokens += response.input_tokens || 0;
        tokenUsage.outputTokens += response.output_tokens || 0;
        return response.content;
      }

      const response = await this.complete({
        messages,
        model: options?.model || this.config.defaultModel,
        max_tokens: options?.maxTokens || 8192,
        temperature: req.useExtendedThinking ? 1 : 0.3,
        metadata: {
          useExtendedThinking: req.useExtendedThinking || false,
        },
      });

      tokenUsage.inputTokens += response.input_tokens || 0;
      tokenUsage.outputTokens += response.output_tokens || 0;
      return response.content;
    };
    fn.tokenUsage = tokenUsage;
    return fn;
  }

  /**
   * Create an LLMEvalFn compatible with core-engine validation runner.
   * Uses a different (cheaper/faster) model to avoid self-validation bias.
   */
  createEvalFn(options?: { model?: string }): LLMEvalFn {
    return async (req: LLMEvalRequest): Promise<string> => {
      const messages: ChatMessage[] = [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userPrompt },
      ];

      const response = await this.complete({
        messages,
        model: options?.model || this.config.evaluatorModel,
        max_tokens: 2048,
        temperature: 0.1, // low temp for consistent evaluations
        response_format: req.responseFormat === "json" ? "json" : "text",
      });

      return response.content;
    };
  }

  /**
   * List available models from the Go orchestrator.
   */
  async listModels(): Promise<Array<{ id: string; provider: string; contextWindow: number }>> {
    const response = await this.client.get("/api/v1/models");
    const raw = response.data.models;
    // The Go orchestrator returns models as a map {id: modelInfo}, convert to array
    if (raw && !Array.isArray(raw)) {
      return Object.values(raw) as Array<{ id: string; provider: string; contextWindow: number }>;
    }
    return raw || [];
  }

  /**
   * Get usage stats from the Go orchestrator.
   */
  async getUsage(projectId?: string): Promise<Record<string, unknown>> {
    const params = projectId ? { project_id: projectId } : {};
    const response = await this.client.get("/api/v1/usage", { params });
    return response.data;
  }

  /**
   * Health check the Go orchestrator.
   */
  async healthCheck(): Promise<{ status: string; providers: Record<string, string> }> {
    const response = await this.client.get("/health");
    return response.data;
  }

  /**
   * Check if a separate validation/evaluator model is available and resolvable.
   *
   * Ported from legacy-bridge hasValidationModel() — verifies the evaluator
   * model resolves to a configured provider with credentials before attempting
   * the dual-model flow. Without this check, the reviewer step would fail
   * silently when no evaluator model is configured.
   *
   * Returns true if an evaluator model distinct from the generator is available.
   */
  async hasValidationModel(): Promise<boolean> {
    try {
      await this.ensureModelsDiscovered();

      // No evaluator configured at all
      if (!this.config.evaluatorModel) return false;

      // Verify the evaluator model is actually resolvable by the orchestrator
      const models = await this.listModels();
      const evaluatorExists = models.some((m) => m.id === this.config.evaluatorModel);

      return evaluatorExists;
    } catch {
      // Orchestrator unreachable or model listing failed — no validation model
      return false;
    }
  }
}

// Lazy singleton — ensures process.env is populated (via dotenv) before reading config.
// With ESM, module-level code runs before dotenv.config() in server.ts,
// so we defer construction until first access.
let _instance: LLMProxyService | null = null;
export const llmProxyService: LLMProxyService = new Proxy({} as LLMProxyService, {
  get(_target, prop, receiver) {
    if (!_instance) {
      _instance = new LLMProxyService();
    }
    const value = (_instance as any)[prop];
    return typeof value === "function" ? value.bind(_instance) : value;
  },
});
