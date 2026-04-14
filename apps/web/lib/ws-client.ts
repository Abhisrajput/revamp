import type { WSManager, WSEvent } from '@revamp/core/api/ws';

type Handler = (event: WSEvent) => void;
type ConnectionHandler = (connected: boolean) => void;

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Creates a browser WebSocket manager with:
 * - Exponential backoff reconnect (1s → 2s → 4s → 8s → max 30s)
 * - Topic-based subscriptions with server-side subscribe/unsubscribe signalling
 * - Message queue for messages sent while disconnected
 * - Heartbeat: responds to { event: 'ping' } with { action: 'pong' }
 * - Intentional close via disconnect() skips reconnect
 */
export function createBrowserWSManager(): WSManager {
  let ws: WebSocket | null = null;
  let connected = false;
  let intentionalClose = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentUrl = '';
  let currentToken = '';

  // topic → set of handlers
  const subscriptions = new Map<string, Set<Handler>>();
  // connection state listeners
  const connectionListeners = new Set<ConnectionHandler>();
  // outbound message queue (used while disconnected)
  const messageQueue: Record<string, unknown>[] = [];

  // ─── Internal helpers ────────────────────────────────────────────

  function notifyConnectionChange(state: boolean): void {
    connected = state;
    connectionListeners.forEach((fn) => fn(state));
  }

  function sendRaw(message: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      messageQueue.push(message);
    }
  }

  function flushQueue(): void {
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      if (msg && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }
  }

  function resubscribeAll(): void {
    subscriptions.forEach((_handlers, topic) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'subscribe', topic }));
      }
    });
  }

  function backoffDelay(attempt: number): number {
    const delay = BACKOFF_INITIAL_MS * Math.pow(2, attempt);
    return Math.min(delay, BACKOFF_MAX_MS);
  }

  function scheduleReconnect(): void {
    if (intentionalClose) return;
    const delay = backoffDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      if (!intentionalClose && currentUrl && currentToken) {
        openSocket(currentUrl, currentToken);
      }
    }, delay);
  }

  function openSocket(apiUrl: string, token: string): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Build WS URL from HTTP API base URL
    const wsBase = apiUrl.replace(/^http/, 'ws');
    const wsUrl = `${wsBase.replace(/\/$/, '')}/ws?token=${encodeURIComponent(token)}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectAttempt = 0;
      notifyConnectionChange(true);
      resubscribeAll();
      flushQueue();
    };

    ws.onclose = () => {
      notifyConnectionChange(false);
      ws = null;
      if (!intentionalClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect is handled there
    };

    ws.onmessage = (event: MessageEvent) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      // Heartbeat: respond to ping
      if (parsed['event'] === 'ping') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'pong' }));
        }
        return;
      }

      // Route to topic subscribers
      const topic = parsed['topic'] as string | undefined;
      if (topic) {
        const handlers = subscriptions.get(topic);
        if (handlers) {
          const wsEvent: WSEvent = {
            topic,
            event: (parsed['event'] as string) ?? '',
            data: parsed['data'] ?? parsed,
          };
          handlers.forEach((fn) => fn(wsEvent));
        }
      }
    };
  }

  // ─── WSManager implementation ────────────────────────────────────

  const manager: WSManager = {
    connect(apiUrl: string, token: string): void {
      intentionalClose = false;
      currentUrl = apiUrl;
      currentToken = token;
      // Close any existing socket cleanly before opening a new one
      if (ws) {
        ws.onclose = null; // prevent reconnect loop from the old socket
        ws.close();
        ws = null;
      }
      openSocket(apiUrl, token);
    },

    disconnect(): void {
      intentionalClose = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
      notifyConnectionChange(false);
    },

    subscribe(topic: string, handler: Handler): () => void {
      if (!subscriptions.has(topic)) {
        subscriptions.set(topic, new Set());
        // Tell server we want this topic (if already connected)
        if (connected && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'subscribe', topic }));
        }
      }
      subscriptions.get(topic)!.add(handler);

      return () => {
        const handlers = subscriptions.get(topic);
        if (!handlers) return;
        handlers.delete(handler);
        if (handlers.size === 0) {
          subscriptions.delete(topic);
          // Tell server we no longer need this topic
          if (connected && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'unsubscribe', topic }));
          }
        }
      };
    },

    send(message: Record<string, unknown>): void {
      sendRaw(message);
    },

    isConnected(): boolean {
      return connected;
    },

    onConnectionChange(handler: ConnectionHandler): () => void {
      connectionListeners.add(handler);
      return () => {
        connectionListeners.delete(handler);
      };
    },
  };

  return manager;
}
