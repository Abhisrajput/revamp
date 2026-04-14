/**
 * WebSocket manager — platform-agnostic real-time transport interface.
 *
 * Multica pattern: packages/core defines the interface.
 * Each platform provides its own implementation:
 *   Web: native WebSocket with reconnect
 *   VS Code: WebSocket via vscode.env
 *   Desktop: electron WebSocket
 */

export interface WSEvent {
  topic: string;
  event: string;
  data: unknown;
}

export interface WSManager {
  /** Connect to the WebSocket server */
  connect(url: string, token: string): void;
  /** Disconnect and clean up */
  disconnect(): void;
  /** Subscribe to a topic. Returns an unsubscribe function. */
  subscribe(topic: string, handler: (event: WSEvent) => void): () => void;
  /** Send a JSON message to the server */
  send(message: Record<string, unknown>): void;
  /** Whether the WebSocket is currently connected */
  isConnected(): boolean;
  /** Register a connection state change listener. Returns unsubscribe. */
  onConnectionChange(handler: (connected: boolean) => void): () => void;
}

// ─── Global singleton (set by platform provider) ────────────────

let _wsManager: WSManager | null = null;

/**
 * Register the WebSocket manager implementation.
 * Called once at app boot (e.g., in providers.tsx).
 */
export function setWSManager(manager: WSManager): void {
  _wsManager = manager;
}

/**
 * Get the registered WebSocket manager.
 * Returns a no-op manager during SSR (before setWSManager is called).
 */
export function getWSManager(): WSManager {
  if (_wsManager) return _wsManager;
  return SSR_NOOP_WS;
}

// SSR no-op — prevents crashes when hooks run during server rendering
const SSR_NOOP_WS: WSManager = {
  connect: () => {},
  disconnect: () => {},
  subscribe: () => () => {},
  send: () => {},
  isConnected: () => false,
  onConnectionChange: () => () => {},
};
