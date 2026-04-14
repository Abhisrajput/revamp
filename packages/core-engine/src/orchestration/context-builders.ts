/**
 * Context Builders — assemble prompts for each pipeline stage.
 *
 * Ported from legacy-bridge src/lib/stageAI.ts (buildProjectContext,
 * buildPriorStageContext, buildUserFeedback) with improvements:
 *   - Typed context interfaces instead of raw strings
 *   - Configurable per-stage char budgets
 *   - Structured metadata injection for prompt caching (Anthropic cache_control)
 *   - Cross-stage keyword extraction for traceability checks
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';

// ─── TYPES ──────────────────────────────────────────────────────

export interface FileAnalysis {
  totalFiles: number;
  totalLines: number;
  filesByExtension: Record<string, number>;
  linesByExtension: Record<string, number>;
  largestFiles: Array<{ path: string; lines: number; extension: string }>;
  directoryTree: string;
  keyFiles: string[];
  codeSnippets: Array<{ path: string; language: string; content: string }>;
  detectedLanguages: string[];
  /** Framework/runtime versions extracted from config files */
  frameworkVersions?: Array<{ name: string; version: string; source: string }>;
  /** Migration/schema file stats */
  migrationStats?: { count: number; earliest: string; latest: string; directory: string };
  /** Component counts by directory */
  componentCounts?: Array<{ name: string; directory: string; count: number }>;
}

export interface ProjectContext {
  projectId: string;
  projectName: string;
  description: string;
  codebaseSource: string; // repo URL or upload path
  sourceLanguages: string[]; // e.g., ['COBOL', 'JCL', 'DB2']
  targetStack: string; // e.g., 'Java/Spring Boot'
  targetCloud?: string; // e.g., 'AWS'
  teamSize?: number;
  supportingDocs?: Array<{ name: string; content: string }>;
  /** Real file analysis from scanning the codebase */
  fileAnalysis?: FileAnalysis;
  /** Path to the cloned/analyzed codebase on disk */
  codebasePath?: string;
}

export interface StageOutput {
  stageName: PipelineStageName;
  stageIndex: number;
  output: string;
  completedAt: string;
  artifacts?: Array<{ name: string; type: string }>;
}

export interface StageGoal {
  objective: string;
  deliverables: string[];
  keyQuestions: string[];
}

export interface UserFeedback {
  stageIndex: number;
  feedback: string;
  source: 'user_input' | 'approval_rejection';
  timestamp: string;
}

export interface ValidationFinding {
  type: string;
  severity: 'critical' | 'major' | 'minor';
  description: string;
  suggestion?: string;
}

export interface AssembledPrompt {
  systemPrompt: string;
  userPrompt: string;
  priorStageKeywords: string[]; // for cross-stage reference checks
  cacheablePrefix: string; // portion safe to cache (project + prior context)
}

// ─── STAGE GOALS ────────────────────────────────────────────────

const STAGE_GOALS: Record<PipelineStageName, StageGoal> = {
  [PipelineStageName.SCAN]: {
    objective: 'Analyze and scope the legacy codebase — define migration baseline, risks, and stage gates',
    deliverables: [
      'Architecture overview with component diagram (Mermaid)',
      'Technology stack inventory',
      'Technical debt assessment with risk/impact ratings',
      'Dependency map (internal + external)',
      'Initial recommendations ranked by ROI',
    ],
    keyQuestions: [
      'What are the core business-critical paths?',
      'Which components have the highest coupling?',
      'What are the biggest risks if we migrate vs. don\'t?',
    ],
  },
  [PipelineStageName.DECODE]: {
    objective: 'Extract business intent, rules, and workflows from legacy code',
    deliverables: [
      'Business rules catalog with source-file traceability',
      'Workflow/process diagrams',
      'Data entity model',
      'Integration points inventory',
      'Business logic map (rule → code location → data touched)',
    ],
    keyQuestions: [
      'What business rules are encoded implicitly vs. explicitly?',
      'Which workflows span multiple modules/files?',
      'What data transformations happen and where?',
    ],
  },
  [PipelineStageName.BLUEPRINT]: {
    objective: 'Map business capabilities to system components and define service boundaries',
    deliverables: [
      'Capability map (Mermaid)',
      'Service boundary definitions with data ownership',
      'Dependency graph between proposed services',
      'Migration wave plan (which services first)',
    ],
    keyQuestions: [
      'What are the right service boundaries given data affinity?',
      'Which capabilities should be extracted first based on risk/value?',
      'How do we handle shared data during migration?',
    ],
  },
  [PipelineStageName.SPEC_LOCK]: {
    objective: 'Lock behavioral specs as BDD/Gherkin scenarios and acceptance criteria',
    deliverables: [
      'Gherkin feature files with 5+ scenarios per business capability',
      'API contracts (OpenAPI or interface definitions)',
      'Acceptance criteria per service',
      'Edge cases and error scenarios',
    ],
    keyQuestions: [
      'Have we captured all critical business paths as scenarios?',
      'Are the acceptance criteria testable and unambiguous?',
      'What edge cases could cause behavioral divergence?',
    ],
  },
  [PipelineStageName.ARCHITECT]: {
    objective: 'Design modernization strategy, target architecture, and migration roadmap',
    deliverables: [
      'Target architecture diagram (Mermaid)',
      'Technology selection with alternatives compared',
      'Migration strategy with phases and milestones',
      'Risk assessment with mitigation plans',
      'Cost estimate (compute, licensing, team)',
    ],
    keyQuestions: [
      'Is the target architecture aligned with team capabilities?',
      'What is the minimum viable migration scope?',
      'How do we maintain feature parity during transition?',
    ],
  },
  [PipelineStageName.FORGE]: {
    objective: 'Generate production-ready code aligned to target architecture',
    deliverables: [
      'Source code files with file path labels',
      'Unit and integration tests',
      'Configuration files (Dockerfile, env, CI)',
      'Database migration scripts',
      'API endpoint implementations',
    ],
    keyQuestions: [
      'Does the generated code implement all locked BDD scenarios?',
      'Are error handling and logging production-grade?',
      'Is the code idiomatic for the target language/framework?',
    ],
  },
  [PipelineStageName.SHADOW_RUN]: {
    objective: 'Run legacy and modern systems in parallel — validate behavioral equivalence',
    deliverables: [
      'Test matrix with PASS/FAIL per BDD scenario',
      'Behavioral comparison (legacy vs. modern)',
      'Performance comparison (latency, throughput)',
      'GO/NO-GO cutover verdict with justification',
    ],
    keyQuestions: [
      'Are there any behavioral deviations between old and new?',
      'Does the new system meet performance SLAs?',
      'What rollback plan exists if cutover fails?',
    ],
  },
  [PipelineStageName.EVOLVE]: {
    objective: 'Continuous modernization — KPI roadmap, operational plan, and ongoing evolution',
    deliverables: [
      'KPI dashboard targets (latency, uptime, cost)',
      'Operational runbooks',
      'Modernization backlog for remaining legacy',
      'Legacy decommission plan with timeline',
    ],
    keyQuestions: [
      'What KPIs prove the modernization succeeded?',
      'How do we prevent regression?',
      'What legacy components remain and when do they retire?',
    ],
  },
};

// Per-stage char budgets for prior context inclusion.
// Later stages need MORE prior context — they synthesize outputs from all earlier stages.
// Capped at 12K to avoid diluting the model's generative output with too much recap.
// The weight formula (below) gives stages closest to the current one the largest share.
const PRIOR_CONTEXT_BUDGETS: Record<PipelineStageName, number> = {
  [PipelineStageName.SCAN]: 0,
  [PipelineStageName.DECODE]: 4000,
  [PipelineStageName.BLUEPRINT]: 6000,
  [PipelineStageName.SPEC_LOCK]: 8000,
  [PipelineStageName.ARCHITECT]: 10000,
  [PipelineStageName.FORGE]: 12000,
  [PipelineStageName.SHADOW_RUN]: 12000,
  [PipelineStageName.EVOLVE]: 10000,
};

// ─── BUILDERS ───────────────────────────────────────────────────

/**
 * Build static project context block (cacheable — doesn't change per stage).
 */
export function buildProjectContext(project: ProjectContext): string {
  const parts: string[] = [
    `# Project: ${project.projectName}`,
    '',
    `**Description:** ${truncate(project.description, 300)}`,
    `**Source Languages:** ${project.sourceLanguages.join(', ')}`,
    `**Target Stack:** ${project.targetStack}`,
    project.targetCloud ? `**Target Cloud:** ${project.targetCloud}` : '',
    project.teamSize ? `**Team Size:** ${project.teamSize}` : '',
    `**Codebase Source:** ${project.codebaseSource}`,
  ].filter(Boolean);

  // ─── File analysis from real codebase scan ──────────────────
  if (project.fileAnalysis) {
    const fa = project.fileAnalysis;

    // Inject codebase strategy adaptation
    const adaptation = determineCodebaseStrategy(fa);
    parts.push('', `## Codebase Strategy: ${adaptation.strategy === 'full_read' ? 'Full Read (Small Codebase)' : 'Targeted Search (Large Codebase)'}`);
    parts.push(adaptation.strategyDescription);

    parts.push('', '## Codebase Analysis (auto-scanned)');
    parts.push(`- **Total Files:** ${fa.totalFiles.toLocaleString()}`);
    parts.push(`- **Total Lines of Code:** ${fa.totalLines.toLocaleString()}`);

    if (fa.detectedLanguages.length > 0) {
      parts.push(`- **Detected Languages:** ${fa.detectedLanguages.join(', ')}`);
    }

    // Language distribution
    const topLangs = Object.entries(fa.linesByExtension)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (topLangs.length > 0) {
      parts.push('', '### Language Distribution (by lines)');
      for (const [ext, lines] of topLangs) {
        const fileCount = fa.filesByExtension[ext] || 0;
        parts.push(`- **${ext}**: ${lines.toLocaleString()} lines across ${fileCount} files`);
      }
    }

    // Key files
    if (fa.keyFiles.length > 0) {
      parts.push('', '### Key Files');
      for (const f of fa.keyFiles.slice(0, 15)) {
        parts.push(`- \`${f}\``);
      }
    }

    // Largest files
    if (fa.largestFiles.length > 0) {
      parts.push('', '### Largest Source Files');
      for (const f of fa.largestFiles.slice(0, 8)) {
        parts.push(`- \`${f.path}\` — ${f.lines.toLocaleString()} lines (${f.extension})`);
      }
    }

    // Directory tree
    if (fa.directoryTree) {
      parts.push('', '### Directory Structure');
      parts.push('```');
      parts.push(truncate(fa.directoryTree, 2000));
      parts.push('```');
    }

    // Code snippets
    if (fa.codeSnippets.length > 0) {
      parts.push('', '### Representative Code Samples');
      for (const snippet of fa.codeSnippets) {
        parts.push(``, `**File: \`${snippet.path}\`** (${snippet.language})`);
        parts.push(`\`\`\`${snippet.language.toLowerCase()}`);
        parts.push(truncate(snippet.content, 1500));
        parts.push('```');
      }
    }

    // ─── GROUND TRUTH: verified data from config files ──────────
    // This block provides exact versions, counts, and stats that
    // downstream stages MUST reference instead of guessing.
    const hasGroundTruth = fa.frameworkVersions?.length || fa.componentCounts?.length || fa.migrationStats;
    if (hasGroundTruth) {
      parts.push('', '## Verified Ground Truth (from config files — DO NOT override)');
      parts.push('The following data is extracted directly from the codebase config files. Use these EXACT values when referencing versions, component counts, or migration data. Do NOT substitute estimates or training-data knowledge.');

      if (fa.frameworkVersions && fa.frameworkVersions.length > 0) {
        const runtimeDeps = fa.frameworkVersions.filter(fv => !fv.name.endsWith(' (dev)'));
        if (runtimeDeps.length > 0) {
          parts.push('', '### Technology Stack (verified)');
          parts.push('| Technology | Version | Source |');
          parts.push('|------------|---------|--------|');
          for (const fv of runtimeDeps.slice(0, 40)) {
            parts.push(`| ${fv.name} | ${fv.version} | ${fv.source} |`);
          }
        }
      }

      if (fa.componentCounts && fa.componentCounts.length > 0) {
        parts.push('', '### Component Counts (verified)');
        parts.push('| Component | Directory | Count |');
        parts.push('|-----------|-----------|-------|');
        for (const cc of fa.componentCounts) {
          parts.push(`| ${cc.name} | ${cc.directory} | ${cc.count} |`);
        }
      }

      if (fa.migrationStats) {
        parts.push('', '### Migration Stats (verified)');
        parts.push(`- **Count:** ${fa.migrationStats.count} files`);
        parts.push(`- **Earliest:** ${fa.migrationStats.earliest}`);
        parts.push(`- **Latest:** ${fa.migrationStats.latest}`);
        parts.push(`- **Directory:** ${fa.migrationStats.directory}`);
      }

      parts.push('', 'If a technology is NOT listed above, it does NOT exist in this codebase.');
    }
  }

  if (project.supportingDocs && project.supportingDocs.length > 0) {
    parts.push('', '## Supporting Documents');
    // Limit to last 2 docs, capped at 700 chars each
    const docs = project.supportingDocs.slice(-2);
    for (const doc of docs) {
      parts.push(`### ${truncate(doc.name, 100)}`);
      parts.push(truncate(doc.content, 700));
    }
  }

  return parts.join('\n');
}

/**
 * Build prior-stage context — compacted outputs from all prior stages.
 * Uses per-stage char budgets to control context size.
 *
 * Returns { context, keywords } where keywords are terms extracted
 * from prior stages for cross-stage reference validation.
 */
export function buildPriorStageContext(
  currentStage: PipelineStageName,
  priorOutputs: StageOutput[],
): { context: string; keywords: string[] } {
  const budget = PRIOR_CONTEXT_BUDGETS[currentStage];
  if (budget === 0 || priorOutputs.length === 0) {
    return { context: 'No prior stage outputs available.', keywords: [] };
  }

  // Sort by stage order
  const sorted = [...priorOutputs].sort((a, b) => a.stageIndex - b.stageIndex);

  // Allocate budget by stage importance — foundational stages (SCAN, DECODE)
  // get more context than later stages, because they contain the architecture
  // overview and business rules that all subsequent stages must respect.
  const IMPORTANCE_WEIGHTS: Record<string, number> = {
    SCAN: 0.25,        // Architecture overview — foundational
    DECODE: 0.22,      // Business rules — critical reference
    BLUEPRINT: 0.15,   // Capability map — structural guide
    SPEC_LOCK: 0.13,   // BDD specs — behavioral contract
    ARCHITECT: 0.10,   // Strategy decisions
    FORGE: 0.07,       // Implementation details
    SHADOW_RUN: 0.05,  // Validation results
    EVOLVE: 0.03,      // Operations plan
  };

  const allocated = sorted.map((stage) => {
    const weight = IMPORTANCE_WEIGHTS[stage.stageName] ?? (1 / sorted.length);
    return Math.floor(budget * weight);
  });

  const parts: string[] = ['# Prior Stage Outputs\n'];
  const keywords: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const stage = sorted[i];
    const charLimit = allocated[i];
    const compacted = compactOutput(stage.output, charLimit);

    parts.push(`## Stage ${stage.stageIndex + 1} — ${stage.stageName}`);
    parts.push(compacted);
    parts.push('');

    // Extract keywords for traceability
    keywords.push(...extractKeywords(stage.output));
  }

  return { context: parts.join('\n'), keywords: dedup(keywords).slice(0, 30) };
}

/**
 * Build user feedback block — highest priority override.
 *
 * Ported from legacy-bridge formatFeedbackBlock() in stageAI.ts.
 * This is the core mechanism that allows user rejection comments to override
 * ALL AI decisions — technology choices, architectural patterns, and recommendations.
 * The prompt language is intentionally strong to ensure the LLM treats user
 * feedback as an inviolable constraint.
 */
export function buildUserFeedback(feedback: UserFeedback[]): string | null {
  if (feedback.length === 0) return null;

  // Most recent feedback first
  const sorted = [...feedback].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const parts = [
    '# USER FEEDBACK — HIGHEST PRIORITY',
    '',
    'The user rejected the previous output and provided the following feedback.',
    'You MUST follow these instructions EXACTLY. They OVERRIDE any technology choices,',
    'architectural decisions, or recommendations from prior stages or your own analysis.',
    'If the user specifies a technology stack, language, or framework, USE THAT — do not',
    'substitute your own recommendation regardless of what the legacy codebase uses.',
    '',
  ];

  for (const fb of sorted.slice(0, 3)) {
    parts.push(`> ${fb.feedback}`);
    parts.push('');
  }

  parts.push('You MUST address ALL points above. Non-compliance will require re-generation.');

  return parts.join('\n');
}

/**
 * Build validation feedback block — formats previous run's validation findings
 * as explicit instructions for the next LLM call.
 *
 * Ported from legacy-bridge buildValidationFeedback() in stageAI.ts.
 * When a stage fails validation, the specific contract violations and
 * deterministic check failures are formatted as actionable instructions
 * so the LLM knows exactly what to fix on re-generation.
 */
export function buildValidationFeedback(
  validationFindings: ValidationFinding[],
): string | null {
  if (validationFindings.length === 0) return null;

  // Sort by severity: critical first, then major, then minor
  const severityOrder: Record<string, number> = { critical: 0, major: 1, minor: 2 };
  const sorted = [...validationFindings].sort(
    (a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2),
  );

  const critical = sorted.filter((f) => f.severity === 'critical');
  const major = sorted.filter((f) => f.severity === 'major');
  const minor = sorted.filter((f) => f.severity === 'minor');

  const parts: string[] = [
    '# VALIDATION FEEDBACK FROM PREVIOUS RUN',
    '',
    'The previous output FAILED validation. You MUST address ALL issues listed below.',
    'Pay special attention to CRITICAL issues — these are blocking and must be resolved.',
    '',
  ];

  if (critical.length > 0) {
    parts.push('## CRITICAL Issues (MUST fix)');
    for (const f of critical) {
      parts.push(`- **[${f.type}]** ${f.description}`);
      if (f.suggestion) parts.push(`  - Fix: ${f.suggestion}`);
    }
    parts.push('');
  }

  if (major.length > 0) {
    parts.push('## Major Issues (should fix)');
    for (const f of major) {
      parts.push(`- **[${f.type}]** ${f.description}`);
      if (f.suggestion) parts.push(`  - Fix: ${f.suggestion}`);
    }
    parts.push('');
  }

  if (minor.length > 0) {
    parts.push('## Minor Issues (fix if possible)');
    for (const f of minor.slice(0, 5)) { // Cap minor issues to avoid noise
      parts.push(`- **[${f.type}]** ${f.description}`);
      if (f.suggestion) parts.push(`  - Fix: ${f.suggestion}`);
    }
    if (minor.length > 5) {
      parts.push(`- ... and ${minor.length - 5} more minor issues`);
    }
    parts.push('');
  }

  parts.push('Ensure ALL deliverables are complete and substantive. No placeholders or TBDs.');

  return parts.join('\n');
}

/**
 * Format a single feedback string into the override block.
 * Useful when you have raw feedback text (e.g., from approval rejection comment)
 * rather than a structured UserFeedback array.
 */
export function formatFeedbackOverride(feedback: string): string {
  return [
    '## USER FEEDBACK — HIGHEST PRIORITY',
    'The user rejected the previous output and provided the following feedback.',
    'You MUST follow these instructions EXACTLY. They OVERRIDE any technology choices,',
    'architectural decisions, or recommendations from prior stages or your own analysis.',
    'If the user specifies a technology stack, language, or framework, USE THAT — do not',
    'substitute your own recommendation regardless of what the legacy codebase uses.',
    '',
    `> ${feedback}`,
    '',
  ].join('\n');
}

/**
 * Assemble full prompt for a pipeline stage.
 * Returns systemPrompt + userPrompt separated for provider compatibility.
 */
export function assembleStagePrompt(
  project: ProjectContext,
  currentStage: PipelineStageName,
  stageIndex: number,
  priorOutputs: StageOutput[],
  stageTemplate: string,
  templateVars: Record<string, string>,
  feedback: UserFeedback[],
  validationFindings?: ValidationFinding[],
): AssembledPrompt {
  const goal = STAGE_GOALS[currentStage];
  const projectCtx = buildProjectContext(project);
  const { context: priorCtx, keywords } = buildPriorStageContext(currentStage, priorOutputs);
  const feedbackBlock = buildUserFeedback(feedback);

  // System prompt — stable per stage, cacheable
  const systemPrompt = [
    'You are REVAMP, an AI-powered legacy application modernization engine.',
    `You are currently executing Stage ${stageIndex + 1} (${currentStage}) of the 8-stage modernization pipeline.`,
    '',
    `**Objective:** ${goal.objective}`,
    '',
    '**Required Deliverables:**',
    ...goal.deliverables.map((d) => `- ${d}`),
    '',
    '**Key Questions to Address:**',
    ...goal.keyQuestions.map((q) => `- ${q}`),
    '',
    '## Rules',
    '- Be thorough and specific. Reference concrete files, line numbers, and code snippets.',
    '- Use Mermaid diagrams for architectural/dependency visualizations (except in SCAN stage).',
    '- Label every code block with its file path: `// File: path/to/file.ext`',
    '- Include all required sections with substantive content (no placeholders, no TBDs).',
    '- Build explicitly on prior stage outputs — reference their findings by name.',
    stageIndex >= 5 ? '- You have write access. Generate production-ready, buildable code.' : '- You are in analysis mode. Do not generate implementation code yet.',
    '',
    '## Ground Truth (CRITICAL)',
    '- The project context contains a "Verified Ground Truth" section with exact versions, component counts, and migration stats extracted from config files.',
    '- When referencing technology versions, COPY the exact version string from the verified data (e.g. if verified data says ">=8.5", write ">=8.5" — NOT "8.4", "8.5", or "8.x").',
    '- When referencing component counts (controllers, models, etc.), use the EXACT verified number.',
    '- If a technology or dependency is NOT listed in the verified data, it does NOT exist in this codebase — do NOT invent it.',
    '- When citing file line counts (e.g. "god class with X lines"), use the verified largest-files data.',
    '- Do NOT round, paraphrase, or approximate verified values. Copy them verbatim.',
    '- If you reference a file path, that file MUST exist in the codebase. Do NOT fabricate file paths or method names.',
    '',
    '## Advisor',
    'You may have access to an `advisor` tool backed by a stronger model. If available, call it:',
    '- Before committing to architectural decisions or trade-offs',
    '- When merging conflicting information from multiple sources',
    '- When stuck or when your approach is not converging',
    'The advisor sees your full context. Give its guidance serious weight.',
  ].join('\n');

  // User prompt — includes variable content
  let interpolatedTemplate = stageTemplate;
  for (const [key, value] of Object.entries(templateVars)) {
    interpolatedTemplate = interpolatedTemplate.replace(
      new RegExp(`{{${key}}}`, 'g'),
      value,
    );
  }

  // User feedback goes BEFORE the stage template because it has highest priority.
  // The LLM sees it early in the context, which increases adherence.
  // This matches the legacy-bridge pattern where user rejection comments
  // override all AI decisions.
  const userParts = [
    projectCtx,
    '',
    priorCtx,
  ];

  if (feedbackBlock) {
    userParts.push('', '---', '', feedbackBlock);
  }

  // Inject validation feedback from previous failed run (if any).
  // This is placed after user feedback but before the stage template so the
  // LLM sees specific validation failures as constraints to address.
  const validationBlock = validationFindings
    ? buildValidationFeedback(validationFindings)
    : null;
  if (validationBlock) {
    userParts.push('', '---', '', validationBlock);
  }

  userParts.push(
    '',
    '---',
    '',
    `# Stage ${stageIndex + 1}: ${currentStage}`,
    '',
    interpolatedTemplate,
  );

  const userPrompt = userParts.join('\n');

  // Cacheable prefix = project context + prior stage context (stable between refinements)
  const cacheablePrefix = [projectCtx, '', priorCtx].join('\n');

  return {
    systemPrompt,
    userPrompt,
    priorStageKeywords: keywords,
    cacheablePrefix,
  };
}

/**
 * Get the stage goal for a given stage.
 */
export function getStageGoal(stage: PipelineStageName): StageGoal {
  return STAGE_GOALS[stage];
}

/**
 * Get the ordered list of all stages.
 */
export function getStageOrder(): PipelineStageName[] {
  return [
    PipelineStageName.SCAN,
    PipelineStageName.DECODE,
    PipelineStageName.BLUEPRINT,
    PipelineStageName.SPEC_LOCK,
    PipelineStageName.ARCHITECT,
    PipelineStageName.FORGE,
    PipelineStageName.SHADOW_RUN,
    PipelineStageName.EVOLVE,
  ];
}

// ─── CODEBASE SIZE ADAPTATION ───────────────────────────────────
//
// Ported from legacy-bridge src/lib/stageAI.ts runStageAgent().
// Different codebase sizes need fundamentally different exploration strategies.
// Small codebases can be read in full; large ones need targeted search.

/** Threshold between small and large codebase strategies */
const SMALL_CODEBASE_THRESHOLD = 30;

/**
 * Exploration strategy determined by codebase size.
 *
 * - **full_read**: Codebase is small enough (<30 files) to read every file.
 *   Agent should list_files then batch_read_files for all source files.
 *   Skip search_code unless looking for something specific.
 *
 * - **targeted_search**: Codebase is large (30+ files). Agent should use
 *   list_files for directory overview, search_code for key patterns, then
 *   read only the most relevant files. Use read_file_range for large files.
 *   Prefer lsp_document_symbols over reading entire files.
 */
type CodebaseStrategy = 'full_read' | 'targeted_search';

interface CodebaseAdaptation {
  strategy: CodebaseStrategy;
  totalFiles: number;
  /** Recommended max tool calls for this strategy */
  maxToolCalls: number;
  /** Human-readable strategy description for inclusion in prompts */
  strategyDescription: string;
}

/**
 * Determine the exploration strategy based on codebase size.
 * Returns strategy metadata that can be injected into agent system prompts.
 *
 * @param fileAnalysis - Real file analysis from codebase scan (if available)
 * @param fallbackFileCount - Estimated file count (used when no real scan available)
 */
function determineCodebaseStrategy(
  fileAnalysis?: FileAnalysis,
  fallbackFileCount?: number,
): CodebaseAdaptation {
  const totalFiles = fileAnalysis?.totalFiles ?? fallbackFileCount ?? 0;

  if (totalFiles > 0 && totalFiles < SMALL_CODEBASE_THRESHOLD) {
    return {
      strategy: 'full_read',
      totalFiles,
      maxToolCalls: 15,
      strategyDescription: [
        `This is a SMALL codebase (${totalFiles} files). Use the full-read strategy:`,
        '1. Use list_files to get the complete file list.',
        '2. Use batch_read_files to read ALL source files at once.',
        '3. Skip search_code unless you need to find a very specific pattern.',
        '4. You should have complete codebase knowledge after reading all files.',
        '5. Do NOT call file_stats or list_files more than once.',
      ].join('\n'),
    };
  }

  return {
    strategy: 'targeted_search',
    totalFiles,
    maxToolCalls: 25,
    strategyDescription: [
      `This is a LARGE codebase (${totalFiles || 'unknown number of'} files). Use the targeted-search strategy:`,
      '1. Start with file_stats to understand size and language distribution.',
      '2. Use list_files for a directory overview.',
      '3. Use search_code to find key patterns (entry points, main classes, config files).',
      '4. Read only the most relevant files (aim for 10-20 key files max).',
      '5. Use read_file_range for files >300 lines — read only the relevant sections.',
      '6. Prefer lsp_document_symbols over reading entire large files.',
      '7. Use lsp_references to trace dependencies instead of reading every file.',
    ].join('\n'),
  };
}

// ─── HELPERS ────────────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

/**
 * Compact a long output to fit within a char budget.
 * Preserves headings and first sentences of each section.
 */
function compactOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;

  const lines = output.split('\n');
  const result: string[] = [];
  let charCount = 0;

  for (const line of lines) {
    // Always include headings
    if (/^#{1,4}\s/.test(line)) {
      result.push(line);
      charCount += line.length + 1;
      continue;
    }

    // Include non-empty lines until budget
    if (line.trim() && charCount + line.length < maxChars) {
      result.push(line);
      charCount += line.length + 1;
    }

    if (charCount >= maxChars) {
      result.push('\n[... output truncated for context budget ...]');
      break;
    }
  }

  return result.join('\n');
}

/**
 * Extract salient keywords from stage output for cross-reference checking.
 * Focuses on capitalized terms, technical names, and quoted identifiers.
 */
function extractKeywords(output: string): string[] {
  const keywords: string[] = [];

  // Backtick-quoted identifiers (file names, function names)
  const backtickMatches = output.match(/`([^`]+)`/g);
  if (backtickMatches) {
    keywords.push(...backtickMatches.map((m) => m.replace(/`/g, '')).slice(0, 10));
  }

  // Headings
  const headingMatches = output.match(/^#{1,3}\s+(.+)$/gm);
  if (headingMatches) {
    keywords.push(...headingMatches.map((m) => m.replace(/^#+\s+/, '')).slice(0, 10));
  }

  // Capitalized multi-word terms (likely entity/service names)
  const capitalizedMatches = output.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\b/g);
  if (capitalizedMatches) {
    keywords.push(...capitalizedMatches.slice(0, 5));
  }

  return keywords;
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}
