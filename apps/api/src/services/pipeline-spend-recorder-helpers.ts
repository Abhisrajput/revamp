import type { StageTokenUsage } from "./llm-proxy.js";

/**
 * Accumulate a single LLM response's token counts into a running `StageTokenUsage`.
 * Use at call sites that invoke `streamCompletion` or `complete` directly (bypassing
 * the `createCallFn` wrapper's automatic accumulation).
 */
export function accumulateTokens(
  target: StageTokenUsage,
  response: {
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    cache_creation_tokens?: number;
  },
): void {
  target.inputTokens += response.input_tokens || 0;
  target.outputTokens += response.output_tokens || 0;
  target.cachedTokens += response.cached_tokens || 0;
  target.cacheCreationTokens += response.cache_creation_tokens || 0;
}

/**
 * Resolve a provider name from a model id. Used by recorder call sites that
 * don't already know which provider served a request.
 */
export function resolveProviderName(modelId: string): string {
  const m = modelId.toLowerCase();
  // Bedrock cross-region inference IDs have a regional prefix (us./eu./ap.) or literal "bedrock"
  if (m.startsWith("us.") || m.startsWith("eu.") || m.startsWith("ap.") || m.includes("bedrock")) {
    return "bedrock";
  }
  if (m.includes("anthropic") || m.includes("claude")) return "anthropic";
  if (m.includes("gpt") || m.includes("openai")) return "openai";
  if (m.includes("gemini") || m.includes("flash")) return "gemini";
  return "unknown";
}
