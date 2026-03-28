/**
 * Export Routes — Generate downloadable project reports and code archives.
 *
 * Endpoints:
 *   GET    /export/project/:projectId/report  → JSON/Markdown project report
 *   GET    /export/project/:projectId/code    → ZIP of modernized codebase
 *   GET    /export/project/:projectId/summary → Quick project summary
 */

import { FastifyInstance } from "fastify";
import { db } from "@/db/index.js";
import {
  projects,
  pipelineRuns,
  stageArtifacts,
  llmUsage,
  modernizedFiles,
  approvalGates,
} from "@/db/schema.js";
import { eq, desc } from "drizzle-orm";
import { calculateCost } from "@revamp/core-engine";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, relative } from "path";
import { execSync } from "child_process";
import { PIPELINE_STAGE_ORDER } from "@revamp/shared-types";

// ─── CONSTANTS ──────────────────────────────────────────────────

const WORKSPACE_BASE = resolve(process.env.WORKSPACE_DIR || "/tmp/revamp-workspaces");

const STAGE_NAMES = PIPELINE_STAGE_ORDER as readonly string[];

// ─── ROUTES ─────────────────────────────────────────────────────

export async function exportRoutes(fastify: FastifyInstance) {
  /**
   * GET /export/project/:projectId/report — Full project report.
   *
   * Returns a comprehensive JSON report covering all stages,
   * artifacts, validation results, approvals, and LLM usage.
   * Can also return markdown via ?format=markdown query param.
   */
  fastify.get<{
    Params: { projectId: string };
    Querystring: { format?: string };
  }>(
    "/export/project/:projectId/report",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId } = request.params;
      const format = (request.query as { format?: string }).format || "json";

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      // Gather all data
      const [runs, usageRecords, files] = await Promise.all([
        db.query.pipelineRuns.findMany({
          where: eq(pipelineRuns.project_id, projectId),
          with: { artifacts: true },
          orderBy: desc(pipelineRuns.created_at),
        }),
        db.query.llmUsage.findMany({
          where: eq(llmUsage.project_id, projectId),
        }),
        db.query.modernizedFiles.findMany({
          where: eq(modernizedFiles.project_id, projectId),
        }),
      ]);

      // Fetch approval gates for the latest run (depends on runs result)
      const gates = runs[0]
        ? await db.query.approvalGates.findMany({
            where: eq(approvalGates.pipeline_run_id, runs[0].id),
          })
        : [];

      // Calculate usage
      let totalTokens = 0;
      let totalCostUsd = 0;
      const modelUsage: Record<string, { tokens: number; cost: number }> = {};
      for (const record of usageRecords) {
        const cost = calculateCost(record.input_tokens, record.output_tokens, record.model);
        totalTokens += record.input_tokens + record.output_tokens;
        totalCostUsd += cost;
        if (!modelUsage[record.model]) modelUsage[record.model] = { tokens: 0, cost: 0 };
        modelUsage[record.model].tokens += record.input_tokens + record.output_tokens;
        modelUsage[record.model].cost += cost;
      }

      const report = {
        generated_at: new Date().toISOString(),
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          current_stage: project.current_stage,
          source_type: project.source_type,
          source_url: project.source_url,
          target_stack: project.target_stack,
          target_cloud: project.target_cloud,
          created_at: project.created_at,
        },
        pipeline: {
          total_runs: runs.length,
          latest_run: runs[0]
            ? {
                id: runs[0].id,
                status: runs[0].status,
                current_stage: runs[0].current_stage,
                started_at: runs[0].started_at,
                completed_at: runs[0].completed_at,
              }
            : null,
          stage_artifacts: STAGE_NAMES.map((stageName) => {
            const stageArts = runs[0]?.artifacts?.filter(
              (a: any) => a.stage_name === stageName,
            ) || [];
            const stageGate = gates.find((g) => g.stage_name === stageName);
            return {
              stage: stageName,
              artifact_count: stageArts.length,
              artifact_types: stageArts.map((a: any) => a.artifact_type),
              approval_status: stageGate?.status || "pending",
            };
          }),
        },
        modernized_files: {
          total_count: files.length,
          languages: [...new Set(files.map((f) => f.language).filter(Boolean))],
          total_size_bytes: files.reduce((sum, f) => sum + f.file_size, 0),
          files: files.map((f) => ({
            path: f.file_path,
            language: f.language,
            size: f.file_size,
            is_new: f.is_new,
          })),
        },
        usage: {
          total_tokens: totalTokens,
          total_cost_usd: Math.round(totalCostUsd * 10000) / 10000,
          total_requests: usageRecords.length,
          by_model: Object.entries(modelUsage).map(([model, stats]) => ({
            model,
            tokens: stats.tokens,
            cost: Math.round(stats.cost * 10000) / 10000,
          })),
        },
      };

      if (format === "markdown") {
        const md = generateMarkdownReport(report);
        reply.header("Content-Type", "text/markdown");
        reply.header(
          "Content-Disposition",
          `attachment; filename="${project.name.replace(/[^a-zA-Z0-9]/g, '-')}-report.md"`,
        );
        return reply.send(md);
      }

      return reply.send(report);
    },
  );

  /**
   * GET /export/project/:projectId/code — ZIP of modernized codebase.
   *
   * Packages the workspace or modernized files into a zip archive.
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/export/project/:projectId/code",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId } = request.params;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const workspacePath = join(WORKSPACE_BASE, projectId);

      // Option 1: Workspace exists on disk — zip it
      if (existsSync(workspacePath)) {
        try {
          const zipName = `${project.name.replace(/[^a-zA-Z0-9]/g, '-')}-code.zip`;
          const zipPath = join("/tmp", `revamp-export-${projectId}.zip`);

          execSync(
            `cd ${JSON.stringify(workspacePath)} && zip -r ${JSON.stringify(zipPath)} . -x ".git/*" "node_modules/*" "__pycache__/*" ".next/*"`,
            { timeout: 60_000, stdio: "pipe" },
          );

          const zipBuffer = readFileSync(zipPath);
          reply.header("Content-Type", "application/zip");
          reply.header("Content-Disposition", `attachment; filename="${zipName}"`);
          reply.header("Content-Length", zipBuffer.length);
          return reply.send(zipBuffer);
        } catch (err) {
          return reply.status(500).send({
            error: "Failed to create ZIP archive",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      // Option 2: Use modernized files from DB
      const files = await db.query.modernizedFiles.findMany({
        where: eq(modernizedFiles.project_id, projectId),
      });

      if (files.length === 0) {
        return reply.status(404).send({
          error: "No modernized code available. Run the FORGE stage first.",
        });
      }

      // Create a JSON bundle of files (lightweight alternative to zip)
      reply.header("Content-Type", "application/json");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${project.name.replace(/[^a-zA-Z0-9]/g, '-')}-code.json"`,
      );
      return reply.send({
        project: project.name,
        exported_at: new Date().toISOString(),
        file_count: files.length,
        files: files.map((f) => ({
          path: f.file_path,
          name: f.file_name,
          language: f.language,
          content: f.content,
          size: f.file_size,
        })),
      });
    },
  );

  /**
   * GET /export/project/:projectId/summary — Quick project summary.
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/export/project/:projectId/summary",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId } = request.params;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const [runs, usage, fileCount] = await Promise.all([
        db.query.pipelineRuns.findMany({
          where: eq(pipelineRuns.project_id, projectId),
          columns: { id: true, status: true },
        }),
        db.query.llmUsage.findMany({
          where: eq(llmUsage.project_id, projectId),
        }),
        db.query.modernizedFiles.findMany({
          where: eq(modernizedFiles.project_id, projectId),
          columns: { id: true },
        }),
      ]);

      let totalCost = 0;
      let totalTokens = 0;
      for (const u of usage) {
        totalCost += calculateCost(u.input_tokens, u.output_tokens, u.model);
        totalTokens += u.input_tokens + u.output_tokens;
      }

      return reply.send({
        project_id: projectId,
        name: project.name,
        status: project.status,
        current_stage: project.current_stage,
        pipeline_runs: runs.length,
        completed_runs: runs.filter((r) => r.status === "completed").length,
        modernized_files: fileCount.length,
        total_tokens: totalTokens,
        total_cost_usd: Math.round(totalCost * 10000) / 10000,
      });
    },
  );
}

// ─── MARKDOWN REPORT GENERATOR ──────────────────────────────────

function generateMarkdownReport(report: any): string {
  const lines: string[] = [];

  lines.push(`# REVAMP Modernization Report`);
  lines.push(`## ${report.project.name}`);
  lines.push(``);
  lines.push(`Generated: ${new Date(report.generated_at).toLocaleString()}`);
  lines.push(``);

  // Project Overview
  lines.push(`## Project Overview`);
  lines.push(``);
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Status | ${report.project.status} |`);
  lines.push(`| Current Stage | ${report.project.current_stage || 'N/A'} |`);
  lines.push(`| Source | ${report.project.source_type || 'N/A'} |`);
  lines.push(`| Target Stack | ${report.project.target_stack || 'N/A'} |`);
  lines.push(`| Target Cloud | ${report.project.target_cloud || 'N/A'} |`);
  lines.push(``);

  // Pipeline Status
  lines.push(`## Pipeline Status`);
  lines.push(``);
  lines.push(`Total Runs: ${report.pipeline.total_runs}`);
  if (report.pipeline.latest_run) {
    lines.push(`Latest Run: ${report.pipeline.latest_run.status} (${report.pipeline.latest_run.current_stage || 'N/A'})`);
  }
  lines.push(``);

  lines.push(`### Stage Progress`);
  lines.push(``);
  lines.push(`| Stage | Artifacts | Approval |`);
  lines.push(`|-------|-----------|----------|`);
  for (const stage of report.pipeline.stage_artifacts) {
    lines.push(`| ${stage.stage} | ${stage.artifact_count} | ${stage.approval_status} |`);
  }
  lines.push(``);

  // Modernized Files
  lines.push(`## Modernized Files`);
  lines.push(``);
  lines.push(`Total: ${report.modernized_files.total_count} files`);
  lines.push(`Languages: ${report.modernized_files.languages.join(', ') || 'N/A'}`);
  lines.push(`Size: ${(report.modernized_files.total_size_bytes / 1024).toFixed(1)} KB`);
  lines.push(``);

  // Usage
  lines.push(`## LLM Usage`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Tokens | ${report.usage.total_tokens.toLocaleString()} |`);
  lines.push(`| Total Cost | $${report.usage.total_cost_usd.toFixed(4)} |`);
  lines.push(`| API Calls | ${report.usage.total_requests} |`);
  lines.push(``);

  if (report.usage.by_model.length > 0) {
    lines.push(`### By Model`);
    lines.push(``);
    lines.push(`| Model | Tokens | Cost |`);
    lines.push(`|-------|--------|------|`);
    for (const m of report.usage.by_model) {
      lines.push(`| ${m.model} | ${m.tokens.toLocaleString()} | $${m.cost.toFixed(4)} |`);
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`*Report generated by REVAMP 10X*`);

  return lines.join('\n');
}
