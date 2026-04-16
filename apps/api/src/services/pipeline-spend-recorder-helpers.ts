/**
 * Resolve a provider name from a model id. Used by recorder call sites that
 * don't already know which provider served a request.
 */
export function resolveProviderName(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.includes("anthropic") || m.includes("claude")) {
    // Bedrock IDs look like "us.anthropic.claude-sonnet-4-6..." — treat as bedrock when prefixed
    if (m.startsWith("us.") || m.startsWith("eu.") || m.startsWith("ap.") || m.includes("bedrock")) {
      return "bedrock";
    }
    return "anthropic";
  }
  if (m.includes("gpt") || m.includes("openai")) return "openai";
  if (m.includes("gemini") || m.includes("flash")) return "gemini";
  return "unknown";
}
