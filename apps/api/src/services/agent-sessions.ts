/**
 * Agent Session Service — manages session chains for agent context continuity.
 *
 * The session chain pattern (from Paperclip) preserves agent context across
 * multiple pipeline stage invocations. Each session links to its predecessor
 * via session_id_before, forming a chain that can be traversed or compacted.
 *
 * When token counts exceed the compaction threshold, older sessions get
 * summarized into a compact form to stay within LLM context limits while
 * preserving key learnings.
 */

import crypto from "crypto";
import { db } from "@/db/index.js";
import { agentSessions, agentPersonas } from "@/db/schema.js";
import { eq, and, desc, sql, asc } from "drizzle-orm";

/**
 * Well-known UUID for system-level operations (not tied to a real agent).
 * Used when the orchestrator creates sessions/subtasks without a specific agent.
 */
export const SYSTEM_AGENT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Generate a deterministic UUID v5 from a composite string key.
 * Used to convert non-UUID task identifiers into valid UUIDs while
 * maintaining idempotency (same key → same UUID).
 */
export function deterministicUUID(key: string): string {
  // Use SHA-256 to hash the key, then format as UUID v5
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  // Format: 8-4-4-4-12, set version nibble to 5, variant to 10xx
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "5" + hash.slice(13, 16),          // version 5
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20), // variant 10xx
    hash.slice(20, 32),
  ].join("-");
}

// ─── TYPES ──────────────────────────────────────────────────────

/**
 * Memory tier — two-tier memory pattern (inspired by MetaGPT):
 *   - "working": task-specific memory, scoped to a single pipeline run.
 *                Cleared after the pipeline completes. Used for subtask
 *                context threading within a run.
 *   - "persistent": cross-pipeline learnings that carry forward to future
 *                   runs. Never auto-cleared. Used for evolution memories,
 *                   agent skill improvements, and codebase familiarity.
 */
export type MemoryTier = "working" | "persistent";

export interface SessionData {
  /** Memory tier: "working" (auto-cleared) or "persistent" (carries forward) */
  memoryTier?: MemoryTier;
  /** Context from the previous stage execution */
  stageContext?: Record<string, unknown>;
  /** Key findings/learnings the agent accumulated */
  findings?: string[];
  /** Decisions made and their rationale */
  decisions?: Array<{ decision: string; rationale: string }>;
  /** Warnings or risks identified */
  warnings?: string[];
  /** Custom data from the agent's execution */
  custom?: Record<string, unknown>;
}

export interface SessionChainEntry {
  id: string;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  sessionData: SessionData | null;
  tokenCount: number;
  compacted: boolean;
  compactionSummary: string | null;
  createdAt: string;
}

export interface SessionContext {
  /** The current session ID (latest in chain) */
  currentSessionId: string | null;
  /** Combined context from the chain for injection into prompts */
  contextSummary: string;
  /** Total tokens across the chain */
  totalTokens: number;
  /** Number of sessions in the chain */
  chainLength: number;
}

// ─── CREATE SESSION ─────────────────────────────────────────────

/**
 * Create a new session entry in the chain for an agent working on a task.
 * Links to the previous session if one exists.
 */
export async function createSession(params: {
  agentId: string;
  taskId: string;
  pipelineRunId?: string;
  sessionData: SessionData;
  tokenCount: number;
}): Promise<string> {
  return await db.transaction(async (tx) => {
    // Find the latest session for this agent+task to chain from
    const previous = await tx.query.agentSessions.findFirst({
      where: and(
        eq(agentSessions.agent_id, params.agentId),
        eq(agentSessions.task_id, params.taskId),
      ),
      orderBy: [desc(agentSessions.created_at)],
    });

    const sessionIdBefore = previous?.id ?? null;

    const [session] = await tx
      .insert(agentSessions)
      .values({
        agent_id: params.agentId,
        task_id: params.taskId,
        pipeline_run_id: params.pipelineRunId,
        session_id_before: sessionIdBefore,
        session_data: params.sessionData,
        token_count: params.tokenCount,
      })
      .returning();

    // Update the previous session's forward pointer
    if (sessionIdBefore) {
      await tx
        .update(agentSessions)
        .set({ session_id_after: session.id })
        .where(eq(agentSessions.id, sessionIdBefore));
    }

    return session.id;
  });
}

// ─── GET SESSION CHAIN ──────────────────────────────────────────

/**
 * Retrieve the full session chain for an agent working on a task.
 * Returns sessions in chronological order.
 */
export async function getSessionChain(
  agentId: string,
  taskId: string,
): Promise<SessionChainEntry[]> {
  const sessions = await db.query.agentSessions.findMany({
    where: and(
      eq(agentSessions.agent_id, agentId),
      eq(agentSessions.task_id, taskId),
    ),
    orderBy: [asc(agentSessions.created_at)],
  });

  return sessions.map((s) => ({
    id: s.id,
    sessionIdBefore: s.session_id_before,
    sessionIdAfter: s.session_id_after,
    sessionData: s.session_data as SessionData | null,
    tokenCount: s.token_count,
    compacted: s.compacted,
    compactionSummary: s.compaction_summary,
    createdAt: s.created_at.toISOString(),
  }));
}

// ─── BUILD SESSION CONTEXT ──────────────────────────────────────

/**
 * Build a context summary from an agent's session chain.
 * Combines compaction summaries with recent session data to create
 * a prompt-injectable context block.
 */
export async function buildSessionContext(
  agentId: string,
  taskId: string,
): Promise<SessionContext> {
  const chain = await getSessionChain(agentId, taskId);

  if (chain.length === 0) {
    return {
      currentSessionId: null,
      contextSummary: "",
      totalTokens: 0,
      chainLength: 0,
    };
  }

  const parts: string[] = [];
  let totalTokens = 0;

  for (const entry of chain) {
    totalTokens += entry.tokenCount;

    if (entry.compacted && entry.compactionSummary) {
      // Use the compacted summary instead of raw data
      parts.push(`[Compacted session]: ${entry.compactionSummary}`);
      continue;
    }

    const data = entry.sessionData;
    if (!data) continue;

    const sections: string[] = [];

    if (data.findings && data.findings.length > 0) {
      sections.push(`Findings: ${data.findings.join("; ")}`);
    }
    if (data.decisions && data.decisions.length > 0) {
      sections.push(
        `Decisions: ${data.decisions.map((d) => `${d.decision} (${d.rationale})`).join("; ")}`,
      );
    }
    if (data.warnings && data.warnings.length > 0) {
      sections.push(`Warnings: ${data.warnings.join("; ")}`);
    }

    if (sections.length > 0) {
      parts.push(sections.join("\n"));
    }
  }

  const latest = chain[chain.length - 1];

  return {
    currentSessionId: latest.id,
    contextSummary: parts.length > 0
      ? `--- Agent Session Context ---\n${parts.join("\n---\n")}\n--- End Session Context ---`
      : "",
    totalTokens,
    chainLength: chain.length,
  };
}

// ─── COMPACT OLD SESSIONS ───────────────────────────────────────

/**
 * Compact older sessions in a chain when the total token count exceeds
 * the agent's compaction threshold. Replaces raw session data with a
 * summary while preserving the chain links.
 *
 * Compaction strategy:
 *   1. Keep the N most recent sessions uncompacted
 *   2. For older sessions, generate a summary from findings/decisions
 *   3. Clear the raw session_data and set compacted=true
 */
/**
 * Per-stage compaction thresholds — early stages (SCAN, DECODE) accumulate
 * shorter sessions and compact sooner, while later stages (FORGE, Co-Create)
 * need deeper context and compact less aggressively.
 */
const STAGE_COMPACTION_THRESHOLDS: Record<string, number> = {
  SCAN: 50000,
  DECODE: 60000,
  BLUEPRINT: 80000,
  SPEC_LOCK: 80000,
  ARCHITECT: 100000,
  FORGE: 120000,
  SHADOW_RUN: 80000,
  EVOLVE: 60000,
};

/**
 * Resolve the compaction threshold for a given agent + stage combination.
 * Priority: per-stage override → agent's personal threshold → global default.
 */
function resolveCompactionThreshold(
  agentThreshold: number | null | undefined,
  stageName?: string,
): number {
  // Per-stage override takes priority
  if (stageName && STAGE_COMPACTION_THRESHOLDS[stageName]) {
    return STAGE_COMPACTION_THRESHOLDS[stageName];
  }
  // Agent's personal threshold
  if (agentThreshold && agentThreshold > 0) {
    return agentThreshold;
  }
  // Global default
  return 100000;
}

export type LLMSummaryFn = (prompt: string) => Promise<string>;

export async function compactSessionChain(
  agentId: string,
  taskId: string,
  options?: {
    /** Number of recent sessions to keep uncompacted (default: 3) */
    keepRecent?: number;
    /** Stage name for per-stage threshold resolution */
    stageName?: string;
    /** Optional LLM function for generating richer summaries */
    llmSummaryFn?: LLMSummaryFn;
  },
): Promise<{ compacted: number; totalTokensBefore: number; totalTokensAfter: number }> {
  const keepRecent = options?.keepRecent ?? 3;

  // Get the agent's compaction threshold
  const agent = await db.query.agentPersonas.findFirst({
    where: eq(agentPersonas.id, agentId),
    columns: { session_compaction_threshold: true, memory_strategy: true },
  });

  const threshold = resolveCompactionThreshold(
    agent?.session_compaction_threshold,
    options?.stageName,
  );
  const chain = await getSessionChain(agentId, taskId);

  const totalTokensBefore = chain.reduce((sum, s) => sum + s.tokenCount, 0);

  // Only compact if above threshold
  if (totalTokensBefore < threshold) {
    return { compacted: 0, totalTokensBefore, totalTokensAfter: totalTokensBefore };
  }

  // Sessions to compact (all except the N most recent)
  const toCompact = chain
    .filter((s) => !s.compacted)
    .slice(0, -keepRecent);

  if (toCompact.length === 0) {
    return { compacted: 0, totalTokensBefore, totalTokensAfter: totalTokensBefore };
  }

  // If LLM summary function is provided, batch-summarize older sessions
  // for a richer handoff summary (instead of simple concatenation).
  let llmBatchSummary: string | null = null;
  if (options?.llmSummaryFn && toCompact.length >= 2) {
    try {
      llmBatchSummary = await generateLlmHandoffSummary(toCompact, options.llmSummaryFn);
    } catch {
      // LLM summary failed — fall back to deterministic
      llmBatchSummary = null;
    }
  }

  let compactedCount = 0;

  for (let i = 0; i < toCompact.length; i++) {
    const session = toCompact[i];
    const data = session.sessionData;

    if (!data) {
      await db
        .update(agentSessions)
        .set({ compacted: true, session_data: null })
        .where(eq(agentSessions.id, session.id));
      compactedCount++;
      continue;
    }

    // For the first session in the batch, store the LLM summary (if available).
    // Subsequent sessions get a minimal marker pointing to the batch summary.
    let summary: string;
    if (i === 0 && llmBatchSummary) {
      summary = llmBatchSummary;
    } else if (llmBatchSummary) {
      summary = `[Included in batch summary on session ${toCompact[0].id}]`;
    } else {
      // Deterministic summary fallback
      summary = buildDeterministicSummary(data);
    }

    await db
      .update(agentSessions)
      .set({
        compacted: true,
        compaction_summary: summary,
        session_data: null, // free the raw data
      })
      .where(eq(agentSessions.id, session.id));

    compactedCount++;
  }

  // Recalculate total tokens (compacted sessions count as ~100 tokens for the summary)
  const COMPACTED_TOKEN_ESTIMATE = 100;
  const compactedIds = new Set(toCompact.map((c) => c.id));
  const remaining = chain.filter((s) => !compactedIds.has(s.id));
  const totalTokensAfter =
    remaining.reduce((sum, s) => sum + s.tokenCount, 0) +
    compactedCount * COMPACTED_TOKEN_ESTIMATE;

  return { compacted: compactedCount, totalTokensBefore, totalTokensAfter };
}

/**
 * Build a deterministic summary from session data.
 * Used as fallback when LLM summary is not available.
 */
function buildDeterministicSummary(data: SessionData): string {
  const parts: string[] = [];

  if (data.findings && data.findings.length > 0) {
    parts.push(`Found: ${data.findings.slice(0, 5).join(", ")}`);
  }
  if (data.decisions && data.decisions.length > 0) {
    parts.push(
      `Decided: ${data.decisions.slice(0, 3).map((d) => d.decision).join(", ")}`,
    );
  }
  if (data.warnings && data.warnings.length > 0) {
    parts.push(`Warned: ${data.warnings.slice(0, 3).join(", ")}`);
  }

  return parts.join(". ") || "No notable context.";
}

/**
 * Generate an LLM-powered handoff summary that distills multiple sessions
 * into a coherent context handoff. Much richer than concatenated bullet points.
 */
async function generateLlmHandoffSummary(
  sessions: SessionChainEntry[],
  llmFn: LLMSummaryFn,
): Promise<string> {
  const sessionTexts = sessions
    .filter((s) => s.sessionData)
    .map((s, i) => {
      const d = s.sessionData!;
      const parts: string[] = [`Session ${i + 1} (${s.createdAt}):`];
      if (d.findings?.length) parts.push(`  Findings: ${d.findings.join("; ")}`);
      if (d.decisions?.length)
        parts.push(`  Decisions: ${d.decisions.map((x) => `${x.decision} (${x.rationale})`).join("; ")}`);
      if (d.warnings?.length) parts.push(`  Warnings: ${d.warnings.join("; ")}`);
      if (d.stageContext) parts.push(`  Context: ${JSON.stringify(d.stageContext)}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const prompt = [
    "Summarize the following agent session history into a concise handoff document.",
    "Focus on: key findings, decisions made and their rationale, unresolved issues, and warnings.",
    "The summary should allow a successor agent to understand what was done and continue the work.",
    "Keep it under 500 words. Use bullet points for findings and decisions.",
    "",
    "=== SESSION HISTORY ===",
    sessionTexts,
    "=== END ===",
    "",
    "Write the handoff summary:",
  ].join("\n");

  return llmFn(prompt);
}

// ─── GET AGENT SESSIONS ─────────────────────────────────────────

/**
 * Get all sessions for an agent (across all tasks).
 */
export async function getAgentSessions(
  agentId: string,
  limit = 50,
): Promise<SessionChainEntry[]> {
  const sessions = await db.query.agentSessions.findMany({
    where: eq(agentSessions.agent_id, agentId),
    orderBy: [desc(agentSessions.created_at)],
    limit,
  });

  return sessions.map((s) => ({
    id: s.id,
    sessionIdBefore: s.session_id_before,
    sessionIdAfter: s.session_id_after,
    sessionData: s.session_data as SessionData | null,
    tokenCount: s.token_count,
    compacted: s.compacted,
    compactionSummary: s.compaction_summary,
    createdAt: s.created_at.toISOString(),
  }));
}

// ─── DELETE AGENT SESSIONS ──────────────────────────────────────

/**
 * Delete all sessions for an agent (used when soft-deleting a persona).
 */
export async function deleteAgentSessions(agentId: string): Promise<number> {
  const result = await db
    .delete(agentSessions)
    .where(eq(agentSessions.agent_id, agentId))
    .returning({ id: agentSessions.id });

  return result.length;
}

// ─── TWO-TIER MEMORY ───────────────────────────────────────────

/**
 * Create a working memory session (auto-cleared after pipeline completes).
 * Used for subtask context threading within a single pipeline run.
 */
export async function createWorkingMemory(params: {
  agentId: string;
  pipelineRunId: string;
  subtaskType: string;
  findings: string[];
  decisions?: Array<{ decision: string; rationale: string }>;
  tokenCount: number;
}): Promise<string> {
  const agentId = params.agentId === "system" ? SYSTEM_AGENT_ID : params.agentId;
  const taskId = deterministicUUID(`${params.pipelineRunId}:working:${params.subtaskType}`);

  return createSession({
    agentId,
    taskId,
    pipelineRunId: params.pipelineRunId,
    sessionData: {
      memoryTier: "working",
      stageContext: { subtaskType: params.subtaskType },
      findings: params.findings,
      decisions: params.decisions,
    },
    tokenCount: params.tokenCount,
  });
}

/**
 * Create a persistent memory session (carries forward to future runs).
 * Used for cross-pipeline learnings, skill improvements, codebase familiarity.
 */
export async function createPersistentMemory(params: {
  agentId: string;
  pipelineRunId: string;
  learnings: string[];
  decisions?: Array<{ decision: string; rationale: string }>;
  tokenCount: number;
}): Promise<string> {
  const agentId = params.agentId === "system" ? SYSTEM_AGENT_ID : params.agentId;
  // Use agent-scoped taskId so persistent memories chain across pipeline runs
  // (unlike working memory which is pipeline-scoped and auto-cleared).
  const taskId = deterministicUUID(`${agentId}:persistent`);

  return createSession({
    agentId,
    taskId,
    pipelineRunId: params.pipelineRunId,
    sessionData: {
      memoryTier: "persistent",
      findings: params.learnings,
      decisions: params.decisions,
    },
    tokenCount: params.tokenCount,
  });
}

/**
 * Clear all working memory for a pipeline run.
 * Called after a pipeline completes to free up session entries that are
 * no longer needed. Persistent memories are preserved.
 */
export async function clearWorkingMemory(pipelineRunId: string): Promise<number> {
  // Working memory sessions have memoryTier: "working" in their session_data.
  // We use a JSONB query to find and delete them.
  // Use COALESCE to match sessions without memoryTier (legacy) as well as explicit "working".
  // Matches the same logic as buildTieredSessionContext.
  const result = await db
    .delete(agentSessions)
    .where(
      and(
        eq(agentSessions.pipeline_run_id, pipelineRunId),
        sql`COALESCE(${agentSessions.session_data}->>'memoryTier', 'working') = 'working'`,
      ),
    )
    .returning({ id: agentSessions.id });

  return result.length;
}

/**
 * Build context from BOTH memory tiers for an agent.
 * Persistent memories come first (foundational knowledge), then working
 * memories (current task context). This gives the agent both institutional
 * knowledge and immediate task awareness.
 */
export async function buildTieredSessionContext(
  agentId: string,
  pipelineRunId: string,
): Promise<SessionContext> {
  // Get persistent memories (from any pipeline run)
  const persistentSessions = await db.query.agentSessions.findMany({
    where: and(
      eq(agentSessions.agent_id, agentId),
      sql`${agentSessions.session_data}->>'memoryTier' = 'persistent'`,
    ),
    orderBy: [desc(agentSessions.created_at)],
    limit: 5, // Keep persistent context manageable
  });

  // Get working memories (current pipeline run only)
  const workingSessions = await db.query.agentSessions.findMany({
    where: and(
      eq(agentSessions.agent_id, agentId),
      eq(agentSessions.pipeline_run_id, pipelineRunId),
      sql`COALESCE(${agentSessions.session_data}->>'memoryTier', 'working') = 'working'`,
    ),
    orderBy: [asc(agentSessions.created_at)],
  });

  const parts: string[] = [];
  let totalTokens = 0;

  // Persistent memories first
  if (persistentSessions.length > 0) {
    parts.push("=== Persistent Knowledge ===");
    for (const s of persistentSessions) {
      totalTokens += s.token_count;
      const data = s.session_data as SessionData | null;
      if (s.compacted && s.compaction_summary) {
        parts.push(s.compaction_summary);
      } else if (data?.findings?.length) {
        parts.push(data.findings.join("; "));
      }
    }
  }

  // Working memories second
  if (workingSessions.length > 0) {
    parts.push("=== Current Task Context ===");
    for (const s of workingSessions) {
      totalTokens += s.token_count;
      const data = s.session_data as SessionData | null;
      if (!data) continue;
      const sections: string[] = [];
      if (data.stageContext?.subtaskType) {
        sections.push(`[${data.stageContext.subtaskType}]`);
      }
      if (data.findings?.length) {
        sections.push(data.findings.join("; "));
      }
      if (data.decisions?.length) {
        sections.push(data.decisions.map((d) => `${d.decision}: ${d.rationale}`).join("; "));
      }
      if (sections.length > 0) parts.push(sections.join(" — "));
    }
  }

  const latestSession = workingSessions[workingSessions.length - 1]
    || persistentSessions[0];

  return {
    currentSessionId: latestSession?.id ?? null,
    contextSummary: parts.length > 0
      ? `--- Agent Tiered Memory ---\n${parts.join("\n")}\n--- End Memory ---`
      : "",
    totalTokens,
    chainLength: persistentSessions.length + workingSessions.length,
  };
}
