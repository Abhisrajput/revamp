/**
 * Usage Routes — API endpoints for LLM token usage and cost tracking.
 *
 * Endpoints:
 *   GET    /usage/project/:projectId          → Token usage for a project
 *   GET    /usage/project/:projectId/stages   → Usage breakdown by stage
 *   GET    /usage/project/:projectId/models   → Usage breakdown by model
 *   GET    /usage/summary                     → Org-wide usage summary
 *   GET    /usage/models                      → Available models with pricing
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/db/index.js";
import { llmUsage, projects, pipelineRuns, stageArtifacts } from "@/db/schema.js";
import { eq, and, sql, desc, gte, inArray } from "drizzle-orm";
import { getModelPricing, calculateCost, MODEL_PRICING, getAvailableModels } from "@revamp/core-engine";
import { llmProxyService } from "@/services/llm-proxy.js";
import { PIPELINE_STAGE_ORDER } from "@revamp/shared-types";
import { buildRouteSchema } from "@/lib/zod-to-jsonschema.js";

// ─── SCHEMAS ────────────────────────────────────────────────────

const DateRangeSchema = z.object({
  from: z.string().optional(), // ISO date string
  to: z.string().optional(),
});

// ─── ROUTES ─────────────────────────────────────────────────────

export async function usageRoutes(fastify: FastifyInstance) {
  /**
   * GET /usage/project/:projectId — Token usage for a specific project.
   *
   * Returns total tokens, cost, and per-request breakdown.
   */
  fastify.get<{ Params: { projectId: string }; Querystring: z.infer<typeof DateRangeSchema> }>(
    "/usage/project/:projectId",
    {
      schema: buildRouteSchema({
        tags: ["Usage"],
        summary: "Get token usage for a specific project",
        params: z.object({ projectId: z.string().uuid() }),
        querystring: DateRangeSchema,
        response: {
          200: { type: "object", properties: { project_id: { type: "string" }, total_requests: { type: "number" }, total_tokens: { type: "number" }, total_cost_usd: { type: "number" }, by_model: { type: "array" }, recent_requests: { type: "array" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists and user has access
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const records = await db.query.llmUsage.findMany({
        where: eq(llmUsage.project_id, projectId),
        orderBy: desc(llmUsage.created_at),
      });

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;

      const byModel: Record<string, { count: number; input_tokens: number; output_tokens: number; cost: number }> = {};

      for (const record of records) {
        totalInputTokens += record.input_tokens;
        totalOutputTokens += record.output_tokens;

        const cost = calculateCost(record.input_tokens, record.output_tokens, record.model);
        totalCost += cost;

        if (!byModel[record.model]) {
          byModel[record.model] = { count: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
        }
        byModel[record.model].count++;
        byModel[record.model].input_tokens += record.input_tokens;
        byModel[record.model].output_tokens += record.output_tokens;
        byModel[record.model].cost += cost;
      }

      return reply.send({
        project_id: projectId,
        total_requests: records.length,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
        by_model: Object.entries(byModel).map(([model, stats]) => ({
          model,
          ...stats,
          cost: Math.round(stats.cost * 10000) / 10000,
        })),
        recent_requests: records.slice(0, 50).map((r) => ({
          id: r.id,
          model: r.model,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cost: Math.round(calculateCost(r.input_tokens, r.output_tokens, r.model) * 10000) / 10000,
          created_at: r.created_at,
        })),
      });
    },
  );

  /**
   * GET /usage/project/:projectId/stages — Usage breakdown by pipeline stage.
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/usage/project/:projectId/stages",
    {
      schema: buildRouteSchema({
        tags: ["Usage"],
        summary: "Get usage breakdown by pipeline stage",
        params: z.object({ projectId: z.string().uuid() }),
        response: {
          200: { type: "object", properties: { project_id: { type: "string" }, stages: { type: "array" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      // Get all pipeline runs for this project
      const runs = await db.query.pipelineRuns.findMany({
        where: eq(pipelineRuns.project_id, projectId),
        with: {
          llmUsage: true,
          artifacts: true,
        },
      });

      // Build stage-level usage from artifacts timing
      const stageUsage = PIPELINE_STAGE_ORDER.map((name, index) => {
        let tokens = 0;
        let cost = 0;
        let requests = 0;

        for (const run of runs) {
          // Each artifact records which stage it belongs to
          const stageArtifacts = (run.artifacts || []).filter(
            (a: any) => a.stage_name === name,
          );
          if (stageArtifacts.length > 0) {
            // Attribute proportional usage to this stage
            const totalArtifacts = (run.artifacts || []).length || 1;
            const stageProportion = stageArtifacts.length / totalArtifacts;
            const runUsage = (run.llmUsage || []) as any[];

            for (const u of runUsage) {
              const stageTokens = Math.round(
                (u.input_tokens + u.output_tokens) * stageProportion,
              );
              tokens += stageTokens;
              cost += calculateCost(
                Math.round(u.input_tokens * stageProportion),
                Math.round(u.output_tokens * stageProportion),
                u.model,
              );
              requests += stageProportion;
            }
          }
        }

        return {
          stage_name: name,
          stage_index: index,
          total_tokens: tokens,
          total_cost_usd: Math.round(cost * 10000) / 10000,
          request_count: Math.round(requests),
        };
      });

      return reply.send({
        project_id: projectId,
        stages: stageUsage,
      });
    },
  );

  /**
   * GET /usage/project/:projectId/models — Usage breakdown by model.
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/usage/project/:projectId/models",
    {
      schema: buildRouteSchema({
        tags: ["Usage"],
        summary: "Get usage breakdown by model",
        params: z.object({ projectId: z.string().uuid() }),
        response: {
          200: { type: "object", properties: { project_id: { type: "string" }, models: { type: "array" } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const records = await db.query.llmUsage.findMany({
        where: eq(llmUsage.project_id, projectId),
      });

      const byModel: Record<
        string,
        { count: number; input_tokens: number; output_tokens: number; cost: number }
      > = {};

      for (const record of records) {
        if (!byModel[record.model]) {
          byModel[record.model] = { count: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
        }
        byModel[record.model].count++;
        byModel[record.model].input_tokens += record.input_tokens;
        byModel[record.model].output_tokens += record.output_tokens;
        byModel[record.model].cost += calculateCost(
          record.input_tokens,
          record.output_tokens,
          record.model,
        );
      }

      return reply.send({
        project_id: projectId,
        models: Object.entries(byModel)
          .map(([model, stats]) => ({
            model,
            provider: model.startsWith("claude")
              ? "anthropic"
              : model.startsWith("gpt") || model.startsWith("o3")
                ? "openai"
                : model.startsWith("gemini")
                  ? "google"
                  : "unknown",
            pricing: getModelPricing(model),
            ...stats,
            cost: Math.round(stats.cost * 10000) / 10000,
          }))
          .sort((a, b) => b.cost - a.cost),
      });
    },
  );

  /**
   * GET /usage/summary — Org-wide usage summary.
   *
   * Shows aggregate token usage and cost across all projects.
   */
  fastify.get(
    "/usage/summary",
    {
      schema: buildRouteSchema({
        tags: ["Usage"],
        summary: "Get org-wide usage summary with daily breakdown",
        response: {
          200: { type: "object", properties: { total_requests: { type: "number" }, total_tokens: { type: "number" }, total_cost_usd: { type: "number" }, project_count: { type: "number" }, by_project: { type: "array" }, by_model: { type: "array" }, daily_usage: { type: "array" } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const orgId = request.user.organization_id;

      // Get all projects for this org
      const orgProjects = await db.query.projects.findMany({
        where: orgId ? eq(projects.organization_id, orgId) : undefined,
        columns: { id: true, name: true },
      });

      const projectIds = orgProjects.map((p) => p.id);

      // Get all usage for these projects
      const allUsage = await db.query.llmUsage.findMany({
        where: projectIds.length > 0
          ? inArray(llmUsage.project_id, projectIds)
          : undefined,
      });

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;
      const byProject: Record<string, { name: string; tokens: number; cost: number; requests: number }> = {};
      const byModel: Record<string, { tokens: number; cost: number; requests: number }> = {};

      // Last 30 days daily breakdown
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const dailyUsage: Record<string, { tokens: number; cost: number; requests: number }> = {};

      for (const record of allUsage) {
        const cost = calculateCost(record.input_tokens, record.output_tokens, record.model);
        totalInputTokens += record.input_tokens;
        totalOutputTokens += record.output_tokens;
        totalCost += cost;

        // By project
        const proj = orgProjects.find((p) => p.id === record.project_id);
        const projName = proj?.name || record.project_id;
        if (!byProject[record.project_id]) {
          byProject[record.project_id] = { name: projName, tokens: 0, cost: 0, requests: 0 };
        }
        byProject[record.project_id].tokens += record.input_tokens + record.output_tokens;
        byProject[record.project_id].cost += cost;
        byProject[record.project_id].requests++;

        // By model
        if (!byModel[record.model]) {
          byModel[record.model] = { tokens: 0, cost: 0, requests: 0 };
        }
        byModel[record.model].tokens += record.input_tokens + record.output_tokens;
        byModel[record.model].cost += cost;
        byModel[record.model].requests++;

        // Daily
        if (record.created_at && record.created_at >= thirtyDaysAgo) {
          const day = record.created_at.toISOString().split("T")[0];
          if (!dailyUsage[day]) {
            dailyUsage[day] = { tokens: 0, cost: 0, requests: 0 };
          }
          dailyUsage[day].tokens += record.input_tokens + record.output_tokens;
          dailyUsage[day].cost += cost;
          dailyUsage[day].requests++;
        }
      }

      return reply.send({
        total_requests: allUsage.length,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
        project_count: projectIds.length,
        by_project: Object.entries(byProject)
          .map(([id, stats]) => ({
            project_id: id,
            ...stats,
            cost: Math.round(stats.cost * 10000) / 10000,
          }))
          .sort((a, b) => b.cost - a.cost),
        by_model: Object.entries(byModel)
          .map(([model, stats]) => ({
            model,
            ...stats,
            cost: Math.round(stats.cost * 10000) / 10000,
          }))
          .sort((a, b) => b.cost - a.cost),
        daily_usage: Object.entries(dailyUsage)
          .map(([date, stats]) => ({
            date,
            ...stats,
            cost: Math.round(stats.cost * 10000) / 10000,
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      });
    },
  );

  /**
   * GET /usage/models — Available models with pricing information.
   * Fetches dynamically from the Go LLM orchestrator — no hardcoded model list.
   */
  fastify.get(
    "/usage/models",
    {
      schema: buildRouteSchema({
        tags: ["Usage"],
        summary: "List available models with pricing information",
        response: {
          200: { type: "object", properties: { models: { type: "array" } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (_request, reply) => {
      try {
        const orchestratorModels = await llmProxyService.listModels();
        const models = orchestratorModels.map((m) => ({
          id: m.id,
          name: (m as any).name || m.id,
          provider: m.provider,
          context_size: m.contextWindow,
          input_price_per_1m: (m as any).cost_per_input || getModelPricing(m.id).input,
          output_price_per_1m: (m as any).cost_per_output || getModelPricing(m.id).output,
        }));
        return reply.send({ models });
      } catch {
        // Fallback to static pricing data if orchestrator is unavailable
        const models = getAvailableModels().map((id) => {
          const pricing = getModelPricing(id);
          const provider = id.startsWith("claude")
            ? "anthropic"
            : id.startsWith("gpt") || id.startsWith("o3")
              ? "openai"
              : id.startsWith("gemini")
                ? "google"
                : "unknown";
          return { id, name: id, provider, input_price_per_1m: pricing.input, output_price_per_1m: pricing.output };
        });
        return reply.send({ models });
      }
    },
  );
}
