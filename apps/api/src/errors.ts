/**
 * Typed service errors for the REVAMP API.
 *
 * Error handling contract:
 *   - Services throw typed errors for expected failures (not found, forbidden, etc.)
 *   - The Fastify global error handler maps statusCode to HTTP responses.
 *   - Non-critical operations (DB writes, metrics, tier summaries) use .catch(() => {})
 *     with console.error — this is intentional fire-and-forget, not sloppy error handling.
 *   - LLM call failures use classifyError() + withRetry() in the stage runner.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(message, 403, "FORBIDDEN");
  }
}

export class ValidationError extends AppError {
  readonly details?: unknown;

  constructor(message = "Invalid input", details?: unknown) {
    super(message, 400, "VALIDATION_ERROR");
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict") {
    super(message, 409, "CONFLICT");
  }
}
