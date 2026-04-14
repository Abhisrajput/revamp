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
  aliases?: string[]; // alternative heading names the LLM might use
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
      { heading: 'Business Rules', aliases: ['Business Rules Inventory', 'Business Rules & Domain Logic', 'Business Rules Catalog', 'Rules Catalog', 'Rules Inventory'], required: true, minWordCount: 200, mustContain: ['rule', 'condition'] },
      { heading: 'Workflows', aliases: ['Key Workflows', 'Workflow Extraction', 'User Workflows', 'Business Workflows', 'Process Flows'], required: true, minWordCount: 150 },
      { heading: 'Data', aliases: ['Data Flows', 'Data Flow Analysis', 'Data Entry Points', 'Data Model', 'Data Architecture', 'Data Layer'], required: true, minWordCount: 120 },
      { heading: 'Integration', aliases: ['Integration Points', 'Integration Mapping', 'External API Integrations', 'External Integrations', 'Integration Architecture', 'API Integration'], required: true, minWordCount: 80 },
      { heading: 'Domain Entities', aliases: ['Entity Inventory', 'Entity Relationships', 'Domain Entity Modeling', 'Entities', 'Entity Relationship', 'Core Entities'], required: true, minWordCount: 100 },
      { heading: 'Technical Debt', aliases: ['Technical Debt Inventory', 'Constraints & Technical Debt', 'Constraints & Assumptions', 'Tech Debt', 'Code Quality Debt', 'Security Debt'], required: true, minWordCount: 80 },
      { heading: 'Open Questions', aliases: ['Open Questions for SME', 'Open Questions for SME Clarification', 'Questions', 'Clarifications', 'Unknowns'], required: true, minWordCount: 40 },
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
      { name: 'gherkin_scenarios', pattern: /Scenario[:\s]/g, minOccurrences: 25, description: 'Must have at least 25 BDD scenarios for comprehensive coverage' },
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
    minTotalWords: 2000,
    maxRefinementPasses: 3,
    hardGate: true, // Hard gate — incomplete code generation makes SHADOW_RUN pointless
    requiredSections: [
      { heading: 'Implementation', aliases: ['Domain Models', 'Service Layer', 'API Layer', 'Source Code', 'Generated Code'], required: true, minWordCount: 400, mustContain: ['class', 'function'] },
      { heading: 'Tests', aliases: ['Test Scaffolding', 'Test Suite', 'Unit Tests', 'Step Definitions', 'BDD Tests'], required: true, minWordCount: 150, mustContain: ['test', 'assert', 'expect', 'describe', 'Scenario'] },
      { heading: 'Configuration', aliases: ['Infrastructure', 'Build Configuration', 'Deployment', 'DevOps', 'CI/CD'], required: true, minWordCount: 80 },
    ],
    requiredArtifacts: [
      { type: 'code', description: 'Source code files', required: true },
      { type: 'test', description: 'Test files', required: true },
      { type: 'config', description: 'Configuration files (Dockerfile, env, etc.)', required: true },
    ],
    requiredPatterns: [
      // Code generation coverage — scales dynamically
      { name: 'code_blocks', pattern: /```(?:typescript|javascript|python|java|go|rust|kotlin|csharp|cs|php|ruby|scala)[\s\S]*?```/g, minOccurrences: 10, description: 'Must include 10+ typed code blocks' },
      // File output coverage
      { name: 'file_headers', pattern: /(?:###\s*FILE:|\/\/\s*(?:File|Path):|#\s*File:)\s*.+/g, minOccurrences: 15, description: 'Must label 15+ generated files' },
      // BR traceability — the key coverage metric
      { name: 'br_coverage', pattern: /@BR-\d+|\/\/\s*@?BR-\d+|#\s*@?BR-\d+|BR-\d+/g, minOccurrences: 10, description: 'Must reference 10+ business rules in code' },
      // Test coverage
      { name: 'test_blocks', pattern: /(?:describe|it|test|def test_|func Test|@Test|\[Fact\]|Scenario|@pytest)/g, minOccurrences: 8, description: 'Must include 8+ test definitions' },
      // BDD step definitions for SPEC_LOCK features
      { name: 'step_definitions', pattern: /(?:@Given|@When|@Then|Given\(|When\(|Then\(|step_impl|@given|@when|@then)/g, minOccurrences: 5, description: 'Must include 5+ BDD step definition stubs' },
      // Model/entity definitions
      { name: 'model_definitions', pattern: /(?:@Entity|@Table|class\s+\w+(?:Entity|Model|Schema)|model\s+\w+|CREATE TABLE|Base\.metadata)/g, minOccurrences: 3, description: 'Must define 3+ domain models/entities' },
      // API endpoint definitions
      { name: 'api_endpoints', pattern: /(?:@(?:Get|Post|Put|Delete|Patch)Mapping|@app\.(?:get|post|put|delete)|router\.(?:get|post|put|delete)|@Controller|@RestController|@router)/g, minOccurrences: 3, description: 'Must define 3+ API endpoints' },
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
 * Accepts optional per-project overrides that merge with defaults.
 * Returns violations and a refinement prompt if gaps exist.
 */
export async function enforceContract(
  stageName: PipelineStageName,
  output: string,
  projectOverride?: Partial<StageContract>,
  /** Optional LLM function for agent-based section validation (more accurate than regex) */
  llmFn?: (req: { systemPrompt: string; userPrompt: string }) => Promise<string>,
): Promise<ContractResult> {
  const defaultContract = stageContracts.find((c) => c.stageName === stageName);
  if (!defaultContract) {
    return { stageName, passed: true, completenessScore: 100, violations: [], refinementPrompt: null, hardGated: false };
  }

  // Merge project overrides with defaults
  const contract: StageContract = projectOverride
    ? {
        ...defaultContract,
        minTotalWords: projectOverride.minTotalWords ?? defaultContract.minTotalWords,
        maxRefinementPasses: projectOverride.maxRefinementPasses ?? defaultContract.maxRefinementPasses,
        hardGate: projectOverride.hardGate ?? defaultContract.hardGate,
        requiredSections: projectOverride.requiredSections ?? defaultContract.requiredSections,
      }
    : defaultContract;

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

  // 2. Check required sections — use fast heuristic matching
  // For agent-based validation (more accurate), call enforceContractWithAgent() instead
  for (const section of contract.requiredSections) {
    const candidates = [section.heading, ...(section.aliases || [])];
    let match: RegExpExecArray | null = null;
    let matchLevel = 0;

    // Strategy: try multiple matching approaches, from strict to loose
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();

      // 1. Exact heading match (with optional prefixes)
      const escaped = escapeRegex(candidate);
      const headingPattern = new RegExp(`^(#{1,3})\\s*(?:(?:Section|Part|PART)\\s+)?(?:\\d+\\.?\\s*)?(?:[:\\-—–]\\s*)?${escaped}`, 'im');
      match = headingPattern.exec(output);
      if (match) { matchLevel = (match[1] || '##').length; break; }

      // 2. Substring match — candidate appears anywhere in a heading line
      const substringPattern = new RegExp(`^(#{1,3})\\s+.*${escaped}`, 'im');
      match = substringPattern.exec(output);
      if (match) { matchLevel = (match[1] || '##').length; break; }

      // 3. Fuzzy content match — the section's CONTENT exists even if heading name differs
      // Check if the output contains substantial text with the section's mustContain keywords
      if (section.mustContain && section.mustContain.length > 0) {
        const outputLower = output.toLowerCase();
        const keywordHits = section.mustContain.filter(kw => outputLower.includes(kw.toLowerCase()));
        if (keywordHits.length === section.mustContain.length) {
          // All required keywords present — section content exists under a different heading
          match = { index: 0, 0: candidate } as unknown as RegExpExecArray;
          matchLevel = 2;
          break;
        }
      }

      // 4. Bold heading match
      const boldPattern = new RegExp(`^\\*\\*(?:(?:Section|Part)\\s+)?(?:\\d+\\.?\\s*)?(?:[:\\-—–]\\s*)?${escaped}`, 'im');
      match = boldPattern.exec(output);
      if (match) { matchLevel = 2; break; }
    }

    // 5. Last resort: check if section keyword appears as a word in ANY heading
    if (!match) {
      const mainKeyword = section.heading.split(/\s+/)[0]; // first word: "Business", "Workflows", etc.
      if (mainKeyword.length > 4) {
        const keywordInHeading = new RegExp(`^(#{1,3})\\s+.*\\b${escapeRegex(mainKeyword)}\\b`, 'im');
        match = keywordInHeading.exec(output);
        if (match) matchLevel = (match[1] || '##').length;
      }
    }

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

    // Extract section content until next heading of SAME or higher level (fewer or equal '#')
    // This ensures sub-headings (###) are included in the parent (##) section body
    const sectionStart = match.index + match[0].length;
    const sameLevelPattern = new RegExp(`^#{1,${matchLevel}}\\s`, 'm');
    const nextHeading = output.slice(sectionStart).search(sameLevelPattern);
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

  // 5. FORGE-specific: dynamic BR coverage check against prior stage output
  if (stageName === PipelineStageName.FORGE) {
    // Extract all unique BR-{ids} referenced in FORGE output
    const brInCode = new Set(
      (output.match(/BR-\d+/g) || []).map(m => m.toUpperCase()),
    );
    const fileCount = (output.match(/(?:###\s*FILE:|\/\/\s*(?:File|Path):|#\s*File:)\s*.+/g) || []).length;
    const testCount = (output.match(/(?:describe|it|test|def test_|func Test|@Test|\[Fact\]|Scenario|@pytest)/g) || []).length;

    // Coverage score: weighted combination of BR references, file count, and test count
    const brCount = brInCode.size;
    const brCoverage = Math.min(100, Math.round((brCount / Math.max(brCount, 10)) * 100));
    const fileCoverage = Math.min(100, Math.round((fileCount / 20) * 100)); // 20 files = 100%
    const testCoverage = Math.min(100, Math.round((testCount / 10) * 100)); // 10 tests = 100%

    // Weighted: 40% BR, 30% files, 30% tests
    const forgeCoverage = Math.round(brCoverage * 0.4 + fileCoverage * 0.3 + testCoverage * 0.3);

    if (forgeCoverage < 70) {
      violations.push({
        type: 'missing_pattern',
        severity: 'critical',
        description: `FORGE coverage ${forgeCoverage}% is below 70% minimum (${brCount} BRs, ${fileCount} files, ${testCount} tests). Need more business rule implementations, files, or tests.`,
        actual: forgeCoverage,
        expected: 70,
      });
    } else {
      passedChecks++;
    }
  }

  // 6. Agent-based section validation — upgrade deterministic results when LLM available
  const sectionViolationCount = violations.filter(v => v.type === 'missing_section').length;
  if (llmFn && sectionViolationCount > 0) {
    try {
      const agentResult = await validateSectionsWithAgent(stageName, output, llmFn, projectOverride);
      if (agentResult.sectionResults.length > 0) {
        // Remove deterministic section violations, replace with agent findings
        const nonSectionViolations = violations.filter(v => v.type !== 'missing_section' && v.type !== 'thin_section');
        const agentViolations: ContractViolation[] = [];

        for (const r of agentResult.sectionResults) {
          if (!r.found) {
            agentViolations.push({
              type: 'missing_section',
              severity: 'critical',
              description: `Missing required section: "${r.heading}" — ${r.reasoning}`,
              section: r.heading,
            });
          } else if (r.quality === 'thin') {
            agentViolations.push({
              type: 'thin_section',
              severity: 'major',
              description: `Section "${r.heading}" is thin (${r.wordCount ?? 0} words) — ${r.reasoning}`,
              section: r.heading,
              actual: r.wordCount,
              expected: 100,
            });
          } else {
            passedChecks++; // Agent confirmed section exists with good quality
          }
        }

        // Replace violations with agent results
        violations.length = 0;
        violations.push(...nonSectionViolations, ...agentViolations);
      }
    } catch {
      // Agent validation failed — keep deterministic results
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

// ─── AGENT-BASED SECTION VALIDATOR ─────────────────────────────

/**
 * LLM-based section validation — replaces brittle regex matching.
 * An agent reviews the output and determines which required sections
 * are present, regardless of heading format or naming conventions.
 *
 * Call this AFTER enforceContract() to upgrade section checks from
 * regex-based to semantic understanding.
 */

/**
 * Build a condensed preview of a large output that preserves ALL headings
 * with a preview of each section's content. This ensures the validation
 * agent sees the complete document structure even for 50K+ outputs.
 */
function buildSectionPreview(output: string, budget: number): string {
  const lines = output.split('\n');
  const sections: Array<{ heading: string; startLine: number; content: string }> = [];
  let currentHeading = '(preamble)';
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i])) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, startLine: i - currentLines.length, content: currentLines.join('\n') });
      }
      currentHeading = lines[i];
      currentLines = [];
    } else {
      currentLines.push(lines[i]);
    }
  }
  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, startLine: lines.length - currentLines.length, content: currentLines.join('\n') });
  }

  // Build preview: full heading + first N chars of content per section
  const perSectionBudget = Math.max(300, Math.floor(budget / Math.max(sections.length, 1)));
  const parts: string[] = [];
  let totalLen = 0;

  for (const section of sections) {
    const preview = section.content.length > perSectionBudget
      ? section.content.slice(0, perSectionBudget) + '\n[... section continues ...]'
      : section.content;
    const block = section.heading + '\n' + preview;
    if (totalLen + block.length > budget) {
      parts.push(section.heading + '\n[... content present but omitted for brevity ...]');
      totalLen += section.heading.length + 50;
    } else {
      parts.push(block);
      totalLen += block.length;
    }
  }

  return parts.join('\n\n');
}

export async function validateSectionsWithAgent(
  stageName: PipelineStageName,
  output: string,
  llmFn: (req: { systemPrompt: string; userPrompt: string }) => Promise<string>,
  projectOverride?: Partial<StageContract>,
): Promise<{ sectionResults: Array<{ heading: string; found: boolean; quality: 'good' | 'thin' | 'missing'; matchedHeading?: string; wordCount?: number; reasoning: string }>; score: number }> {
  const defaultContract = stageContracts.find((c) => c.stageName === stageName);
  if (!defaultContract) return { sectionResults: [], score: 100 };

  const contract = projectOverride
    ? { ...defaultContract, requiredSections: projectOverride.requiredSections ?? defaultContract.requiredSections }
    : defaultContract;

  const sectionList = contract.requiredSections
    .map((s, i) => {
      const aliasText = s.aliases?.length ? ` (also acceptable: ${s.aliases.join(', ')})` : '';
      return `${i + 1}. "${s.heading}"${aliasText} (required: ${s.required}, min words: ${s.minWordCount ?? 'none'}${s.mustContain ? `, must contain: ${s.mustContain.join(', ')}` : ''})`;
    })
    .join('\n');

  // For validation, send output headings + section previews instead of truncating mid-content.
  // This ensures the agent sees ALL sections even in large outputs.
  const outputForAgent = output.length > 25000
    ? buildSectionPreview(output, 25000)
    : output;

  const prompt = `You are a validation agent. Review this ${stageName} stage output and determine which required sections are present.

## REQUIRED SECTIONS
${sectionList}

## STAGE OUTPUT TO VALIDATE
${outputForAgent}

## INSTRUCTIONS
For each required section, determine:
1. Is the content present? (The heading name may differ — look for the CONTENT, not exact heading text)
2. What heading does it appear under? (The actual heading used in the output)
3. Quality: "good" (substantial content), "thin" (exists but minimal), or "missing"
4. Approximate word count of that section
5. Brief reasoning

Respond with ONLY valid JSON:
{
  "sections": [
    {
      "required_heading": "Business Rules",
      "found": true,
      "quality": "good",
      "matched_heading": "Section 1: Business Rules Catalog (242+ Rules)",
      "word_count": 2500,
      "reasoning": "Comprehensive business rules inventory with 242 rules cataloged in tables"
    }
  ]
}`;

  try {
    const raw = await llmFn({
      systemPrompt: 'You are a validation agent. Output ONLY valid JSON. No explanation.',
      userPrompt: prompt,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { sectionResults: [], score: 0 };

    const parsed = JSON.parse(jsonMatch[0]);
    const sections = parsed.sections || [];

    const results = contract.requiredSections.map((req) => {
      const agentResult = sections.find((s: any) =>
        s.required_heading?.toLowerCase() === req.heading.toLowerCase() ||
        req.aliases?.some(a => s.required_heading?.toLowerCase() === a.toLowerCase()),
      );

      return {
        heading: req.heading,
        found: agentResult?.found ?? false,
        quality: (agentResult?.quality ?? 'missing') as 'good' | 'thin' | 'missing',
        matchedHeading: agentResult?.matched_heading,
        wordCount: agentResult?.word_count,
        reasoning: agentResult?.reasoning ?? 'Not evaluated by agent',
      };
    });

    const foundCount = results.filter(r => r.found).length;
    const score = Math.round((foundCount / results.length) * 100);

    return { sectionResults: results, score };
  } catch {
    // Agent validation failed — return empty (caller falls back to deterministic)
    return { sectionResults: [], score: 0 };
  }
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
  | 'constraints-debt-analysis'
  | 'security-auth-analysis'
  | 'batch-job-analysis'
  | 'ui-frontend-analysis'
  | 'event-driven-analysis';

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

const DECODE_SUBTASK_CONTRACTS: SubtaskContract[] = [
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
