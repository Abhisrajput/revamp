/**
 * Typed LLM Provider Errors — Goose-inspired error taxonomy.
 *
 * Each error type carries retryability semantics, enabling callers
 * to make smart retry decisions without string-matching error messages.
 *
 * Pattern: ProviderError.fromHttpStatus(status, body) classifies
 * HTTP responses into typed errors with telemetry labels.
 */

export enum ProviderErrorType {
  /** API key invalid, expired, or missing */
  Authentication = "authentication",
  /** Rate limit exceeded (429) — retryable with backoff */
  RateLimit = "rate_limit",
  /** Input exceeds model's context window */
  ContextLength = "context_length",
  /** Provider returned 5xx */
  ServerError = "server_error",
  /** Network failure (DNS, TCP, TLS) */
  Network = "network",
  /** Credits/billing exhausted */
  CreditsExhausted = "credits_exhausted",
  /** Requested model not available */
  ModelNotFound = "model_not_found",
  /** Malformed request (4xx, non-auth, non-rate-limit) */
  InvalidRequest = "invalid_request",
  /** Request timed out */
  Timeout = "timeout",
}

const RETRYABLE_BY_DEFAULT: Record<ProviderErrorType, boolean> = {
  [ProviderErrorType.Authentication]: false,
  [ProviderErrorType.RateLimit]: true,
  [ProviderErrorType.ContextLength]: false,
  [ProviderErrorType.ServerError]: true,
  [ProviderErrorType.Network]: true,
  [ProviderErrorType.CreditsExhausted]: false,
  [ProviderErrorType.ModelNotFound]: false,
  [ProviderErrorType.InvalidRequest]: false,
  [ProviderErrorType.Timeout]: true,
};

export class ProviderError extends Error {
  readonly type: ProviderErrorType;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
  readonly provider?: string;

  constructor(
    type: ProviderErrorType,
    message: string,
    options?: {
      retryable?: boolean;
      retryAfterMs?: number;
      statusCode?: number;
      provider?: string;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = "ProviderError";
    if (options?.cause) (this as any).cause = options.cause;
    this.type = type;
    this.retryable = options?.retryable ?? RETRYABLE_BY_DEFAULT[type];
    this.retryAfterMs = options?.retryAfterMs;
    this.statusCode = options?.statusCode;
    this.provider = options?.provider;
  }

  /** Label for telemetry/metrics */
  get telemetryType(): string {
    return this.type;
  }

  /**
   * Classify an HTTP response into a typed ProviderError.
   */
  static fromHttpStatus(
    status: number,
    body?: string,
    provider?: string,
  ): ProviderError {
    const bodyLower = (body || "").toLowerCase();

    if (status === 401 || status === 403) {
      return new ProviderError(
        ProviderErrorType.Authentication,
        `Authentication failed (${status}): ${body || "Invalid credentials"}`,
        { statusCode: status, provider },
      );
    }

    if (status === 429) {
      // Try to extract Retry-After from body
      let retryAfterMs: number | undefined;
      const retryMatch = body?.match(/retry.after[:\s]*(\d+)/i);
      if (retryMatch) {
        retryAfterMs = parseInt(retryMatch[1], 10) * 1000;
      }
      return new ProviderError(
        ProviderErrorType.RateLimit,
        `Rate limit exceeded: ${body || "Too many requests"}`,
        { statusCode: status, retryAfterMs, provider },
      );
    }

    if (status === 400 || status === 422) {
      if (bodyLower.includes("context") || bodyLower.includes("token") || bodyLower.includes("too long")) {
        return new ProviderError(
          ProviderErrorType.ContextLength,
          `Context length exceeded: ${body}`,
          { statusCode: status, provider },
        );
      }
      if (bodyLower.includes("model") && (bodyLower.includes("not found") || bodyLower.includes("not available"))) {
        return new ProviderError(
          ProviderErrorType.ModelNotFound,
          `Model not found: ${body}`,
          { statusCode: status, provider },
        );
      }
      return new ProviderError(
        ProviderErrorType.InvalidRequest,
        `Invalid request (${status}): ${body}`,
        { statusCode: status, provider },
      );
    }

    if (status === 402 || bodyLower.includes("credit") || bodyLower.includes("billing") || bodyLower.includes("quota")) {
      return new ProviderError(
        ProviderErrorType.CreditsExhausted,
        `Credits exhausted: ${body || "Billing limit reached"}`,
        { statusCode: status, provider },
      );
    }

    if (status >= 500) {
      return new ProviderError(
        ProviderErrorType.ServerError,
        `Server error (${status}): ${body || "Internal server error"}`,
        { statusCode: status, provider },
      );
    }

    return new ProviderError(
      ProviderErrorType.InvalidRequest,
      `HTTP ${status}: ${body || "Unknown error"}`,
      { statusCode: status, provider },
    );
  }

  /**
   * Classify a network/system error into a typed ProviderError.
   */
  static fromNetworkError(err: Error, provider?: string): ProviderError {
    const msg = err.message.toLowerCase();

    if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted")) {
      return new ProviderError(
        ProviderErrorType.Timeout,
        `Request timed out: ${err.message}`,
        { cause: err, provider },
      );
    }

    return new ProviderError(
      ProviderErrorType.Network,
      `Network error: ${err.message}`,
      { cause: err, provider },
    );
  }
}

/**
 * Check if an unknown error is retryable.
 * Works with ProviderError (uses .retryable) and plain errors (falls back to message matching).
 */
export function isProviderErrorRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const retryablePatterns = ["timeout", "econnrefused", "econnreset", "network", "rate limit", "429", "502", "503"];
  return retryablePatterns.some((p) => message.includes(p));
}
