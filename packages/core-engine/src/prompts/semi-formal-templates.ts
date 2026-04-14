/**
 * Semi-Formal Reasoning Templates
 *
 * Based on "Semi-Formal Reasoning" (2025): structured certificate templates
 * that force LLMs to document explicit evidence before conclusions. This
 * prevents unsupported claims and improves accuracy by 5-12pp on code
 * verification tasks.
 *
 * Key mechanism: structure forces interprocedural reasoning — the LLM must
 * actually trace function calls rather than guess their behavior.
 */

// ─── FAULT LOCALIZATION ─────────────────────────────────────────

export const FAULT_LOCALIZATION_SYSTEM_PROMPT = [
  'You are a fault localization agent using semi-formal reasoning.',
  'You MUST complete all 5 certificate sections with documented evidence',
  'before recommending a fix. Do not guess — trace evidence.',
].join(' ');
