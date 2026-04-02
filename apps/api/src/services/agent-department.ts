/**
 * Agent Department Service — manages agent personas, assignments, costs, and budgets.
 *
 * Follows the same patterns as PipelineService: Drizzle queries, activity logging,
 * atomic operations, and non-fatal error handling for audit trails.
 */

import { db } from "@/db/index.js";
import {
  agentPersonas,
  agentAssignments,
  agentSessions,
  agentSubtasks,
  budgetPolicies,
  costEvents,
  budgetIncidents,
  agentActivityLog,
} from "@/db/schema.js";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import {
  emitTaskAssigned,
  emitTaskStarted,
  emitTaskCompleted,
  emitTaskEscalated,
  emitStatusChanged,
} from "./agent-events.js";

// ─── ACTIVITY LOG HELPER ────────────────────────────────────────

async function logActivity(params: {
  agentId: string;
  action: string;
  pipelineRunId?: string;
  assignmentId?: string;
  details?: Record<string, unknown>;
}) {
  try {
    await db.insert(agentActivityLog).values({
      agent_id: params.agentId,
      action: params.action,
      pipeline_run_id: params.pipelineRunId,
      assignment_id: params.assignmentId,
      details: params.details || {},
    });
  } catch {
    // Never let logging failures break the operation
  }
}

// ─── PERSONA OPERATIONS ─────────────────────────────────────────

export async function listPersonas(filters?: {
  department?: string;
  role?: string;
  status?: string;
}) {
  const conditions = [];
  if (filters?.department) {
    conditions.push(eq(agentPersonas.department, filters.department));
  }
  if (filters?.role) {
    conditions.push(eq(agentPersonas.role, filters.role));
  }
  if (filters?.status) {
    conditions.push(eq(agentPersonas.status, filters.status));
  }
  // Exclude soft-deleted
  conditions.push(isNull(agentPersonas.hidden_at));

  const personas = await db.query.agentPersonas.findMany({
    where: conditions.length > 0 ? and(...conditions) : isNull(agentPersonas.hidden_at),
    orderBy: [desc(agentPersonas.role), agentPersonas.department, agentPersonas.name],
  });

  return personas;
}

export async function getPersona(id: string) {
  const persona = await db.query.agentPersonas.findFirst({
    where: and(eq(agentPersonas.id, id), isNull(agentPersonas.hidden_at)),
    with: {
      subordinates: true,
      reportsToAgent: {
        columns: { id: true, name: true, slug: true, role: true, department: true },
      },
    },
  });
  if (persona?.subordinates) {
    // Filter out soft-deleted subordinates (Drizzle relations don't support where)
    persona.subordinates = persona.subordinates.filter((s: any) => !s.hidden_at);
  }
  return persona;
}

export async function createPersona(data: {
  name: string;
  slug: string;
  role: string;
  department: string;
  system_prompt: string;
  skills?: unknown;
  tech_stack?: unknown;
  legacy_expertise?: unknown;
  modern_expertise?: unknown;
  tool_permissions?: unknown;
  stage_permissions?: unknown;
  preferred_provider?: string;
  preferred_model?: string;
  evaluator_model?: string;
  max_concurrent_tasks?: number;
  reports_to?: string;
  can_delegate?: boolean;
  monthly_budget_cents?: number;
  lifetime_budget_cents?: number;
  hard_stop_enabled?: boolean;
  warning_threshold?: string;
  session_compaction_threshold?: number;
  memory_strategy?: string;
}) {
  const [persona] = await db.insert(agentPersonas).values({
    name: data.name,
    slug: data.slug,
    role: data.role,
    department: data.department,
    system_prompt: data.system_prompt,
    skills: data.skills ?? [],
    tech_stack: data.tech_stack ?? [],
    legacy_expertise: data.legacy_expertise ?? [],
    modern_expertise: data.modern_expertise ?? [],
    tool_permissions: data.tool_permissions ?? [],
    stage_permissions: data.stage_permissions ?? [],
    preferred_provider: data.preferred_provider,
    preferred_model: data.preferred_model,
    evaluator_model: data.evaluator_model,
    max_concurrent_tasks: data.max_concurrent_tasks ?? 3,
    reports_to: data.reports_to,
    can_delegate: data.can_delegate ?? false,
    monthly_budget_cents: data.monthly_budget_cents ?? 10000,
    lifetime_budget_cents: data.lifetime_budget_cents,
    hard_stop_enabled: data.hard_stop_enabled ?? true,
    warning_threshold: data.warning_threshold ?? "0.80",
    session_compaction_threshold: data.session_compaction_threshold ?? 100000,
    memory_strategy: data.memory_strategy ?? "summary",
  }).returning();

  await logActivity({
    agentId: persona.id,
    action: "persona_created",
    details: { name: data.name, slug: data.slug },
  });

  return persona;
}

export async function updatePersona(
  id: string,
  data: Partial<{
    name: string;
    status: string;
    pause_reason: string | null;
    system_prompt: string;
    skills: unknown;
    tech_stack: unknown;
    tool_permissions: unknown;
    stage_permissions: unknown;
    preferred_provider: string;
    preferred_model: string;
    evaluator_model: string;
    max_concurrent_tasks: number;
    reports_to: string;
    can_delegate: boolean;
    monthly_budget_cents: number;
    hard_stop_enabled: boolean;
    warning_threshold: string;
    memory_strategy: string;
  }>,
) {
  const [updated] = await db.update(agentPersonas).set({
    ...data,
    updated_at: new Date(),
    version: sql`${agentPersonas.version} + 1`,
  }).where(and(eq(agentPersonas.id, id), isNull(agentPersonas.hidden_at))).returning();

  if (updated) {
    await logActivity({
      agentId: id,
      action: "persona_updated",
      details: { fields: Object.keys(data) },
    });

    // Broadcast real-time event if status changed (non-fatal)
    if (data.status) {
      try {
        emitStatusChanged({
          agentId: id,
          agentName: updated.name,
          newStatus: data.status,
          reason: data.pause_reason ?? undefined,
        });
      } catch {
        // Never let event broadcasting break the operation
      }
    }
  }

  return updated;
}

export async function softDeletePersona(id: string) {
  const [updated] = await db.update(agentPersonas).set({
    hidden_at: new Date(),
    status: "disabled",
    updated_at: new Date(),
  }).where(and(eq(agentPersonas.id, id), isNull(agentPersonas.hidden_at))).returning();

  if (updated) {
    await logActivity({
      agentId: id,
      action: "persona_soft_deleted",
    });

    // Broadcast real-time event (non-fatal)
    try {
      emitStatusChanged({
        agentId: id,
        agentName: updated.name,
        newStatus: "disabled",
        reason: "soft_deleted",
      });
    } catch {
      // Never let event broadcasting break the operation
    }
  }

  return updated;
}

// ─── ASSIGNMENT OPERATIONS ──────────────────────────────────────

export async function assignTask(
  agentId: string,
  pipelineRunId: string,
  stageName: string,
  matchScore?: number,
  assignedBy?: string,
) {
  const [assignment] = await db.insert(agentAssignments).values({
    agent_id: agentId,
    pipeline_run_id: pipelineRunId,
    stage_name: stageName,
    match_score: matchScore?.toString(),
    assigned_by: assignedBy,
    status: "assigned",
  }).returning();

  await logActivity({
    agentId,
    action: "task_assigned",
    pipelineRunId,
    assignmentId: assignment.id,
    details: { stageName, matchScore },
  });

  // Broadcast real-time event (non-fatal)
  try {
    const persona = await db.query.agentPersonas.findFirst({
      where: eq(agentPersonas.id, agentId),
      columns: { name: true },
    });
    emitTaskAssigned({
      agentId,
      agentName: persona?.name ?? agentId,
      assignmentId: assignment.id,
      pipelineRunId,
      stageName,
      matchScore,
    });
  } catch {
    // Never let event broadcasting break the operation
  }

  return assignment;
}

/**
 * Atomic task checkout — Paperclip pattern.
 * Uses conditional UPDATE to prevent double-assignment race conditions.
 * Returns null if the assignment was already checked out.
 */
export async function checkoutTask(assignmentId: string, runId: string) {
  const result = await db.execute(sql`
    UPDATE agent_assignments
    SET checkout_run_id = ${runId},
        status = 'in_progress',
        checked_out_at = NOW(),
        started_at = NOW(),
        updated_at = NOW()
    WHERE id = ${assignmentId}
      AND status = 'assigned'
      AND checkout_run_id IS NULL
    RETURNING *
  `);

  const rows = result.rows as any[];
  if (rows.length === 0) return null;

  const row = rows[0];
  await logActivity({
    agentId: row.agent_id,
    action: "task_checkout",
    assignmentId,
    details: { runId },
  });

  // Broadcast real-time event (non-fatal)
  try {
    const persona = await db.query.agentPersonas.findFirst({
      where: eq(agentPersonas.id, row.agent_id),
      columns: { name: true },
    });
    emitTaskStarted({
      agentId: row.agent_id,
      agentName: persona?.name ?? row.agent_id,
      assignmentId,
      runId,
    });
  } catch {
    // Never let event broadcasting break the operation
  }

  return row;
}

export async function completeTask(
  assignmentId: string,
  result: Record<string, unknown>,
  costCents: number,
  tokensUsed: number,
  refinementCount: number,
) {
  const [updated] = await db.update(agentAssignments).set({
    status: "completed",
    result,
    cost_cents: costCents,
    tokens_used: tokensUsed,
    refinement_count: refinementCount,
    completed_at: new Date(),
    updated_at: new Date(),
  }).where(
    and(
      eq(agentAssignments.id, assignmentId),
      eq(agentAssignments.status, "in_progress"),
    ),
  ).returning();

  if (updated) {
    await logActivity({
      agentId: updated.agent_id,
      action: "task_completed",
      assignmentId,
      details: { costCents, tokensUsed, refinementCount },
    });

    // Broadcast real-time event (non-fatal)
    try {
      const persona = await db.query.agentPersonas.findFirst({
        where: eq(agentPersonas.id, updated.agent_id),
        columns: { name: true },
      });
      emitTaskCompleted({
        agentId: updated.agent_id,
        agentName: persona?.name ?? updated.agent_id,
        assignmentId,
        costCents,
        tokensUsed,
        refinementCount,
      });
    } catch {
      // Never let event broadcasting break the operation
    }
  }

  return updated;
}

export async function escalateTask(assignmentId: string, reason: string) {
  const [updated] = await db.update(agentAssignments).set({
    status: "escalated",
    error_message: reason,
    updated_at: new Date(),
  }).where(
    and(
      eq(agentAssignments.id, assignmentId),
      eq(agentAssignments.status, "in_progress"),
    ),
  ).returning();

  if (updated) {
    await logActivity({
      agentId: updated.agent_id,
      action: "task_escalated",
      assignmentId,
      details: { reason },
    });

    // Broadcast real-time event (non-fatal)
    try {
      const persona = await db.query.agentPersonas.findFirst({
        where: eq(agentPersonas.id, updated.agent_id),
        columns: { name: true },
      });
      emitTaskEscalated({
        agentId: updated.agent_id,
        agentName: persona?.name ?? updated.agent_id,
        assignmentId,
        reason,
      });
    } catch {
      // Never let event broadcasting break the operation
    }
  }

  return updated;
}

// ─── COST OPERATIONS ────────────────────────────────────────────

/**
 * Record a cost event — immutable append-only (Paperclip pattern).
 * NEVER update or delete cost events.
 */
export async function recordCostEvent(event: {
  agent_id?: string;
  pipeline_run_id?: string;
  assignment_id?: string;
  project_id?: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  cost_cents: number;
  stage_name?: string;
  operation?: string;
}) {
  const [costEvent] = await db.insert(costEvents).values({
    agent_id: event.agent_id,
    pipeline_run_id: event.pipeline_run_id,
    assignment_id: event.assignment_id,
    project_id: event.project_id,
    provider: event.provider,
    model: event.model,
    input_tokens: event.input_tokens,
    output_tokens: event.output_tokens,
    cached_tokens: event.cached_tokens ?? 0,
    cost_cents: event.cost_cents,
    stage_name: event.stage_name,
    operation: event.operation,
  }).returning();

  // Atomically increment spent_monthly_cents on the agent persona.
  // Uses SQL arithmetic to avoid read-modify-write race conditions.
  if (event.agent_id && event.cost_cents > 0) {
    try {
      await db.update(agentPersonas).set({
        spent_monthly_cents: sql`${agentPersonas.spent_monthly_cents} + ${event.cost_cents}`,
        updated_at: new Date(),
      }).where(eq(agentPersonas.id, event.agent_id));
    } catch {
      // Non-fatal: reconcileMonthlyBudgets will correct any drift
    }
  }

  return costEvent;
}

export async function getAgentCosts(agentId: string, limit = 100) {
  return db.query.costEvents.findMany({
    where: eq(costEvents.agent_id, agentId),
    orderBy: desc(costEvents.created_at),
    limit,
  });
}

// ─── BUDGET OPERATIONS ──────────────────────────────────────────

export async function checkBudget(agentId: string): Promise<{
  allowed: boolean;
  spentCents: number;
  limitCents: number;
  percentUsed: number;
}> {
  const persona = await db.query.agentPersonas.findFirst({
    where: eq(agentPersonas.id, agentId),
    columns: {
      monthly_budget_cents: true,
      spent_monthly_cents: true,
      hard_stop_enabled: true,
      warning_threshold: true,
    },
  });

  if (!persona) {
    return { allowed: false, spentCents: 0, limitCents: 0, percentUsed: 0 };
  }

  const limitCents = persona.monthly_budget_cents;
  const spentCents = persona.spent_monthly_cents;
  const percentUsed = limitCents > 0 ? spentCents / limitCents : 0;
  const allowed = !persona.hard_stop_enabled || spentCents < limitCents;

  return { allowed, spentCents, limitCents, percentUsed };
}

// ─── DASHBOARD ──────────────────────────────────────────────────

export async function getAgentDashboard() {
  const personas = await db.query.agentPersonas.findMany({
    where: isNull(agentPersonas.hidden_at),
  });

  const activeAssignments = await db.query.agentAssignments.findMany({
    where: eq(agentAssignments.status, "in_progress"),
  });

  const recentCosts = await db.query.costEvents.findMany({
    orderBy: desc(costEvents.created_at),
    limit: 20,
  });

  const byDepartment: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let totalSpentCents = 0;

  for (const p of personas) {
    byDepartment[p.department] = (byDepartment[p.department] || 0) + 1;
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    totalSpentCents += p.spent_monthly_cents;
  }

  return {
    totalAgents: personas.length,
    byDepartment,
    byStatus,
    totalSpentCents,
    activeAssignments: activeAssignments.length,
    recentCostEvents: recentCosts,
  };
}

// ─── ACTIVITY HISTORY (Orchestration Dashboard) ─────────────────

/**
 * Returns agent activity from the last N days, pulling real data from
 * agent_activity_log, agent_assignments, agent_subtasks, and cost_events.
 *
 * Used by the orchestration dashboard to show deep insight into what agents
 * have been doing, with the ability to go back in time.
 */
export async function getAgentActivityHistory(days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // 1. Activity log entries — the audit trail
  const activityRows = await db.execute(sql`
    SELECT
      l.id,
      l.agent_id,
      l.action,
      l.pipeline_run_id,
      l.assignment_id,
      l.details,
      l.created_at,
      p.name AS agent_name,
      p.slug AS agent_slug,
      p.department,
      p.role
    FROM agent_activity_log l
    LEFT JOIN agent_personas p ON p.id = l.agent_id
    WHERE l.created_at >= ${cutoff.toISOString()}
    ORDER BY l.created_at DESC
    LIMIT 500
  `);

  // 2. Assignments — real tasks with real names, costs, tokens
  const assignmentRows = await db.execute(sql`
    SELECT
      a.id,
      a.agent_id,
      a.pipeline_run_id,
      a.stage_name,
      a.subtask_id,
      a.status,
      a.match_score,
      a.cost_cents,
      a.tokens_used,
      a.refinement_count,
      a.started_at,
      a.completed_at,
      a.created_at,
      a.error_message,
      p.name AS agent_name,
      p.slug AS agent_slug,
      p.department,
      p.role
    FROM agent_assignments a
    LEFT JOIN agent_personas p ON p.id = a.agent_id
    WHERE a.created_at >= ${cutoff.toISOString()}
    ORDER BY a.created_at DESC
    LIMIT 200
  `);

  // 3. Subtasks — work items from director delegation
  const subtaskRows = await db.execute(sql`
    SELECT
      s.id,
      s.pipeline_run_id,
      s.stage_name,
      s.title,
      s.description,
      s.priority,
      s.status,
      s.cost_cents,
      s.created_at,
      s.updated_at,
      s.assigned_agent_id,
      s.created_by_agent_id,
      pa.name AS assigned_agent_name,
      pc.name AS created_by_agent_name
    FROM agent_subtasks s
    LEFT JOIN agent_personas pa ON pa.id = s.assigned_agent_id
    LEFT JOIN agent_personas pc ON pc.id = s.created_by_agent_id
    WHERE s.created_at >= ${cutoff.toISOString()}
    ORDER BY s.created_at DESC
    LIMIT 200
  `);

  // 4. Cost events — token and cost summaries
  const costSummary = await db.execute(sql`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(cost_cents), 0) AS total_cost_cents,
      COUNT(*) AS total_llm_calls
    FROM cost_events
    WHERE created_at >= ${cutoff.toISOString()}
  `);

  // 5. Completed task count
  const completedCount = await db.execute(sql`
    SELECT COUNT(*) AS count
    FROM agent_assignments
    WHERE status = 'completed'
      AND completed_at >= ${cutoff.toISOString()}
  `);

  // 6. Per-agent stats for the period
  const perAgentStats = await db.execute(sql`
    SELECT
      a.agent_id,
      p.name AS agent_name,
      p.slug AS agent_slug,
      p.department,
      p.role,
      p.status AS current_status,
      COUNT(*) FILTER (WHERE a.status = 'completed') AS tasks_completed,
      COUNT(*) FILTER (WHERE a.status = 'in_progress') AS tasks_active,
      COUNT(*) FILTER (WHERE a.status = 'failed') AS tasks_failed,
      COALESCE(SUM(a.tokens_used), 0) AS total_tokens,
      COALESCE(SUM(a.cost_cents), 0) AS total_cost_cents,
      MAX(a.completed_at) AS last_active_at
    FROM agent_assignments a
    LEFT JOIN agent_personas p ON p.id = a.agent_id
    WHERE a.created_at >= ${cutoff.toISOString()}
    GROUP BY a.agent_id, p.name, p.slug, p.department, p.role, p.status
    ORDER BY tasks_completed DESC
  `);

  const cs = costSummary.rows[0] || {};
  const cc = completedCount.rows[0] || {};

  return {
    period: { days, since: cutoff.toISOString() },
    summary: {
      totalLLMCalls: Number(cs.total_llm_calls ?? 0),
      totalInputTokens: Number(cs.total_input_tokens ?? 0),
      totalOutputTokens: Number(cs.total_output_tokens ?? 0),
      totalTokens: Number(cs.total_input_tokens ?? 0) + Number(cs.total_output_tokens ?? 0),
      totalCostCents: Number(cs.total_cost_cents ?? 0),
      tasksCompleted: Number(cc.count ?? 0),
    },
    activityLog: activityRows.rows,
    assignments: assignmentRows.rows,
    subtasks: subtaskRows.rows,
    perAgentStats: perAgentStats.rows,
  };
}

// ─── ESCALATION QUERIES ─────────────────────────────────────────

/**
 * List all escalated assignments across agents, joined with agent names.
 */
export async function listEscalatedAssignments(filters?: {
  department?: string;
}) {
  const assignments = await db.query.agentAssignments.findMany({
    where: eq(agentAssignments.status, "escalated"),
    with: {
      agent: {
        columns: {
          id: true,
          name: true,
          slug: true,
          role: true,
          department: true,
        },
      },
    },
    orderBy: desc(agentAssignments.updated_at),
  });

  // Filter by department if requested (post-query since it's on the relation)
  if (filters?.department) {
    return assignments.filter(
      (a) => a.agent?.department === filters.department
    );
  }

  return assignments;
}

// ─── SKILL MATCHING ─────────────────────────────────────────────

export async function getMatchableAgents() {
  return db.query.agentPersonas.findMany({
    where: isNull(agentPersonas.hidden_at),
  });
}
