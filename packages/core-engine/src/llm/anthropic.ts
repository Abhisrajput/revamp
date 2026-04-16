import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, HealthStatus, ChatMessage } from './types.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(options: { apiKey?: string } = {}) {
    this.client = new Anthropic({
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = this.splitSystemMessage(request.messages);

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature ?? 0.3,
      system: system
        ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
        : undefined,
      messages,
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      id: response.id,
      content,
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      stop_reason: response.stop_reason || 'end_turn',
      cached_tokens: (response.usage as any).cache_read_input_tokens || 0,
      cache_creation_tokens: (response.usage as any).cache_creation_input_tokens || 0,
    };
  }

  async stream(
    request: ChatRequest,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> {
    const { system, messages } = this.splitSystemMessage(request.messages);

    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature ?? 0.3,
      system: system
        ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
        : undefined,
      messages,
    });

    let accumulated = '';

    stream.on('text', (text) => {
      accumulated += text;
      onDelta({ text });
    });

    const finalMessage = await stream.finalMessage();

    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;
    const cachedTokens = (finalMessage.usage as any).cache_read_input_tokens || 0;
    const cacheCreationTokens = (finalMessage.usage as any).cache_creation_input_tokens || 0;

    return {
      id: finalMessage.id,
      content: accumulated,
      model: finalMessage.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      stop_reason: finalMessage.stop_reason || 'end_turn',
      cached_tokens: cachedTokens,
      cache_creation_tokens: cacheCreationTokens,
    };
  }

  async health(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      await this.client.messages.create({
        model: 'claude-haiku-4-5',
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
    return ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
  }

  /** Anthropic requires system as a separate param, not in messages array */
  private splitSystemMessage(messages: ChatMessage[]): {
    system: string | undefined;
    messages: Anthropic.MessageParam[];
  } {
    let system: string | undefined;
    const formatted: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = (system ? system + '\n\n' : '') + msg.content;
      } else {
        formatted.push({ role: msg.role, content: msg.content });
      }
    }

    return { system, messages: formatted };
  }
}
