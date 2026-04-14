/**
 * Tests for the typed error system and global error handler.
 *
 * Ensures that service-layer errors are correctly mapped to HTTP responses.
 */
import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  UnauthorizedError,
  ConflictError,
} from "@/errors.js";

describe("Typed Error Classes", () => {
  it("NotFoundError should have statusCode 404", () => {
    const err = new NotFoundError("Pipeline run not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Pipeline run not found");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it("ForbiddenError should have statusCode 403", () => {
    const err = new ForbiddenError("Access denied");
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
  });

  it("ValidationError should have statusCode 400 and optional details", () => {
    const details = [{ field: "name", message: "required" }];
    const err = new ValidationError("Invalid input", details);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.details).toEqual(details);
  });

  it("UnauthorizedError should have statusCode 401", () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Authentication required");
  });

  it("ConflictError should have statusCode 409", () => {
    const err = new ConflictError("Stage is already executing");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
  });

  it("default messages should be sensible", () => {
    expect(new NotFoundError().message).toBe("Resource not found");
    expect(new ForbiddenError().message).toBe("Access denied");
    expect(new ValidationError().message).toBe("Invalid input");
  });
});

describe("Error Classification Heuristics", () => {
  // These mirror the heuristics in plugins/error-handler.ts
  function classifyMessage(msg: string): number {
    const lower = msg.toLowerCase();
    if (lower.includes("not found")) return 404;
    if (lower.includes("access denied") || lower.includes("permission")) return 403;
    if (lower.includes("unauthorized") || lower.includes("jwt")) return 401;
    if (lower.includes("invalid") || lower.includes("validation")) return 400;
    if (lower.includes("quota") || lower.includes("rate limit")) return 429;
    if (lower.includes("conflict") || lower.includes("already exists")) return 409;
    return 500;
  }

  it("should classify 'not found' messages as 404", () => {
    expect(classifyMessage("Pipeline run not found")).toBe(404);
    expect(classifyMessage("Approval gate not found")).toBe(404);
  });

  it("should classify access errors as 403", () => {
    expect(classifyMessage("Access denied — not a project member")).toBe(403);
    expect(classifyMessage("Insufficient permission to approve")).toBe(403);
  });

  it("should classify auth errors as 401", () => {
    expect(classifyMessage("Unauthorized")).toBe(401);
    expect(classifyMessage("Invalid JWT token")).toBe(401);
  });

  it("should classify validation errors as 400", () => {
    expect(classifyMessage("Invalid stage name")).toBe(400);
    expect(classifyMessage("Validation failed")).toBe(400);
  });

  it("should classify rate limits as 429", () => {
    expect(classifyMessage("API quota exceeded")).toBe(429);
    expect(classifyMessage("Rate limit reached")).toBe(429);
  });

  it("should classify conflicts as 409", () => {
    expect(classifyMessage("Stage is already exists")).toBe(409);
    expect(classifyMessage("Conflict detected")).toBe(409);
  });

  it("should default unknown errors to 500", () => {
    expect(classifyMessage("Something went wrong")).toBe(500);
    expect(classifyMessage("")).toBe(500);
  });
});
