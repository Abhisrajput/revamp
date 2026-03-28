/**
 * Memory Hotness Scoring — ranks artifacts by access frequency × recency.
 *
 * Ported from OpenViking's memory_lifecycle.py hotness_score() function.
 * Formula: score = sigmoid(log1p(active_count)) × time_decay(last_accessed_at)
 *
 * Used when selecting prior stage outputs as context for current stages:
 * - Recently accessed artifacts are boosted (likely relevant to current work)
 * - Frequently referenced artifacts are boosted (probably important)
 * - Old, rarely-accessed artifacts naturally decay
 */

import { db } from "@/db/index.js";
import { stageArtifacts } from "@/db/schema.js";
import { eq, sql } from "drizzle-orm";

/** Default half-life in days for the exponential time-decay component. */
const DEFAULT_HALF_LIFE_DAYS = 7.0;

/**
 * Compute a 0.0–1.0 hotness score for an artifact.
 *
 * @param activeCount - Number of times this artifact was retrieved/accessed
 * @param lastAccessedAt - Last access timestamp (null = cold, returns 0)
 * @param now - Current time (for testability)
 * @param halfLifeDays - Half-life for recency decay (default 7 days)
 */
export function hotnessScore(
  activeCount: number,
  lastAccessedAt: Date | null,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  // Frequency component: sigmoid of log of access count
  const freq = 1.0 / (1.0 + Math.exp(-Math.log1p(activeCount)));

  // Recency component: exponential decay
  if (!lastAccessedAt) return 0.0;

  const ageDays = Math.max(
    (now.getTime() - lastAccessedAt.getTime()) / (86400 * 1000),
    0.0,
  );
  const decay = Math.pow(2, -ageDays / halfLifeDays);

  return freq * decay;
}

/**
 * Record an access to an artifact — increments active_count and updates last_accessed_at.
 * Call this whenever an artifact is read as context for a stage execution.
 */
export async function recordArtifactAccess(artifactId: string): Promise<void> {
  await db
    .update(stageArtifacts)
    .set({
      active_count: sql`${stageArtifacts.active_count} + 1`,
      last_accessed_at: new Date(),
    })
    .where(eq(stageArtifacts.id, artifactId));
}

/**
 * Rank artifacts by blended score: semantic relevance × hotness.
 *
 * @param artifacts - Array of artifacts with scores
 * @param hotnessAlpha - Weight for hotness in final ranking (0.0 = disabled, 0.2 = OpenViking default)
 * @returns Sorted array with blended scores
 */
export function rankWithHotness<
  T extends {
    id: string;
    relevanceScore: number;
    activeCount: number;
    lastAccessedAt: Date | null;
  },
>(artifacts: T[], hotnessAlpha: number = 0.2): (T & { blendedScore: number })[] {
  const now = new Date();

  return artifacts
    .map((a) => {
      const hot = hotnessScore(a.activeCount, a.lastAccessedAt, now);
      const blendedScore = (1 - hotnessAlpha) * a.relevanceScore + hotnessAlpha * hot;
      return { ...a, blendedScore };
    })
    .sort((a, b) => b.blendedScore - a.blendedScore);
}
