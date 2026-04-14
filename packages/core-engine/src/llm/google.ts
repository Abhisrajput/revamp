import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, HealthStatus, ChatMessage } from './types.js';

export class GoogleProvider implements LLMProvider {
  readonly name = 'google';
  private genAI: GoogleGenerativeAI;

  constructor(options: { apiKey?: string } = {}) {
    const apiKey = options.apiKey || process.env.GOOGLE_AI_API_KEY || '';
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { systemPrompt, contents } = this.buildContents(request.messages);

    const model = this.genAI.getGenerativeModel({
      model: request.model,
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
    });

    const result = await model.generateContent({
      contents,
      generationConfig: {
        maxOutputTokens: request.max_tokens,
        temperature: request.temperature ?? 0.3,
      },
    });

    const content = result.response.text();
    const usage = result.response.usageMetadata;

    return {
      id: `google-${Date.now()}`,
      content,
      model: request.model,
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: usage?.candidatesTokenCount ?? 0,
      stop_reason: result.response.candidates?.[0]?.finishReason ?? 'STOP',
    };
  }

  async stream(
    request: ChatRequest,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> {
    const { systemPrompt, contents } = this.buildContents(request.messages);

    const model = this.genAI.getGenerativeModel({
      model: request.model,
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
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
      const text = chunk.text();
      if (text) {
        accumulated += text;
        onDelta({ text });
      }
    }

    const finalResponse = await result.response;
    const usage = finalResponse.usageMetadata;

    return {
      id: `google-${Date.now()}`,
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
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
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
    return ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'];
  }

  /**
   * Google uses 'model' instead of 'assistant', and system messages go in
   * the model config (systemInstruction), not in the contents array.
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
