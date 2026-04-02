/**
 * Agent Tasks & Routines Routes — Kanban board, budget enforcement, scheduled runs.
 *
 * Endpoints:
 *   GET    /agent-tasks                → List tasks (filterable by status, project, agent)
 *   POST   /agent-tasks                → Create task
 *   PATCH  /agent-tasks/:id            → Update task (status, assignment, priority)
 *   PATCH  /agent-tasks/:id/move       → Kanban move (update status + sort order)
 *   DELETE /agent-tasks/:id            → Delete task
 *
 *   GET    /agent-routines             → List routines
 *   POST   /agent-routines             → Create routine
 *   PATCH  /agent-routines/:id         → Update routine
 *   POST   /agent-routines/:id/trigger → Manually trigger a routine
 *   DELETE /agent-routines/:id         → Delete routine
 *
 *   GET    /budget-policies            → List budget policies
 *   POST   /budget-policies            → Create/update budget policy
 *   GET    /budget-incidents           → List budget incidents
 *   POST   /budget-incidents/:id/resolve → Resolve an incident
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/db/index.js";
import { agentTasks, agentRoutines, budgetPolicies, budgetIncidents } from "@/db/schema.js";
import { eq, and, desc, asc, inArray } from "drizzle-orm";

// ─── SCHEMAS ────────────────────────────────────────────────────

const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  project_id: z.string().uuid().optional(),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]).default("backlog"),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  assigned_agent_id: z.string().uuid().optional(),
  labels: z.array(z.string()).optional(),
  stage: z.string().optional(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]).optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  assigned_agent_id: z.string().uuid().nullable().optional(),
  assigned_user_id: z.string().uuid().nullable().optional(),
  labels: z.array(z.string()).optional(),
  progress: z.number().min(0).max(100).optional(),
  sort_order: z.number().optional(),
  error_message: z.string().nullable().optional(),
});

const MoveTaskSchema = z.object({
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]),
  sort_order: z.number().default(0),
});

const CreateRoutineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  project_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  cron_expression: z.string().optional(),
  trigger_type: z.enum(["schedule", "webhook", "manual"]).default("schedule"),
  task_template: z.object({
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
    stage: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  concurrency_policy: z.enum(["skip_if_active", "coalesce_if_active", "always_enqueue"]).default("skip_if_active"),
  max_retries: z.number().min(0).max(10).default(1),
});

const CreateBudgetPolicySchema = z.object({
  scope_type: z.enum(["organization", "project", "agent"]),
  scope_id: z.string().uuid(),
  limit_cents: z.number().int().positive(),
  window: z.enum(["monthly", "weekly", "daily", "lifetime"]).default("monthly"),
  warn_percent: z.number().min(0).max(1).default(0.8),
  hard_stop: z.boolean().default(true),
});

// ─── ROUTES ─────────────────────────────────────────────────────

export async function agentTaskRoutes(fastify: FastifyInstance) {
  // ═══ TASKS (Kanban) ══════════════════════════════════════════

  fastify.get<{ Querystring: { project_id?: string; status?: string; agent_id?: string; limit?: string } }>(
    "/agent-tasks",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { project_id, status, agent_id, limit } = request.query;
      const orgId = request.user.organization_id;

      let query = db.query.agentTasks.findMany({
        limit: parseInt(limit || "100", 10),
        orderBy: [asc(agentTasks.sort_order), desc(agentTasks.created_at)],
        where: and(
          eq(agentTasks.organization_id, orgId),
          project_id ? eq(agentTasks.project_id, project_id) : undefined,
          status ? eq(agentTasks.status, status) : undefined,
          agent_id ? eq(agentTasks.assigned_agent_id, agent_id) : undefined,
        ),
      });

      const tasks = await query;

      // Group by status for Kanban
      const kanban: Record<string, typeof tasks> = {
        backlog: [], todo: [], in_progress: [], in_review: [], blocked: [], done: [], cancelled: [],
      };
      for (const task of tasks) {
        if (kanban[task.status]) kanban[task.status].push(task);
      }

      return reply.send({ tasks, kanban });
    },
  );

  fastify.post<{ Body: z.infer<typeof CreateTaskSchema> }>(
    "/agent-tasks",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const body = CreateTaskSchema.parse(request.body);
      const orgId = request.user.organization_id;

      const [task] = await db.insert(agentTasks).values({
        organization_id: orgId,
        project_id: body.project_id || null,
        title: body.title,
        description: body.description,
        status: body.status,
        priority: body.priority,
        assigned_agent_id: body.assigned_agent_id || null,
        labels: body.labels || [],
        stage: body.stage,
        created_by: request.user.sub,
      }).returning();

      return reply.status(201).send(task);
    },
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof UpdateTaskSchema> }>(
    "/agent-tasks/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const body = UpdateTaskSchema.parse(request.body);

      const updates: Record<string, unknown> = { ...body, updated_at: new Date() };
      if (body.status === "in_progress" && !updates.started_at) {
        updates.started_at = new Date();
      }
      if (body.status === "done" || body.status === "cancelled") {
        updates.completed_at = new Date();
      }

      const [updated] = await db.update(agentTasks)
        .set(updates)
        .where(eq(agentTasks.id, request.params.id))
        .returning();

      return reply.send(updated);
    },
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof MoveTaskSchema> }>(
    "/agent-tasks/:id/move",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const body = MoveTaskSchema.parse(request.body);

      const updates: Record<string, unknown> = {
        status: body.status,
        sort_order: body.sort_order,
        updated_at: new Date(),
      };
      if (body.status === "in_progress") updates.started_at = new Date();
      if (body.status === "done" || body.status === "cancelled") updates.completed_at = new Date();

      const [updated] = await db.update(agentTasks)
        .set(updates)
        .where(eq(agentTasks.id, request.params.id))
        .returning();

      return reply.send(updated);
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/agent-tasks/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      await db.delete(agentTasks).where(eq(agentTasks.id, request.params.id));
      return reply.send({ deleted: true });
    },
  );

  // ═══ ROUTINES (Scheduled Runs) ═══════════════════════════════

  fastify.get(
    "/agent-routines",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const orgId = request.user.organization_id;
      const routines = await db.query.agentRoutines.findMany({
        where: eq(agentRoutines.organization_id, orgId),
        orderBy: desc(agentRoutines.created_at),
      });
      return reply.send({ routines });
    },
  );

  fastify.post<{ Body: z.infer<typeof CreateRoutineSchema> }>(
    "/agent-routines",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const body = CreateRoutineSchema.parse(request.body);
      const orgId = request.user.organization_id;

      // Calculate next run time from cron
      let nextRunAt: Date | null = null;
      if (body.cron_expression && body.trigger_type === "schedule") {
        nextRunAt = calculateNextCronRun(body.cron_expression);
      }

      const [routine] = await db.insert(agentRoutines).values({
        organization_id: orgId,
        project_id: body.project_id || null,
        agent_id: body.agent_id || null,
        name: body.name,
        description: body.description,
        cron_expression: body.cron_expression,
        trigger_type: body.trigger_type,
        task_template: body.task_template,
        concurrency_policy: body.concurrency_policy,
        max_retries: body.max_retries,
        next_run_at: nextRunAt,
        created_by: request.user.sub,
      }).returning();

      return reply.status(201).send(routine);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/agent-routines/:id/trigger",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const routine = await db.query.agentRoutines.findFirst({
        where: eq(agentRoutines.id, request.params.id),
      });

      if (!routine) return reply.status(404).send({ error: "Routine not found" });

      const template = routine.task_template as any;

      // Create a task from the routine template
      const [task] = await db.insert(agentTasks).values({
        organization_id: routine.organization_id,
        project_id: routine.project_id,
        routine_id: routine.id,
        title: template.title || routine.name,
        description: template.description,
        priority: template.priority || "medium",
        status: "todo",
        assigned_agent_id: routine.agent_id,
        labels: template.labels || [],
        stage: template.stage,
        created_by: request.user.sub,
      }).returning();

      // Update routine run stats
      await db.update(agentRoutines).set({
        last_run_at: new Date(),
        run_count: (routine.run_count || 0) + 1,
        next_run_at: routine.cron_expression ? calculateNextCronRun(routine.cron_expression) : null,
        updated_at: new Date(),
      }).where(eq(agentRoutines.id, routine.id));

      return reply.status(201).send({ task, routine_id: routine.id });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/agent-routines/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      await db.delete(agentRoutines).where(eq(agentRoutines.id, request.params.id));
      return reply.send({ deleted: true });
    },
  );

  // ═══ BUDGET POLICIES & INCIDENTS ═════════════════════════════

  fastify.get(
    "/budget-policies",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const policies = await db.query.budgetPolicies.findMany({
        where: eq(budgetPolicies.active, true),
        orderBy: desc(budgetPolicies.created_at),
      });
      return reply.send({ policies });
    },
  );

  fastify.post<{ Body: z.infer<typeof CreateBudgetPolicySchema> }>(
    "/budget-policies",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const body = CreateBudgetPolicySchema.parse(request.body);

      // Deactivate existing policy for the same scope
      await db.update(budgetPolicies)
        .set({ active: false, updated_at: new Date() })
        .where(and(
          eq(budgetPolicies.scope_type, body.scope_type),
          eq(budgetPolicies.scope_id, body.scope_id),
          eq(budgetPolicies.active, true),
        ));

      const [policy] = await db.insert(budgetPolicies).values({
        scope_type: body.scope_type,
        scope_id: body.scope_id,
        limit_cents: body.limit_cents,
        window: body.window,
        warn_percent: String(body.warn_percent),
        hard_stop: body.hard_stop,
      }).returning();

      return reply.status(201).send(policy);
    },
  );

  // Edit budget policy
  fastify.put<{ Params: { id: string }; Body: Partial<z.infer<typeof CreateBudgetPolicySchema>> }>(
    "/budget-policies/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (body.limit_cents !== undefined) updates.limit_cents = body.limit_cents;
      if (body.window !== undefined) updates.window = body.window;
      if (body.warn_percent !== undefined) updates.warn_percent = String(body.warn_percent);
      if (body.hard_stop !== undefined) updates.hard_stop = body.hard_stop;
      if (body.active !== undefined) updates.active = body.active;

      const [updated] = await db.update(budgetPolicies)
        .set(updates)
        .where(eq(budgetPolicies.id, request.params.id))
        .returning();

      if (!updated) return reply.status(404).send({ error: "Policy not found" });
      return reply.send(updated);
    },
  );

  // Delete (deactivate) budget policy
  fastify.delete<{ Params: { id: string } }>(
    "/budget-policies/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const [updated] = await db.update(budgetPolicies)
        .set({ active: false, updated_at: new Date() })
        .where(eq(budgetPolicies.id, request.params.id))
        .returning();

      if (!updated) return reply.status(404).send({ error: "Policy not found" });
      return reply.send({ deleted: true, id: request.params.id });
    },
  );

  fastify.get(
    "/budget-incidents",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const incidents = await db.query.budgetIncidents.findMany({
        orderBy: desc(budgetIncidents.created_at),
        limit: 50,
      });
      return reply.send({ incidents });
    },
  );

  fastify.post<{ Params: { id: string }; Body: { resolution_note?: string } }>(
    "/budget-incidents/:id/resolve",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const [updated] = await db.update(budgetIncidents)
        .set({
          resolved: true,
          action_taken: (request.body as any)?.resolution_note || "Manually resolved",
        })
        .where(eq(budgetIncidents.id, request.params.id))
        .returning();

      return reply.send(updated);
    },
  );
}

// ─── HELPERS ────────────────────────────────────────────────────

function calculateNextCronRun(cron: string): Date {
  // Simple cron parser — handles basic patterns
  // For production, use a proper library like cron-parser
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(next.getMinutes() + 1);
  next.setSeconds(0);
  next.setMilliseconds(0);

  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return next;

  const [min, hour] = parts;

  // Handle specific minute
  if (min !== "*" && !min.includes("/")) {
    next.setMinutes(parseInt(min, 10));
  }
  // Handle specific hour
  if (hour !== "*" && !hour.includes("/")) {
    next.setHours(parseInt(hour, 10));
    if (next <= now) next.setDate(next.getDate() + 1);
  }
  // Handle interval (*/N)
  if (min.startsWith("*/")) {
    const interval = parseInt(min.slice(2), 10);
    const nextMin = Math.ceil((now.getMinutes() + 1) / interval) * interval;
    if (nextMin >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(0);
    } else {
      next.setMinutes(nextMin);
    }
  }

  return next;
}
