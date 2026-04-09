/**
 * Agent Delegation Service — hierarchical task delegation and escalation.
 *
 * Directors can delegate to leads, leads can delegate to specialists.
 * When a specialist can't complete a task, it escalates up the chain.
 * Subtask decomposition allows manager agents to break work into pieces.
 */

import { db } from "@/db/index.js";
import {
  agentPersonas,
  agentAssignments,
  agentSubtasks,
  agentActivityLog,
} from "@/db/schema.js";
import { eq, and, isNull, sql, desc, asc } from "drizzle-orm";

// ─── TYPES ──────────────────────────────────────────────────────

export interface DelegationTarget {
  id: string;
  name: string;
  slug: string;
  role: string;
  department: string;
  status: string;
  skills: unknown[];
}

export interface SubtaskInput {
  pipelineRunId: string;
  stageName: string;
  title: string;
  description?: string;
  requiredSkills?: string[];
  requiredTechStack?: string[];
  priority?: number;
  parentSubtaskId?: string;
}

export interface SubtaskView {
  id: string;
  parentSubtaskId: string | null;
  pipelineRunId: string;
  stageName: string;
  title: string;
  description: string | null;
  requiredSkills: string[];
  requiredTechStack: string[];
  priority: number;
  status: string;
  assignedAgentId: string | null;
  assignedAgentName?: string;
  createdByAgentId: string;
  createdByAgentName?: string;
  result: unknown;
  costCents: number;
  createdAt: string;
  updatedAt: string;
}

// ─── HIERARCHY ──────────────────────────────────────────────────

/**
 * Get subordinates of a given agent (agents who report to this one).
 */
export async function getSubordinates(agentId: string): Promise<DelegationTarget[]> {
  const subs = await db.query.agentPersonas.findMany({
    where: and(
      eq(agentPersonas.reports_to, agentId),
      isNull(agentPersonas.hidden_at),
    ),
  });

  return subs.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    role: s.role,
    department: s.department,
    status: s.status,
    skills: (s.skills as unknown[]) || [],
  }));
}

/**
 * Get the reporting chain for an agent (up to the director).
 */
export async function getReportingChain(agentId: string): Promise<DelegationTarget[]> {
  // Load all non-hidden agents once to avoid N+1 queries per hierarchy level
  const allAgents = await db.query.agentPersonas.findMany({
    where: isNull(agentPersonas.hidden_at),
  });
  const agentMap = new Map(allAgents.map((a) => [a.id, a]));

  const chain: DelegationTarget[] = [];
  let currentId: string | null = agentId;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const agent = agentMap.get(currentId);
    if (!agent) break;

    if (agent.id !== agentId) {
      chain.push({
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        role: agent.role,
        department: agent.department,
        status: agent.status,
        skills: (agent.skills as unknown[]) || [],
      });
    }

    currentId = agent.reports_to;
  }

  return chain;
}

/**
 * Get the full org tree for a department.
 */
export async function getDepartmentTree(department: string): Promise<{
  director: DelegationTarget | null;
  leads: DelegationTarget[];
  specialists: DelegationTarget[];
}> {
  const agents = await db.query.agentPersonas.findMany({
    where: and(
      eq(agentPersonas.department, department),
      isNull(agentPersonas.hidden_at),
    ),
  });

  const director = agents.find((a) => a.role === "director") ?? null;
  const leads = agents.filter((a) => a.role === "lead");
  const specialists = agents.filter((a) => a.role === "specialist");

  const toTarget = (a: typeof agents[0]): DelegationTarget => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    role: a.role,
    department: a.department,
    status: a.status,
    skills: (a.skills as unknown[]) || [],
  });

  return {
    director: director ? toTarget(director) : null,
    leads: leads.map(toTarget),
    specialists: specialists.map(toTarget),
  };
}

// ─── SUBTASK MANAGEMENT ─────────────────────────────────────────

/**
 * Create a subtask (manager agents decompose work into pieces).
 */
export async function createSubtask(
  createdByAgentId: string,
  input: SubtaskInput,
): Promise<SubtaskView> {
  const [subtask] = await db
    .insert(agentSubtasks)
    .values({
      parent_subtask_id: input.parentSubtaskId,
      pipeline_run_id: input.pipelineRunId,
      stage_name: input.stageName,
      title: input.title,
      description: input.description,
      required_skills: input.requiredSkills || [],
      required_tech_stack: input.requiredTechStack || [],
      priority: input.priority ?? 5,
      status: "backlog",
      created_by_agent_id: createdByAgentId,
    })
    .returning();

  await logActivity(createdByAgentId, "subtask_created", {
    subtaskId: subtask.id,
    title: input.title,
    pipelineRunId: input.pipelineRunId,
  });

  return formatSubtask(subtask);
}

/**
 * Assign a subtask to a specialist agent.
 */
export async function assignSubtask(
  subtaskId: string,
  agentId: string,
  assignedBy: string,
): Promise<SubtaskView | null> {
  const [updated] = await db
    .update(agentSubtasks)
    .set({
      assigned_agent_id: agentId,
      status: "assigned",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSubtasks.id, subtaskId),
        eq(agentSubtasks.status, "backlog"),
      ),
    )
    .returning();

  if (!updated) return null;

  await logActivity(assignedBy, "subtask_assigned", {
    subtaskId,
    assignedTo: agentId,
  });

  return formatSubtask(updated);
}

/**
 * Atomic checkout — claim exclusive ownership of a subtask.
 * Returns null with `conflict: true` if another agent already has it.
 * Inspired by Paperclip's atomic checkout pattern (409 Conflict).
 */
export async function checkoutSubtask(
  subtaskId: string,
  agentId: string,
): Promise<{ subtask: SubtaskView | null; conflict: boolean; currentOwner?: string }> {
  // Atomic: only succeed if no one else has checked it out
  const [updated] = await db
    .update(agentSubtasks)
    .set({
      assigned_agent_id: agentId,
      status: "in_progress",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSubtasks.id, subtaskId),
        sql`(${agentSubtasks.assigned_agent_id} IS NULL OR ${agentSubtasks.assigned_agent_id} = ${agentId})`,
        sql`${agentSubtasks.status} IN ('backlog', 'assigned', 'needs_context')`,
      ),
    )
    .returning();

  if (updated) {
    await logActivity(agentId, "subtask_checked_out", { subtaskId });
    return { subtask: formatSubtask(updated), conflict: false };
  }

  // Conflict — check who owns it
  const existing = await db.query.agentSubtasks.findFirst({
    where: eq(agentSubtasks.id, subtaskId),
  });

  return {
    subtask: null,
    conflict: true,
    currentOwner: existing?.assigned_agent_id ?? undefined,
  };
}

/**
 * Complete a subtask with results.
 */
export async function completeSubtask(
  subtaskId: string,
  result: Record<string, unknown>,
  costCents: number,
): Promise<SubtaskView | null> {
  const [updated] = await db
    .update(agentSubtasks)
    .set({
      status: "completed",
      result,
      cost_cents: costCents,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(agentSubtasks.id, subtaskId),
        eq(agentSubtasks.status, "in_progress"),
      ),
    )
    .returning();

  if (!updated) return null;

  if (updated.assigned_agent_id) {
    await logActivity(updated.assigned_agent_id, "subtask_completed", {
      subtaskId,
      costCents,
    });
  }

  return formatSubtask(updated);
}

/**
 * Fail a subtask.
 */
export async function failSubtask(
  subtaskId: string,
  reason: string,
): Promise<SubtaskView | null> {
  const [updated] = await db
    .update(agentSubtasks)
    .set({
      status: "failed",
      result: { error: reason },
      updated_at: new Date(),
    })
    .where(eq(agentSubtasks.id, subtaskId))
    .returning();

  if (!updated) return null;

  return formatSubtask(updated);
}

/**
 * Mark a subtask as blocked — the agent hit an obstacle it cannot resolve.
 * Escalates to the director/manager via the reporting chain.
 * Inspired by Superpowers' BLOCKED status code pattern.
 */
export async function blockSubtask(
  subtaskId: string,
  reason: string,
  blockedBy?: string, // what's blocking: "missing_context" | "dependency" | "permission" | "error"
): Promise<SubtaskView | null> {
  const [updated] = await db
    .update(agentSubtasks)
    .set({
      status: "blocked",
      result: { blocked: true, reason, blockedBy: blockedBy || "unknown" },
      updated_at: new Date(),
    })
    .where(eq(agentSubtasks.id, subtaskId))
    .returning();

  if (!updated) return null;

  if (updated.assigned_agent_id) {
    await logActivity(updated.assigned_agent_id, "subtask_blocked", {
      subtaskId,
      reason,
      blockedBy,
    });
  }

  return formatSubtask(updated);
}

/**
 * Mark a subtask as needing additional context before it can proceed.
 * The agent has made progress but needs data from another subtask or external source.
 * Inspired by Superpowers' NEEDS_CONTEXT status code.
 */
export async function requestContextForSubtask(
  subtaskId: string,
  contextNeeded: string,
  partialResult?: Record<string, unknown>,
): Promise<SubtaskView | null> {
  const [updated] = await db
    .update(agentSubtasks)
    .set({
      status: "needs_context",
      result: {
        ...(partialResult || {}),
        needs_context: true,
        context_needed: contextNeeded,
      },
      updated_at: new Date(),
    })
    .where(eq(agentSubtasks.id, subtaskId))
    .returning();

  if (!updated) return null;

  if (updated.assigned_agent_id) {
    await logActivity(updated.assigned_agent_id, "subtask_needs_context", {
      subtaskId,
      contextNeeded,
    });
  }

  return formatSubtask(updated);
}

/**
 * List subtasks for a pipeline run (optionally filtered by stage).
 */
export async function listSubtasks(
  pipelineRunId: string,
  stageName?: string,
): Promise<SubtaskView[]> {
  const conditions = [eq(agentSubtasks.pipeline_run_id, pipelineRunId)];
  if (stageName) {
    conditions.push(eq(agentSubtasks.stage_name, stageName));
  }

  const subtasks = await db.query.agentSubtasks.findMany({
    where: and(...conditions),
    orderBy: [asc(agentSubtasks.priority), asc(agentSubtasks.created_at)],
  });

  return subtasks.map(formatSubtask);
}

/**
 * Get children subtasks of a parent subtask.
 */
export async function getChildSubtasks(parentSubtaskId: string): Promise<SubtaskView[]> {
  const subtasks = await db.query.agentSubtasks.findMany({
    where: eq(agentSubtasks.parent_subtask_id, parentSubtaskId),
    orderBy: [asc(agentSubtasks.priority)],
  });

  return subtasks.map(formatSubtask);
}

// ─── HELPERS ────────────────────────────────────────────────────

function formatSubtask(s: typeof agentSubtasks.$inferSelect): SubtaskView {
  return {
    id: s.id,
    parentSubtaskId: s.parent_subtask_id,
    pipelineRunId: s.pipeline_run_id,
    stageName: s.stage_name,
    title: s.title,
    description: s.description,
    requiredSkills: (s.required_skills as string[]) || [],
    requiredTechStack: (s.required_tech_stack as string[]) || [],
    priority: s.priority,
    status: s.status,
    assignedAgentId: s.assigned_agent_id,
    createdByAgentId: s.created_by_agent_id,
    result: s.result,
    costCents: s.cost_cents,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
  };
}

async function logActivity(
  agentId: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(agentActivityLog).values({
      agent_id: agentId,
      action,
      details,
    });
  } catch {
    // Never let logging break operations
  }
}
