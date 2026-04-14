import { FastifyInstance, FastifyError } from "fastify";
import fp from "fastify-plugin";
import { AppError } from "@/errors.js";

/**
 * Global error handler plugin.
 *
 * Catches unhandled errors from route handlers and maps them to
 * consistent HTTP responses. This is the boundary between service-layer
 * throws and client-facing error responses.
 *
 * Priority:
 *   1. AppError subclasses → use their statusCode directly
 *   2. Fastify validation errors → 400
 *   3. Message heuristics → infer status from error message
 *   4. Unknown → 500 with sanitized message
 */
async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError | Error, request, reply) => {
    // 1. Typed AppError — use statusCode directly
    if (error instanceof AppError) {
      const body: Record<string, unknown> = {
        error: error.message,
        code: error.code,
      };
      if ("details" in error && (error as any).details) {
        body.details = (error as any).details;
      }
      return reply.status(error.statusCode).send(body);
    }

    // 2. Fastify schema validation errors
    if ("validation" in error && error.validation) {
      return reply.status(400).send({
        error: "Invalid input",
        code: "VALIDATION_ERROR",
        details: error.validation,
      });
    }

    // 3. Message-based heuristics for untyped errors
    const msg = error.message || "Internal server error";
    const lower = msg.toLowerCase();

    if (lower.includes("not found")) {
      return reply.status(404).send({ error: msg, code: "NOT_FOUND" });
    }
    if (lower.includes("access denied") || lower.includes("not authorized") || lower.includes("permission")) {
      return reply.status(403).send({ error: msg, code: "FORBIDDEN" });
    }
    if (lower.includes("unauthorized") || lower.includes("invalid token") || lower.includes("jwt")) {
      return reply.status(401).send({ error: msg, code: "UNAUTHORIZED" });
    }
    if (lower.includes("invalid") || lower.includes("validation") || lower.includes("required")) {
      return reply.status(400).send({ error: msg, code: "VALIDATION_ERROR" });
    }
    if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("too many")) {
      return reply.status(429).send({ error: msg, code: "RATE_LIMITED" });
    }
    if (lower.includes("conflict") || lower.includes("already exists") || lower.includes("duplicate")) {
      return reply.status(409).send({ error: msg, code: "CONFLICT" });
    }

    // 4. Unknown error — 500 with sanitized message
    const statusCode = "statusCode" in error ? (error as any).statusCode : 500;
    request.log.error(error, "Unhandled error");
    return reply.status(statusCode || 500).send({
      error: process.env.NODE_ENV === "production" ? "Internal server error" : msg,
      code: "INTERNAL_ERROR",
    });
  });
}

export default fp(errorHandlerPlugin, {
  name: "error-handler",
});
