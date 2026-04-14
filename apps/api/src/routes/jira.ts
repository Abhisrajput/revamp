/**
 * Jira Integration Routes
 *
 *   GET    /jira/status           → Check Jira connection status
 *   GET    /jira/board            → Get Kanban board (issues grouped by status)
 *   GET    /jira/issue/:key       → Get single issue details
 *   POST   /jira/issue/:key/comment → Post agent comment to issue
 *   POST   /jira/issue/:key/transition → Move issue to new status
 *   POST   /jira/issue/:key/assign → Assign issue
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildRouteSchema } from "@/lib/zod-to-jsonschema.js";
import {
  isJiraConfigured,
  getJiraBoard,
  getJiraIssue,
  addJiraComment,
  transitionJiraIssue,
  assignJiraIssue,
} from "@/services/jira-client.js";
import { db } from "@/db/index.js";
import { agentPersonas, agentTasks, agentActivityLog, llmUsage, stageArtifacts } from "@/db/schema.js";
import crypto from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import { llmProxyService, type ChatMessage } from "@/services/llm-proxy.js";
import { detectStage, getStageProcess, buildAgentPrompt } from "@/services/agent-process.js";
import { executeTool, getToolsForStage as getSandboxTools } from "@/services/sandbox.js";
import { getToolsForStage as getToolDefs } from "@/services/agent-tools.js";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// ─── SCHEMAS ────────────────────────────────────────────────────

const ErrorResponse = { type: "object" as const, properties: { error: { type: "string" } } };
const IssueKeyParams = z.object({ key: z.string().min(1) });
const CommentBodySchema = z.object({ body: z.string().min(1), agent_name: z.string().optional() });
const TransitionBodySchema = z.object({ transition: z.string().min(1) });
const AssignBodySchema = z.object({ account_id: z.string().nullable() });
const AssignAgentBodySchema = z.object({ agent_id: z.string().uuid() });

export async function jiraRoutes(fastify: FastifyInstance) {
  // ── Status check ─────────────────────────────────────────────
  fastify.get(
    "/jira/status",
    {
      schema: buildRouteSchema({
        tags: ["Jira"],
        summary: "Check Jira connection status",
        response: {
          200: { type: "object", properties: { connected: { type: "boolean" }, projectKey: { type: "string" }, message: { type: "string" } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (_request, reply) => {
      const configured = isJiraConfigured();
      if (!configured) {
        return reply.send({
          connected: false,
          message: "Jira not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN env vars.",
        });
      }
      // Quick health check — try to fetch project
      try {
        await getJiraBoard();
        return reply.send({ connected: true, projectKey: process.env.JIRA_PROJECT_KEY || "" });
      } catch (err) {
        return reply.send({ connected: false, message: String(err) });
      }
    },
  );

  // ── Board (Kanban columns) ───────────────────────────────────
  fastify.get<{ Querystring: { project?: string } }>(
    "/jira/board",
    {
      schema: buildRouteSchema({
        querystring: z.object({ project: z.string().optional() }),
        tags: ["Jira"],
        summary: "Get Kanban board with issues grouped by status",
        response: { 200: {}, 400: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      if (!isJiraConfigured()) {
        return reply.status(400).send({ error: "Jira not configured" });
      }
      const board = await getJiraBoard(request.query.project);
      return reply.send(board);
    },
  );

  // ── Single issue ─────────────────────────────────────────────
  fastify.get<{ Params: { key: string } }>(
    "/jira/issue/:key",
    {
      schema: buildRouteSchema({
        params: IssueKeyParams,
        tags: ["Jira"],
        summary: "Get single Jira issue details",
        response: { 200: {}, 400: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      if (!isJiraConfigured()) {
        return reply.status(400).send({ error: "Jira not configured" });
      }
      const issue = await getJiraIssue(request.params.key);
      return reply.send(issue);
    },
  );

  // ── Post comment (agent reporting progress) ──────────────────
  fastify.post<{ Params: { key: string }; Body: { body: string; agent_name?: string } }>(
    "/jira/issue/:key/comment",
    {
      schema: buildRouteSchema({
        params: IssueKeyParams,
        body: CommentBodySchema,
        tags: ["Jira"],
        summary: "Post a comment on a Jira issue",
        response: { 201: {}, 400: ErrorResponse },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      if (!isJiraConfigured()) {
        return reply.status(400).send({ error: "Jira not configured" });
      }
      const { body, agent_name } = request.body as { body: string; agent_name?: string };
      if (!body) return reply.status(400).send({ error: "body is required" });

      const comment = await addJiraComment(request.params.key, body, agent_name);
      return reply.status(201).send(comment);
    },
  );

  // ── Transition issue ─────────────────────────────────────────
  fastify.post<{ Params: { key: string }; Body: { transition: string } }>(
    "/jira/issue/:key/transition",
    {
      schema: buildRouteSchema({
        params: IssueKeyParams,
        body: TransitionBodySchema,
        tags: ["Jira"],
        summary: "Transition a Jira issue to a new status",
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" }, issue: { type: "string" }, transition: { type: "string" } } },
          400: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      if (!isJiraConfigured()) {
        return reply.status(400).send({ error: "Jira not configured" });
      }
      const { transition } = request.body as { transition: string };
      if (!transition) return reply.status(400).send({ error: "transition name is required" });

      await transitionJiraIssue(request.params.key, transition);
      return reply.send({ ok: true, issue: request.params.key, transition });
    },
  );

  // ── Assign issue ─────────────────────────────────────────────
  fastify.post<{ Params: { key: string }; Body: { account_id: string | null } }>(
    "/jira/issue/:key/assign",
    {
      schema: buildRouteSchema({
        params: IssueKeyParams,
        body: AssignBodySchema,
        tags: ["Jira"],
        summary: "Assign a Jira issue to a user",
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" }, issue: { type: "string" } } },
          400: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      if (!isJiraConfigured()) {
        return reply.status(400).send({ error: "Jira not configured" });
      }
      const { account_id } = request.body as { account_id: string | null };
      await assignJiraIssue(request.params.key, account_id);
      return reply.send({ ok: true, issue: request.params.key });
    },
  );

  // ── Assign Jira issue to a REVAMP agent and execute ──────────
  // 1. Creates an agent_task linked to the Jira issue
  // 2. Posts assignment comment to Jira
  // 3. Kicks off the agent LLM loop in the background
  // 4. Agent posts progress + final output as Jira comments
  // 5. Transitions the issue when done
  fastify.post<{ Params: { key: string }; Body: { agent_id: string } }>(
    "/jira/issue/:key/assign-agent",
    {
      schema: buildRouteSchema({
        params: IssueKeyParams,
        body: AssignAgentBodySchema,
        tags: ["Jira"],
        summary: "Assign a Jira issue to a REVAMP agent and execute",
        response: {
          202: { type: "object", properties: { task_id: { type: "string" }, jira_key: { type: "string" }, agent_id: { type: "string" }, agent_name: { type: "string" }, summary: { type: "string" }, status: { type: "string" }, message: { type: "string" } } },
          400: ErrorResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { key } = request.params;
      const { agent_id } = request.body as { agent_id: string };

      if (!agent_id) return reply.status(400).send({ error: "agent_id required" });

      // Verify agent exists (load system prompt + config)
      const agent = await db.query.agentPersonas.findFirst({
        where: and(eq(agentPersonas.id, agent_id), isNull(agentPersonas.hidden_at)),
      });
      if (!agent) return reply.status(404).send({ error: "Agent not found" });

      // Get Jira issue details
      let issue: Awaited<ReturnType<typeof getJiraIssue>>;
      try {
        issue = await getJiraIssue(key);
      } catch {
        return reply.status(404).send({ error: `Jira issue ${key} not found` });
      }

      // Create agent_task
      const [task] = await db.insert(agentTasks).values({
        title: `[${key}] ${issue.summary}`,
        description: issue.description || undefined,
        status: "in_progress",
        priority: issue.priority === "Highest" ? "critical" : issue.priority === "High" ? "high" : issue.priority === "Low" ? "low" : "medium",
        assigned_agent_id: agent_id,
        labels: [...issue.labels, `jira:${key}`],
        organization_id: "00000000-0000-0000-0000-000000000001",
        created_by: (request as any).user?.sub || "00000000-0000-0000-0000-000000000010",
        started_at: new Date(),
      }).returning();

      // Post assignment comment to Jira
      try {
        await addJiraComment(key,
          `Assigned to REVAMP agent **${agent.name}** (${agent.department}). Starting work now...`,
          "REVAMP",
        );
      } catch { /* non-fatal */ }

      // Transition Jira to "In Progress" (if available)
      try { await transitionJiraIssue(key, "In Progress"); } catch { /* transition may not exist */ }

      // Log the assignment
      try {
        await db.insert(agentActivityLog).values({
          agent_id, action: "jira_task_assigned",
          details: { jira_key: key, summary: issue.summary, task_id: task.id },
        });
      } catch { /* non-fatal */ }

      // Reply immediately — execution runs in background
      reply.status(202).send({
        task_id: task.id,
        jira_key: key,
        agent_id: agent.id,
        agent_name: agent.name,
        summary: issue.summary,
        status: "executing",
        message: `Agent ${agent.name} is now working on ${key}. Progress will be posted to Jira.`,
      });

      // ── BACKGROUND: Run the agent with structured process ───
      (async () => {
        const llmProxy = llmProxyService;
        const agentName = agent.name;

        // 1. Detect which pipeline stage this task maps to
        const stage = detectStage(issue.labels, issue.summary);
        const process = getStageProcess(stage);

        // 2. Build structured prompt with stage methodology
        const existingComments = issue.comments.map(c => `[${c.author}]: ${c.body}`).join("\n");
        const agentBasePrompt = agent.system_prompt || `You are ${agentName}, an AI agent.`;
        const { systemPrompt, userPrompt } = buildAgentPrompt(
          agentBasePrompt, process, key, issue.summary,
          issue.description, issue.labels, existingComments,
        );

        try {
          // Post stage-aware "starting" comment
          await addJiraComment(key,
            `Starting **${stage}** stage execution.\n\nMethodology: ${process.outputFormat}\nTools: ${process.tools.join(", ")}`,
            agentName,
          );

          // Resolve workspace (codebase path for tool execution)
          const workspaceBase = path.resolve("workspaces");
          if (!existsSync(workspaceBase)) mkdirSync(workspaceBase, { recursive: true });

          // Find cloned codebase path from any pipeline run
          let workspace = workspaceBase;
          try {
            const artifact = await db.query.stageArtifacts.findFirst({
              where: eq(stageArtifacts.artifact_type, "cloned_codebase"),
              columns: { storage_path: true },
            });
            if (artifact?.storage_path && existsSync(artifact.storage_path)) {
              workspace = artifact.storage_path;
            }
          } catch { /* use default */ }

          // Get tools for this stage
          const toolDefs = getToolDefs(process.stageIndex);
          const allowedTools = new Set(getSandboxTools(process.stageIndex));

          // Build message history for the agent loop
          const model = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
          const messages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ];

          let finalOutput = "";
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          const maxIter = process.maxIterations;

          // ── Agent tool loop ─────────────────────────────────
          for (let iteration = 1; iteration <= maxIter; iteration++) {
            let accumulatedText = "";

            const response = await llmProxy.streamCompletion(
              {
                messages,
                model,
                max_tokens: 8192,
                temperature: 0.3,
                metadata: {
                  tools: toolDefs.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
                  agent_id, jira_key: key, stage, iteration,
                },
              },
              (text: string) => { accumulatedText = text; },
            );

            totalInputTokens += response.input_tokens || 0;
            totalOutputTokens += response.output_tokens || 0;

            const llmOutput = response.content || accumulatedText;

            // Parse tool calls from the LLM output
            const toolCalls = parseToolCallsFromOutput(llmOutput);

            if (toolCalls.length === 0) {
              // No tool calls — LLM produced final output
              finalOutput = llmOutput;
              break;
            }

            // Execute tool calls
            messages.push({ role: "assistant", content: llmOutput });
            const toolResults: string[] = [];

            for (const call of toolCalls) {
              if (!allowedTools.has(call.name as any)) {
                toolResults.push(`<tool_result tool_use_id="${call.id}"><error>Tool '${call.name}' not available in ${stage}</error></tool_result>`);
                continue;
              }

              const result = await executeTool(workspace, call.name, call.input);
              if (result.success) {
                toolResults.push(`<tool_result tool_use_id="${call.id}">\n${result.output.slice(0, 8000)}\n</tool_result>`);
              } else {
                toolResults.push(`<tool_result tool_use_id="${call.id}"><error>${result.error || "Failed"}</error></tool_result>`);
              }
            }

            // Feed tool results back to the LLM
            messages.push({ role: "user", content: toolResults.join("\n\n") });

            // Post progress every 3 iterations
            if (iteration % 3 === 0) {
              try {
                await addJiraComment(key, `Working... (iteration ${iteration}/${maxIter}, ${toolCalls.length} tools used)`, agentName);
              } catch { /* non-fatal */ }
            }
          }

          const output = finalOutput;
          const response = { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, model, content: output };

          // Post the agent's output as a Jira comment
          if (output.length > 0) {
            // Jira comments have a practical limit; truncate if needed
            const commentBody = output.length > 30000
              ? output.slice(0, 30000) + "\n\n_(truncated — full output in REVAMP)_"
              : output;
            await addJiraComment(key, commentBody, agentName);
          }

          // Update task as completed
          await db.update(agentTasks).set({
            status: "done",
            progress: 100,
            stage: stage,
            tokens_used: (response.input_tokens || 0) + (response.output_tokens || 0),
            result: { output: output.slice(0, 50000), stage, model: response.model || model },
            completed_at: new Date(),
            updated_at: new Date(),
          }).where(eq(agentTasks.id, task.id));

          // Transition Jira to "Done" (if available)
          try { await transitionJiraIssue(key, "Done"); } catch { /* OK */ }

          // Post completion summary
          const tokens = (response.input_tokens || 0) + (response.output_tokens || 0);
          await addJiraComment(key,
            `**${stage}** stage complete.\n\nTokens used: ${tokens.toLocaleString()} | Model: ${response.model || model}`,
            agentName,
          );

          // Log completion
          await db.insert(agentActivityLog).values({
            agent_id, action: "jira_task_completed",
            details: {
              jira_key: key, task_id: task.id,
              tokens: (response.input_tokens || 0) + (response.output_tokens || 0),
              model: response.model || model,
            },
          });

          // Record LLM usage
          try {
            await db.insert(llmUsage).values({
              id: crypto.randomUUID(),
              project_id: "00000000-0000-0000-0000-000000000001",
              model: response.model || model,
              input_tokens: response.input_tokens || 0,
              output_tokens: response.output_tokens || 0,
              cost: 0,
            });
          } catch { /* non-fatal */ }

        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          console.error(`[JIRA Agent] ${key} failed:`, err);

          // Update task as failed
          await db.update(agentTasks).set({
            status: "blocked",
            error_message: errorMsg,
            updated_at: new Date(),
          }).where(eq(agentTasks.id, task.id));

          // Post failure comment to Jira
          try {
            await addJiraComment(key,
              `Failed to complete task: ${errorMsg}\n\nPlease retry or reassign.`,
              agentName,
            );
          } catch { /* last resort */ }

          // Log failure
          try {
            await db.insert(agentActivityLog).values({
              agent_id, action: "jira_task_failed",
              details: { jira_key: key, task_id: task.id, error: errorMsg },
            });
          } catch { /* non-fatal */ }
        }
      })();
    },
  );

  // ── List agents available for assignment ────────────────────
  fastify.get(
    "/jira/agents",
    {
      schema: buildRouteSchema({
        tags: ["Jira"],
        summary: "List agents available for Jira issue assignment",
        response: {
          200: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, role: { type: "string" }, department: { type: "string" }, status: { type: "string" } } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (_request, reply) => {
      const agents = await db.query.agentPersonas.findMany({
        where: isNull(agentPersonas.hidden_at),
        columns: { id: true, name: true, slug: true, role: true, department: true, status: true },
        orderBy: [agentPersonas.department, agentPersonas.role, agentPersonas.name],
      });
      return reply.send(agents);
    },
  );
}

// ─── HELPERS ────────────────────────────────────────────────────

/** Parse tool calls from LLM output (XML and JSON formats). */
function parseToolCallsFromOutput(
  content: string,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

  // JSON format: {"type":"tool_use","id":"...","name":"...","input":{...}}
  const jsonPattern = /\{"type"\s*:\s*"tool_use"\s*,\s*"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"input"\s*:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = jsonPattern.exec(content)) !== null) {
    try { calls.push({ id: match[1], name: match[2], input: JSON.parse(match[3]) }); } catch {}
  }
  if (calls.length > 0) return calls;

  // XML format: <function_calls><invoke name="..."><parameter name="...">...</parameter></invoke></function_calls>
  const invokePattern = /<invoke\s+name="(\w+)">([\s\S]*?)<\/invoke>/g;
  while ((match = invokePattern.exec(content)) !== null) {
    const input: Record<string, unknown> = {};
    const paramPattern = /<parameter\s+name="(\w+)">([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramPattern.exec(match[2])) !== null) {
      input[pm[1]] = pm[2].trim();
    }
    if (Object.keys(input).length > 0) {
      calls.push({ id: `tool_${crypto.randomUUID().slice(0, 8)}`, name: match[1], input });
    }
  }

  return calls;
}
