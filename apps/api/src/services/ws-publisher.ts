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
