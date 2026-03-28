/**
 * LLM provider and model types for REVAMP
 */

export enum LLMProvider {
  OPENAI = 'OPENAI',
  ANTHROPIC = 'ANTHROPIC',
  GOOGLE = 'GOOGLE',
  AWS_BEDROCK = 'AWS_BEDROCK',
}

export interface ModelInfo {
  provider: LLMProvider;
  modelId: string;
  name: string;
  displayName: string;
  description?: string;
  version: string;
  contextWindow: number; // tokens
  maxOutputTokens: number;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  supportedModes: ('chat' | 'completion' | 'streaming')[];
  isAvailable: boolean;
  deprecationDate?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostEstimate {
  currency: 'USD';
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  name?: string;
  functionCall?: {
    name: string;
    arguments: string;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number; // 0.0 - 2.0, default 1.0
  topP?: number; // 0.0 - 1.0
  topK?: number;
  maxTokens?: number;
  frequencyPenalty?: number; // -2.0 to 2.0
  presencePenalty?: number; // -2.0 to 2.0
  stream?: boolean;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finishReason: 'stop' | 'length' | 'function_call' | 'content_filter' | 'error';
  }>;
  usage: TokenUsage;
  created: number; // unix timestamp
  costEstimate?: CostEstimate;
}

export interface StreamChunk {
  id: string;
  type: 'start' | 'delta' | 'completion';
  model: string;
  timestamp: number;
  delta?: {
    role?: string;
    content?: string;
    functionCall?: {
      name?: string;
      arguments?: string;
    };
  };
  usage?: TokenUsage;
  finishReason?: string;
}

export interface LLMProviderConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimitPerMinute?: number;
}

export interface ProviderHealthStatus {
  provider: LLMProvider;
  isHealthy: boolean;
  lastCheckedAt: string;
  responseTime?: number; // milliseconds
  errorMessage?: string;
  availableModels?: string[];
}

export interface LLMServiceStatus {
  overall: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  providers: ProviderHealthStatus[];
  lastUpdate: string;
  nextCheck: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  variables: string[];
  examples?: Array<{
    input: Record<string, unknown>;
    output: string;
  }>;
  version: string;
  tags: string[];
}

export interface PromptExecutionRequest {
  templateId: string;
  variables: Record<string, unknown>;
  model?: string;
  parameters?: Partial<ChatRequest>;
}

export interface PromptExecutionResponse {
  executionId: string;
  templateId: string;
  result: ChatResponse | StreamChunk[];
  duration: number;
  tokensUsed: TokenUsage;
  costEstimate?: CostEstimate;
}
