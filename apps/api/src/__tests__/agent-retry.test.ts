/**
 * Tests for agent retry utility — exponential backoff with jitter.
 */
import { describe, it, expect, vi } from "vitest";
import {
  retryToolExecution,
  isToolExecutionRetryable,
} from "../services/agent-retry.js";

describe("Agent Retry", () => {
  describe("retryToolExecution", () => {
    it("returns result on first successful call", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await retryToolExecution(fn, { maxRetries: 3, baseDelayMs: 10 });
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and succeeds on second attempt", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue("ok");

      const result = await retryToolExecution(fn, { maxRetries: 3, baseDelayMs: 10 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting all retries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));
      await expect(
        retryToolExecution(fn, { maxRetries: 2, baseDelayMs: 10 }),
      ).rejects.toThrow("always fails");
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("calls onRetry callback before each retry", async () => {
      const onRetry = vi.fn();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("ok");

      await retryToolExecution(fn, { maxRetries: 3, baseDelayMs: 10, onRetry });
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry.mock.calls[0][0]).toBe(1); // attempt 1
      expect(onRetry.mock.calls[1][0]).toBe(2); // attempt 2
    });

    it("respects isRetryable predicate — non-retryable errors throw immediately", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("not found"));
      const isRetryable = (err: unknown) =>
        !(err instanceof Error && err.message.includes("not found"));

      await expect(
        retryToolExecution(fn, { maxRetries: 3, baseDelayMs: 10, isRetryable }),
      ).rejects.toThrow("not found");
      expect(fn).toHaveBeenCalledTimes(1); // no retries
    });

    it("aborts on signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const fn = vi.fn().mockResolvedValue("should not reach");
      await expect(
        retryToolExecution(fn, { maxRetries: 3, signal: controller.signal }),
      ).rejects.toThrow("aborted");
      expect(fn).not.toHaveBeenCalled();
    });

    it("delay increases exponentially", async () => {
      const delays: number[] = [];
      const onRetry = (_attempt: number, _error: unknown, delayMs: number) => {
        delays.push(delayMs);
      };

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("ok");

      await retryToolExecution(fn, {
        maxRetries: 3,
        baseDelayMs: 100,
        jitterFactor: 0, // no jitter for deterministic test
        onRetry,
      });

      // First delay: 100ms (100 * 2^0), second: 200ms (100 * 2^1)
      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
    });
  });

  describe("isToolExecutionRetryable", () => {
    it("timeout errors are retryable", () => {
      expect(isToolExecutionRetryable(new Error("connection timeout"))).toBe(true);
      expect(isToolExecutionRetryable(new Error("request timed out"))).toBe(true);
    });

    it("network errors are retryable", () => {
      expect(isToolExecutionRetryable(new Error("ECONNREFUSED"))).toBe(true);
      expect(isToolExecutionRetryable(new Error("ECONNRESET"))).toBe(true);
    });

    it("rate limit errors are retryable", () => {
      expect(isToolExecutionRetryable(new Error("rate limit exceeded"))).toBe(true);
      expect(isToolExecutionRetryable(new Error("429 Too Many Requests"))).toBe(true);
    });

    it("permission errors are NOT retryable", () => {
      expect(isToolExecutionRetryable(new Error("permission denied"))).toBe(false);
      expect(isToolExecutionRetryable(new Error("access denied"))).toBe(false);
    });

    it("file not found is NOT retryable", () => {
      expect(isToolExecutionRetryable(new Error("ENOENT: file not found"))).toBe(false);
    });

    it("syntax errors are NOT retryable", () => {
      expect(isToolExecutionRetryable(new Error("syntax error at line 5"))).toBe(false);
    });

    it("null/undefined returns false", () => {
      expect(isToolExecutionRetryable(null)).toBe(false);
      expect(isToolExecutionRetryable(undefined)).toBe(false);
    });
  });
});
