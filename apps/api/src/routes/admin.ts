/**
 * Admin Routes — System health, user management, platform stats, audit logs.
 *
 * Endpoints:
 *   GET    /admin/health          → System health (DB, Redis, Orchestrator, S3)
 *   GET    /admin/users           → List all users
 *   PATCH  /admin/users/:userId   → Update user role/status
 *   GET    /admin/stats           → Platform-wide statistics
 *   GET    /admin/audit-logs      → Paginated audit logs
 *   GET    /admin/llm-usage       → LLM usage statistics
 *   GET    /admin/export/audit-logs → Export audit logs as CSV
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/db/index.js";
import { users, auditLogs, llmUsage, projects, pipelineRuns } from "@/db/schema.js";
import { eq, desc, count, lt } from "drizzle-orm";
import { checkDatabaseHealth } from "@/db/index.js";
import { llmProxyService } from "@/services/llm-proxy.js";
import { calculateCost } from "@revamp/core-engine";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ─── SCHEMAS ────────────────────────────────────────────────────

const UpdateUserSchema = z.object({
  role: z.enum(["admin", "architect", "developer", "sme"]).optional(),
  is_active: z.boolean().optional(),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ─── HELPERS ────────────────────────────────────────────────────

async function checkRedisHealth(): Promise<{ ok: boolean; latency?: number }> {
  try {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    // Dynamic import to avoid startup dependency
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(redisUrl, { connectTimeout: 3000, lazyConnect: true });
    const start = Date.now();
    await redis.connect();
    await redis.ping();
    const latency = Date.now() - start;
    await redis.quit();
    return { ok: true, latency };
  } catch {
    return { ok: false };
  }
}

async function checkOrchestratorHealth(): Promise<{ ok: boolean; providers?: Record<string, string> }> {
  try {
    const health = await llmProxyService.healthCheck();
    return { ok: health.status === "ok" || health.status === "healthy", providers: health.providers };
  } catch {
    return { ok: false };
  }
}

async function checkS3Health(): Promise<{ ok: boolean }> {
  try {
    const endpoint = process.env.S3_ENDPOINT || "http://localhost:9000";
    const res = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

// ─── ROUTES ─────────────────────────────────────────────────────

export async function adminRoutes(fastify: FastifyInstance) {
  /**
   * GET /admin/health — Comprehensive system health check.
   */
  fastify.get(
    "/admin/health",
    { onRequest: [fastify.authorize(["admin"])] },
    async (_request, reply) => {
      const [dbHealth, redisHealth, orchestratorHealth, s3Health] = await Promise.all([
        checkDatabaseHealth(),
        checkRedisHealth(),
        checkOrchestratorHealth(),
        checkS3Health(),
      ]);

      const allHealthy = dbHealth && redisHealth.ok && orchestratorHealth.ok && s3Health.ok;
      const status = allHealthy ? "healthy" : "degraded";

      return reply.send({
        status,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        },
        services: {
          database: {
            status: dbHealth ? "ok" : "error",
          },
          redis: {
            status: redisHealth.ok ? "ok" : "error",
            latency_ms: redisHealth.latency,
          },
          llm_orchestrator: {
            status: orchestratorHealth.ok ? "ok" : "error",
            providers: orchestratorHealth.providers,
          },
          s3_storage: {
            status: s3Health.ok ? "ok" : "error",
          },
        },
      });
    },
  );

  /**
   * GET /admin/users — List all users (admin only).
   */
  fastify.get<{ Querystring: z.infer<typeof PaginationSchema> }>(
    "/admin/users",
    { onRequest: [fastify.authorize(["admin"])] },
    async (request, reply) => {
      const { page, limit } = PaginationSchema.parse(request.query || {});

      const allUsers = await db.query.users.findMany({
        columns: {
          password_hash: false,
          otp_secret: false,
        },
        limit,
        offset: (page - 1) * limit,
        orderBy: desc(users.created_at),
      });

      const [totalResult] = await db
        .select({ count: count() })
        .from(users);

      return reply.send({
        users: allUsers,
        pagination: {
          page,
          limit,
          total: totalResult?.count || 0,
          pages: Math.ceil((totalResult?.count || 0) / limit),
        },
      });
    },
  );

  /**
   * PATCH /admin/users/:userId — Update user role/status (admin only).
   */
  fastify.patch<{ Params: { userId: string }; Body: z.infer<typeof UpdateUserSchema> }>(
    "/admin/users/:userId",
    { onRequest: [fastify.authorize(["admin"])] },
    async (request, reply) => {
      const { userId } = request.params;
      const validation = UpdateUserSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });
      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      await db
        .update(users)
        .set({ ...validation.data, updated_at: new Date() })
        .where(eq(users.id, userId));

      await db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        user_id: request.user.sub,
        action: "UPDATE_USER",
        resource_type: "user",
        resource_id: userId,
        changes: validation.data,
        ip_address: request.ip,
      });

      return reply.send({ message: "User updated" });
    },
  );

  /**
   * GET /admin/stats — Platform-wide statistics.
   */
  fastify.get(
    "/admin/stats",
    { onRequest: [fastify.authorize(["admin"])] },
    async (_request, reply) => {
      const [
        [userCount],
        [projectCount],
        [pipelineCount],
        recentPipelines,
        usageRecords,
      ] = await Promise.all([
        db.select({ count: count() }).from(users),
        db.select({ count: count() }).from(projects),
        db.select({ count: count() }).from(pipelineRuns),
        db.query.pipelineRuns.findMany({
          limit: 10,
          orderBy: desc(pipelineRuns.created_at),
          columns: {
            id: true,
            status: true,
            current_stage: true,
            created_at: true,
          },
        }),
        db.query.llmUsage.findMany({ limit: 1000 }),
      ]);

      let totalTokens = 0;
      let totalCost = 0;
      for (const record of usageRecords) {
        totalTokens += record.input_tokens + record.output_tokens;
        totalCost += calculateCost(record.input_tokens, record.output_tokens, record.model);
      }

      // Pipeline status breakdown
      const statusCounts: Record<string, number> = {};
      const allPipelines = await db.query.pipelineRuns.findMany({
        columns: { status: true },
      });
      for (const p of allPipelines) {
        statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
      }

      return reply.send({
        total_users: userCount?.count || 0,
        total_projects: projectCount?.count || 0,
        total_pipeline_runs: pipelineCount?.count || 0,
        pipeline_status_breakdown: statusCounts,
        total_llm_tokens: totalTokens,
        total_llm_cost_usd: Math.round(totalCost * 10000) / 10000,
        total_llm_requests: usageRecords.length,
        recent_pipelines: recentPipelines,
      });
    },
  );

  /**
   * GET /admin/audit-logs — Paginated audit logs.
   */
  fastify.get<{ Querystring: z.infer<typeof PaginationSchema> }>(
    "/admin/audit-logs",
    { onRequest: [fastify.authorize(["admin"])] },
    async (request, reply) => {
      const { page, limit } = PaginationSchema.parse(request.query || {});

      const logs = await db.query.auditLogs.findMany({
        limit,
        offset: (page - 1) * limit,
        orderBy: desc(auditLogs.created_at),
      });

      const [totalResult] = await db
        .select({ count: count() })
        .from(auditLogs);

      return reply.send({
        logs,
        pagination: {
          page,
          limit,
          total: totalResult?.count || 0,
          pages: Math.ceil((totalResult?.count || 0) / limit),
        },
      });
    },
  );

  /**
   * GET /admin/llm-usage — LLM usage statistics.
   */
  fastify.get(
    "/admin/llm-usage",
    { onRequest: [fastify.authorize(["admin"])] },
    async (_request, reply) => {
      const stats = await db.query.llmUsage.findMany({
        limit: 500,
        orderBy: desc(llmUsage.created_at),
      });

      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      const byModel: Record<string, { count: number; cost: number; input_tokens: number; output_tokens: number }> = {};

      for (const stat of stats) {
        const cost = calculateCost(stat.input_tokens, stat.output_tokens, stat.model);
        totalCost += cost;
        totalInputTokens += stat.input_tokens;
        totalOutputTokens += stat.output_tokens;

        if (!byModel[stat.model]) {
          byModel[stat.model] = { count: 0, cost: 0, input_tokens: 0, output_tokens: 0 };
        }
        byModel[stat.model].count++;
        byModel[stat.model].cost += cost;
        byModel[stat.model].input_tokens += stat.input_tokens;
        byModel[stat.model].output_tokens += stat.output_tokens;
      }

      return reply.send({
        total_requests: stats.length,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
        by_model: Object.entries(byModel)
          .map(([model, data]) => ({
            model,
            ...data,
            cost: Math.round(data.cost * 10000) / 10000,
          }))
          .sort((a, b) => b.cost - a.cost),
      });
    },
  );

  /**
   * GET /admin/metrics — Platform-wide aggregated metrics.
   *
   * Aggregates project_metrics and llm_usage tables for platform-wide totals:
   * total projects, files processed, lines analyzed, tokens used, cost.
   */
  fastify.get(
    "/admin/metrics",
    { onRequest: [fastify.authorize(["admin"])] },
    async (_request, reply) => {
      const [allProjects, allUsage, [projectTotal], [pipelineTotal]] = await Promise.all([
        db.query.projects.findMany({
          columns: { id: true, metrics: true, status: true },
        }),
        db.query.llmUsage.findMany({
          columns: { input_tokens: true, output_tokens: true, cost: true, model: true },
        }),
        db.select({ count: count() }).from(projects),
        db.select({ count: count() }).from(pipelineRuns),
      ]);

      // Aggregate project-level metrics
      let totalStagesCompleted = 0;
      let totalRefinements = 0;
      let totalValidationIssues = 0;
      let activeProjects = 0;

      for (const proj of allProjects) {
        const m = (proj.metrics as Record<string, unknown>) || {};
        totalStagesCompleted += (m.stages_completed as number) || 0;
        totalRefinements += (m.total_refinements as number) || 0;
        totalValidationIssues += (m.total_validation_issues as number) || 0;
        if (proj.status === "active" || proj.status === "in_progress") {
          activeProjects++;
        }
      }

      // Aggregate LLM usage
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCostCents = 0;
      const modelBreakdown: Record<string, { requests: number; tokens: number; cost_cents: number }> = {};

      for (const usage of allUsage) {
        totalInputTokens += usage.input_tokens;
        totalOutputTokens += usage.output_tokens;
        totalCostCents += usage.cost;

        if (!modelBreakdown[usage.model]) {
          modelBreakdown[usage.model] = { requests: 0, tokens: 0, cost_cents: 0 };
        }
        modelBreakdown[usage.model].requests++;
        modelBreakdown[usage.model].tokens += usage.input_tokens + usage.output_tokens;
        modelBreakdown[usage.model].cost_cents += usage.cost;
      }

      return reply.send({
        platform: {
          total_projects: projectTotal?.count || 0,
          active_projects: activeProjects,
          total_pipeline_runs: pipelineTotal?.count || 0,
          total_stages_completed: totalStagesCompleted,
          total_refinements: totalRefinements,
          total_validation_issues: totalValidationIssues,
        },
        llm_usage: {
          total_requests: allUsage.length,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          total_tokens: totalInputTokens + totalOutputTokens,
          total_cost_cents: totalCostCents,
          total_cost_usd: Math.round(totalCostCents) / 100,
          by_model: Object.entries(modelBreakdown)
            .map(([model, data]) => ({ model, ...data }))
            .sort((a, b) => b.cost_cents - a.cost_cents),
        },
        generated_at: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /admin/performance — Server performance & resource snapshot.
   */
  fastify.get(
    "/admin/performance",
    { onRequest: [fastify.authorize(["admin"])] },
    async (_request, reply) => {
      const mem = process.memoryUsage();

      // Count revamp node processes
      let processCount = 0;
      let orphanCount = 0;
      try {
        const output = execSync(
          'ps aux | grep -E "node.*revamp-platform" | grep -v grep',
          { encoding: "utf-8", timeout: 5000 },
        ).trim();
        const lines = output ? output.split("\n") : [];
        processCount = lines.length;
        orphanCount = Math.max(0, processCount - 7); // 7 = normal (3 API + 4 Web)
      } catch {
        // No processes found
      }

      // .next cache size
      let nextCacheMB = 0;
      try {
        const nextDir = join(process.cwd(), "..", "web", ".next");
        if (existsSync(nextDir)) {
          const output = execSync(`du -sm "${nextDir}"`, {
            encoding: "utf-8",
            timeout: 10000,
          }).trim();
          nextCacheMB = parseInt(output.split("\t")[0], 10) || 0;
        }
      } catch {
        // Non-fatal
      }

      return reply.send({
        uptime_seconds: Math.round(process.uptime()),
        memory: {
          rss_mb: Math.round(mem.rss / 1024 / 1024),
          heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
          external_mb: Math.round(mem.external / 1024 / 1024),
        },
        processes: {
          total: processCount,
          orphaned: orphanCount,
        },
        caches: {
          next_cache_mb: nextCacheMB,
        },
        pid: process.pid,
      });
    },
  );

  /**
   * POST /admin/cleanup — Trigger manual cleanup of orphaned processes, caches, stale DB records.
   */
  fastify.post<{ Body: { targets?: string[] } }>(
    "/admin/cleanup",
    { onRequest: [fastify.authorize(["admin"])] },
    async (request, reply) => {
      const targets = (request.body as { targets?: string[] })?.targets || [
        "processes",
        "caches",
        "db",
      ];
      const results: Record<string, unknown> = {};

      // 1. Kill orphaned processes
      if (targets.includes("processes")) {
        let killed = 0;
        try {
          const output = execSync(
            'ps aux | grep -E "node.*revamp-platform" | grep -v grep',
            { encoding: "utf-8", timeout: 5000 },
          ).trim();

          if (output) {
            const procs = output
              .split("\n")
              .map((line) => parseInt(line.trim().split(/\s+/)[1], 10))
              .filter((pid) => !isNaN(pid))
              .sort((a, b) => a - b);

            // Keep the 7 highest PIDs (current servers) + our own PID
            const keepCount = 7;
            const toKeep = new Set(procs.slice(-keepCount));
            toKeep.add(process.pid);
            if (process.ppid) toKeep.add(process.ppid);

            for (const pid of procs) {
              if (!toKeep.has(pid)) {
                try {
                  process.kill(pid, "SIGTERM");
                  killed++;
                } catch {
                  // Already dead
                }
              }
            }
          }
        } catch {
          // No matches
        }
        results.processes = { orphans_killed: killed };
      }

      // 2. Clear .next cache
      if (targets.includes("caches")) {
        let freedMB = 0;
        try {
          const nextDir = join(process.cwd(), "..", "web", ".next");
          if (existsSync(nextDir)) {
            const sizeOutput = execSync(`du -sm "${nextDir}"`, {
              encoding: "utf-8",
              timeout: 10000,
            }).trim();
            freedMB = parseInt(sizeOutput.split("\t")[0], 10) || 0;
            execSync(`rm -rf "${nextDir}"`, { timeout: 30000 });
          }
        } catch {
          // Non-fatal
        }

        // Clear turbo cache
        try {
          const turboDir = join(process.cwd(), "..", "..", ".turbo");
          if (existsSync(turboDir)) {
            execSync(`rm -rf "${turboDir}"`, { timeout: 10000 });
          }
        } catch {
          // Non-fatal
        }

        results.caches = { freed_mb: freedMB };
      }

      // 3. Clean stale DB records
      if (targets.includes("db")) {
        let cleaned = 0;
        try {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 30);
          const deleted = await db
            .delete(auditLogs)
            .where(lt(auditLogs.created_at, cutoff))
            .returning({ id: auditLogs.id });
          cleaned = deleted.length;
        } catch {
          // Non-fatal
        }
        results.db = { stale_records_cleaned: cleaned };
      }

      return reply.send({
        message: "Cleanup completed",
        results,
        timestamp: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /admin/export/audit-logs — Export audit logs as CSV.
   */
  fastify.get(
    "/admin/export/audit-logs",
    { onRequest: [fastify.authorize(["admin"])] },
    async (_request, reply) => {
      const logs = await db.query.auditLogs.findMany({
        limit: 10000,
        orderBy: desc(auditLogs.created_at),
      });

      const csv = [
        "id,user_id,action,resource_type,resource_id,changes,ip_address,created_at",
        ...logs.map((log) =>
          [
            log.id,
            log.user_id || "",
            log.action,
            log.resource_type,
            log.resource_id || "",
            JSON.stringify(log.changes || {}).replace(/,/g, ";"),
            log.ip_address || "",
            log.created_at?.toISOString() || "",
          ].join(","),
        ),
      ].join("\n");

      reply.header("Content-Type", "text/csv");
      reply.header("Content-Disposition", "attachment; filename=audit-logs.csv");
      return reply.send(csv);
    },
  );
}
