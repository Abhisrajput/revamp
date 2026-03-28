/**
 * 6-Category Memory Extraction Service — extracts structured memories
 * from pipeline stage outputs for cross-project learning.
 *
 * Inspired by OpenViking's memory_extractor.py with 6 categories:
 *   1. PROFILE    — What the codebase is (language, framework, domain, age)
 *   2. PREFERENCES — Coding conventions, naming patterns, architectural styles
 *   3. ENTITIES    — Key domain objects, services, data structures, APIs
 *   4. EVENTS      — Significant discoveries, decisions, milestones
 *   5. CASES       — Specific transformation patterns that worked (or failed)
 *   6. PATTERNS    — Recurring structural/architectural patterns across codebases
 *
 * Memories are extracted after each pipeline stage completes and stored in
 * `modernization_memories` for retrieval in future pipeline runs (same project
 * or similar projects).
 *
 * Uses LLM-based extraction with structured JSON output, plus deterministic
 * fallback for when LLM is unavailable.
 */

import { db } from "@/db/index.js";
import { modernizationMemories } from "@/db/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { llmProxyService } from "./llm-proxy.js";

// ─── TYPES ──────────────────────────────────────────────────────

export type MemoryCategory =
  | "profile"
  | "preferences"
  | "entities"
  | "events"
  | "cases"
  | "patterns";

export const ALL_CATEGORIES: MemoryCategory[] = [
  "profile", "preferences", "entities", "events", "cases", "patterns",
];

export interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface MemoryExtractionResult {
  memories: ExtractedMemory[];
  stored: number;
  skipped: number;
  extractionMethod: "llm" | "deterministic";
}

// ─── EXTRACTION PROMPTS ─────────────────────────────────────────

function buildExtractionPrompt(
  stageName: PipelineStageName,
  stageOutput: string,
): string {
  return [
    "## Memory Extraction Task",
    "",
    `You are analyzing the output of the ${stageName} stage of a legacy modernization pipeline.`,
    "Extract structured memories across 6 categories. Each memory should be a self-contained",
    "piece of knowledge that would be useful for future modernization projects.",
    "",
    "### Categories",
    "",
    "1. **profile** — What is this codebase? (language, framework, domain, age, size, complexity)",
    "   Examples: 'COBOL batch processing system for insurance claims, ~50K LOC, written 1992-2005'",
    "",
    "2. **preferences** — Coding conventions and architectural styles observed",
    "   Examples: 'Uses Hungarian notation for all variables', 'Follows layered architecture with clear service/repository separation'",
    "",
    "3. **entities** — Key domain objects, services, data structures, external integrations",
    "   Examples: 'PolicyClaim entity with 47 fields including nested address, 12 status codes'",
    "",
    "4. **events** — Significant discoveries, decisions, or milestones from this analysis",
    "   Examples: 'Discovered undocumented batch job NIGHTLY-RECON that reconciles accounts'",
    "",
    "5. **cases** — Specific transformation patterns, what worked/failed, lessons learned",
    "   Examples: 'COBOL PERFORM VARYING with nested GO TO required manual refactoring — direct loop translation loses control flow'",
    "",
    "6. **patterns** — Recurring structural/architectural patterns worth remembering",
    "   Examples: 'All DB access goes through DBUTIL copybook with standard error handling PARAGRAPH'",
    "",
    "### Stage Output to Analyze",
    "",
    stageOutput.slice(0, 15000),
    "",
    "### Required Response Format (JSON)",
    "Return an array of memory objects. Include 2-5 memories per category (skip categories with no relevant content).",
    "Each memory MUST have a confidence score (0.0-1.0) — higher for directly evidenced facts, lower for inferences.",
    "",
    "```json",
    "[",
    '  { "category": "profile", "content": "...", "confidence": 0.9, "keywords": ["cobol", "insurance"] },',
    '  { "category": "entities", "content": "...", "confidence": 0.8, "keywords": ["PolicyClaim", "entity"] },',
    "  ...",
    "]",
    "```",
  ].join("\n");
}

// ─── LLM-BASED EXTRACTION ───────────────────────────────────────

async function extractWithLlm(
  stageName: PipelineStageName,
  stageOutput: string,
): Promise<ExtractedMemory[]> {
  const callFn = llmProxyService.createCallFn({
    maxTokens: 4096,
    model: process.env.LLM_EVALUATOR_MODEL || "haiku",
  });

  const prompt = buildExtractionPrompt(stageName, stageOutput);

  const raw = await callFn({
    systemPrompt: "You are a knowledge extraction specialist. Output ONLY valid JSON array.",
    userPrompt: prompt,
  });

  // Parse JSON
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Memory extraction did not produce valid JSON");
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  const parsed = JSON.parse(jsonStr);

  if (!Array.isArray(parsed)) {
    throw new Error("Memory extraction result is not an array");
  }

  const validCategories = new Set(ALL_CATEGORIES);

  return parsed
    .filter((m: any) => validCategories.has(m.category) && m.content)
    .map((m: any) => ({
      category: m.category as MemoryCategory,
      content: String(m.content).slice(0, 2000),
      confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0.5)),
      metadata: {
        keywords: Array.isArray(m.keywords) ? m.keywords.map(String) : [],
        ...(m.metadata || {}),
      },
    }));
}

// ─── DETERMINISTIC EXTRACTION ───────────────────────────────────

/**
 * Fallback extraction when LLM is unavailable. Uses regex patterns
 * to pull out structural information from stage outputs.
 */
function extractDeterministic(
  stageName: PipelineStageName,
  stageOutput: string,
): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];
  const lower = stageOutput.toLowerCase();

  // PROFILE — detect language mentions
  const langPatterns = [
    { re: /\bcobol\b/i, lang: 'COBOL' },
    { re: /\bvb6\b|visual basic 6/i, lang: 'VB6' },
    { re: /\bdelphi\b|object pascal/i, lang: 'Delphi' },
    { re: /\bfortran\b/i, lang: 'Fortran' },
    { re: /\bpowerbuilder\b/i, lang: 'PowerBuilder' },
    { re: /\bjava\b(?!script)/i, lang: 'Java' },
    { re: /\bpython\b/i, lang: 'Python' },
    { re: /\bc#\b|csharp/i, lang: 'C#' },
  ];

  const detectedLangs = langPatterns
    .filter((p) => p.re.test(stageOutput))
    .map((p) => p.lang);

  if (detectedLangs.length > 0) {
    memories.push({
      category: "profile",
      content: `Codebase uses: ${detectedLangs.join(", ")}`,
      confidence: 0.8,
      metadata: { languages: detectedLangs, source: "deterministic" },
    });
  }

  // ENTITIES — extract markdown headings as potential entities
  const headings = stageOutput.match(/^#{1,3}\s+(.+)$/gm);
  if (headings && headings.length > 0) {
    const entityHeadings = headings
      .map((h) => h.replace(/^#+\s+/, ''))
      .filter((h) => h.length > 3 && h.length < 100)
      .slice(0, 10);

    if (entityHeadings.length > 0) {
      memories.push({
        category: "entities",
        content: `Key sections identified: ${entityHeadings.join("; ")}`,
        confidence: 0.6,
        metadata: { headings: entityHeadings, source: "deterministic" },
      });
    }
  }

  // PATTERNS — detect common pattern keywords
  const patternKeywords = [
    "pattern", "anti-pattern", "architecture", "layered", "microservice",
    "monolith", "batch", "event-driven", "CQRS", "repository",
    "service layer", "facade", "adapter", "decorator",
  ];

  const foundPatterns = patternKeywords.filter((kw) => lower.includes(kw));
  if (foundPatterns.length > 0) {
    memories.push({
      category: "patterns",
      content: `Architectural patterns mentioned: ${foundPatterns.join(", ")}`,
      confidence: 0.5,
      metadata: { patterns: foundPatterns, source: "deterministic" },
    });
  }

  // EVENTS — detect action/decision language
  const decisionRe = /(?:decided|chosen|selected|recommended|approach|strategy):\s*(.{20,200})/gi;
  let decMatch;
  while ((decMatch = decisionRe.exec(stageOutput)) !== null && memories.length < 15) {
    memories.push({
      category: "events",
      content: decMatch[0].slice(0, 300),
      confidence: 0.5,
      metadata: { source: "deterministic" },
    });
  }

  return memories;
}

// ─── MAIN EXTRACTION API ────────────────────────────────────────

/**
 * Extract memories from a completed pipeline stage output.
 * Tries LLM extraction first, falls back to deterministic.
 *
 * Call this after each stage completes successfully.
 */
export async function extractMemories(params: {
  projectId: string;
  pipelineRunId: string;
  stageName: PipelineStageName;
  stageOutput: string;
}): Promise<MemoryExtractionResult> {
  const { projectId, pipelineRunId, stageName, stageOutput } = params;

  if (!stageOutput || stageOutput.length < 100) {
    return { memories: [], stored: 0, skipped: 0, extractionMethod: "deterministic" };
  }

  let memories: ExtractedMemory[];
  let method: "llm" | "deterministic";

  try {
    memories = await extractWithLlm(stageName, stageOutput);
    method = "llm";
  } catch {
    memories = extractDeterministic(stageName, stageOutput);
    method = "deterministic";
  }

  // Store extracted memories
  let stored = 0;
  let skipped = 0;

  for (const memory of memories) {
    // Skip low-confidence memories from deterministic extraction
    if (method === "deterministic" && memory.confidence < 0.4) {
      skipped++;
      continue;
    }

    // Check for duplicate content in this project
    const existing = await db.query.modernizationMemories.findFirst({
      where: and(
        eq(modernizationMemories.project_id, projectId),
        eq(modernizationMemories.category, memory.category),
        // Simple content similarity check — exact match on first 100 chars
        sql`LEFT(${modernizationMemories.content}, 100) = LEFT(${memory.content}, 100)`,
      ),
    });

    if (existing) {
      // Update if new confidence is higher
      if (memory.confidence > parseFloat(existing.confidence as any)) {
        await db
          .update(modernizationMemories)
          .set({
            content: memory.content,
            confidence: String(memory.confidence),
            metadata: memory.metadata,
            pipeline_run_id: pipelineRunId,
            stage_name: stageName,
          })
          .where(eq(modernizationMemories.id, existing.id));
        stored++;
      } else {
        skipped++;
      }
      continue;
    }

    try {
      await db.insert(modernizationMemories).values({
        project_id: projectId,
        pipeline_run_id: pipelineRunId,
        stage_name: stageName,
        category: memory.category,
        content: memory.content,
        confidence: String(memory.confidence),
        metadata: memory.metadata,
      });
      stored++;
    } catch {
      skipped++;
    }
  }

  return { memories, stored, skipped, extractionMethod: method };
}

// ─── RETRIEVAL ──────────────────────────────────────────────────

/**
 * Retrieve memories for a project, optionally filtered by category.
 * Returns memories ordered by confidence and recency.
 */
export async function getProjectMemories(
  projectId: string,
  options?: {
    category?: MemoryCategory;
    limit?: number;
    minConfidence?: number;
  },
): Promise<Array<{
  id: string;
  category: MemoryCategory;
  content: string;
  confidence: number;
  stageName: string | null;
  createdAt: string;
}>> {
  const limit = options?.limit ?? 50;
  const minConf = options?.minConfidence ?? 0.0;

  const conditions = [
    eq(modernizationMemories.project_id, projectId),
    sql`${modernizationMemories.superseded_by} IS NULL`,
  ];

  if (options?.category) {
    conditions.push(eq(modernizationMemories.category, options.category));
  }

  if (minConf > 0) {
    conditions.push(sql`${modernizationMemories.confidence}::numeric >= ${minConf}`);
  }

  const rows = await db.query.modernizationMemories.findMany({
    where: and(...conditions),
    orderBy: [desc(modernizationMemories.confidence), desc(modernizationMemories.created_at)],
    limit,
  });

  // Record access for hotness scoring
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await db.execute(sql`
      UPDATE modernization_memories
      SET access_count = access_count + 1,
          last_accessed_at = NOW()
      WHERE id = ANY(${ids}::uuid[])
    `);
  }

  return rows.map((r) => ({
    id: r.id,
    category: r.category as MemoryCategory,
    content: r.content,
    confidence: parseFloat(r.confidence as any),
    stageName: r.stage_name,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Build a prompt-injectable context block from project memories.
 * Useful for injecting learned knowledge into agent prompts.
 */
export async function buildMemoryContext(
  projectId: string,
  maxTokens: number = 2000,
): Promise<string> {
  const memories = await getProjectMemories(projectId, {
    minConfidence: 0.5,
    limit: 30,
  });

  if (memories.length === 0) return "";

  const parts: string[] = ["--- Project Memory Context ---"];
  let tokenEstimate = 10;

  // Group by category
  const grouped: Record<string, typeof memories> = {};
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  }

  for (const [category, mems] of Object.entries(grouped)) {
    const categoryHeader = `\n## ${category.charAt(0).toUpperCase() + category.slice(1)}`;
    parts.push(categoryHeader);
    tokenEstimate += 5;

    for (const m of mems) {
      const line = `- ${m.content} (confidence: ${m.confidence.toFixed(1)})`;
      const lineTokens = Math.round(line.length / 4);

      if (tokenEstimate + lineTokens > maxTokens) break;

      parts.push(line);
      tokenEstimate += lineTokens;
    }

    if (tokenEstimate >= maxTokens) break;
  }

  parts.push("\n--- End Project Memory ---");
  return parts.join("\n");
}
