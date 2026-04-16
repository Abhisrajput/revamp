import { describe, it, expect } from "vitest";
import { resolveProviderName, accumulateTokens } from "@/services/pipeline-spend-recorder-helpers.js";

describe("resolveProviderName", () => {
  it("identifies Bedrock cross-region IDs by prefix", () => {
    expect(resolveProviderName("us.anthropic.claude-sonnet-4-6-20251001-v1:0")).toBe("bedrock");
    expect(resolveProviderName("eu.anthropic.claude-sonnet-4-6")).toBe("bedrock");
    expect(resolveProviderName("ap.anthropic.claude-haiku-4-5")).toBe("bedrock");
    expect(resolveProviderName("us.amazon.nova-pro-v1:0")).toBe("bedrock");
    expect(resolveProviderName("mistral.mistral-large-2402-v1:0")).toBe("unknown"); // no regional prefix, not in any provider list
  });

  it("identifies native Anthropic models", () => {
    expect(resolveProviderName("claude-sonnet-4-6")).toBe("anthropic");
    expect(resolveProviderName("claude-3-5-sonnet")).toBe("anthropic");
  });

  it("identifies OpenAI models", () => {
    expect(resolveProviderName("gpt-4o")).toBe("openai");
    expect(resolveProviderName("gpt-4-turbo")).toBe("openai");
  });

  it("identifies Gemini models", () => {
    expect(resolveProviderName("gemini-1.5-pro")).toBe("gemini");
    expect(resolveProviderName("flash")).toBe("gemini");
  });

  it("returns unknown for unrecognized models", () => {
    expect(resolveProviderName("")).toBe("unknown");
    expect(resolveProviderName("mystery-model-v1")).toBe("unknown");
  });
});

describe("accumulateTokens", () => {
  it("adds all four token fields into the target accumulator", () => {
    const target = { inputTokens: 100, outputTokens: 50, cachedTokens: 10, cacheCreationTokens: 5 };
    accumulateTokens(target, {
      input_tokens: 200,
      output_tokens: 150,
      cached_tokens: 20,
      cache_creation_tokens: 30,
    });
    expect(target).toEqual({ inputTokens: 300, outputTokens: 200, cachedTokens: 30, cacheCreationTokens: 35 });
  });

  it("treats missing fields as zero", () => {
    const target = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
    accumulateTokens(target, { input_tokens: 50 });
    expect(target).toEqual({ inputTokens: 50, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 });
  });

  it("mutates the passed-in target (reference semantics)", () => {
    const target = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };
    const returnValue = accumulateTokens(target, { input_tokens: 1, output_tokens: 2 });
    expect(returnValue).toBeUndefined();
    expect(target.inputTokens).toBe(1);
    expect(target.outputTokens).toBe(2);
  });
});
