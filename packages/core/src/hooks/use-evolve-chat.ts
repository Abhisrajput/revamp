

import { useState, useCallback, useRef } from 'react';
import { useAuthStore } from '../stores/auth-store';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface UseEvolveChatReturn {
  messages: ChatMessage[];
  sendMessage: (text: string) => Promise<void>;
  isStreaming: boolean;
  error: string | null;
  clearHistory: () => void;
}

/**
 * Hook for EVOLVE stage interactive chat.
 * Connects to POST /pipeline/:id/chat which returns SSE-streamed responses
 * with full pipeline context.
 */
export function useEvolveChat(pipelineRunId: string | null): UseEvolveChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || !pipelineRunId) return;
      if (isStreaming) return;

      // Abort any previous stream
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };

      // Create placeholder for assistant response
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      };

      setMessages((prev: ChatMessage[]) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setError(null);

      try {
        const token = useAuthStore.getState().token;
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

        const response = await fetch(`${apiUrl}/pipeline/${pipelineRunId}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            message: text,
            history: messages.slice(-10).map((m: ChatMessage) => ({
              role: m.role,
              content: m.content,
            })),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Chat failed: ${response.status}`);
        }

        if (!response.body) {
          throw new Error('No response body');
        }

        // Read SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6);

              if (eventType === 'delta') {
                try {
                  const parsed = JSON.parse(data);
                  const deltaText = parsed.text || '';
                  accumulated += deltaText;
                  // Update assistant message content in place
                  setMessages((prev: ChatMessage[]) =>
                    prev.map((m: ChatMessage) =>
                      m.id === assistantId ? { ...m, content: accumulated } : m
                    )
                  );
                } catch {
                  // Non-JSON delta — treat as raw text
                  accumulated += data;
                  setMessages((prev: ChatMessage[]) =>
                    prev.map((m: ChatMessage) =>
                      m.id === assistantId ? { ...m, content: accumulated } : m
                    )
                  );
                }
              } else if (eventType === 'complete') {
                try {
                  const parsed = JSON.parse(data);
                  const finalContent = parsed.content || accumulated;
                  setMessages((prev: ChatMessage[]) =>
                    prev.map((m: ChatMessage) =>
                      m.id === assistantId ? { ...m, content: finalContent } : m
                    )
                  );
                } catch {
                  // Keep accumulated content
                }
              } else if (eventType === 'error') {
                try {
                  const parsed = JSON.parse(data);
                  setError(parsed.message || 'Chat error');
                } catch {
                  setError('Chat error');
                }
              }

              eventType = '';
            }
          }
        }

        // If we got no content from streaming, remove the empty assistant message
        if (!accumulated) {
          setMessages((prev: ChatMessage[]) => prev.filter((m: ChatMessage) => m.id !== assistantId));
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          // User cancelled — keep partial content
          return;
        }
        const message = err instanceof Error ? err.message : 'Chat request failed';
        setError(message);
        // Remove empty assistant message on error
        setMessages((prev: ChatMessage[]) => {
          const last = prev[prev.length - 1];
          if (last?.id === assistantId && !last.content) {
            return prev.slice(0, -1);
          }
          return prev;
        });
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [pipelineRunId, messages, isStreaming],
  );

  const clearHistory = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setIsStreaming(false);
  }, []);

  return { messages, sendMessage, isStreaming, error, clearHistory };
}
