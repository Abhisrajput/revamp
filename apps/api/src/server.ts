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
import errorHandlerPlugin from "@/plugins/error-handler.js";
import metricsPlugin from "@/plugins/metrics.js";

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
import { jiraRoutes } from "@/routes/jira.js";
import { agentEventsRoutes } from "@/routes/agent-events.js";
import { agentTaskRoutes } from "@/routes/agent-tasks.js";
import { agentFeatureRoutes } from "@/routes/agent-features.js";

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

  // Security headers on every response
  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-XSS-Protection", "0"); // Modern browsers use CSP; legacy header is misleading
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  });

  // Register plugins
  await fastify.register(fastifyCors, {
    origin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(","),
    credentials: true,
  });

  // Cookie parser — required before authPlugin for HttpOnly JWT cookie extraction
  const fastifyCookie = (await import("@fastify/cookie")).default;
  await fastify.register(fastifyCookie);

  await fastify.register(errorHandlerPlugin);
  await fastify.register(metricsPlugin);
  await fastify.register(authPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(websocketPlugin);

  // Swagger documentation
  await fastify.register(fastifySwagger, {
    swagger: {
      info: {
        title: "REVAMP API Gateway",
        description:
          "AIgnite LAPM — AI-powered legacy application modernizer. " +
          "Transforms legacy systems through an 8-stage pipeline: " +
          "SCAN → DECODE → BLUEPRINT → SPEC_LOCK → ARCHITECT → FORGE → SHADOW_RUN → EVOLVE.",
        version: "1.0.0",
        contact: { name: "Tavant AIgnite Team" },
      },
      schemes: [NODE_ENV === "development" ? "http" : "https"],
      consumes: ["application/json"],
      produces: ["application/json"],
      securityDefinitions: {
        bearerAuth: {
          type: "apiKey",
          name: "Authorization",
          in: "header",
          description: "JWT token: Bearer <token>",
        },
        cookieAuth: {
          type: "apiKey",
          name: "revamp_token",
          in: "header",
          description: "HttpOnly cookie (set automatically on login)",
        },
      },
      tags: [
        { name: "Auth", description: "Authentication and user management" },
        { name: "Projects", description: "Project CRUD and configuration" },
        { name: "Pipeline", description: "8-stage modernization pipeline execution, approval, and history" },
        { name: "Usage", description: "LLM token usage and cost tracking" },
        { name: "Admin", description: "System administration and health checks" },
        { name: "Storage", description: "File upload and artifact storage" },
        { name: "Export", description: "Export pipeline results" },
        { name: "Agents", description: "AI agent personas and configuration" },
        { name: "Agent Department", description: "Agent department management and task routing" },
        { name: "Agent Events", description: "Agent activity event stream" },
        { name: "Agent Features", description: "Agent feature flags and capabilities" },
        { name: "Agent Tasks", description: "Agent task queue and execution" },
        { name: "GitHub", description: "GitHub integration for code sync" },
        { name: "Jira", description: "Jira integration for project tracking" },
      ],
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
  await fastify.register(agentTaskRoutes);
  await fastify.register(agentFeatureRoutes);
  await fastify.register(jiraRoutes);

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

  // BREE Engine proxy routes — forward to Rust service (auth-gated)
  fastify.get("/bree/languages", { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const { breeListLanguages } = await import("@/services/bree-client.js");
    return reply.send(await breeListLanguages());
  });
  fastify.get("/bree/tiers", { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const { breeListTiers } = await import("@/services/bree-client.js");
    return reply.send(await breeListTiers());
  });
  fastify.get("/bree/readiness", { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const { breeReadiness } = await import("@/services/bree-client.js");
    return reply.send(await breeReadiness());
  });
  fastify.post("/bree/detect", { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const { breeDetect } = await import("@/services/bree-client.js");
    const body = req.body as { files: Array<{ path: string; content: string }> };
    return reply.send(await breeDetect(body.files));
  });
  fastify.post("/bree/analyze", { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const { breeAnalyze } = await import("@/services/bree-client.js");
    const body = req.body as { files: Array<{ path: string; content: string }> };
    return reply.send(await breeAnalyze(body.files));
  });

  // Deep BREE analysis — reads files from cloned codebase on server disk
  fastify.post("/bree/deep-analyze", async (req, reply) => {
    const body = req.body as { pipeline_run_id: string; stage_name: string };
    if (!body.pipeline_run_id) {
      return reply.status(400).send({ error: "pipeline_run_id required" });
    }

    const { db } = await import("@/db/index.js");
    const { stageArtifacts } = await import("@/db/schema.js");
    const { eq, and } = await import("drizzle-orm");

    // Find the cloned codebase path
    const artifact = await db.query.stageArtifacts.findFirst({
      where: and(
        eq(stageArtifacts.pipeline_run_id, body.pipeline_run_id),
        eq(stageArtifacts.artifact_type, "cloned_codebase"),
      ),
    });

    const codebasePath = artifact?.storage_path;
    if (!codebasePath) {
      return reply.status(404).send({ error: "Cloned codebase not found" });
    }

    // Read files from disk
    const { promises: fs } = await import("fs");
    const path = await import("path");

    const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.next', 'target', 'dist', 'build']);
    const BINARY_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'woff', 'woff2', 'ttf', 'eot', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'so']);

    const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB aggregate limit
    let totalBytes = 0;

    async function readDir(dir: string): Promise<Array<{ path: string; content: string }>> {
      const files: Array<{ path: string; content: string }> = [];
      if (totalBytes >= MAX_TOTAL_BYTES) return files;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (totalBytes >= MAX_TOTAL_BYTES) break;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await readDir(fullPath));
          } else {
            const ext = entry.name.split('.').pop()?.toLowerCase() || '';
            if (BINARY_EXTS.has(ext)) continue;
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              if (content.length < 500_000 && totalBytes + content.length < MAX_TOTAL_BYTES) {
                totalBytes += content.length;
                files.push({ path: path.relative(codebasePath!, fullPath), content });
              }
            } catch { /* skip unreadable */ }
          }
        }
      } catch { /* skip unreadable dirs */ }
      return files;
    }

    const files = await readDir(codebasePath);

    if (files.length === 0) {
      return reply.status(404).send({ error: "No readable files found in codebase" });
    }

    // Run all BREE analyses in parallel
    const {
      breeAnalyze: breeAnalyzeFn,
      breeAnalyzeGraph,
      breeAnalyzeRequirements,
      breeDetect,
      breeLlmStrategy,
    } = await import("@/services/bree-client.js");

    fastify.log.info({ fileCount: files.length, codebasePath }, "BREE deep-analyze: sending files to BREE Engine");

    const [analyzeRes, graphRes, reqsRes, detectRes, strategyRes] = await Promise.allSettled([
      breeAnalyzeFn(files),
      breeAnalyzeGraph({ files }),
      breeAnalyzeRequirements({ files }),
      breeDetect(files),
      breeLlmStrategy(files),
    ]);

    // Log failures so they're visible in server logs
    const results = { analyzeRes, graphRes, reqsRes, detectRes, strategyRes };
    for (const [name, res] of Object.entries(results)) {
      if (res.status === 'rejected') {
        fastify.log.error({ name, reason: String(res.reason) }, "BREE deep-analyze: sub-request failed");
      }
    }

    return reply.send({
      analysisReport: analyzeRes.status === 'fulfilled' ? analyzeRes.value : null,
      graphAnalysis: graphRes.status === 'fulfilled' ? graphRes.value : null,
      requirements: reqsRes.status === 'fulfilled' ? reqsRes.value : null,
      languageProfile: detectRes.status === 'fulfilled' ? detectRes.value : null,
      llmStrategy: strategyRes.status === 'fulfilled' ? strategyRes.value : null,
      filesAnalyzed: files.length,
    });
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

  // Run database migrations before accepting requests.
  // Safe to run on every startup — Drizzle skips already-applied migrations.
  if (process.env.SKIP_MIGRATIONS !== "true") {
    try {
      const { Pool: MigrationPool } = await import("pg");
      const { drizzle: migrationDrizzle } = await import("drizzle-orm/node-postgres");
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      const migrationPool = new MigrationPool({ connectionString: process.env.DATABASE_URL });
      const migrationDb = migrationDrizzle(migrationPool);
      await migrate(migrationDb, { migrationsFolder: "./drizzle" });
      await migrationPool.end();
      fastify.log.info("Database migrations applied successfully");
    } catch (migrationErr: any) {
      const msg = migrationErr?.message || "";
      if (msg.includes("No file") && NODE_ENV === "development") {
        // In dev, migration SQL files may be missing (already applied to DB).
        // Skip gracefully — the DB schema is up-to-date from prior runs.
        fastify.log.warn("Migration files missing (dev mode) — skipping. Run `pnpm db:generate` to regenerate.");
      } else {
        fastify.log.error(migrationErr, "Database migration failed — server will NOT start with stale schema");
        process.exit(1);
      }
    }
  }

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Server listening on http://${HOST}:${PORT}`);
    console.log(`API docs available at http://${HOST}:${PORT}/docs`);

    // ─── Startup recovery: reset orphaned in_progress stages ──────
    // When the server restarts (crash, deploy, SSO refresh), any stages
    // that were mid-execution get stuck in 'in_progress' forever.
    // Detect and reset them so users don't see stuck timers.
    try {
      const { db } = await import("@/db/index.js");
      const { sql } = await import("drizzle-orm");
      const result = await db.execute(sql`
        UPDATE pipeline_runs
        SET stage_progress = (
          SELECT jsonb_object_agg(
            key,
            CASE
              WHEN value->>'status' = 'in_progress'
              THEN jsonb_set(value, '{status}', '"failed"')
              ELSE value
            END
          )
          FROM jsonb_each(stage_progress)
        )
        WHERE status = 'running'
          AND updated_at < NOW() - INTERVAL '5 minutes'
        RETURNING id
      `);
      const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
      if (rows.length > 0) {
        console.log(`[Startup] Recovered ${rows.length} pipeline run(s) with stuck in_progress stages`);
      }
    } catch (recoveryErr) {
      // Non-fatal — don't block server start
      console.warn('[Startup] Stage recovery failed:', recoveryErr instanceof Error ? recoveryErr.message : recoveryErr);
    }
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

bootstrap();
