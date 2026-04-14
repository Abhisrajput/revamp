import type { LLMProvider, ProviderCredentials } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { BedrockProvider } from './bedrock.js';
import { OpenAIProvider } from './openai.js';
import { AzureProvider } from './azure.js';
import { GoogleProvider } from './google.js';
import { VertexAIProvider } from './vertexai.js';

/**
 * Get the appropriate LLM provider for a model + credentials combination.
 *
 * Priority:
 * 1. BYOK credentials (explicit provider from project settings)
 * 2. Model name prefix matching (claude-* → anthropic, gpt-* → openai, etc.)
 * 3. Default: Bedrock (most common in enterprise)
 */
export function getProvider(model: string, credentials?: ProviderCredentials): LLMProvider {
  // ─── BYOK: explicit credentials override ──────────────────
  if (credentials) {
    if (credentials.provider === 'bedrock' || credentials.aws_region) {
      return new BedrockProvider({
        region: credentials.aws_region || 'us-east-2',
        accessKeyId: credentials.aws_access_key_id,
        secretAccessKey: credentials.aws_secret_access_key,
        sessionToken: credentials.aws_session_token,
        bearerToken: credentials.aws_bearer_token,
      });
    }
    if (credentials.provider === 'anthropic' || credentials.anthropic_api_key) {
      return new AnthropicProvider({ apiKey: credentials.anthropic_api_key });
    }
    if (credentials.provider === 'azure' || credentials.azure_endpoint) {
      return new AzureProvider({
        endpoint: credentials.azure_endpoint,
        apiKey: credentials.azure_api_key,
        apiVersion: credentials.azure_api_version,
      });
    }
    if (credentials.provider === 'openai' || credentials.openai_api_key) {
      return new OpenAIProvider({
        apiKey: credentials.openai_api_key,
        baseURL: credentials.openai_endpoint,
      });
    }
    if (credentials.provider === 'vertexai' || credentials.provider === 'vertex_ai') {
      return new VertexAIProvider({});
    }
    if (credentials.provider === 'gemini' || credentials.gemini_api_key) {
      return new GoogleProvider({ apiKey: credentials.gemini_api_key });
    }
  }

  // ─── Route by model name prefix ───────────────────────────
  const m = model.toLowerCase();

  // Bedrock model IDs contain 'anthropic' with region prefix
  if (m.includes('.anthropic.') || m.startsWith('us.') || m.startsWith('eu.')) {
    return new BedrockProvider({ region: process.env.AWS_REGION || 'us-east-2' });
  }

  // Claude direct API
  if (m.startsWith('claude')) {
    // If Anthropic API key is set, use direct. Otherwise fall back to Bedrock.
    if (process.env.ANTHROPIC_API_KEY) {
      return new AnthropicProvider({});
    }
    return new BedrockProvider({ region: process.env.AWS_REGION || 'us-east-2' });
  }

  // OpenAI models
  if (/^(gpt|o1|o3|text-|davinci|chatgpt)/.test(m)) {
    return new OpenAIProvider({});
  }

  // Google Gemini
  if (m.startsWith('gemini')) {
    if (process.env.VERTEX_AI_PROJECT_ID) {
      return new VertexAIProvider({});
    }
    return new GoogleProvider({});
  }

  // Default: Bedrock (enterprise default)
  return new BedrockProvider({ region: process.env.AWS_REGION || 'us-east-2' });
}

/**
 * List all available models across all configured providers.
 * Returns models from providers that have credentials configured.
 */
export function listAvailableModels(): Array<{ id: string; provider: string }> {
  const models: Array<{ id: string; provider: string }> = [];

  // Always include Bedrock (uses AWS credential chain)
  const bedrock = new BedrockProvider({});
  for (const id of bedrock.models()) {
    models.push({ id, provider: 'bedrock' });
  }

  // Include Anthropic direct if API key is set
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = new AnthropicProvider({});
    for (const id of anthropic.models()) {
      models.push({ id, provider: 'anthropic' });
    }
  }

  // Include OpenAI if API key is set
  if (process.env.OPENAI_API_KEY) {
    const openai = new OpenAIProvider({});
    for (const id of openai.models()) {
      models.push({ id, provider: 'openai' });
    }
  }

  // Include Google if API key is set
  if (process.env.GOOGLE_AI_API_KEY) {
    const google = new GoogleProvider({});
    for (const id of google.models()) {
      models.push({ id, provider: 'gemini' });
    }
  }

  // Include Azure if endpoint is set
  if (process.env.AZURE_OPENAI_ENDPOINT) {
    const azure = new AzureProvider({});
    for (const id of azure.models()) {
      models.push({ id, provider: 'azure' });
    }
  }

  // Include Vertex AI if project is set
  if (process.env.VERTEX_AI_PROJECT_ID) {
    const vertex = new VertexAIProvider({});
    for (const id of vertex.models()) {
      models.push({ id, provider: 'vertexai' });
    }
  }

  return models;
}
