import { describe, it, expect } from "vitest";
import { resolveProviderName } from "@/services/pipeline-spend-recorder-helpers.js";

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
