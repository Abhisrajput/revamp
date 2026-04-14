import { useEffect, useRef, useState, useCallback } from 'react';
import { getWSManager, type WSEvent } from '../api/ws';

/**
 * Subscribe to a WebSocket topic. Calls handler for each event.
 * Automatically unsubscribes on unmount or topic change.
 */
export function useWSSubscribe(
  topic: string | null,
  handler: (event: WSEvent) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!topic) return;

    const unsubscribe = getWSManager().subscribe(topic, (event) => {
      handlerRef.current(event);
    });

    return unsubscribe;
  }, [topic]);
}

/**
 * Returns the current WebSocket connection state.
 * Re-renders when connection state changes.
 */
export function useWSConnected(): boolean {
  const [connected, setConnected] = useState(() => getWSManager().isConnected());

  useEffect(() => {
    // Sync initial state
    setConnected(getWSManager().isConnected());
    const unsub = getWSManager().onConnectionChange(setConnected);
    return unsub;
  }, []);

  return connected;
}

/**
 * Returns a stable `send` function for the WebSocket connection.
 */
export function useWSSend(): (message: Record<string, unknown>) => void {
  return useCallback((message: Record<string, unknown>) => {
    getWSManager().send(message);
  }, []);
}
