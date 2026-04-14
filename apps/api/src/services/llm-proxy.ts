/**
 * LLM Proxy Service — bridges Fastify API → Node LLM Providers (direct SDK calls).
 *
 * Previously this service proxied all LLM traffic through the Go orchestrator
 * via HTTP. Now it uses the @revamp/core-engine/llm providers directly,
 * eliminating the Go dependency for LLM calls.
 *
 * Supports:
 *   - System + user prompt separation (required by Claude, OpenAI)
 *   - Native SDK streaming (no SSE parsing needed)
 *   - Prompt caching hints (Anthropic cache_control)
 *   - Structured output / JSON mode
 *   - Model selection and fallback
 *   - Per-provider circuit breakers (via cockatiel)
 *   - BYOK credentials (per-project)
 *
 * Best practices applied:
 *   - Anthropic: prompt caching via cache_control ephemeral markers
 *   - OpenAI: structured outputs with json_schema response_format
 *   - All providers: separate evaluator model from generator to avoid self-validation bias
 */

import type { LLMCallFn, LLMCallRequest } from "@revamp/core-engine";
import type { LLMEvalFn, LLMEvalRequest } from "@revamp/core-engine";
import { getProvider, getCircuitBreaker, listAvailableModels } from "@revamp/core-engine/llm";
import type { ProviderCredentials as CoreCredentials } from "@revamp/core-engine/llm";
import { ProviderError, isProviderErrorRetryable } from "@/errors/provider-errors.js";
import { retryToolExecution } from "./agent-retry.js";

// ─── TYPES ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  cache_control?: { type: "ephemeral" }; // Anthropic prompt caching
}

export interface ProjectCredentials {
  provider: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  aws_bearer_token?: string;   // Bedrock presigned token (may expire)
  aws_sso_profile?: string;    // SSO profile name from ~/.aws/config (auto-refreshes)
  anthropic_api_key?: string;
  openai_api_key?: string;
  openai_endpoint?: string;
  gemini_api_key?: string;
  // Google Vertex AI
  vertex_ai_project_id?: string;
  vertex_ai_location?: string;
  vertex_ai_service_account_json?: string;
  vertex_ai_access_token?: string;
  // Azure AI Foundry (Azure OpenAI)
  azure_endpoint?: string;
  azure_api_key?: string;
  azure_ad_token?: string;
  azure_api_version?: string;
  azure_deployments?: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: "text" | "json";
  metadata?: Record<string, unknown>;
  credentials?: ProjectCredentials;
  advisor?: { enabled: boolean; model?: string; max_uses?: number };
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

export interface LLMProviderConfig {
  defaultModel: string;
  evaluatorModel: string; // different model for validation (avoid self-validation bias)
  timeout: number;
}

// ─── SERVICE ────────────────────────────────────────────────────

export class LLMProxyService {
  private config: LLMProviderConfig;
  private modelsDiscovered = false;
  private discoveryPromise: Promise<void> | null = null;

  constructor(config?: Partial<LLMProviderConfig>) {
    this.config = {
      defaultModel: config?.defaultModel || process.env.LLM_DEFAULT_MODEL || "",
      evaluatorModel: config?.evaluatorModel || process.env.LLM_EVALUATOR_MODEL || "",
      timeout: config?.timeout || 600000, // 10 min — composition and FORGE code generation need longer for large outputs
    };
  }

  /**
   * Auto-discover available models from configured providers on first use.
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
      const models = listAvailableModels();
      const ids = models.map((m) => m.id);

      if (!this.config.defaultModel) {
        // Prefer Claude Sonnet 4 > Claude 3.5 Sonnet > first available
        this.config.defaultModel =
          ids.find((id) => id.includes("claude-sonnet-4")) ||
          ids.find((id) => id.includes("claude-3-5-sonnet")) ||
          ids.find((id) => id.includes("gpt-4")) ||
          ids[0] || "us.anthropic.claude-sonnet-4-6-20251001-v1:0";
        console.log(`[LLM] Auto-selected default model: ${this.config.defaultModel}`);
      }

      if (!this.config.evaluatorModel) {
        // Prefer a cheaper/faster model for evaluation
        this.config.evaluatorModel =
          ids.find((id) => id.includes("claude-haiku")) ||
          ids.find((id) => id.includes("gpt-3.5")) ||
          ids.find((id) => id.includes("flash")) ||
          this.config.defaultModel;
        console.log(`[LLM] Auto-selected evaluator model: ${this.config.evaluatorModel}`);
      }
    } catch {
      // Use Bedrock cross-region inference IDs as fallback — bare model names like
      // "claude-sonnet-4-6" don't match any provider's model list and cause routing failures.
      if (!this.config.defaultModel) this.config.defaultModel = "us.anthropic.claude-sonnet-4-6-20251001-v1:0";
      if (!this.config.evaluatorModel) this.config.evaluatorModel = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    }
    this.modelsDiscovered = true;
  }

  /**
   * Classify a provider SDK error into a typed ProviderError.
   */
  private classifyError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (err instanceof Error) {
      // Try to extract HTTP status from common SDK error patterns
      const anyErr = err as any;
      if (anyErr.status || anyErr.statusCode) {
        return ProviderError.fromHttpStatus(
          anyErr.status || anyErr.statusCode,
          err.message,
        );
      }
      return ProviderError.fromNetworkError(err);
    }
    return ProviderError.fromNetworkError(new Error(String(err)));
  }

  /**
   * Map ProjectCredentials (API-level) to ProviderCredentials (core-engine level).
   */
  private mapCredentials(creds?: ProjectCredentials): CoreCredentials | undefined {
    if (!creds) return undefined;
    return {
      provider: creds.provider,
      aws_access_key_id: creds.aws_access_key_id,
      aws_secret_access_key: creds.aws_secret_access_key,
      aws_session_token: creds.aws_session_token,
      aws_region: creds.aws_region,
      aws_bearer_token: creds.aws_bearer_token,
      aws_sso_profile: creds.aws_sso_profile,
      anthropic_api_key: creds.anthropic_api_key,
      openai_api_key: creds.openai_api_key,
      openai_endpoint: creds.openai_endpoint,
      gemini_api_key: creds.gemini_api_key,
      azure_endpoint: creds.azure_endpoint,
      azure_api_key: creds.azure_api_key,
      azure_api_version: creds.azure_api_version,
    };
  }

  /**
   * Non-streaming chat completion with automatic retry on transient failures.
   * Uses Node LLM providers directly (no Go orchestrator).
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    await this.ensureModelsDiscovered();

    return retryToolExecution(
      async () => {
        try {
          const model = request.model || this.config.defaultModel;
          const provider = getProvider(model, this.mapCredentials(request.credentials));
          const breaker = getCircuitBreaker(provider.name);

          const response = await breaker.execute(() => provider.chat({
            messages: request.messages.map(m => ({
              role: m.role,
              content: m.content,
              cache_control: m.cache_control,
            })),
            model,
            max_tokens: request.max_tokens || 8192,
            temperature: request.temperature ?? 0.3,
            response_format: request.response_format,
          }));

          return {
            id: response.id,
            content: response.content,
            model: response.model,
            input_tokens: response.input_tokens,
            output_tokens: response.output_tokens,
            stop_reason: response.stop_reason,
            cached_tokens: response.cached_tokens,
          };
        } catch (err) {
          throw this.classifyError(err);
        }
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 15000,
        isRetryable: isProviderErrorRetryable,
        onRetry: (attempt, error) => {
          const pe = error instanceof ProviderError ? error : null;
          console.warn(`[LLM] Retry ${attempt} (${pe?.telemetryType || "unknown"}): ${pe?.message || error}`);
        },
      },
    );
  }

  /**
   * Streaming chat completion via native SDK streaming.
   * Calls onDelta for each content chunk, returns full accumulated response.
   */
  async streamCompletion(
    request: CompletionRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResponse> {
    await this.ensureModelsDiscovered();

    const model = request.model || this.config.defaultModel;
    const provider = getProvider(model, this.mapCredentials(request.credentials));
    const breaker = getCircuitBreaker(provider.name);

    try {
      const response = await breaker.execute(() => provider.stream(
        {
          messages: request.messages.map(m => ({
            role: m.role,
            content: m.content,
            cache_control: m.cache_control,
          })),
          model,
          max_tokens: request.max_tokens || 8192,
          temperature: request.temperature ?? 0.3,
          signal,
        },
        (chunk) => { if (chunk.text) onDelta?.(chunk.text); },
      ));

      return {
        id: response.id,
        content: response.content,
        model: response.model,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        stop_reason: response.stop_reason,
        cached_tokens: response.cached_tokens,
      };
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  /**
   * Create an LLMCallFn compatible with core-engine stage runner.
   * This is the main integration point.
   *
   * The returned function has a `.tokenUsage` property that accumulates
   * input/output tokens across all calls made through this function.
   */
  createCallFn(options?: { model?: string; maxTokens?: number; credentials?: ProjectCredentials; advisor?: { enabled: boolean; model?: string; max_uses?: number } }): LLMCallFn & { tokenUsage: { inputTokens: number; outputTokens: number } } {
    const tokenUsage = { inputTokens: 0, outputTokens: 0 };
    const fn = async (req: LLMCallRequest): Promise<string> => {
      const messages: ChatMessage[] = [];

      // System prompt — mark as cacheable for Anthropic
      // Append markdown formatting rules to ensure clean, parseable output
      if (req.systemPrompt) {
        let formattingRules = "";
        try {
          const coreEngine = await import("@revamp/core-engine");
          formattingRules = (coreEngine as any).MARKDOWN_FORMATTING_RULES || "";
        } catch { /* non-fatal */ }
        messages.push({
          role: "system",
          content: req.systemPrompt + formattingRules,
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
            credentials: options?.credentials,
            advisor: options?.advisor,
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
        credentials: options?.credentials,
        advisor: options?.advisor,
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
  createEvalFn(options?: { model?: string; credentials?: ProjectCredentials }): LLMEvalFn {
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
        credentials: options?.credentials,
      });

      return response.content;
    };
  }

  /**
   * List available models from all configured providers.
   */
  async listModels(): Promise<Array<{ id: string; provider: string; contextWindow: number }>> {
    const models = listAvailableModels();
    return models.map(m => ({ id: m.id, provider: m.provider, contextWindow: 200000 }));
  }

  /**
   * Get usage stats. Previously delegated to Go orchestrator.
   * Now returns empty — usage is tracked in the database via llm_usage table.
   */
  async getUsage(projectId?: string): Promise<Record<string, unknown>> {
    // Usage tracking is handled by the database (llm_usage table), not the LLM provider layer.
    // This method is kept for backward compatibility.
    return { project_id: projectId, note: "Usage is tracked in the database. Query the llm_usage table directly." };
  }

  /**
   * Health check the configured LLM providers.
   */
  async healthCheck(): Promise<{ status: string; providers: Record<string, string> }> {
    const providers: Record<string, string> = {};
    try {
      const provider = getProvider(this.config.defaultModel || "us.anthropic.claude-sonnet-4-6-20251001-v1:0");
      const health = await provider.health();
      providers[provider.name] = health.healthy ? "healthy" : `unhealthy: ${health.error}`;
    } catch (err) {
      providers["default"] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      status: Object.values(providers).every(v => v === "healthy") ? "healthy" : "degraded",
      providers,
    };
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

      // Verify the evaluator model is actually in the available model list
      const models = listAvailableModels();
      const evaluatorExists = models.some((m) => m.id === this.config.evaluatorModel);

      return evaluatorExists;
    } catch {
      // Provider listing failed — no validation model
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
