import { VertexAI } from '@google-cloud/vertexai';
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, HealthStatus, ChatMessage } from './types.js';

interface VertexAIOptions {
  projectId?: string;
  location?: string;
  apiKey?: string;
}

export class VertexAIProvider implements LLMProvider {
  readonly name = 'vertexai';
  private vertexAI: VertexAI;

  constructor(options: VertexAIOptions = {}) {
    const project = options.projectId || process.env.VERTEX_AI_PROJECT_ID || '';
    const location = options.location || process.env.VERTEX_AI_LOCATION || 'us-central1';

    this.vertexAI = new VertexAI({ project, location });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { systemPrompt, contents } = this.buildContents(request.messages);

    const model = this.vertexAI.getGenerativeModel({
      model: request.model,
      ...(systemPrompt ? { systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] } } : {}),
    });

    const result = await model.generateContent({
      contents,
      generationConfig: {
        maxOutputTokens: request.max_tokens,
        temperature: request.temperature ?? 0.3,
      },
    });

    const candidate = result.response.candidates?.[0];
    const content = candidate?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    const usage = result.response.usageMetadata;

    return {
      id: `vertexai-${Date.now()}`,
      content,
      model: request.model,
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: usage?.candidatesTokenCount ?? 0,
      stop_reason: candidate?.finishReason ?? 'STOP',
    };
  }

  async stream(
    request: ChatRequest,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> {
    const { systemPrompt, contents } = this.buildContents(request.messages);

    const model = this.vertexAI.getGenerativeModel({
      model: request.model,
      ...(systemPrompt ? { systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] } } : {}),
    });

    const result = await model.generateContentStream({
      contents,
      generationConfig: {
        maxOutputTokens: request.max_tokens,
        temperature: request.temperature ?? 0.3,
      },
    });

    let accumulated = '';

    for await (const chunk of result.stream) {
      const chunkText = chunk.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      if (chunkText) {
        accumulated += chunkText;
        onDelta({ text: chunkText });
      }
    }

    const finalResponse = await result.response;
    const usage = finalResponse.usageMetadata;

    return {
      id: `vertexai-${Date.now()}`,
      content: accumulated,
      model: request.model,
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: usage?.candidatesTokenCount ?? 0,
      stop_reason: finalResponse.candidates?.[0]?.finishReason ?? 'STOP',
    };
  }

  async health(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      const model = this.vertexAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
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
    return ['gemini-2.0-flash', 'gemini-1.5-pro'];
  }

  /**
   * Vertex AI uses the same content format as Google Gemini:
   * 'model' role instead of 'assistant', system messages in systemInstruction config.
   */
  private buildContents(messages: ChatMessage[]): {
    systemPrompt: string | undefined;
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  } {
    let systemPrompt: string | undefined;
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return { systemPrompt, contents };
  }
}
