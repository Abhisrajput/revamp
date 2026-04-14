/**
 * FORGE Orchestrator — code generation stage (Stage 6: Co-Create).
 *
 * Generates production-ready modernized code files based on:
 *   - DECODE business rules (what to implement)
 *   - ARCHITECT target architecture (how to structure it)
 *   - SPEC_LOCK BDD specs (what tests to write)
 *
 * Flow:
 *   1. Load prior stage context (DECODE rules, ARCHITECT specs)
 *   2. Planning: LLM generates a file generation plan
 *   3. Code generation: LLM generates each file's content
 *   4. Store files in modernized_files table
 *   5. Build traceability matrix (rule → file mapping)
 *   6. Validate generated code
 *
 * Files are stored in DB and streamed to frontend via SSE.
 */

import crypto from "crypto";
// Advisor tool: enable Opus guidance for planning calls
const FORGE_ADVISOR_ENABLED = process.env.ADVISOR_ENABLED !== 'false';
const FORGE_ADVISOR_CONFIG = FORGE_ADVISOR_ENABLED ? { enabled: true, model: 'claude-opus-4-6', max_uses: 3 } as const : undefined;

import { db } from "@/db/index.js";
import { modernizedFiles, traceabilityEntries, stageArtifacts } from "@/db/schema.js";
import { eq, and } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import {
  type StageRunResult,
  type StagePhase,
  type StageEvent,
  type OnStageEvent,
  type OnDelta,
  type ProjectContext,
  type StageOutput,
  runValidation,
  type FullValidationResult,
} from "@revamp/core-engine";
import { llmProxyService, type ProjectCredentials } from "./llm-proxy.js";

// ─── TYPES ──────────────────────────────────────────────────────

export interface ForgeOrchestrationOptions {
  pipelineRunId: string;
  projectContext: ProjectContext;
  priorOutputs: StageOutput[];
  feedback: any[];
  onEvent?: OnStageEvent;
  onDelta?: OnDelta;
  signal?: AbortSignal;
  model?: string;
  maxTokens?: number;
  /** BYOK credentials from project settings */
  credentials?: ProjectCredentials;
}

interface GeneratedFile {
  path: string;
  content: string;
  language: string;
  description: string;
  rules: string[]; // business rule IDs this file implements
}

interface FilePlan {
  path: string;
  description: string;
  language: string;
  rules: string[];
}

// ─── MAIN ORCHESTRATOR ──────────────────────────────────────────

export async function orchestrateForgeStage(
  opts: ForgeOrchestrationOptions,
): Promise<StageRunResult> {
  const startTime = Date.now();
  const phases: StageEvent[] = [];
  const generatedFiles: GeneratedFile[] = [];

  const emit = (phase: string, data?: Record<string, unknown>) => {
    const event: StageEvent = {
      phase: phase as StagePhase,
      stageName: PipelineStageName.FORGE,
      stageIndex: 5,
      timestamp: new Date().toISOString(),
      data,
    };
    phases.push(event);
    opts.onEvent?.(event);
  };

  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error("Stage execution aborted");
  };

  // Track failed file saves to detect data loss
  const failedSaves: string[] = [];

  // ── STEP 1: Load prior context ────────────────────────────────
  emit("context_retrieval", { message: "Loading prior stage outputs..." });

  const decodeOutput = opts.priorOutputs.find(o => o.stageName === "DECODE")?.output || "";
  const architectOutput = opts.priorOutputs.find(o => o.stageName === "ARCHITECT")?.output || "";
  const specLockOutput = opts.priorOutputs.find(o => o.stageName === "SPEC_LOCK")?.output || "";
  const scanOutput = opts.priorOutputs.find(o => o.stageName === "SCAN")?.output || "";

  const projectConfig = opts.projectContext as unknown as Record<string, unknown>;
  const targetStack = (projectConfig?.target_stack ?? projectConfig?.targetStack ?? "typescript-express") as string;
  const targetCloud = (projectConfig?.target_cloud ?? projectConfig?.targetCloud ?? "aws") as string;
  const sourceLanguages = ((projectConfig?.sourceLanguages ?? projectConfig?.source_languages) as string[] | undefined)?.join(", ") || "unknown";

  emit("context_retrieval", {
    message: `Context loaded: DECODE (${decodeOutput.length} chars), ARCHITECT (${architectOutput.length} chars), SPEC_LOCK (${specLockOutput.length} chars), SCAN (${scanOutput.length} chars)`,
  });

  // ── STEP 2: Planning phase ────────────────────────────────────
  emit("director_planning", { message: "Planning code generation..." });
  checkAbort();

  const planCallFn = llmProxyService.createCallFn({ maxTokens: opts.maxTokens || 8192, model: opts.model, credentials: opts.credentials, advisor: FORGE_ADVISOR_CONFIG });

  // Extract frontend signals from SCAN output for planning
  const scanLower = scanOutput.toLowerCase();
  const hasFrontend = ["vue", "react", "angular", "blade", "twig", "javascript", "typescript", ".jsx", ".tsx", ".vue", ".html"].some(fw => scanLower.includes(fw));
  const frontendNote = hasFrontend
    ? `\n\nCRITICAL: The source codebase contains frontend code (detected in SCAN). You MUST include frontend components in the plan — pages, components, routing, state management, API client. Do NOT generate a backend-only plan.`
    : "";

  // Extract ALL entity/model names and business rule IDs from DECODE for comprehensive planning
  const entityPattern = /(?:model|entity|table|class)[:\s]+[`*]*([A-Z][a-zA-Z]+)/g;
  const rulePattern = /BR-\d+/g;
  const allEntities = [...new Set([...decodeOutput.matchAll(entityPattern)].map(m => m[1]))];
  const allRules = [...new Set([...decodeOutput.matchAll(rulePattern)].map(m => m[0]))];

  emit("director_planning", {
    message: `Identified ${allEntities.length} entities and ${allRules.length} business rules from DECODE`,
    entities: allEntities.slice(0, 20),
    ruleCount: allRules.length,
  });

  // Group entities into domain clusters for multi-pass generation
  const domainGroups: Array<{ name: string; entities: string[]; rules: string[] }> = [];
  const chunkSize = 6; // 6 entities per group → manageable per LLM call
  for (let i = 0; i < allEntities.length; i += chunkSize) {
    const group = allEntities.slice(i, i + chunkSize);
    const groupName = group[0] || `Group${Math.floor(i / chunkSize) + 1}`;
    // Find rules that reference these entities
    const groupRules = allRules.filter(rule => {
      const ruleIdx = decodeOutput.indexOf(rule);
      if (ruleIdx === -1) return false;
      const context = decodeOutput.slice(Math.max(0, ruleIdx - 500), ruleIdx + 500).toLowerCase();
      return group.some(e => context.includes(e.toLowerCase()));
    });
    domainGroups.push({ name: groupName, entities: group, rules: groupRules.slice(0, 15) });
  }
  // Ensure at least one group with all rules if entity extraction failed
  if (domainGroups.length === 0) {
    domainGroups.push({ name: 'Core', entities: ['Account', 'Transaction', 'User', 'Budget'], rules: allRules.slice(0, 20) });
  }

  const planPrompt = `You are a code generation planner for a COMPREHENSIVE modernization. Based on the business rules and target architecture below, create a JSON plan of ALL files needed.

## Source Languages & Frameworks: ${sourceLanguages}
## Target Stack: ${targetStack}
## Target Cloud: ${targetCloud}

## ALL Domain Entities to Cover (${allEntities.length} total):
${allEntities.map(e => `- ${e}`).join('\n')}

## ALL Business Rules (${allRules.length} total):
${allRules.join(', ')}

## Codebase Discovery (from SCAN stage):
${scanOutput.slice(0, 4000)}

## Business Rules & Workflows (from DECODE stage):
${decodeOutput.slice(0, 16000)}

## Target Architecture (from ARCHITECT stage):
${architectOutput.slice(0, 8000)}

Generate a JSON array of ALL files needed for COMPLETE coverage. Each file should have:
- path: full file path
- description: what this file does
- language: programming language
- rules: array of business rule IDs this file implements
- domainGroup: which domain group this belongs to (e.g., "accounts", "transactions", "budgets")

CRITICAL REQUIREMENTS:
1. EVERY entity listed above MUST have a model file, a service file, and a controller/route file
2. EVERY domain MUST have repository, DTO/request/response types, and tests
3. Include shared infrastructure: auth, middleware, error handling, database config
4. Include frontend pages for EACH major entity (list, create, edit, detail views)
5. Include Docker, CI/CD, and deployment config
6. Target 80-120 files for comprehensive coverage

Output ONLY valid JSON wrapped in \`\`\`json code fence.${frontendNote}`;

  let filePlan: FilePlan[] = [];
  try {
    const planRaw = await planCallFn({
      systemPrompt: "You are a code generation planner. Output ONLY valid JSON.",
      userPrompt: planPrompt,
    });

    const jsonMatch = planRaw.match(/```json\s*([\s\S]*?)```/) || planRaw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] !== undefined ? jsonMatch[1] : jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      filePlan = Array.isArray(parsed) ? parsed : parsed.files || parsed.plan || [];
    }
  } catch (err) {
    console.error("[FORGE] Planning failed:", err);
  }

  if (filePlan.length === 0) {
    // Fallback: generate a minimal plan
    filePlan = [
      { path: "backend/src/models/account.ts", description: "Account domain model", language: "typescript", rules: ["BR-001"] },
      { path: "backend/src/services/account.service.ts", description: "Account business logic", language: "typescript", rules: ["BR-001", "BR-003", "BR-004"] },
      { path: "backend/src/routes/auth.routes.ts", description: "Authentication endpoints", language: "typescript", rules: ["BR-001"] },
      { path: "backend/src/routes/account.routes.ts", description: "Account operations endpoints", language: "typescript", rules: ["BR-003", "BR-004"] },
      { path: "backend/src/server.ts", description: "Express server entry point", language: "typescript", rules: [] },
      { path: "backend/package.json", description: "Backend dependencies", language: "json", rules: [] },
      { path: "frontend/src/App.tsx", description: "React application root", language: "tsx", rules: [] },
      { path: "frontend/src/pages/LoginPage.tsx", description: "Login page component", language: "tsx", rules: ["BR-001"] },
      { path: "docker-compose.yml", description: "Docker composition", language: "yaml", rules: [] },
    ];
  }

  emit("director_planning", {
    message: `Plan: ${filePlan.length} files to generate`,
    fileCount: filePlan.length,
    files: filePlan.map(f => ({ path: f.path, language: f.language })),
  });

  // ── STEP 3: Generate code files ───────────────────────────────
  // Generate files in batches of 2-3, grouped by domain for better context
  const batchSize = 2;
  const batches: FilePlan[][] = [];

  // Group files by domain group for coherent generation
  const filesByDomain = new Map<string, FilePlan[]>();
  for (const f of filePlan) {
    const domain = (f as any).domainGroup || 'core';
    const list = filesByDomain.get(domain) || [];
    list.push(f);
    filesByDomain.set(domain, list);
  }
  // Create batches within each domain group
  for (const [, domainFiles] of filesByDomain) {
    for (let i = 0; i < domainFiles.length; i += batchSize) {
      batches.push(domainFiles.slice(i, i + batchSize));
    }
  }

  emit("director_planning", {
    message: `Code generation: ${filePlan.length} files in ${batches.length} batches across ${filesByDomain.size} domain groups`,
    fileCount: filePlan.length,
    batchCount: batches.length,
    domainGroups: [...filesByDomain.keys()],
  });

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    checkAbort();

    const batchDomain = (batch[0] as any).domainGroup || 'core';

    emit("subtask_executing", {
      message: `[${batchDomain}] Generating files ${bi + 1}/${batches.length}: ${batch.map(f => f.path.split('/').pop()).join(', ')}`,
      batch: bi + 1,
      totalBatches: batches.length,
      domain: batchDomain,
    });

    // Include domain-specific context from DECODE — find sections relevant to this batch's entities
    const batchEntities = batch.flatMap(f => f.rules || []).join(' ');
    const relevantDecodeContext = extractRelevantContext(decodeOutput, batch.map(f => f.path), 6000);

    const batchPrompt = `Generate the COMPLETE source code for these files. Each file must be production-ready with proper imports, error handling, and documentation.

## Target Stack: ${targetStack}
## Domain Group: ${batchDomain}

## Relevant Business Rules (from DECODE):
${relevantDecodeContext}

## Architecture Context:
${architectOutput.slice(0, 4000)}

## Files to Generate:
${batch.map((f, i) => `${i + 1}. **${f.path}** — ${f.description} (${f.language}) [implements: ${(f.rules || []).join(', ')}]`).join("\n")}

For EACH file, output using this exact format:

### FILE: <path>
\`\`\`<language>
<complete file content>
\`\`\`

Generate ALL ${batch.length} files with complete, working code. No stubs, no TODOs, no placeholders.`;

    try {
      let accumulated = "";
      const response = await llmProxyService.streamCompletion(
        {
          messages: [
            { role: "system", content: "You are a Senior Full-Stack Engineer. Generate complete, production-ready code files. Output each file with ### FILE: <path> header followed by a fenced code block." },
            { role: "user", content: batchPrompt },
          ],
          model: opts.model || undefined,
          max_tokens: 16384,
          temperature: 0.2,
          credentials: opts.credentials,
        },
        (delta) => {
          accumulated += delta;
          opts.onDelta?.(delta);
        },
        opts.signal,
      );

      accumulated = response.content || accumulated;

      // Parse generated files from the response
      const filePattern = /###\s*FILE:\s*(.+?)\s*\n```(\w+)?\s*\n([\s\S]*?)```/g;
      let match;
      while ((match = filePattern.exec(accumulated)) !== null) {
        const filePath = match[1].trim();
        const language = match[2] || detectLanguage(filePath);
        const content = match[3].trim();

        const planned = batch.find(f => f.path === filePath) || batch.find(f => filePath.includes(f.path.split("/").pop()!));

        const file: GeneratedFile = {
          path: filePath,
          content,
          language,
          description: planned?.description || filePath,
          rules: planned?.rules || [],
        };
        generatedFiles.push(file);

        // Store in DB
        const fileName = filePath.split("/").pop() || filePath;
        await db.insert(modernizedFiles).values({
          project_id: (projectConfig?.id ?? projectConfig?.projectId ?? opts.pipelineRunId) as string,
          pipeline_run_id: opts.pipelineRunId,
          file_path: filePath,
          file_name: fileName,
          language,
          content,
          file_size: content.length,
          is_new: true,
        });

        // Emit file generated event
        emit("subtask_executing", {
          path: filePath,
          name: fileName,
          language,
          size: content.length,
          description: file.description,
        });
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit("subtask_executing", { message: `Batch ${bi + 1} error: ${errMsg}`, error: errMsg });
    }
  }

  // ── STEP 3b: Coverage gap-fill loop ──────────────────────────
  // Measure coverage after initial generation. If below target, plan and generate
  // additional files for uncovered entities/rules. Repeat up to 3 times.
  const COVERAGE_TARGET = 0.90; // 90% minimum
  const MAX_GAP_FILL_ROUNDS = 3;

  for (let round = 0; round < MAX_GAP_FILL_ROUNDS; round++) {
    checkAbort();

    // Measure current coverage
    const coveredRulesSet = new Set(generatedFiles.flatMap(f => f.rules));
    const coveredEntityNames = new Set(generatedFiles.map(f => {
      const name = f.path.split('/').pop()?.replace(/\.\w+$/, '') || '';
      return name.replace(/(Service|Controller|Repository|Model|Entity|Dto|Test|Spec|Slice|Client|Form|Page|Routes?|Config)$/i, '').toLowerCase();
    }).filter(Boolean));

    const uncoveredEntities = allEntities.filter(e => !coveredEntityNames.has(e.toLowerCase()));
    const uncoveredRules = allRules.filter(r => !coveredRulesSet.has(r));
    const entityCoverage = allEntities.length > 0 ? (allEntities.length - uncoveredEntities.length) / allEntities.length : 1;
    const ruleCoverage = allRules.length > 0 ? (allRules.length - uncoveredRules.length) / allRules.length : 1;
    const overallCoverage = (entityCoverage + ruleCoverage) / 2;

    emit("validating" as StagePhase, {
      message: `Coverage check (round ${round + 1}): entities ${Math.round(entityCoverage * 100)}%, rules ${Math.round(ruleCoverage * 100)}%, overall ${Math.round(overallCoverage * 100)}%`,
      entityCoverage: Math.round(entityCoverage * 100),
      ruleCoverage: Math.round(ruleCoverage * 100),
      uncoveredEntities: uncoveredEntities.length,
      uncoveredRules: uncoveredRules.length,
    });

    if (overallCoverage >= COVERAGE_TARGET || (uncoveredEntities.length === 0 && uncoveredRules.length === 0)) {
      emit("validating" as StagePhase, { message: `Coverage target met: ${Math.round(overallCoverage * 100)}% ≥ ${Math.round(COVERAGE_TARGET * 100)}%` });
      break;
    }

    // Plan gap-fill files for uncovered entities
    emit("director_planning", {
      message: `Gap-fill round ${round + 1}: generating code for ${uncoveredEntities.length} uncovered entities and ${uncoveredRules.length} uncovered rules`,
    });

    const gapPlanPrompt = `You are filling COVERAGE GAPS in a modernized codebase. The following entities and business rules were NOT covered in the first generation pass.

## Target Stack: ${targetStack}
## Target Cloud: ${targetCloud}

## UNCOVERED Entities (MUST generate files for ALL of these):
${uncoveredEntities.map(e => `- ${e}`).join('\n')}

## UNCOVERED Business Rules:
${uncoveredRules.slice(0, 30).join(', ')}

## Already Generated Files (do NOT duplicate):
${generatedFiles.map(f => `- ${f.path}`).join('\n')}

## Architecture Context:
${architectOutput.slice(0, 4000)}

Generate a JSON array of NEW files to create for the uncovered entities. For EACH uncovered entity, generate:
1. Domain model/entity file
2. Service/business logic file
3. REST controller/route file
4. Repository/data access file

Output ONLY valid JSON wrapped in \`\`\`json code fence. Each entry: { path, description, language, rules, domainGroup }`;

    try {
      const gapPlanRaw = await planCallFn({
        systemPrompt: "You are a code generation planner. Output ONLY valid JSON.",
        userPrompt: gapPlanPrompt,
      });

      const gapJsonMatch = gapPlanRaw.match(/```json\s*([\s\S]*?)```/) || gapPlanRaw.match(/\[[\s\S]*\]/);
      let gapPlan: FilePlan[] = [];
      if (gapJsonMatch) {
        const parsed = JSON.parse(gapJsonMatch[1] || gapJsonMatch[0]);
        gapPlan = Array.isArray(parsed) ? parsed : parsed.files || parsed.plan || [];
      }

      if (gapPlan.length === 0) {
        emit("director_planning", { message: "Gap-fill planner returned no files — stopping coverage loop" });
        break;
      }

      // Filter out already-generated paths
      const existingPaths = new Set(generatedFiles.map(f => f.path));
      gapPlan = gapPlan.filter(f => !existingPaths.has(f.path));

      emit("director_planning", { message: `Gap-fill plan: ${gapPlan.length} new files` });

      // Generate gap-fill files in batches
      const gapBatches: FilePlan[][] = [];
      for (let i = 0; i < gapPlan.length; i += batchSize) {
        gapBatches.push(gapPlan.slice(i, i + batchSize));
      }

      for (let gbi = 0; gbi < gapBatches.length; gbi++) {
        const gapBatch = gapBatches[gbi];
        checkAbort();

        emit("subtask_executing", {
          message: `Gap-fill ${round + 1}.${gbi + 1}: ${gapBatch.map(f => f.path.split('/').pop()).join(', ')}`,
        });

        const relevantCtx = extractRelevantContext(decodeOutput, gapBatch.map(f => f.path), 6000);
        const gapGenPrompt = `Generate COMPLETE source code for these gap-fill files. Production-ready, no stubs.

## Target Stack: ${targetStack}
## Business Rules Context:
${relevantCtx}

## Files to Generate:
${gapBatch.map((f, i) => `${i + 1}. **${f.path}** — ${f.description} (${f.language}) [${(f.rules || []).join(', ')}]`).join('\n')}

### FILE: <path>
\`\`\`<language>
<complete file content>
\`\`\``;

        try {
          let gapAccum = "";
          const gapResp = await llmProxyService.streamCompletion({
            messages: [
              { role: "system", content: "You are a Senior Full-Stack Engineer. Generate complete, production-ready code." },
              { role: "user", content: gapGenPrompt },
            ],
            model: opts.model || undefined,
            max_tokens: 16384,
            temperature: 0.2,
            credentials: opts.credentials,
          }, (delta) => { gapAccum += delta; opts.onDelta?.(delta); }, opts.signal);

          gapAccum = gapResp.content || gapAccum;

          const gapFilePattern = /###\s*FILE:\s*(.+?)\s*\n```(\w+)?\s*\n([\s\S]*?)```/g;
          let gapMatch;
          while ((gapMatch = gapFilePattern.exec(gapAccum)) !== null) {
            const filePath = gapMatch[1].trim();
            const language = gapMatch[2] || detectLanguage(filePath);
            const content = gapMatch[3].trim();
            const planned = gapBatch.find(f => f.path === filePath) || gapBatch[0];

            generatedFiles.push({ path: filePath, content, language, description: planned?.description || filePath, rules: planned?.rules || [] });

            try {
              await db.insert(modernizedFiles).values({
                project_id: (projectConfig?.id ?? projectConfig?.projectId ?? opts.pipelineRunId) as string,
                pipeline_run_id: opts.pipelineRunId,
                file_path: filePath, file_name: filePath.split('/').pop() || filePath,
                language, content, file_size: content.length, is_new: true,
              });
            } catch (saveErr) {
              failedSaves.push(filePath);
              emit("subtask_failed", {
                message: `Failed to save file: ${filePath}`,
                error: saveErr instanceof Error ? saveErr.message : String(saveErr),
              });
            }

            emit("subtask_executing", { path: filePath, language, size: content.length });
          }
        } catch (gapErr) {
          emit("subtask_executing", { message: `Gap batch error: ${gapErr instanceof Error ? gapErr.message : String(gapErr)}` });
        }
      }
    } catch (planErr) {
      emit("director_planning", { message: `Gap-fill planning error: ${planErr instanceof Error ? planErr.message : String(planErr)}` });
      break;
    }
  }

  // Check file save failure rate — fail the stage if too many files were lost
  if (failedSaves.length > 0) {
    const failRate = failedSaves.length / Math.max(generatedFiles.length, 1);
    emit("composing", {
      message: `WARNING: ${failedSaves.length}/${generatedFiles.length} files failed to save to database`,
      failedFiles: failedSaves,
      failRate: Math.round(failRate * 100),
    });
    if (failRate > 0.2) {
      throw new Error(
        `FORGE stage failed: ${failedSaves.length}/${generatedFiles.length} generated files could not be saved (${Math.round(failRate * 100)}% failure rate). ` +
        `First failures: ${failedSaves.slice(0, 5).join(', ')}`,
      );
    }
  }

  emit("composing", {
    message: `Generated ${generatedFiles.length} files`,
    totalFiles: generatedFiles.length,
    totalSize: generatedFiles.reduce((s, f) => s + f.content.length, 0),
  });

  // ── STEP 4: Build traceability matrix ─────────────────────────
  emit("composing", { message: "Building traceability matrix..." });

  const projectId = (projectConfig?.id ?? projectConfig?.projectId ?? opts.pipelineRunId) as string;
  for (const file of generatedFiles) {
    for (const ruleId of file.rules) {
      try {
        await db.insert(traceabilityEntries).values({
          project_id: projectId,
          pipeline_run_id: opts.pipelineRunId,
          rule_id: ruleId,
          rule_text: `Business rule ${ruleId}`,
          target_file_path: file.path,
          status: "implemented",
          confidence: "0.85",
          notes: file.description,
        });
      } catch (traceErr) {
        // Traceability is non-blocking but logged for visibility
        console.warn(`[FORGE] traceability entry failed for ${file.path}/${ruleId}:`, traceErr instanceof Error ? traceErr.message : traceErr);
      }
    }
  }

  // ── STEP 5: Compose output summary ────────────────────────────
  const outputSections: string[] = [];
  outputSections.push("# FORGE: Co-Create — Generated Codebase\n");
  outputSections.push(`## Summary\n`);
  outputSections.push(`- **Files generated**: ${generatedFiles.length}`);
  outputSections.push(`- **Total size**: ${(generatedFiles.reduce((s, f) => s + f.content.length, 0) / 1024).toFixed(1)} KB`);
  outputSections.push(`- **Target stack**: ${targetStack}`);
  outputSections.push(`- **Target cloud**: ${targetCloud}\n`);

  outputSections.push("## Generated Files\n");
  outputSections.push("| # | File | Language | Size | Description |");
  outputSections.push("|---|------|----------|------|-------------|");
  generatedFiles.forEach((f, i) => {
    outputSections.push(`| ${i + 1} | \`${f.path}\` | ${f.language} | ${f.content.length} | ${f.description} |`);
  });

  outputSections.push("\n## Traceability Matrix\n");
  outputSections.push("| Rule | Target File | Status |");
  outputSections.push("|------|-------------|--------|");
  for (const file of generatedFiles) {
    for (const rule of file.rules) {
      outputSections.push(`| ${rule} | \`${file.path}\` | Implemented |`);
    }
  }

  // Coverage analysis
  const coveredRules = new Set(generatedFiles.flatMap(f => f.rules));
  const uncoveredRules = allRules.filter(r => !coveredRules.has(r));
  const coveredEntities = new Set(generatedFiles.flatMap(f => {
    const name = f.path.split('/').pop()?.replace(/\.\w+$/, '') || '';
    return name.replace(/(Service|Controller|Repository|Model|Entity|Dto|Test|Spec|Slice|Client|Form|Page)$/i, '');
  }).filter(Boolean));
  const uncoveredEntities = allEntities.filter(e => !coveredEntities.has(e) && !coveredEntities.has(e.toLowerCase()));

  outputSections.push("\n## Coverage Analysis\n");
  outputSections.push(`- **Entities identified**: ${allEntities.length}`);
  outputSections.push(`- **Entities with generated code**: ${coveredEntities.size} (${Math.round(coveredEntities.size / Math.max(allEntities.length, 1) * 100)}%)`);
  outputSections.push(`- **Business rules identified**: ${allRules.length}`);
  outputSections.push(`- **Business rules implemented**: ${coveredRules.size} (${Math.round(coveredRules.size / Math.max(allRules.length, 1) * 100)}%)`);
  if (uncoveredEntities.length > 0) {
    outputSections.push(`\n### Uncovered Entities (${uncoveredEntities.length})`);
    uncoveredEntities.forEach(e => outputSections.push(`- ${e}`));
  }
  if (uncoveredRules.length > 0) {
    outputSections.push(`\n### Uncovered Business Rules (${uncoveredRules.length})`);
    outputSections.push(uncoveredRules.join(', '));
  }

  // Include file contents in output
  outputSections.push("\n## File Contents\n");
  for (const file of generatedFiles) {
    outputSections.push(`### ${file.path}\n`);
    outputSections.push(`\`\`\`${file.language}`);
    outputSections.push(file.content);
    outputSections.push("```\n");
  }

  const composedOutput = outputSections.join("\n");

  // Store as artifact
  try {
    await db.insert(stageArtifacts).values({
      id: crypto.randomUUID(),
      pipeline_run_id: opts.pipelineRunId,
      stage_name: PipelineStageName.FORGE,
      artifact_type: "stage_output",
      storage_path: `inline:forge_output:${opts.pipelineRunId}`,
      metadata: {
        content: composedOutput,
        filesGenerated: generatedFiles.length,
        totalSize: generatedFiles.reduce((s, f) => s + f.content.length, 0),
      },
    });
  } catch { /* non-fatal */ }

  // ── STEP 6: Validate ──────────────────────────────────────────
  emit("validating" as StagePhase, { message: "Validating generated code..." });

  const prompts = (projectConfig?.stagePrompts as Record<string, string>) || {};
  const valPrompts = (projectConfig?.validationPrompts as Record<string, string>) || {};
  let stagePrompt = prompts["5"] || prompts["FORGE"] || "";
  let validationPrompt = valPrompts["5"] || valPrompts["FORGE"] || "";
  // Fallback to defaults so validation never degrades
  if (!stagePrompt) {
    try {
      const { DEFAULT_STAGE_PROMPTS } = await import("@revamp/core-engine");
      stagePrompt = DEFAULT_STAGE_PROMPTS["FORGE"] || DEFAULT_STAGE_PROMPTS["5"] || "";
    } catch { /* non-fatal */ }
  }
  if (!validationPrompt) {
    try {
      const { DEFAULT_VALIDATION_PROMPTS } = await import("@revamp/core-engine");
      validationPrompt = DEFAULT_VALIDATION_PROMPTS["FORGE"] || DEFAULT_VALIDATION_PROMPTS["5"] || "";
    } catch { /* non-fatal */ }
  }

  let validationResult: FullValidationResult | null = null;
  try {
    const llmEvalFn = await llmProxyService.hasValidationModel()
      ? llmProxyService.createEvalFn({ credentials: opts.credentials })
      : undefined;

    validationResult = await runValidation({
      pipelineRunId: opts.pipelineRunId,
      stageName: PipelineStageName.FORGE,
      stageOutput: composedOutput,
      stagePrompt,
      validationPrompt,
      llmEvalFn,
      priorStageOutputs: opts.priorOutputs.map(o => ({ stageName: o.stageName, output: o.output })),
    });
  } catch {
    // validation failure is non-fatal
  }

  emit("completed", {
    message: `FORGE complete: ${generatedFiles.length} files generated`,
    filesGenerated: generatedFiles.length,
  });

  return {
    stageName: PipelineStageName.FORGE,
    stageIndex: 5,
    output: composedOutput,
    validation: validationResult,
    refinementCount: 0,
    duration: Date.now() - startTime,
    phases,
    aborted: opts.signal?.aborted ?? false,
  };
}

// ─── HELPERS ────────────────────────────────────────────────────

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    java: "java", py: "python", go: "go", rs: "rust",
    sql: "sql", json: "json", yaml: "yaml", yml: "yaml",
    xml: "xml", html: "html", css: "css", scss: "scss",
    md: "markdown", sh: "bash", dockerfile: "dockerfile",
  };
  return map[ext] || ext || "text";
}

/**
 * Extract sections from DECODE output that are relevant to the given file paths.
 * Finds paragraphs containing entity names derived from file paths.
 */
function extractRelevantContext(decodeOutput: string, filePaths: string[], maxChars: number): string {
  // Extract entity names from file paths (e.g., "AccountService.java" → "account")
  const entityNames = filePaths.map(p => {
    const fileName = p.split('/').pop()?.replace(/\.\w+$/, '') || '';
    return fileName
      .replace(/(Service|Controller|Repository|Model|Entity|Dto|Test|Spec|Slice|Client|Form|Page)$/i, '')
      .toLowerCase();
  }).filter(Boolean);

  if (entityNames.length === 0) return decodeOutput.slice(0, maxChars);

  // Split DECODE into sections and find relevant ones
  const sections = decodeOutput.split(/^##\s+/m).filter(Boolean);
  const relevant: string[] = [];
  let totalLen = 0;

  for (const section of sections) {
    const sectionLower = section.toLowerCase();
    const isRelevant = entityNames.some(e => sectionLower.includes(e));
    if (isRelevant && totalLen + section.length < maxChars) {
      relevant.push('## ' + section);
      totalLen += section.length;
    }
  }

  // If no relevant sections found, return truncated full output
  return relevant.length > 0 ? relevant.join('\n') : decodeOutput.slice(0, maxChars);
}
