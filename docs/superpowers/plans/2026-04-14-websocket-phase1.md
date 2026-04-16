# WebSocket Migration Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all client-facing SSE with WebSocket using topic-based subscriptions, backed by Redis pub/sub for horizontal scaling.

**Architecture:** Single WebSocket connection per browser session connects to Fastify's existing `@fastify/websocket` plugin. Clients subscribe to topics (`pipeline:<runId>`, `agent:events`, `chat:<runId>:<stage>`). Backend publishes events to topics via a `WSPublisher` service that delivers locally + through Redis pub/sub. Frontend hooks (`use-stage-execution`, `use-agent-events`, `use-evolve-chat`) are rewritten to consume WebSocket events instead of SSE/fetch streams.

**Tech Stack:** `@fastify/websocket` (already installed), `ioredis` (already installed), React 19 hooks, Zustand stores.

---

## File Map

### New Files

| File | Responsibility |
|---|---|
| `packages/core/src/api/ws.ts` | WSManager interface + injection (Multica pattern) |
| `packages/core/src/hooks/use-ws.ts` | `useWSSubscribe()`, `useWSConnected()` React hooks |
| `apps/web/lib/ws-client.ts` | Browser WebSocket implementation with reconnect |
| `apps/api/src/services/ws-publisher.ts` | Topic-based event publisher + Redis pub/sub bridge |

### Modified Files

| File | Change |
|---|---|
| `apps/api/src/plugins/websocket.ts` | Add topic subscription manager, Redis pub/sub bridge, heartbeat |
| `apps/api/src/routes/pipeline.ts` | Replace SSE streaming with `publisher.publish()` (stage exec + chat) |
| `apps/api/src/routes/agents.ts` | Replace SSE streaming with `publisher.publish()` (agent exec + events) |
| `apps/api/src/services/agent-events.ts` | Remove SSE client tracking, use publisher |
| `packages/core/src/hooks/use-stage-execution.ts` | Replace fetch+ReadableStream with WS subscribe |
| `packages/core/src/hooks/use-agent-events.ts` | Replace EventSource with WS subscribe |
| `packages/core/src/hooks/use-evolve-chat.ts` | Replace fetch+ReadableStream with WS subscribe |
| `packages/core/src/index.ts` | Export WS types + injection functions |
| `apps/web/app/providers.tsx` | Register WSManager at boot |

---

### Task 1: WSManager Interface + Injection

**Files:**
- Create: `packages/core/src/api/ws.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create the WSManager interface**

Create `packages/core/src/api/ws.ts`:

```typescript
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
```

- [ ] **Step 2: Add exports to barrel**

In `packages/core/src/index.ts`, add after the Notifications exports:

```typescript
// WebSocket
export { setWSManager, getWSManager } from './api/ws';
export type { WSManager, WSEvent } from './api/ws';
```

- [ ] **Step 3: Verify type-check passes**

Run: `pnpm --filter @revamp/web type-check`
Expected: PASS (no new errors)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/api/ws.ts packages/core/src/index.ts
git commit -m "feat(core): add WSManager interface + injection (Multica pattern)"
```

---

### Task 2: Browser WebSocket Implementation

**Files:**
- Create: `apps/web/lib/ws-client.ts`
- Modify: `apps/web/app/providers.tsx`

- [ ] **Step 1: Create browser WS implementation**

Create `apps/web/lib/ws-client.ts`:

```typescript
import type { WSManager, WSEvent } from '@revamp/core/api/ws';

type Handler = (event: WSEvent) => void;
type ConnectionHandler = (connected: boolean) => void;

/**
 * Browser WebSocket manager with automatic reconnection,
 * topic re-subscription, and outbound message queuing.
 */
export function createBrowserWSManager(): WSManager {
  let ws: WebSocket | null = null;
  let url = '';
  let token = '';
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let intentionalClose = false;

  // Topic → Set<handler>
  const subscriptions = new Map<string, Set<Handler>>();
  // Connection state listeners
  const connectionListeners = new Set<ConnectionHandler>();
  // Queued messages during disconnect
  const messageQueue: string[] = [];

  function setConnected(value: boolean) {
    if (connected === value) return;
    connected = value;
    for (const listener of connectionListeners) {
      try { listener(value); } catch { /* swallow */ }
    }
  }

  function handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);

      // Server ping → respond with pong
      if (msg.event === 'ping') {
        ws?.send(JSON.stringify({ action: 'pong' }));
        return;
      }

      // Snapshot events (sent on reconnect subscription)
      if (msg.event === 'snapshot') {
        const topic = msg.topic as string;
        const handlers = subscriptions.get(topic);
        if (handlers) {
          for (const handler of handlers) {
            try { handler(msg as WSEvent); } catch { /* swallow */ }
          }
        }
        return;
      }

      // Regular topic event
      const topic = msg.topic as string;
      if (!topic) return;

      const handlers = subscriptions.get(topic);
      if (handlers) {
        const event: WSEvent = { topic, event: msg.event, data: msg.data };
        for (const handler of handlers) {
          try { handler(event); } catch { /* swallow */ }
        }
      }
    } catch {
      // Non-JSON message — ignore
    }
  }

  function doConnect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const protocol = url.startsWith('https') ? 'wss' : 'ws';
    const host = url.replace(/^https?:\/\//, '');
    const wsUrl = `${protocol}://${host}/ws?token=${encodeURIComponent(token)}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay = 1000; // Reset backoff

      // Re-subscribe to all active topics
      for (const topic of subscriptions.keys()) {
        ws?.send(JSON.stringify({ action: 'subscribe', topic }));
      }

      // Flush queued messages
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        try { ws?.send(msg); } catch { /* re-queue on next connect */ }
      }

      // Start heartbeat monitoring
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'pong' }));
        }
      }, 30_000);
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        handleMessage(e.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

      if (!intentionalClose) {
        // Reconnect with exponential backoff
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
          doConnect();
        }, reconnectDelay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there
    };
  }

  return {
    connect(serverUrl: string, authToken: string) {
      url = serverUrl;
      token = authToken;
      intentionalClose = false;
      doConnect();
    },

    disconnect() {
      intentionalClose = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (ws) { ws.close(); ws = null; }
      setConnected(false);
    },

    subscribe(topic: string, handler: Handler): () => void {
      if (!subscriptions.has(topic)) {
        subscriptions.set(topic, new Set());
        // Send subscribe message if connected
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'subscribe', topic }));
        }
      }
      subscriptions.get(topic)!.add(handler);

      // Return unsubscribe function
      return () => {
        const handlers = subscriptions.get(topic);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) {
            subscriptions.delete(topic);
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ action: 'unsubscribe', topic }));
            }
          }
        }
      };
    },

    send(message: Record<string, unknown>) {
      const payload = JSON.stringify(message);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else {
        messageQueue.push(payload);
      }
    },

    isConnected: () => connected,

    onConnectionChange(handler: ConnectionHandler): () => void {
      connectionListeners.add(handler);
      return () => { connectionListeners.delete(handler); };
    },
  };
}
```

- [ ] **Step 2: Register WSManager in providers.tsx**

In `apps/web/app/providers.tsx`, add after the existing platform bridge registrations:

```typescript
import { setWSManager } from '@revamp/core/api/ws';
import { createBrowserWSManager } from '@/lib/ws-client';
```

Inside the `if (typeof window !== 'undefined')` block, add:

```typescript
  // WebSocket — connect after auth is available
  const wsManager = createBrowserWSManager();
  setWSManager(wsManager);

  // Auto-connect when auth token is available
  const { useAuthStore } = require('@revamp/core/stores/auth-store');
  const token = useAuthStore.getState().token;
  if (token) {
    const apiUrl = apiClient.getBaseUrl?.() || 'http://localhost:8787';
    wsManager.connect(apiUrl, token);
  }
  // Re-connect on auth changes
  useAuthStore.subscribe((state: any) => {
    if (state.token && state.isAuthenticated) {
      const apiUrl = apiClient.getBaseUrl?.() || 'http://localhost:8787';
      wsManager.connect(apiUrl, state.token);
    } else {
      wsManager.disconnect();
    }
  });
```

- [ ] **Step 3: Verify type-check**

Run: `pnpm --filter @revamp/web type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/ws-client.ts apps/web/app/providers.tsx
git commit -m "feat(web): browser WebSocket client with reconnect + auth integration"
```

---

### Task 3: React Hooks for WebSocket

**Files:**
- Create: `packages/core/src/hooks/use-ws.ts`

- [ ] **Step 1: Create the WS hooks**

Create `packages/core/src/hooks/use-ws.ts`:

```typescript
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
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm --filter @revamp/web type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/hooks/use-ws.ts
git commit -m "feat(core): add useWSSubscribe, useWSConnected, useWSSend hooks"
```

---

### Task 4: Backend Topic Subscription Manager

**Files:**
- Modify: `apps/api/src/plugins/websocket.ts`

- [ ] **Step 1: Rewrite websocket plugin with topic subscriptions**

Replace the entire contents of `apps/api/src/plugins/websocket.ts` with:

```typescript
import { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fp from "fastify-plugin";
import type { WebSocket } from "ws";

// ─── Topic Subscription Manager ─────────────────────────────────

interface ClientMeta {
  userId: string;
  organizationId: string;
  topics: Set<string>;
}

const clients = new Map<WebSocket, ClientMeta>();
const topicSubscribers = new Map<string, Set<WebSocket>>();

/** Get all sockets subscribed to a topic */
export function getTopicSubscribers(topic: string): Set<WebSocket> {
  return topicSubscribers.get(topic) || new Set();
}

/** Publish an event to all subscribers of a topic (local instance only) */
export function publishLocal(topic: string, event: string, data: unknown): void {
  const subs = topicSubscribers.get(topic);
  if (!subs || subs.size === 0) return;

  const payload = JSON.stringify({ topic, event, data });
  for (const socket of subs) {
    try {
      if (socket.readyState === 1) socket.send(payload);
    } catch {
      // Dead socket — will be cleaned up on close
    }
  }
}

/** Subscribe a socket to a topic */
function subscribeTopic(socket: WebSocket, topic: string): void {
  const meta = clients.get(socket);
  if (!meta) return;

  meta.topics.add(topic);
  if (!topicSubscribers.has(topic)) {
    topicSubscribers.set(topic, new Set());
  }
  topicSubscribers.get(topic)!.add(socket);
}

/** Unsubscribe a socket from a topic */
function unsubscribeTopic(socket: WebSocket, topic: string): void {
  const meta = clients.get(socket);
  if (meta) meta.topics.delete(topic);

  const subs = topicSubscribers.get(topic);
  if (subs) {
    subs.delete(socket);
    if (subs.size === 0) topicSubscribers.delete(topic);
  }
}

/** Clean up all subscriptions for a socket */
function cleanupSocket(socket: WebSocket): void {
  const meta = clients.get(socket);
  if (!meta) return;

  for (const topic of meta.topics) {
    const subs = topicSubscribers.get(topic);
    if (subs) {
      subs.delete(socket);
      if (subs.size === 0) topicSubscribers.delete(topic);
    }
  }
  clients.delete(socket);
}

/** Number of connected WS clients */
export function connectedWSClientCount(): number {
  return clients.size;
}

// ─── Legacy compatibility ───────────────────────────────────────
// broadcastToPipeline is still called by some routes during migration.
// It publishes to the pipeline topic using the new system.
export function broadcastToPipeline(pipelineRunId: string, message: Record<string, unknown>): void {
  publishLocal(`pipeline:${pipelineRunId}`, message.type as string || 'update', message);
}

// ─── Plugin ─────────────────────────────────────────────────────

export const websocketPlugin = fp(async function websocketPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyWebsocket, {
    errorHandler: (error, socket) => {
      console.error("WebSocket error:", error);
      socket.destroy();
    },
  });

  // Helper: verify JWT from query param or Authorization header.
  async function verifyWsToken(request: { url: string; headers: Record<string, string | string[] | undefined> }): Promise<{
    sub: string;
    email: string;
    role: string;
    organization_id: string;
  } | null> {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token");
      if (token) {
        return fastify.jwt.verify(token) as any;
      }
      const authHeader = request.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        return fastify.jwt.verify(authHeader.slice(7)) as any;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── Main WebSocket endpoint ────────────────────────────────
  fastify.get("/ws", { websocket: true }, async (socket, request) => {
    const user = await verifyWsToken(request);
    if (!user) {
      socket.send(JSON.stringify({ event: "error", data: { message: "Invalid or missing token" } }));
      socket.close(4001, "Unauthorized");
      return;
    }

    // Register client
    clients.set(socket, {
      userId: user.sub,
      organizationId: user.organization_id,
      topics: new Set(),
    });

    // Handle incoming messages (subscribe/unsubscribe/pong)
    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.action === "subscribe" && typeof msg.topic === "string") {
          subscribeTopic(socket, msg.topic);
          socket.send(JSON.stringify({
            event: "subscribed",
            data: { topic: msg.topic },
          }));
        }

        if (msg.action === "unsubscribe" && typeof msg.topic === "string") {
          unsubscribeTopic(socket, msg.topic);
        }

        if (msg.action === "pong") {
          // Client responded to heartbeat — connection is alive
        }
      } catch {
        // Non-JSON message — ignore
      }
    });

    // Cleanup on disconnect
    socket.on("close", () => {
      cleanupSocket(socket);
    });

    // Send connected confirmation
    socket.send(JSON.stringify({
      event: "connected",
      data: { timestamp: new Date().toISOString() },
    }));
  });

  // ─── Heartbeat ────────────────────────────────────────────
  const heartbeatInterval = setInterval(() => {
    const payload = JSON.stringify({ event: "ping" });
    for (const [socket] of clients) {
      try {
        if (socket.readyState === 1) socket.send(payload);
      } catch {
        // Will be cleaned up on close event
      }
    }
  }, 30_000);

  fastify.addHook("onClose", () => {
    clearInterval(heartbeatInterval);
    for (const [socket] of clients) {
      try { socket.close(); } catch { /* ignore */ }
    }
    clients.clear();
    topicSubscribers.clear();
  });
});
```

- [ ] **Step 2: Verify API type-check**

Run: `pnpm --filter @revamp/api type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/plugins/websocket.ts
git commit -m "feat(api): rewrite websocket plugin with topic subscription manager"
```

---

### Task 5: WSPublisher Service with Redis Pub/Sub

**Files:**
- Create: `apps/api/src/services/ws-publisher.ts`

- [ ] **Step 1: Create the publisher service**

Create `apps/api/src/services/ws-publisher.ts`:

```typescript
/**
 * WebSocket Publisher — broadcasts events to topic subscribers.
 *
 * Two delivery paths:
 * 1. Local: delivers to WebSocket clients on this Fastify instance
 * 2. Redis: publishes to Redis pub/sub for other Fastify instances
 *
 * This enables horizontal scaling — any instance can publish,
 * and all instances with subscribers receive the event.
 */

import Redis from "ioredis";
import { publishLocal } from "@/plugins/websocket.js";

const REDIS_CHANNEL_PREFIX = "ws:";

let pubClient: Redis | null = null;
let subClient: Redis | null = null;

/**
 * Initialize Redis pub/sub for cross-instance event delivery.
 * Call once at server startup. If Redis is unavailable,
 * falls back to local-only delivery (single-instance mode).
 */
export function initWSPublisher(): void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log("[WSPublisher] No REDIS_URL — running in local-only mode");
    return;
  }

  try {
    pubClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });

    subClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });

    // Subscribe to all ws: channels using pattern subscription
    subClient.psubscribe(`${REDIS_CHANNEL_PREFIX}*`).catch((err) => {
      console.warn("[WSPublisher] Redis psubscribe failed:", err.message);
    });

    // When a message arrives from Redis, deliver to local WS clients
    subClient.on("pmessage", (_pattern: string, channel: string, message: string) => {
      const topic = channel.slice(REDIS_CHANNEL_PREFIX.length);
      try {
        const parsed = JSON.parse(message);
        publishLocal(topic, parsed.event, parsed.data);
      } catch {
        // Malformed message — skip
      }
    });

    pubClient.on("error", (err) => {
      console.warn("[WSPublisher] Redis pub client error:", err.message);
    });

    subClient.on("error", (err) => {
      console.warn("[WSPublisher] Redis sub client error:", err.message);
    });

    console.log("[WSPublisher] Redis pub/sub initialized");
  } catch (err) {
    console.warn("[WSPublisher] Redis init failed, running local-only:", err instanceof Error ? err.message : err);
  }
}

/**
 * Publish an event to a topic.
 * Delivers to local WebSocket clients AND publishes to Redis for other instances.
 */
export function publish(topic: string, event: string, data: unknown): void {
  // 1. Local delivery
  publishLocal(topic, event, data);

  // 2. Redis pub/sub (cross-instance)
  if (pubClient) {
    const channel = `${REDIS_CHANNEL_PREFIX}${topic}`;
    const payload = JSON.stringify({ event, data });
    pubClient.publish(channel, payload).catch(() => {
      // Non-fatal — local delivery still worked
    });
  }
}

/**
 * Shutdown pub/sub connections gracefully.
 */
export async function shutdownWSPublisher(): Promise<void> {
  if (subClient) {
    try { await subClient.punsubscribe(); } catch { /* ignore */ }
    subClient.disconnect();
    subClient = null;
  }
  if (pubClient) {
    pubClient.disconnect();
    pubClient = null;
  }
}
```

- [ ] **Step 2: Initialize publisher in server.ts**

In `apps/api/src/server.ts`, add import:

```typescript
import { initWSPublisher, shutdownWSPublisher } from "@/services/ws-publisher.js";
```

After `await fastify.register(websocketPlugin);`, add:

```typescript
  // Initialize WebSocket pub/sub for cross-instance event delivery
  initWSPublisher();
```

In the shutdown handler (find `fastify.addHook('onClose'` or the graceful shutdown section), add:

```typescript
  await shutdownWSPublisher();
```

- [ ] **Step 3: Verify API type-check**

Run: `pnpm --filter @revamp/api type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/ws-publisher.ts apps/api/src/server.ts
git commit -m "feat(api): add WSPublisher service with Redis pub/sub bridge"
```

---

### Task 6: Migrate Pipeline Stage Execution (Backend)

**Files:**
- Modify: `apps/api/src/routes/pipeline.ts`

This is the largest SSE endpoint (~370 lines). The route changes from returning an SSE stream to returning a normal JSON response while publishing events via WebSocket.

- [ ] **Step 1: Add publisher import**

At the top of `apps/api/src/routes/pipeline.ts`, add:

```typescript
import { publish } from "@/services/ws-publisher.js";
```

- [ ] **Step 2: Replace the stage execution route handler**

Find the POST route for `/pipeline/:pipelineRunId/stage/:stage` (around line 562). Replace the route's schema and handler.

Change the schema response from SSE to JSON:

```typescript
response: {
  200: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      stageName: { type: "string" },
      output: { type: "string" },
      validation: { type: "object", additionalProperties: true },
      duration: { type: "number" },
    },
    additionalProperties: true,
  },
  ...errorResponse,
},
```

Update the summary and description:

```typescript
summary: "Execute a pipeline stage (events via WebSocket)",
description: "Executes the specified stage. Progress events are pushed to WebSocket topic 'pipeline:<runId>'. Subscribe to the topic before calling this endpoint.",
```

Replace the handler body. Remove ALL SSE code (reply.raw.writeHead, sendSSE, keepalive interval, reply.raw.end). Replace with:

```typescript
async (request, reply) => {
  const { pipelineRunId, stage } = request.params;

  if (!validStageNames.includes(stage as PipelineStageName)) {
    return reply.status(400).send({
      error: `Invalid stage: ${stage}. Valid: ${validStageNames.join(", ")}`,
    });
  }

  const stageName = stage as PipelineStageName;
  const body = ExecuteStageSchema.safeParse(request.body || {});
  const templateVars = body.success ? (body.data.template_vars || {}) : {};

  // Verify execution lock (same as before)
  const lockAcquired = await acquireStageLock(pipelineRunId, stageName);
  if (!lockAcquired.ok) {
    return reply.status((lockAcquired as any).code || 409).send({ error: (lockAcquired as any).error });
  }

  // Prevent socket timeouts during long LLM calls
  request.raw.socket.setTimeout(0);
  request.raw.socket.setKeepAlive(true, 30_000);

  const topic = `pipeline:${pipelineRunId}`;
  let accumulatedOutput = "";

  // Stage timeout (30 minutes)
  const timeoutMs = 30 * 60 * 1000;
  const controller = new AbortController();
  const stageTimeout = setTimeout(() => {
    controller.abort();
    publish(topic, "error", { message: "Stage execution timed out after 30 minutes" });
  }, timeoutMs);

  request.raw.on("close", () => {
    controller.abort();
    clearTimeout(stageTimeout);
  });

  try {
    const result = await pipelineService.executeStage(
      pipelineRunId,
      stageName,
      templateVars,
      {
        onEvent: (event) => {
          // Trajectory events get their own event type
          if (event.phase === 'context_retrieval' && event.data?.trajectory) {
            publish(topic, "trajectory", {
              stagesUsed: event.data.trajectory.stagesUsed,
              totalChars: event.data.trajectory.totalChars,
              strategy: event.data.trajectory.strategy,
            });
            return;
          }

          publish(topic, "phase", {
            phase: event.phase,
            stageName: event.stageName,
            stageIndex: event.stageIndex,
            timestamp: event.timestamp,
            data: event.data,
          });
        },
        onDelta: (text) => {
          accumulatedOutput += text;
          publish(topic, "delta", { text });
        },
        signal: controller.signal,
        skipLlmEval: body.success ? body.data.skip_llm_eval : false,
        model: body.success ? body.data.model : undefined,
        composerModel: body.success ? body.data.composer_model : undefined,
        evaluatorModel: body.success ? body.data.evaluator_model : undefined,
        promptOverride: body.success ? body.data.prompt_override : undefined,
        validationFeedback: body.success ? body.data.validation_feedback : undefined,
        maxTokens: body.success ? body.data.max_tokens : undefined,
      },
    );

    clearTimeout(stageTimeout);

    // Publish validation events
    if (result.validation) {
      publish(topic, "validation", {
        passed: result.validation.passed,
        confidenceScore: result.validation.confidenceScore,
      });

      // Stream individual validation findings
      const criteria = result.validation.criteria || result.validation.deterministicResults || [];
      for (const finding of criteria) {
        publish(topic, "validation_finding", finding);
      }

      publish(topic, "validation_result", {
        passed: result.validation.passed,
        confidenceScore: result.validation.confidenceScore,
        criteria,
        summary: result.validation.summary || "",
      });
    }

    // Publish completion
    publish(topic, "complete", {
      stageName,
      output: result.output?.slice(0, 200),
      outputLength: result.output?.length || 0,
      validation: result.validation ? {
        passed: result.validation.passed,
        confidenceScore: result.validation.confidenceScore,
      } : null,
      duration: result.duration,
      refinementCount: result.refinementCount,
    });

    // Notify scoped WebSocket subscribers (legacy broadcastToPipeline)
    broadcastToPipeline(pipelineRunId, {
      type: "stage_completed",
      stage: stageName,
      timestamp: new Date().toISOString(),
    });

    return reply.status(200).send({
      success: true,
      stageName: result.stageName,
      output: result.output ? `${result.output.length} chars generated` : null,
      validation: result.validation ? {
        passed: result.validation.passed,
        confidenceScore: result.validation.confidenceScore,
      } : null,
      duration: result.duration,
      refinementCount: result.refinementCount,
    });
  } catch (err) {
    clearTimeout(stageTimeout);

    const isAbort = err instanceof Error && (err.message === "Stage execution aborted" || err.name === "AbortError");
    if (isAbort) {
      publish(topic, "error", { message: "Stage execution aborted", aborted: true });
      return reply.status(499).send({ error: "Aborted" });
    }

    const message = err instanceof Error ? err.message : "Stage execution failed";
    publish(topic, "error", { message, stageName });
    return reply.status(500).send({ error: message });
  }
},
```

- [ ] **Step 3: Verify API type-check**

Run: `pnpm --filter @revamp/api type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/pipeline.ts
git commit -m "feat(api): migrate pipeline stage execution from SSE to WebSocket publisher"
```

---

### Task 7: Migrate Evolve Chat (Backend)

**Files:**
- Modify: `apps/api/src/routes/pipeline.ts`

- [ ] **Step 1: Replace the chat route handler**

Find the POST route for `/pipeline/:pipelineRunId/chat` (around line 1536). Replace the schema response and handler.

Change schema:

```typescript
summary: "Interactive chat for Evolve stage (events via WebSocket)",
description: "Sends a message and streams the response via WebSocket topic 'chat:<runId>:EVOLVE'. Subscribe before calling.",
response: {
  200: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      content: { type: "string" },
    },
    additionalProperties: true,
  },
  ...errorResponse,
},
```

Replace the handler:

```typescript
async (request, reply) => {
  const { pipelineRunId } = request.params;
  const validation = ChatMessageSchema.safeParse(request.body);
  if (!validation.success) {
    return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
  }

  const run = await pipelineService.getPipelineRun(pipelineRunId);
  if (!run) {
    return reply.status(404).send({ error: "Pipeline run not found" });
  }

  const topic = `chat:${pipelineRunId}:EVOLVE`;
  const controller = new AbortController();
  request.raw.on("close", () => controller.abort());

  try {
    const content = await pipelineService.chat(
      pipelineRunId,
      validation.data.message,
      validation.data.history,
      (deltaText: string) => {
        publish(topic, "delta", { text: deltaText });
      },
      controller.signal,
    );

    publish(topic, "complete", { content });
    return reply.status(200).send({ success: true, content });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return reply.status(499).send({ error: "Aborted" });
    }
    const message = err instanceof Error ? err.message : "Chat failed";
    publish(topic, "error", { message });
    return reply.status(500).send({ error: message });
  }
},
```

- [ ] **Step 2: Verify API type-check**

Run: `pnpm --filter @revamp/api type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/pipeline.ts
git commit -m "feat(api): migrate evolve chat from SSE to WebSocket publisher"
```

---

### Task 8: Migrate Agent Events (Backend)

**Files:**
- Modify: `apps/api/src/services/agent-events.ts`
- Modify: `apps/api/src/routes/agents.ts`

- [ ] **Step 1: Remove SSE from agent-events.ts**

In `apps/api/src/services/agent-events.ts`, remove the entire SSE client tracking:
- Remove the `SSEClient` interface
- Remove the `sseClients` Set
- Remove `addSSEClient` and `removeSSEClient` functions
- In the `broadcast()` function, remove the SSE client loop
- In the `broadcastToAgent()` function, remove the SSE client loop

Replace `broadcast()` to also publish via WS publisher:

```typescript
import { publish } from "@/services/ws-publisher.js";

/** Broadcast an event to ALL connected clients (WebSocket + WS Publisher). */
export function broadcast(event: AgentEvent): void {
  const payload = JSON.stringify(event);

  // WebSocket clients (direct, for agent-department WS route)
  for (const client of clients) {
    safeSend(client, payload, event.agentId);
  }

  // WS Publisher (topic-based, for general subscribers)
  publish("agent:events", event.eventType, event);
  publish(`agent:${event.agentId}`, event.eventType, event);
}
```

Update `broadcastToAgent()` similarly.

- [ ] **Step 2: Remove SSE event stream routes from agents.ts**

In `apps/api/src/routes/agents.ts`, find and remove the SSE endpoints:
- The `/agents/events` SSE endpoint (around line 960-1015)
- The `/agents/:id/events` SSE endpoint (around line 1030-1055)
- The SSE streaming in the agent tool execution route (around line 218-240 and 379-547)

For the agent tool execution routes, replace SSE with WebSocket publishing (same pattern as pipeline):

```typescript
import { publish } from "@/services/ws-publisher.js";
```

Replace `reply.raw.writeHead` + `sendSSE` patterns with `publish("agent:<agentId>", event, data)`.

- [ ] **Step 3: Verify API type-check**

Run: `pnpm --filter @revamp/api type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/agent-events.ts apps/api/src/routes/agents.ts
git commit -m "feat(api): migrate agent events from SSE to WebSocket publisher"
```

---

### Task 9: Migrate use-stage-execution (Frontend)

**Files:**
- Modify: `packages/core/src/hooks/use-stage-execution.ts`

- [ ] **Step 1: Rewrite to use WebSocket subscription**

The `handleSSEEvent` function (lines 221-520) stays exactly as-is — it's the event dispatcher that updates stores. Only the transport changes.

Replace the `fetch()` + `ReadableStream` block with:
1. HTTP POST to start execution (fire and forget, no streaming response)
2. `getWSManager().subscribe('pipeline:' + runId)` to receive events

Key changes in `executeStage`:

```typescript
import { getWSManager } from '../api/ws';

// ... inside executeStage callback:

// 1. Subscribe to pipeline events BEFORE starting execution
const topic = `pipeline:${pipelineRunId}`;
const unsubscribe = getWSManager().subscribe(topic, (wsEvent) => {
  // Map WS event to the existing handleSSEEvent format
  const event = { type: wsEvent.event, data: wsEvent.data };
  
  if (wsEvent.event === 'delta') {
    store.getState().appendStreamingText((wsEvent.data as any)?.text ?? '');
  } else if (wsEvent.event === 'complete' || wsEvent.event === 'stage_completed') {
    handleSSEEvent({ type: 'completed', data: wsEvent.data }, stageName, stageIndex);
    cleanup();
  } else if (wsEvent.event === 'error') {
    const msg = (wsEvent.data as any)?.message ?? 'Stage execution failed';
    if (stageIndex >= 0) {
      store.getState().setStageStatus(stageIndex, 'failed');
      activityStore.getState().addLog({ type: 'error', message: msg, timestamp: new Date().toISOString() });
      flashError(stageName, msg);
    }
    cleanup();
  } else {
    handleSSEEvent(event, stageName, stageIndex);
  }
});

function cleanup() {
  unsubscribe();
  isExecutingRef.current = false;
  setIsExecuting(false);
  setCurrentPhase(null);
}

// 2. HTTP POST to start execution (no streaming response)
const authToken = useAuthStore.getState().token;
fetch(`${getBaseUrl()}/pipeline/${pipelineRunId}/stage/${stageName}`, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  },
  body: JSON.stringify({
    skip_llm_eval: options.skipLlmEval ?? false,
    ...(options.model ? { model: options.model } : {}),
    ...(options.composerModel ? { composer_model: options.composerModel } : {}),
    ...(options.evaluatorModel ? { evaluator_model: options.evaluatorModel } : {}),
    ...(options.promptOverride ? { prompt_override: options.promptOverride } : {}),
    ...(options.validationFeedback?.length ? { validation_feedback: options.validationFeedback } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
  }),
  signal: controller.signal,
}).then(async (res) => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  // Response is just a confirmation — events come via WebSocket
}).catch((err) => {
  if (err.name === 'AbortError') {
    cleanup();
    return;
  }
  const msg = err.message ?? 'Stage execution failed';
  if (stageIndex >= 0) {
    store.getState().setStageStatus(stageIndex, 'failed');
    activityStore.getState().addLog({ type: 'error', message: msg, timestamp: new Date().toISOString() });
    flashError(stageName, msg);
  }
  cleanup();
});
```

Remove all `ReadableStream`, `TextDecoder`, `processChunk`, `buffer` logic.

- [ ] **Step 2: Verify web type-check**

Run: `pnpm --filter @revamp/web type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/hooks/use-stage-execution.ts
git commit -m "feat(core): migrate use-stage-execution from SSE to WebSocket"
```

---

### Task 10: Migrate use-agent-events (Frontend)

**Files:**
- Modify: `packages/core/src/hooks/use-agent-events.ts`

- [ ] **Step 1: Rewrite to use WebSocket subscription**

Replace the entire hook. Remove all EventSource code:

```typescript
import { useState, useEffect, useRef } from 'react';
import { getWSManager } from '../api/ws';
import type { WSEvent } from '../api/ws';

// ─── Types ─────────────────────────────────────────────────────────

export type AgentEventType =
  | 'agent.task_started'
  | 'agent.task_assigned'
  | 'agent.task_completed'
  | 'agent.task_failed'
  | 'agent.task_escalated'
  | 'agent.budget_warning'
  | 'agent.budget_exceeded'
  | 'agent.status_changed'
  | 'agent.memory_updated'
  | 'agent.delegated'
  | 'agent.message'
  | 'agent.error';

export interface AgentEvent {
  id: string;
  agentId: string;
  agentName: string;
  eventType: AgentEventType;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface UseAgentEventsOptions {
  maxEvents?: number;
  agentId?: string;
}

export interface UseAgentEventsReturn {
  events: AgentEvent[];
  lastEvent: AgentEvent | null;
  isConnected: boolean;
  connected: boolean;
}

// ─── Hook ──────────────────────────────────────────────────────────

export function useAgentEvents(
  agentIdOrOptions?: string | UseAgentEventsOptions,
  options?: UseAgentEventsOptions,
): UseAgentEventsReturn {
  let agentId: string | undefined;
  let opts: UseAgentEventsOptions = {};

  if (typeof agentIdOrOptions === 'string') {
    agentId = agentIdOrOptions;
    opts = options ?? {};
  } else if (agentIdOrOptions && typeof agentIdOrOptions === 'object') {
    opts = agentIdOrOptions;
    agentId = agentIdOrOptions.agentId;
  }

  const maxEvents = opts.maxEvents ?? 50;

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<AgentEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Subscribe to agent topic via WebSocket
    const topic = agentId ? `agent:${agentId}` : 'agent:events';

    const unsubscribe = getWSManager().subscribe(topic, (wsEvent: WSEvent) => {
      if (!mountedRef.current) return;

      const raw = wsEvent.data as Record<string, unknown>;
      const agentEvent: AgentEvent = {
        id: (raw.id as string) ?? crypto.randomUUID(),
        agentId: (raw.agentId as string) ?? (raw.agent_id as string) ?? '',
        agentName: (raw.agentName as string) ?? (raw.agent_name as string) ?? 'Agent',
        eventType: (wsEvent.event as AgentEventType) ?? (raw.eventType as AgentEventType) ?? 'agent.message',
        data: (raw.data as Record<string, unknown>) ?? raw,
        timestamp: (raw.timestamp as string) ?? new Date().toISOString(),
      };

      setEvents((prev) => [agentEvent, ...prev].slice(0, maxEvents));
      setLastEvent(agentEvent);
    });

    // Track connection state
    const unsubConn = getWSManager().onConnectionChange((connected) => {
      if (mountedRef.current) setIsConnected(connected);
    });
    setIsConnected(getWSManager().isConnected());

    return () => {
      mountedRef.current = false;
      unsubscribe();
      unsubConn();
    };
  }, [agentId, maxEvents]);

  return { events, lastEvent, isConnected, connected: isConnected };
}
```

- [ ] **Step 2: Verify web type-check**

Run: `pnpm --filter @revamp/web type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/hooks/use-agent-events.ts
git commit -m "feat(core): migrate use-agent-events from EventSource to WebSocket"
```

---

### Task 11: Migrate use-evolve-chat (Frontend)

**Files:**
- Modify: `packages/core/src/hooks/use-evolve-chat.ts`

- [ ] **Step 1: Rewrite to use WebSocket subscription**

```typescript
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

  // Subscribe to chat topic when streaming
  useEffect(() => {
    return () => {
      // Cleanup on unmount
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
          throw new Error(body.error || `Chat failed: ${response.status}`);
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
```

- [ ] **Step 2: Verify web type-check**

Run: `pnpm --filter @revamp/web type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/hooks/use-evolve-chat.ts
git commit -m "feat(core): migrate use-evolve-chat from SSE to WebSocket"
```

---

### Task 12: Delete Dead SSE Code + Final Verification

**Files:**
- Modify: `apps/api/src/routes/agents.ts` (remove SSE event stream routes)
- Modify: `apps/api/src/routes/pipeline.ts` (remove any remaining SSE imports/helpers)

- [ ] **Step 1: Remove SSE event stream endpoints from agents.ts**

In `apps/api/src/routes/agents.ts`, delete the SSE-based `/agents/events` and `/agents/:id/events` endpoint handlers that use `reply.raw.writeHead("text/event-stream")`. These are replaced by the WebSocket topic subscriptions (`agent:events` and `agent:<id>`).

Also remove any imports of `addSSEClient` / `removeSSEClient` from agent-events.ts.

- [ ] **Step 2: Clean up pipeline.ts**

Remove any dead SSE helper functions or imports that are no longer used after the route rewrites in Tasks 6 and 7.

- [ ] **Step 3: Full type-check both apps**

Run: `pnpm --filter @revamp/api type-check && pnpm --filter @revamp/web type-check`
Expected: Both PASS with zero errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents.ts apps/api/src/routes/pipeline.ts
git commit -m "chore: remove dead SSE code from agents and pipeline routes"
```

- [ ] **Step 5: Add connection indicator to TopBar**

In `apps/web/components/layout/top-bar.tsx`, add a small connection status dot. Import the hook:

```typescript
import { useWSConnected } from '@revamp/core/hooks/use-ws';
```

Inside the TopBar component, add:

```typescript
const wsConnected = useWSConnected();
```

Render a dot near the right side of the TopBar:

```tsx
<span
  className={cn(
    'w-2 h-2 rounded-full',
    wsConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse',
  )}
  title={wsConnected ? 'Connected' : 'Disconnected — reconnecting...'}
/>
```

- [ ] **Step 6: Final integration smoke test**

1. Start all servers: `pnpm dev`
2. Open http://localhost:3001 — login
3. Open browser DevTools → Network → WS tab → verify single WebSocket connection to `/ws`
4. Navigate to a project → Pipeline → execute a stage
5. Verify: events appear in real-time (delta text streaming, phase updates, validation results)
6. Open the Agent Orchestrator view → verify agent events flow
7. Test page refresh → verify WebSocket reconnects and re-subscribes

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete WebSocket migration Phase 1 — all SSE replaced with topic-based WebSocket"
```
