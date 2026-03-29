/**
 * Pipeline Routes — API endpoints for the 8-stage modernization pipeline.
 *
 * Endpoints:
 *   POST   /pipeline/start              → Create pipeline run
 *   GET    /pipeline/:id/status         → Get pipeline status
 *   POST   /pipeline/:id/stage/:stage   → Execute a stage (SSE streaming)
 *   POST   /pipeline/:id/advance        → Advance to next stage
 *   GET    /pipeline/:id/artifacts      → List all artifacts
 *   GET    /pipeline/:id/artifacts/:stage → Get stage artifacts
 *   POST   /pipeline/:id/approve/:stage → Approve gate
 *   POST   /pipeline/:id/reject/:stage  → Reject gate
 *   GET    /pipeline/:id/validation/:stage → Get validation results
 *   POST   /pipeline/:id/refine          → Refine a section of stage output
 *   POST   /pipeline/:id/chat            → Interactive chat for Evolve stage (SSE)
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/db/index.js";
import { stageArtifacts, approvalGates, auditLogs, stageRuns, stageExecutionLogs, projectMembers, pipelineRuns, users, projects } from "@/db/schema.js";
import { eq, and, desc, inArray } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { getStageOrder, classifyError } from "@revamp/core-engine";
import { pipelineService } from "@/services/pipeline.js";
import { broadcastToPipeline } from "@/plugins/websocket.js";
import { recordRetrievalTrajectory } from "@/services/retrieval-observability.js";

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
  /** Override evaluator/validation model for this stage */
  evaluator_model: z.string().optional(),
});

const ApproveGateSchema = z.object({
  comment: z.string().optional(),
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

// ─── ROUTES ─────────────────────────────────────────────────────

export async function pipelineRoutes(fastify: FastifyInstance) {
  /**
   * GET /pipeline/:pipelineRunId/history — Execution history, approvals, prompt changes
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/history",
    { onRequest: [fastify.authenticate] },
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
    { onRequest: [fastify.authenticate] },
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
    async (request, reply) => {
      const run = await pipelineService.getPipelineRun(request.params.pipelineRunId);
      if (!run) {
        return reply.status(404).send({ error: "Pipeline run not found" });
      }

      return reply.send({
        id: run.id,
        status: run.status,
        current_stage: run.current_stage,
        stage_progress: run.stage_progress,
        error_message: run.error_message,
        started_at: run.started_at,
        completed_at: run.completed_at,
        artifacts: run.artifacts?.map((a: any) => ({
          id: a.id,
          stage_name: a.stage_name,
          artifact_type: a.artifact_type,
          created_at: a.created_at,
        })),
        approval_gates: run.approvalGates?.map((g: any) => ({
          id: g.id,
          stage_name: g.stage_name,
          status: g.status,
          required_role: g.required_role,
        })),
      });
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/stage/:stage — Execute a stage
   *
   * Returns SSE stream for real-time progress.
   * Events:
   *   event: phase     → { phase, stageName, stageIndex }
   *   event: delta     → { text } (incremental LLM text delta)
   *   event: complete  → { output, validation, duration }
   *   event: error     → { message }
   */
  fastify.post<{
    Params: { pipelineRunId: string; stage: string };
    Body: z.infer<typeof ExecuteStageSchema>;
  }>(
    "/pipeline/:pipelineRunId/stage/:stage",
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
      const evaluatorModelOverride = body.success ? body.data.evaluator_model : undefined;

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

          // Only "approved" or "skipped" count as truly done.
          // "completed" and "awaiting_approval" mean the stage finished but
          // the human hasn't reviewed/approved yet — block the next stage.
          if (priorStatus !== "approved" && priorStatus !== "skipped") {
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
      // If THIS stage already has a pending approval gate (e.g. re-run attempt
      // after completion), block until the existing gate is resolved.
      const currentStatus = stageProgress[stageName]?.status;
      if (currentStatus === "awaiting_approval") {
        const pendingGate = await db.query.approvalGates.findFirst({
          where: and(
            eq(approvalGates.pipeline_run_id, pipelineRunId),
            eq(approvalGates.stage_name, stageName),
          ),
        });
        if (pendingGate && pendingGate.status === "pending") {
          return reply.status(400).send({
            error: `Stage ${stageName} is awaiting approval. Please review and approve or reject before re-running.`,
          });
        }
      }

      // SSE response — must set CORS headers manually since reply.raw bypasses Fastify plugins
      const origin = request.headers.origin || process.env.CORS_ORIGIN || "http://localhost:3001";

      // Prevent socket timeouts during long LLM calls (matches legacy-bridge pattern)
      request.raw.socket.setTimeout(0);
      request.raw.socket.setKeepAlive(true, 30_000);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      });

      let closed = false;
      const sendSSE = (event: string, data: unknown) => {
        if (closed) return;
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          closed = true;
        }
      };

      // Keepalive heartbeat every 15s to prevent proxies/browsers closing the connection
      const keepalive = setInterval(() => {
        if (closed) { clearInterval(keepalive); return; }
        try { reply.raw.write(": keepalive\n\n"); } catch { closed = true; }
      }, 15_000);

      const controller = new AbortController();
      request.raw.on("close", () => { closed = true; clearInterval(keepalive); controller.abort(); });

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
        }).catch(() => { /* non-fatal */ });
      };

      persistLog("info", `Stage execution started (attempt ${attempt})`, "initializing");

      // Clean up artifacts from prior attempts so re-runs don't create duplicates
      if (attempt > 1) {
        try {
          await db.delete(stageArtifacts).where(and(
            eq(stageArtifacts.pipeline_run_id, pipelineRunId),
            eq(stageArtifacts.stage_name, stageName),
          ));
          persistLog("info", `Cleaned up artifacts from ${attempt - 1} prior attempt(s)`, "initializing");
        } catch {
          // Non-fatal — duplicates are cosmetic, not blocking
        }
      }

      try {
        const result = await pipelineService.executeStage(
          pipelineRunId,
          stageName,
          templateVars,
          {
            model: modelOverride,
            evaluatorModel: evaluatorModelOverride,
            onEvent: (event: { phase: string; stageName: string; stageIndex: number; data?: unknown; timestamp?: string }) => {
              sendSSE("phase", {
                phase: event.phase,
                stageName: event.stageName,
                stageIndex: event.stageIndex,
                data: event.data,
              });

              // Emit dedicated trajectory event for context_retrieval phase
              if (event.phase === "context_retrieval" && event.data) {
                const d = event.data as Record<string, unknown>;
                sendSSE("trajectory", {
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
              sendSSE("delta", { text });
            },
            signal: controller.signal,
            skipLlmEval,
          },
        );

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

        sendSSE("complete", {
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
        }).where(eq(stageRuns.id, stageRunId)).catch(() => {});

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
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : "Unknown error";
        const classified = classifyError(err);
        const userMessage = ERROR_USER_MESSAGES[classified.category] || ERROR_USER_MESSAGES.unknown;

        // Send rich error event to frontend
        sendSSE("error", {
          message: userMessage,
          detail: rawMessage,
          category: classified.category,
          shouldRetry: classified.shouldRetry,
          suggestedDelayMs: classified.suggestedDelayMs,
        });

        // Update stage run record with error
        await db.update(stageRuns).set({
          status: "failed",
          error_message: rawMessage,
          error_category: classified.category,
          completed_at: new Date(),
        }).where(eq(stageRuns.id, stageRunId)).catch(() => {});

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
        clearInterval(keepalive);
        reply.raw.end();
      }
    },
  );

  /**
   * POST /pipeline/:pipelineRunId/advance — Advance to next stage
   */
  fastify.post<{ Params: { pipelineRunId: string } }>(
    "/pipeline/:pipelineRunId/advance",
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
   * GET /pipeline/:pipelineRunId/validation/:stage — Get validation results
   */
  fastify.get<{ Params: { pipelineRunId: string; stage: string } }>(
    "/pipeline/:pipelineRunId/validation/:stage",
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
    async (request, reply) => {
      const artifact = await db.query.stageArtifacts.findFirst({
        where: and(
          eq(stageArtifacts.pipeline_run_id, request.params.pipelineRunId),
          eq(stageArtifacts.stage_name, request.params.stage),
          eq(stageArtifacts.artifact_type, "validation_result"),
        ),
      });

      if (!artifact) {
        return reply.status(404).send({ error: "No validation results for this stage" });
      }

      return reply.send(artifact.metadata);
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
    async (request, reply) => {
      const { pipelineRunId, stage } = request.params;
      const validation = ApproveGateSchema.safeParse(request.body);
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
        await pipelineService.approveGate(
          pipelineRunId,
          stage as PipelineStageName,
          request.user.sub,
          validation.data.comment,
        );
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
   * POST /pipeline/:pipelineRunId/refine — Refine a section of stage output
   *
   * Takes a markdown section + user feedback, returns refined content via LLM.
   */
  fastify.post<{
    Params: { pipelineRunId: string };
    Body: z.infer<typeof RefineSectionSchema>;
  }>(
    "/pipeline/:pipelineRunId/refine",
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
   * Streams LLM response via SSE for real-time chat in the Evolve panel.
   * Includes pipeline context (prior stage outputs) for informed responses.
   */
  fastify.post<{
    Params: { pipelineRunId: string };
    Body: z.infer<typeof ChatMessageSchema>;
  }>(
    "/pipeline/:pipelineRunId/chat",
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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

      // SSE response
      const origin = request.headers.origin || process.env.CORS_ORIGIN || "http://localhost:3001";
      request.raw.socket.setTimeout(0);
      request.raw.socket.setKeepAlive(true, 30_000);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      });

      let chatClosed = false;
      const sendChatSSE = (event: string, data: unknown) => {
        if (chatClosed) return;
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch { chatClosed = true; }
      };

      const chatKeepalive = setInterval(() => {
        if (chatClosed) { clearInterval(chatKeepalive); return; }
        try { reply.raw.write(": keepalive\n\n"); } catch { chatClosed = true; }
      }, 15_000);

      const controller = new AbortController();
      request.raw.on("close", () => { chatClosed = true; clearInterval(chatKeepalive); controller.abort(); });

      try {
        const content = await pipelineService.chat(
          pipelineRunId,
          validation.data.message,
          validation.data.history,
          (deltaText: string) => {
            sendChatSSE("delta", { text: deltaText });
          },
          controller.signal,
        );

        sendChatSSE("complete", { content });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // Client disconnected
        } else {
          const message = err instanceof Error ? err.message : "Chat failed";
          sendChatSSE("error", { message });
        }
      } finally {
        clearInterval(chatKeepalive);
        reply.raw.end();
      }
    },
  );

  /**
   * GET /audit-logs — Project-scoped audit logs
   */
  fastify.get<{ Querystring: { project_id?: string; limit?: string } }>(
    "/audit-logs",
    { onRequest: [fastify.authenticate] },
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
    { onRequest: [fastify.authenticate, fastify.requirePipelineAccess] },
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
}
