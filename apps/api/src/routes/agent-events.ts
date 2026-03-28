/**
 * Agent Events WebSocket Route — real-time event stream for the Agent Department.
 *
 * Endpoint:
 *   GET /agent-department/events  — WebSocket upgrade
 *
 * Protocol:
 *   Client -> Server:
 *     { "subscribe": "agent:<agentId>" }     — subscribe to a specific agent
 *     { "unsubscribe": "agent:<agentId>" }   — unsubscribe from an agent
 *
 *   Server -> Client:
 *     { "type": "connected", "timestamp": "..." }                  — on connect
 *     { "eventType": "agent.task_assigned", "agentId": "...", ... } — event
 */

import { FastifyInstance } from "fastify";
import {
  addClient,
  removeClient,
  subscribeToAgent,
  unsubscribeFromAgent,
  connectedClientCount,
} from "@/services/agent-events.js";

// ─── ROUTE ───────────────────────────────────────────────────

export async function agentEventsRoutes(fastify: FastifyInstance) {
  /**
   * GET /agent-department/events — WebSocket upgrade for real-time agent events.
   */
  fastify.get("/agent-department/events", { websocket: true }, (socket, request) => {
    const client = addClient(socket);

    fastify.log.info(
      `Agent events WS connected (total: ${connectedClientCount()})`,
    );

    // Send initial connection confirmation
    socket.send(
      JSON.stringify({
        type: "connected",
        timestamp: new Date().toISOString(),
        message: "Connected to agent events stream",
      }),
    );

    // Handle incoming subscription messages
    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Subscribe: { "subscribe": "agent:abc-123" }
        if (typeof msg.subscribe === "string") {
          const match = msg.subscribe.match(/^agent:(.+)$/);
          if (match) {
            const agentId = match[1];
            subscribeToAgent(client, agentId);
            socket.send(
              JSON.stringify({
                type: "subscribed",
                agentId,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }

        // Unsubscribe: { "unsubscribe": "agent:abc-123" }
        if (typeof msg.unsubscribe === "string") {
          const match = msg.unsubscribe.match(/^agent:(.+)$/);
          if (match) {
            const agentId = match[1];
            unsubscribeFromAgent(client, agentId);
            socket.send(
              JSON.stringify({
                type: "unsubscribed",
                agentId,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Clean up on disconnect
    socket.on("close", () => {
      removeClient(client);
      fastify.log.info(
        `Agent events WS disconnected (total: ${connectedClientCount()})`,
      );
    });

    socket.on("error", (err: Error) => {
      fastify.log.error(`Agent events WS error: ${err.message}`);
      removeClient(client);
    });
  });
}
