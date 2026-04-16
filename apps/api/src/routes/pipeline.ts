/**
 * Pipeline Routes — API endpoints for the 8-stage modernization pipeline.
 *
 * Endpoints:
 *   POST   /pipeline/start              → Create pipeline run
 *   GET    /pipeline/:id/status         → Get pipeline status
 *   POST   /pipeline/:id/stage/:stage   → Execute a stage (events via WebSocket)
 *   POST   /pipeline/:id/advance        → Advance to next stage
 *   GET    /pipeline/:id/artifacts      → List all artifacts
 *   GET    /pipeline/:id/artifacts/:stage → Get stage artifacts
 *   POST   /pipeline/:id/approve/:stage → Approve gate
 *   POST   /pipeline/:id/reject/:stage  → Reject gate
 *   GET    /pipeline/:id/validation/:stage → Get validation results
 *   POST   /pipeline/:id/refine          → Refine a section of stage output
 *   POST   /pipeline/:id/chat            → Interactive chat for Evolve stage (events via WebSocket)
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildRouteSchema } from "@/lib/zod-to-jsonschema.js";
import { db } from "@/db/index.js";
import { stageArtifacts, approvalGates, auditLogs, stageRuns, stageExecutionLogs, projectMembers, pipelineRuns, users, projects, modernizedFiles, traceabilityEntries, agentSubtasks, stageExecutions } from "@/db/schema.js";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { getStageOrder, classifyError } from "@revamp/core-engine";
import { pipelineService } from "@/services/pipeline.js";
import { broadcastToPipeline } from "@/plugins/websocket.js";
import { publish } from "@/services/ws-publisher.js";
import { recordRetrievalTrajectory } from "@/services/retrieval-observability.js";
import {
  createExecution,
  completeExecution,
  failExecution,
  getStatusForRun,
} from "@/services/stage-execution-repository.js";

// ─── AUDIT LOG HELPER ───────────────────────────────────────────

async function writeAuditLog(params: {
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}) {
  try {
    await db.insert(auditLogs).values({
      user_id: params.userId,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId,
      changes: params.changes,
      ip_address: params.ipAddress,
      user_agent: params.userAgent,
    });
  } catch {
    // Never let audit logging failures break the pipeline
  }
}

// ─── ERROR CLASSIFICATION HELPER ────────────────────────────────

const ERROR_USER_MESSAGES: Record<string, string> = {
  auth: "Authentication failed — check your LLM provider API key in Settings.",
  quota: "API quota or billing limit exceeded — check your provider account.",
  context_length: "Input too large for the model's context window. Try a model with a larger context or reduce the codebase scope.",
  retryable: "Temporary service error. The system retried automatically but the issue persists. Try again in a few minutes.",
  unknown: "An unexpected error occurred during stage execution.",
};

// ─── SCHEMAS ────────────────────────────────────────────────────

const StartPipelineSchema = z.object({
  project_id: z.string().uuid(),
});

const ExecuteStageSchema = z.object({
  template_vars: z.record(z.string()).optional(),
  skip_llm_eval: z.boolean().optional(),
  /** Override execution model for this stage (e.g. "claude-sonnet-4-20250514") */
  model: z.string().optional(),
  /** Override director/composition model (e.g. "us.anthropic.claude-opus-4-6-v1:0") */
  composer_model: z.string().optional(),
  /** Override evaluator/validation model for this stage */
  evaluator_model: z.string().optional(),
  /** Max output tokens (scales output depth for larger codebases) */
  max_tokens: z.number().optional(),
  /** Override stage prompt for this execution (re-run with edited prompt) */
  prompt_override: z.string().optional(),
  /** Validation feedback from previous run — injected into prompt on re-run */
  validation_feedback: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    score: z.number(),
    feedback: z.string(),
    severity: z.string().optional(),
  })).optional(),
});

const ApproveGateSchema = z.object({
  comment: z.string().optional(),
  /** Admin-only: bypass confidence threshold check */
  force: z.boolean().optional(),
});

const RejectGateSchema = z.object({
  reason: z.string().min(1),
});

const RefineSectionSchema = z.object({
  stage_name: z.string(),
  section_title: z.string(),
  section_content: z.string(),
  user_feedback: z.string(),
  full_text: z.string(),
});

const ChatMessageSchema = z.object({
  message: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).optional().default([]),
});

const validStageNames = Object.values(PipelineStageName);

// ─── SHARED PARAM SCHEMAS ──────────────────────────────────────

const PipelineRunParamsSchema = z.object({
  pipelineRunId: z.string().uuid(),
});

const PipelineStageParamsSchema = z.object({
  pipelineRunId: z.string().uuid(),
  stage: z.string(),
});

const errorResponse = {
  400: { type: "object" as const, properties: { error: { type: "string" } } },
  404: { type: "object" as const, properties: { error: { type: "string" } } },
};

// ─── ROUTES ─────────────────────────────────────────────────────

export async function pipelineRoutes(fastify: FastifyInstance) {
  /**
   * GET /pipeline/:pipelineRunId/history — Execution history, approvals, prompt changes
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/history",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Get pipeline execution history and approval timeline",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId } = request.params;

      // Fetch stage runs, approval gates, and user info in parallel
      const [runs, gates] = await Promise.all([
        db.query.stageRuns.findMany({
          where: eq(stageRuns.pipeline_run_id, pipelineRunId),
          orderBy: desc(stageRuns.created_at),
        }),
        db.query.approvalGates.findMany({
          where: eq(approvalGates.pipeline_run_id, pipelineRunId),
          orderBy: desc(approvalGates.created_at),
        }),
      ]);

      // Collect all user IDs to resolve names
      const userIds = [...new Set([
        ...runs.map(r => (r as any).initiated_by).filter(Boolean),
        ...gates.map(g => g.approved_by).filter(Boolean),
      ])] as string[];

      // Also include the pipeline initiator
      const run = await db.query.pipelineRuns.findFirst({
        where: eq(pipelineRuns.id, pipelineRunId),
        columns: { initiated_by: true },
      });
      if (run?.initiated_by) userIds.push(run.initiated_by);

      const userMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const userRows = await db.query.users.findMany({
          where: inArray(users.id, [...new Set(userIds)]),
          columns: { id: true, email: true, first_name: true, last_name: true },
        });
        for (const u of userRows) {
          userMap[u.id] = u.first_name && u.last_name
            ? `${u.first_name} ${u.last_name}`
            : u.email;
        }
      }

      // Build timeline entries
      const timeline: Array<{
        type: 'execution' | 'approval' | 'rejection';
        stage: string;
        attempt?: number;
        status: string;
        user: string;
        model?: string | null;
        duration_ms?: number | null;
        validation_passed?: boolean | null;
        comment?: string | null;
        timestamp: string;
      }> = [];

      for (const r of runs) {
        timeline.push({
          type: 'execution',
          stage: r.stage_name,
          attempt: r.attempt,
          status: r.status,
          user: userMap[(r as any).initiated_by] || userMap[run?.initiated_by || ''] || 'Unknown',
          model: r.model,
          duration_ms: r.duration_ms,
          validation_passed: r.validation_passed,
          timestamp: r.created_at?.toISOString() || new Date().toISOString(),
        });
      }

      for (const g of gates) {
        timeline.push({
          type: g.status === 'approved' ? 'approval' : 'rejection',
          stage: g.stage_name,
          status: g.status,
          user: g.approved_by ? (userMap[g.approved_by] || 'Unknown') : 'Pending',
          comment: g.approval_comment,
          timestamp: g.approved_at?.toISOString() || g.created_at?.toISOString() || new Date().toISOString(),
        });
      }

      // Sort by timestamp descending (most recent first)
      timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return reply.send({ history: timeline });
    },
  );

  /**
   * POST /pipeline/start — Create a new pipeline run
   */
  fastify.post<{ Body: z.infer<typeof StartPipelineSchema> }>(
    "/pipeline/start",
    {
      schema: buildRouteSchema({
        body: StartPipelineSchema,
        tags: ["Pipeline"],
        summary: "Create a new pipeline run for a project",
        response: {
          201: { type: "object", properties: { pipeline_run_id: { type: "string" } }, additionalProperties: true },
          ...errorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const validation = StartPipelineSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const { project_id } = validation.data;

      const project = await db.query.projects.findFirst({
        where: (table) => eq(table.id, project_id),
      });

      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      // Verify caller has access to this project
      if (request.user.role !== "admin") {
        const isSameOrg = project.organization_id === request.user.organization_id;
        if (!isSameOrg || project.visibility === "private") {
          const membership = await db.query.projectMembers.findFirst({
            where: and(
              eq(projectMembers.project_id, project_id),
              eq(projectMembers.user_id, request.user.sub),
            ),
          });
          if (!membership) {
            return reply.status(403).send({ error: "Access denied — not a project member" });
          }
        }
      }

      const runId = await pipelineService.createRun(project_id, request.user.sub);

      // Audit: pipeline started
      writeAuditLog({
        userId: request.user.sub,
        action: "PIPELINE_STARTED",
        resourceType: "pipeline_run",
        resourceId: runId,
        changes: { projectId: project_id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      // Notify scoped WebSocket subscribers (only users with access to this pipeline)
      broadcastToPipeline(runId, {
        type: "pipeline_started",
        pipeline_run_id: runId,
        project_id,
      });

      return reply.status(201).send({ pipeline_run_id: runId });
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/status — Get pipeline status
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/status",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Get current pipeline run status, stage progress, and subtasks",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const run = await pipelineService.getPipelineRun(request.params.pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      // Backfill startedAt into stage_progress so the frontend elapsed timer can
      // resume after a page refresh. Only backfill for stages that are currently
      // in_progress, and only use stage_runs rows that are still 'running' — this
      // avoids picking up orphaned/aborted attempts from prior sessions which would
      // cause the timer to show absurd values like 5+ hours.
      const enrichedStageProgress = { ...((run.stage_progress as Record<string, any>) || {}) };
      const inProgressStageNames = Object.entries(enrichedStageProgress)
        .filter(([, sp]) => sp && typeof sp === "object" && (sp as any).status === "in_progress" && !(sp as any).startedAt)
        .map(([name]) => name);
      if (inProgressStageNames.length > 0) {
        const runningStageRunRows = await db
          .select({
            stage_name: stageRuns.stage_name,
            started_at: stageRuns.started_at,
          })
          .from(stageRuns)
          .where(
            and(
              eq(stageRuns.pipeline_run_id, run.id),
              eq(stageRuns.status, "running"),
              inArray(stageRuns.stage_name, inProgressStageNames),
            ),
          )
          .orderBy(desc(stageRuns.started_at));
        const latestStartedAt: Record<string, string> = {};
        for (const row of runningStageRunRows) {
          if (!latestStartedAt[row.stage_name] && row.started_at) {
            latestStartedAt[row.stage_name] = row.started_at.toISOString();
          }
        }
        for (const stageName of inProgressStageNames) {
          if (latestStartedAt[stageName]) {
            enrichedStageProgress[stageName] = { ...enrichedStageProgress[stageName], startedAt: latestStartedAt[stageName] };
          }
        }
      }

      // Load subtasks for the current stage so the frontend can re-populate the
      // bot grid + progress bar after a page refresh (the SSE director_planning
      // events that originally created them don't replay across reloads).
      //
      // The Director runs in multiple "rounds": an initial planning round, then
      // one or more coverage gap-fill rounds. Each round inserts a fresh batch
      // of subtasks with NEW titles ("Financial Business Rules..." vs
      // "Financial Domain Rules..."), so title-based dedup is unreliable.
      // Instead we identify the most recent batch by clustering on created_at
      // (rows in the same batch are inserted in a single transaction within
      // milliseconds of each other) and return only that batch. This gives the
      // user a stable view of the LATEST plan, not a pile of stale rounds.
      let currentStageSubtasks: Array<{
        id: string;
        title: string;
        priority: number;
        status: string;
        cost_cents: number;
        type: string;
      }> = [];
      let currentStageProgress = {
        total: 0,
        completed: 0,
        running: 0,
        failed: 0,
        pending: 0,
        rounds: 0,
      };
      const currentStageStatus = enrichedStageProgress[run.current_stage ?? ""]?.status;
      const isStageActive = currentStageStatus && currentStageStatus !== "pending";
      if (run.current_stage && isStageActive) { try {
        // Fetch subtasks for any non-pending stage (in_progress, completed, approved,
        // awaiting_approval) so the bot grid persists after page refresh.
        // Use a single SQL query that joins stage_runs to scope subtasks to the
        // CURRENT attempt only. All comparisons stay in DB time (no JS Date
        // round-trip) to avoid the timestamp-without-timezone offset bug.
        type SubtaskRow = {
          id: string;
          title: string;
          priority: number;
          status: string;
          cost_cents: number;
          created_at: Date | null;
        };
        const rawResult = await db.execute(sql`
          SELECT ast.id, ast.title, ast.priority, ast.status, ast.cost_cents, ast.created_at
            FROM agent_subtasks ast
           WHERE ast.pipeline_run_id = ${run.id}
             AND ast.stage_name = ${run.current_stage}
             AND ast.created_at >= (
               SELECT sr.started_at
                 FROM stage_runs sr
                WHERE sr.pipeline_run_id = ${run.id}
                  AND sr.stage_name = ${run.current_stage}
                ORDER BY sr.started_at DESC
                LIMIT 1
             )
           ORDER BY ast.created_at DESC
           LIMIT 200
        `);
        // db.execute() returns { rows: [...] } with node-postgres driver
        const subtaskRows: SubtaskRow[] = (
          Array.isArray(rawResult) ? rawResult : (rawResult as any).rows ?? []
        ) as SubtaskRow[];

        // Identify the most recent batch by clustering on created_at. The first
        // row (desc order) is from the latest batch; we include every row whose
        // created_at is within BATCH_CLUSTER_MS of it. The Director inserts a
        // whole round in a single transaction so all rows of one batch share
        // a created_at within ~50ms — a 2-second window is generous and safe.
        const BATCH_CLUSTER_MS = 2000;
        const latestBatch: typeof subtaskRows = [];
        // db.execute() returns raw strings for timestamps, not Date objects.
        // Normalise to epoch-ms for safe comparison.
        const toEpoch = (v: Date | string | null | undefined): number => {
          if (!v) return 0;
          return typeof v === 'string' ? new Date(v).getTime() : v.getTime();
        };
        if (subtaskRows.length > 0) {
          const newest = toEpoch(subtaskRows[0].created_at);
          for (const row of subtaskRows) {
            const t = toEpoch(row.created_at);
            if (newest - t <= BATCH_CLUSTER_MS) {
              latestBatch.push(row);
            } else {
              break; // rows are sorted desc, no more matches possible
            }
          }
        }

        // Compute OVERALL progress across all batches/rounds, deduped by title
        // with best-status-wins. This is what the progress bar should reflect —
        // not just the current batch — so a fresh gap-fill round doesn't reset
        // the bar to 0% when prior rounds already completed real work.
        const statusRank = (s: string): number => {
          switch (s) {
            case "completed": return 4;
            case "in_progress": return 3;
            case "failed": return 2;
            case "backlog": return 1;
            default: return 0;
          }
        };
        const bestByTitle = new Map<string, typeof subtaskRows[number]>();
        for (const row of subtaskRows) {
          const existing = bestByTitle.get(row.title);
          if (!existing || statusRank(row.status) > statusRank(existing.status)) {
            bestByTitle.set(row.title, row);
          }
        }
        currentStageProgress.total = bestByTitle.size;
        for (const r of bestByTitle.values()) {
          if (r.status === "completed") currentStageProgress.completed++;
          else if (r.status === "in_progress") currentStageProgress.running++;
          else if (r.status === "failed") currentStageProgress.failed++;
          else currentStageProgress.pending++;
        }
        // Count distinct rounds (clusters of created_at within BATCH_CLUSTER_MS)
        const sortedTimes = subtaskRows
          .map((r) => toEpoch(r.created_at))
          .sort((a, b) => b - a);
        if (sortedTimes.length > 0) {
          currentStageProgress.rounds = 1;
          for (let i = 1; i < sortedTimes.length; i++) {
            if (sortedTimes[i - 1] - sortedTimes[i] > BATCH_CLUSTER_MS) {
              currentStageProgress.rounds++;
            }
          }
        }

        currentStageSubtasks = latestBatch.map((r) => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          // Map agent_subtasks status to the frontend ScanSubtaskState union
          //   backlog → pending; in_progress → running; completed → completed; failed → failed
          status: r.status === "backlog"
            ? "pending"
            : r.status === "in_progress"
              ? "running"
              : r.status,
          cost_cents: r.cost_cents,
          type: r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40),
        }));
      } catch (subtaskErr) {
        // Non-fatal: subtask/progress features are nice-to-have.
        // Don't let them crash the entire /status endpoint.
        console.error("[Status] Subtask query failed:", subtaskErr);
      } }

      return reply.send({
        id: run.id,
        status: run.status,
        current_stage: run.current_stage,
        current_stage_subtasks: currentStageSubtasks,
        current_stage_progress: currentStageProgress,
        stage_progress: enrichedStageProgress,
        error_message: run.error_message,
        started_at: run.started_at,
        completed_at: run.completed_at,
        artifacts: run.artifacts?.map((a: any) => ({
          id: a.id,
          stage_name: a.stage_name,
          artifact_type: a.artifact_type,
          created_at: a.created_at,
        })),
        // Deduplicate: only return the LATEST gate per stage (by created_at)
        approval_gates: Object.values(
          (run.approvalGates || []).reduce((acc: Record<string, any>, g: any) => {
            const existing = acc[g.stage_name];
            if (!existing || new Date(g.created_at) > new Date(existing.created_at)) {
              acc[g.stage_name] = {
                id: g.id,
                stage_name: g.stage_name,
                status: g.status,
                required_role: g.required_role,
                created_at: g.created_at,
                approved_at: g.approved_at,
              };
            }
            return acc;
          }, {} as Record<string, any>),
        ),
      });
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/status/v2 — Stage-executions-based status
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/status/v2",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Get pipeline status from stage_executions (v2)",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId } = request.params;
      const run = await pipelineService.getPipelineRun(pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      const { PIPELINE_STAGE_ORDER } = await import("@revamp/shared-types/pipeline");
      const stages = await getStatusForRun(pipelineRunId, PIPELINE_STAGE_ORDER);

      // Derive run status from stage states
      const stageEntries = Object.values(stages);
      const allApproved = stageEntries.every(s => s.latest?.approval_status === 'approved');
      const anyRunning = stageEntries.some(s => s.latest?.status === 'running');
      const anyStarted = stageEntries.some(s => s.latest !== null);
      const derivedStatus = allApproved ? 'completed'
        : anyRunning ? 'running'
        : anyStarted ? 'in_progress'
        : 'pending';

      return reply.send({
        id: run.id,
        project_id: run.project_id,
        status: derivedStatus,
        stages,
      });
    },
  );

  /**
   * GET /pipeline/execution/:executionId/output — Get execution output content
   */
  fastify.get<{ Params: { executionId: string } }>(
    "/pipeline/execution/:executionId/output",
    {
      schema: buildRouteSchema({
        params: z.object({ executionId: z.string().uuid() }),
        tags: ["Pipeline"],
        summary: "Get stage execution output content",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { executionId } = request.params;
      const exec = await db.query.stageExecutions.findFirst({
        where: eq(stageExecutions.id, executionId),
        columns: { id: true, output: true, stage_name: true, version: true },
      });
      if (!exec) {
        return reply.status(404).send({ error: "Execution not found" });
      }
      return reply.send({
        id: exec.id,
        stage_name: exec.stage_name,
        version: exec.version,
        output: exec.output,
      });
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/stage/:stage — Execute a stage
   *
   * Returns JSON response. Real-time progress events are pushed to
   * WebSocket topic 'pipeline:<runId>'.
   * Events (via WS): phase, delta, trajectory, validation, validation_finding,
   *   validation_result, complete, error
   */
  fastify.post<{
    Params: { pipelineRunId: string; stage: string };
    Body: z.infer<typeof ExecuteStageSchema>;
  }>(
    "/pipeline/:pipelineRunId/stage/:stage",
    {
      schema: buildRouteSchema({
        params: PipelineStageParamsSchema,
        body: ExecuteStageSchema,
        tags: ["Pipeline"],
        summary: "Execute a pipeline stage (events via WebSocket)",
        description: "Executes the specified stage. Progress events are pushed to WebSocket topic 'pipeline:<runId>'. Subscribe to the topic before calling this endpoint.",
        response: {
          202: {
            type: "object",
            properties: {
              accepted: { type: "boolean" },
              pipelineRunId: { type: "string" },
              stageName: { type: "string" },
              topic: { type: "string" },
              stageRunId: { type: "string" },
              attempt: { type: "number" },
            },
            additionalProperties: true,
          },
          ...errorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId, stage } = request.params;

      if (!validStageNames.includes(stage as PipelineStageName)) {
        return reply.status(400).send({
          error: `Invalid stage: ${stage}. Valid: ${validStageNames.join(", ")}`,
        });
      }

      const stageName = stage as PipelineStageName;
      const body = ExecuteStageSchema.safeParse(request.body || {});
      const templateVars = body.success ? (body.data.template_vars || {}) : {};
      const skipLlmEval = body.success ? body.data.skip_llm_eval : false;
      const modelOverride = body.success ? body.data.model : undefined;
      const composerModelOverride = body.success ? body.data.composer_model : undefined;
      const evaluatorModelOverride = body.success ? body.data.evaluator_model : undefined;
      const promptOverride = body.success ? body.data.prompt_override : undefined;
      const maxTokensOverride = body.success ? body.data.max_tokens : undefined;
      const validationFeedback = body.success ? body.data.validation_feedback : undefined;

      const run = await pipelineService.getPipelineRun(pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      if (run.status === "completed" || run.status === "cancelled") {
        return reply.status(400).send({ error: `Pipeline is ${run.status}, cannot execute stages` });
      }

      // If a previous stage execution crashed (e.g. DB error), the pipeline
      // is stuck in "failed" state. Reset it to "running" so the user can retry.
      if (run.status === "failed") {
        await pipelineService.resetRunStatus(pipelineRunId);
      }

      // ─── Stage prerequisite guardrail ───────────────────────────
      // Ensure all prior stages are completed/approved before allowing execution
      const stageOrder = getStageOrder();
      const currentStageIdx = stageOrder.indexOf(stageName);
      const stageProgress = (run.stage_progress as Record<string, { status?: string }>) || {};

      if (currentStageIdx > 0) {
        for (let i = 0; i < currentStageIdx; i++) {
          const priorStage = stageOrder[i];
          const priorStatus = stageProgress[priorStage]?.status;

          // Allow next stage ONLY when prior stage is explicitly approved or skipped.
          // Approval is a HARD GATE — the stage output must be reviewed before proceeding.
          // This ensures every stage output is validated by a human before the next stage builds on it.
          const doneStatuses = new Set(["approved", "skipped"]);
          if (!doneStatuses.has(priorStatus || "")) {
            const priorConfig = pipelineService.getStageConfig(priorStage);

            // Provide a clear message depending on whether the stage needs approval or hasn't run
            const needsApproval = priorStatus === "completed" || priorStatus === "awaiting_approval";
            const message = needsApproval
              ? `Cannot execute ${stageName}: prior stage "${priorStage}" is awaiting approval. Please review and approve it first.`
              : `Cannot execute ${stageName}: prerequisite stage "${priorStage}" (${priorConfig.name}) has not been completed yet (status: ${priorStatus || "pending"}).`;

            return reply.status(400).send({ error: message });
          }
        }
      }

      // ─── Approval gate enforcement ─────────────────────────────
      // Atomic guard: acquire row lock, check stage status, set to in_progress.
      // This prevents concurrent execution of the same stage — the second request
      // will block on the FOR UPDATE lock until the first sets in_progress, then see
      // the updated status and return 409.
      const lockAcquired = await db.transaction(async (tx) => {
        // Acquire exclusive row lock on the pipeline run
        const lockResult = await tx.execute(
          sql`SELECT stage_progress FROM ${pipelineRuns} WHERE id = ${pipelineRunId} FOR UPDATE`
        );
        const locked = lockResult.rows?.[0] ?? (lockResult as any)[0];
        if (!locked) return { ok: false, error: "Pipeline run not found", code: 404 };

        const sp = (locked.stage_progress as Record<string, { status?: string }>) || {};
        const currentStatus = sp[stageName]?.status;

        if (currentStatus === "in_progress") {
          return { ok: false, error: "Stage is already executing", code: 409 };
        }
        if (currentStatus === "awaiting_approval") {
          const pendingGate = await tx.query.approvalGates.findFirst({
            where: and(
              eq(approvalGates.pipeline_run_id, pipelineRunId),
              eq(approvalGates.stage_name, stageName),
            ),
          });
          if (pendingGate && pendingGate.status === "pending") {
            return {
              ok: false,
              error: `Stage ${stageName} is awaiting approval. Please review and approve or reject before re-running.`,
              code: 400,
            };
          }
        }

        // Atomically set stage to in_progress under the lock
        await pipelineService.updateStageProgress(pipelineRunId, stageName, "in_progress", 0, { conn: tx });
        return { ok: true };
      });

      if (!lockAcquired.ok) {
        return reply.status((lockAcquired as any).code || 409).send({ error: (lockAcquired as any).error });
      }

      // WebSocket topic for real-time event delivery
      const topic = `pipeline:${pipelineRunId}`;

      let accumulatedOutput = "";

      const controller = new AbortController();

      // Stage-level timeout: abort if stage takes longer than 30 minutes.
      // Individual LLM calls have their own timeout (5-10 min via llm-proxy config),
      // but the entire stage (with refinement loops) could exceed that.
      const STAGE_TIMEOUT_MS = 30 * 60 * 1000;
      const stageTimeout = setTimeout(() => {
        publish(topic, "error", { message: "Stage execution timed out after 30 minutes" });
        controller.abort();
      }, STAGE_TIMEOUT_MS);

      // Audit: stage execution started
      const userId = request.user?.sub;
      writeAuditLog({
        userId,
        action: "STAGE_STARTED",
        resourceType: "pipeline_stage",
        resourceId: pipelineRunId,
        changes: { stageName, model: modelOverride, evaluatorModel: evaluatorModelOverride },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      // ─── Create stage run record for persistent history ───
      // Count prior attempts for the same stage in this pipeline run
      const priorAttempts = await db.select({ id: stageRuns.id })
        .from(stageRuns)
        .where(and(eq(stageRuns.pipeline_run_id, pipelineRunId), eq(stageRuns.stage_name, stageName)));
      const attempt = priorAttempts.length + 1;

      const stageRunId = crypto.randomUUID();
      await db.insert(stageRuns).values({
        id: stageRunId,
        pipeline_run_id: pipelineRunId,
        stage_name: stageName,
        attempt,
        status: "running",
        model: modelOverride || process.env.LLM_DEFAULT_MODEL || null,
      });

      // Dual-write: create stage execution record
      let stageExecId: string | null = null;
      try {
        const exec = await createExecution({
          pipelineRunId,
          stageName: stageName as any,
          model: modelOverride || process.env.LLM_DEFAULT_MODEL || undefined,
        });
        stageExecId = exec.id;
      } catch (execErr) {
        console.warn(`[Pipeline] Failed to create stage execution: ${execErr instanceof Error ? execErr.message : execErr}`);
      }

      // Helper: persist a log entry (fire-and-forget, non-blocking)
      const persistLog = (level: string, message: string, phase?: string, detail?: string, metadata?: unknown) => {
        db.insert(stageExecutionLogs).values({
          stage_run_id: stageRunId,
          pipeline_run_id: pipelineRunId,
          stage_name: stageName,
          level,
          phase,
          message,
          detail,
          metadata: metadata ?? undefined,
        }).catch((err) => {
          console.warn(`[Pipeline] Failed to persist log: ${err instanceof Error ? err.message : "unknown"}`);
        });
      };

      persistLog("info", `Stage execution started (attempt ${attempt})`, "initializing");

      // Clean up artifacts from prior attempts so re-runs don't create duplicates
      if (attempt > 1) {
        try {
          await db.delete(stageArtifacts).where(and(
            eq(stageArtifacts.pipeline_run_id, pipelineRunId),
            eq(stageArtifacts.stage_name, stageName),
          ));
          // Clean up stale pending approval gates from prior attempts
          await db.delete(approvalGates).where(
            and(
              eq(approvalGates.pipeline_run_id, pipelineRunId),
              eq(approvalGates.stage_name, stageName),
              eq(approvalGates.status, "pending"),
            ),
          );
          persistLog("info", `Cleaned up artifacts from ${attempt - 1} prior attempt(s)`, "initializing");
        } catch {
          // Non-fatal — duplicates are cosmetic, not blocking
        }
      }

      // ─── Respond immediately, run stage in background ────────
      // With WebSocket, all events flow through the WS topic. The HTTP
      // response is just an acknowledgement. We can't hold the connection
      // open for 5-30 minutes — browsers/proxies will close idle connections.
      reply.status(202).send({
        accepted: true,
        pipelineRunId,
        stageName,
        topic,
        stageRunId,
        attempt,
      });

      // Run stage execution asynchronously (fire-and-forget from HTTP perspective)
      (async () => {
      try {
        let result = await pipelineService.executeStage(
          pipelineRunId,
          stageName,
          templateVars,
          {
            model: modelOverride,
            composerModel: composerModelOverride,
            evaluatorModel: evaluatorModelOverride,
            promptOverride,
            maxTokens: maxTokensOverride,
            validationFeedback,
            onEvent: (event: { phase: string; stageName: string; stageIndex: number; data?: unknown; timestamp?: string }) => {
              publish(topic, "phase", {
                phase: event.phase,
                stageName: event.stageName,
                stageIndex: event.stageIndex,
                data: event.data,
              });

              // Emit dedicated trajectory event for context_retrieval phase
              if (event.phase === "context_retrieval" && event.data) {
                const d = event.data as Record<string, unknown>;
                publish(topic, "trajectory", {
                  pipelineRunId,
                  stageName: event.stageName,
                  trajectory: d.trajectory ?? [],
                  tokensUsed: d.tokensUsed ?? 0,
                  totalTokenBudget: d.totalTokenBudget ?? 0,
                  evolutionMemoriesLoaded: d.evolutionMemoriesLoaded ?? 0,
                  buildDurationMs: d.buildDurationMs ?? 0,
                });

                // Persist trajectory to DB so the Context tab can reload on page refresh
                recordRetrievalTrajectory({
                  pipelineRunId,
                  stageName: event.stageName,
                  totalTokenBudget: (d.totalTokenBudget as number) ?? 0,
                  tokensUsed: (d.tokensUsed as number) ?? 0,
                  trajectory: (d.trajectory as any[]) ?? [],
                  evolutionMemoriesLoaded: (d.evolutionMemoriesLoaded as number) ?? 0,
                  evolutionMemoryIds: (d.evolutionMemoryIds as string[]) ?? [],
                  buildDurationMs: (d.buildDurationMs as number) ?? 0,
                }).catch(() => { /* non-fatal */ });
              }

              // Persist phase events as log entries
              const msg = typeof (event.data as any)?.message === "string"
                ? (event.data as any).message
                : `${event.phase}`;
              persistLog("info", msg, event.phase, undefined, event.data);

              // Scoped broadcast — only clients subscribed to this pipeline
              broadcastToPipeline(pipelineRunId, {
                type: "stage_event",
                pipeline_run_id: pipelineRunId,
                ...event,
              });
            },
            onDelta: (text: string) => {
              publish(topic, "delta", { text });
              accumulatedOutput += text;
            },
            signal: controller.signal,
            skipLlmEval,
          },
        );

        // Safety net: if result.output is empty but we streamed text via onDelta,
        // use the accumulated delta text. This handles cases where streamCompletion
        // loses the accumulated content (long streams, connection edge cases).
        if (!result.output && accumulatedOutput.length > 20) {
          console.warn(`[Pipeline] result.output empty but ${accumulatedOutput.length} chars streamed — using accumulated delta text`);
          result = { ...result, output: accumulatedOutput };
        }

        // Build validation criteria from deterministic + LLM results for the frontend.
        // The frontend expects { passed, score, criteria[], summary } where each criterion
        // has { name, passed, score, feedback }. Map from the core-engine's CheckResult/EvalResult.
        const validationPayload = result.validation ? (() => {
          const v = result.validation;
          const criteria: Array<{ name: string; passed: boolean; score: number; feedback: string }> = [];

          // Map deterministic check results → criteria
          if (v.deterministicResults) {
            for (const cr of v.deterministicResults) {
              criteria.push({
                name: cr.name || cr.type,
                passed: cr.status === "PASS",
                score: Math.round((cr.score ?? 0) * 100),
                feedback: cr.message || (cr.status === "PASS" ? "Passed" : "Failed"),
              });
            }
          }

          // Map LLM evaluation results → criteria
          if (v.llmResults) {
            for (const lr of v.llmResults) {
              criteria.push({
                name: lr.dimension || "LLM Evaluation",
                passed: (lr.score ?? 0) >= 0.6,
                score: Math.round((lr.score ?? 0) * 100),
                feedback: lr.reasoning || "",
              });
            }
          }

          // Map contract violations → criteria (if no deterministic/LLM results)
          if (criteria.length === 0 && v.issues) {
            for (const issue of v.issues) {
              criteria.push({
                name: issue.title || issue.code,
                passed: issue.severity === "INFO",
                score: issue.severity === "ERROR" ? 0 : issue.severity === "WARN" ? 50 : 80,
                feedback: issue.description,
              });
            }
          }

          return {
            passed: v.passed,
            confidenceScore: v.confidenceScore,
            score: v.confidenceScore,
            criteria,
            issueCount: v.issues?.length ?? 0,
            summary: v.recommendations?.slice(0, 3).join("; ") || "",
            recommendations: v.recommendations?.slice(0, 5) ?? [],
          };
        })() : null;

        // Publish individual validation findings before the final result
        if (validationPayload && validationPayload.criteria.length > 0) {
          publish(topic, "validation", {
            phase: "validating",
            stageName: result.stageName,
            stageIndex: result.stageIndex,
          });
          for (const criterion of validationPayload.criteria) {
            publish(topic, "validation_finding", {
              stageName: result.stageName,
              name: criterion.name,
              passed: criterion.passed,
              score: criterion.score,
              feedback: criterion.feedback,
              severity: criterion.passed ? 'info' : criterion.score < 50 ? 'critical' : 'warning',
            });
          }
        }

        publish(topic, "validation_result", validationPayload || {
          passed: true,
          confidenceScore: 100,
          criteria: [],
          summary: "No validation configured",
        });

        // Dual-write: complete stage execution
        if (stageExecId) {
          try {
            await completeExecution({
              executionId: stageExecId,
              output: result.output,
              validation: validationPayload ? {
                passed: validationPayload.passed,
                confidenceScore: validationPayload.confidenceScore,
                criteria: validationPayload.criteria,
                summary: validationPayload.summary,
              } : undefined,
            });
          } catch (execErr) {
            console.warn(`[Pipeline] Failed to complete stage execution: ${execErr instanceof Error ? execErr.message : execErr}`);
          }
        }

        publish(topic, "complete", {
          stageName: result.stageName,
          stageIndex: result.stageIndex,
          outputLength: result.output.length,
          validation: validationPayload,
          refinementCount: result.refinementCount,
          duration: result.duration,
          aborted: result.aborted,
        });

        // Update stage run record with results
        await db.update(stageRuns).set({
          status: result.aborted ? "aborted" : "completed",
          duration_ms: result.duration,
          output_length: result.output.length,
          validation_passed: result.validation?.passed ?? null,
          validation_score: result.validation?.confidenceScore ?? null,
          completed_at: new Date(),
        }).where(eq(stageRuns.id, stageRunId)).catch((err) => {
          const msg = err instanceof Error ? err.message : "DB operation failed";
          persistLog("error", `Failed to update stage run record on completion: ${msg}`, "db_error");
          console.warn(`[Pipeline] DB update failed (stage completion): ${msg}`);
        });

        persistLog("info", `Stage ${result.aborted ? "aborted" : "completed"} (${result.duration}ms)`, "complete");

        // Audit: stage completed
        writeAuditLog({
          userId,
          action: result.aborted ? "STAGE_ABORTED" : "STAGE_COMPLETED",
          resourceType: "pipeline_stage",
          resourceId: pipelineRunId,
          changes: {
            stageName: result.stageName,
            passed: result.validation?.passed ?? null,
            confidenceScore: result.validation?.confidenceScore ?? null,
            refinementCount: result.refinementCount,
            duration: result.duration,
          },
        });

        // Stage completed — result already published via WS events
        persistLog("info", `Stage completed (${result.duration}ms, output: ${result.output?.length || 0} chars)`, "completed");
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : "Unknown error";
        const classified = classifyError(err);
        const userMessage = ERROR_USER_MESSAGES[classified.category] || ERROR_USER_MESSAGES.unknown;

        // Publish rich error event to WebSocket subscribers
        publish(topic, "error", {
          message: userMessage,
          detail: rawMessage,
          category: classified.category,
          shouldRetry: classified.shouldRetry,
          suggestedDelayMs: classified.suggestedDelayMs,
        });

        // Mark stage as failed in stage_progress JSONB so the frontend sync
        // effect picks up the terminal status and stops the elapsed timer.
        // Without this, stage_progress stays at "in_progress" after errors
        // and the timer runs forever on page refresh.
        await pipelineService.updateStageProgress(pipelineRunId, stageName, "failed", 0).catch(() => {});

        // Dual-write: fail stage execution
        if (stageExecId) {
          try {
            await failExecution({ executionId: stageExecId, errorMessage: rawMessage });
          } catch (execErr) {
            console.warn(`[Pipeline] Failed to fail stage execution: ${execErr instanceof Error ? execErr.message : execErr}`);
          }
        }

        // Update stage run record with error
        await db.update(stageRuns).set({
          status: "failed",
          error_message: rawMessage,
          error_category: classified.category,
          completed_at: new Date(),
        }).where(eq(stageRuns.id, stageRunId)).catch((dbErr) => {
          const dbMsg = dbErr instanceof Error ? dbErr.message : "DB operation failed";
          persistLog("error", `Failed to update stage run record on failure: ${dbMsg}`, "db_error");
        });

        persistLog("error", rawMessage, "failed", classified.category);

        // Audit: stage failed
        writeAuditLog({
          userId,
          action: "STAGE_FAILED",
          resourceType: "pipeline_stage",
          resourceId: pipelineRunId,
          changes: {
            stageName,
            error: rawMessage,
            errorCategory: classified.category,
            shouldRetry: classified.shouldRetry,
          },
          ipAddress: request.ip,
        });

        try {
          await pipelineService.failStage(pipelineRunId, `[${classified.category}] ${rawMessage}`);
        } catch {
          // Ignore DB errors during error handling
        }
      } finally {
        clearTimeout(stageTimeout);
      }
      })(); // End of async IIFE — runs in background after 202 response
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/advance — Advance to next stage
   */
  fastify.post<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/advance",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Advance pipeline to the next stage",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const run = await pipelineService.getPipelineRun(request.params.pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      try {
        await pipelineService.advanceStage(request.params.pipelineRunId);
        return reply.send({ message: "Stage advanced" });
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/artifacts — List all artifacts
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/artifacts",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "List all artifacts for a pipeline run",
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const artifacts = await db.query.stageArtifacts.findMany({
        where: eq(stageArtifacts.pipeline_run_id, request.params.pipelineRunId),
      });

      return reply.send(artifacts.map((a) => ({
        id: a.id,
        stage_name: a.stage_name,
        artifact_type: a.artifact_type,
        storage_path: a.storage_path,
        file_size: a.file_size,
        created_at: a.created_at,
      })));
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/artifacts/:stage — Get stage artifacts
   */
  fastify.get<{ Params: { pipelineRunId: string; stage: string } }>(
    "/pipeline/:pipelineRunId/artifacts/:stage",
    {
      schema: buildRouteSchema({
        params: PipelineStageParamsSchema,
        tags: ["Pipeline"],
        summary: "Get artifacts for a specific pipeline stage",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const artifacts = await db.query.stageArtifacts.findMany({
        where: and(
          eq(stageArtifacts.pipeline_run_id, request.params.pipelineRunId),
          eq(stageArtifacts.stage_name, request.params.stage),
        ),
      });

      return reply.send(artifacts);
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/artifacts/:stage/:artifactId — Get single artifact with metadata
   */
  fastify.get<{ Params: { pipelineRunId: string; stage: string; artifactId: string } }>(
    "/pipeline/:pipelineRunId/artifacts/:stage/:artifactId",
    {
      schema: buildRouteSchema({
        params: z.object({
          pipelineRunId: z.string().uuid(),
          stage: z.string(),
          artifactId: z.string().uuid(),
        }),
        tags: ["Pipeline"],
        summary: "Get a single artifact with full metadata",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const artifact = await db.query.stageArtifacts.findFirst({
        where: and(
          eq(stageArtifacts.id, request.params.artifactId),
          eq(stageArtifacts.pipeline_run_id, request.params.pipelineRunId),
        ),
      });
      if (!artifact) return reply.status(404).send({ error: "Artifact not found" });
      return reply.send(artifact);
    },
  );

  /**
   * DELETE /pipeline/:pipelineRunId/artifacts/:stage/:artifactId — Delete an artifact
   */
  fastify.delete<{ Params: { pipelineRunId: string; stage: string; artifactId: string } }>(
    "/pipeline/:pipelineRunId/artifacts/:stage/:artifactId",
    {
      schema: buildRouteSchema({
        params: z.object({
          pipelineRunId: z.string().uuid(),
          stage: z.string(),
          artifactId: z.string().uuid(),
        }),
        tags: ["Pipeline"],
        summary: "Delete an artifact",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const result = await db.delete(stageArtifacts).where(
        and(
          eq(stageArtifacts.id, request.params.artifactId),
          eq(stageArtifacts.pipeline_run_id, request.params.pipelineRunId),
        ),
      );
      return reply.send({ message: "Artifact deleted" });
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/validation/:stage — Get validation results
   */
  fastify.get<{ Params: { pipelineRunId: string; stage: string } }>(
    "/pipeline/:pipelineRunId/validation/:stage",
    {
      schema: buildRouteSchema({
        params: PipelineStageParamsSchema,
        tags: ["Pipeline"],
        summary: "Get validation results for a pipeline stage",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const artifacts = await db.query.stageArtifacts.findMany({
        where: and(
          eq(stageArtifacts.pipeline_run_id, request.params.pipelineRunId),
          eq(stageArtifacts.stage_name, request.params.stage),
          eq(stageArtifacts.artifact_type, "validation_result"),
        ),
        orderBy: (t, { desc }) => [desc(t.created_at)],
        limit: 1,
      });

      if (artifacts.length === 0) {
        return reply.status(404).send({ error: "No validation results for this stage" });
      }

      return reply.send(artifacts[0].metadata);
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/approve/:stage — Approve gate
   */
  fastify.post<{
    Params: { pipelineRunId: string; stage: string };
    Body: z.infer<typeof ApproveGateSchema>;
  }>(
    "/pipeline/:pipelineRunId/approve/:stage",
    {
      schema: buildRouteSchema({
        params: PipelineStageParamsSchema,
        body: ApproveGateSchema,
        tags: ["Pipeline"],
        summary: "Approve an approval gate for a pipeline stage",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId, stage } = request.params;
      const validation = ApproveGateSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      // Find the latest pending gate for this stage
      const gate = await db.query.approvalGates.findFirst({
        where: and(
          eq(approvalGates.pipeline_run_id, pipelineRunId),
          eq(approvalGates.stage_name, stage),
          eq(approvalGates.status, "pending"),
        ),
        orderBy: (table, { desc }) => [desc(table.created_at)],
      });

      if (!gate) {
        return reply.status(404).send({ error: "No pending approval gate found for this stage" });
      }

      if (!["admin", "architect", "sme"].includes(request.user.role)) {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      // Enforce per-stage required role (admin can always approve)
      if (request.user.role !== "admin" && gate.required_role !== request.user.role) {
        return reply.status(403).send({
          error: `This stage requires "${gate.required_role}" role to approve. You have "${request.user.role}".`,
        });
      }

      try {
        // Admin users can force-approve below confidence threshold
        const force = request.user.role === "admin" && validation.data.force === true;
        await pipelineService.approveGate(
          pipelineRunId,
          stage as PipelineStageName,
          request.user.sub,
          validation.data.comment,
          force,
        );

        // Approve ALL pending gates for this stage (handles duplicates from re-runs)
        await db.update(approvalGates)
          .set({ status: "approved", approved_by: request.user.sub, approved_at: new Date(), approval_comment: validation.data.comment })
          .where(and(
            eq(approvalGates.pipeline_run_id, pipelineRunId),
            eq(approvalGates.stage_name, stage),
            eq(approvalGates.status, "pending"),
          ));

        // Publish approval event via WebSocket so all clients update immediately
        publish(`pipeline:${pipelineRunId}`, "stage_approved", {
          stageName: stage,
          approvedBy: request.user.sub,
          comment: validation.data.comment,
          timestamp: new Date().toISOString(),
        });

        writeAuditLog({
          userId: request.user.sub,
          action: "STAGE_APPROVED",
          resourceType: "pipeline_stage",
          resourceId: pipelineRunId,
          changes: { stageName: stage, comment: validation.data.comment },
          ipAddress: request.ip,
        });
        return reply.send({ message: "Gate approved" });
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/reject/:stage — Reject gate
   */
  fastify.post<{
    Params: { pipelineRunId: string; stage: string };
    Body: z.infer<typeof RejectGateSchema>;
  }>(
    "/pipeline/:pipelineRunId/reject/:stage",
    {
      schema: buildRouteSchema({
        params: PipelineStageParamsSchema,
        body: RejectGateSchema,
        tags: ["Pipeline"],
        summary: "Reject an approval gate for a pipeline stage",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId, stage } = request.params;
      const validation = RejectGateSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      const gate = await db.query.approvalGates.findFirst({
        where: and(
          eq(approvalGates.pipeline_run_id, pipelineRunId),
          eq(approvalGates.stage_name, stage),
        ),
      });

      if (!gate) {
        return reply.status(404).send({ error: "Approval gate not found" });
      }

      if (!["admin", "architect", "sme"].includes(request.user.role)) {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      try {
        await pipelineService.rejectGate(
          pipelineRunId,
          stage as PipelineStageName,
          request.user.sub,
          validation.data.reason,
        );

        publish(`pipeline:${pipelineRunId}`, "stage_rejected", {
          stageName: stage,
          rejectedBy: request.user.sub,
          reason: validation.data.reason,
          timestamp: new Date().toISOString(),
        });

        writeAuditLog({
          userId: request.user.sub,
          action: "STAGE_REJECTED",
          resourceType: "pipeline_stage",
          resourceId: pipelineRunId,
          changes: { stageName: stage, reason: validation.data.reason },
          ipAddress: request.ip,
        });
        return reply.send({ message: "Gate rejected" });
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * SDK-experimental: POST /pipeline/:pipelineRunId/diagnose
   *
   * Runs the Claude SDK diagnostic agent against a pipeline run.
   * The agent investigates failed/problematic runs using read-only tools
   * and returns a structured root-cause + suggested-fixes report.
   *
   * NET-NEW feature — does NOT replace any existing orchestrator.
   */
  fastify.post<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/diagnose",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Run diagnostic agent to investigate pipeline failures",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId } = request.params;

      try {
        const { runDiagnosticAgent } = await import("../services/diagnostic-agent.js");
        const report = await runDiagnosticAgent(pipelineRunId);

        writeAuditLog({
          userId: request.user.sub,
          action: "DIAGNOSTIC_RUN",
          resourceType: "pipeline_run",
          resourceId: pipelineRunId,
          changes: {
            status: report.status,
            findingsCount: report.findings.length,
            toolCalls: report.toolCallsCount,
          },
          ipAddress: request.ip,
        });

        return reply.send(report);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        console.error("[DiagnosticAgent] Failed:", message);
        if (stack) console.error(stack);
        return reply.status(500).send({
          error: message,
        });
      }
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/generate-prompts — Regenerate tailored prompts for stages 2-8
   *
   * Uses SCAN output + BREE analysis + project config to generate
   * stage-specific prompts and validation prompts.
   */
  fastify.post<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/generate-prompts",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Regenerate tailored prompts for stages 2-8",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId } = request.params;

      try {
        const run = await db.query.pipelineRuns.findFirst({
          where: eq(pipelineRuns.id, pipelineRunId),
          columns: { project_id: true },
        });
        if (!run) return reply.status(404).send({ error: "Pipeline run not found" });

        const { generateAndSaveProjectPrompts } = await import("../services/prompt-generator.js");
        const result = await generateAndSaveProjectPrompts(run.project_id, pipelineRunId);

        writeAuditLog({
          userId: request.user.sub,
          action: "PROMPTS_GENERATED",
          resourceType: "pipeline_stage",
          resourceId: pipelineRunId,
          changes: { stagesPopulated: result.stagesPopulated },
          ipAddress: request.ip,
        });

        return reply.send({
          message: `Generated tailored prompts for ${result.stagesPopulated} stages`,
          stagesPopulated: result.stagesPopulated,
        });
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Prompt generation failed",
        });
      }
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/refine — Refine a section of stage output
   *
   * Takes a markdown section + user feedback, returns refined content via LLM.
   */
  fastify.post<{
    Params: { pipelineRunId: string };
    Body: z.infer<typeof RefineSectionSchema>;
  }>(
    "/pipeline/:pipelineRunId/refine",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        body: RefineSectionSchema,
        tags: ["Pipeline"],
        summary: "Refine a section of stage output with user feedback",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId } = request.params;
      const validation = RefineSectionSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const run = await pipelineService.getPipelineRun(pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      try {
        const refined = await pipelineService.refineSection(
          pipelineRunId,
          validation.data.stage_name,
          validation.data.section_title,
          validation.data.section_content,
          validation.data.user_feedback,
          validation.data.full_text,
        );

        return reply.send({ refined_content: refined });
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "Refine failed",
        });
      }
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/chat — Interactive chat for Evolve stage
   *
   * Sends a message and streams the LLM response via WebSocket.
   * Subscribe to topic 'chat:<runId>:EVOLVE' before calling this endpoint.
   */
  fastify.post<{
    Params: { pipelineRunId: string };
    Body: z.infer<typeof ChatMessageSchema>;
  }>(
    "/pipeline/:pipelineRunId/chat",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        body: ChatMessageSchema,
        tags: ["Pipeline"],
        summary: "Interactive chat for Evolve stage (events via WebSocket)",
        description: "Sends a message. Response streamed via WebSocket topic 'chat:<runId>:EVOLVE'. Subscribe before calling.",
        response: {
          200: { type: "object", properties: { success: { type: "boolean" }, content: { type: "string" } }, additionalProperties: true },
          ...errorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId } = request.params;
      const validation = ChatMessageSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const run = await pipelineService.getPipelineRun(pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      const topic = `chat:${pipelineRunId}:EVOLVE`;
      const controller = new AbortController();
      request.raw.on("close", () => { controller.abort(); });

      try {
        const content = await pipelineService.chat(
          pipelineRunId,
          validation.data.message,
          validation.data.history,
          (deltaText: string) => {
            publish(topic, "delta", { text: deltaText });
          },
          controller.signal,
        );

        publish(topic, "complete", { content });
        return reply.send({ success: true, content });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return reply.status(499).send({ error: "Client disconnected" });
        }
        const message = err instanceof Error ? err.message : "Chat failed";
        publish(topic, "error", { message });
        return reply.status(500).send({ error: message });
      }
    },
  );

  /**
   * GET /audit-logs — Project-scoped audit logs
   */
  fastify.get<{ Querystring: { project_id?: string; limit?: string } }>(
    "/audit-logs",
    {
      schema: buildRouteSchema({
        querystring: z.object({
          project_id: z.string().uuid().optional(),
          limit: z.string().optional(),
        }),
        tags: ["Pipeline"],
        summary: "List project-scoped audit logs",
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const projectId = request.query.project_id;
      const limit = Math.min(parseInt(request.query.limit || "100", 10), 500);

      const conditions = projectId
        ? eq(auditLogs.resource_id, projectId)
        : undefined;

      const logs = await db.query.auditLogs.findMany({
        where: conditions,
        limit,
        orderBy: desc(auditLogs.created_at),
      });

      return reply.send({ logs });
    },
  );

  // ─── Stage Run History & Execution Logs ──────────────────────────

  /**
   * GET /pipeline/:pipelineRunId/runs — List all stage run attempts for a pipeline
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/runs",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "List all stage run attempts for a pipeline",
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const runs = await db.query.stageRuns.findMany({
        where: eq(stageRuns.pipeline_run_id, request.params.pipelineRunId),
        orderBy: desc(stageRuns.created_at),
      });
      return reply.send(runs);
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/runs/:stageName — Stage run history for a specific stage
   */
  fastify.get<{ Params: { pipelineRunId: string; stageName: string } }>(
    "/pipeline/:pipelineRunId/runs/:stageName",
    {
      schema: buildRouteSchema({
        params: z.object({
          pipelineRunId: z.string().uuid(),
          stageName: z.string(),
        }),
        tags: ["Pipeline"],
        summary: "Get stage run history for a specific stage",
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const runs = await db.query.stageRuns.findMany({
        where: and(
          eq(stageRuns.pipeline_run_id, request.params.pipelineRunId),
          eq(stageRuns.stage_name, request.params.stageName),
        ),
        orderBy: desc(stageRuns.created_at),
      });
      return reply.send(runs);
    },
  );

  /**
   * GET /pipeline/:pipelineRunId/logs/:stageName — Execution logs for a stage
   * Returns the logs from the most recent run attempt (or a specific stageRunId via query param)
   */
  fastify.get<{ Params: { pipelineRunId: string; stageName: string }; Querystring: { stage_run_id?: string } }>(
    "/pipeline/:pipelineRunId/logs/:stageName",
    {
      schema: buildRouteSchema({
        params: z.object({
          pipelineRunId: z.string().uuid(),
          stageName: z.string(),
        }),
        querystring: z.object({
          stage_run_id: z.string().uuid().optional(),
        }),
        tags: ["Pipeline"],
        summary: "Get execution logs for a stage (most recent run or specific run)",
      }),
      onRequest: [fastify.authenticate, fastify.requirePipelineAccess],
    },
    async (request, reply) => {
      const { pipelineRunId, stageName } = request.params;
      const stageRunId = request.query.stage_run_id;

      if (stageRunId) {
        // Fetch logs for a specific stage run
        const logs = await db.query.stageExecutionLogs.findMany({
          where: eq(stageExecutionLogs.stage_run_id, stageRunId),
          orderBy: stageExecutionLogs.created_at,
        });
        return reply.send(logs);
      }

      // Default: fetch logs from the most recent stage run
      const [latestRun] = await db.query.stageRuns.findMany({
        where: and(
          eq(stageRuns.pipeline_run_id, pipelineRunId),
          eq(stageRuns.stage_name, stageName),
        ),
        orderBy: desc(stageRuns.created_at),
        limit: 1,
      });

      if (!latestRun) {
        return reply.send([]);
      }

      const logs = await db.query.stageExecutionLogs.findMany({
        where: eq(stageExecutionLogs.stage_run_id, latestRun.id),
        orderBy: stageExecutionLogs.created_at,
      });

      return reply.send(logs);
    },
  );

  // ═══ MODERNIZED FILES ══════════════════════════════════════════

  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/modernized-files",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "List modernized files generated by the pipeline",
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const files = await db.query.modernizedFiles.findMany({
        where: eq(modernizedFiles.pipeline_run_id, request.params.pipelineRunId),
        columns: { id: true, file_path: true, file_name: true, language: true, file_size: true, is_new: true, created_at: true },
        orderBy: modernizedFiles.file_path,
      });
      return reply.send({ files });
    },
  );

  fastify.get<{ Params: { pipelineRunId: string; fileId: string } }>(
    "/pipeline/:pipelineRunId/modernized-files/:fileId",
    {
      schema: buildRouteSchema({
        params: z.object({
          pipelineRunId: z.string().uuid(),
          fileId: z.string().uuid(),
        }),
        tags: ["Pipeline"],
        summary: "Get a single modernized file with content",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const file = await db.query.modernizedFiles.findFirst({
        where: and(
          eq(modernizedFiles.id, request.params.fileId),
          eq(modernizedFiles.pipeline_run_id, request.params.pipelineRunId),
        ),
      });
      if (!file) return reply.status(404).send({ error: "File not found" });
      return reply.send(file);
    },
  );

  // ═══ TRACEABILITY MATRIX ═══════════════════════════════════════

  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/traceability",
    {
      schema: buildRouteSchema({
        params: PipelineRunParamsSchema,
        tags: ["Pipeline"],
        summary: "Get traceability matrix entries for a pipeline run",
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const entries = await db.query.traceabilityEntries.findMany({
        where: eq(traceabilityEntries.pipeline_run_id, request.params.pipelineRunId),
        orderBy: traceabilityEntries.rule_id,
      });
      return reply.send({ entries });
    },
  );

  // ═══ RESET STAGE (admin) ══════════════════════════════════════
  // Resets a stage back to pending so it can be re-executed.
  fastify.post<{ Params: { pipelineRunId: string; stage: string } }>(
    "/pipeline/:pipelineRunId/reset/:stage",
    {
      schema: buildRouteSchema({
        params: PipelineStageParamsSchema,
        tags: ["Pipeline"],
        summary: "Reset a stage back to pending for re-execution",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { pipelineRunId, stage } = request.params;
      await pipelineService.updateStageProgress(pipelineRunId, stage as PipelineStageName, "pending", 0);
      return reply.send({ ok: true, stage, status: "pending" });
    },
  );

  // ═══ TEST LLM CREDENTIALS ════════════════════════════════════
  // Sends a minimal "ping" completion to verify credentials work before running the pipeline.
  fastify.post<{ Params: { projectId: string } }>(
    "/pipeline/test-credentials/:projectId",
    {
      schema: buildRouteSchema({
        params: z.object({ projectId: z.string().uuid() }),
        tags: ["Pipeline"],
        summary: "Test LLM credentials with a minimal ping request",
        response: { ...errorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId } = request.params;

      try {
        const project = await db.query.projects.findFirst({
          where: eq(projects.id, projectId),
        });
        if (!project) return reply.status(404).send({ error: "Project not found" });

        // Extract BYOK credentials (same logic as executeStage)
        const settings = (project as any).settings as Record<string, unknown> | null;
        const llmProviders = (
          (settings?.llmProviders as Record<string, unknown>[])
          || (settings?.llm_providers as Record<string, unknown>[])
          || []
        );

        let credentials: import("../services/llm-proxy.js").ProjectCredentials | undefined;
        let providerName = "default";

        if (llmProviders.length > 0) {
          const provider = (llmProviders.find((p: any) => p.is_default) || llmProviders[0]) as any;
          const ptype = provider.provider_type as string;
          const apiKeyField = provider.api_key_encrypted as string || "";
          providerName = ptype;

          credentials = { provider: ptype };
          if (ptype === "bedrock") {
            let bearerToken: string | undefined;
            let parsed: Record<string, string> | undefined;
            if (typeof apiKeyField === "string" && apiKeyField.startsWith("{")) {
              try {
                parsed = JSON.parse(apiKeyField);
                bearerToken = parsed?.bearerToken || parsed?.bearer_token || parsed?.apiKey || parsed?.api_key;
              } catch { /* */ }
            } else if (typeof apiKeyField === "string" && apiKeyField.length > 10) {
              bearerToken = apiKeyField;
            }
            if (bearerToken) {
              credentials.aws_bearer_token = bearerToken;
              credentials.aws_region = parsed?.region || parsed?.aws_region || "us-east-2";
            } else if (parsed) {
              credentials.aws_access_key_id = parsed.accessKeyId || parsed.aws_access_key_id || "";
              credentials.aws_secret_access_key = parsed.secretAccessKey || parsed.aws_secret_access_key || "";
              credentials.aws_session_token = parsed.sessionToken || parsed.aws_session_token || "";
              credentials.aws_region = parsed.region || parsed.aws_region || "us-east-2";
            }
          } else if (ptype === "anthropic") {
            credentials.anthropic_api_key = apiKeyField;
          } else if (ptype === "openai") {
            credentials.openai_api_key = apiKeyField;
          } else if (ptype === "gemini") {
            credentials.gemini_api_key = apiKeyField;
          }
        }

        const { llmProxyService } = await import("../services/llm-proxy.js");
        const callFn = llmProxyService.createCallFn({
          maxTokens: 32,
          credentials,
        });

        const start = Date.now();
        const result = await callFn({
          systemPrompt: "Respond with exactly: OK",
          userPrompt: "Ping",
        });
        const latencyMs = Date.now() - start;

        return reply.send({
          ok: true,
          provider: providerName,
          response: result.slice(0, 50),
          latencyMs,
        });
      } catch (err: any) {
        const msg = err?.message || String(err);
        return reply.status(400).send({
          ok: false,
          error: msg.includes("403") || msg.includes("401") || msg.includes("Authentication")
            ? `Credential error: ${msg}`
            : `LLM error: ${msg}`,
        });
      }
    },
  );
}
