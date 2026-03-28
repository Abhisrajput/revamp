/**
 * Agent Retry Utility — retries tool execution failures with exponential backoff.
 *
 * Ported from legacy-bridge retry utility for agent tool execution.
 * When an agent tool call fails (file read error, sandbox timeout, etc.),
 * this utility retries with exponential backoff and jitter to avoid
 * thundering herd when multiple agents retry simultaneously.
 *
 * Usage:
 *   const result = await retryToolExecution(
 *     () => sandboxClient.executeFile(filePath),
 *     { maxRetries: 3, baseDelayMs: 1000 }
 *   );
 */

export interface RetryToolOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 1000). Doubles each attempt. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 to randomize delay (default: 0.2) */
  jitterFactor?: number;
  /** Abort signal — cancels pending retries */
  signal?: AbortSignal;
  /** Called before each retry attempt */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** Optional predicate to determine if an error is retryable. Default: all errors are retryable. */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Retry a tool execution function with exponential backoff and jitter.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The result of fn() if it eventually succeeds
 * @throws The last error if all retries are exhausted
 */
export async function retryToolExecution<T>(
  fn: () => Promise<T>,
  options?: RetryToolOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 30000;
  const jitterFactor = options?.jitterFactor ?? 0.2;
  const isRetryable = options?.isRetryable ?? (() => true);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check abort signal before each attempt
    if (options?.signal?.aborted) {
      throw new Error("Tool execution aborted");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt or error is not retryable
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
      const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1); // +/- jitterFactor
      const finalDelay = Math.max(0, Math.round(cappedDelay + jitter));

      options?.onRetry?.(attempt + 1, error, finalDelay);

      // Wait with abort support
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, finalDelay);

        if (options?.signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Tool execution aborted"));
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

/**
 * Default retryable error predicate for common tool execution failures.
 * Returns true for transient errors that are likely to succeed on retry.
 */
export function isToolExecutionRetryable(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // Non-retryable: permission denied, not found, invalid input
  const nonRetryable = [
    "permission denied",
    "access denied",
    "not found",
    "enoent",
    "invalid",
    "syntax error",
    "type error",
  ];
  if (nonRetryable.some((p) => message.includes(p))) return false;

  // Retryable: timeout, network, resource busy, rate limit
  const retryable = [
    "timeout",
    "timed out",
    "econnrefused",
    "econnreset",
    "network",
    "resource busy",
    "rate limit",
    "too many",
    "temporarily",
    "503",
    "502",
    "429",
  ];
  if (retryable.some((p) => message.includes(p))) return true;

  // Default: retry unknown errors
  return true;
}
