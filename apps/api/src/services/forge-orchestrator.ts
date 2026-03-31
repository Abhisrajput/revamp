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
import { llmProxyService } from "./llm-proxy.js";

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

  // ── STEP 1: Load prior context ────────────────────────────────
  emit("context_retrieval", { message: "Loading prior stage outputs..." });

  const decodeOutput = opts.priorOutputs.find(o => o.stageName === "DECODE")?.output || "";
  const architectOutput = opts.priorOutputs.find(o => o.stageName === "ARCHITECT")?.output || "";
  const specLockOutput = opts.priorOutputs.find(o => o.stageName === "SPEC_LOCK")?.output || "";
  const scanOutput = opts.priorOutputs.find(o => o.stageName === "SCAN")?.output || "";

  const projectConfig = opts.projectContext as any;
  const targetStack = projectConfig?.target_stack || projectConfig?.targetStack || "typescript-express";
  const targetCloud = projectConfig?.target_cloud || projectConfig?.targetCloud || "aws";
  const sourceLanguages = (projectConfig?.sourceLanguages as string[])?.join(", ") || (projectConfig?.source_languages as string[])?.join(", ") || "unknown";

  emit("context_retrieval", {
    message: `Context loaded: DECODE (${decodeOutput.length} chars), ARCHITECT (${architectOutput.length} chars), SPEC_LOCK (${specLockOutput.length} chars), SCAN (${scanOutput.length} chars)`,
  });

  // ── STEP 2: Planning phase ────────────────────────────────────
  emit("director_planning", { message: "Planning code generation..." });
  checkAbort();

  const planCallFn = llmProxyService.createCallFn({ maxTokens: opts.maxTokens || 8192, model: opts.model });

  // Extract frontend signals from SCAN output for planning
  const scanLower = scanOutput.toLowerCase();
  const hasFrontend = ["vue", "react", "angular", "blade", "twig", "javascript", "typescript", ".jsx", ".tsx", ".vue", ".html"].some(fw => scanLower.includes(fw));
  const frontendNote = hasFrontend
    ? `\n\nCRITICAL: The source codebase contains frontend code (detected in SCAN). You MUST include frontend components in the plan — pages, components, routing, state management, API client. Do NOT generate a backend-only plan.`
    : "";

  const planPrompt = `You are a code generation planner. Based on the business rules and target architecture below, create a JSON plan of files to generate.

## Source Languages & Frameworks: ${sourceLanguages}
## Target Stack: ${targetStack}
## Target Cloud: ${targetCloud}

## Codebase Discovery (from SCAN stage):
${scanOutput.slice(0, 6000)}

## Business Rules & Workflows (from DECODE stage):
${decodeOutput.slice(0, 12000)}

## Target Architecture (from ARCHITECT stage):
${architectOutput.slice(0, 8000)}

Generate a JSON array of files to create. Each file should have:
- path: full file path (e.g., "backend/src/services/account.service.ts")
- description: what this file does
- language: programming language
- rules: array of business rule IDs this file implements (e.g., ["BR-001", "BR-002"])

Output ONLY valid JSON wrapped in \`\`\`json code fence. Generate 15-30 files covering ALL layers of the source codebase:
1. Domain models/entities
2. Services/business logic
3. API routes/controllers
4. Database schema/migrations
5. Tests (unit + integration)
6. Configuration (Docker, env, etc.)
7. Frontend pages and components (REQUIRED if source has frontend code)
8. Frontend routing and state management (REQUIRED if source has frontend code)
9. Frontend API client/services (REQUIRED if source has frontend code)${frontendNote}`;

  let filePlan: FilePlan[] = [];
  try {
    const planRaw = await planCallFn({
      systemPrompt: "You are a code generation planner. Output ONLY valid JSON.",
      userPrompt: planPrompt,
    });

    const jsonMatch = planRaw.match(/```json\s*([\s\S]*?)```/) || planRaw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
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
  // Generate files in batches of 3-4 to stay within token limits
  const batchSize = 3;
  const batches = [];
  for (let i = 0; i < filePlan.length; i += batchSize) {
    batches.push(filePlan.slice(i, i + batchSize));
  }

  const codeCallFn = llmProxyService.createCallFn({ maxTokens: opts.maxTokens || 16384, model: opts.model });

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    checkAbort();

    emit("subtask_executing", {
      message: `Generating files ${bi * batchSize + 1}-${bi * batchSize + batch.length} of ${filePlan.length}...`,
      batch: bi + 1,
      totalBatches: batches.length,
    });

    const batchPrompt = `Generate the COMPLETE source code for these files. Each file must be production-ready with proper imports, error handling, and documentation.

## Target Stack: ${targetStack}

## Business Rules Context:
${decodeOutput.slice(0, 6000)}

## Architecture Context:
${architectOutput.slice(0, 4000)}

## Files to Generate:
${batch.map((f, i) => `${i + 1}. **${f.path}** — ${f.description} (${f.language})`).join("\n")}

For EACH file, output using this exact format:

### FILE: <path>
\`\`\`<language>
<complete file content>
\`\`\`

Generate ALL ${batch.length} files with complete, working code. No stubs, no TODOs.`;

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
          project_id: (opts.projectContext as any).id || (opts.projectContext as any).projectId,
          pipeline_run_id: opts.pipelineRunId,
          file_path: filePath,
          file_name: fileName,
          language,
          content,
          file_size: content.length,
          is_new: true,
        });

        // Emit file generated event
        emit("file_generated" as any, {
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

  emit("composing", {
    message: `Generated ${generatedFiles.length} files`,
    totalFiles: generatedFiles.length,
    totalSize: generatedFiles.reduce((s, f) => s + f.content.length, 0),
  });

  // ── STEP 4: Build traceability matrix ─────────────────────────
  emit("composing", { message: "Building traceability matrix..." });

  const projectId = (opts.projectContext as any).id || (opts.projectContext as any).projectId;
  for (const file of generatedFiles) {
    for (const ruleId of file.rules) {
      await db.insert(traceabilityEntries).values({
        project_id: projectId,
        pipeline_run_id: opts.pipelineRunId,
        rule_id: ruleId,
        rule_text: `Business rule ${ruleId}`,
        target_file_path: file.path,
        status: "implemented",
        confidence: "0.85",
        notes: file.description,
      }).catch(() => {}); // non-fatal
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

  const stagePrompt = (opts.projectContext as any)?.stagePrompts?.["5"] || "";
  const validationPrompt = (opts.projectContext as any)?.validationPrompts?.["5"] || "";

  let validationResult: FullValidationResult | null = null;
  try {
    const llmEvalFn = await llmProxyService.hasValidationModel()
      ? llmProxyService.createEvalFn()
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
