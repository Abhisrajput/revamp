/**
 * Deterministic validation checks — fast, repeatable, zero LLM cost.
 *
 * Two categories:
 *   1. OUTPUT CHECKS — validate LLM stage output text for completeness
 *   2. CODE QUALITY CHECKS — validate generated code artifacts
 *
 * Each check returns a CheckResult with score 0-1, mapped to PASS/WARN/FAIL.
 * The pipeline orchestrator runs all registered checks per stage and
 * aggregates weighted scores into a confidence number.
 */

import { CheckResult, CheckType } from './types';
import { stripCodeFences, isFilePath, cleanPath, checkImportConsistency, extractCodeBlocks } from './utils';

// ═══════════════════════════════════════════════════════════════════
// 1. OUTPUT-LEVEL CHECKS — run against LLM stage output markdown
// ═══════════════════════════════════════════════════════════════════

/**
 * SECTION_COMPLETENESS — checks that all required H2/H3 headings exist
 * and each section meets a minimum word count.
 */
export function scoreSectionCompleteness(
  output: string,
  args: { requiredHeadings?: string[]; expectedSections?: string[]; minWordsPerSection?: number },
): CheckResult {
  // Accept both `requiredHeadings` (original) and `expectedSections` (rubric alias)
  const requiredHeadings = args?.requiredHeadings || args?.expectedSections || [];
  const { minWordsPerSection = 40 } = args || {};
  const found: string[] = [];
  const thin: string[] = [];
  const missing: string[] = [];

  for (const heading of requiredHeadings) {
    // Match heading lines (## Heading) AND bold lines (**Heading**)
    const headingPattern = new RegExp(`^#{1,3}\\s*(?:\\d+\\.?\\s*)?${escapeRegex(heading)}`, 'im');
    const boldPattern = new RegExp(`^\\*\\*${escapeRegex(heading)}\\*\\*`, 'im');
    const match = headingPattern.exec(output) || boldPattern.exec(output);
    if (!match) {
      missing.push(heading);
      continue;
    }
    // Extract section until next heading
    const start = match.index + match[0].length;
    const next = output.slice(start).search(/^#{1,3}\s/m);
    const body = next === -1 ? output.slice(start) : output.slice(start, start + next);
    const words = body.split(/\s+/).filter(Boolean).length;
    if (words < minWordsPerSection) {
      thin.push(`${heading} (${words}w < ${minWordsPerSection}w)`);
    } else {
      found.push(heading);
    }
  }

  const score = requiredHeadings.length > 0
    ? found.length / requiredHeadings.length
    : 1;

  return {
    name: 'Section Completeness',
    type: CheckType.SECTION_COMPLETENESS,
    score,
    weight: 0, // set by rule
    status: score >= 0.8 ? 'PASS' : score >= 0.5 ? 'WARN' : 'FAIL',
    message: missing.length === 0 && thin.length === 0
      ? `All ${requiredHeadings.length} sections present and substantive`
      : `Missing: ${missing.length}, Thin: ${thin.length}`,
    details: { found, thin, missing },
  };
}

/**
 * BDD_SCENARIO_COUNT — counts Gherkin scenarios and Given/When/Then triplets.
 */
export function scoreBddScenarioCount(
  output: string,
  args: { minScenarios?: number } = {},
): CheckResult {
  const { minScenarios = 5 } = args;

  const scenarioMatches = output.match(/Scenario[:\s]/g);
  const scenarioCount = scenarioMatches?.length ?? 0;

  const gwtPattern = /Given\s.+[\n\r]\s*When\s.+[\n\r]\s*Then\s/g;
  const gwtMatches = output.match(gwtPattern);
  const gwtCount = gwtMatches?.length ?? 0;

  const rawScore = Math.min(scenarioCount / minScenarios, 1);
  const gwtRatio = scenarioCount > 0 ? gwtCount / scenarioCount : 0;
  // Penalize scenarios missing Given/When/Then structure
  const score = rawScore * (0.5 + 0.5 * Math.min(gwtRatio, 1));

  return {
    name: 'BDD Scenario Count',
    type: CheckType.BDD_SCENARIO_COUNT,
    score,
    weight: 0,
    status: score >= 0.8 ? 'PASS' : score >= 0.4 ? 'WARN' : 'FAIL',
    message: `${scenarioCount} scenarios (${gwtCount} with complete Given/When/Then), need ${minScenarios}+`,
    details: { scenarioCount, gwtCount, minScenarios },
  };
}

/**
 * CROSS_STAGE_REFERENCES — checks that current stage output references
 * artifacts/concepts from prior stages (ensures pipeline coherence).
 */
export function scoreCrossStageReferences(
  output: string,
  args: { priorStageKeywords: string[] },
): CheckResult {
  const { priorStageKeywords } = args;
  if (priorStageKeywords.length === 0) {
    return {
      name: 'Cross-Stage References',
      type: CheckType.CROSS_STAGE_REFERENCES,
      score: 1,
      weight: 0,
      status: 'PASS',
      message: 'No prior stages to reference (first stage)',
      details: {},
    };
  }

  const found: string[] = [];
  const missing: string[] = [];
  const lower = output.toLowerCase();

  for (const kw of priorStageKeywords) {
    if (lower.includes(kw.toLowerCase())) {
      found.push(kw);
    } else {
      missing.push(kw);
    }
  }

  const score = found.length / priorStageKeywords.length;

  return {
    name: 'Cross-Stage References',
    type: CheckType.CROSS_STAGE_REFERENCES,
    score,
    weight: 0,
    status: score >= 0.6 ? 'PASS' : score >= 0.3 ? 'WARN' : 'FAIL',
    message: `References ${found.length}/${priorStageKeywords.length} prior-stage concepts`,
    details: { found, missing },
  };
}

/**
 * CODE_BLOCK_PRESENCE — checks for typed fenced code blocks (```lang ... ```).
 * FORGE stage needs actual implementation code, not just pseudocode.
 */
export function scoreCodeBlockPresence(
  output: string,
  args: { minBlocks?: number; requiredLangs?: string[] } = {},
): CheckResult {
  const { minBlocks = 3, requiredLangs = [] } = args;

  // Match typed code blocks
  const blockPattern = /```(\w+)\n([\s\S]*?)```/g;
  const blocks: Array<{ lang: string; lines: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(output)) !== null) {
    const lang = match[1].toLowerCase();
    const lines = match[2].split('\n').length;
    blocks.push({ lang, lines });
  }

  const langSet = new Set(blocks.map((b) => b.lang));
  const missingLangs = requiredLangs.filter((l) => !langSet.has(l.toLowerCase()));
  const totalLines = blocks.reduce((sum, b) => sum + b.lines, 0);

  const blockScore = Math.min(blocks.length / minBlocks, 1);
  const langScore = requiredLangs.length > 0
    ? (requiredLangs.length - missingLangs.length) / requiredLangs.length
    : 1;
  // Penalize very short code blocks (< 5 lines average)
  const substanceBonus = blocks.length > 0 && totalLines / blocks.length >= 5 ? 1 : 0.8;

  const score = blockScore * 0.5 + langScore * 0.3 + (blocks.length > 0 ? substanceBonus * 0.2 : 0);

  return {
    name: 'Code Block Presence',
    type: CheckType.CODE_BLOCK_PRESENCE,
    score,
    weight: 0,
    status: score >= 0.7 ? 'PASS' : score >= 0.4 ? 'WARN' : 'FAIL',
    message: `${blocks.length} code blocks (${totalLines} lines) across ${langSet.size} language(s)`,
    details: { blocks, missingLangs, totalLines },
  };
}

/**
 * BUILD_READINESS — checks FORGE output for build-ready signals.
 *
 * 7 signal categories (ported from legacy-bridge):
 *   1. Package manifest (package.json, go.mod, etc.)
 *   2. Entrypoint file (main.ts, index.ts, etc.)
 *   3. Dockerfile / container config
 *   4. Config files (.env, yaml configs, etc.)
 *   5. README / documentation
 *   6. Test files
 *   7. Import consistency (relative imports resolve to generated files)
 */
export function scoreBuildReadiness(output: string): CheckResult {
  const signals = [
    { name: 'package_manifest', pattern: /(?:package\.json|go\.mod|pom\.xml|build\.gradle|pyproject\.toml|Cargo\.toml|requirements\.txt)/i, found: false },
    { name: 'entrypoint', pattern: /(?:main\.\w+|index\.\w+|app\.\w+|server\.\w+|cmd\/)/i, found: false },
    { name: 'dockerfile', pattern: /(?:Dockerfile|docker-compose|\.dockerignore)/i, found: false },
    { name: 'config_files', pattern: /(?:\.env|\.yaml|\.yml|\.toml|tsconfig|jest\.config|vitest\.config|\.eslintrc)/i, found: false },
    { name: 'readme', pattern: /(?:README|CONTRIBUTING|CHANGELOG)/i, found: false },
    { name: 'test_files', pattern: /(?:\.test\.|\.spec\.|_test\.|test_|\/tests\/|\/test\/|\/spec\/)/i, found: false },
    { name: 'error_handling', pattern: /(?:try\s*\{|catch\s*\(|\.catch\(|if\s+err\s*!=\s*nil|except\s)/g, found: false },
  ];

  let foundCount = 0;
  for (const sig of signals) {
    if (sig.pattern.test(output)) {
      sig.found = true;
      foundCount++;
    }
  }

  // Import consistency check: do relative imports resolve to known files?
  const codeBlocks = extractCodeBlocks(output);
  const knownFiles: string[] = [];
  // Collect known file names from file headers and code fence filenames
  const fileHeaderPattern = /(?:\/\/|#|--|\/\*)\s*(?:File|Path|Filename):\s*(.+)/gi;
  let m: RegExpExecArray | null;
  while ((m = fileHeaderPattern.exec(output)) !== null) {
    knownFiles.push(cleanPath(m[1]));
  }
  for (const block of codeBlocks) {
    if (block.filename) knownFiles.push(block.filename);
  }

  const importCheck = checkImportConsistency(codeBlocks, knownFiles);
  const importScore = importCheck.total > 0
    ? importCheck.resolved / importCheck.total
    : 1; // no imports = no penalty

  // Composite score: 70% signal presence + 30% import consistency
  const signalScore = foundCount / signals.length;
  const score = signalScore * 0.7 + importScore * 0.3;

  return {
    name: 'Build Readiness',
    type: CheckType.BUILD_READINESS,
    score,
    weight: 0,
    status: score >= 0.6 ? 'PASS' : score >= 0.3 ? 'WARN' : 'FAIL',
    message: `${foundCount}/${signals.length} signals, imports: ${importCheck.resolved}/${importCheck.total} resolved`,
    details: {
      signals: signals.map((s) => ({ name: s.name, found: s.found })),
      importConsistency: importCheck,
    },
  };
}

/**
 * FILE_ARTIFACTS — multi-strategy file path detection in code output.
 *
 * Strategies (ported from legacy-bridge):
 *   1. Comment-style headers: "// File: src/services/user.ts"
 *   2. Code fence filenames: "```ts src/app.ts"
 *   3. Dash-prefixed paths: "- src/models/user.ts"
 *   4. Standalone file paths in narrative text (after stripping code fences)
 */
export function scoreFileArtifacts(
  output: string,
  args: { minFiles?: number } = {},
): CheckResult {
  const { minFiles = 2 } = args;
  const files = new Set<string>();
  let match: RegExpExecArray | null;

  // Strategy 1: Comment-style file headers
  const fileHeaderPattern = /(?:\/\/|#|--|\/\*)\s*(?:File|Path|Filename):\s*(.+)/gi;
  while ((match = fileHeaderPattern.exec(output)) !== null) {
    const p = cleanPath(match[1]);
    if (p) files.add(p);
  }

  // Strategy 2: Code fence filenames — "```lang filename.ext"
  const altPattern = /```\w+\s+([\w/.\\@-]+\.\w+)/g;
  while ((match = altPattern.exec(output)) !== null) {
    const p = cleanPath(match[1]);
    if (p) files.add(p);
  }

  // Strategy 3: Dash-prefixed paths in lists — "- src/app.ts"
  const dashPattern = /^[-*]\s+((?:[\w@./\\-]+\/)?[\w.-]+\.\w{1,10})\s*$/gm;
  while ((match = dashPattern.exec(output)) !== null) {
    const p = cleanPath(match[1]);
    if (isFilePath(p)) files.add(p);
  }

  // Strategy 4: Standalone file paths in narrative (strip code to avoid noise)
  const narrative = stripCodeFences(output);
  const pathPattern = /(?:^|\s)((?:src|lib|app|pkg|cmd|internal|test|spec|config)\/[\w/.\\-]+\.\w{1,10})/gm;
  while ((match = pathPattern.exec(narrative)) !== null) {
    const p = cleanPath(match[1]);
    if (isFilePath(p) && !files.has(p)) files.add(p);
  }

  // Also count substantial code fences (5+ lines) as implicit file artifacts
  const codeBlocks = extractCodeBlocks(output);
  const substantialBlocks = codeBlocks.filter((b) => b.lines >= 5).length;

  const fileCount = files.size;
  const totalArtifacts = fileCount + Math.max(0, substantialBlocks - fileCount);
  const score = Math.min(totalArtifacts / minFiles, 1);

  return {
    name: 'File Artifacts',
    type: CheckType.FILE_ARTIFACTS,
    score,
    weight: 0,
    status: score >= 0.8 ? 'PASS' : score >= 0.4 ? 'WARN' : 'FAIL',
    message: `${fileCount} labeled file(s) + ${substantialBlocks} code blocks, need ${minFiles}+`,
    details: { files: [...files], substantialBlocks, minFiles },
  };
}

/**
 * PARALLEL_RUN_COVERAGE — SHADOW_RUN stage specific.
 * Checks for explicit PASS/FAIL/DEVIATION results per test scenario
 * and a GO/NO-GO cutover verdict.
 */
export function scoreParallelRunCoverage(output: string): CheckResult {
  const passCount = (output.match(/\bPASS\b/g) ?? []).length;
  const failCount = (output.match(/\bFAIL\b/g) ?? []).length;
  const deviationCount = (output.match(/\bDEVIATION\b/g) ?? []).length;
  const totalResults = passCount + failCount + deviationCount;

  const hasVerdict = /\b(?:GO|NO-GO|READY|NOT READY)\b/i.test(output);
  const hasPerformanceData = /\b(?:latency|throughput|p\d{2}|response time|ms\b)/gi.test(output);

  let score = 0;
  if (totalResults >= 5) score += 0.4;
  else if (totalResults >= 2) score += 0.2;
  if (hasVerdict) score += 0.4;
  if (hasPerformanceData) score += 0.2;

  return {
    name: 'Parallel Run Coverage',
    type: CheckType.PARALLEL_RUN_COVERAGE,
    score,
    weight: 0,
    status: score >= 0.7 ? 'PASS' : score >= 0.4 ? 'WARN' : 'FAIL',
    message: `${totalResults} test results (${passCount}P/${failCount}F/${deviationCount}D), verdict: ${hasVerdict ? 'yes' : 'no'}`,
    details: { passCount, failCount, deviationCount, hasVerdict, hasPerformanceData },
  };
}

/**
 * MERMAID_VALIDITY — checks that mermaid diagram blocks contain valid syntax.
 * Not a full parser, but catches common structural issues.
 */
export function scoreMermaidValidity(output: string): CheckResult {
  const mermaidPattern = /```mermaid\n([\s\S]*?)```/g;
  const diagrams: Array<{ valid: boolean; type: string; error?: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = mermaidPattern.exec(output)) !== null) {
    const body = match[1].trim();
    const firstLine = body.split('\n')[0].trim().toLowerCase();

    // Check for valid diagram type declaration
    const validTypes = ['graph', 'flowchart', 'sequencediagram', 'classDiagram', 'statediagram',
      'erdiagram', 'gantt', 'pie', 'gitgraph', 'mindmap', 'timeline', 'c4context',
      'graph td', 'graph lr', 'graph rl', 'graph bt',
      'flowchart td', 'flowchart lr', 'flowchart rl', 'flowchart bt',
      'sequencediagram', 'classdiagram', 'statediagram', 'erdiagram'];

    const hasValidType = validTypes.some((t) => firstLine.startsWith(t.toLowerCase()));
    const hasNodes = /\w+[\s]*(?:-->|---|==>|-.->|\||\[|\(|\{)/.test(body);
    const hasMinContent = body.split('\n').length >= 3;

    if (!hasValidType) {
      diagrams.push({ valid: false, type: firstLine, error: 'Invalid diagram type' });
    } else if (!hasNodes && !['pie', 'gantt', 'gitgraph', 'timeline'].some(t => firstLine.startsWith(t))) {
      diagrams.push({ valid: false, type: firstLine, error: 'No nodes or connections found' });
    } else if (!hasMinContent) {
      diagrams.push({ valid: false, type: firstLine, error: 'Diagram too short (< 3 lines)' });
    } else {
      diagrams.push({ valid: true, type: firstLine });
    }
  }

  if (diagrams.length === 0) {
    return {
      name: 'Mermaid Validity',
      type: CheckType.MERMAID_VALIDITY,
      score: 0,
      weight: 0,
      status: 'FAIL',
      message: 'No Mermaid diagrams found',
      details: { diagrams },
    };
  }

  const validCount = diagrams.filter((d) => d.valid).length;
  const score = validCount / diagrams.length;

  return {
    name: 'Mermaid Validity',
    type: CheckType.MERMAID_VALIDITY,
    score,
    weight: 0,
    status: score >= 0.8 ? 'PASS' : score >= 0.5 ? 'WARN' : 'FAIL',
    message: `${validCount}/${diagrams.length} Mermaid diagram(s) structurally valid`,
    details: { diagrams },
  };
}

/**
 * OUTPUT_SUBSTANCE — guards against filler content.
 * Penalizes: excessive bullet-only sections, placeholder text,
 * "TBD"/"TODO" items, very short paragraphs, overly generic language.
 */
export function scoreOutputSubstance(output: string): CheckResult {
  const totalWords = output.split(/\s+/).filter(Boolean).length;
  const penalties: Array<{ reason: string; deduction: number }> = [];

  // 1. TBD/TODO/placeholder count
  const tbdCount = (output.match(/\b(?:TBD|TODO|PLACEHOLDER|FIXME|XXX|INSERT HERE)\b/gi) ?? []).length;
  if (tbdCount > 0) {
    penalties.push({ reason: `${tbdCount} placeholder(s) (TBD/TODO)`, deduction: Math.min(tbdCount * 0.05, 0.3) });
  }

  // 2. Filler phrases
  const fillerPatterns = [
    /\bas (?:mentioned|discussed|noted) (?:above|below|earlier|previously)\b/gi,
    /\bin (?:summary|conclusion|other words)\b/gi,
    /\bgoing forward\b/gi,
    /\bit is (?:important|worth noting|recommended) to\b/gi,
  ];
  let fillerCount = 0;
  for (const fp of fillerPatterns) {
    fillerCount += (output.match(fp) ?? []).length;
  }
  if (fillerCount > 5) {
    penalties.push({ reason: `${fillerCount} filler phrases`, deduction: Math.min(fillerCount * 0.02, 0.15) });
  }

  // 3. Bullet-to-prose ratio: too many bullets, not enough exposition
  const bulletLines = (output.match(/^\s*[-*•]\s/gm) ?? []).length;
  const totalLines = output.split('\n').length;
  const bulletRatio = totalLines > 0 ? bulletLines / totalLines : 0;
  if (bulletRatio > 0.7 && totalWords > 200) {
    penalties.push({ reason: `${Math.round(bulletRatio * 100)}% bullet-only content`, deduction: 0.1 });
  }

  // 4. Very short output
  if (totalWords < 200) {
    penalties.push({ reason: `Only ${totalWords} words`, deduction: 0.3 });
  }

  const totalDeduction = penalties.reduce((s, p) => s + p.deduction, 0);
  const score = Math.max(0, 1 - totalDeduction);

  return {
    name: 'Output Substance',
    type: CheckType.OUTPUT_SUBSTANCE,
    score,
    weight: 0,
    status: score >= 0.7 ? 'PASS' : score >= 0.4 ? 'WARN' : 'FAIL',
    message: penalties.length === 0
      ? 'Output is substantive and well-structured'
      : `${penalties.length} substance issue(s): ${penalties.map((p) => p.reason).join('; ')}`,
    details: { totalWords, penalties, bulletRatio },
  };
}

/**
 * TEST_COVERAGE — parses test results from stage output.
 *
 * Ported from legacy-bridge scoreTestCoverage(). Looks for:
 *   1. Numeric test results: "X passed, Y failed" / "X/Y tests"
 *   2. Checkmark/cross test lines: ✓ test name / ✗ test name
 *   3. Pass rate calculation
 *   4. Fallback: detects test discussion/mentions if no parseable counts
 */
export function scoreTestCoverage(
  output: string,
  args: { minTests?: number } = {},
): CheckResult {
  const { minTests = 3 } = args;

  // Strategy 1: Look for explicit pass/fail counts
  const passFailPattern = /(\d+)\s*(?:passed|pass|✓|✅)\s*[,\s]*(\d+)?\s*(?:failed|fail|✗|❌)?/gi;
  let totalPassed = 0;
  let totalFailed = 0;
  let match: RegExpExecArray | null;

  while ((match = passFailPattern.exec(output)) !== null) {
    totalPassed += parseInt(match[1], 10);
    if (match[2]) totalFailed += parseInt(match[2], 10);
  }

  // Strategy 2: Count checkmark lines
  const checkLines = (output.match(/^\s*[✓✅☑√]\s+.+/gm) ?? []).length;
  const crossLines = (output.match(/^\s*[✗❌☐×]\s+.+/gm) ?? []).length;

  if (checkLines > totalPassed) {
    totalPassed = checkLines;
    totalFailed = Math.max(totalFailed, crossLines);
  }

  // Strategy 3: "N/M tests" pattern
  const ratioPattern = /(\d+)\s*\/\s*(\d+)\s*tests?\s*(?:passed|passing)/gi;
  while ((match = ratioPattern.exec(output)) !== null) {
    const p = parseInt(match[1], 10);
    const t = parseInt(match[2], 10);
    if (p > totalPassed) {
      totalPassed = p;
      totalFailed = Math.max(totalFailed, t - p);
    }
  }

  const totalTests = totalPassed + totalFailed;

  // Fallback: if no parseable counts, check for test discussion
  if (totalTests === 0) {
    const testMentions = (output.match(/\b(?:test|spec|assertion|expect|should|describe|it\(|test\()\b/gi) ?? []).length;
    const hasTestDiscussion = testMentions >= 3;

    return {
      name: 'Test Coverage',
      type: CheckType.TEST_COVERAGE,
      score: hasTestDiscussion ? 0.3 : 0,
      weight: 0,
      status: hasTestDiscussion ? 'WARN' : 'FAIL',
      message: hasTestDiscussion
        ? 'Test-related discussion found but no parseable results'
        : 'No test results or discussion found',
      details: { testMentions, totalTests: 0 },
    };
  }

  const passRate = totalTests > 0 ? totalPassed / totalTests : 0;
  const countScore = Math.min(totalTests / minTests, 1);
  const score = countScore * 0.6 + passRate * 0.4;

  return {
    name: 'Test Coverage',
    type: CheckType.TEST_COVERAGE,
    score,
    weight: 0,
    status: score >= 0.7 ? 'PASS' : score >= 0.4 ? 'WARN' : 'FAIL',
    message: `${totalPassed} passed, ${totalFailed} failed (${totalTests} total, ${Math.round(passRate * 100)}% pass rate)`,
    details: { totalPassed, totalFailed, totalTests, passRate, minTests },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 2. CHECK REGISTRY & DISPATCHER
// ═══════════════════════════════════════════════════════════════════

type OutputCheckFn = (output: string, args?: Record<string, unknown>) => CheckResult;

const DETERMINISTIC_CHECK_REGISTRY: Record<CheckType, OutputCheckFn> = {
  [CheckType.SECTION_COMPLETENESS]: (output, args) =>
    scoreSectionCompleteness(output, args as { requiredHeadings: string[]; minWordsPerSection?: number }),
  [CheckType.BDD_SCENARIO_COUNT]: (output, args) =>
    scoreBddScenarioCount(output, args as { minScenarios?: number }),
  [CheckType.CROSS_STAGE_REFERENCES]: (output, args) =>
    scoreCrossStageReferences(output, args as { priorStageKeywords: string[] }),
  [CheckType.CODE_BLOCK_PRESENCE]: (output, args) =>
    scoreCodeBlockPresence(output, args as { minBlocks?: number; requiredLangs?: string[] }),
  [CheckType.BUILD_READINESS]: (output) =>
    scoreBuildReadiness(output),
  [CheckType.FILE_ARTIFACTS]: (output, args) =>
    scoreFileArtifacts(output, args as { minFiles?: number }),
  [CheckType.PARALLEL_RUN_COVERAGE]: (output) =>
    scoreParallelRunCoverage(output),
  [CheckType.MERMAID_VALIDITY]: (output) =>
    scoreMermaidValidity(output),
  [CheckType.OUTPUT_SUBSTANCE]: (output) =>
    scoreOutputSubstance(output),
  [CheckType.TEST_COVERAGE]: (output, args) =>
    scoreTestCoverage(output, args as { minTests?: number }),
};

/**
 * Run a single deterministic check by type.
 * Returns CheckResult with weight from the rule applied.
 */
export function runDeterministicCheck(
  type: CheckType,
  output: string,
  weight: number,
  args?: Record<string, unknown>,
): CheckResult {
  const fn = DETERMINISTIC_CHECK_REGISTRY[type];
  if (!fn) {
    return {
      name: `Unknown Check: ${type}`,
      type,
      score: 0,
      weight,
      status: 'FAIL',
      message: `No check registered for type: ${type}`,
    };
  }
  const result = fn(output, args);
  result.weight = weight;
  return result;
}

/**
 * Run all deterministic checks for a stage according to its validation rule.
 * Returns array of CheckResults and weighted aggregate score (0-1).
 */
export function runAllDeterministicChecks(
  output: string,
  checks: Array<{ type: CheckType; weight: number; args?: Record<string, unknown> }>,
): { results: CheckResult[]; aggregateScore: number } {
  const results = checks.map((c) => runDeterministicCheck(c.type, output, c.weight, c.args));

  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  const aggregateScore = totalWeight > 0
    ? results.reduce((s, r) => s + r.score * r.weight, 0) / totalWeight
    : 0;

  return { results, aggregateScore };
}

// ═══════════════════════════════════════════════════════════════════
// 3. CODE QUALITY CHECKS — for generated source code artifacts
// ═══════════════════════════════════════════════════════════════════

export interface DeadCodeAnalysis {
  unreachableLines: Array<{ file: string; line: number; code: string }>;
  unusedVariables: Array<{ file: string; name: string; line: number }>;
  unusedFunctions: Array<{ file: string; name: string; line: number }>;
  unusedImports: Array<{ file: string; module: string; line: number }>;
}

export interface ComplexityMetrics {
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  nestingLevel: number;
  functions: Array<{
    name: string;
    file: string;
    cyclomaticComplexity: number;
    linesOfCode: number;
  }>;
}

export interface DependencyAnalysis {
  directDependencies: string[];
  transitiveDepth: number;
  circularDependencies: Array<string[]>;
  externalDependencies: {
    production: Array<{ name: string; version: string }>;
    development: Array<{ name: string; version: string }>;
  };
  vulnDependencies: Array<{
    name: string;
    version: string;
    vulnerability: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
  }>;
}

export interface CodeCoverageMetrics {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  uncoveredLines: Array<{ file: string; line: number }>;
}

export interface DuplicationMetrics {
  duplicatedLines: number;
  duplicateBlocks: Array<{
    file1: string; line1: number;
    file2: string; line2: number;
    lines: number;
  }>;
}

export function checkDeadCode(analysis: DeadCodeAnalysis): CheckResult {
  const issues = [
    ...analysis.unreachableLines,
    ...analysis.unusedVariables,
    ...analysis.unusedFunctions,
    ...analysis.unusedImports,
  ];
  const score = issues.length === 0 ? 1 : Math.max(0, 1 - issues.length * 0.05);
  return {
    name: 'Dead Code Detection',
    type: CheckType.OUTPUT_SUBSTANCE, // reuse as general quality
    score,
    weight: 1,
    status: issues.length === 0 ? 'PASS' : issues.length > 10 ? 'FAIL' : 'WARN',
    message: issues.length === 0 ? 'No dead code detected' : `Found ${issues.length} dead code issues`,
    details: { issues, count: issues.length },
  };
}

export function checkComplexity(metrics: ComplexityMetrics): CheckResult {
  const complexFns = metrics.functions.filter((f) => f.cyclomaticComplexity > 10);
  const hasHighComplexity = metrics.cyclomaticComplexity > 15 || metrics.cognitiveComplexity > 20;
  const score = hasHighComplexity ? 0.3 : complexFns.length > 5 ? 0.5 : complexFns.length > 0 ? 0.7 : 1;
  return {
    name: 'Complexity Check',
    type: CheckType.OUTPUT_SUBSTANCE,
    score,
    weight: 1,
    status: score >= 0.7 ? 'PASS' : score >= 0.5 ? 'WARN' : 'FAIL',
    message: score === 1 ? 'Complexity within acceptable ranges' : `${complexFns.length} complex functions found`,
    details: { metrics, complexFunctions: complexFns.slice(0, 10) },
  };
}

export function checkDependencies(analysis: DependencyAnalysis): CheckResult {
  const criticalVulns = analysis.vulnDependencies.filter((v) => v.severity === 'critical');
  const hasCircular = analysis.circularDependencies.length > 0;
  const score = criticalVulns.length > 0 ? 0 : hasCircular ? 0.5 : 1;
  return {
    name: 'Dependency Analysis',
    type: CheckType.OUTPUT_SUBSTANCE,
    score,
    weight: 1,
    status: criticalVulns.length > 0 ? 'FAIL' : hasCircular ? 'WARN' : 'PASS',
    message: criticalVulns.length > 0
      ? `${criticalVulns.length} critical vulnerabilities`
      : hasCircular ? `${analysis.circularDependencies.length} circular dependencies` : 'Dependencies healthy',
    details: { analysis, criticalVulnerabilities: criticalVulns },
  };
}

export function checkCodeCoverage(metrics: CodeCoverageMetrics): CheckResult {
  const avg = (metrics.statements + metrics.branches + metrics.functions + metrics.lines) / 4;
  const score = avg / 100;
  return {
    name: 'Code Coverage Check',
    type: CheckType.OUTPUT_SUBSTANCE,
    score,
    weight: 1,
    status: avg >= 80 ? 'PASS' : avg >= 60 ? 'WARN' : 'FAIL',
    message: `Average coverage: ${avg.toFixed(1)}%`,
    details: { metrics },
  };
}

export function checkDuplication(metrics: DuplicationMetrics): CheckResult {
  const score = Math.max(0, 1 - metrics.duplicatedLines / 100);
  return {
    name: 'Duplication Check',
    type: CheckType.OUTPUT_SUBSTANCE,
    score,
    weight: 1,
    status: metrics.duplicatedLines <= 5 ? 'PASS' : metrics.duplicatedLines <= 15 ? 'WARN' : 'FAIL',
    message: `${metrics.duplicatedLines}% code duplication`,
    details: { metrics, topDuplicates: metrics.duplicateBlocks.slice(0, 5) },
  };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
