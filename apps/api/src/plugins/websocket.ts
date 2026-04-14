import { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fp from "fastify-plugin";
import type { WebSocket } from "@fastify/websocket";

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
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
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
