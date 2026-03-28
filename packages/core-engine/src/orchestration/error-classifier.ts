/**
 * Error Classification & Retry Strategy
 *
 * Ported from legacy-bridge src/lib/stageAI.ts isRetryableError() and
 * src/lib/aiClient.ts error classification functions.
 *
 * Classifies LLM errors into categories with different retry strategies:
 *   - RETRYABLE: Temporary failures (network, rate limit, overload) → retry with backoff
 *   - CONTEXT_LENGTH: Input too long → truncate prompt and retry
 *   - QUOTA: Billing/quota exceeded → fail immediately, no retry
 *   - AUTH: Invalid API key → fail immediately
 *   - UNKNOWN: Unclassified → retry once, then fail
 */

// ─── ERROR TYPES ────────────────────────────────────────────────

export type ErrorCategory =
  | 'retryable'       // Temporary — retry with exponential backoff
  | 'context_length'  // Input too long — truncate and retry
  | 'quota'           // Billing/quota — fail immediately
  | 'auth'            // Authentication — fail immediately
  | 'unknown';        // Unclassified — retry once

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  shouldRetry: boolean;
  suggestedDelayMs: number;
}

// ─── CLASSIFICATION ──────────────────────────────────────────────

export function classifyError(error: unknown, attempt: number = 1): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Quota/billing errors — never retry, will keep failing
  if (isQuotaError(lower)) {
    return {
      category: 'quota',
      message,
      shouldRetry: false,
      suggestedDelayMs: 0,
    };
  }

  // Auth errors — never retry
  if (isAuthError(lower)) {
    return {
      category: 'auth',
      message,
      shouldRetry: false,
      suggestedDelayMs: 0,
    };
  }

  // Context length errors — can retry with truncated prompt
  if (isContextLengthError(lower)) {
    return {
      category: 'context_length',
      message,
      shouldRetry: attempt <= 1, // only retry once with truncation
      suggestedDelayMs: 500,
    };
  }

  // Rate limit / overload — retry with longer backoff
  if (isRateLimitError(lower)) {
    return {
      category: 'retryable',
      message,
      shouldRetry: attempt <= 3,
      suggestedDelayMs: Math.min(2000 * Math.pow(2, attempt - 1), 30000), // 2s, 4s, 8s... max 30s
    };
  }

  // Network/transient errors — retry with standard backoff
  if (isTransientError(lower)) {
    return {
      category: 'retryable',
      message,
      shouldRetry: attempt <= 3,
      suggestedDelayMs: 2000 * attempt, // 2s, 4s, 6s
    };
  }

  // Unknown — retry once
  return {
    category: 'unknown',
    message,
    shouldRetry: attempt <= 1,
    suggestedDelayMs: 2000,
  };
}

// ─── DETECTION HELPERS ───────────────────────────────────────────

function isQuotaError(msg: string): boolean {
  return (
    msg.includes('quota') ||
    msg.includes('billing') ||
    msg.includes('payment') ||
    msg.includes('insufficient_quota') ||
    msg.includes('exceeded') ||
    msg.includes('(402)')
  );
}

function isAuthError(msg: string): boolean {
  return (
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication') ||
    msg.includes('authentication_error') ||
    msg.includes('unauthorized') ||
    msg.includes('(401)') ||
    msg.includes('(403)')
  );
}

function isContextLengthError(msg: string): boolean {
  return (
    msg.includes('context length') ||
    msg.includes('context_length') ||
    msg.includes('maximum context') ||
    msg.includes('too many tokens') ||
    msg.includes('token limit') ||
    msg.includes('max_tokens') ||
    msg.includes('prompt is too long')
  );
}

function isRateLimitError(msg: string): boolean {
  return (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('(429)') ||
    msg.includes('overloaded') ||
    msg.includes('(529)') ||
    msg.includes('(503)')
  );
}

function isTransientError(msg: string): boolean {
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('temporar') ||
    msg.includes('gateway') ||
    msg.includes('bodystreambuffer') ||
    msg.includes('aborted') ||
    msg.includes('connection') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('(502)') ||
    msg.includes('(500)')
  );
}

// ─── RETRY EXECUTOR ──────────────────────────────────────────────

export interface RetryOptions {
  maxAttempts?: number;
  onRetry?: (attempt: number, classified: ClassifiedError) => void;
}

/**
 * Execute an async function with intelligent retry based on error classification.
 * Different error types get different retry strategies.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyError(err, attempt);

      if (!classified.shouldRetry || attempt >= maxAttempts) {
        throw err; // Re-throw original error
      }

      options?.onRetry?.(attempt, classified);

      // Wait before retrying
      if (classified.suggestedDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, classified.suggestedDelayMs));
      }
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error('Retry exhausted');
}

// ─── REASONING MODEL DETECTION ───────────────────────────────────

/**
 * Detect OpenAI reasoning models (o1, o3-mini, o3) that require special handling:
 *   - No system prompt allowed (must be moved to first user message)
 *   - Use `max_completion_tokens` instead of `max_tokens`
 *   - Higher default context windows (200k for o3)
 *   - Temperature must be 0 or 1 (no intermediate values)
 *
 * Ported from legacy-bridge isReasoningModel() in aiClient.ts.
 * Mirrors the Go-side isReasoningModel() in openai.go.
 */
export function isReasoningModel(model: string): boolean {
  if (!model) return false;
  const trimmed = model.trim().toLowerCase();
  // Match o1, o1-mini, o1-preview, o3, o3-mini, etc.
  return /^o[13](-|$)/.test(trimmed);
}

// ─── TOKEN ESTIMATION ────────────────────────────────────────────

const CHARS_PER_TOKEN = 4; // Rough estimate for English text

/**
 * Estimate token count for a given text.
 * Uses the standard ~4 chars per token heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text || !text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Model context window sizes (input limits).
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic — Claude 4.x
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5-20251001': 200000,
  // Anthropic — Claude 3.5
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-haiku-20241022': 200000,
  // Anthropic — Claude 3
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  // OpenAI
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  // Google
  'gemini-2.0-flash': 1000000,
  'gemini-1.5-pro': 2000000,
  'gemini-1.5-flash': 1000000,
};

/**
 * Get the context window for a model (defaults to 128k if unknown).
 */
export function getModelContextWindow(model: string): number {
  // Try exact match first
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // Try prefix match (e.g., "claude-sonnet-4" matches "claude-sonnet-4-*")
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key.split('-').slice(0, 3).join('-'))) return value;
  }
  return 128000; // Safe default
}

/**
 * Pre-flight check: estimate if the prompt will fit in the model's context window.
 * Returns the estimated usage ratio (0-1+) and whether truncation is recommended.
 */
export function checkTokenBudget(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  reservedOutputTokens: number = 8192,
): { estimatedInputTokens: number; contextWindow: number; usageRatio: number; shouldTruncate: boolean } {
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  const contextWindow = getModelContextWindow(model);
  const availableForInput = contextWindow - reservedOutputTokens;
  const usageRatio = estimatedInputTokens / availableForInput;

  return {
    estimatedInputTokens,
    contextWindow,
    usageRatio,
    shouldTruncate: usageRatio > 0.85, // Warn at 85% usage
  };
}
