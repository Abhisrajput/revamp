

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAuthStore } from '../stores/auth-store';
import { getApiClient } from '../api/types';
import { getWSManager } from '../api/ws';
import type { WSEvent } from '../api/ws';

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

export function useEvolveChat(pipelineRunId: string | null): UseEvolveChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const accumulatedRef = useRef('');
  const unsubRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      unsubRef.current?.();
    };
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || !pipelineRunId) return;
      if (isStreaming) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };

      const assistantId = crypto.randomUUID();
      assistantIdRef.current = assistantId;
      accumulatedRef.current = '';

      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setError(null);

      // Subscribe to chat events via WebSocket
      const topic = `chat:${pipelineRunId}:EVOLVE`;
      unsubRef.current?.();
      unsubRef.current = getWSManager().subscribe(topic, (wsEvent: WSEvent) => {
        const data = wsEvent.data as Record<string, unknown>;

        if (wsEvent.event === 'delta') {
          const deltaText = (data.text as string) || '';
          accumulatedRef.current += deltaText;
          const content = accumulatedRef.current;
          setMessages((prev) =>
            prev.map((m) => m.id === assistantIdRef.current ? { ...m, content } : m)
          );
        } else if (wsEvent.event === 'complete') {
          const finalContent = (data.content as string) || accumulatedRef.current;
          setMessages((prev) =>
            prev.map((m) => m.id === assistantIdRef.current ? { ...m, content: finalContent } : m)
          );
          setIsStreaming(false);
          unsubRef.current?.();
          unsubRef.current = null;
        } else if (wsEvent.event === 'error') {
          setError((data.message as string) || 'Chat error');
          setIsStreaming(false);
          unsubRef.current?.();
          unsubRef.current = null;
        }
      });

      // Send message via HTTP POST (no streaming response)
      try {
        const token = useAuthStore.getState().token;
        const apiUrl = (getApiClient() as any).getBaseUrl?.() || 'http://localhost:8787';

        const response = await fetch(`${apiUrl}/pipeline/${pipelineRunId}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            message: text,
            history: messages.slice(-10).map((m) => ({
              role: m.role,
              content: m.content,
            })),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error((body as any).error || `Chat failed: ${response.status}`);
        }
        // Response is confirmation — events come via WebSocket
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Chat request failed';
        setError(message);
        // Remove empty assistant message on error
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.id === assistantId && !last.content) return prev.slice(0, -1);
          return prev;
        });
        setIsStreaming(false);
        unsubRef.current?.();
        unsubRef.current = null;
      }
    },
    [pipelineRunId, messages, isStreaming],
  );

  const clearHistory = useCallback(() => {
    abortRef.current?.abort();
    unsubRef.current?.();
    unsubRef.current = null;
    setMessages([]);
    setError(null);
    setIsStreaming(false);
  }, []);

  return { messages, sendMessage, isStreaming, error, clearHistory };
}
