/**
 * Two-Stage Review Service — independent verification of subtask outputs.
 *
 * Implements the two-stage review pattern from obra/superpowers:
 *   1. Behavioral Equivalence Review — "Does the output preserve the original behavior?"
 *   2. Quality Review — "Is the output well-structured and actionable?"
 *
 * Key design principle: "CRITICAL: Do Not Trust the Report" — the reviewer
 * independently verifies claims rather than summarizing what the report says.
 *
 * The review is lightweight (Haiku/Flash models) and returns a structured
 * verdict that the orchestrator can use to decide whether to accept, refine,
 * or reject the subtask output.
 */

import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { llmProxyService } from "./llm-proxy.js";

// ─── TYPES ──────────────────────────────────────────────────────

export type ReviewVerdict = "PASS" | "PASS_WITH_CONCERNS" | "NEEDS_REVISION" | "REJECT";

export interface ReviewDimension {
  name: string;
  score: number; // 0.0 - 1.0
  verdict: ReviewVerdict;
  evidence: string;
  concerns: string[];
}

export interface ReviewResult {
  stage: "behavioral_equivalence" | "quality";
  overallVerdict: ReviewVerdict;
  overallScore: number;
  dimensions: ReviewDimension[];
  summary: string;
  revisionPrompt: string | null; // non-null when verdict is NEEDS_REVISION
}

export interface TwoStageReviewResult {
  behavioralReview: ReviewResult;
  qualityReview: ReviewResult;
  combinedVerdict: ReviewVerdict;
  combinedScore: number;
  shouldRefine: boolean;
  refinementPrompt: string | null;
}

export interface ReviewContext {
  pipelineRunId: string;
  stageName: PipelineStageName;
  subtaskType: string;
  output: string;
  /** Original source code or prior stage output for behavioral comparison */
  referenceInput?: string;
  /** BDD specs or business rules to verify against */
  specs?: string;
  /** Model to use for review (defaults to cheap/fast) */
  model?: string;
  /** BYOK credentials from project settings */
  credentials?: import("./llm-proxy.js").ProjectCredentials;
}

// ─── REVIEW PROMPTS ─────────────────────────────────────────────

function buildBehavioralEquivalencePrompt(ctx: ReviewContext): string {
  const parts = [
    "## BEHAVIORAL EQUIVALENCE REVIEW",
    "",
    "CRITICAL: Do NOT trust the report. Independently verify each claim.",
    "",
    `You are reviewing the output of a ${ctx.subtaskType} subtask in the ${ctx.stageName} stage.`,
    "Your job is to verify that the output faithfully represents the source material.",
    "",
    "### Review Dimensions",
    "",
    "For each dimension, cite SPECIFIC evidence from both the source and the output.",
    "If the output claims something, verify it against the source.",
    "",
    "1. **Completeness** — Does the output cover all elements present in the source?",
    "   Look for: missing components, omitted edge cases, dropped data flows",
    "",
    "2. **Accuracy** — Are the claims in the output factually correct?",
    "   Look for: hallucinated file names, wrong technology versions, misattributed patterns",
    "",
    "3. **Traceability** — Can each claim be traced back to the source?",
    "   Look for: unsupported conclusions, vague references, invented details",
    "",
  ];

  if (ctx.referenceInput) {
    parts.push(
      "### Source Material (Reference)",
      "```",
      ctx.referenceInput.slice(0, 24000),
      "```",
      "",
    );
  }

  if (ctx.specs) {
    parts.push(
      "### Behavioral Specifications",
      "```",
      ctx.specs.slice(0, 12000),
      "```",
      "",
    );
  }

  parts.push(
    "### Output to Review",
    "```",
    ctx.output.slice(0, 48000),
    "```",
    "",
    "### Required Response Format (JSON)",
    "```json",
    "{",
    '  "dimensions": [',
    '    { "name": "completeness", "score": 0.0-1.0, "verdict": "PASS|PASS_WITH_CONCERNS|NEEDS_REVISION|REJECT", "evidence": "...", "concerns": ["..."] },',
    '    { "name": "accuracy", "score": 0.0-1.0, "verdict": "...", "evidence": "...", "concerns": ["..."] },',
    '    { "name": "traceability", "score": 0.0-1.0, "verdict": "...", "evidence": "...", "concerns": ["..."] }',
    "  ],",
    '  "overallScore": 0.0-1.0,',
    '  "overallVerdict": "PASS|PASS_WITH_CONCERNS|NEEDS_REVISION|REJECT",',
    '  "summary": "2-3 sentence summary",',
    '  "revisionPrompt": "specific instructions for fixing issues, or null"',
    "}",
    "```",
  );

  return parts.join("\n");
}

function buildQualityReviewPrompt(ctx: ReviewContext): string {
  return [
    "## QUALITY REVIEW",
    "",
    "CRITICAL: Do NOT trust the report. Evaluate the output independently.",
    "",
    `You are reviewing the quality of a ${ctx.subtaskType} subtask output in the ${ctx.stageName} stage.`,
    "Your job is to assess whether this output is production-ready and actionable.",
    "",
    "### Review Dimensions",
    "",
    "1. **Actionability** — Could a development team implement from this output?",
    "   Look for: vague recommendations, missing specifics, unclear next steps",
    "",
    "2. **Structure** — Is the output well-organized and logically coherent?",
    "   Look for: missing sections, poor flow, redundant content, inconsistent depth",
    "",
    "3. **Technical Depth** — Is the analysis sufficiently detailed?",
    "   Look for: surface-level observations, missing trade-off analysis, unsupported choices",
    "",
    "### Output to Review",
    "```",
    ctx.output.slice(0, 48000),
    "```",
    "",
    "### Required Response Format (JSON)",
    "```json",
    "{",
    '  "dimensions": [',
    '    { "name": "actionability", "score": 0.0-1.0, "verdict": "PASS|PASS_WITH_CONCERNS|NEEDS_REVISION|REJECT", "evidence": "...", "concerns": ["..."] },',
    '    { "name": "structure", "score": 0.0-1.0, "verdict": "...", "evidence": "...", "concerns": ["..."] },',
    '    { "name": "technical_depth", "score": 0.0-1.0, "verdict": "...", "evidence": "...", "concerns": ["..."] }',
    "  ],",
    '  "overallScore": 0.0-1.0,',
    '  "overallVerdict": "PASS|PASS_WITH_CONCERNS|NEEDS_REVISION|REJECT",',
    '  "summary": "2-3 sentence summary",',
    '  "revisionPrompt": "specific instructions for fixing issues, or null"',
    "}",
    "```",
  ].join("\n");
}

// ─── REVIEW EXECUTION ───────────────────────────────────────────

/**
 * Run a single review stage (behavioral or quality).
 */
async function runReview(
  stage: "behavioral_equivalence" | "quality",
  ctx: ReviewContext,
): Promise<ReviewResult> {
  const reviewModel = ctx.model || pickReviewModel();
  const callFn = llmProxyService.createCallFn({
    maxTokens: 2048,
    model: reviewModel,
    credentials: ctx.credentials,
  });

  const prompt = stage === "behavioral_equivalence"
    ? buildBehavioralEquivalencePrompt(ctx)
    : buildQualityReviewPrompt(ctx);

  const raw = await callFn({
    systemPrompt: "You are an independent technical reviewer. Output ONLY valid JSON matching the required format.",
    userPrompt: prompt,
  });

  // Parse the JSON response
  const parsed = parseReviewResponse(raw);

  return {
    stage,
    overallVerdict: parsed.overallVerdict,
    overallScore: parsed.overallScore,
    dimensions: parsed.dimensions,
    summary: parsed.summary,
    revisionPrompt: parsed.revisionPrompt,
  };
}

/**
 * Run the full two-stage review: behavioral equivalence + quality.
 *
 * Returns a combined verdict and optional refinement prompt.
 * The combined score weights behavioral 60%, quality 40%.
 */
export async function runTwoStageReview(
  ctx: ReviewContext,
): Promise<TwoStageReviewResult> {
  // Run both reviews (sequentially to save memory on 8GB machine)
  const behavioralReview = await runReview("behavioral_equivalence", ctx);
  const qualityReview = await runReview("quality", ctx);

  // Weighted combination: behavioral accuracy matters more than style
  const combinedScore = behavioralReview.overallScore * 0.6 + qualityReview.overallScore * 0.4;

  // Combined verdict: worst of the two wins
  const verdictPriority: Record<ReviewVerdict, number> = {
    REJECT: 0,
    NEEDS_REVISION: 1,
    PASS_WITH_CONCERNS: 2,
    PASS: 3,
  };
  const combinedVerdict =
    verdictPriority[behavioralReview.overallVerdict] <= verdictPriority[qualityReview.overallVerdict]
      ? behavioralReview.overallVerdict
      : qualityReview.overallVerdict;

  const shouldRefine = combinedVerdict === "NEEDS_REVISION";

  // Merge refinement prompts
  let refinementPrompt: string | null = null;
  if (shouldRefine) {
    const parts: string[] = [];
    if (behavioralReview.revisionPrompt) {
      parts.push(`Behavioral issues:\n${behavioralReview.revisionPrompt}`);
    }
    if (qualityReview.revisionPrompt) {
      parts.push(`Quality issues:\n${qualityReview.revisionPrompt}`);
    }
    refinementPrompt = parts.join("\n\n") || null;
  }

  return {
    behavioralReview,
    qualityReview,
    combinedVerdict,
    combinedScore,
    shouldRefine,
    refinementPrompt,
  };
}

/**
 * Lightweight single-stage review for quick checks.
 * Runs only the quality review (faster, cheaper).
 */
export async function runQuickReview(
  ctx: ReviewContext,
): Promise<ReviewResult> {
  return runReview("quality", ctx);
}

// ─── PARSING ────────────────────────────────────────────────────

function parseReviewResponse(raw: string): {
  dimensions: ReviewDimension[];
  overallVerdict: ReviewVerdict;
  overallScore: number;
  summary: string;
  revisionPrompt: string | null;
} {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr);

    const validVerdicts = new Set(["PASS", "PASS_WITH_CONCERNS", "NEEDS_REVISION", "REJECT"]);

    const dimensions: ReviewDimension[] = (parsed.dimensions || []).map((d: any) => ({
      name: String(d.name || "unknown"),
      score: Math.max(0, Math.min(1, Number(d.score) || 0)),
      verdict: validVerdicts.has(d.verdict) ? d.verdict as ReviewVerdict : "PASS_WITH_CONCERNS",
      evidence: String(d.evidence || ""),
      concerns: Array.isArray(d.concerns) ? d.concerns.map(String) : [],
    }));

    return {
      dimensions,
      overallVerdict: validVerdicts.has(parsed.overallVerdict)
        ? parsed.overallVerdict as ReviewVerdict
        : "PASS_WITH_CONCERNS",
      overallScore: Math.max(0, Math.min(1, Number(parsed.overallScore) || 0.5)),
      summary: String(parsed.summary || "Review completed."),
      revisionPrompt: parsed.revisionPrompt ? String(parsed.revisionPrompt) : null,
    };
  } catch {
    // Parse failed — return conservative result
    return {
      dimensions: [],
      overallVerdict: "PASS_WITH_CONCERNS",
      overallScore: 0.5,
      summary: "Review response could not be parsed. Manual review recommended.",
      revisionPrompt: null,
    };
  }
}

// ─── HELPERS ────────────────────────────────────────────────────

function pickReviewModel(): string {
  // Use cheap/fast model for reviews
  return process.env.LLM_REVIEW_MODEL || process.env.LLM_EVALUATOR_MODEL || "haiku";
}
