import OpenAI from 'openai';
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, HealthStatus } from './types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name: string = 'openai';
  protected client: OpenAI;

  constructor(
    options: {
      apiKey?: string;
      baseURL?: string;
      organization?: string;
      defaultQuery?: Record<string, string>;
      defaultHeaders?: Record<string, string | undefined>;
    } = {},
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey || process.env.OPENAI_API_KEY,
      baseURL: options.baseURL,
      organization: options.organization,
      defaultQuery: options.defaultQuery,
      defaultHeaders: options.defaultHeaders,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature ?? 0.3,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(request.response_format === 'json'
        ? { response_format: { type: 'json_object' as const } }
        : {}),
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? '';
    const usage = response.usage;

    return {
      id: response.id,
      content,
      model: response.model,
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      stop_reason: choice?.finish_reason ?? 'stop',
    };
  }

  async stream(request: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const streamResponse = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature ?? 0.3,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(request.response_format === 'json'
        ? { response_format: { type: 'json_object' as const } }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let accumulated = '';
    let id = '';
    let model = request.model;
    let stopReason = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of streamResponse) {
      if (chunk.id) id = chunk.id;
      if (chunk.model) model = chunk.model;

      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        accumulated += delta;
        onDelta({ text: delta });
      }

      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason) stopReason = finishReason;

      // Usage arrives in the final chunk when stream_options.include_usage is set
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    return {
      id,
      content: accumulated,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      stop_reason: stopReason,
    };
  }

  async health(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { provider: this.name, healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        provider: this.name,
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  models(): string[] {
    return ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3-mini'];
  }
}
