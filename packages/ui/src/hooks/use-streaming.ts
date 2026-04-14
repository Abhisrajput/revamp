/**
 * Hook for consuming real-time streaming updates over WebSocket.
 *
 * Replaces the former SSE (EventSource) implementation — all real-time
 * pipeline events now flow through the Fastify WebSocket gateway
 * (`/ws` endpoint) rather than text/event-stream SSE.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { StreamUpdate } from '@revamp/shared-types/pipeline';

export interface UseStreamingOptions {
  url: string;
  onMessage?: (update: StreamUpdate) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  onClose?: () => void;
  autoConnect?: boolean;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface UseStreamingReturn {
  isConnected: boolean;
  isConnecting: boolean;
  error: Error | null;
  data: StreamUpdate[];
  connect: () => void;
  disconnect: () => void;
}

export function useStreaming({
  url,
  onMessage,
  onError,
  onOpen,
  onClose,
  autoConnect = true,
  retryAttempts = 3,
  retryDelay = 1000,
}: UseStreamingOptions): UseStreamingReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<StreamUpdate[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disconnect = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent retry loop on manual close
      wsRef.current.close();
      wsRef.current = null;
      setIsConnected(false);
      onClose?.();
    }
  }, [onClose]);

  const connect = useCallback(() => {
    if (isConnected || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setIsConnecting(false);
        retryCountRef.current = 0;
        setError(null);
        onOpen?.();
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const update: StreamUpdate = JSON.parse(event.data as string);
          setData((prev) => [...prev, update]);
          onMessage?.(update);
        } catch (err) {
          const parseError = new Error(`Failed to parse stream data: ${err}`);
          setError(parseError);
          onError?.(parseError);
        }
      };

      ws.onerror = () => {
        // onerror is always followed by onclose — handle retry there
        setIsConnecting(false);
      };

      ws.onclose = () => {
        wsRef.current = null;
        setIsConnected(false);
        setIsConnecting(false);

        if (retryCountRef.current < retryAttempts) {
          const delay = retryDelay * Math.pow(2, retryCountRef.current);
          retryCountRef.current += 1;
          retryTimerRef.current = setTimeout(() => connect(), delay);
        } else {
          const retryError = new Error(
            `Stream connection failed after ${retryAttempts} attempts`,
          );
          setError(retryError);
          onError?.(retryError);
        }
      };
    } catch (err) {
      const connectError = new Error(`Failed to establish stream: ${err}`);
      setError(connectError);
      setIsConnecting(false);
      onError?.(connectError);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, isConnected, isConnecting, retryAttempts, retryDelay, onMessage, onError, onOpen]);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);

  return {
    isConnected,
    isConnecting,
    error,
    data,
    connect,
    disconnect,
  };
}

export default useStreaming;
