// env.ts MUST be the first import — it loads dotenv before any module
// reads process.env (ESM hoists imports above inline code).
import "./env.js";

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { authPlugin } from "@/plugins/auth.js";
import { rateLimitPlugin } from "@/plugins/rate-limit.js";
import { websocketPlugin } from "@/plugins/websocket.js";

import { authRoutes } from "@/routes/auth.js";
import { projectRoutes } from "@/routes/projects.js";
import { pipelineRoutes } from "@/routes/pipeline.js";
import { agentRoutes } from "@/routes/agents.js";
import { storageRoutes } from "@/routes/storage.js";
import { adminRoutes } from "@/routes/admin.js";
import { githubRoutes } from "@/routes/github.js";
import { usageRoutes } from "@/routes/usage.js";
import { exportRoutes } from "@/routes/export.js";
import { agentDepartmentRoutes } from "@/routes/agent-department.js";
import { agentEventsRoutes } from "@/routes/agent-events.js";

import { closeDatabaseConnection } from "@/db/index.js";
// Lazy-import lsp-manager — it's a 65KB module with 63 language server configs
// that is only needed when agents execute code analysis. Eagerly loading it
// at startup adds hundreds of milliseconds to the bootstrap time.
// At shutdown, we dynamically import it only if there are cached servers to kill.
// ESM module cache ensures this is a no-op if lsp-manager was already imported
// by sandbox.ts during the session.
import { startCleanupScheduler, stopCleanupScheduler } from "@/services/cleanup-scheduler.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";

async function bootstrap() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      transport:
        NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
  });

  // Register plugins
  await fastify.register(fastifyCors, {
    origin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(","),
    credentials: true,
  });

  await fastify.register(authPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(websocketPlugin);

  // Swagger documentation
  await fastify.register(fastifySwagger, {
    swagger: {
      info: {
        title: "REVAMP API Gateway",
        description: "AI-powered legacy application modernizer",
        version: "1.0.0",
      },
      schemes: [NODE_ENV === "development" ? "http" : "https"],
      consumes: ["application/json"],
      produces: ["application/json"],
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  // Register routes
  await fastify.register(authRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(pipelineRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(storageRoutes);
  await fastify.register(adminRoutes);
  await fastify.register(githubRoutes);
  await fastify.register(usageRoutes);
  await fastify.register(exportRoutes);
  await fastify.register(agentDepartmentRoutes);
  await fastify.register(agentEventsRoutes);

  // Health check endpoint (includes BREE Engine status)
  fastify.get("/health", async (request, reply) => {
    let breeStatus = "unavailable";
    try {
      const { breeHealth } = await import("@/services/bree-client.js");
      const health = await breeHealth();
      breeStatus = health?.status === "ok" ? `online (v${health.version})` : "offline";
    } catch { /* BREE client not available */ }

    return reply.send({
      status: "ok",
      timestamp: new Date().toISOString(),
      services: { bree_engine: breeStatus },
    });
  });

  // BREE Engine proxy routes — forward to Rust service
  fastify.get("/bree/languages", async (req, reply) => {
    const { breeListLanguages } = await import("@/services/bree-client.js");
    return reply.send(await breeListLanguages());
  });
  fastify.get("/bree/tiers", async (req, reply) => {
    const { breeListTiers } = await import("@/services/bree-client.js");
    return reply.send(await breeListTiers());
  });
  fastify.get("/bree/readiness", async (req, reply) => {
    const { breeReadiness } = await import("@/services/bree-client.js");
    return reply.send(await breeReadiness());
  });
  fastify.post("/bree/detect", async (req, reply) => {
    const { breeDetect } = await import("@/services/bree-client.js");
    const body = req.body as { files: Array<{ path: string; content: string }> };
    return reply.send(await breeDetect(body.files));
  });
  fastify.post("/bree/analyze", async (req, reply) => {
    const { breeAnalyze } = await import("@/services/bree-client.js");
    const body = req.body as { files: Array<{ path: string; content: string }> };
    return reply.send(await breeAnalyze(body.files));
  });

  // Start background cleanup scheduler (dev only)
  startCleanupScheduler(fastify.log);

  // Graceful shutdown
  const signals = ["SIGTERM", "SIGINT"];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      stopCleanupScheduler();
      // Lazy-import lsp-manager at shutdown time. If it was already loaded by
      // sandbox.ts during the session, ESM cache returns the same module instantly.
      // If it was never loaded, this is still fast enough for a shutdown path.
      try {
        const { shutdownAllServers } = await import("@/services/lsp-manager.js");
        shutdownAllServers();
      } catch {
        // lsp-manager not available — no servers to kill
      }
      await fastify.close();
      await closeDatabaseConnection();
      process.exit(0);
    });
  }

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Server listening on http://${HOST}:${PORT}`);
    console.log(`API docs available at http://${HOST}:${PORT}/docs`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

bootstrap();
