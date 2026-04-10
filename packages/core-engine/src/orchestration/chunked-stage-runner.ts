/**
 * Chunked Stage Runner — universal multi-pass generation for ALL pipeline stages.
 *
 * Solves the token limit truncation problem by:
 *   1. (Optional) Pre-analysis hook — file scanning, BREE analysis, scout triage
 *   2. Splitting the work into domain-based chunks
 *   3. Running each chunk as a separate LLM call
 *   4. Composing all chunk outputs into a single document
 *   5. Measuring coverage and gap-filling until target is met
 *   6. (Optional) Post-composition hook — validation, refinement
 *
 * Used by ALL stages: SCAN, DECODE, BLUEPRINT, SPEC_LOCK, ARCHITECT, FORGE
 */

import type { LLMCallFn } from './stage-runner.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ChunkDefinition {
  id: string;
  label: string;
  /** Entities/topics this chunk covers */
  entities: string[];
  /** Additional context to inject for this chunk */
  context?: string;
}

export interface ChunkResult {
  id: string;
  label: string;
  output: string;
  entities: string[];
  duration: number;
}

export interface ChunkedRunnerOptions {
  /** Pipeline stage name (for logging) */
  stageName: string;
  /** System prompt for the LLM */
  systemPrompt: string;
  /** Base user prompt template — {{CHUNK_ENTITIES}} and {{CHUNK_CONTEXT}} are replaced */
  userPromptTemplate: string;
  /** Composition prompt — {{CHUNK_RESULTS}} is replaced with all chunk outputs */
  compositionPrompt: string;
  /** All entities/topics to cover */
  allEntities: string[];
  /** Shared context (prior stage outputs, architecture, etc.) */
  sharedContext: string;
  /** Maximum entities per chunk */
  chunkSize?: number;
  /** LLM call function */
  llmCallFn: LLMCallFn;
  /** Coverage target (0-1). Default 0.9 */
  coverageTarget?: number;
  /** Max gap-fill rounds. Default 2 */
  maxGapFillRounds?: number;
  /** Callback for progress events */
  onProgress?: (phase: string, message: string, data?: Record<string, unknown>) => void;
  /** Callback for streaming text */
  onDelta?: (text: string) => void;
  /** Abort signal */
  signal?: AbortSignal;

  // ── Stage-specific hooks (optional) ────────────────────────

  /**
   * Pre-analysis hook — runs BEFORE chunked generation.
   * SCAN uses this for: file analysis, BREE integration, scout triage.
   * Returns additional context to inject into chunk prompts.
   */
  preAnalysis?: (opts: { signal?: AbortSignal }) => Promise<{
    /** Extra context from pre-analysis (e.g., BREE results, file stats) */
    additionalContext?: string;
    /** Override the entity list based on pre-analysis findings */
    refinedEntities?: string[];
    /** Data to pass to each chunk (e.g., code snippets per entity) */
    perEntityData?: Record<string, string>;
  }>;

  /**
   * Per-chunk context builder — called for each chunk to provide entity-specific data.
   * SCAN uses this to inject relevant code snippets per entity group.
   * DECODE uses this to inject relevant business rules per entity.
   */
  chunkContextBuilder?: (entities: string[]) => Promise<string> | string;

  /**
   * Post-composition hook — runs AFTER composition.
   * Used for: validation, refinement, storing additional artifacts.
   * Can modify the final output.
   */
  postComposition?: (output: string, coverage: { total: number; covered: number; uncovered: string[] }) => Promise<string>;

  /**
   * Custom composition strategy — override the default LLM composition.
   * FORGE uses this to merge code files instead of using LLM composition.
   */
  customComposer?: (chunks: ChunkResult[]) => Promise<string>;

  /**
   * LLM call function for scout/fast model (cheaper/faster for triage).
   * Falls back to main llmCallFn if not provided.
   */
  scoutLlmCallFn?: LLMCallFn;
}

export interface ChunkedRunnerResult {
  output: string;
  chunks: ChunkResult[];
  coverage: {
    total: number;
    covered: number;
    percentage: number;
    uncovered: string[];
  };
  duration: number;
}

// ─── Main Runner ────────────────────────────────────────────────

export async function runChunkedStage(
  options: ChunkedRunnerOptions,
): Promise<ChunkedRunnerResult> {
  const startTime = Date.now();
  const {
    stageName,
    systemPrompt,
    userPromptTemplate,
    compositionPrompt,
    allEntities,
    sharedContext,
    chunkSize = 8,
    llmCallFn,
    coverageTarget = 0.9,
    maxGapFillRounds = 2,
    onProgress,
    onDelta,
    signal,
  } = options;

  const chunks: ChunkResult[] = [];
  const emit = (phase: string, msg: string, data?: Record<string, unknown>) => {
    onProgress?.(phase, msg, data);
  };

  const checkAbort = () => {
    if (signal?.aborted) throw new Error('Stage execution aborted');
  };

  // ── Step 0: Pre-analysis hook ─────────────────────────────────
  let effectiveEntities = [...allEntities];
  let additionalContext = '';
  let perEntityData: Record<string, string> = {};

  if (options.preAnalysis) {
    checkAbort();
    emit('pre_analysis', `${stageName}: running pre-analysis hook`);
    try {
      const preResult = await options.preAnalysis({ signal });
      if (preResult.additionalContext) additionalContext = preResult.additionalContext;
      if (preResult.refinedEntities) effectiveEntities = preResult.refinedEntities;
      if (preResult.perEntityData) perEntityData = preResult.perEntityData;
      emit('pre_analysis', `${stageName}: pre-analysis complete`, {
        entityCount: effectiveEntities.length,
        hasAdditionalContext: !!additionalContext,
      });
    } catch (err) {
      emit('pre_analysis', `${stageName}: pre-analysis failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Step 1: Split entities into chunks ────────────────────────
  const chunkDefs: ChunkDefinition[] = [];
  for (let i = 0; i < effectiveEntities.length; i += chunkSize) {
    const group = effectiveEntities.slice(i, i + chunkSize);
    chunkDefs.push({
      id: `chunk-${Math.floor(i / chunkSize) + 1}`,
      label: group.slice(0, 3).join(', ') + (group.length > 3 ? '...' : ''),
      entities: group,
    });
  }

  emit('planning', `${stageName}: ${effectiveEntities.length} entities in ${chunkDefs.length} chunks`, {
    totalEntities: effectiveEntities.length,
    chunkCount: chunkDefs.length,
  });

  // ── Step 2: Run each chunk ────────────────────────────────────
  for (let ci = 0; ci < chunkDefs.length; ci++) {
    const chunk = chunkDefs[ci];
    checkAbort();

    emit('generating', `${stageName} chunk ${ci + 1}/${chunkDefs.length}: ${chunk.label}`, {
      chunk: ci + 1,
      total: chunkDefs.length,
      entities: chunk.entities,
    });

    const chunkStart = Date.now();

    // Build entity-specific context
    let entityContext = chunk.context || '';
    if (options.chunkContextBuilder) {
      try {
        const built = await options.chunkContextBuilder(chunk.entities);
        entityContext = built || entityContext;
      } catch { /* use default */ }
    }
    // Append per-entity data (e.g., code snippets for SCAN)
    const entityDataSection = chunk.entities
      .filter(e => perEntityData[e])
      .map(e => `### ${e}\n${perEntityData[e]}`)
      .join('\n\n');

    const userPrompt = userPromptTemplate
      .replace('{{CHUNK_ENTITIES}}', chunk.entities.join(', '))
      .replace('{{CHUNK_CONTEXT}}', entityContext + (entityDataSection ? `\n\n## Entity-Specific Data:\n${entityDataSection}` : ''))
      .replace('{{CHUNK_NUMBER}}', String(ci + 1))
      .replace('{{CHUNK_TOTAL}}', String(chunkDefs.length))
      .replace('{{SHARED_CONTEXT}}', (additionalContext + '\n\n' + sharedContext).slice(0, 12000));

    try {
      const output = await llmCallFn({
        systemPrompt,
        userPrompt,
        onDelta: ci === chunkDefs.length - 1 ? onDelta : undefined, // stream only last chunk
        signal,
      });

      chunks.push({
        id: chunk.id,
        label: chunk.label,
        output: output || '',
        entities: chunk.entities,
        duration: Date.now() - chunkStart,
      });

      emit('generating', `${stageName} chunk ${ci + 1} complete (${(output || '').length} chars)`, {
        chunk: ci + 1,
        outputLength: (output || '').length,
        duration: Date.now() - chunkStart,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit('generating', `${stageName} chunk ${ci + 1} failed: ${msg}`, { error: msg });
      // Continue with other chunks — partial results are better than none
    }
  }

  // ── Step 3: Measure coverage ──────────────────────────────────
  let coveredEntities = measureCoverage(effectiveEntities, chunks);
  let uncovered = effectiveEntities.filter(e => !coveredEntities.has(e.toLowerCase()));
  let coveragePercent = effectiveEntities.length > 0
    ? coveredEntities.size / effectiveEntities.length
    : 1;

  emit('validating', `${stageName} coverage: ${Math.round(coveragePercent * 100)}% (${coveredEntities.size}/${allEntities.length})`, {
    covered: coveredEntities.size,
    total: allEntities.length,
    percentage: Math.round(coveragePercent * 100),
    uncovered: uncovered.slice(0, 10),
  });

  // ── Step 4: Gap-fill rounds ───────────────────────────────────
  for (let round = 0; round < maxGapFillRounds; round++) {
    if (coveragePercent >= coverageTarget || uncovered.length === 0) break;
    checkAbort();

    emit('generating', `${stageName} gap-fill round ${round + 1}: ${uncovered.length} uncovered entities`, {
      round: round + 1,
      uncovered: uncovered,
    });

    // Create gap-fill chunks
    const gapChunks: ChunkDefinition[] = [];
    for (let i = 0; i < uncovered.length; i += chunkSize) {
      const group = uncovered.slice(i, i + chunkSize);
      gapChunks.push({
        id: `gap-${round + 1}-${Math.floor(i / chunkSize) + 1}`,
        label: `Gap-fill: ${group.slice(0, 3).join(', ')}`,
        entities: group,
        context: `IMPORTANT: These entities were MISSING from the previous analysis. You MUST cover each one thoroughly.`,
      });
    }

    for (const gapChunk of gapChunks) {
      checkAbort();

      const gapStart = Date.now();
      const userPrompt = userPromptTemplate
        .replace('{{CHUNK_ENTITIES}}', gapChunk.entities.join(', '))
        .replace('{{CHUNK_CONTEXT}}', gapChunk.context || '')
        .replace('{{CHUNK_NUMBER}}', 'gap-fill')
        .replace('{{CHUNK_TOTAL}}', String(gapChunks.length))
        .replace('{{SHARED_CONTEXT}}', sharedContext.slice(0, 8000));

      try {
        const output = await llmCallFn({
          systemPrompt,
          userPrompt,
          signal,
        });

        if (output) {
          chunks.push({
            id: gapChunk.id,
            label: gapChunk.label,
            output,
            entities: gapChunk.entities,
            duration: Date.now() - gapStart,
          });
        }
      } catch {
        // Continue
      }
    }

    // Re-measure coverage
    coveredEntities = measureCoverage(allEntities, chunks);
    uncovered = allEntities.filter(e => !coveredEntities.has(e.toLowerCase()));
    coveragePercent = allEntities.length > 0
      ? coveredEntities.size / allEntities.length
      : 1;

    emit('validating', `${stageName} coverage after gap-fill ${round + 1}: ${Math.round(coveragePercent * 100)}%`, {
      covered: coveredEntities.size,
      total: allEntities.length,
      percentage: Math.round(coveragePercent * 100),
    });
  }

  // ── Step 5: Compose final output ──────────────────────────────
  emit('composing', `${stageName}: composing ${chunks.length} chunks into final output`);

  const chunkSummaries = chunks
    .filter(c => c.output.length > 50)
    .map(c => `--- ${c.label} ---\n${c.output}`)
    .join('\n\n');

  let composedOutput: string;

  if (options.customComposer) {
    // Custom composition (e.g., FORGE merges code files)
    composedOutput = await options.customComposer(chunks);
  } else if (chunks.length === 1) {
    // Single chunk — no composition needed
    composedOutput = chunks[0].output;
  } else {
    // Multi-chunk — compose into a single document via LLM
    const composePrompt = compositionPrompt
      .replace('{{CHUNK_RESULTS}}', chunkSummaries)
      .replace('{{COVERAGE_PERCENT}}', String(Math.round(coveragePercent * 100)))
      .replace('{{TOTAL_ENTITIES}}', String(effectiveEntities.length))
      .replace('{{COVERED_ENTITIES}}', String(coveredEntities.size));

    try {
      composedOutput = await llmCallFn({
        systemPrompt: `You are composing the final ${stageName} document from multiple analysis chunks. CONSOLIDATE, never concatenate. Merge duplicates. Use tables. Keep it organized.`,
        userPrompt: composePrompt,
        onDelta,
        signal,
      });
    } catch {
      // Fallback: concatenate chunks
      composedOutput = chunks.map(c => c.output).join('\n\n---\n\n');
    }
  }

  // ── Step 6: Post-composition hook ─────────────────────────────
  if (options.postComposition && composedOutput) {
    emit('post_composition', `${stageName}: running post-composition hook`);
    try {
      composedOutput = await options.postComposition(composedOutput, {
        total: effectiveEntities.length,
        covered: coveredEntities.size,
        uncovered,
      });
    } catch (err) {
      emit('post_composition', `${stageName}: post-composition failed (using unmodified output): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    output: composedOutput || chunks.map(c => c.output).join('\n\n'),
    chunks,
    coverage: {
      total: allEntities.length,
      covered: coveredEntities.size,
      percentage: Math.round(coveragePercent * 100),
      uncovered,
    },
    duration: Date.now() - startTime,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Measure which entities are mentioned in the chunk outputs.
 * Uses case-insensitive substring matching.
 */
function measureCoverage(
  allEntities: string[],
  chunks: ChunkResult[],
): Set<string> {
  const allText = chunks.map(c => c.output).join(' ').toLowerCase();
  const covered = new Set<string>();

  for (const entity of allEntities) {
    const lower = entity.toLowerCase();
    // Check for the entity name (with word boundary-like matching)
    if (allText.includes(lower) ||
        allText.includes(entity.replace(/([A-Z])/g, ' $1').trim().toLowerCase())) {
      covered.add(lower);
    }
  }

  return covered;
}

/**
 * Extract all entity/model names from text using common patterns.
 */
export function extractEntitiesFromText(text: string): string[] {
  const patterns = [
    /(?:model|entity|table|class)[:\s]+[`*]*([A-Z][a-zA-Z]+)/g,
    /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g, // CamelCase words
  ];

  const entities = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name && name.length > 3 && name.length < 40) {
        entities.add(name);
      }
    }
  }

  return [...entities];
}
