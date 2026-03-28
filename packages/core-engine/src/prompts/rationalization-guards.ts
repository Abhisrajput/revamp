/**
 * Anti-Rationalization Guards — prevents AI agents from skipping critical steps.
 *
 * Inspired by obra/superpowers' anti-rationalization engineering pattern.
 * Each guard is a block of text injected into agent prompts to close common
 * evasion loopholes observed in legacy modernization workflows.
 *
 * Guards are stage-specific: SCAN agents get different guards than FORGE agents.
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';

export interface RationalizationGuard {
  /** The stage(s) this guard applies to. '*' means all stages. */
  stages: PipelineStageName[] | '*';
  /** Short identifier for logging/debugging */
  id: string;
  /** The guard text injected into the agent's prompt */
  prompt: string;
}

// ─── UNIVERSAL GUARDS (all stages) ─────────────────────────────

const UNIVERSAL_GUARDS: RationalizationGuard[] = [
  {
    stages: '*',
    id: 'no-skip-validation',
    prompt: `## MANDATORY: Validation Is Not Optional

You MUST NOT skip, abbreviate, or mark as "unnecessary" any required section in the stage contract.
If you find yourself thinking any of these, STOP and follow the contract:
- "This section is obvious and doesn't need detail" → WRONG. Write it anyway.
- "The output is good enough without this section" → WRONG. The contract defines "good enough".
- "I'll mention it briefly in another section instead" → WRONG. Each section must stand alone.
- "Time is limited, so I'll skip the less important parts" → WRONG. Every required section is important.

Violating the letter of the contract IS violating the spirit. There are no shortcuts.`,
  },
  {
    stages: '*',
    id: 'evidence-required',
    prompt: `## MANDATORY: Evidence Over Claims

Every factual statement must include concrete evidence:
- File paths with line numbers (e.g., \`src/main/CUST001.cbl:245\`)
- Code snippets showing the actual pattern
- Specific counts (e.g., "47 files", not "many files")

RED FLAGS — if you catch yourself writing any of these, replace with evidence:
- "Appears to be..." → Find the actual code and cite it
- "Likely uses..." → Search the codebase and confirm
- "Standard pattern for..." → Show the specific instance
- "Several components..." → Count them and list them`,
  },
];

// ─── SCAN-SPECIFIC GUARDS ──────────────────────────────────────

const SCAN_GUARDS: RationalizationGuard[] = [
  {
    stages: [PipelineStageName.SCAN],
    id: 'no-premature-modernization',
    prompt: `## GUARD: Do Not Prescribe Solutions During Analysis

Your job in SCAN is to UNDERSTAND the codebase, not to MODERNIZE it.
If you find yourself writing transformation recommendations, service decomposition
plans, or target architecture suggestions — STOP. That belongs in later stages.

Common evasions to watch for:
- "This module should be extracted into a microservice" → Just describe the module
- "This pattern should be replaced with..." → Just document the existing pattern
- "The recommended approach would be..." → Save it for ARCHITECT stage`,
  },
  {
    stages: [PipelineStageName.SCAN],
    id: 'no-dead-code-assumptions',
    prompt: `## GUARD: Do Not Assume Dead Code

Never classify code as "dead" or "unused" without evidence from the call graph.
Legacy codebases frequently have:
- Batch jobs invoked by external schedulers (not visible in the codebase)
- COPY/INCLUDE members referenced by programs outside the scanned scope
- Dynamic dispatch via string-based program names (CALL variable)
- Conditional compilation that activates code only in certain environments

If you cannot trace all callers, mark as "usage uncertain" — never "dead code".`,
  },
];

// ─── DECODE-SPECIFIC GUARDS ────────────────────────────────────

const DECODE_GUARDS: RationalizationGuard[] = [
  {
    stages: [PipelineStageName.DECODE],
    id: 'no-implicit-rules',
    prompt: `## GUARD: Make Every Business Rule Explicit

Legacy code embeds business rules in conditions, PERFORM loops, EVALUATE statements,
and data validation blocks. You MUST extract each rule with:
1. A unique Rule ID (e.g., BR-AR-001)
2. The source file and line number
3. The exact code snippet implementing the rule
4. A plain-English description of what the rule enforces
5. Edge cases and boundary conditions

Common evasions to watch for:
- "Standard validation logic" → WRONG. What does it validate? What are the thresholds?
- "Business rules are embedded in the workflow" → Extract each one separately
- "The logic is straightforward" → Still document it. "Straightforward" is subjective.`,
  },
  {
    stages: [PipelineStageName.DECODE],
    id: 'no-skipping-data-flows',
    prompt: `## GUARD: Trace All Data Flows End-to-End

Every data entity must be traced from source to sink:
- Where is it created? (user input, batch file, API call, database read)
- Where is it transformed? (calculations, enrichment, format conversion)
- Where is it stored? (database write, file output, API response)
- What validates it at each step?

Do NOT write "data flows through the system" without specifics.`,
  },
];

// ─── SPEC_LOCK-SPECIFIC GUARDS ─────────────────────────────────

const SPEC_LOCK_GUARDS: RationalizationGuard[] = [
  {
    stages: [PipelineStageName.SPEC_LOCK],
    id: 'no-happy-path-only',
    prompt: `## GUARD: BDD Specs Must Cover Edge Cases

Every Scenario must have corresponding edge case scenarios:
- Boundary values (minimum, maximum, zero, negative, overflow)
- Invalid inputs (wrong type, missing required fields, malformed data)
- Concurrency (what happens if two processes run simultaneously?)
- Error recovery (what happens after a partial failure?)

If you only have "happy path" scenarios, your spec is INCOMPLETE.
A modernized service that only handles happy paths will fail in production.`,
  },
];

// ─── FORGE-SPECIFIC GUARDS ─────────────────────────────────────

const FORGE_GUARDS: RationalizationGuard[] = [
  {
    stages: [PipelineStageName.FORGE],
    id: 'no-naive-translation',
    prompt: `## GUARD: Modernize, Don't Translate Line-by-Line

Line-by-line translation produces code that is technically modern but architecturally legacy.
Every transformation must:
1. Respect the target platform's idioms (e.g., Spring Boot conventions, not COBOL-in-Java)
2. Use the target language's type system (no untyped maps where domain types should exist)
3. Handle errors using the target platform's patterns (not COBOL-style status codes)
4. Implement proper separation of concerns (not monolithic procedure-to-method mapping)

If the modernized code "looks like COBOL written in Java" — start over with the right idioms.`,
  },
  {
    stages: [PipelineStageName.FORGE],
    id: 'tests-before-code',
    prompt: `## GUARD: Tests Are Not Optional

You MUST produce test code for every transformation:
- Unit tests for individual business rules
- Integration tests for data flows
- Contract tests for API boundaries

If you find yourself thinking "the tests are obvious" or "I'll add tests later" — STOP.
No production code without corresponding test code. Period.`,
  },
];

// ─── SHADOW_RUN-SPECIFIC GUARDS ────────────────────────────────

const SHADOW_RUN_GUARDS: RationalizationGuard[] = [
  {
    stages: [PipelineStageName.SHADOW_RUN],
    id: 'no-false-equivalence',
    prompt: `## GUARD: Behavioral Equivalence Must Be Proven, Not Claimed

"The outputs match" is not sufficient. You must show:
1. Test case ID and description
2. Input data used
3. Expected output (from legacy system)
4. Actual output (from modernized system)
5. PASS/FAIL verdict with diff if different

Partial matches are DEVIATIONS, not passes. Document every deviation with:
- Root cause analysis
- Impact assessment (critical/acceptable/cosmetic)
- Whether it requires a fix before cutover`,
  },
];

// ─── ALL GUARDS ────────────────────────────────────────────────

export const ALL_RATIONALIZATION_GUARDS: RationalizationGuard[] = [
  ...UNIVERSAL_GUARDS,
  ...SCAN_GUARDS,
  ...DECODE_GUARDS,
  ...SPEC_LOCK_GUARDS,
  ...FORGE_GUARDS,
  ...SHADOW_RUN_GUARDS,
];

/**
 * Get rationalization guards applicable to a specific stage.
 * Returns the combined text of all matching guards, ready for prompt injection.
 */
export function getRationalizationGuards(stageName: PipelineStageName): string {
  const applicable = ALL_RATIONALIZATION_GUARDS.filter(
    (g) => g.stages === '*' || g.stages.includes(stageName),
  );

  if (applicable.length === 0) return '';

  return [
    '# ═══ ANTI-RATIONALIZATION GUARDS ═══',
    '# These guards are non-negotiable. Do not rationalize your way around them.',
    '',
    ...applicable.map((g) => g.prompt),
  ].join('\n\n');
}

/**
 * Get a specific guard by ID.
 */
export function getGuard(id: string): RationalizationGuard | undefined {
  return ALL_RATIONALIZATION_GUARDS.find((g) => g.id === id);
}
