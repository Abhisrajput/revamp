/**
 * LLM Provider interface — platform-agnostic wrapper for LLM SDKs.
 * Each provider (Anthropic, OpenAI, Google, Bedrock) implements this interface.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  max_tokens: number;
  temperature?: number;
  response_format?: 'text' | 'json';
  signal?: AbortSignal;
}

export interface ChatResponse {
  id: string;
  content: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
  cached_tokens?: number;
}

export interface StreamChunk {
  text: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens?: number;
  };
}

export interface HealthStatus {
  provider: string;
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface LLMProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse>;
  health(): Promise<HealthStatus>;
  models(): string[];
}

/** Credentials for per-project BYOK */
export interface ProviderCredentials {
  provider: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  aws_bearer_token?: string;
  aws_sso_profile?: string;
  anthropic_api_key?: string;
  openai_api_key?: string;
  openai_endpoint?: string;
  gemini_api_key?: string;
  azure_endpoint?: string;
  azure_api_key?: string;
  azure_api_version?: string;
}
