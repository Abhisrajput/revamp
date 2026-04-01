/**
 * Agent Events Service — broadcasts real-time WebSocket events for the Agent Department.
 *
 * Follows the same patterns as agent-department.ts: non-fatal error handling,
 * structured event payloads, and clean separation from persistence logic.
 *
 * Event flow:
 *   1. Service functions in agent-department.ts call emit* helpers after mutations.
 *   2. This module serialises the event and pushes it to all connected WS clients.
 *   3. Per-agent subscriptions allow the frontend to filter noise.
 */

// Use a minimal interface instead of importing 'ws' directly.
// @fastify/websocket wraps the 'ws' library and provides the socket,
// but we only need send() and readyState for broadcasting.
interface MinimalWebSocket {
  send(data: string): void;
  readyState: number;
  readonly OPEN: number;
}

// ─── EVENT TYPES ─────────────────────────────────────────────

export type AgentEventType =
  | "agent.status_changed"
  | "agent.task_assigned"
  | "agent.task_started"
  | "agent.task_completed"
  | "agent.task_failed"
  | "agent.task_escalated"
  | "agent.budget_warning"
  | "agent.budget_exceeded";

export interface AgentEvent {
  eventType: AgentEventType;
  agentId: string;
  agentName: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// ─── CLIENT TRACKING ─────────────────────────────────────────

interface TrackedClient {
  socket: MinimalWebSocket;
  /** Agent IDs this client is subscribed to. Empty = receive all events. */
  subscriptions: Set<string>;
}

const clients = new Set<TrackedClient>();

// ─── SSE CLIENT TRACKING ────────────────────────────────────

/** SSE client that receives events via HTTP text/event-stream. */
export interface SSEClient {
  /** Write function bound to the response stream. */
  write: (data: string) => boolean;
  /** Agent ID filter. Empty string = receive all events. */
  agentFilter: string;
}

const sseClients = new Set<SSEClient>();

/** Register an SSE client for agent events. */
export function addSSEClient(client: SSEClient): void {
  sseClients.add(client);
}

/** Remove an SSE client on disconnect. */
export function removeSSEClient(client: SSEClient): void {
  sseClients.delete(client);
}

// ─── PUBLIC API ──────────────────────────────────────────────

/**
 * Register a new WebSocket connection for agent events.
 * Returns the tracked-client handle so the route can manage subscriptions.
 */
export function addClient(socket: MinimalWebSocket): TrackedClient {
  const client: TrackedClient = { socket, subscriptions: new Set() };
  clients.add(client);
  return client;
}

/** Remove a client on disconnect. */
export function removeClient(client: TrackedClient): void {
  clients.delete(client);
}

/** Subscribe a client to a specific agent's events. */
export function subscribeToAgent(client: TrackedClient, agentId: string): void {
  client.subscriptions.add(agentId);
}

/** Unsubscribe a client from a specific agent's events. */
export function unsubscribeFromAgent(client: TrackedClient, agentId: string): void {
  client.subscriptions.delete(agentId);
}

/** Broadcast an event to ALL connected clients (WebSocket + SSE). */
export function broadcast(event: AgentEvent): void {
  const payload = JSON.stringify(event);

  // WebSocket clients
  for (const client of clients) {
    safeSend(client, payload, event.agentId);
  }

  // SSE clients
  const ssePayload = `data: ${payload}\n\n`;
  for (const sse of sseClients) {
    try {
      if (sse.agentFilter === "" || sse.agentFilter === event.agentId) {
        sse.write(ssePayload);
      }
    } catch {
      sseClients.delete(sse);
    }
  }
}

/** Broadcast an event only to clients subscribed to a specific agent. */
export function broadcastToAgent(agentId: string, event: AgentEvent): void {
  const payload = JSON.stringify(event);

  // WebSocket clients
  for (const client of clients) {
    if (client.subscriptions.has(agentId)) {
      safeSend(client, payload, agentId);
    }
  }

  // SSE clients filtered to this agent
  const ssePayload = `data: ${payload}\n\n`;
  for (const sse of sseClients) {
    try {
      if (sse.agentFilter === agentId) {
        sse.write(ssePayload);
      }
    } catch {
      sseClients.delete(sse);
    }
  }
}

/** Number of currently connected clients (useful for health checks). */
export function connectedClientCount(): number {
  return clients.size + sseClients.size;
}

// ─── EMIT HELPERS ────────────────────────────────────────────
// Convenience wrappers called from agent-department.ts after mutations.

export function emitTaskAssigned(params: {
  agentId: string;
  agentName: string;
  assignmentId: string;
  pipelineRunId: string;
  stageName: string;
  matchScore?: number;
}): void {
  broadcast({
    eventType: "agent.task_assigned",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      assignmentId: params.assignmentId,
      pipelineRunId: params.pipelineRunId,
      stageName: params.stageName,
      matchScore: params.matchScore,
    },
  });
}

export function emitTaskStarted(params: {
  agentId: string;
  agentName: string;
  assignmentId: string;
  runId: string;
}): void {
  broadcast({
    eventType: "agent.task_started",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      assignmentId: params.assignmentId,
      runId: params.runId,
    },
  });
}

export function emitTaskCompleted(params: {
  agentId: string;
  agentName: string;
  assignmentId: string;
  costCents: number;
  tokensUsed: number;
  refinementCount: number;
}): void {
  broadcast({
    eventType: "agent.task_completed",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      assignmentId: params.assignmentId,
      costCents: params.costCents,
      tokensUsed: params.tokensUsed,
      refinementCount: params.refinementCount,
    },
  });
}

export function emitTaskFailed(params: {
  agentId: string;
  agentName: string;
  assignmentId: string;
  error: string;
}): void {
  broadcast({
    eventType: "agent.task_failed",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      assignmentId: params.assignmentId,
      error: params.error,
    },
  });
}

export function emitTaskEscalated(params: {
  agentId: string;
  agentName: string;
  assignmentId: string;
  reason: string;
}): void {
  broadcast({
    eventType: "agent.task_escalated",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      assignmentId: params.assignmentId,
      reason: params.reason,
    },
  });
}

export function emitStatusChanged(params: {
  agentId: string;
  agentName: string;
  previousStatus?: string;
  newStatus: string;
  reason?: string;
}): void {
  broadcast({
    eventType: "agent.status_changed",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      previousStatus: params.previousStatus,
      newStatus: params.newStatus,
      reason: params.reason,
    },
  });
}

export function emitBudgetWarning(params: {
  agentId: string;
  agentName: string;
  spentCents: number;
  limitCents: number;
  percentUsed: number;
}): void {
  broadcast({
    eventType: "agent.budget_warning",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      spentCents: params.spentCents,
      limitCents: params.limitCents,
      percentUsed: params.percentUsed,
    },
  });
}

export function emitBudgetExceeded(params: {
  agentId: string;
  agentName: string;
  spentCents: number;
  limitCents: number;
}): void {
  broadcast({
    eventType: "agent.budget_exceeded",
    agentId: params.agentId,
    agentName: params.agentName,
    timestamp: new Date().toISOString(),
    data: {
      spentCents: params.spentCents,
      limitCents: params.limitCents,
    },
  });
}

// ─── INTERNAL HELPERS ────────────────────────────────────────

function safeSend(client: TrackedClient, payload: string, agentId: string): void {
  try {
    // If client has subscriptions, only send if this agent is in the set.
    // If subscriptions are empty, send everything (broadcast mode).
    if (client.subscriptions.size > 0 && !client.subscriptions.has(agentId)) {
      return;
    }

    // readyState 1 = OPEN (matching the ws library constant)
    if (client.socket.readyState === 1) {
      client.socket.send(payload);
    }
  } catch {
    // Never let a single broken connection disrupt the broadcast loop
  }
}
