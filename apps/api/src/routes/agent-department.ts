/**
 * Agent Department Routes — API endpoints for the Agent Department system.
 *
 * Endpoints:
 *   GET    /agent-department/personas              — list personas (with filters)
 *   GET    /agent-department/personas/:id           — get persona detail
 *   POST   /agent-department/personas               — create persona
 *   PATCH  /agent-department/personas/:id           — update persona
 *   DELETE /agent-department/personas/:id           — soft delete persona
 *   POST   /agent-department/personas/:id/assign    — assign task to agent
 *   POST   /agent-department/assignments/:id/checkout — atomic checkout
 *   POST   /agent-department/assignments/:id/complete — complete assignment
 *   POST   /agent-department/assignments/:id/escalate — escalate to manager
 *   GET    /agent-department/dashboard               — department overview
 *   GET    /agent-department/personas/:id/costs       — cost history for agent
 *   GET    /agent-department/personas/:id/budget      — budget status for agent
 *   POST   /agent-department/personas/:id/resume      — resume a paused agent (admin only)
 *   POST   /agent-department/reconcile-budgets        — trigger manual budget reconciliation (admin only)
 *   POST   /agent-department/match                    — skill-match agents for a task
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildRouteSchema } from "@/lib/zod-to-jsonschema.js";
import {
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  softDeletePersona,
  assignTask,
  checkoutTask,
  completeTask,
  escalateTask,
  getAgentCosts,
  getAgentDashboard,
  getMatchableAgents,
  recordCostEvent,
  checkBudget,
  listEscalatedAssignments,
  getAgentActivityHistory,
} from "@/services/agent-department.js";
import {
  getSessionChain,
  getAgentSessions,
  buildSessionContext,
  compactSessionChain,
} from "@/services/agent-sessions.js";
import {
  retrieveEvolutionMemories,
  supersedeMemory,
} from "@/services/agent-evolution.js";
import {
  getRetrievalTrajectories,
  getStageTrajectory,
} from "@/services/retrieval-observability.js";
import {
  getSubordinates,
  getReportingChain,
  getDepartmentTree,
  createSubtask,
  assignSubtask,
  completeSubtask,
  listSubtasks,
} from "@/services/agent-delegation.js";
import {
  getAgentBudgetStatus,
  reconcileMonthlyBudgets,
  resumeAgent,
} from "@/services/budget-enforcement.js";
import { matchAgentToTask, type TaskRequirements } from "@revamp/core-engine";
import type { AgentPersona } from "@revamp/shared-types/agent";

// ─── SCHEMAS ────────────────────────────────────────────────────

const CreatePersonaSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  role: z.enum(["director", "lead", "specialist"]),
  department: z.enum(["discovery", "execution", "qa", "pm"]),
  system_prompt: z.string().min(1),
  skills: z.array(z.any()).optional(),
  tech_stack: z.array(z.string()).optional(),
  legacy_expertise: z.array(z.string()).optional(),
  modern_expertise: z.array(z.string()).optional(),
  tool_permissions: z.array(z.string()).optional(),
  stage_permissions: z.array(z.string()).optional(),
  preferred_provider: z.string().optional(),
  preferred_model: z.string().optional(),
  evaluator_model: z.string().optional(),
  max_concurrent_tasks: z.number().int().min(1).max(20).optional(),
  reports_to: z.string().uuid().optional(),
  can_delegate: z.boolean().optional(),
  monthly_budget_cents: z.number().int().min(0).optional(),
  lifetime_budget_cents: z.number().int().min(0).optional(),
  hard_stop_enabled: z.boolean().optional(),
  warning_threshold: z.string().optional(),
  session_compaction_threshold: z.number().int().optional(),
  memory_strategy: z.enum(["full", "summary", "none"]).optional(),
});

const UpdatePersonaSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(["idle", "working", "paused", "disabled"]).optional(),
  pause_reason: z.string().nullable().optional(),
  system_prompt: z.string().min(1).optional(),
  skills: z.array(z.any()).optional(),
  tech_stack: z.array(z.string()).optional(),
  tool_permissions: z.array(z.string()).optional(),
  stage_permissions: z.array(z.string()).optional(),
  preferred_provider: z.string().optional(),
  preferred_model: z.string().optional(),
  evaluator_model: z.string().optional(),
  max_concurrent_tasks: z.number().int().min(1).max(20).optional(),
  reports_to: z.string().uuid().optional(),
  can_delegate: z.boolean().optional(),
  monthly_budget_cents: z.number().int().min(0).optional(),
  hard_stop_enabled: z.boolean().optional(),
  warning_threshold: z.string().optional(),
  memory_strategy: z.enum(["full", "summary", "none"]).optional(),
});

const AssignTaskSchema = z.object({
  pipeline_run_id: z.string().uuid(),
  stage_name: z.string().min(1),
  match_score: z.number().optional(),
  assigned_by: z.string().uuid().optional(),
});

const CheckoutSchema = z.object({
  run_id: z.string().uuid(),
});

const CompleteTaskSchema = z.object({
  result: z.record(z.any()),
  cost_cents: z.number().int().min(0),
  tokens_used: z.number().int().min(0),
  refinement_count: z.number().int().min(0).optional(),
});

const EscalateSchema = z.object({
  reason: z.string().min(1),
});

const MatchSchema = z.object({
  keywords: z.array(z.string()),
  tech_stack: z.array(z.string()).optional(),
  stage_name: z.string(),
  min_proficiency: z.enum(["intermediate", "advanced", "expert"]).optional(),
});

// ─── Common response shapes ────────────────────────────────────

const ErrorResponse = { type: "object" as const, properties: { error: { type: "string" } } };
const MessageResponse = { type: "object" as const, properties: { message: { type: "string" } } };
const SuccessResponse = { type: "object" as const, properties: { success: { type: "boolean" } } };
const IdParams = z.object({ id: z.string().uuid() });
const DeptParams = z.object({ dept: z.string().min(1) });
const IdAndTaskIdParams = z.object({ id: z.string().uuid(), taskId: z.string().uuid() });
const PipelineRunIdParams = z.object({ pipelineRunId: z.string().uuid() });
const PipelineRunAndStageParams = z.object({ pipelineRunId: z.string().uuid(), stageName: z.string().min(1) });

// ─── ROUTES ─────────────────────────────────────────────────────

export async function agentDepartmentRoutes(fastify: FastifyInstance) {
  /**
   * GET /agent-department/personas — list personas
   */
  fastify.get<{ Querystring: { department?: string; role?: string; status?: string } }>(
    "/agent-department/personas",
    {
      schema: buildRouteSchema({
        querystring: z.object({ department: z.string().optional(), role: z.string().optional(), status: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "List agent personas with optional filters",
        response: { 200: { type: "array", items: {} } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const personas = await listPersonas({
        department: request.query.department,
        role: request.query.role,
        status: request.query.status,
      });
      return reply.send(personas);
    },
  );

  /**
   * GET /agent-department/personas/:id — get persona detail
   */
  fastify.get<{ Params: { id: string } }>(
    "/agent-department/personas/:id",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Department"],
        summary: "Get agent persona detail by ID",
        response: { 200: {}, 404: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const persona = await getPersona(request.params.id);
      if (!persona) {
        return reply.status(404).send({ error: "Agent persona not found" });
      }
      return reply.send(persona);
    },
  );

  /**
   * POST /agent-department/personas — create persona
   */
  fastify.post<{ Body: z.infer<typeof CreatePersonaSchema> }>(
    "/agent-department/personas",
    {
      schema: buildRouteSchema({
        body: CreatePersonaSchema,
        tags: ["Agent Department"],
        summary: "Create a new agent persona",
        response: { 201: {}, 400: ErrorResponse, 409: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const validation = CreatePersonaSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      try {
        const persona = await createPersona(validation.data);
        return reply.status(201).send(persona);
      } catch (error: any) {
        if (error.code === "23505") {
          return reply.status(409).send({ error: "Agent with this slug already exists" });
        }
        throw error;
      }
    },
  );

  /**
   * PATCH /agent-department/personas/:id — update persona
   */
  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof UpdatePersonaSchema> }>(
    "/agent-department/personas/:id",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: UpdatePersonaSchema,
        tags: ["Agent Department"],
        summary: "Update an agent persona",
        response: { 200: {}, 400: ErrorResponse, 404: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const validation = UpdatePersonaSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const updated = await updatePersona(request.params.id, validation.data);
      if (!updated) {
        return reply.status(404).send({ error: "Agent persona not found" });
      }
      return reply.send(updated);
    },
  );

  /**
   * DELETE /agent-department/personas/:id — soft delete persona
   */
  fastify.delete<{ Params: { id: string } }>(
    "/agent-department/personas/:id",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Department"],
        summary: "Soft-delete an agent persona",
        response: { 200: MessageResponse, 404: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const deleted = await softDeletePersona(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: "Agent persona not found" });
      }
      return reply.send({ message: "Agent persona soft-deleted" });
    },
  );

  /**
   * POST /agent-department/personas/:id/assign — assign task to agent
   */
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof AssignTaskSchema> }>(
    "/agent-department/personas/:id/assign",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: AssignTaskSchema,
        tags: ["Agent Department"],
        summary: "Assign a pipeline stage task to an agent",
        response: { 201: {}, 400: ErrorResponse, 403: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const validation = AssignTaskSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      // Budget check
      const budget = await checkBudget(request.params.id);
      if (!budget.allowed) {
        return reply.status(403).send({
          error: "Agent budget exceeded",
          budget,
        });
      }

      const assignment = await assignTask(
        request.params.id,
        validation.data.pipeline_run_id,
        validation.data.stage_name,
        validation.data.match_score,
        validation.data.assigned_by,
      );

      return reply.status(201).send(assignment);
    },
  );

  /**
   * POST /agent-department/assignments/:id/checkout — atomic checkout
   */
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof CheckoutSchema> }>(
    "/agent-department/assignments/:id/checkout",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: CheckoutSchema,
        tags: ["Agent Department"],
        summary: "Atomically checkout an assignment for execution",
        response: { 200: {}, 400: ErrorResponse, 409: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const validation = CheckoutSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const result = await checkoutTask(request.params.id, validation.data.run_id);
      if (!result) {
        return reply.status(409).send({ error: "Assignment already checked out or not in assigned state" });
      }

      return reply.send(result);
    },
  );

  /**
   * POST /agent-department/assignments/:id/complete — complete assignment
   */
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof CompleteTaskSchema> }>(
    "/agent-department/assignments/:id/complete",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: CompleteTaskSchema,
        tags: ["Agent Department"],
        summary: "Mark an assignment as completed with results",
        response: { 200: {}, 400: ErrorResponse, 409: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const validation = CompleteTaskSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const { result, cost_cents, tokens_used, refinement_count } = validation.data;
      const updated = await completeTask(
        request.params.id,
        result,
        cost_cents,
        tokens_used,
        refinement_count ?? 0,
      );

      if (!updated) {
        return reply.status(409).send({ error: "Assignment not found or not in 'in_progress' state" });
      }

      return reply.send(updated);
    },
  );

  /**
   * POST /agent-department/assignments/:id/escalate — escalate to manager
   */
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof EscalateSchema> }>(
    "/agent-department/assignments/:id/escalate",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: EscalateSchema,
        tags: ["Agent Department"],
        summary: "Escalate an assignment to the agent's manager",
        response: { 200: {}, 400: ErrorResponse, 409: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const validation = EscalateSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const updated = await escalateTask(request.params.id, validation.data.reason);
      if (!updated) {
        return reply.status(409).send({ error: "Assignment not found or not in 'in_progress' state" });
      }

      return reply.send(updated);
    },
  );

  /**
   * GET /agent-department/dashboard — department overview
   */
  fastify.get(
    "/agent-department/dashboard",
    {
      schema: buildRouteSchema({
        tags: ["Agent Department"],
        summary: "Get department overview dashboard",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (_request, reply) => {
      const dashboard = await getAgentDashboard();
      return reply.send(dashboard);
    },
  );

  /**
   * GET /agent-department/activity-history — full activity history for orchestration dashboard
   *
   * Returns real data from agent_activity_log, agent_assignments, agent_subtasks,
   * and cost_events for the last N days. Used by the orchestration dashboard.
   */
  fastify.get<{ Querystring: { days?: string } }>(
    "/agent-department/activity-history",
    {
      schema: buildRouteSchema({
        querystring: z.object({ days: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "Get full activity history for orchestration dashboard",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const days = Math.min(parseInt(request.query.days || "7", 10), 30);
      const history = await getAgentActivityHistory(days);
      return reply.send(history);
    },
  );

  /**
   * GET /agent-department/personas/:id/costs — cost history for agent
   */
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/agent-department/personas/:id/costs",
    {
      schema: buildRouteSchema({
        params: IdParams,
        querystring: z.object({ limit: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "Get cost history for an agent",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit || "100", 10), 500);
      const costs = await getAgentCosts(request.params.id, limit);
      return reply.send(costs);
    },
  );

  /**
   * POST /agent-department/match — skill-match agents for a task
   */
  fastify.post<{ Body: z.infer<typeof MatchSchema> }>(
    "/agent-department/match",
    {
      schema: buildRouteSchema({
        body: MatchSchema,
        tags: ["Agent Department"],
        summary: "Skill-match agents for a task",
        response: { 200: { type: "array", items: {} }, 400: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const validation = MatchSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.issues });
      }

      const agents = await getMatchableAgents();

      // Convert DB rows to AgentPersona type for the matcher
      const personaList: AgentPersona[] = agents.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        role: a.role as AgentPersona["role"],
        department: a.department as AgentPersona["department"],
        status: a.status as AgentPersona["status"],
        pauseReason: a.pause_reason,
        systemPrompt: a.system_prompt,
        skills: (a.skills as AgentPersona["skills"]) || [],
        techStack: (a.tech_stack as string[]) || [],
        legacyExpertise: (a.legacy_expertise as string[]) || [],
        modernExpertise: (a.modern_expertise as string[]) || [],
        toolPermissions: (a.tool_permissions as AgentPersona["toolPermissions"]) || [],
        stagePermissions: (a.stage_permissions as string[]) || [],
        preferredProvider: a.preferred_provider,
        preferredModel: a.preferred_model,
        evaluatorModel: a.evaluator_model,
        maxConcurrentTasks: a.max_concurrent_tasks,
        reportsTo: a.reports_to,
        canDelegate: a.can_delegate,
        escalationTarget: a.escalation_target,
        monthlyBudgetCents: a.monthly_budget_cents,
        lifetimeBudgetCents: a.lifetime_budget_cents,
        hardStopEnabled: a.hard_stop_enabled,
        warningThreshold: parseFloat(a.warning_threshold),
        spentMonthlyCents: a.spent_monthly_cents,
        sessionCompactionThreshold: a.session_compaction_threshold,
        memoryStrategy: a.memory_strategy as AgentPersona["memoryStrategy"],
        version: a.version,
        createdAt: a.created_at.toISOString(),
        updatedAt: a.updated_at.toISOString(),
        hiddenAt: a.hidden_at?.toISOString() ?? null,
      }));

      const taskReq: TaskRequirements = {
        keywords: validation.data.keywords,
        techStack: validation.data.tech_stack || [],
        stageName: validation.data.stage_name,
        minProficiency: validation.data.min_proficiency,
      };

      const results = matchAgentToTask(taskReq, personaList);

      return reply.send(results);
    },
  );

  // ─── ESCALATION ROUTES ─────────────────────────────────────────

  /**
   * GET /agent-department/escalations — list all escalated assignments across agents
   */
  fastify.get<{ Querystring: { department?: string } }>(
    "/agent-department/escalations",
    {
      schema: buildRouteSchema({
        querystring: z.object({ department: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "List all escalated assignments across agents",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const escalations = await listEscalatedAssignments({
        department: request.query.department,
      });
      return reply.send(escalations);
    },
  );

  // ─── SESSION ROUTES ──────────────────────────────────────────

  /**
   * GET /agent-department/personas/:id/sessions — list sessions for an agent
   */
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/agent-department/personas/:id/sessions",
    {
      schema: buildRouteSchema({
        params: IdParams,
        querystring: z.object({ limit: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "List sessions for an agent",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit || "50", 10), 200);
      const sessions = await getAgentSessions(request.params.id, limit);
      return reply.send(sessions);
    },
  );

  /**
   * GET /agent-department/personas/:id/sessions/:taskId/chain — get session chain for a specific task
   */
  fastify.get<{ Params: { id: string; taskId: string } }>(
    "/agent-department/personas/:id/sessions/:taskId/chain",
    {
      schema: buildRouteSchema({
        params: IdAndTaskIdParams,
        tags: ["Agent Department"],
        summary: "Get session chain for a specific task",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const chain = await getSessionChain(request.params.id, request.params.taskId);
      return reply.send(chain);
    },
  );

  /**
   * GET /agent-department/personas/:id/sessions/:taskId/context — build session context for prompt injection
   */
  fastify.get<{ Params: { id: string; taskId: string } }>(
    "/agent-department/personas/:id/sessions/:taskId/context",
    {
      schema: buildRouteSchema({
        params: IdAndTaskIdParams,
        tags: ["Agent Department"],
        summary: "Build session context for prompt injection",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const context = await buildSessionContext(request.params.id, request.params.taskId);
      return reply.send(context);
    },
  );

  /**
   * POST /agent-department/personas/:id/sessions/:taskId/compact — compact old sessions
   */
  fastify.post<{ Params: { id: string; taskId: string }; Body: { keep_recent?: number } }>(
    "/agent-department/personas/:id/sessions/:taskId/compact",
    {
      schema: buildRouteSchema({
        params: IdAndTaskIdParams,
        body: z.object({ keep_recent: z.number().optional() }),
        tags: ["Agent Department"],
        summary: "Compact old sessions for a task",
        response: { 200: {} },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const result = await compactSessionChain(
        request.params.id,
        request.params.taskId,
        { keepRecent: request.body?.keep_recent },
      );
      return reply.send(result);
    },
  );

  // ─── DELEGATION & HIERARCHY ROUTES ───────────────────────────

  /**
   * GET /agent-department/personas/:id/subordinates — get agents who report to this one
   */
  fastify.get<{ Params: { id: string } }>(
    "/agent-department/personas/:id/subordinates",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Department"],
        summary: "Get agents who report to this agent",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const subs = await getSubordinates(request.params.id);
      return reply.send(subs);
    },
  );

  /**
   * GET /agent-department/personas/:id/chain — get reporting chain up to director
   */
  fastify.get<{ Params: { id: string } }>(
    "/agent-department/personas/:id/chain",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Department"],
        summary: "Get reporting chain up to director",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const chain = await getReportingChain(request.params.id);
      return reply.send(chain);
    },
  );

  /**
   * GET /agent-department/departments/:dept/tree — get full org tree for a department
   */
  fastify.get<{ Params: { dept: string } }>(
    "/agent-department/departments/:dept/tree",
    {
      schema: buildRouteSchema({
        params: DeptParams,
        tags: ["Agent Department"],
        summary: "Get full org tree for a department",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const tree = await getDepartmentTree(request.params.dept);
      return reply.send(tree);
    },
  );

  // ─── BUDGET ENFORCEMENT ROUTES ──────────────────────────────

  /**
   * GET /agent-department/personas/:id/budget — budget status for agent
   */
  fastify.get<{ Params: { id: string } }>(
    "/agent-department/personas/:id/budget",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Department"],
        summary: "Get budget status for an agent",
        response: { 200: {}, 404: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const status = await getAgentBudgetStatus(request.params.id);
      if (!status) {
        return reply.status(404).send({ error: "Agent persona not found" });
      }
      return reply.send(status);
    },
  );

  /**
   * POST /agent-department/reconcile-budgets — trigger manual budget reconciliation (admin only)
   */
  fastify.post(
    "/agent-department/reconcile-budgets",
    {
      schema: buildRouteSchema({
        tags: ["Agent Department"],
        summary: "Trigger manual budget reconciliation (admin only)",
        response: { 200: {} },
      }),
      onRequest: [fastify.authorize(["admin"])],
    },
    async (_request, reply) => {
      const result = await reconcileMonthlyBudgets();
      return reply.send(result);
    },
  );

  /**
   * POST /agent-department/personas/:id/resume — resume a paused agent
   */
  fastify.post<{ Params: { id: string } }>(
    "/agent-department/personas/:id/resume",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Department"],
        summary: "Resume a paused agent (admin only)",
        response: { 200: MessageResponse, 409: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const success = await resumeAgent(request.params.id);
      if (!success) {
        return reply.status(409).send({
          error: "Agent not found, not paused, or already deleted",
        });
      }
      return reply.send({ message: "Agent resumed successfully" });
    },
  );

  // ─── SUBTASK ROUTES ──────────────────────────────────────────

  /**
   * POST /agent-department/subtasks — create a subtask
   */
  fastify.post<{
    Body: {
      created_by_agent_id: string;
      pipeline_run_id: string;
      stage_name: string;
      title: string;
      description?: string;
      required_skills?: string[];
      required_tech_stack?: string[];
      priority?: number;
      parent_subtask_id?: string;
    };
  }>(
    "/agent-department/subtasks",
    {
      schema: buildRouteSchema({
        body: z.object({
          created_by_agent_id: z.string().uuid(),
          pipeline_run_id: z.string().uuid(),
          stage_name: z.string().min(1),
          title: z.string().min(1),
          description: z.string().optional(),
          required_skills: z.array(z.string()).optional(),
          required_tech_stack: z.array(z.string()).optional(),
          priority: z.number().optional(),
          parent_subtask_id: z.string().uuid().optional(),
        }),
        tags: ["Agent Department"],
        summary: "Create a subtask for delegation",
        response: { 201: {}, 400: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const body = request.body;
      const subtask = await createSubtask(body.created_by_agent_id, {
        pipelineRunId: body.pipeline_run_id,
        stageName: body.stage_name,
        title: body.title,
        description: body.description,
        requiredSkills: body.required_skills,
        requiredTechStack: body.required_tech_stack,
        priority: body.priority,
        parentSubtaskId: body.parent_subtask_id,
      });
      return reply.status(201).send(subtask);
    },
  );

  /**
   * GET /agent-department/subtasks?pipeline_run_id=X&stage_name=Y — list subtasks
   */
  fastify.get<{ Querystring: { pipeline_run_id: string; stage_name?: string } }>(
    "/agent-department/subtasks",
    {
      schema: buildRouteSchema({
        querystring: z.object({ pipeline_run_id: z.string().uuid(), stage_name: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "List subtasks for a pipeline run",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const subtasks = await listSubtasks(
        request.query.pipeline_run_id,
        request.query.stage_name,
      );
      return reply.send(subtasks);
    },
  );

  /**
   * POST /agent-department/subtasks/:id/assign — assign a subtask to an agent
   */
  fastify.post<{ Params: { id: string }; Body: { agent_id: string; assigned_by: string } }>(
    "/agent-department/subtasks/:id/assign",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: z.object({ agent_id: z.string().uuid(), assigned_by: z.string().uuid() }),
        tags: ["Agent Department"],
        summary: "Assign a subtask to an agent",
        response: { 200: {}, 409: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const result = await assignSubtask(
        request.params.id,
        request.body.agent_id,
        request.body.assigned_by,
      );
      if (!result) {
        return reply.status(409).send({ error: "Subtask not in 'backlog' status" });
      }
      return reply.send(result);
    },
  );

  /**
   * POST /agent-department/subtasks/:id/complete — complete a subtask
   */
  fastify.post<{ Params: { id: string }; Body: { result: Record<string, unknown>; cost_cents: number } }>(
    "/agent-department/subtasks/:id/complete",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: z.object({ result: z.record(z.any()), cost_cents: z.number().int().min(0) }),
        tags: ["Agent Department"],
        summary: "Complete a subtask with results",
        response: { 200: {}, 409: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const completed = await completeSubtask(
        request.params.id,
        request.body.result,
        request.body.cost_cents,
      );
      if (!completed) {
        return reply.status(409).send({ error: "Subtask not in 'in_progress' status" });
      }
      return reply.send(completed);
    },
  );

  // ─── AGENT EXECUTION ROUTES ────────────────────────────────────
  // These routes are called by the Go coordinator to trigger and manage
  // agent-mediated execution of pipeline stages.

  /**
   * POST /agent-department/assignments/:id/execute — trigger agent execution
   *
   * Called by the Go coordinator's Executor after HeartbeatTick checks out a task.
   * Also callable by admins for manual execution triggers.
   */
  fastify.post<{ Params: { id: string }; Body: { source?: string } }>(
    "/agent-department/assignments/:id/execute",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: z.object({ source: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "Trigger agent execution for an assignment",
        response: { 200: {}, 500: ErrorResponse },
      }),
      onRequest: [
        // Allow both internal service calls and admin users
        async (request, reply) => {
          const isInternal = request.headers["x-internal-service"] === "llm-orchestrator";
          if (isInternal) return; // Internal service bypass
          return fastify.authorize(["admin"])(request, reply);
        },
      ],
    },
    async (request, reply) => {
      const { executeAgentAssignment } = await import("@/services/agent-execution.js");

      try {
        const result = await executeAgentAssignment(request.params.id, {
          onEvent: (event) => {
            fastify.log.info({ agentEvent: event }, "Agent execution event");
          },
        });
        return reply.send(result);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        fastify.log.error({ assignmentId: request.params.id, error: errMsg }, "Agent execution failed");
        return reply.status(500).send({ success: false, error: errMsg });
      }
    },
  );

  /**
   * GET /agent-department/assignments/:id/status — get execution status
   *
   * Returns the current state of an agent assignment including timing,
   * cost, and result data.
   */
  fastify.get<{ Params: { id: string } }>(
    "/agent-department/assignments/:id/status",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Department"],
        summary: "Get execution status of an assignment",
        response: { 200: {}, 404: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      const { db } = await import("@/db/index.js");
      const { agentAssignments } = await import("@/db/schema.js");
      const { eq } = await import("drizzle-orm");

      const assignment = await db.query.agentAssignments.findFirst({
        where: eq(agentAssignments.id, request.params.id),
      });

      if (!assignment) {
        return reply.status(404).send({ error: "Assignment not found" });
      }

      return reply.send({
        id: assignment.id,
        agentId: assignment.agent_id,
        status: assignment.status,
        stageName: assignment.stage_name,
        pipelineRunId: assignment.pipeline_run_id,
        matchScore: assignment.match_score,
        checkoutRunId: assignment.checkout_run_id,
        costCents: assignment.cost_cents,
        tokensUsed: assignment.tokens_used,
        refinementCount: assignment.refinement_count,
        result: assignment.result,
        createdAt: assignment.created_at,
        startedAt: assignment.started_at,
        completedAt: assignment.completed_at,
      });
    },
  );

  /**
   * GET /agent-department/execution/active — list currently executing assignments
   *
   * Shows all assignments in 'in_progress' state with their agent details.
   * Used by the dashboard to show real-time agent activity.
   */
  fastify.get(
    "/agent-department/execution/active",
    {
      schema: buildRouteSchema({
        tags: ["Agent Department"],
        summary: "List currently executing assignments with agent details",
        response: { 200: { type: "object", properties: { active: { type: "array", items: {} } } } },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (_request, reply) => {
      const { db } = await import("@/db/index.js");
      const { sql } = await import("drizzle-orm");

      const active = await db.execute(sql`
        SELECT
          a.id AS assignment_id,
          a.agent_id,
          a.pipeline_run_id,
          a.stage_name,
          a.match_score,
          a.checkout_run_id,
          a.cost_cents,
          a.tokens_used,
          a.started_at,
          p.name AS agent_name,
          p.slug AS agent_slug,
          p.department,
          p.role,
          p.preferred_model
        FROM agent_assignments a
        JOIN agent_personas p ON p.id = a.agent_id
        WHERE a.status = 'in_progress'
        ORDER BY a.started_at DESC
        LIMIT 50
      `);

      return reply.send({ active: active.rows });
    },
  );

  // ─── EVOLUTION MEMORY ROUTES (OpenViking Pattern) ──────────────

  /**
   * GET /agent-department/personas/:id/evolution — list evolution memories for an agent
   */
  fastify.get<{ Params: { id: string }; Querystring: { category?: string; limit?: string } }>(
    "/agent-department/personas/:id/evolution",
    {
      schema: buildRouteSchema({
        params: IdParams,
        querystring: z.object({ category: z.string().optional(), limit: z.string().optional() }),
        tags: ["Agent Department"],
        summary: "List evolution memories for an agent",
        response: { 200: { type: "array", items: {} } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { db } = await import("@/db/index.js");
      const { agentEvolutionMemory } = await import("@/db/schema.js");
      const { eq, and, isNull, desc } = await import("drizzle-orm");

      const conditions = [
        eq(agentEvolutionMemory.agent_id, request.params.id),
        isNull(agentEvolutionMemory.superseded_by),
      ];

      if (request.query.category) {
        conditions.push(eq(agentEvolutionMemory.category, request.query.category));
      }

      const limit = Math.min(parseInt(request.query.limit || "50", 10), 200);

      const memories = await db.query.agentEvolutionMemory.findMany({
        where: and(...conditions),
        orderBy: [desc(agentEvolutionMemory.confidence), desc(agentEvolutionMemory.created_at)],
        limit,
      });

      return reply.send(
        memories.map((m) => ({
          id: m.id,
          agentId: m.agent_id,
          category: m.category,
          summary: m.summary,
          sourcePipelineRunId: m.source_pipeline_run_id,
          sourceStage: m.source_stage,
          confidence: parseFloat(m.confidence),
          usageCount: m.usage_count,
          lastUsedAt: m.last_used_at?.toISOString() ?? null,
          supersededBy: m.superseded_by,
          createdAt: m.created_at.toISOString(),
        })),
      );
    },
  );

  /**
   * POST /agent-department/evolution/:id/supersede — mark a memory as superseded
   */
  fastify.post<{ Params: { id: string }; Body: { newMemoryId: string } }>(
    "/agent-department/evolution/:id/supersede",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: z.object({ newMemoryId: z.string().uuid() }),
        tags: ["Agent Department"],
        summary: "Mark an evolution memory as superseded",
        response: { 200: SuccessResponse, 400: ErrorResponse },
      }),
      onRequest: [fastify.authorize(["admin", "architect"])],
    },
    async (request, reply) => {
      if (!request.body?.newMemoryId) {
        return reply.status(400).send({ error: "newMemoryId is required" });
      }
      await supersedeMemory(request.params.id, request.body.newMemoryId);
      return reply.send({ success: true });
    },
  );

  // ─── RETRIEVAL TRAJECTORY ROUTES (OpenViking Pattern) ──────────

  /**
   * GET /agent-department/trajectories/:pipelineRunId — get all retrieval trajectories for a run
   */
  fastify.get<{ Params: { pipelineRunId: string } }>(
    "/agent-department/trajectories/:pipelineRunId",
    {
      schema: buildRouteSchema({
        params: PipelineRunIdParams,
        tags: ["Agent Department"],
        summary: "Get all retrieval trajectories for a pipeline run",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const trajectories = await getRetrievalTrajectories(request.params.pipelineRunId);
      return reply.send(trajectories);
    },
  );

  /**
   * GET /agent-department/trajectories/:pipelineRunId/:stageName — get trajectory for specific stage
   */
  fastify.get<{ Params: { pipelineRunId: string; stageName: string } }>(
    "/agent-department/trajectories/:pipelineRunId/:stageName",
    {
      schema: buildRouteSchema({
        params: PipelineRunAndStageParams,
        tags: ["Agent Department"],
        summary: "Get retrieval trajectory for a specific pipeline stage",
        response: { 200: {}, 404: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const trajectory = await getStageTrajectory(
        request.params.pipelineRunId,
        request.params.stageName,
      );
      if (!trajectory) {
        return reply.status(404).send({ error: "Trajectory not found for this stage" });
      }
      return reply.send(trajectory);
    },
  );
}
