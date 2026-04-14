/**
 * Prompt-Derived Validation — extracts validation criteria from the stage prompt itself.
 *
 * Instead of maintaining hardcoded rubrics/contracts per stage, this module:
 *   1. Parses the stage prompt to extract numbered requirements (e.g., "1. BUSINESS RULES — ...")
 *   2. Generates validation criteria dynamically from those requirements
 *   3. Checks the output against each extracted requirement
 *   4. Uses BREE ground-truth anchoring when available (file counts, languages, etc.)
 *   5. Uses the validation prompt as an LLM-as-Judge with structured scoring
 *
 * This eliminates rubric maintenance — the prompt IS the contract.
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';
import type { LLMEvalFn } from '../orchestration/validation-runner';

// ─── TYPES ──────────────────────────────────────────────────────

export interface ExtractedRequirement {
  index: number;
  label: string;        // e.g., "BUSINESS RULES"
  description: string;  // full text after the label
  keywords: string[];   // key terms extracted from the description
}

export interface RequirementCheck {
  requirement: ExtractedRequirement;
  found: boolean;
  matchedHeading: string | null;
  contentLength: number;  // word count in matched section
  keywordHits: number;    // how many keywords from the requirement appear
  keywordTotal: number;
  score: number;          // 0-1
}

export interface GroundTruthAnchor {
  type: 'file_count' | 'language' | 'line_count' | 'component';
  expected: string | number;
  actual: string | number | null;
  match: boolean;
}

export interface PromptDerivedResult {
  stageName: PipelineStageName;
  pipelineRunId: string;
  timestamp: string;

  // From prompt parsing
  requirementsExtracted: number;
  requirementChecks: RequirementCheck[];

  // From ground-truth anchoring
  groundTruthAnchors: GroundTruthAnchor[];
  groundTruthScore: number;  // 0-1

  // From LLM judge
  llmJudgeScore: number | null;  // 0-1, null if skipped
  llmJudgeFeedback: string | null;
  llmJudgeCriteria: Array<{ name: string; score: number; feedback: string }>;

  // Composite
  passed: boolean;
  confidenceScore: number;  // 0-100
  issues: Array<{ severity: 'error' | 'warn' | 'info'; message: string }>;
  recommendations: string[];

  // For refinement
  refinementPrompt: string | null;
}

// ─── PROMPT PARSING ─────────────────────────────────────────────

/**
 * Extract numbered requirements from a stage prompt.
 *
 * Matches patterns like:
 *   1. BUSINESS RULES — Every conditional...
 *   2. DATA FLOWS -- How data enters...
 *   - CAPABILITY HIERARCHY — Top-level domains...
 */
export function extractRequirementsFromPrompt(prompt: string): ExtractedRequirement[] {
  if (!prompt || prompt.trim().length === 0) return [];

  const requirements: ExtractedRequirement[] = [];
  let match;

  // Pattern 1: Numbered items — "1. LABEL — description" or "1. LABEL -- description"
  const numberedPattern = /(?:^|\n)\s*(\d+)\.\s+([A-Z][A-Z &/,()-]+?)(?:\s*[—–-]{1,2}\s*|\s*:\s*)([\s\S]*?)(?=\n\s*\d+\.\s+[A-Z]|\n\n[A-Z]|\n\s*(?:CRITICAL|DO NOT|IMPORTANT|Use |Generate |Produce |Include |Focus )|\n*$)/gm;

  while ((match = numberedPattern.exec(prompt)) !== null) {
    const index = parseInt(match[1], 10);
    const label = match[2].trim();
    const description = match[3].trim().replace(/\n\s+/g, ' ');
    const keywords = extractKeywordsFromDescription(description, label);
    requirements.push({ index, label, description, keywords });
  }

  // Pattern 2: Markdown headings with numbers — "### 1. Executive Summary" or "## 3. Architecture"
  if (requirements.length === 0) {
    const headingPattern = /(?:^|\n)#{2,4}\s*(\d+)\.\s+(.+?)(?:\s*\(.*?\))?\s*\n([\s\S]*?)(?=\n#{2,4}\s*\d+\.|## Output|## COMPOSITION|## YOUR TASK|\n*$)/gm;
    while ((match = headingPattern.exec(prompt)) !== null) {
      const index = parseInt(match[1], 10);
      const label = match[2].trim().replace(/\*+/g, '');
      const description = match[3].trim().replace(/\n\s+/g, ' ');
      const keywords = extractKeywordsFromDescription(description, label);
      requirements.push({ index, label, description, keywords });
    }
  }

  // Pattern 3: Unnumbered markdown headings — "## Executive Summary", "## Architecture"
  if (requirements.length === 0) {
    const unNumberedHeadingPattern = /(?:^|\n)#{2,4}\s+([A-Z][A-Za-z &/,()'-]+?)\s*\n([\s\S]*?)(?=\n#{2,4}\s+[A-Z]|## Output|## COMPOSITION|## YOUR TASK|## RULES|\n*$)/gm;
    let idx = 1;
    while ((match = unNumberedHeadingPattern.exec(prompt)) !== null) {
      const label = match[1].trim().replace(/\*+/g, '');
      const description = match[2].trim().replace(/\n\s+/g, ' ');
      const keywords = extractKeywordsFromDescription(description, label);
      requirements.push({ index: idx++, label, description, keywords });
    }
  }

  // Pattern 4: Bullet/dash items — "- **LABEL** — description"
  if (requirements.length === 0) {
    const bulletPattern = /(?:^|\n)\s*[-•*]\s+\*?\*?([A-Z][A-Z &/,()-]+?)\*?\*?\s*[—–:-]\s*([\s\S]*?)(?=\n\s*[-•*]\s+\*?\*?[A-Z]|\n\n|\n*$)/gm;
    let idx = 1;
    while ((match = bulletPattern.exec(prompt)) !== null) {
      const label = match[1].trim().replace(/\*+/g, '');
      const description = match[2].trim().replace(/\n\s+/g, ' ');
      const keywords = extractKeywordsFromDescription(description, label);
      requirements.push({ index: idx++, label, description, keywords });
    }
  }

  return requirements;
}

function extractKeywordsFromDescription(description: string, label: string): string[] {
  const keywords: string[] = [];

  // Add the label itself as keyword variations
  const labelWords = label.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  keywords.push(...labelWords);

  // Extract quoted terms
  const quoted = description.match(/"([^"]+)"|'([^']+)'/g);
  if (quoted) keywords.push(...quoted.map(q => q.replace(/['"]/g, '').toLowerCase()));

  // Extract technical terms (PascalCase, camelCase, UPPER_CASE, file.ext)
  const techTerms = description.match(/\b[A-Z][a-z]+[A-Z]\w*\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z_]{3,}\b|\b\w+\.\w{2,4}\b/g);
  if (techTerms) keywords.push(...techTerms.map(t => t.toLowerCase()));

  // Extract key nouns from description (words after "include", "with", "every", "all")
  const contextTerms = description.match(/(?:include|with|every|all|each)\s+(\w+(?:\s+\w+)?)/gi);
  if (contextTerms) keywords.push(...contextTerms.map(t => t.split(/\s+/).slice(1).join(' ').toLowerCase()));

  return [...new Set(keywords)].filter(k => k.length > 2);
}

// ─── OUTPUT CHECKING ────────────────────────────────────────────

/**
 * Check output against extracted requirements.
 */
function checkRequirements(
  output: string,
  requirements: ExtractedRequirement[],
): RequirementCheck[] {
  const outputLower = output.toLowerCase();

  // Extract all headings from the output (## or ### headings in markdown)
  const headings = [...output.matchAll(/^#{1,4}\s+(.+)$/gm)].map(m => m[1].trim());

  // Split output into sections by headings
  const sections = splitIntoSections(output);

  return requirements.map(req => {
    // Try to find a matching heading (fuzzy match)
    const matchedHeading = findBestHeadingMatch(req.label, headings);

    // Get content of matched section
    const sectionContent = matchedHeading
      ? (sections[matchedHeading] || '')
      : '';

    // Also search for the label (or its significant words) anywhere in the output
    const labelLower = req.label.toLowerCase();
    const significantWords = req.label.split(/\s+/).filter(w => w.length > 2).map(w => w.toLowerCase());
    const labelFound = outputLower.includes(labelLower) ||
      (significantWords.length > 0 && significantWords.every(word => outputLower.includes(word)));

    // Check keyword density even without a heading match — if most keywords are present,
    // the content exists somewhere in the output (just under a different heading).
    const keywordPresence = req.keywords.length > 0
      ? req.keywords.filter(kw => outputLower.includes(kw)).length / req.keywords.length
      : 0;
    const contentLikelyPresent = keywordPresence >= 0.6;

    const found = !!matchedHeading || labelFound || contentLikelyPresent;

    // Count words in the section
    const contentLength = sectionContent
      ? sectionContent.split(/\s+/).filter(w => w.length > 0).length
      : 0;

    // Check keyword coverage
    const keywordHits = req.keywords.filter(kw => outputLower.includes(kw)).length;
    const keywordTotal = req.keywords.length;

    // Compute score
    let score = 0;
    if (found) score += 0.4;                                          // heading/label found
    if (contentLength > 50) score += 0.2;                             // substantial content
    else if (contentLength > 20) score += 0.1;
    if (keywordTotal > 0) score += 0.4 * (keywordHits / keywordTotal); // keyword coverage

    return {
      requirement: req,
      found,
      matchedHeading,
      contentLength,
      keywordHits,
      keywordTotal,
      score: Math.min(1, score),
    };
  });
}

function splitIntoSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = text.split(/^(#{1,4}\s+.+)$/gm);

  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].replace(/^#+\s+/, '').trim();
    const content = parts[i + 1] || '';
    sections[heading] = content;
  }

  return sections;
}

function findBestHeadingMatch(label: string, headings: string[]): string | null {
  const labelLower = label.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const labelWords = labelLower.split(/\s+/).filter(w => w.length > 2);

  // Pass 1: Exact substring match (highest confidence)
  for (const heading of headings) {
    const headingLower = heading.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (headingLower.includes(labelLower) || labelLower.includes(headingLower)) {
      return heading;
    }
  }

  // Pass 2: All significant words present in heading (e.g. "DATA FLOWS" → "Data Flows")
  for (const heading of headings) {
    const headingLower = heading.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const headingWords = headingLower.split(/\s+/);
    const allPresent = labelWords.length > 0 && labelWords.every(w =>
      headingWords.some(hw => hw.includes(w) || w.includes(hw))
    );
    if (allPresent) return heading;
  }

  // Pass 3: Best partial overlap (threshold 60% of label words)
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const heading of headings) {
    const headingLower = heading.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const headingWords = headingLower.split(/\s+/);
    const overlap = labelWords.filter(w => headingWords.some(hw => hw.includes(w) || w.includes(hw))).length;
    const score = overlap / Math.max(labelWords.length, 1);

    if (score > bestScore && score >= 0.6) {
      bestScore = score;
      bestMatch = heading;
    }
  }

  return bestMatch;
}

// ─── GROUND-TRUTH ANCHORING ─────────────────────────────────────

export interface BreeGroundTruth {
  totalFiles?: number;
  totalLines?: number;
  languages?: Array<{ id: string; fileCount: number }>;
  components?: string[];
}

/**
 * Cross-reference LLM output claims against BREE static analysis results.
 */
function anchorToGroundTruth(
  output: string,
  groundTruth: BreeGroundTruth,
): GroundTruthAnchor[] {
  const anchors: GroundTruthAnchor[] = [];

  // Check file count claims
  if (groundTruth.totalFiles) {
    const fileCountMatch = output.match(/(\d+)\s*(?:total\s+)?files/i);
    if (fileCountMatch) {
      const claimed = parseInt(fileCountMatch[1], 10);
      anchors.push({
        type: 'file_count',
        expected: groundTruth.totalFiles,
        actual: claimed,
        match: Math.abs(claimed - groundTruth.totalFiles) <= 2, // allow small variance
      });
    }
  }

  // Check line count claims
  if (groundTruth.totalLines) {
    const lineMatch = output.match(/([\d,]+)\s*(?:total\s+)?(?:lines|LOC)/i);
    if (lineMatch) {
      const claimed = parseInt(lineMatch[1].replace(/,/g, ''), 10);
      const expected = groundTruth.totalLines;
      anchors.push({
        type: 'line_count',
        expected,
        actual: claimed,
        match: Math.abs(claimed - expected) / expected < 0.15, // 15% tolerance
      });
    }
  }

  // Check language claims
  if (groundTruth.languages) {
    for (const lang of groundTruth.languages) {
      const langName = lang.id.toLowerCase();
      const found = output.toLowerCase().includes(langName);
      anchors.push({
        type: 'language',
        expected: lang.id,
        actual: found ? lang.id : null,
        match: found,
      });
    }
  }

  return anchors;
}

// ─── LLM-AS-JUDGE ───────────────────────────────────────────────

/**
 * Use the stage's validation prompt as a structured LLM judge.
 * Returns per-criterion scores instead of a single pass/fail.
 */
export async function runLlmJudge(
  evalFn: LLMEvalFn,
  stagePrompt: string,
  validationPrompt: string,
  stageOutput: string,
  requirements: ExtractedRequirement[],
): Promise<{
  overallScore: number;
  feedback: string;
  criteria: Array<{ name: string; score: number; feedback: string }>;
}> {
  const reqList = requirements.map(r => `${r.index}. ${r.label}`).join('\n');

  const systemPrompt = `You are a strict quality reviewer. Evaluate the output against the original prompt's requirements.

Return ONLY valid JSON in this format:
{
  "overall_score": 0.0-1.0,
  "feedback": "brief overall assessment",
  "criteria": [
    {"name": "requirement name", "score": 0.0-1.0, "feedback": "specific feedback"}
  ]
}

Score guide: 1.0 = fully addressed with evidence, 0.7 = addressed but lacking detail, 0.4 = partially addressed, 0.0 = missing.`;

  const userPrompt = `## Validation Guidance
${validationPrompt}

## Requirements to Check
${reqList}

## Output to Evaluate (first 6000 chars)
${stageOutput.slice(0, 6000)}

Evaluate each requirement. Return JSON only.`;

  try {
    const response = await evalFn({ systemPrompt, userPrompt, responseFormat: 'json' });

    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { overallScore: 0, feedback: 'Judge response was not valid JSON', criteria: [] };
    }

    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    return {
      overallScore: Math.max(0, Math.min(1, parsed.overall_score ?? 0)),
      feedback: parsed.feedback || '',
      criteria: (parsed.criteria || []).map((c: any) => ({
        name: c.name || 'Unknown',
        score: Math.max(0, Math.min(1, c.score ?? 0)),
        feedback: c.feedback || '',
      })),
    };
  } catch {
    return { overallScore: 0, feedback: 'LLM judge call failed', criteria: [] };
  }
}

// ─── MAIN RUNNER ────────────────────────────────────────────────

export interface PromptDerivedValidationOptions {
  pipelineRunId: string;
  stageName: PipelineStageName;
  stageOutput: string;
  stagePrompt: string;          // the execution prompt — source of truth for requirements
  validationPrompt?: string;    // the validation guidance prompt for LLM judge
  llmEvalFn?: LLMEvalFn;
  skipLlmEval?: boolean;
  breeGroundTruth?: BreeGroundTruth;
}

export async function runPromptDerivedValidation(
  options: PromptDerivedValidationOptions,
): Promise<PromptDerivedResult> {
  const { pipelineRunId, stageName, stageOutput, stagePrompt } = options;

  // 1. Parse requirements from the stage prompt
  const requirements = extractRequirementsFromPrompt(stagePrompt);

  // 2. Check each requirement against the output
  const requirementChecks = checkRequirements(stageOutput, requirements);

  // 3. Ground-truth anchoring (if BREE data available)
  const groundTruthAnchors = options.breeGroundTruth
    ? anchorToGroundTruth(stageOutput, options.breeGroundTruth)
    : [];

  const groundTruthScore = groundTruthAnchors.length > 0
    ? groundTruthAnchors.filter(a => a.match).length / groundTruthAnchors.length
    : 0.5; // no ground truth = unverified, penalize slightly (not a free pass)

  // 4. LLM-as-Judge (if eval function available)
  let llmJudgeScore: number | null = null;
  let llmJudgeFeedback: string | null = null;
  let llmJudgeCriteria: Array<{ name: string; score: number; feedback: string }> = [];

  if (options.llmEvalFn && !options.skipLlmEval && options.validationPrompt && requirements.length > 0) {
    const judgeResult = await runLlmJudge(
      options.llmEvalFn,
      stagePrompt,
      options.validationPrompt,
      stageOutput,
      requirements,
    );
    llmJudgeScore = judgeResult.overallScore;
    llmJudgeFeedback = judgeResult.feedback;
    llmJudgeCriteria = judgeResult.criteria;
  }

  // 5. Compute composite score
  const reqScore = requirements.length > 0
    ? requirementChecks.reduce((sum, c) => sum + c.score, 0) / requirementChecks.length
    : 0.5;

  // Basic output quality checks
  const wordCount = stageOutput.split(/\s+/).filter(w => w.length > 0).length;
  const hasSubstance = wordCount > 200;
  const substanceScore = hasSubstance ? 1 : wordCount / 200;

  let confidenceScore: number;
  if (llmJudgeScore !== null) {
    // Full validation: requirements 30% + ground truth 15% + LLM judge 40% + substance 15%
    confidenceScore = Math.round(
      (reqScore * 0.30 + groundTruthScore * 0.15 + llmJudgeScore * 0.40 + substanceScore * 0.15) * 100,
    );
  } else {
    // No LLM judge: requirements 50% + ground truth 25% + substance 25%
    confidenceScore = Math.round(
      (reqScore * 0.50 + groundTruthScore * 0.25 + substanceScore * 0.25) * 100,
    );
  }

  // 6. Build issues
  const issues: Array<{ severity: 'error' | 'warn' | 'info'; message: string }> = [];

  const missingReqs = requirementChecks.filter(c => !c.found);
  const weakReqs = requirementChecks.filter(c => c.found && c.score < 0.5);

  for (const m of missingReqs) {
    issues.push({ severity: 'error', message: `Missing requirement: ${m.requirement.label}` });
  }
  for (const w of weakReqs) {
    issues.push({ severity: 'warn', message: `Weak coverage: ${w.requirement.label} (${Math.round(w.score * 100)}%)` });
  }
  for (const a of groundTruthAnchors.filter(a => !a.match)) {
    issues.push({ severity: 'warn', message: `Ground-truth mismatch: expected ${a.type}=${a.expected}, found ${a.actual}` });
  }
  if (!hasSubstance) {
    issues.push({ severity: 'error', message: `Output too short: ${wordCount} words (expected 200+)` });
  }

  // 7. Determine pass/fail
  const passed = confidenceScore >= 55 && missingReqs.length === 0;

  // 8. Build recommendations
  const recommendations: string[] = [];
  if (missingReqs.length > 0) {
    recommendations.push(`Add sections for: ${missingReqs.map(m => m.requirement.label).join(', ')}`);
  }
  if (weakReqs.length > 0) {
    recommendations.push(`Expand coverage in: ${weakReqs.map(w => w.requirement.label).join(', ')}`);
  }
  if (llmJudgeFeedback) {
    recommendations.push(llmJudgeFeedback);
  }

  // 9. Build refinement prompt if needed
  let refinementPrompt: string | null = null;
  if (!passed && (missingReqs.length > 0 || weakReqs.length > 0)) {
    const gaps = [
      ...missingReqs.map(m => `- MISSING: "${m.requirement.label}" — ${m.requirement.description.slice(0, 100)}`),
      ...weakReqs.map(w => `- WEAK: "${w.requirement.label}" — needs more detail and evidence (current: ${w.contentLength} words)`),
    ];
    refinementPrompt = `The output is missing or has weak coverage in these areas:\n\n${gaps.join('\n')}\n\nPlease add or expand these sections while keeping existing content intact.`;
  }

  return {
    stageName,
    pipelineRunId,
    timestamp: new Date().toISOString(),
    requirementsExtracted: requirements.length,
    requirementChecks,
    groundTruthAnchors,
    groundTruthScore,
    llmJudgeScore,
    llmJudgeFeedback,
    llmJudgeCriteria,
    passed,
    confidenceScore,
    issues,
    recommendations,
    refinementPrompt,
  };
}
