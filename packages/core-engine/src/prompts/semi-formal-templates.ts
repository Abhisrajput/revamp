/**
 * Semi-Formal Reasoning Templates
 *
 * Based on "Semi-Formal Reasoning" (2025): structured certificate templates
 * that force LLMs to document explicit evidence before conclusions. This
 * prevents unsupported claims and improves accuracy by 5-12pp on code
 * verification tasks.
 *
 * Applied to three REVAMP pipeline contexts:
 *   1. Behavioral equivalence verification (SHADOW_RUN / Stage 6)
 *   2. Code review certificates (reviewer agent)
 *   3. Stage output evaluation (validation LLM eval)
 *
 * Key mechanism: structure forces interprocedural reasoning — the LLM must
 * actually trace function calls rather than guess their behavior.
 */

// ─── BEHAVIORAL EQUIVALENCE VERIFICATION ────────────────────────
//
// Used in SHADOW_RUN (Stage 6) when running AI-based parallel verification
// instead of actual test execution. Forces per-scenario execution tracing
// for both legacy and modernized code.

export interface BehaviorEquivalenceInput {
  scenarioName: string;
  scenarioGherkin: string;
  legacyCodeSnippet: string;
  modernizedCodeSnippet: string;
  contextNotes?: string;
}

/**
 * Build a semi-formal prompt for verifying behavioral equivalence between
 * legacy and modernized code for a single BDD scenario.
 *
 * This is the REVAMP-specific adaptation of the paper's patch equivalence
 * verification certificate — the task where semi-formal reasoning achieved
 * 93% accuracy.
 */
export function buildBehaviorEquivalenceCertificate(
  input: BehaviorEquivalenceInput,
): string {
  return [
    '═══════════════════════════════════════════════════',
    '  BEHAVIORAL EQUIVALENCE VERIFICATION CERTIFICATE',
    '═══════════════════════════════════════════════════',
    '',
    'You are verifying whether legacy and modernized code produce identical',
    'behavior for a specific BDD scenario. Follow the protocol EXACTLY.',
    '',
    '## SECTION 1: SCENARIO PREMISES',
    'Parse the BDD scenario and list every observable behavior it tests:',
    '  P1: <Given precondition>',
    '  P2: <When action>',
    '  P3: <Then expected outcome>',
    '  P4: <And additional outcomes>',
    'Be precise — include data types, error conditions, and side effects.',
    '',
    '## SECTION 2: LEGACY EXECUTION TRACE',
    'For the legacy code, trace the execution path for this scenario:',
    '  Step 1: Entry point → which function/method is called',
    '  Step 2: What data transformations occur (trace variable mutations)',
    '  Step 3: What external calls are made (DB, API, file I/O)',
    '  Step 4: What is the return value / side effect / output',
    'IMPORTANT: Do NOT assume function behavior — trace through the actual',
    'implementation. If a function is called, read its definition.',
    '',
    '## SECTION 3: MODERNIZED EXECUTION TRACE',
    'Repeat the same trace for the modernized code:',
    '  Step 1: Entry point',
    '  Step 2: Data transformations',
    '  Step 3: External calls',
    '  Step 4: Return value / side effect / output',
    '',
    '## SECTION 4: COMPARISON MATRIX',
    'For each premise, compare legacy vs modernized behavior:',
    '  P1: Legacy=[trace result] | Modern=[trace result] | MATCH/DEVIATION',
    '  P2: Legacy=[trace result] | Modern=[trace result] | MATCH/DEVIATION',
    '  P3: Legacy=[trace result] | Modern=[trace result] | MATCH/DEVIATION',
    '',
    '## SECTION 5: EDGE CASE ANALYSIS',
    'Identify 2-3 edge cases not covered by the scenario and trace both:',
    '  - Null/empty input handling',
    '  - Error path behavior',
    '  - Boundary conditions (max values, concurrent access)',
    '',
    '## SECTION 6: VERDICT',
    'Based ONLY on the traces documented above:',
    '{"equivalent": true|false, "confidence": 0.0-1.0, "deviations": ["specific deviation with trace refs"], "risk_level": "none|low|medium|high"}',
    '',
    '═══ SCENARIO ═══',
    `Name: ${input.scenarioName}`,
    input.scenarioGherkin,
    '',
    '═══ LEGACY CODE ═══',
    input.legacyCodeSnippet,
    '',
    '═══ MODERNIZED CODE ═══',
    input.modernizedCodeSnippet,
    input.contextNotes ? `\n═══ CONTEXT ═══\n${input.contextNotes}` : '',
  ].join('\n');
}

/**
 * System prompt for the behavioral equivalence verifier.
 */
export const BEHAVIOR_EQUIVALENCE_SYSTEM_PROMPT = [
  'You are a behavioral equivalence verifier using semi-formal reasoning.',
  'You MUST complete all 6 certificate sections before rendering a verdict.',
  'CRITICAL: Do NOT assume function behavior — trace through actual implementations.',
  'Your final line must be the JSON verdict and nothing else.',
].join(' ');

// ─── BATCH VERIFICATION ─────────────────────────────────────────

/**
 * Build a batch verification prompt for multiple scenarios against the
 * same legacy/modernized codebase pair. More token-efficient than
 * individual certificates when verifying 5+ scenarios.
 */
export function buildBatchEquivalenceCertificate(
  scenarios: Array<{ name: string; gherkin: string }>,
  legacyCode: string,
  modernizedCode: string,
): string {
  return [
    '═══════════════════════════════════════════════════',
    '  BATCH BEHAVIORAL EQUIVALENCE CERTIFICATE',
    '═══════════════════════════════════════════════════',
    '',
    'Verify behavioral equivalence for ALL scenarios below.',
    'For each scenario, follow this abbreviated protocol:',
    '',
    '## PER-SCENARIO PROTOCOL',
    '1. PREMISES: List the observable behaviors tested',
    '2. TRACE: Key execution path difference (if any) between legacy and modern',
    '3. VERDICT: EQUIVALENT / DEVIATION / UNCERTAIN',
    '',
    '## FINAL SUMMARY',
    'After all scenarios, provide:',
    '{"total_scenarios": N, "equivalent": N, "deviations": N, "uncertain": N,',
    ' "critical_deviations": ["scenario name: description"],',
    ' "overall_verdict": "PROCEED|REMEDIATE|BLOCK",',
    ' "confidence": 0.0-1.0}',
    '',
    '═══ SCENARIOS ═══',
    ...scenarios.map((s, i) =>
      `\n--- Scenario ${i + 1}: ${s.name} ---\n${s.gherkin}`
    ),
    '',
    '═══ LEGACY CODE ═══',
    legacyCode,
    '',
    '═══ MODERNIZED CODE ═══',
    modernizedCode,
  ].join('\n');
}

// ─── FAULT LOCALIZATION ─────────────────────────────────────────
//
// Used when a stage output fails validation — helps trace WHY it failed
// back to the specific generation step that went wrong.

/**
 * Build a semi-formal fault localization prompt for debugging failed
 * stage outputs. Forces hypothesis-driven investigation instead of
 * guessing.
 */
export function buildFaultLocalizationCertificate(
  stageName: string,
  stageOutput: string,
  validationIssues: string[],
  originalPrompt: string,
): string {
  return [
    '═══════════════════════════════════════════════════',
    '  FAULT LOCALIZATION CERTIFICATE',
    '═══════════════════════════════════════════════════',
    '',
    `Stage: ${stageName}`,
    `Validation issues found: ${validationIssues.length}`,
    '',
    '## SECTION 1: ISSUE INVENTORY',
    ...validationIssues.map((issue, i) => `  F${i + 1}: ${issue}`),
    '',
    '## SECTION 2: HYPOTHESIS FORMATION',
    'For each issue, form a hypothesis about the root cause:',
    '  F1 hypothesis: <why this issue likely occurred>',
    'Consider: missing context, ambiguous prompt, model hallucination,',
    'context window overflow, wrong model for task.',
    '',
    '## SECTION 3: EVIDENCE GATHERING',
    'For each hypothesis, document supporting/refuting evidence:',
    '  F1: [SUPPORTED|REFUTED] — <evidence from output or prompt>',
    '',
    '## SECTION 4: ROOT CAUSE RANKING',
    'Rank the most likely root causes by confidence:',
    '  1. <root cause> (confidence: high/medium/low)',
    '',
    '## SECTION 5: REMEDIATION',
    'For each root cause, specify the targeted fix:',
    '{"root_causes": [{"issue": "F1", "cause": "...", "fix": "..."}],',
    ' "prompt_adjustments": ["specific prompt change"],',
    ' "should_retry": true|false}',
    '',
    '═══ ORIGINAL PROMPT (excerpt) ═══',
    originalPrompt.slice(0, 2000),
    '',
    '═══ FAILED OUTPUT ═══',
    stageOutput.slice(0, 6000),
  ].join('\n');
}

export const FAULT_LOCALIZATION_SYSTEM_PROMPT = [
  'You are a fault localization agent using semi-formal reasoning.',
  'You MUST complete all 5 certificate sections with documented evidence',
  'before recommending a fix. Do not guess — trace evidence.',
].join(' ');
