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
