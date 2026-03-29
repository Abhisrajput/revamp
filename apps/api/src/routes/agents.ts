/**
 * Agent Routes — API endpoints for AI agent execution with tool use.
 *
 * Endpoints:
 *   POST   /agents/execute       → Simple one-shot agent (legacy)
 *   POST   /agents/run           → Full agent loop with tool execution (SSE)
 *   POST   /agents/workspace     → Initialize workspace for a project
 *   GET    /agents/tools         → List available tools for a stage
 *   GET    /agents/health        → Agent system health check
 *
 * The agent loop works as follows:
 *   1. User sends a prompt + stage context
 *   2. LLM generates a response (possibly with tool_use blocks)
 *   3. For each tool_use, the sandbox executes the tool safely
 *   4. Tool results are fed back to the LLM
 *   5. Repeat until LLM produces a final text response (no more tool calls)
 *   6. All events are streamed via SSE to the client
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import { llmProxyService, type ChatMessage } from "@/services/llm-proxy.js";
import { executeTool, getToolsForStage as getSandboxToolsForStage } from "@/services/sandbox.js";
import { getToolsForStage as getToolDefsForStage, getAllTools, type ToolDefinition } from "@/services/agent-tools.js";
import { db } from "@/db/index.js";
import { llmUsage, projects } from "@/db/schema.js";
import { eq } from "drizzle-orm";
import { PIPELINE_STAGE_ORDER } from "@revamp/shared-types";
import {
  listPersonas,
  getPersona,
  updatePersona,
  softDeletePersona,
} from "@/services/agent-department.js";

// ─── CONSTANTS ──────────────────────────────────────────────────

const MAX_AGENT_ITERATIONS = 25;
const WORKSPACE_BASE = resolve(process.env.WORKSPACE_DIR || "/tmp/revamp-workspaces");
const CLONE_TIMEOUT_MS = 120_000; // 2 minutes

// ─── SCHEMAS ────────────────────────────────────────────────────

const ExecuteAgentSchema = z.object({
  agent_type: z.enum(["analyzer", "modernizer", "tester", "reviewer"]),
  code: z.string(),
  language: z.string(),
  context: z.record(z.any()).optional(),
  stream: z.boolean().default(false),
});

const RunAgentSchema = z.object({
  project_id: z.string().uuid(),
  pipeline_run_id: z.string().optional(),
  stage_index: z.number().int().min(0).max(7),
  stage_name: z.string(),
  prompt: z.string().min(1),
  system_prompt: z.string().optional(),
  model: z.string().optional(),
  max_iterations: z.number().int().min(1).max(MAX_AGENT_ITERATIONS).optional(),
  // Additional context passed to the LLM
  prior_output: z.string().optional(),
  codebase_summary: z.string().optional(),
});

const WorkspaceSchema = z.object({
  project_id: z.string().uuid(),
  source_type: z.enum(["git", "upload", "empty"]),
  // For git source
  repo_url: z.string().optional(),
  branch: z.string().optional(),
  token: z.string().optional(),
  // For upload source
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .optional(),
});

const ToolsQuerySchema = z.object({
  stage_index: z.coerce.number().int().min(0).max(7),
});

// ─── AGENT SYSTEM PROMPTS ───────────────────────────────────────

const AGENT_SYSTEM_PROMPTS: Record<string, string> = {
  analyzer:
    "You are an expert code analyzer. Analyze the provided code for structure, patterns, dependencies, and potential issues. Provide a detailed JSON analysis.",
  modernizer:
    "You are an expert code modernizer. Transform the provided legacy code into modern, idiomatic code following best practices. Provide the modernized code with explanations.",
  tester:
    "You are an expert test engineer. Generate comprehensive test cases for the provided code. Include unit tests, edge cases, and integration test suggestions.",
  reviewer:
    "You are an expert code reviewer. Review the provided code for quality, security, performance, and maintainability issues. Provide actionable suggestions.",
};

const DEFAULT_AGENT_SYSTEM_PROMPT = `You are REVAMP — an expert AI agent for legacy application modernization.

You have access to tools that let you read, write, search, and analyze code in the project workspace. Use these tools strategically to:
1. Understand the existing codebase structure and patterns
2. Identify business logic, dependencies, and integration points
3. Generate modernized code when requested
4. Validate your work by reading and testing results

Guidelines:
- Always read files before modifying them
- Use search_code to find patterns across the codebase
- Use file_stats to understand the project structure first
- For large files, use read_file_range instead of read_file
- When writing code, maintain the project's existing conventions
- Provide clear explanations of your analysis and decisions

Your output should be comprehensive markdown that covers your findings, analysis, and recommendations.`;

// ─── HELPERS ────────────────────────────────────────────────────

function getWorkspacePath(projectId: string): string {
  return join(WORKSPACE_BASE, projectId);
}

/**
 * Parse tool_use blocks from LLM response text.
 * The Go orchestrator returns tool calls in the response when tools are provided.
 * We parse both structured tool_use JSON and XML-style tool blocks.
 */
function parseToolCalls(
  content: string,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

  // Try JSON-structured tool_use blocks (Claude API format)
  // Pattern: {"type":"tool_use","id":"...","name":"...","input":{...}}
  const jsonPattern = /\{"type"\s*:\s*"tool_use"\s*,\s*"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"input"\s*:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})\s*\}/g;
  let match: RegExpExecArray | null;

  while ((match = jsonPattern.exec(content)) !== null) {
    try {
      const input = JSON.parse(match[3]);
      calls.push({ id: match[1], name: match[2], input });
    } catch {
      // Skip malformed JSON
    }
  }

  if (calls.length > 0) return calls;

  // Try XML-style tool blocks (alternative format)
  // <tool_use>
  //   <tool_name>read_file</tool_name>
  //   <parameters>{"path": "src/main.ts"}</parameters>
  // </tool_use>
  const xmlPattern = /<tool_use>\s*<tool_name>(\w+)<\/tool_name>\s*<parameters>([\s\S]*?)<\/parameters>\s*<\/tool_use>/g;

  while ((match = xmlPattern.exec(content)) !== null) {
    try {
      const input = JSON.parse(match[2].trim());
      calls.push({
        id: `tool_${crypto.randomUUID().slice(0, 8)}`,
        name: match[1],
        input,
      });
    } catch {
      // Skip malformed parameters
    }
  }

  return calls;
}

// ─── ROUTES ─────────────────────────────────────────────────────

export async function agentRoutes(fastify: FastifyInstance) {
  /**
   * POST /agents/execute — Simple one-shot agent execution (legacy).
   * Kept for backward compatibility.
   */
  fastify.post<{ Body: z.infer<typeof ExecuteAgentSchema> }>(
    "/agents/execute",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = ExecuteAgentSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      const { agent_type, code, language, context, stream } = validation.data;
      const systemPrompt = AGENT_SYSTEM_PROMPTS[agent_type];

      try {
        if (stream) {
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const result = await llmProxyService.streamCompletion(
            {
              messages: [
                { role: "system", content: systemPrompt },
                {
                  role: "user",
                  content: `Analyze the following ${language} code:\n\`\`\`${language}\n${code}\n\`\`\``,
                },
              ],
            },
            (text: string) => {
              reply.raw.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
            },
          );

          reply.raw.write(`event: done\ndata: ${JSON.stringify({ model: result.model })}\n\n`);
          reply.raw.end();
        } else {
          const result = await llmProxyService.complete({
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `${agent_type === "modernizer" ? "Modernize" : "Analyze"} the following ${language} code:\n\`\`\`${language}\n${code}\n\`\`\``,
              },
            ],
          });

          await db.insert(llmUsage).values({
            id: crypto.randomUUID(),
            project_id: context?.project_id || "",
            model: result.model,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            cost: 0,
          });

          return reply.send({
            agent_type,
            output: result.content,
            model: result.model,
            tokens: {
              input: result.input_tokens,
              output: result.output_tokens,
            },
          });
        }
      } catch (error) {
        console.error("Agent execution error:", error);
        return reply.status(500).send({
          error: "Agent execution failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /agents/run — Full agent loop with tool execution (SSE streaming).
   *
   * SSE Events:
   *   event: start          → { iteration: 0 }
   *   event: thinking       → { iteration, message }
   *   event: text_delta     → { text } (accumulated LLM text output)
   *   event: tool_use       → { id, name, input }
   *   event: tool_result    → { id, name, success, output, error? }
   *   event: iteration      → { iteration, tool_calls_count }
   *   event: done           → { output, iterations, model, tokens }
   *   event: error          → { message }
   */
  fastify.post<{ Body: z.infer<typeof RunAgentSchema> }>(
    "/agents/run",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = RunAgentSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          error: "Invalid input",
          details: validation.error.issues,
        });
      }

      const {
        project_id,
        pipeline_run_id,
        stage_index,
        stage_name,
        prompt,
        system_prompt,
        model,
        max_iterations,
        prior_output,
        codebase_summary,
      } = validation.data;

      // Verify project exists
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, project_id),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      // Resolve workspace
      const workspace = getWorkspacePath(project_id);
      if (!existsSync(workspace)) {
        mkdirSync(workspace, { recursive: true });
      }

      // Get tools for this stage
      const toolDefs = getToolDefsForStage(stage_index);
      const allowedToolNames = new Set(getSandboxToolsForStage(stage_index));

      // Build messages
      const sysPrompt = system_prompt || DEFAULT_AGENT_SYSTEM_PROMPT;
      const messages: ChatMessage[] = [
        { role: "system", content: sysPrompt, cache_control: { type: "ephemeral" } },
      ];

      // Add codebase summary as cacheable context
      if (codebase_summary) {
        messages.push({
          role: "user",
          content: `## Codebase Summary\n\n${codebase_summary}`,
          cache_control: { type: "ephemeral" },
        });
      }

      // Add prior output from previous stages
      if (prior_output) {
        messages.push({
          role: "user",
          content: `## Prior Stage Output\n\n${prior_output}`,
        });
      }

      // Add the actual user prompt
      messages.push({
        role: "user",
        content: `## Task — Stage: ${stage_name} (${stage_index}/7)\n\n${prompt}`,
      });

      // SSE response
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sendSSE = (event: string, data: unknown) => {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // Client disconnected
        }
      };

      const controller = new AbortController();
      request.raw.on("close", () => controller.abort());

      const maxIter = max_iterations || MAX_AGENT_ITERATIONS;
      let iteration = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let usedModel = model || "";
      let finalOutput = "";

      sendSSE("start", { iteration: 0, stage_name, stage_index, tools: toolDefs.length });

      try {
        // Agent loop: call LLM, execute tools, repeat
        while (iteration < maxIter) {
          if (controller.signal.aborted) {
            sendSSE("error", { message: "Aborted by client" });
            break;
          }

          iteration++;
          sendSSE("thinking", { iteration, message: `Iteration ${iteration}/${maxIter}...` });

          // Call LLM (non-streaming for tool use, we stream the text deltas ourselves)
          let accumulatedText = "";
          const response = await llmProxyService.streamCompletion(
            {
              messages,
              model,
              max_tokens: 8192,
              temperature: 0.3,
              metadata: {
                tools: toolDefs.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema,
                })),
                project_id,
                pipeline_run_id,
                stage_name,
              },
            },
            (text: string) => {
              accumulatedText = text;
              sendSSE("text_delta", { text });
            },
            controller.signal,
          );

          totalInputTokens += response.input_tokens;
          totalOutputTokens += response.output_tokens;
          if (response.model) usedModel = response.model;

          const llmOutput = response.content;

          // Check for tool calls in the response
          const toolCalls = parseToolCalls(llmOutput);

          if (toolCalls.length === 0) {
            // No tool calls — the LLM produced a final response
            finalOutput = llmOutput;
            break;
          }

          // Execute each tool call
          sendSSE("iteration", { iteration, tool_calls_count: toolCalls.length });

          // Add assistant message to conversation
          messages.push({ role: "assistant", content: llmOutput });

          const toolResults: string[] = [];

          for (const call of toolCalls) {
            // Verify tool is allowed for this stage
            if (!allowedToolNames.has(call.name as any)) {
              const result = {
                id: call.id,
                name: call.name,
                success: false,
                output: "",
                error: `Tool '${call.name}' is not available in stage ${stage_name} (index ${stage_index}).`,
              };
              sendSSE("tool_use", { id: call.id, name: call.name, input: call.input });
              sendSSE("tool_result", result);
              toolResults.push(
                `<tool_result tool_use_id="${call.id}">\n<error>${result.error}</error>\n</tool_result>`,
              );
              continue;
            }

            sendSSE("tool_use", { id: call.id, name: call.name, input: call.input });

            // Execute in sandbox (async for LSP tools, sync for file/shell)
            const toolResult = await executeTool(workspace, call.name, call.input);

            const result = {
              id: call.id,
              name: call.name,
              success: toolResult.success,
              output: toolResult.output.slice(0, 10_000), // Cap output for SSE
              error: toolResult.error,
            };
            sendSSE("tool_result", result);

            // Format result for LLM
            if (toolResult.success) {
              toolResults.push(
                `<tool_result tool_use_id="${call.id}">\n${toolResult.output}\n</tool_result>`,
              );
            } else {
              toolResults.push(
                `<tool_result tool_use_id="${call.id}">\n<error>${toolResult.error || "Tool execution failed"}</error>\n</tool_result>`,
              );
            }
          }

          // Add tool results to conversation
          messages.push({
            role: "user",
            content: toolResults.join("\n\n"),
          });
        }

        // Record usage
        if (usedModel && totalInputTokens > 0) {
          try {
            await db.insert(llmUsage).values({
              id: crypto.randomUUID(),
              project_id,
              model: usedModel,
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
              cost: 0, // Calculated by orchestrator
            });
          } catch {
            // Non-critical — don't fail the agent run for usage tracking
          }
        }

        sendSSE("done", {
          output: finalOutput,
          iterations: iteration,
          model: usedModel,
          tokens: {
            input: totalInputTokens,
            output: totalOutputTokens,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Agent execution failed";
        console.error("Agent run error:", err);
        sendSSE("error", { message });
      } finally {
        reply.raw.end();
      }
    },
  );

  /**
   * POST /agents/workspace — Initialize a workspace for a project.
   *
   * Creates the workspace directory and populates it from the specified source:
   * - "git": Clones a repository (supports PAT authentication)
   * - "upload": Writes provided files to the workspace
   * - "empty": Creates an empty workspace
   */
  fastify.post<{ Body: z.infer<typeof WorkspaceSchema> }>(
    "/agents/workspace",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = WorkspaceSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          error: "Invalid input",
          details: validation.error.issues,
        });
      }

      const { project_id, source_type, repo_url, branch, token, files } = validation.data;

      // Verify project exists
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, project_id),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const workspace = getWorkspacePath(project_id);

      try {
        // Clean existing workspace if it exists
        if (existsSync(workspace)) {
          execSync(`rm -rf ${JSON.stringify(workspace)}`, { timeout: 30_000 });
        }
        mkdirSync(workspace, { recursive: true });

        let fileCount = 0;

        if (source_type === "git" && repo_url) {
          // Clone repository
          const cloneUrl = token
            ? repo_url.replace("https://", `https://x-access-token:${token}@`)
            : repo_url;

          const branchArg = branch ? `--branch ${branch}` : "";
          const cmd = `git clone --depth 1 ${branchArg} ${JSON.stringify(cloneUrl)} ${JSON.stringify(workspace)}`;

          execSync(cmd, {
            timeout: CLONE_TIMEOUT_MS,
            stdio: "pipe",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          });

          // Count files
          try {
            const output = execSync("find . -type f | wc -l", {
              cwd: workspace,
              encoding: "utf-8",
              timeout: 10_000,
            });
            fileCount = parseInt(output.trim(), 10) || 0;
          } catch {
            fileCount = -1;
          }
        } else if (source_type === "upload" && files) {
          // Write uploaded files
          for (const file of files) {
            const filePath = resolve(workspace, file.path);
            // Prevent path traversal
            if (!filePath.startsWith(workspace + "/") && filePath !== workspace) {
              continue;
            }
            const dir = join(filePath, "..");
            if (!existsSync(dir)) {
              mkdirSync(dir, { recursive: true });
            }
            writeFileSync(filePath, file.content, "utf-8");
            fileCount++;
          }
        } else {
          // Empty workspace — already created
          fileCount = 0;
        }

        return reply.status(201).send({
          project_id,
          workspace_path: workspace,
          source_type,
          file_count: fileCount,
          message: `Workspace initialized (${source_type})`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workspace initialization failed";
        console.error("Workspace init error:", error);

        // Clean up on failure
        try {
          if (existsSync(workspace)) {
            execSync(`rm -rf ${JSON.stringify(workspace)}`, { timeout: 10_000 });
          }
        } catch {
          // Ignore cleanup errors
        }

        return reply.status(500).send({ error: message });
      }
    },
  );

  /**
   * GET /agents/tools — List available tools for a stage.
   *
   * Query: ?stage_index=0..7
   * Returns tool definitions with their JSON schemas.
   */
  fastify.get<{ Querystring: z.infer<typeof ToolsQuerySchema> }>(
    "/agents/tools",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = ToolsQuerySchema.safeParse(request.query);
      if (!validation.success) {
        return reply.status(400).send({
          error: "Invalid stage_index",
          details: validation.error.issues,
        });
      }

      const { stage_index } = validation.data;
      const tools = getToolDefsForStage(stage_index);

      const isWriteEnabled = stage_index === 5 || stage_index === 7;

      return reply.send({
        stage_index,
        stage_name: PIPELINE_STAGE_ORDER[stage_index] || "UNKNOWN",
        write_enabled: isWriteEnabled,
        tool_count: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      });
    },
  );

  /**
   * GET /agents/health — Agent system health check
   */
  fastify.get("/agents/health", async (_request, reply) => {
    const allTools = getAllTools();
    const workspaceExists = existsSync(WORKSPACE_BASE);

    return reply.send({
      status: "ok",
      agents: ["analyzer", "modernizer", "tester", "reviewer"],
      sandbox: {
        workspace_base: WORKSPACE_BASE,
        workspace_available: workspaceExists,
        total_tools: allTools.length,
        tool_names: allTools.map((t) => t.name),
      },
      max_iterations: MAX_AGENT_ITERATIONS,
    });
  });

  // ─── /agents alias routes — web app uses /agents, data lives in agent_personas ──

  /** GET /agents — list all agent personas */
  fastify.get<{ Querystring: { department?: string; role?: string; status?: string } }>(
    "/agents",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const personas = await listPersonas({
        department: request.query.department,
        role: request.query.role,
        status: request.query.status,
      });
      return reply.send(personas);
    }
  );

  /** GET /agents/dashboard — summary stats across all agents */
  fastify.get(
    "/agents/dashboard",
    { onRequest: [fastify.authenticate] },
    async (_request, reply) => {
      const personas = await listPersonas({});
      const byDept: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const p of personas) {
        byDept[p.department] = (byDept[p.department] ?? 0) + 1;
        byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      }
      return reply.send({
        total: personas.length,
        by_department: byDept,
        by_status: byStatus,
        agents: personas,
      });
    }
  );

  /** GET /agents/tree — hierarchy tree */
  fastify.get(
    "/agents/tree",
    { onRequest: [fastify.authenticate] },
    async (_request, reply) => {
      const personas = await listPersonas({});
      return reply.send(personas);
    }
  );

  /** GET /agents/:id — single agent persona */
  fastify.get<{ Params: { id: string } }>(
    "/agents/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const persona = await getPersona(request.params.id);
      if (!persona) return reply.status(404).send({ error: "Agent not found" });
      return reply.send(persona);
    }
  );

  /** PATCH /agents/:id — update agent persona */
  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/agents/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const persona = await updatePersona(request.params.id, request.body as any);
      if (!persona) return reply.status(404).send({ error: "Agent not found" });
      return reply.send(persona);
    }
  );

  /** DELETE /agents/:id — soft-delete agent persona */
  fastify.delete<{ Params: { id: string } }>(
    "/agents/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      await softDeletePersona(request.params.id);
      return reply.status(204).send();
    }
  );

  /** GET /agents/:id/budget — agent budget summary */
  fastify.get<{ Params: { id: string } }>(
    "/agents/:id/budget",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const persona = await getPersona(request.params.id);
      if (!persona) return reply.status(404).send({ error: "Agent not found" });
      return reply.send({
        agent_id: persona.id,
        monthly_budget_cents: persona.monthly_budget_cents,
        spent_monthly_cents: persona.spent_monthly_cents,
        remaining_cents: (persona.monthly_budget_cents ?? 0) - (persona.spent_monthly_cents ?? 0),
        hard_stop_enabled: persona.hard_stop_enabled,
        warning_threshold: persona.warning_threshold,
      });
    }
  );

  /** POST /agents/:id/resume — resume a paused agent */
  fastify.post<{ Params: { id: string } }>(
    "/agents/:id/resume",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const persona = await updatePersona(request.params.id, { status: "idle", pause_reason: null } as any);
      if (!persona) return reply.status(404).send({ error: "Agent not found" });
      return reply.send(persona);
    }
  );
}
