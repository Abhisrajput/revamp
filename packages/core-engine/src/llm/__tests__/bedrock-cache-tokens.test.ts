import { describe, it, expect, vi, beforeEach } from "vitest";

// Separate mocks for messages.create (non-streaming) and messages.stream (streaming)
const mockCreate = vi.fn();
const mockStream = vi.fn();

// Mock the Bedrock SDK before importing the provider
vi.mock("@anthropic-ai/bedrock-sdk", () => {
  function AnthropicBedrock() {
    return {
      messages: { create: mockCreate, stream: mockStream },
    };
  }
  return { default: AnthropicBedrock, AnthropicBedrock };
});

import { BedrockProvider } from "../bedrock.js";

describe("BedrockProvider — cache_creation_tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("non-streaming: populates cache_creation_tokens from response.usage", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_1",
      model: "us.anthropic.claude-sonnet-4-6-20251001-v1:0",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 50,
      },
    });

    const provider = new BedrockProvider({ region: "us-east-2" });
    const response = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "us.anthropic.claude-sonnet-4-6-20251001-v1:0",
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
      model: "us.anthropic.claude-sonnet-4-6-20251001-v1:0",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new BedrockProvider({ region: "us-east-2" });
    const response = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "us.anthropic.claude-sonnet-4-6-20251001-v1:0",
      max_tokens: 100,
    });

    expect(response.cache_creation_tokens).toBe(0);
    expect(response.cached_tokens).toBe(0);
  });

  it("streaming: populates cache_creation_tokens from finalMessage.usage", async () => {
    // The provider calls stream.on('text', cb) then stream.finalMessage()
    // .on() must be chainable (returns the same stream object)
    const streamObject = {
      on: vi.fn().mockReturnThis(),
      finalMessage: vi.fn().mockResolvedValueOnce({
        id: "msg_stream",
        model: "us.anthropic.claude-sonnet-4-6-20251001-v1:0",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 50,
        },
      }),
    };

    mockStream.mockReturnValueOnce(streamObject);

    const provider = new BedrockProvider({ region: "us-east-2" });
    const onDelta = vi.fn();

    const response = await provider.stream(
      {
        messages: [{ role: "user", content: "hi" }],
        model: "us.anthropic.claude-sonnet-4-6-20251001-v1:0",
        max_tokens: 100,
      },
      onDelta,
    );

    expect(response.cache_creation_tokens).toBe(400);
    expect(response.cached_tokens).toBe(50);
    expect(response.input_tokens).toBe(100);
    expect(response.output_tokens).toBe(20);
    expect(response.id).toBe("msg_stream");
    // The provider registered a 'text' listener via stream.on()
    expect(streamObject.on).toHaveBeenCalledWith("text", expect.any(Function));
  });
});
