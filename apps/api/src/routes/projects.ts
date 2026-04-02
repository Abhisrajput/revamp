import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/db/index.js";
import {
  projects,
  projectMembers,
  supportingDocuments,
  users,
  pipelineRuns,
  stageArtifacts,
  approvalGates,
  llmUsage,
  modernizedFiles,
  stageRuns,
  stageExecutionLogs,
  agentSessions,
  agentAssignments,
  agentSubtasks,
  costEvents,
  agentActivityLog,
  retrievalTrajectories,
  modernizationMemories,
} from "@/db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import {
  getPresetTemplates,
  getPresetTemplateById,
  DEFAULT_STAGE_PROMPTS,
  DEFAULT_VALIDATION_PROMPTS,
} from "@revamp/core-engine";

// ─── Schemas ───────────────────────────────────────────────────────────────

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional().default(""),
  // Codebase source
  source_type: z.enum(["git", "upload", "local"]).optional(),
  source_url: z.string().optional(),
  source_branch: z.string().optional().default("main"),
  source_languages: z.array(z.string()).optional().default([]),
  // Target configuration
  target_stack: z.string().optional(),
  target_cloud: z.enum(["aws", "azure", "gcp", "on-prem", ""]).optional(),
  // Pipeline configuration
  prompt_template_id: z.string().optional(),
  repository_url: z.string().optional(),
  repository_branch: z.string().default("main"),
  visibility: z.enum(["private", "team", "public"]).default("private"),
});

const UpdateProjectSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["draft", "active", "in_progress", "paused", "completed", "archived"]).optional(),
  current_stage: z.string().optional(),
  current_stage_index: z.number().optional(),
  source_type: z.enum(["git", "upload", "local"]).optional(),
  source_url: z.string().optional(),
  source_branch: z.string().optional(),
  source_languages: z.array(z.string()).optional(),
  target_stack: z.string().optional(),
  target_cloud: z.enum(["aws", "azure", "gcp", "on-prem", ""]).optional(),
  prompt_template_id: z.string().optional(),
  stage_prompts: z.record(z.string(), z.string()).optional(),
  validation_prompts: z.record(z.string(), z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  deep_analysis: z.record(z.string(), z.boolean()).optional(),
});

const AddMemberSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["owner", "editor", "reviewer", "viewer"]),
});

const ApplyTemplateSchema = z.object({
  template_id: z.string().min(1),
});

// ─── Routes ────────────────────────────────────────────────────────────────

export async function projectRoutes(fastify: FastifyInstance) {
  // ── Create project ─────────────────────────────────────────────────────
  fastify.post<{ Body: z.infer<typeof CreateProjectSchema> }>(
    "/projects",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const validation = CreateProjectSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const data = validation.data;
      const projectId = crypto.randomUUID();

      // If a template is specified, apply its prompts
      let stagePrompts = { ...DEFAULT_STAGE_PROMPTS };
      const validationPrompts = { ...DEFAULT_VALIDATION_PROMPTS };

      if (data.prompt_template_id) {
        const template = getPresetTemplateById(data.prompt_template_id);
        if (template) {
          stagePrompts = { ...stagePrompts, ...template.prompts };
        }
      }

      await db.insert(projects).values({
        id: projectId,
        organization_id: request.user.organization_id || '00000000-0000-0000-0000-000000000001',
        name: data.name,
        description: data.description,
        repository_url: data.repository_url || data.source_url,
        repository_branch: data.repository_branch || data.source_branch,
        visibility: data.visibility,
        source_type: data.source_type,
        source_url: data.source_url,
        source_branch: data.source_branch,
        source_languages: data.source_languages,
        target_stack: data.target_stack,
        target_cloud: data.target_cloud,
        prompt_template_id: data.prompt_template_id,
        stage_prompts: stagePrompts,
        validation_prompts: validationPrompts,
        settings: {
          primaryAiModel: "",
          validationAiModel: "",
          bddFramework: "cucumber",
          testTimeout: 30,
          confidenceThreshold: 75,
          maxTokens: 16384,
          autoApprovalTimeoutHours: 3,
          autoApprovalEnabled: true,
          cloudProvider: data.target_cloud || "",
          deepAnalysis: {},
        },
        current_stage: "SCAN",
        current_stage_index: 0,
        status: "draft",
        created_by: request.user.sub,
      });

      // Add creator as owner
      await db.insert(projectMembers).values({
        id: crypto.randomUUID(),
        project_id: projectId,
        user_id: request.user.sub,
        role: "owner",
      });

      // Fetch the created project
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: {
          members: { with: { user: true } },
        },
      });

      return reply.status(201).send(project);
    }
  );

  // ── List projects ──────────────────────────────────────────────────────
  // Returns projects where user is an explicit member OR shares the organization.
  // This handles users without an organization (empty org_id in JWT) who created
  // projects — they can still see them via the project_members table.
  fastify.get("/projects", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const orgId = request.user.organization_id;

    // Get projects by explicit membership (always works, even with empty org_id)
    const memberRows = await db.query.projectMembers.findMany({
      where: eq(projectMembers.user_id, request.user.sub),
      columns: { project_id: true },
    });
    const memberProjectIds = new Set(memberRows.map((m) => m.project_id));

    const withRelations = { members: true, creator: true, pipelineRuns: true } as const;

    // Get projects by organization (if user has a real org_id)
    const orgProjects = (orgId && orgId !== "" && orgId !== "00000000-0000-0000-0000-000000000001")
      ? await db.query.projects.findMany({
          where: eq(projects.organization_id, orgId),
          with: withRelations,
        })
      : [];

    // Get projects by explicit membership
    const memberProjects = memberProjectIds.size > 0
      ? await db.query.projects.findMany({
          where: (table, { inArray }) => inArray(table.id, [...memberProjectIds]),
          with: withRelations,
        })
      : [];

    // Merge, dedup by id
    const seen = new Set<string>();
    const result = [];
    for (const p of [...orgProjects, ...memberProjects]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        result.push(p);
      }
    }

    return reply.send(result);
  });

  // ── Get project ────────────────────────────────────────────────────────
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { projectId } = request.params;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: {
          members: { with: { user: true } },
          pipelineRuns: {
            with: { artifacts: true, approvalGates: true },
          },
          supportingDocuments: true,
          creator: true,
        },
      });

      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const isMember = project.members.some((m) => m.user_id === request.user.sub);
      if (!isMember && project.visibility === "private" && request.user.role !== 'admin') {
        return reply.status(403).send({ error: "Access denied" });
      }

      return reply.send(project);
    }
  );

  // ── Update project ─────────────────────────────────────────────────────
  fastify.patch<{ Params: { projectId: string }; Body: z.infer<typeof UpdateProjectSchema> }>(
    "/projects/:projectId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { projectId } = request.params;
      const validation = UpdateProjectSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });

      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      // Admins can update any project; otherwise check membership
      if (request.user.role !== 'admin') {
        const member = await db.query.projectMembers.findFirst({
          where: and(
            eq(projectMembers.project_id, projectId),
            eq(projectMembers.user_id, request.user.sub)
          ),
        });

        if (!member || !["owner", "editor"].includes(member.role)) {
          return reply.status(403).send({ error: "Access denied" });
        }
      }

      const updateData: Record<string, unknown> = { updated_at: new Date() };

      // Map validated fields to DB columns
      const d = validation.data;
      if (d.name !== undefined) updateData.name = d.name;
      if (d.description !== undefined) updateData.description = d.description;
      if (d.status !== undefined) updateData.status = d.status;
      if (d.current_stage !== undefined) updateData.current_stage = d.current_stage;
      if (d.current_stage_index !== undefined) updateData.current_stage_index = d.current_stage_index;
      if (d.source_type !== undefined) updateData.source_type = d.source_type;
      if (d.source_url !== undefined) updateData.source_url = d.source_url;
      if (d.source_branch !== undefined) updateData.source_branch = d.source_branch;
      if (d.source_languages !== undefined) updateData.source_languages = d.source_languages;
      if (d.target_stack !== undefined) updateData.target_stack = d.target_stack;
      if (d.target_cloud !== undefined) updateData.target_cloud = d.target_cloud;
      if (d.prompt_template_id !== undefined) updateData.prompt_template_id = d.prompt_template_id;
      if (d.stage_prompts !== undefined) updateData.stage_prompts = d.stage_prompts;
      if (d.validation_prompts !== undefined) updateData.validation_prompts = d.validation_prompts;
      if (d.settings !== undefined) {
        // Merge with existing settings
        updateData.settings = { ...(project.settings as Record<string, unknown>), ...d.settings };
      }
      if (d.deep_analysis !== undefined) updateData.deep_analysis = d.deep_analysis;

      await db.update(projects).set(updateData).where(eq(projects.id, projectId));

      const updated = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: { members: { with: { user: true } } },
      });

      return reply.send(updated);
    }
  );

  // ── Delete project ─────────────────────────────────────────────────────
  fastify.delete<{ Params: { projectId: string } }>(
    "/projects/:projectId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { projectId } = request.params;

      const member = await db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.project_id, projectId),
          eq(projectMembers.user_id, request.user.sub)
        ),
      });

      if (!member || member.role !== "owner") {
        return reply.status(403).send({ error: "Only owners can delete projects" });
      }

      // Cascade delete all project-owned data in dependency order.
      // Collect pipeline run IDs first — many child tables reference them.
      const runs = await db.query.pipelineRuns.findMany({
        where: eq(pipelineRuns.project_id, projectId),
        columns: { id: true },
      });
      const runIds = runs.map((r) => r.id);

      if (runIds.length > 0) {
        // Tables that reference pipeline_run_id
        await db.delete(stageExecutionLogs).where(inArray(stageExecutionLogs.pipeline_run_id, runIds));
        await db.delete(stageRuns).where(inArray(stageRuns.pipeline_run_id, runIds));
        await db.delete(stageArtifacts).where(inArray(stageArtifacts.pipeline_run_id, runIds));
        await db.delete(approvalGates).where(inArray(approvalGates.pipeline_run_id, runIds));
        await db.delete(agentSubtasks).where(inArray(agentSubtasks.pipeline_run_id, runIds));
        await db.delete(agentAssignments).where(inArray(agentAssignments.pipeline_run_id, runIds));
        await db.delete(agentSessions).where(inArray(agentSessions.pipeline_run_id, runIds));
        await db.delete(agentActivityLog).where(inArray(agentActivityLog.pipeline_run_id, runIds));
        await db.delete(costEvents).where(inArray(costEvents.pipeline_run_id, runIds));
        await db.delete(retrievalTrajectories).where(inArray(retrievalTrajectories.pipeline_run_id, runIds));
        await db.delete(modernizationMemories).where(inArray(modernizationMemories.pipeline_run_id, runIds));
        await db.delete(pipelineRuns).where(eq(pipelineRuns.project_id, projectId));
      }

      // Tables that reference project_id directly
      await db.delete(llmUsage).where(eq(llmUsage.project_id, projectId));
      await db.delete(modernizedFiles).where(eq(modernizedFiles.project_id, projectId));
      await db.delete(costEvents).where(eq(costEvents.project_id, projectId));
      await db.delete(supportingDocuments).where(eq(supportingDocuments.project_id, projectId));
      // Memories not yet deleted (those without pipeline_run_id)
      await db.delete(modernizationMemories).where(eq(modernizationMemories.project_id, projectId));
      await db.delete(projectMembers).where(eq(projectMembers.project_id, projectId));
      await db.delete(projects).where(eq(projects.id, projectId));

      return reply.send({ message: "Project deleted" });
    }
  );

  // ── Apply prompt template ──────────────────────────────────────────────
  fastify.post<{ Params: { projectId: string }; Body: z.infer<typeof ApplyTemplateSchema> }>(
    "/projects/:projectId/apply-template",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId } = request.params;
      const validation = ApplyTemplateSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      const template = getPresetTemplateById(validation.data.template_id);
      if (!template) {
        return reply.status(404).send({ error: "Template not found" });
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      // Merge template prompts with defaults
      const mergedPrompts = { ...DEFAULT_STAGE_PROMPTS, ...template.prompts };

      await db
        .update(projects)
        .set({
          prompt_template_id: template.id,
          stage_prompts: mergedPrompts,
          updated_at: new Date(),
        })
        .where(eq(projects.id, projectId));

      return reply.send({
        message: "Template applied",
        template: { id: template.id, name: template.name },
      });
    }
  );

  // ── List preset templates ──────────────────────────────────────────────
  fastify.get(
    "/prompt-templates",
    { onRequest: [fastify.authenticate] },
    async (_request, reply) => {
      const templates = getPresetTemplates();
      return reply.send(templates);
    }
  );

  // ── Supporting documents ───────────────────────────────────────────────

  // List documents for a project
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/documents",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId } = request.params;

      const docs = await db.query.supportingDocuments.findMany({
        where: eq(supportingDocuments.project_id, projectId),
      });

      return reply.send(docs);
    }
  );

  // Upload document metadata (actual file goes to S3 via presigned URL)
  fastify.post<{
    Params: { projectId: string };
    Body: { name: string; file_type: string; storage_key: string; file_size: number };
  }>(
    "/projects/:projectId/documents",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId } = request.params;
      const { name, file_type, storage_key, file_size } = request.body;

      const docId = crypto.randomUUID();
      await db.insert(supportingDocuments).values({
        id: docId,
        project_id: projectId,
        name,
        file_type,
        storage_key,
        file_size,
        uploaded_by: request.user.sub,
      });

      return reply.status(201).send({ id: docId });
    }
  );

  // Delete a supporting document
  fastify.delete<{ Params: { projectId: string; docId: string } }>(
    "/projects/:projectId/documents/:docId",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId, docId } = request.params;

      await db
        .delete(supportingDocuments)
        .where(
          and(
            eq(supportingDocuments.id, docId),
            eq(supportingDocuments.project_id, projectId),
          )
        );

      return reply.send({ message: "Document deleted" });
    }
  );

  // ── Project members ────────────────────────────────────────────────────

  fastify.post<{ Params: { projectId: string }; Body: z.infer<typeof AddMemberSchema> }>(
    "/projects/:projectId/members",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { projectId } = request.params;
      const { user_id, role } = request.body;

      const member = await db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.project_id, projectId),
          eq(projectMembers.user_id, request.user.sub)
        ),
      });

      if (!member || member.role !== "owner") {
        return reply.status(403).send({ error: "Only owners can add members" });
      }

      const existing = await db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, user_id)),
      });

      if (existing) {
        return reply.status(409).send({ error: "User already member" });
      }

      await db.insert(projectMembers).values({
        id: crypto.randomUUID(),
        project_id: projectId,
        user_id,
        role,
      });

      return reply.status(201).send({ message: "Member added" });
    }
  );

  fastify.delete<{ Params: { projectId: string; userId: string } }>(
    "/projects/:projectId/members/:userId",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { projectId, userId } = request.params;

      const member = await db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.project_id, projectId),
          eq(projectMembers.user_id, request.user.sub)
        ),
      });

      if (!member || member.role !== "owner") {
        return reply.status(403).send({ error: "Only owners can remove members" });
      }

      await db
        .delete(projectMembers)
        .where(
          and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId))
        );

      return reply.send({ message: "Member removed" });
    }
  );

  // ── Update stage prompts ───────────────────────────────────────────────
  fastify.put<{
    Params: { projectId: string; stageIndex: string };
    Body: { prompt: string; type?: "stage" | "validation" };
  }>(
    "/projects/:projectId/prompts/:stageIndex",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId, stageIndex } = request.params;
      const { prompt, type = "stage" } = request.body;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const field = type === "validation" ? "validation_prompts" : "stage_prompts";
      const currentPrompts = (project[field] as Record<string, string>) || {};
      const updatedPrompts = { ...currentPrompts, [stageIndex]: prompt };

      await db
        .update(projects)
        .set({ [field]: updatedPrompts, updated_at: new Date() })
        .where(eq(projects.id, projectId));

      return reply.send({ message: "Prompt updated", [field]: updatedPrompts });
    }
  );

  // ── Per-stage model configuration ─────────────────────────────────────
  // Persists per-stage LLM model selections to the project settings.
  // The frontend model selector uses this to save user preferences.
  const StageModelConfigSchema = z.object({
    stage_models: z.record(z.string(), z.string()),
  });

  fastify.put<{
    Params: { projectId: string };
    Body: z.infer<typeof StageModelConfigSchema>;
  }>(
    "/projects/:projectId/stage-models",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { projectId } = request.params;
      const validation = StageModelConfigSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      // Check membership
      const member = await db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.project_id, projectId),
          eq(projectMembers.user_id, request.user.sub),
        ),
      });
      if (!member || !["owner", "editor"].includes(member.role)) {
        return reply.status(403).send({ error: "Access denied" });
      }

      // Merge stage_models into project settings
      const currentSettings = (project.settings as Record<string, unknown>) || {};
      const updatedSettings = {
        ...currentSettings,
        stage_models: {
          ...((currentSettings.stage_models as Record<string, string>) || {}),
          ...validation.data.stage_models,
        },
      };

      await db
        .update(projects)
        .set({ settings: updatedSettings, updated_at: new Date() })
        .where(eq(projects.id, projectId));

      return reply.send({
        message: "Stage model configuration updated",
        stage_models: updatedSettings.stage_models,
      });
    }
  );

  // GET per-stage model config
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/stage-models",
    { onRequest: [fastify.authenticate, fastify.requireProjectAccess] },
    async (request, reply) => {
      const { projectId } = request.params;
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const settings = (project.settings as Record<string, unknown>) || {};
      return reply.send({
        stage_models: (settings.stage_models as Record<string, string>) || {},
      });
    }
  );

  // ── Project Budget ──────────────────────────────────────────────────
  // Real-time project budget status from budget_policies + cost_events.

  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/budget",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { getProjectBudgetStatus } = await import("@/services/pipeline-budget.js");
      const status = await getProjectBudgetStatus(request.params.projectId);
      if (!status) {
        return reply.send({
          configured: false,
          message: "No budget policy configured for this project",
        });
      }
      return reply.send({ configured: true, ...status });
    }
  );
}
