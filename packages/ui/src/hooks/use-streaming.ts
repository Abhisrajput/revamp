/**
 * Hook for consuming Server-Sent Events (SSE) streams
 * Used to receive real-time updates from the Go orchestrator
 */

import { useEffect, useState, useCallback } from 'react';
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
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const connect = useCallback(() => {
    if (isConnected || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      const es = new EventSource(url);

      es.addEventListener('open', () => {
        setIsConnected(true);
        setIsConnecting(false);
        setRetryCount(0);
        setError(null);
        onOpen?.();
      });

      es.addEventListener('message', (event: MessageEvent) => {
        try {
          const update: StreamUpdate = JSON.parse(event.data);
          setData((prev) => [...prev, update]);
          onMessage?.(update);
        } catch (err) {
          const parseError = new Error(`Failed to parse stream data: ${err}`);
          setError(parseError);
          onError?.(parseError);
        }
      });

      es.addEventListener('error', () => {
        es.close();
        setIsConnected(false);
        setIsConnecting(false);

        if (retryCount < retryAttempts) {
          setTimeout(() => {
            setRetryCount((c) => c + 1);
            connect();
          }, retryDelay * Math.pow(2, retryCount)); // Exponential backoff
        } else {
          const retryError = new Error(
            `Stream connection failed after ${retryAttempts} attempts`,
          );
          setError(retryError);
          onError?.(retryError);
        }
      });

      setEventSource(es);
    } catch (err) {
      const connectError = new Error(`Failed to establish stream: ${err}`);
      setError(connectError);
      setIsConnecting(false);
      onError?.(connectError);
    }
  }, [url, isConnected, isConnecting, retryCount, retryAttempts, retryDelay, onMessage, onError, onOpen]);

  const disconnect = useCallback(() => {
    if (eventSource) {
      eventSource.close();
      setEventSource(null);
      setIsConnected(false);
      onClose?.();
    }
  }, [eventSource, onClose]);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

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
