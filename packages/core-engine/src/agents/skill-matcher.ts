/**
 * Skill Matcher — scores and ranks agents for a given task.
 *
 * Scoring algorithm:
 *   - Skill keyword overlap: 40%
 *   - Tech stack match: 30%
 *   - Stage permissions: 20%
 *   - Availability (status=idle, within budget): 10%
 */

import type { AgentPersona, Skill, SkillMatchResult } from '@revamp/shared-types/agent';

export interface TaskRequirements {
  /** Keywords describing what the task involves */
  keywords: string[];
  /** Tech stack requirements (e.g., ['java', 'spring boot', 'postgresql']) */
  techStack: string[];
  /** Which pipeline stage this task belongs to */
  stageName: string;
  /** Minimum proficiency required */
  minProficiency?: 'intermediate' | 'advanced' | 'expert';
}

// ─── SCORING WEIGHTS ───────────────────────────────────────────

const WEIGHTS = {
  skillKeywordOverlap: 0.40,
  techStackMatch: 0.30,
  stagePermissions: 0.20,
  availability: 0.10,
} as const;

const PROFICIENCY_SCORES: Record<string, number> = {
  expert: 1.0,
  advanced: 0.7,
  intermediate: 0.4,
};

const MIN_PROFICIENCY_SCORES: Record<string, number> = {
  expert: 0.9,
  advanced: 0.6,
  intermediate: 0.3,
};

// ─── SCORING FUNCTIONS ─────────────────────────────────────────

function scoreSkillKeywords(agentSkills: Skill[], taskKeywords: string[]): { score: number; matches: string[] } {
  if (taskKeywords.length === 0) return { score: 0, matches: [] };

  const lowerKeywords = taskKeywords.map((k) => k.toLowerCase());
  const matches: string[] = [];
  let totalWeight = 0;
  let matchedWeight = 0;

  for (const skill of agentSkills) {
    const profMult = PROFICIENCY_SCORES[skill.proficiency] ?? 0.4;
    const skillWeight = skill.weight * profMult;
    totalWeight += skillWeight;

    const matched = skill.keywords.some((kw) =>
      lowerKeywords.some((q) => kw.includes(q) || q.includes(kw))
    );

    if (matched) {
      matchedWeight += skillWeight;
      matches.push(skill.name);
    }
  }

  if (totalWeight === 0) return { score: 0, matches };
  return { score: Math.min(matchedWeight / totalWeight, 1), matches };
}

function scoreTechStack(
  agentTechStack: string[],
  taskTechStack: string[],
  agentLegacyExpertise?: string[],
): { score: number; matches: string[] } {
  if (taskTechStack.length === 0) return { score: 0.5, matches: [] }; // neutral if no requirement

  // Combine tech_stack and legacy_expertise — legacy languages like COBOL
  // live in legacy_expertise, not tech_stack, but they're equally relevant
  // when matching an agent to a task that involves those languages.
  const combinedAgent = [
    ...agentTechStack.map((t) => t.toLowerCase()),
    ...(agentLegacyExpertise || []).map((t) => t.toLowerCase()),
  ];
  const lowerTask = taskTechStack.map((t) => t.toLowerCase());
  const matches: string[] = [];

  for (const tech of lowerTask) {
    if (combinedAgent.some((a) => a.includes(tech) || tech.includes(a))) {
      matches.push(tech);
    }
  }

  return {
    score: matches.length / lowerTask.length,
    matches,
  };
}

function scoreStagePermission(agentStagePermissions: string[], stageName: string): number {
  if (!stageName) return 0.5; // neutral if no stage specified
  return agentStagePermissions.includes(stageName) ? 1.0 : 0.0;
}

function scoreAvailability(agent: AgentPersona): number {
  if (agent.status === 'disabled' || agent.status === 'paused') return 0.0;

  // "working" agents are allowed if they have concurrent task capacity.
  // activeTasks is set by the caller (matchAndAssignAgent) from live DB data;
  // if not set, fall back to a small penalty so idle agents are still preferred.
  if (agent.status === 'working') {
    const active = agent.activeTasks ?? 1;
    const max = agent.maxConcurrentTasks || 3;
    if (active >= max) return 0.0; // at capacity
    return 0.7; // has capacity — small preference for idle agents
  }

  // Budget check
  if (agent.hardStopEnabled && agent.monthlyBudgetCents > 0) {
    const spentRatio = agent.spentMonthlyCents / agent.monthlyBudgetCents;
    if (spentRatio >= 1.0) return 0.0;
    if (spentRatio >= agent.warningThreshold) return 0.5;
  }

  return 1.0; // idle + within budget
}

// ─── ROLE HIERARCHY ───────────────────────────────────────────
// Specialists do the work, leads supervise, directors manage the department.
// Only match specialists for direct execution; fall back to leads, then director.

const ROLE_EXECUTION_ORDER: AgentPersona['role'][] = ['specialist', 'lead', 'director'];

// ─── MAIN MATCHER ──────────────────────────────────────────────

/**
 * Score a single agent for a task. Returns null if agent should be skipped.
 */
function scoreAgentForTask(
  agent: AgentPersona,
  task: TaskRequirements,
): SkillMatchResult | null {
  if (agent.hiddenAt) return null;

  // Check minimum proficiency if required
  if (task.minProficiency) {
    const minScore = MIN_PROFICIENCY_SCORES[task.minProficiency] ?? 0;
    const bestProficiency = Math.max(
      ...agent.skills.map((s) => PROFICIENCY_SCORES[s.proficiency] ?? 0),
      0,
    );
    if (bestProficiency < minScore) return null;
  }

  const reasons: string[] = [];

  // Score each dimension
  const skillResult = scoreSkillKeywords(agent.skills, task.keywords);
  const techResult = scoreTechStack(agent.techStack, task.techStack, agent.legacyExpertise);
  const stageScore = scoreStagePermission(agent.stagePermissions, task.stageName);
  const availScore = scoreAvailability(agent);

  // Weighted total
  const score =
    skillResult.score * WEIGHTS.skillKeywordOverlap +
    techResult.score * WEIGHTS.techStackMatch +
    stageScore * WEIGHTS.stagePermissions +
    availScore * WEIGHTS.availability;

  // Build reasons
  if (skillResult.matches.length > 0) {
    reasons.push(`Skills: ${skillResult.matches.join(', ')}`);
  }
  if (techResult.matches.length > 0) {
    reasons.push(`Tech: ${techResult.matches.join(', ')}`);
  }
  if (stageScore === 1.0) {
    reasons.push(`Stage: ${task.stageName} permitted`);
  }
  if (availScore < 1.0) {
    if (availScore === 0) reasons.push('Unavailable (disabled/paused/over budget)');
    else if (agent.status === 'working') reasons.push('Currently working');
    else reasons.push('Near budget limit');
  }

  if (score <= 0) return null;

  return { agent, score: Math.round(score * 100) / 100, reasons };
}

/**
 * Match and rank agents for a given task.
 *
 * Respects role hierarchy: specialists first, then leads, then director.
 * Only escalates to a higher role if no suitable agent is found at the
 * current level (score >= 0.1).
 */
export function matchAgentToTask(
  task: TaskRequirements,
  agents: AgentPersona[],
): SkillMatchResult[] {
  // Group agents by role
  const byRole = new Map<string, AgentPersona[]>();
  for (const agent of agents) {
    const role = agent.role ?? 'specialist';
    const list = byRole.get(role) ?? [];
    list.push(agent);
    byRole.set(role, list);
  }

  // Try each role level in order: specialist → lead → director
  for (const role of ROLE_EXECUTION_ORDER) {
    const roleAgents = byRole.get(role);
    if (!roleAgents || roleAgents.length === 0) continue;

    const results: SkillMatchResult[] = [];
    for (const agent of roleAgents) {
      const result = scoreAgentForTask(agent, task);
      if (result) results.push(result);
    }

    results.sort((a, b) => b.score - a.score);

    // If any agent at this role level scores above threshold, use this level
    if (results.length > 0 && results[0].score >= 0.1) {
      // Add role context to reasons
      if (role !== 'specialist') {
        for (const r of results) {
          r.reasons.push(`Escalated: no specialist available`);
        }
      }
      return results;
    }
  }

  return [];
}
