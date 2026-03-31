/**
 * Stage Contracts — enforce completeness, not just score it.
 *
 * Each stage defines:
 *   - requiredSections: headings/sections that MUST be present in the output
 *   - requiredArtifacts: concrete deliverables (code files, diagrams, specs)
 *   - requiredPatterns: regex patterns that indicate completeness (e.g., BDD Given/When/Then)
 *   - minDepth: minimum heading depth (H2 sections with H3 subsections)
 *   - maxRefinementPasses: how many times to auto-refine before escalating to user
 *
 * The enforcer diffs the output against the contract, identifies EXACTLY what's missing,
 * and feeds a targeted refinement prompt back to the LLM — not a full re-run.
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';

export interface SectionRequirement {
  heading: string;
  required: boolean;
  minWordCount?: number;
  mustContain?: string[]; // keywords that must appear in this section
  subsections?: string[]; // required H3 subsections under this H2
}

export interface ArtifactRequirement {
  type: 'code' | 'diagram' | 'spec' | 'config' | 'test' | 'migration';
  description: string;
  filePattern?: string; // e.g., "*.ts", "Dockerfile", "*.gherkin"
  required: boolean;
}

export interface PatternRequirement {
  name: string;
  pattern: RegExp;
  minOccurrences: number;
  description: string;
}

export interface StageContract {
  stageName: PipelineStageName;
  stageIndex: number;
  requiredSections: SectionRequirement[];
  requiredArtifacts: ArtifactRequirement[];
  requiredPatterns: PatternRequirement[];
  minTotalWords: number;
  maxRefinementPasses: number;
  /**
   * Hard gate — when true, the pipeline REFUSES to advance if validation fails,
   * even if the agent claims "output is usable". Critical violations always block.
   * Inspired by Superpowers' mandatory hard-gate pattern.
   */
  hardGate: boolean;
}

export interface ContractViolation {
  type: 'missing_section' | 'thin_section' | 'missing_artifact' | 'missing_pattern' | 'too_short';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  section?: string;
  actual?: number;
  expected?: number;
}

export interface ContractResult {
  stageName: PipelineStageName;
  passed: boolean;
  completenessScore: number; // 0-100
  violations: ContractViolation[];
  refinementPrompt: string | null; // auto-generated prompt to fix gaps
  /**
   * When true, the pipeline MUST NOT advance to the next stage.
   * Set when the contract has hardGate=true AND validation failed.
   */
  hardGated: boolean;
}

// ─── STAGE CONTRACTS ────────────────────────────────────────────

export const stageContracts: StageContract[] = [
  // ── SCAN ───────────────────────────────────────────────────────
  // SCAN is an inventory stage — clean, readable, table-heavy output.
  // No remediation plans, no modernization strategy (those are later stages).
  {
    stageName: PipelineStageName.SCAN,
    stageIndex: 0,
    minTotalWords: 400,
    maxRefinementPasses: 1,
    hardGate: true,
    requiredSections: [
      { heading: 'Architecture', required: true, minWordCount: 60 },
      { heading: 'Technology Stack', required: true, minWordCount: 50 },
      { heading: 'Security', required: false, minWordCount: 40 },
      { heading: 'Risk', required: true, minWordCount: 40 },
    ],
    requiredArtifacts: [
      { type: 'diagram', description: 'Architecture or data flow diagram (Mermaid)', required: false },
    ],
    requiredPatterns: [
      { name: 'file_references', pattern: /`[a-zA-Z0-9_/\\.-]+\.[a-zA-Z]+`/g, minOccurrences: 2, description: 'Must reference specific source files' },
    ],
  },

  // ── DECODE ─────────────────────────────────────────────────────
  {
    stageName: PipelineStageName.DECODE,
    stageIndex: 1,
    minTotalWords: 1500,
    maxRefinementPasses: 2,
    hardGate: true,
    requiredSections: [
      { heading: 'Business Rules', required: true, minWordCount: 200, mustContain: ['rule', 'condition'] },
      { heading: 'Workflows', required: true, minWordCount: 150 },
      { heading: 'Data', required: true, minWordCount: 120 },
      { heading: 'Integration', required: true, minWordCount: 80 },
      { heading: 'Domain Entities', required: true, minWordCount: 100 },
      { heading: 'Technical Debt', required: true, minWordCount: 80 },
      { heading: 'Open Questions', required: true, minWordCount: 40 },
    ],
    requiredArtifacts: [
      { type: 'diagram', description: 'Entity relationship or workflow diagram (Mermaid)', required: true },
    ],
    requiredPatterns: [
      { name: 'code_evidence', pattern: /```[\s\S]*?```/g, minOccurrences: 3, description: 'Must include code evidence from the legacy codebase' },
      { name: 'file_references', pattern: /`[a-zA-Z0-9_/\\.-]+\.[a-zA-Z]+`/g, minOccurrences: 8, description: 'Must trace rules to specific source files' },
    ],
  },

  // ── BLUEPRINT ──────────────────────────────────────────────────
  {
    stageName: PipelineStageName.BLUEPRINT,
    stageIndex: 2,
    minTotalWords: 1000,
    maxRefinementPasses: 2,
    hardGate: true,
    requiredSections: [
      { heading: 'Capability Inventory', required: true, minWordCount: 150, mustContain: ['CAP-', 'BR-'] },
      { heading: 'Bounded Contexts', required: true, minWordCount: 150, mustContain: ['Entities', 'API'] },
      { heading: 'Service Boundary Decisions', required: true, minWordCount: 80, mustContain: ['Rationale', 'Tradeoff'] },
      { heading: 'Migration Waves', required: true, minWordCount: 100, mustContain: ['Wave', 'Sprint'] },
      { heading: 'Data Ownership', required: true, minWordCount: 60 },
    ],
    requiredArtifacts: [
      { type: 'diagram', description: 'Capability map (Mermaid)', required: true },
      { type: 'diagram', description: 'Dependency graph (Mermaid)', required: true },
    ],
    requiredPatterns: [
      { name: 'mermaid_blocks', pattern: /```mermaid[\s\S]*?```/g, minOccurrences: 2, description: 'Must include 2+ Mermaid diagrams' },
      { name: 'capability_ids', pattern: /CAP-\d+/g, minOccurrences: 3, description: 'Must define capability IDs' },
      { name: 'br_references', pattern: /BR-\d+/g, minOccurrences: 5, description: 'Must reference DECODE business rules' },
      { name: 'wave_plans', pattern: /Wave\s+\d+/gi, minOccurrences: 2, description: 'Must have at least 2 migration waves' },
    ],
  },

  // ── SPEC_LOCK ──────────────────────────────────────────────────
  {
    stageName: PipelineStageName.SPEC_LOCK,
    stageIndex: 3,
    minTotalWords: 1500,
    maxRefinementPasses: 3,
    hardGate: true,
    requiredSections: [
      { heading: 'Feature Files', required: true, minWordCount: 500, mustContain: ['Scenario', 'Given', 'When', 'Then', 'Feature'] },
      { heading: 'Test Execution Results', required: true, minWordCount: 100, mustContain: ['PASS', 'FAIL'] },
      { heading: 'Validation Findings', required: true, minWordCount: 100, mustContain: ['Critical', 'Warning'] },
      { heading: 'Traceability Matrix', required: true, minWordCount: 80, mustContain: ['BR-'] },
      { heading: 'Regression Checklist', required: true, minWordCount: 60 },
    ],
    requiredArtifacts: [
      { type: 'spec', description: 'Gherkin .feature files in code blocks', required: true, filePattern: '*.feature' },
    ],
    requiredPatterns: [
      { name: 'gherkin_scenarios', pattern: /Scenario[:\s]/g, minOccurrences: 15, description: 'Must have at least 15 BDD scenarios' },
      { name: 'given_when_then', pattern: /Given\s.+\n\s*When\s.+\n\s*Then\s/g, minOccurrences: 10, description: 'Must have complete Given/When/Then triplets' },
      { name: 'feature_files', pattern: /```gherkin\n#\s*File:/g, minOccurrences: 3, description: 'Must have at least 3 .feature file blocks' },
      { name: 'business_rule_tags', pattern: /@BR-[\w.]+/g, minOccurrences: 8, description: 'Must tag scenarios with business rule IDs' },
      { name: 'scenario_outlines', pattern: /Scenario Outline:/g, minOccurrences: 2, description: 'Must use Scenario Outlines with Examples tables' },
      { name: 'examples_tables', pattern: /Examples:/g, minOccurrences: 2, description: 'Must include Examples tables for parameterized scenarios' },
      { name: 'test_results', pattern: /\|\s*(?:PASS|FAIL)\s*\|/g, minOccurrences: 10, description: 'Must have at least 10 test execution results' },
    ],
  },

  // ── ARCHITECT ──────────────────────────────────────────────────
  {
    stageName: PipelineStageName.ARCHITECT,
    stageIndex: 4,
    minTotalWords: 1200,
    maxRefinementPasses: 2,
    hardGate: true,
    requiredSections: [
      { heading: 'Target Architecture', required: true, minWordCount: 200, mustContain: ['Component', 'Service'] },
      { heading: 'Technology Decision', required: true, minWordCount: 120, mustContain: ['Chosen', 'Alternative', 'Rationale'] },
      { heading: 'Migration Roadmap', required: true, minWordCount: 120, mustContain: ['Phase', 'Sprint'] },
      { heading: 'Risk Register', required: true, minWordCount: 100, mustContain: ['Probability', 'Impact', 'Mitigation'] },
      { heading: 'Cost Model', required: true, minWordCount: 60, mustContain: ['$'] },
    ],
    requiredArtifacts: [
      { type: 'diagram', description: 'Target architecture diagram (Mermaid)', required: true },
      { type: 'diagram', description: 'Data flow sequence diagram (Mermaid)', required: true },
      { type: 'diagram', description: 'Infrastructure deployment diagram (Mermaid)', required: true },
    ],
    requiredPatterns: [
      { name: 'mermaid_blocks', pattern: /```mermaid[\s\S]*?```/g, minOccurrences: 3, description: 'Must include 3 Mermaid diagrams (architecture + data flow + infrastructure)' },
      { name: 'cost_values', pattern: /\$[\d,]+/g, minOccurrences: 4, description: 'Must include concrete cost estimates' },
      { name: 'phase_refs', pattern: /Phase\s+\d+/gi, minOccurrences: 3, description: 'Must have at least 3 migration phases' },
      { name: 'br_refs', pattern: /BR-\d+/g, minOccurrences: 3, description: 'Must reference SPEC_LOCK business rules as gate criteria' },
      { name: 'sprint_refs', pattern: /Sprint\s+\d+/gi, minOccurrences: 3, description: 'Must have sprint-level timeline' },
    ],
  },

  // ── FORGE ──────────────────────────────────────────────────────
  {
    stageName: PipelineStageName.FORGE,
    stageIndex: 5,
    minTotalWords: 1000,
    maxRefinementPasses: 3,
    hardGate: false, // Co-Create is iterative — don't block, let user refine
    requiredSections: [
      { heading: 'Implementation', required: true, minWordCount: 200 },
      { heading: 'Tests', required: true, minWordCount: 100, mustContain: ['test', 'assert', 'expect'] },
      { heading: 'Configuration', required: true, minWordCount: 50 },
    ],
    requiredArtifacts: [
      { type: 'code', description: 'Source code files', required: true },
      { type: 'test', description: 'Test files', required: true },
      { type: 'config', description: 'Configuration files (Dockerfile, env, etc.)', required: false },
    ],
    requiredPatterns: [
      { name: 'code_blocks', pattern: /```(?:typescript|javascript|python|java|go|rust)[\s\S]*?```/g, minOccurrences: 3, description: 'Must include typed code blocks' },
      { name: 'test_blocks', pattern: /(?:describe|it|test|def test_|func Test)\s*\(/g, minOccurrences: 3, description: 'Must include test implementations' },
      { name: 'file_headers', pattern: /\/\/\s*(?:File|Path):\s*.+/g, minOccurrences: 2, description: 'Must label generated files with paths' },
    ],
  },

  // ── SHADOW_RUN ─────────────────────────────────────────────────
  {
    stageName: PipelineStageName.SHADOW_RUN,
    stageIndex: 6,
    minTotalWords: 1200,
    maxRefinementPasses: 2,
    hardGate: true, // Never proceed to cutover without passing validation
    requiredSections: [
      { heading: 'Test Matrix', required: true, minWordCount: 200, mustContain: ['MATCH', 'Legacy Result', 'Modern Result'] },
      { heading: 'Behavioral Comparison', required: true, minWordCount: 150, mustContain: ['Root Cause', 'Fix'] },
      { heading: 'Performance Comparison', required: true, minWordCount: 100, mustContain: ['p50', 'p95'] },
      { heading: 'Deviation Analysis', required: true, minWordCount: 80, mustContain: ['Severity', 'Blocking'] },
      { heading: 'Cutover Verdict', required: true, minWordCount: 100, mustContain: ['GO', 'Confidence'] },
    ],
    requiredArtifacts: [],
    requiredPatterns: [
      { name: 'match_results', pattern: /\|\s*(?:MATCH|DEVIATION|REGRESSION|IMPROVEMENT)\s*\|/g, minOccurrences: 10, description: 'Must have at least 10 per-scenario match results' },
      { name: 'verdict', pattern: /\*\*(?:GO|NO-GO)\*\*/g, minOccurrences: 1, description: 'Must include a bold GO/NO-GO verdict' },
      { name: 'confidence_score', pattern: /Confidence\s*(?:Score)?:?\s*\d+/gi, minOccurrences: 1, description: 'Must include a confidence score' },
      { name: 'performance_metrics', pattern: /\d+ms\s*\/\s*\d+ms/g, minOccurrences: 3, description: 'Must include p50/p95 latency comparisons' },
      { name: 'br_tags', pattern: /@BR-[\w.]+/g, minOccurrences: 5, description: 'Must reference business rule tags from SPEC_LOCK' },
    ],
  },

  // ── EVOLVE ─────────────────────────────────────────────────────
  {
    stageName: PipelineStageName.EVOLVE,
    stageIndex: 7,
    minTotalWords: 800,
    maxRefinementPasses: 2,
    hardGate: false, // Final stage — advisory only
    requiredSections: [
      { heading: 'KPI Dashboard', required: true, minWordCount: 100, mustContain: ['Target', 'Baseline'] },
      { heading: 'Operational Runbook', required: true, minWordCount: 100, mustContain: ['Monitor', 'Alert'] },
      { heading: 'Decommission Plan', required: true, minWordCount: 80, mustContain: ['Week', 'Phase'] },
      { heading: 'Modernization Backlog', required: true, minWordCount: 80, mustContain: ['Sprint', 'Priority'] },
      { heading: 'Cost Optimization', required: true, minWordCount: 40 },
    ],
    requiredArtifacts: [],
    requiredPatterns: [
      { name: 'kpi_metrics', pattern: /\d+(?:\.\d+)?%/g, minOccurrences: 8, description: 'Must include 8+ quantified KPI percentages' },
      { name: 'time_targets', pattern: /\d+(?:ms|s|min|h|d)/g, minOccurrences: 4, description: 'Must include time-based targets' },
      { name: 'sprint_refs', pattern: /Sprint\s+\d+/gi, minOccurrences: 2, description: 'Must reference sprint assignments' },
      { name: 'cost_values', pattern: /\$[\d,]+/g, minOccurrences: 2, description: 'Must include cost estimates' },
    ],
  },
];

// ─── CONTRACT ENFORCER ──────────────────────────────────────────

/**
 * Evaluate stage output against its contract.
 * Returns violations and a refinement prompt if gaps exist.
 */
export function enforceContract(
  stageName: PipelineStageName,
  output: string,
): ContractResult {
  const contract = stageContracts.find((c) => c.stageName === stageName);
  if (!contract) {
    return { stageName, passed: true, completenessScore: 100, violations: [], refinementPrompt: null, hardGated: false };
  }

  const violations: ContractViolation[] = [];
  const totalChecks = contract.requiredSections.length + contract.requiredArtifacts.filter(a => a.required).length + contract.requiredPatterns.length + 1;
  let passedChecks = 0;

  // 1. Check total word count
  const wordCount = output.split(/\s+/).filter(Boolean).length;
  if (wordCount < contract.minTotalWords) {
    violations.push({
      type: 'too_short',
      severity: 'critical',
      description: `Output is ${wordCount} words, minimum is ${contract.minTotalWords}`,
      actual: wordCount,
      expected: contract.minTotalWords,
    });
  } else {
    passedChecks++;
  }

  // 2. Check required sections
  for (const section of contract.requiredSections) {
    const headingPattern = new RegExp(`^#{1,3}\\s*${escapeRegex(section.heading)}`, 'im');
    const match = headingPattern.exec(output);

    if (!match) {
      if (section.required) {
        violations.push({
          type: 'missing_section',
          severity: 'critical',
          description: `Missing required section: "${section.heading}"`,
          section: section.heading,
        });
      }
      continue;
    }

    // Extract section content (until next heading of same or higher level)
    const sectionStart = match.index + match[0].length;
    const nextHeading = output.slice(sectionStart).search(/^#{1,3}\s/m);
    const sectionContent = nextHeading === -1
      ? output.slice(sectionStart)
      : output.slice(sectionStart, sectionStart + nextHeading);

    const sectionWords = sectionContent.split(/\s+/).filter(Boolean).length;

    if (section.minWordCount && sectionWords < section.minWordCount) {
      violations.push({
        type: 'thin_section',
        severity: 'major',
        description: `Section "${section.heading}" has ${sectionWords} words, needs ${section.minWordCount}+`,
        section: section.heading,
        actual: sectionWords,
        expected: section.minWordCount,
      });
    } else {
      passedChecks++;
    }

    // Check mustContain keywords
    if (section.mustContain) {
      const missing = section.mustContain.filter(
        (kw) => !sectionContent.toLowerCase().includes(kw.toLowerCase())
      );
      if (missing.length > 0) {
        violations.push({
          type: 'thin_section',
          severity: 'minor',
          description: `Section "${section.heading}" is missing keywords: ${missing.join(', ')}`,
          section: section.heading,
        });
      }
    }

    // Check subsections
    if (section.subsections) {
      for (const sub of section.subsections) {
        const subPattern = new RegExp(`^#{2,4}\\s*${escapeRegex(sub)}`, 'im');
        if (!subPattern.test(sectionContent)) {
          violations.push({
            type: 'missing_section',
            severity: 'major',
            description: `Missing subsection "${sub}" under "${section.heading}"`,
            section: `${section.heading} > ${sub}`,
          });
        }
      }
    }
  }

  // 3. Check required artifacts
  for (const artifact of contract.requiredArtifacts) {
    if (!artifact.required) continue;

    let found = false;
    if (artifact.type === 'diagram') {
      found = /```mermaid/i.test(output);
    } else if (artifact.type === 'code') {
      found = /```(?:typescript|javascript|python|java|go|rust|yaml|json)/i.test(output);
    } else if (artifact.type === 'spec') {
      found = /```(?:gherkin|feature)/i.test(output) || /Scenario[:\s]/i.test(output);
    } else if (artifact.type === 'test') {
      found = /(?:describe|it|test|def test_|func Test)\s*\(/i.test(output);
    } else if (artifact.type === 'config') {
      found = /```(?:yaml|json|toml|env|dockerfile)/i.test(output);
    }

    if (!found) {
      violations.push({
        type: 'missing_artifact',
        severity: 'critical',
        description: `Missing required artifact: ${artifact.description}`,
      });
    } else {
      passedChecks++;
    }
  }

  // 4. Check required patterns
  for (const pattern of contract.requiredPatterns) {
    const matches = output.match(pattern.pattern);
    const count = matches?.length ?? 0;
    if (count < pattern.minOccurrences) {
      violations.push({
        type: 'missing_pattern',
        severity: count === 0 ? 'critical' : 'major',
        description: `${pattern.description}: found ${count}, need ${pattern.minOccurrences}+`,
        actual: count,
        expected: pattern.minOccurrences,
      });
    } else {
      passedChecks++;
    }
  }

  const completenessScore = Math.round((passedChecks / totalChecks) * 100);
  const passed = violations.filter((v) => v.severity === 'critical').length === 0 && completenessScore >= 70;

  // Build targeted refinement prompt
  const refinementPrompt = violations.length > 0 ? buildRefinementPrompt(stageName, violations) : null;

  // Hard gate: block pipeline advancement if contract requires it and validation failed
  const hardGated = contract.hardGate && !passed;

  return { stageName, passed, completenessScore, violations, refinementPrompt, hardGated };
}

/**
 * Build a targeted refinement prompt from violations.
 * This is NOT a full re-run — it asks the LLM to fill specific gaps.
 */
function buildRefinementPrompt(
  stageName: PipelineStageName,
  violations: ContractViolation[],
): string {
  const critical = violations.filter((v) => v.severity === 'critical');
  const major = violations.filter((v) => v.severity === 'major');
  const minor = violations.filter((v) => v.severity === 'minor');

  let prompt = `Your previous output for the ${stageName} stage is incomplete. Fix the following gaps:\n\n`;

  if (critical.length > 0) {
    prompt += `**CRITICAL (must fix):**\n`;
    critical.forEach((v, i) => {
      prompt += `${i + 1}. ${v.description}\n`;
    });
    prompt += '\n';
  }

  if (major.length > 0) {
    prompt += `**MAJOR (should fix):**\n`;
    major.forEach((v, i) => {
      prompt += `${i + 1}. ${v.description}\n`;
    });
    prompt += '\n';
  }

  if (minor.length > 0) {
    prompt += `**MINOR (nice to have):**\n`;
    minor.forEach((v, i) => {
      prompt += `${i + 1}. ${v.description}\n`;
    });
    prompt += '\n';
  }

  prompt += `Output ONLY the missing/incomplete sections. Do not repeat content that was already complete. Use the same heading structure.`;

  return prompt;
}

/**
 * Get contract for a specific stage
 */
export function getStageContract(stageName: PipelineStageName): StageContract | undefined {
  return stageContracts.find((c) => c.stageName === stageName);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── SCAN SUBTASK CONTRACTS ────────────────────────────────────
// Lighter validation for individual subtask outputs.
// The full SCAN contract is enforced only on the composed output.

export type ScanSubtaskContractType =
  | 'architecture-analysis'
  | 'tech-stack-deepdive'
  | 'legacy-patterns'
  | 'data-layer'
  | 'security-scan'
  | 'business-capabilities';

export type DecodeSubtaskContractType =
  | 'business-rules-extraction'
  | 'data-flow-analysis'
  | 'workflow-extraction'
  | 'domain-entity-modeling'
  | 'integration-mapping'
  | 'constraints-debt-analysis';

export interface SubtaskContract {
  type: ScanSubtaskContractType | DecodeSubtaskContractType;
  requiredSections: Array<{ heading: string; required: boolean; minWordCount?: number }>;
  minTotalWords: number;
  maxRefinementPasses: number;
}

export const SCAN_SUBTASK_CONTRACTS: SubtaskContract[] = [
  {
    type: 'architecture-analysis',
    minTotalWords: 200,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Architecture', required: true, minWordCount: 60 },
      { heading: 'Data Flow', required: true, minWordCount: 40 },
    ],
  },
  {
    type: 'tech-stack-deepdive',
    minTotalWords: 150,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Technology', required: true, minWordCount: 60 },
    ],
  },
  {
    type: 'legacy-patterns',
    minTotalWords: 150,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Legacy', required: true, minWordCount: 60 },
    ],
  },
  {
    type: 'data-layer',
    minTotalWords: 150,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Data', required: true, minWordCount: 40 },
    ],
  },
  {
    type: 'security-scan',
    minTotalWords: 150,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Security', required: true, minWordCount: 60 },
    ],
  },
  {
    type: 'business-capabilities',
    minTotalWords: 150,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Business', required: true, minWordCount: 40 },
    ],
  },
];

// ─── DECODE SUBTASK CONTRACTS ───────────────────────────────────

export const DECODE_SUBTASK_CONTRACTS: SubtaskContract[] = [
  {
    type: 'business-rules-extraction',
    minTotalWords: 300,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Business Rules', required: true, minWordCount: 100 },
      { heading: 'Conditional', required: false, minWordCount: 40 },
    ],
  },
  {
    type: 'data-flow-analysis',
    minTotalWords: 250,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Data', required: true, minWordCount: 80 },
      { heading: 'Persistence', required: false, minWordCount: 40 },
    ],
  },
  {
    type: 'workflow-extraction',
    minTotalWords: 250,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Workflow', required: true, minWordCount: 80 },
    ],
  },
  {
    type: 'domain-entity-modeling',
    minTotalWords: 200,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Entity', required: true, minWordCount: 60 },
    ],
  },
  {
    type: 'integration-mapping',
    minTotalWords: 200,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Integration', required: true, minWordCount: 60 },
    ],
  },
  {
    type: 'constraints-debt-analysis',
    minTotalWords: 200,
    maxRefinementPasses: 1,
    requiredSections: [
      { heading: 'Technical Debt', required: true, minWordCount: 60 },
      { heading: 'Constraints', required: false, minWordCount: 40 },
    ],
  },
];

/**
 * Get subtask contract for a specific subtask type (SCAN or DECODE).
 */
export function getSubtaskContract(type: ScanSubtaskContractType | DecodeSubtaskContractType): SubtaskContract | undefined {
  return [...SCAN_SUBTASK_CONTRACTS, ...DECODE_SUBTASK_CONTRACTS].find((c) => c.type === type);
}

/**
 * Lightweight validation for subtask output — checks word count and required sections.
 * Returns violations (if any) but does NOT block execution — subtask results are
 * always kept and the composition step handles gaps.
 *
 * Section matching is fuzzy: each required heading is split into key words and a
 * section matches if any H1-H3 heading in the output contains ALL of those words
 * (case-insensitive). This tolerates the LLM using creative headings like
 * "Dual-Stack Architecture & Migration Mapping" instead of exact "Architecture Overview".
 */
export function validateSubtaskOutput(
  type: ScanSubtaskContractType | DecodeSubtaskContractType,
  output: string,
): { passed: boolean; issues: string[] } {
  const contract = getSubtaskContract(type);
  if (!contract) return { passed: true, issues: [] };

  const issues: string[] = [];
  const wordCount = output.split(/\s+/).filter(Boolean).length;

  if (wordCount < contract.minTotalWords) {
    issues.push(`Output is ${wordCount} words, minimum is ${contract.minTotalWords}`);
  }

  // Extract all headings from the output for fuzzy matching
  const headings = output.match(/^#{1,3}\s+.+$/gm) || [];
  const headingTexts = headings.map((h) => h.replace(/^#+\s*/, '').toLowerCase());

  for (const section of contract.requiredSections) {
    if (!section.required) continue;

    // Extract key words from the required heading (drop short words like "of", "and", "the")
    const keyWords = section.heading
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // A heading matches if it contains ALL key words from the required heading
    const found = headingTexts.some((h) =>
      keyWords.every((kw) => h.includes(kw)),
    );

    if (!found) {
      issues.push(`Missing required section: "${section.heading}"`);
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}
