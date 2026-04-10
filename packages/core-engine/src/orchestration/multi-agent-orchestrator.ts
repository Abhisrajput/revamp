/**
 * Generic Multi-Agent Stage Orchestrator
 *
 * Reusable framework for the Director → Specialists → Composition → Coverage pattern.
 * Used by DECODE, and available for any stage that needs multi-agent delegation.
 *
 * Flow:
 *   1. Director analyzes prior stage output, plans subtasks dynamically (4-10)
 *   2. Specialists execute subtasks in parallel with agent assignment
 *   3. Composer merges specialist outputs into a single document
 *   4. Coverage loop: measure → gap-fill → re-measure (up to N rounds)
 *   5. Contract validation + refinement
 *
 * Each stage provides its own:
 *   - Subtask catalog (types + templates)
 *   - Director prompt
 *   - Composition prompt
 *   - Coverage measurement function
 *   - Contract stage name
 */

import type { PipelineStageName } from '@revamp/shared-types/pipeline';

// ─── TYPES ──────────────────────────────────────────────────────

export interface SubtaskDefinition {
  type: string;
  title: string;
  description: string;
  priority: number;
  /** Whether this subtask is always included or conditionally added by Director */
  mandatory: boolean;
  /** Template prompt for this subtask type */
  template: string;
  /** Skills needed (for agent matching) */
  requiredSkills?: string[];
  requiredTechStack?: string[];
}

export interface SubtaskPlanItem {
  type: string;
  title: string;
  description: string;
  priority: number;
  assignToAgent?: string;
  requiredSkills: string[];
  requiredTechStack: string[];
}

export interface SubtaskResultItem {
  subtaskId: string;
  type: string;
  title: string;
  agentName: string;
  output: string;
  duration: number;
  status: 'completed' | 'failed';
  error?: string;
}

export interface CoverageResult {
  /** 0-1 coverage percentage */
  percentage: number;
  /** Number of items covered */
  covered: number;
  /** Total items to cover */
  total: number;
  /** List of uncovered item names/ids */
  uncovered: string[];
}

export type AgentLLMCallFn = (req: {
  systemPrompt: string;
  userPrompt: string;
  onDelta?: (text: string) => void;
}) => Promise<string>;

export type EmitFn = (phase: string, data?: Record<string, unknown>) => void;

// ─── STAGE ORCHESTRATION CONFIG ─────────────────────────────────

export interface StageOrchestrationConfig {
  /** Pipeline stage name (DECODE, BLUEPRINT, etc.) */
  stageName: PipelineStageName;
  stageIndex: number;

  /** Available subtask types for this stage */
  subtaskCatalog: SubtaskDefinition[];

  /** Director prompt template ({{priorOutput}} and {{subtaskCatalog}} will be interpolated) */
  directorPrompt: string;

  /** Composition prompt template ({{subtaskResults}} will be interpolated) */
  compositionPrompt: string;

  /** Coverage target (0-1). Default: 0.90 */
  coverageTarget?: number;

  /** Max gap-fill rounds. Default: 3 */
  maxGapFillRounds?: number;

  /** Function to measure coverage of the composed output against prior stage data */
  measureCoverage: (output: string, priorContext: string) => CoverageResult;

  /** Build the gap-fill prompt given uncovered items */
  buildGapFillPrompt: (uncovered: string[], existingOutput: string) => string;

  /** Max subtask types the Director can select. Default: 10 */
  maxSubtasks?: number;

  /** Minimum subtask types (mandatory ones). Default: 3 */
  minSubtasks?: number;
}

// ─── ORCHESTRATION RESULT ───────────────────────────────────────

export interface OrchestrationResult {
  output: string;
  subtaskResults: SubtaskResultItem[];
  coveragePercentage: number;
  gapFillRounds: number;
  refinementCount: number;
  duration: number;
  subtaskCount: number;
}

// ─── DIRECTOR PLANNING ──────────────────────────────────────────

/**
 * Build the subtask catalog text for the Director prompt.
 */
export function buildSubtaskCatalogText(catalog: SubtaskDefinition[]): string {
  const mandatory = catalog.filter(s => s.mandatory);
  const conditional = catalog.filter(s => !s.mandatory);

  let text = '### MANDATORY (always include):\n';
  mandatory.forEach((s, i) => {
    text += `${i + 1}. **${s.type}** — ${s.description}\n`;
  });

  if (conditional.length > 0) {
    text += '\n### CONDITIONAL (include when relevant):\n';
    conditional.forEach((s, i) => {
      text += `${mandatory.length + i + 1}. **${s.type}** — ${s.description}\n`;
    });
  }

  return text;
}

/**
 * Parse Director's JSON plan into validated subtask items.
 */
export function parseDirectorPlan(
  raw: string,
  validTypes: Set<string>,
): SubtaskPlanItem[] {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Director plan did not produce valid JSON');

  const jsonStr = jsonMatch[1] !== undefined ? jsonMatch[1] : jsonMatch[0];
  const parsed = JSON.parse(jsonStr);
  const plan = parsed.plan || parsed;

  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error('Director plan is empty or not an array');
  }

  return plan
    .filter((s: any) => validTypes.has(s.type))
    .sort((a: any, b: any) => (a.priority || 5) - (b.priority || 5))
    .map((s: any) => ({
      type: s.type,
      title: s.title || s.type,
      description: s.description || '',
      priority: s.priority || 5,
      assignToAgent: s.assignToAgent,
      requiredSkills: s.requiredSkills || [],
      requiredTechStack: s.requiredTechStack || [],
    }));
}

/**
 * Build default plan from mandatory subtasks (fallback when Director fails).
 */
export function buildDefaultPlan(catalog: SubtaskDefinition[]): SubtaskPlanItem[] {
  return catalog
    .filter(s => s.mandatory)
    .map(s => ({
      type: s.type,
      title: s.title,
      description: s.description,
      priority: s.priority,
      requiredSkills: s.requiredSkills || [],
      requiredTechStack: s.requiredTechStack || [],
    }));
}

// ─── COVERAGE HELPERS ───────────────────────────────────────────

/**
 * Generic string-matching coverage measurement.
 * Checks how many items from a reference list appear in the output text.
 */
export function measureStringCoverage(
  output: string,
  referenceItems: string[],
): CoverageResult {
  if (referenceItems.length === 0) {
    return { percentage: 1, covered: 0, total: 0, uncovered: [] };
  }

  const outputLower = output.toLowerCase();
  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const item of referenceItems) {
    const lower = item.toLowerCase();
    // Split on uppercase BEFORE lowercasing — otherwise .toLowerCase() removes all uppercase
    const camelWords = item.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    const snakeWords = lower.replace(/_/g, ' ');

    if (outputLower.includes(lower) || outputLower.includes(camelWords) || outputLower.includes(snakeWords)) {
      covered.push(item);
    } else {
      uncovered.push(item);
    }
  }

  return {
    percentage: covered.length / referenceItems.length,
    covered: covered.length,
    total: referenceItems.length,
    uncovered,
  };
}

/**
 * Extract component names from SCAN output for coverage measurement.
 */
export function extractComponentsFromScan(scanOutput: string): string[] {
  const components = new Set<string>();

  // Table rows
  const tableRows = scanOutput.match(/^\|[^|]+\|[^|]+\|/gm) || [];
  for (const row of tableRows) {
    const cells = row.split('|').filter(Boolean).map(c => c.trim());
    if (cells.length >= 2 && !cells[0].includes('---') && !/^(name|component|id|#)$/i.test(cells[0])) {
      components.add(cells[0]);
    }
  }

  // File references
  const fileRefs = scanOutput.match(/`([a-zA-Z0-9_/\\.-]+\.[a-zA-Z]+)`/g) || [];
  for (const ref of fileRefs) {
    const name = ref.replace(/`/g, '').split('/').pop()?.replace(/\.\w+$/, '') || '';
    if (name.length > 2) components.add(name);
  }

  const noise = new Set(['id', 'name', 'type', 'path', 'status', 'description', 'version', 'table', 'index', 'key']);
  return Array.from(components).filter(c => !noise.has(c.toLowerCase()) && c.length > 2);
}

/**
 * Extract BR-{ids} from text.
 */
export function extractBRIds(text: string): string[] {
  return [...new Set((text.match(/BR-\d+/g) || []).map(m => m.toUpperCase()))];
}

/**
 * Extract CAP-{ids} from text.
 */
export function extractCAPIds(text: string): string[] {
  return [...new Set((text.match(/CAP-\d+/g) || []).map(m => m.toUpperCase()))];
}

// ─── GENERIC MULTI-AGENT RUNNER ────────────────────────────────

/**
 * Runtime hooks that the calling service provides.
 * These bridge the generic framework to stage-specific infrastructure
 * (DB, agents, LLM proxy, etc.) that lives in the API layer.
 */
export interface StageRuntimeHooks {
  /** Create an LLM call function with given config */
  createLlmFn: (opts: { maxTokens: number; model?: string }) => AgentLLMCallFn;

  /** Emit a stage phase event to SSE */
  emit: EmitFn;

  /** Check if execution was aborted */
  isAborted: () => boolean;

  /** Check pipeline budget (throws if exceeded) */
  checkBudget?: () => Promise<void>;

  /** Match and assign an agent for a subtask (returns agent name or null) */
  matchAgent?: (skills: string[], techStack: string[]) => Promise<{ agentId: string; agentName: string } | null>;

  /** Create a subtask record in the DB */
  createSubtask?: (plan: SubtaskPlanItem) => Promise<string>;

  /** Mark a subtask as completed */
  completeSubtask?: (subtaskId: string, output: string) => Promise<void>;

  /** Mark a subtask as failed */
  failSubtask?: (subtaskId: string, error: string) => Promise<void>;
}

/**
 * Run a complete multi-agent stage with the generic pattern:
 *   Director → Specialists → Composition → Coverage → Validation
 *
 * @param config - Stage-specific configuration (subtask catalog, prompts, coverage)
 * @param hooks - Runtime hooks (LLM, agents, DB, events)
 * @param priorContext - Output from prior stages (SCAN output, etc.)
 * @returns Orchestration result with output, coverage, and subtask details
 */
export async function runMultiAgentStage(
  config: StageOrchestrationConfig,
  hooks: StageRuntimeHooks,
  priorContext: string,
): Promise<OrchestrationResult> {
  const startTime = Date.now();
  const {
    coverageTarget = 0.90,
    maxGapFillRounds = 3,
  } = config;

  // ── STEP 1: DIRECTOR PLANNING ──────────────────────────────
  hooks.emit('director_planning', { message: `Director planning ${config.stageName} subtasks...` });

  let plan: SubtaskPlanItem[];
  const validTypes = new Set(config.subtaskCatalog.map(s => s.type));
  const directorFn = hooks.createLlmFn({ maxTokens: 4096 });

  try {
    if (hooks.isAborted()) throw new Error('Aborted');

    const catalogText = buildSubtaskCatalogText(config.subtaskCatalog);
    const directorPrompt = config.directorPrompt
      .replace('{{priorOutput}}', priorContext.length > 16000 ? priorContext.slice(0, 16000) + '\n\n[... truncated ...]' : priorContext)
      .replace('{{subtaskCatalog}}', catalogText);

    const raw = await directorFn({
      systemPrompt: 'You are the Department Director. Output ONLY valid JSON.',
      userPrompt: directorPrompt,
    });

    plan = parseDirectorPlan(raw, validTypes);
    hooks.emit('director_planning', {
      message: `Director planned ${plan.length} subtasks`,
      subtaskCount: plan.length,
      subtasks: plan.map(s => ({ type: s.type, title: s.title, priority: s.priority })),
    });
  } catch (err) {
    // Graceful degradation — use mandatory subtasks
    hooks.emit('director_planning', {
      message: 'Director plan failed, using default subtasks',
      error: err instanceof Error ? err.message : String(err),
    });
    plan = buildDefaultPlan(config.subtaskCatalog);
  }

  // ── STEP 2: SUBTASK EXECUTION ──────────────────────────────
  const subtaskResults: SubtaskResultItem[] = [];
  const executionFn = hooks.createLlmFn({ maxTokens: 32768 });

  for (const item of plan) {
    if (hooks.isAborted()) break;

    // Budget check
    if (hooks.checkBudget) {
      try { await hooks.checkBudget(); } catch { break; }
    }

    const subtaskStart = Date.now();
    hooks.emit('subtask_executing', {
      message: `Executing: ${item.title}`,
      type: item.type,
    });

    // Create DB record
    let subtaskId = `${item.type}-${Date.now()}`;
    if (hooks.createSubtask) {
      try { subtaskId = await hooks.createSubtask(item); } catch { /* non-fatal */ }
    }

    // Match agent
    let agentName = 'system';
    if (hooks.matchAgent) {
      try {
        const agent = await hooks.matchAgent(item.requiredSkills, item.requiredTechStack);
        if (agent) agentName = agent.agentName;
      } catch { /* non-fatal */ }
    }

    // Find template
    const templateDef = config.subtaskCatalog.find(s => s.type === item.type);
    const template = templateDef?.template || `Execute subtask: ${item.title}\n\nContext:\n{{priorOutput}}`;
    const prompt = template
      .replace(/\{\{codebaseContext\}\}/g, priorContext.slice(0, 8000))
      .replace(/\{\{scanOutput\}\}/g, priorContext.length > 20000 ? priorContext.slice(0, 20000) + '\n[... truncated ...]' : priorContext)
      .replace(/\{\{priorOutput\}\}/g, priorContext.slice(0, 12000))
      .replace(/\{\{priorFindings\}\}/g, subtaskResults.filter(r => r.status === 'completed').map(r => `### ${r.title}\n${r.output.slice(0, 3000)}`).join('\n\n'));

    // Execute
    try {
      const output = await executionFn({
        systemPrompt: `You are a specialist executing: ${item.title}. Be thorough and cite sources.`,
        userPrompt: prompt,
      });

      subtaskResults.push({
        subtaskId,
        type: item.type,
        title: item.title,
        agentName,
        output,
        duration: Date.now() - subtaskStart,
        status: 'completed',
      });

      if (hooks.completeSubtask) {
        try { await hooks.completeSubtask(subtaskId, output); } catch { /* non-fatal */ }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      subtaskResults.push({
        subtaskId,
        type: item.type,
        title: item.title,
        agentName,
        output: '',
        duration: Date.now() - subtaskStart,
        status: 'failed',
        error,
      });

      if (hooks.failSubtask) {
        try { await hooks.failSubtask(subtaskId, error); } catch { /* non-fatal */ }
      }
    }
  }

  const successfulResults = subtaskResults.filter(r => r.status === 'completed');
  if (successfulResults.length === 0) {
    return {
      output: '',
      subtaskResults,
      coveragePercentage: 0,
      gapFillRounds: 0,
      refinementCount: 0,
      duration: Date.now() - startTime,
      subtaskCount: plan.length,
    };
  }

  // ── STEP 3: COMPOSITION ────────────────────────────────────
  hooks.emit('composing', { message: 'Composing subtask results into final document...' });

  const composerFn = hooks.createLlmFn({ maxTokens: 32768 });
  const subtaskOutputsText = successfulResults
    .map(r => `## ${r.title} (${r.type})\n\n${r.output}`)
    .join('\n\n---\n\n');

  const compositionPrompt = config.compositionPrompt
    .replace('{{subtaskResults}}', subtaskOutputsText)
    .replace('{{subtaskCount}}', String(successfulResults.length));

  let composedOutput: string;
  try {
    composedOutput = await composerFn({
      systemPrompt: 'You are the lead architect composing a comprehensive analysis document. Preserve ALL detail from specialist reports. Do NOT summarize or truncate.',
      userPrompt: compositionPrompt,
    });
  } catch {
    // Fallback: concatenate subtask outputs
    composedOutput = subtaskOutputsText;
  }

  // ── STEP 4: COVERAGE GAP-FILL LOOP ────────────────────────
  let gapFillRounds = 0;
  let coveragePercentage = 0;

  for (let round = 0; round < maxGapFillRounds; round++) {
    if (hooks.isAborted()) break;

    const coverage = config.measureCoverage(composedOutput, priorContext);
    coveragePercentage = coverage.percentage;

    hooks.emit('coverage_check', {
      message: `Coverage: ${Math.round(coverage.percentage * 100)}% (${coverage.covered}/${coverage.total})`,
      coverage: Math.round(coverage.percentage * 100),
      covered: coverage.covered,
      total: coverage.total,
      uncovered: coverage.uncovered.slice(0, 10),
      round: round + 1,
    });

    if (coverage.percentage >= coverageTarget || coverage.uncovered.length === 0) {
      hooks.emit('coverage_check', {
        message: `Coverage target met: ${Math.round(coverage.percentage * 100)}% >= ${Math.round(coverageTarget * 100)}%`,
      });
      break;
    }

    // Gap-fill
    hooks.emit('gap_fill', {
      message: `Gap-fill round ${round + 1}: addressing ${coverage.uncovered.length} uncovered items...`,
      uncoveredCount: coverage.uncovered.length,
    });

    try {
      const gapPrompt = config.buildGapFillPrompt(coverage.uncovered, composedOutput);
      const gapFn = hooks.createLlmFn({ maxTokens: 16384 });
      const gapOutput = await gapFn({
        systemPrompt: 'You are filling gaps in an analysis document. Output ONLY the new sections to append.',
        userPrompt: gapPrompt,
      });

      if (gapOutput && gapOutput.trim().length > 100) {
        composedOutput = composedOutput + '\n\n' + gapOutput;
        gapFillRounds++;
      }
    } catch {
      break; // Gap-fill failed — continue with current output
    }
  }

  // Final coverage measurement
  const finalCoverage = config.measureCoverage(composedOutput, priorContext);
  coveragePercentage = finalCoverage.percentage;

  return {
    output: composedOutput,
    subtaskResults,
    coveragePercentage,
    gapFillRounds,
    refinementCount: 0, // Caller handles contract validation + refinement
    duration: Date.now() - startTime,
    subtaskCount: plan.length,
  };
}
