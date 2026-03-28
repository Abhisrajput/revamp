import { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fp from "fastify-plugin";

// ─── Per-connection metadata ─────────────────────────────────────

// Use a WeakMap to attach metadata to socket instances without extending the type.
const socketMeta = new WeakMap<object, {
  userId?: string;
  organizationId?: string;
  pipelineRunId?: string;
}>();

function getMeta(socket: object) {
  let meta = socketMeta.get(socket);
  if (!meta) { meta = {}; socketMeta.set(socket, meta); }
  return meta;
}

// Track pipeline-scoped connections so broadcasts only reach authorized clients.
const pipelineClients = new Map<string, Set<object>>();

/**
 * Broadcast a message only to clients subscribed to a specific pipeline run.
 * Falls back to no-op if nobody is listening.
 */
export function broadcastToPipeline(pipelineRunId: string, message: Record<string, unknown>) {
  const clients = pipelineClients.get(pipelineRunId);
  if (!clients) return;
  const payload = JSON.stringify(message);
  for (const socket of clients) {
    try {
      const ws = socket as any;
      if (ws.readyState === 1) ws.send(payload);
    } catch { /* client gone */ }
  }
}

export const websocketPlugin = fp(async function websocketPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyWebsocket, {
    errorHandler: (error, socket) => {
      console.error("WebSocket error:", error);
      socket.destroy();
    },
  });

  // Helper: verify JWT from query param or Authorization header.
  // Returns decoded payload or null.
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

  // General WebSocket endpoint for real-time notifications
  fastify.get("/ws", { websocket: true }, async (socket, request) => {
    const user = await verifyWsToken(request);
    if (!user) {
      socket.send(JSON.stringify({ type: "error", message: "Invalid or missing token" }));
      socket.close(4001, "Unauthorized");
      return;
    }

    const meta = getMeta(socket);
    meta.userId = user.sub;
    meta.organizationId = user.organization_id;

    socket.on("close", () => {
      // Connection cleaned up automatically
    });

    socket.send(
      JSON.stringify({
        type: "connected",
        timestamp: new Date().toISOString(),
      })
    );
  });

  // WebSocket route for pipeline events — scoped to a specific pipeline run.
  // Only allows connection if the user owns the pipeline's project.
  fastify.get("/ws/pipeline/:pipelineRunId", { websocket: true }, async (socket, request) => {
    const { pipelineRunId } = request.params as { pipelineRunId: string };

    const user = await verifyWsToken(request);
    if (!user) {
      socket.send(JSON.stringify({ type: "error", message: "Invalid or missing token" }));
      socket.close(4001, "Unauthorized");
      return;
    }

    // Verify user has access to this pipeline's project
    try {
      const { db } = await import("@/db/index.js");
      const { pipelineRuns, projectMembers, projects } = await import("@/db/schema.js");
      const { eq, and } = await import("drizzle-orm");

      const run = await db.query.pipelineRuns.findFirst({
        where: eq(pipelineRuns.id, pipelineRunId),
        columns: { project_id: true },
      });

      if (!run) {
        socket.send(JSON.stringify({ type: "error", message: "Pipeline run not found" }));
        socket.close(4004, "Not found");
        return;
      }

      // Check project membership (admins bypass)
      if (user.role !== "admin") {
        const project = await db.query.projects.findFirst({
          where: eq(projects.id, run.project_id),
          columns: { organization_id: true, visibility: true },
        });

        if (!project) {
          socket.send(JSON.stringify({ type: "error", message: "Project not found" }));
          socket.close(4004, "Not found");
          return;
        }

        const isSameOrg = project.organization_id === user.organization_id;
        const isMember = await db.query.projectMembers.findFirst({
          where: and(
            eq(projectMembers.project_id, run.project_id),
            eq(projectMembers.user_id, user.sub),
          ),
        });

        if (!isSameOrg && !isMember && project.visibility === "private") {
          socket.send(JSON.stringify({ type: "error", message: "Access denied" }));
          socket.close(4003, "Forbidden");
          return;
        }
      }
    } catch (error) {
      console.error("WebSocket auth check failed:", error);
      socket.send(JSON.stringify({ type: "error", message: "Authorization check failed" }));
      socket.close(4500, "Internal error");
      return;
    }

    // Register in scoped client set
    const meta = getMeta(socket);
    meta.userId = user.sub;
    meta.organizationId = user.organization_id;
    meta.pipelineRunId = pipelineRunId;

    if (!pipelineClients.has(pipelineRunId)) {
      pipelineClients.set(pipelineRunId, new Set());
    }
    pipelineClients.get(pipelineRunId)!.add(socket);

    socket.on("close", () => {
      const clients = pipelineClients.get(pipelineRunId);
      if (clients) {
        clients.delete(socket);
        if (clients.size === 0) pipelineClients.delete(pipelineRunId);
      }
    });

    socket.send(
      JSON.stringify({
        type: "connected",
        pipelineRunId,
        timestamp: new Date().toISOString(),
      })
    );
  });
});
