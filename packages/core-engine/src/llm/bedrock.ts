import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, HealthStatus, ChatMessage } from './types.js';

interface BedrockOptions {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  bearerToken?: string;
}

export class BedrockProvider implements LLMProvider {
  readonly name = 'bedrock';
  private client: AnthropicBedrock;

  constructor(options: BedrockOptions = {}) {
    const region = options.region || process.env.AWS_REGION || 'us-east-2';

    // Build constructor args based on available credentials
    const clientOpts: Record<string, unknown> = { awsRegion: region };

    if (options.bearerToken) {
      // Bearer token auth (pre-signed, may expire)
      clientOpts.awsAccessKey = '';
      clientOpts.awsSecretKey = '';
      clientOpts.awsSessionToken = options.bearerToken;
    } else if (options.accessKeyId && options.secretAccessKey) {
      // Explicit IAM credentials
      clientOpts.awsAccessKey = options.accessKeyId;
      clientOpts.awsSecretKey = options.secretAccessKey;
      if (options.sessionToken) clientOpts.awsSessionToken = options.sessionToken;
    }
    // If neither, the SDK falls back to the AWS credential chain
    // (env vars, ~/.aws/credentials, SSO, instance profile)

    this.client = new AnthropicBedrock(clientOpts as any);
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
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    return {
      id: response.id,
      content,
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      stop_reason: response.stop_reason || 'end_turn',
      cached_tokens: (response.usage as any).cache_read_input_tokens || 0,
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

    stream.on('text', (text: string) => {
      accumulated += text;
      onDelta({ text });
    });

    const finalMessage = await stream.finalMessage();

    return {
      id: finalMessage.id,
      content: accumulated,
      model: finalMessage.model,
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      stop_reason: finalMessage.stop_reason || 'end_turn',
      cached_tokens: (finalMessage.usage as any).cache_read_input_tokens || 0,
    };
  }

  async health(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      await this.client.messages.create({
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
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
    return [
      'us.anthropic.claude-opus-4-6-20251001-v1:0',
      'us.anthropic.claude-sonnet-4-6-20251001-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    ];
  }

  private splitSystemMessage(messages: ChatMessage[]): {
    system: string | undefined;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    let system: string | undefined;
    const formatted: Array<{ role: 'user' | 'assistant'; content: string }> = [];

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
