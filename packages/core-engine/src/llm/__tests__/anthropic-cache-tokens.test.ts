import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock for messages.create — declared before vi.mock so the factory can close over it
const mockCreate = vi.fn();

// Mock the Anthropic SDK before importing the provider
vi.mock("@anthropic-ai/sdk", () => {
  function Anthropic() {
    return {
      messages: { create: mockCreate, stream: mockCreate },
    };
  }
  return { default: Anthropic, Anthropic };
});

import { AnthropicProvider } from "../anthropic.js";

describe("AnthropicProvider — cache_creation_tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("non-streaming: populates cache_creation_tokens from response.usage", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_1",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 50,
      },
    });

    const provider = new AnthropicProvider({ apiKey: "test" });
    const response = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4",
      max_tokens: 100,
    });

    expect(response.cache_creation_tokens).toBe(400);
    expect(response.cached_tokens).toBe(50);
    expect(response.input_tokens).toBe(100);
    expect(response.output_tokens).toBe(20);
  });

  it("non-streaming: defaults cache_creation_tokens to 0 when absent", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_2",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new AnthropicProvider({ apiKey: "test" });
    const response = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4",
      max_tokens: 100,
    });

    expect(response.cache_creation_tokens).toBe(0);
    expect(response.cached_tokens).toBe(0);
  });
});
