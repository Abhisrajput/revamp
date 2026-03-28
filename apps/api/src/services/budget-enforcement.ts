/**
 * Budget Enforcement Service — automated budget checking, pausing, reconciliation, and resets.
 *
 * Follows the same patterns as AgentDepartmentService: Drizzle queries, activity logging,
 * atomic operations, and non-fatal error handling for audit trails.
 *
 * Key behaviours:
 *   - enforceBudget()         — post-cost check: warning, hard_stop, or exceeded incident
 *   - reconcileMonthlyBudgets — recalculates spent_monthly_cents from cost_events
 *   - resetMonthlyBudgets     — zeroes out spent_monthly_cents for a new billing cycle
 *   - getAgentBudgetStatus    — read-only status snapshot for the API / UI
 */

import { db } from "@/db/index.js";
import {
  agentPersonas,
  budgetPolicies,
  budgetIncidents,
  costEvents,
  agentActivityLog,
} from "@/db/schema.js";
import { eq, and, sql, isNull, gte } from "drizzle-orm";

// ─── ACTIVITY LOG HELPER ────────────────────────────────────────

async function logActivity(params: {
  agentId: string;
  action: string;
  details?: Record<string, unknown>;
}) {
  try {
    await db.insert(agentActivityLog).values({
      agent_id: params.agentId,
      action: params.action,
      details: params.details || {},
    });
  } catch {
    // Never let logging failures break the operation
  }
}

// ─── BUDGET STATUS ──────────────────────────────────────────────

export interface AgentBudgetStatus {
  spentCents: number;
  limitCents: number;
  percentUsed: number;
  warningAt: number;
  isWarning: boolean;
  isExceeded: boolean;
  hardStop: boolean;
}

export async function getAgentBudgetStatus(
  agentId: string,
): Promise<AgentBudgetStatus | null> {
  const persona = await db.query.agentPersonas.findFirst({
    where: and(eq(agentPersonas.id, agentId), isNull(agentPersonas.hidden_at)),
    columns: {
      monthly_budget_cents: true,
      spent_monthly_cents: true,
      hard_stop_enabled: true,
      warning_threshold: true,
    },
  });

  if (!persona) return null;

  const limitCents = persona.monthly_budget_cents;
  const spentCents = persona.spent_monthly_cents;
  const warningAt = parseFloat(persona.warning_threshold);
  const percentUsed = limitCents > 0 ? spentCents / limitCents : 0;
  const isWarning = percentUsed >= warningAt && percentUsed < 1;
  const isExceeded = percentUsed >= 1;

  return {
    spentCents,
    limitCents,
    percentUsed,
    warningAt,
    isWarning,
    isExceeded,
    hardStop: persona.hard_stop_enabled,
  };
}

// ─── ENFORCE BUDGET ─────────────────────────────────────────────

/**
 * Check an agent's budget after a cost event and take action if thresholds are crossed.
 *
 * Actions:
 *   - Warning threshold reached → create budget_incident (type='warning'), log activity
 *   - Limit reached + hard_stop_enabled → pause agent, create budget_incident (type='hard_stop')
 *   - Limit reached + NOT hard_stop   → create budget_incident (type='exceeded'), log only
 */
export async function enforceBudget(agentId: string): Promise<void> {
  const persona = await db.query.agentPersonas.findFirst({
    where: and(eq(agentPersonas.id, agentId), isNull(agentPersonas.hidden_at)),
    columns: {
      id: true,
      monthly_budget_cents: true,
      spent_monthly_cents: true,
      hard_stop_enabled: true,
      warning_threshold: true,
      status: true,
    },
  });

  if (!persona) return;

  const limitCents = persona.monthly_budget_cents;
  const spentCents = persona.spent_monthly_cents;

  // Skip if there's no meaningful budget
  if (limitCents <= 0) return;

  const percentUsed = spentCents / limitCents;
  const warningAt = parseFloat(persona.warning_threshold);

  // Already paused for budget — nothing to do
  if (persona.status === "paused") return;

  // Resolve or create the budget policy to reference in incidents.
  // Look for an active agent-scoped monthly policy; create one on the fly if missing.
  const policyId = await resolveOrCreatePolicy(agentId, limitCents, warningAt, persona.hard_stop_enabled);

  // ── At or over limit ───────────────────────────────────────────
  if (spentCents >= limitCents) {
    if (persona.hard_stop_enabled) {
      // Hard stop → pause the agent
      await db.update(agentPersonas).set({
        status: "paused",
        pause_reason: "budget_exceeded",
        updated_at: new Date(),
      }).where(eq(agentPersonas.id, agentId));

      await db.insert(budgetIncidents).values({
        policy_id: policyId,
        agent_id: agentId,
        incident_type: "hard_stop",
        current_spend_cents: spentCents,
        limit_cents: limitCents,
        percent_used: percentUsed.toFixed(2),
        action_taken: "agent_paused",
      });

      await logActivity({
        agentId,
        action: "budget_hard_stop",
        details: { spentCents, limitCents, percentUsed },
      });
    } else {
      // No hard stop — record the overage but let the agent continue
      await db.insert(budgetIncidents).values({
        policy_id: policyId,
        agent_id: agentId,
        incident_type: "overage",
        current_spend_cents: spentCents,
        limit_cents: limitCents,
        percent_used: percentUsed.toFixed(2),
        action_taken: "logged_only",
      });

      await logActivity({
        agentId,
        action: "budget_exceeded_no_stop",
        details: { spentCents, limitCents, percentUsed },
      });
    }
    return;
  }

  // ── Warning threshold ──────────────────────────────────────────
  if (percentUsed >= warningAt) {
    // Only create one warning incident per threshold crossing per month.
    // Check if we already have an unresolved warning for this agent this month.
    const monthStart = getMonthStart();
    const existing = await db.query.budgetIncidents.findFirst({
      where: and(
        eq(budgetIncidents.agent_id, agentId),
        eq(budgetIncidents.incident_type, "warning"),
        eq(budgetIncidents.resolved, false),
        gte(budgetIncidents.created_at, monthStart),
      ),
    });

    if (!existing) {
      await db.insert(budgetIncidents).values({
        policy_id: policyId,
        agent_id: agentId,
        incident_type: "warning",
        current_spend_cents: spentCents,
        limit_cents: limitCents,
        percent_used: percentUsed.toFixed(2),
        action_taken: "warning_logged",
      });

      await logActivity({
        agentId,
        action: "budget_warning",
        details: { spentCents, limitCents, percentUsed, warningAt },
      });
    }
  }
}

// ─── RECONCILE MONTHLY BUDGETS ──────────────────────────────────

/**
 * Recalculate spent_monthly_cents from cost_events for the current month for all agents.
 * This corrects any drift between the running counter and the immutable cost_events ledger.
 */
export async function reconcileMonthlyBudgets(): Promise<{
  agentsReconciled: number;
}> {
  const monthStart = getMonthStart();

  // Aggregate actual spend from cost_events for this month, grouped by agent
  const aggregated = await db.execute(sql`
    SELECT
      agent_id,
      COALESCE(SUM(cost_cents), 0)::int AS total_spent
    FROM cost_events
    WHERE agent_id IS NOT NULL
      AND created_at >= ${monthStart}
    GROUP BY agent_id
  `);

  const rows = aggregated.rows as Array<{ agent_id: string; total_spent: number }>;

  // Update each agent's spent_monthly_cents to match the ledger
  for (const row of rows) {
    await db.update(agentPersonas).set({
      spent_monthly_cents: row.total_spent,
      updated_at: new Date(),
    }).where(eq(agentPersonas.id, row.agent_id));
  }

  // Zero out agents that have NO cost events this month (they may have been reset already)
  await db.execute(sql`
    UPDATE agent_personas
    SET spent_monthly_cents = 0,
        updated_at = NOW()
    WHERE hidden_at IS NULL
      AND spent_monthly_cents != 0
      AND id NOT IN (
        SELECT DISTINCT agent_id
        FROM cost_events
        WHERE agent_id IS NOT NULL
          AND created_at >= ${monthStart}
      )
  `);

  await logActivity({
    agentId: "system",
    action: "budgets_reconciled",
    details: { agentsReconciled: rows.length, month: monthStart.toISOString() },
  });

  return { agentsReconciled: rows.length };
}

// ─── RESET MONTHLY BUDGETS ─────────────────────────────────────

/**
 * At the start of a new billing month, reset all agents' spent_monthly_cents to 0
 * and resolve any unresolved budget incidents from the previous month.
 */
export async function resetMonthlyBudgets(): Promise<{
  agentsReset: number;
  incidentsResolved: number;
}> {
  // Reset all agents' monthly spend
  const resetResult = await db.execute(sql`
    UPDATE agent_personas
    SET spent_monthly_cents = 0,
        updated_at = NOW()
    WHERE hidden_at IS NULL
      AND spent_monthly_cents > 0
  `);

  const agentsReset = (resetResult.rowCount as number) ?? 0;

  // Resolve all unresolved budget incidents
  const resolveResult = await db.execute(sql`
    UPDATE budget_incidents
    SET resolved = true
    WHERE resolved = false
  `);

  const incidentsResolved = (resolveResult.rowCount as number) ?? 0;

  await logActivity({
    agentId: "system",
    action: "monthly_budgets_reset",
    details: { agentsReset, incidentsResolved },
  });

  return { agentsReset, incidentsResolved };
}

// ─── RESUME AGENT ───────────────────────────────────────────────

/**
 * Resume an agent that was paused due to budget_exceeded.
 * Clears pause_reason and sets status back to idle.
 */
export async function resumeAgent(agentId: string): Promise<boolean> {
  const [updated] = await db.update(agentPersonas).set({
    status: "idle",
    pause_reason: null,
    updated_at: new Date(),
  }).where(
    and(
      eq(agentPersonas.id, agentId),
      eq(agentPersonas.status, "paused"),
      isNull(agentPersonas.hidden_at),
    ),
  ).returning();

  if (updated) {
    // Resolve related budget incidents for this agent
    await db.execute(sql`
      UPDATE budget_incidents
      SET resolved = true
      WHERE agent_id = ${agentId}
        AND resolved = false
    `);

    await logActivity({
      agentId,
      action: "agent_resumed",
      details: { previousPauseReason: "budget_exceeded" },
    });

    return true;
  }

  return false;
}

// ─── HELPERS ────────────────────────────────────────────────────

function getMonthStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * Find or create an agent-scoped monthly budget policy for incident tracking.
 */
async function resolveOrCreatePolicy(
  agentId: string,
  limitCents: number,
  warnPercent: number,
  hardStop: boolean,
): Promise<string> {
  const existing = await db.query.budgetPolicies.findFirst({
    where: and(
      eq(budgetPolicies.scope_type, "agent"),
      eq(budgetPolicies.scope_id, agentId),
      eq(budgetPolicies.window, "monthly"),
      eq(budgetPolicies.active, true),
    ),
    columns: { id: true },
  });

  if (existing) return existing.id;

  const [policy] = await db.insert(budgetPolicies).values({
    scope_type: "agent",
    scope_id: agentId,
    metric: "billed_cents",
    window: "monthly",
    limit_cents: limitCents,
    warn_percent: warnPercent.toFixed(2),
    hard_stop: hardStop,
    notify_enabled: true,
  }).returning();

  return policy.id;
}
