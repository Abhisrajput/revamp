/**
 * Agent Features Routes — Adapter config, approval comments, skills, org chart.
 *
 * 4. Agent Adapter:
 *   PATCH  /agents/:id/adapter         → Update agent's LLM adapter config
 *
 * 5. Approval Comments:
 *   GET    /approval-gates/:id/comments → List comments on an approval gate
 *   POST   /approval-gates/:id/comments → Add comment / request revision
 *
 * 6. Skills:
 *   GET    /agent-skills               → List all skills
 *   POST   /agent-skills               → Create skill
 *   GET    /agent-skills/:id           → Get skill details
 *   POST   /agents/:agentId/skills/:skillId → Assign skill to agent
 *   DELETE /agents/:agentId/skills/:skillId → Remove skill from agent
 *   GET    /agents/:agentId/skills     → List agent's skills
 *
 * 7. Org Chart:
 *   GET    /agents/org-chart           → Get hierarchical org chart data
 *   PATCH  /agents/:id/reports-to     → Set reporting manager
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildRouteSchema } from "@/lib/zod-to-jsonschema.js";
import { db } from "@/db/index.js";
import {
  agentPersonas, approvalGates, approvalComments,
  agentSkills, agentSkillAssignments, users,
  stageRuns, pipelineRuns, llmUsage, agentTasks,
  agentActivityLog, agentAssignments,
} from "@/db/schema.js";
import { eq, and, desc, inArray, count, sql, gte, isNull } from "drizzle-orm";

// ─── SCHEMAS ────────────────────────────────────────────────────

const AdapterConfigSchema = z.object({
  preferred_provider: z.string().optional(),
  preferred_model: z.string().optional(),
  evaluator_model: z.string().optional(),
});

const CommentSchema = z.object({
  content: z.string().min(1),
  action: z.enum(["comment", "revision_requested", "revised"]).default("comment"),
});

const CreateSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum(["language", "framework", "pattern", "domain", "tool"]),
  knowledge: z.string().min(1),
  examples: z.array(z.any()).optional(),
  tags: z.array(z.string()).optional(),
});

const AssignSkillSchema = z.object({
  proficiency: z.enum(["beginner", "intermediate", "expert"]).default("intermediate"),
});

/** Build a human-readable summary from action + raw details. */
function buildDetailSummary(action: string, details: Record<string, unknown>, agentName: string): string {
  switch (action) {
    case 'persona_created':
      return `Created agent: ${details.name || agentName}`;
    case 'persona_updated': {
      const fields = (details.fields as string[]) || [];
      return fields.length > 0 ? `Updated ${fields.join(', ')} on ${agentName}` : `Updated ${agentName}`;
    }
    case 'persona_deleted':
      return `Deleted agent: ${agentName}`;
    case 'subtask_created':
      return `Subtask: ${(details as any)?.title || 'New task'}`;
    case 'subtask_completed':
      return `Completed subtask for ${agentName}`;
    case 'assignment_created':
      return `Assigned ${(details as any)?.stage_name || 'task'} to ${agentName}`;
    case 'budget_warning':
      return `Budget warning for ${agentName} (${(details as any)?.percentUsed ? Math.round((details as any).percentUsed * 100) + '%' : 'over threshold'})`;
    case 'budget_hard_stop':
      return `Budget hard stop — ${agentName} paused`;
    case 'agent_resumed':
      return `${agentName} resumed from pause`;
    case 'budgets_reconciled':
      return `Monthly budgets reconciled (${(details as any)?.agentsReconciled || 0} agents)`;
    default:
      return typeof details === 'object' && Object.keys(details).length > 0
        ? `${action}: ${Object.values(details).filter(v => typeof v === 'string').join(', ').slice(0, 80)}`
        : action;
  }
}

const ReportsToSchema = z.object({
  reports_to: z.string().uuid().nullable(),
});

// ─── Common response shapes ────────────────────────────────────

const ErrorResponse = { type: "object" as const, properties: { error: { type: "string" } } };
const OkResponse = { type: "object" as const, properties: { ok: { type: "boolean" } } };
const IdParams = z.object({ id: z.string().uuid() });
const AgentIdParams = z.object({ agentId: z.string().uuid() });
const AgentSkillParams = z.object({ agentId: z.string().uuid(), skillId: z.string().uuid() });

// ─── ROUTES ─────────────────────────────────────────────────────

export async function agentFeatureRoutes(fastify: FastifyInstance) {

  // ═══ ORCHESTRATOR DASHBOARD — real data from DB ══════════════

  fastify.get<{ Querystring: { period?: string } }>(
    "/agents/orchestrator/status",
    {
      schema: buildRouteSchema({
        querystring: z.object({ period: z.string().optional() }),
        tags: ["Agent Features"],
        summary: "Get orchestrator connection and run status",
        response: { 200: { type: "object", properties: { state: { type: "string" }, connected: { type: "boolean" }, activeRunCount: { type: "number" } } } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      // Check if any pipeline is actively running
      const activeRuns = await db.query.pipelineRuns.findMany({
        where: eq(pipelineRuns.status, "running"),
        columns: { id: true },
        limit: 5,
      });
      return reply.send({
        state: activeRuns.length > 0 ? 'running' : 'idle',
        connected: true,
        activeRunCount: activeRuns.length,
      });
    },
  );

  fastify.get<{ Querystring: { period?: string } }>(
    "/agents/orchestrator/stats",
    {
      schema: buildRouteSchema({
        querystring: z.object({ period: z.string().optional() }),
        tags: ["Agent Features"],
        summary: "Get orchestrator statistics for a time period",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const period = request.query.period || '24h';
      const since = new Date();
      if (period === '1h') since.setHours(since.getHours() - 1);
      else if (period === '7d') since.setDate(since.getDate() - 7);
      else since.setHours(since.getHours() - 24);

      const [agents, stageRunsData, usageData, tasks] = await Promise.all([
        db.query.agentPersonas.findMany({ columns: { id: true, status: true } }),
        db.query.stageRuns.findMany({
          where: gte(stageRuns.created_at, since),
          columns: { status: true, duration_ms: true, cost_cents: true },
        }),
        db.query.llmUsage.findMany({
          where: gte(llmUsage.created_at, since),
          columns: { input_tokens: true, output_tokens: true, cost: true },
        }),
        db.query.agentTasks.findMany({
          where: eq(agentTasks.status, "in_progress"),
          columns: { id: true },
        }),
      ]);

      const completed = stageRunsData.filter(r => r.status === 'completed').length;
      const failed = stageRunsData.filter(r => r.status === 'failed' || r.status === 'aborted').length;
      const totalTokens = usageData.reduce((s, u) => s + (u.input_tokens || 0) + (u.output_tokens || 0), 0);
      const totalCostCents = usageData.reduce((s, u) => s + Math.round((parseFloat(String(u.cost || 0))) * 100), 0);
      const avgDuration = stageRunsData.length > 0
        ? Math.round(stageRunsData.reduce((s, r) => s + (r.duration_ms || 0), 0) / stageRunsData.length)
        : 0;

      const periodLabels: Record<string, string> = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' };

      return reply.send({
        totalAgents: agents.length,
        activeAgents: agents.filter(a => a.status === 'working').length,
        tasksCompleted: completed,
        tasksFailed: failed,
        tasksQueued: tasks.length,
        totalCostCents,
        avgTaskDurationMs: avgDuration,
        escalations: 0,
        totalLLMCalls: usageData.length,
        totalTokens,
        runtimeSeconds: Math.round((Date.now() - since.getTime()) / 1000),
        periodLabel: periodLabels[period] || period,
      });
    },
  );

  fastify.get(
    "/agents/orchestrator/queue",
    {
      schema: buildRouteSchema({
        tags: ["Agent Features"],
        summary: "Get active task queue from the Kanban board",
        response: { 200: { type: "array", items: {} } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      // Combine Kanban tasks + pipeline agent assignments for a unified queue view
      const [kanbanTasks, pipelineAssignments] = await Promise.all([
        db.query.agentTasks.findMany({
          where: inArray(agentTasks.status, ['todo', 'in_progress', 'in_review', 'blocked']),
          orderBy: desc(agentTasks.created_at),
          limit: 20,
        }),
        db.query.agentAssignments.findMany({
          where: inArray(agentAssignments.status, ['pending', 'in_progress']),
          orderBy: desc(agentAssignments.created_at),
          limit: 20,
          with: { agent: { columns: { id: true, name: true, department: true } } },
        }),
      ]);

      const kanbanItems = kanbanTasks.map(t => ({
        id: t.id,
        title: t.title,
        priority: t.priority || 'medium',
        status: t.status === 'in_progress' ? 'running' : t.status === 'todo' ? 'queued' : t.status,
        assignedAgentId: t.assigned_agent_id,
        stage: t.stage,
        progress: t.progress || 0,
        tokensUsed: t.tokens_used || 0,
        createdAt: t.created_at?.toISOString(),
      }));

      const pipelineItems = pipelineAssignments.map(a => ({
        id: a.id,
        title: `Pipeline: ${a.stage_name}`,
        priority: 'high' as const,
        status: a.status === 'in_progress' ? 'running' : 'queued',
        assignedAgentId: a.agent_id,
        assignedAgentName: (a as any).agent?.name,
        assignedAgent: (a as any).agent || null,
        stage: a.stage_name,
        progress: 0,
        tokensUsed: a.tokens_used || 0,
        costCents: a.cost_cents || 0,
        createdAt: a.created_at?.toISOString(),
      }));

      return reply.send([...pipelineItems, ...kanbanItems]);
    },
  );

  fastify.get(
    "/agents/orchestrator/log",
    {
      schema: buildRouteSchema({
        tags: ["Agent Features"],
        summary: "Get orchestrator activity log from stage runs and agent activity",
        response: { 200: { type: "array", items: {} } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      // Build activity log from stage_runs + audit_logs
      const [recentRuns, recentActivity] = await Promise.all([
        db.query.stageRuns.findMany({
          orderBy: desc(stageRuns.created_at),
          limit: 30,
          columns: { id: true, stage_name: true, status: true, model: true, duration_ms: true, created_at: true },
        }),
        db.query.agentActivityLog.findMany({
          orderBy: desc(agentActivityLog.created_at),
          limit: 30,
        }),
      ]);

      // Build agent name lookup (single query for all names)
      const agentIds = [...new Set(recentActivity.map(a => a.agent_id).filter(Boolean))];
      const agentNameMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const personas = await db.query.agentPersonas.findMany({
          where: inArray(agentPersonas.id, agentIds),
          columns: { id: true, name: true, department: true },
        });
        for (const p of personas) agentNameMap[p.id] = p.name;
      }

      const log: any[] = [];

      for (const run of recentRuns) {
        log.push({
          id: run.id,
          agentId: '',
          agentName: 'Pipeline',
          department: 'execution',
          action: run.status === 'completed' ? 'COMPLETE' : run.status === 'failed' ? 'FAIL' : 'EXECUTE',
          details: {
            stage_name: run.stage_name,
            model: run.model || 'default',
            duration_ms: run.duration_ms,
            status: run.status,
          },
          detail: `${run.stage_name} — ${run.model || 'default'} (${run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : 'pending'})`,
          timestamp: run.created_at?.toISOString() || new Date().toISOString(),
          level: run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'info',
        });
      }

      for (const act of recentActivity) {
        const rawDetails = act.details as Record<string, unknown> || {};
        const name = agentNameMap[act.agent_id] || rawDetails.name as string || 'Unknown Agent';
        const detail = buildDetailSummary(act.action, rawDetails, name);

        log.push({
          id: act.id,
          agentId: act.agent_id,
          agentName: name,
          department: (rawDetails.department as string) || 'execution',
          action: act.action,
          details: rawDetails,
          detail,
          timestamp: act.created_at?.toISOString() || new Date().toISOString(),
          level: act.action.includes('fail') || act.action.includes('error') ? 'error'
            : act.action.includes('complete') || act.action.includes('created') ? 'success'
            : act.action.includes('warning') || act.action.includes('paused') ? 'warning'
            : 'info',
        });
      }

      // Sort by timestamp desc
      log.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return reply.send(log.slice(0, 50));
    },
  );

  // Orchestrator control endpoints (no-ops that update UI state)
  fastify.post("/agents/orchestrator/start", { schema: buildRouteSchema({ tags: ["Agent Features"], summary: "Start the orchestrator", response: { 200: OkResponse } }), onRequest: [fastify.authenticate] }, async (_, reply) => reply.send({ ok: true }));
  fastify.post("/agents/orchestrator/pause", { schema: buildRouteSchema({ tags: ["Agent Features"], summary: "Pause the orchestrator", response: { 200: OkResponse } }), onRequest: [fastify.authenticate] }, async (_, reply) => reply.send({ ok: true }));
  fastify.post("/agents/orchestrator/stop", { schema: buildRouteSchema({ tags: ["Agent Features"], summary: "Stop the orchestrator", response: { 200: OkResponse } }), onRequest: [fastify.authenticate] }, async (_, reply) => reply.send({ ok: true }));
  fastify.post("/agents/orchestrator/reset", { schema: buildRouteSchema({ tags: ["Agent Features"], summary: "Reset the orchestrator", response: { 200: OkResponse } }), onRequest: [fastify.authenticate] }, async (_, reply) => reply.send({ ok: true }));

  // ═══ 4. AGENT ADAPTER CONFIG ═════════════════════════════════

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof AdapterConfigSchema> }>(
    "/agents/:id/adapter",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: AdapterConfigSchema,
        tags: ["Agent Features"],
        summary: "Update an agent's LLM adapter configuration",
        response: { 200: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const body = AdapterConfigSchema.parse(request.body);

      const [updated] = await db.update(agentPersonas)
        .set({
          preferred_provider: body.preferred_provider,
          preferred_model: body.preferred_model,
          evaluator_model: body.evaluator_model,
          updated_at: new Date(),
        })
        .where(eq(agentPersonas.id, request.params.id))
        .returning();

      return reply.send(updated);
    },
  );

  // ═══ 5. APPROVAL COMMENTS ═══════════════════════════════════

  fastify.get<{ Params: { id: string } }>(
    "/approval-gates/:id/comments",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Features"],
        summary: "List comments on an approval gate",
        response: { 200: { type: "object", properties: { comments: { type: "array", items: {} } } } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const comments = await db.query.approvalComments.findMany({
        where: eq(approvalComments.approval_gate_id, request.params.id),
        orderBy: desc(approvalComments.created_at),
      });

      // Enrich with user names
      const userIds = [...new Set(comments.map(c => c.user_id).filter(Boolean))] as string[];
      const userMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const userRows = await db.query.users.findMany({
          where: inArray(users.id, userIds),
          columns: { id: true, email: true, first_name: true, last_name: true },
        });
        for (const u of userRows) {
          userMap[u.id] = u.first_name && u.last_name
            ? `${u.first_name} ${u.last_name}`
            : u.email;
        }
      }

      const enriched = comments.map(c => ({
        ...c,
        user_display: c.user_id ? (userMap[c.user_id] || c.user_id) : 'Agent',
      }));

      return reply.send({ comments: enriched });
    },
  );

  fastify.post<{ Params: { id: string }; Body: z.infer<typeof CommentSchema> }>(
    "/approval-gates/:id/comments",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: CommentSchema,
        tags: ["Agent Features"],
        summary: "Add a comment or request revision on an approval gate",
        response: { 201: {}, 400: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const body = CommentSchema.parse(request.body);

      const [comment] = await db.insert(approvalComments).values({
        approval_gate_id: request.params.id,
        user_id: request.user.sub,
        content: body.content,
        action: body.action,
      }).returning();

      // If revision requested, update the gate status
      if (body.action === "revision_requested") {
        await db.update(approvalGates)
          .set({ status: "revision_requested" })
          .where(eq(approvalGates.id, request.params.id));
      }

      return reply.status(201).send(comment);
    },
  );

  // ═══ 6. SKILLS MANAGEMENT ═══════════════════════════════════

  fastify.get(
    "/agent-skills",
    {
      schema: buildRouteSchema({
        tags: ["Agent Features"],
        summary: "List all agent skills for the organization",
        response: { 200: { type: "object", properties: { skills: { type: "array", items: {} } } } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const orgId = request.user.organization_id;
      const skills = await db.query.agentSkills.findMany({
        where: eq(agentSkills.organization_id, orgId),
        orderBy: desc(agentSkills.created_at),
      });
      return reply.send({ skills });
    },
  );

  fastify.post<{ Body: z.infer<typeof CreateSkillSchema> }>(
    "/agent-skills",
    {
      schema: buildRouteSchema({
        body: CreateSkillSchema,
        tags: ["Agent Features"],
        summary: "Create a new agent skill",
        response: { 201: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const body = CreateSkillSchema.parse(request.body);
      const orgId = request.user.organization_id;

      const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);

      const [skill] = await db.insert(agentSkills).values({
        organization_id: orgId,
        name: body.name,
        slug,
        description: body.description,
        category: body.category,
        knowledge: body.knowledge,
        examples: body.examples || [],
        tags: body.tags || [],
        created_by: request.user.sub,
      }).returning();

      return reply.status(201).send(skill);
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/agent-skills/:id",
    {
      schema: buildRouteSchema({
        params: IdParams,
        tags: ["Agent Features"],
        summary: "Get skill details by ID",
        response: { 200: {}, 404: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const skill = await db.query.agentSkills.findFirst({
        where: eq(agentSkills.id, request.params.id),
      });
      if (!skill) return reply.status(404).send({ error: "Skill not found" });
      return reply.send(skill);
    },
  );

  // Assign skill to agent
  fastify.post<{ Params: { agentId: string; skillId: string }; Body: z.infer<typeof AssignSkillSchema> }>(
    "/agents/:agentId/skills/:skillId",
    {
      schema: buildRouteSchema({
        params: AgentSkillParams,
        body: AssignSkillSchema,
        tags: ["Agent Features"],
        summary: "Assign a skill to an agent",
        response: { 201: {} },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const body = AssignSkillSchema.parse(request.body || {});

      const [assignment] = await db.insert(agentSkillAssignments).values({
        agent_id: request.params.agentId,
        skill_id: request.params.skillId,
        proficiency: body.proficiency,
      }).returning();

      return reply.status(201).send(assignment);
    },
  );

  // Remove skill from agent
  fastify.delete<{ Params: { agentId: string; skillId: string } }>(
    "/agents/:agentId/skills/:skillId",
    {
      schema: buildRouteSchema({
        params: AgentSkillParams,
        tags: ["Agent Features"],
        summary: "Remove a skill from an agent",
        response: { 200: { type: "object", properties: { deleted: { type: "boolean" } } } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      await db.delete(agentSkillAssignments).where(
        and(
          eq(agentSkillAssignments.agent_id, request.params.agentId),
          eq(agentSkillAssignments.skill_id, request.params.skillId),
        ),
      );
      return reply.send({ deleted: true });
    },
  );

  // List agent's skills
  fastify.get<{ Params: { agentId: string } }>(
    "/agents/:agentId/skills",
    {
      schema: buildRouteSchema({
        params: AgentIdParams,
        tags: ["Agent Features"],
        summary: "List all skills assigned to an agent",
        response: { 200: { type: "object", properties: { skills: { type: "array", items: {} } } } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const assignments = await db.query.agentSkillAssignments.findMany({
        where: eq(agentSkillAssignments.agent_id, request.params.agentId),
      });

      if (assignments.length === 0) return reply.send({ skills: [] });

      const skillIds = assignments.map(a => a.skill_id);
      const skills = await db.query.agentSkills.findMany({
        where: inArray(agentSkills.id, skillIds),
      });

      const enriched = skills.map(s => {
        const a = assignments.find(a => a.skill_id === s.id);
        return { ...s, proficiency: a?.proficiency || 'intermediate' };
      });

      return reply.send({ skills: enriched });
    },
  );

  // ═══ 7. ORG CHART ═══════════════════════════════════════════

  fastify.get(
    "/agents/org-chart",
    {
      schema: buildRouteSchema({
        tags: ["Agent Features"],
        summary: "Get hierarchical org chart of all agents",
        response: { 200: { type: "object", properties: { roots: { type: "array", items: {} }, total: { type: "number" }, departments: { type: "array", items: { type: "string" } } } } },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const agents = await db.query.agentPersonas.findMany({
        where: isNull(agentPersonas.hidden_at),
        columns: {
          id: true, name: true, slug: true, role: true, department: true,
          status: true, reports_to: true, preferred_model: true,
          preferred_provider: true, can_delegate: true,
        },
      });

      // Build tree structure
      const agentMap = new Map(agents.map(a => [a.id, a]));
      const roots: any[] = [];
      const childrenMap = new Map<string, any[]>();

      for (const agent of agents) {
        if (!agent.reports_to || !agentMap.has(agent.reports_to)) {
          roots.push(agent);
        } else {
          const children = childrenMap.get(agent.reports_to) || [];
          children.push(agent);
          childrenMap.set(agent.reports_to, children);
        }
      }

      function buildTree(agent: any): any {
        return {
          ...agent,
          children: (childrenMap.get(agent.id) || []).map(buildTree),
        };
      }

      return reply.send({
        roots: roots.map(buildTree),
        total: agents.length,
        departments: [...new Set(agents.map(a => a.department))],
      });
    },
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof ReportsToSchema> }>(
    "/agents/:id/reports-to",
    {
      schema: buildRouteSchema({
        params: IdParams,
        body: ReportsToSchema,
        tags: ["Agent Features"],
        summary: "Set reporting manager for an agent",
        response: { 200: {}, 400: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const body = ReportsToSchema.parse(request.body);

      // Prevent circular reporting
      if (body.reports_to) {
        let current = body.reports_to;
        const visited = new Set<string>();
        while (current) {
          if (current === request.params.id) {
            return reply.status(400).send({ error: "Circular reporting relationship detected" });
          }
          if (visited.has(current)) break;
          visited.add(current);
          const parent = await db.query.agentPersonas.findFirst({
            where: eq(agentPersonas.id, current),
            columns: { reports_to: true },
          });
          current = parent?.reports_to || '';
        }
      }

      const [updated] = await db.update(agentPersonas)
        .set({ reports_to: body.reports_to, updated_at: new Date() })
        .where(eq(agentPersonas.id, request.params.id))
        .returning();

      return reply.send(updated);
    },
  );
}
