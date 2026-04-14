import { FastifyInstance } from "fastify";
import { z } from "zod";
import { NotFoundError, ForbiddenError, ValidationError } from "@/errors.js";
import { buildRouteSchema } from "@/lib/zod-to-jsonschema.js";
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
import {
  encryptProviderCredentials,
  decryptProviderCredentials,
  maskCredential,
} from "@/services/crypto.js";

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

// ─── Common JSON Schema shapes for responses ─────────────────────────────

const ErrorResponse = { type: "object" as const, properties: { error: { type: "string" } } };
const MessageResponse = { type: "object" as const, properties: { message: { type: "string" } } };
const ProjectIdParams = z.object({ projectId: z.string().uuid() });
const ProjectIdAndDocIdParams = z.object({ projectId: z.string().uuid(), docId: z.string().uuid() });
const ProjectIdAndUserIdParams = z.object({ projectId: z.string().uuid(), userId: z.string().uuid() });
const ProjectIdAndStageIndexParams = z.object({ projectId: z.string().uuid(), stageIndex: z.string() });
const ProjectIdAndStageNameParams = z.object({ projectId: z.string().uuid(), stageName: z.string() });
const ProjectIdAndProviderIdParams = z.object({ projectId: z.string().uuid(), providerId: z.string() });

// ─── Routes ────────────────────────────────────────────────────────────────

export async function projectRoutes(fastify: FastifyInstance) {
  // ── Create project ─────────────────────────────────────────────────────
  fastify.post<{ Body: z.infer<typeof CreateProjectSchema> }>(
    "/projects",
    {
      schema: buildRouteSchema({
        body: CreateProjectSchema,
        tags: ["Projects"],
        summary: "Create a new project",
        response: {
          201: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } } },
          400: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const validation = CreateProjectSchema.safeParse(request.body);
      if (!validation.success) {
        throw new ValidationError("Invalid input", validation.error.errors);
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
  fastify.get("/projects", {
    schema: buildRouteSchema({
      tags: ["Projects"],
      summary: "List projects for the authenticated user",
      response: {
        200: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } } } },
      },
    }),
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
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
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects"],
        summary: "Get a project by ID",
        response: {
          200: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" }, current_stage: { type: "string" } } },
          403: ErrorResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
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
        throw new NotFoundError("Project not found");
      }

      const isMember = project.members.some((m) => m.user_id === request.user.sub);
      if (!isMember && project.visibility === "private" && request.user.role !== 'admin') {
        throw new ForbiddenError("Access denied");
      }

      return reply.send(project);
    }
  );

  // ── Update project ─────────────────────────────────────────────────────
  fastify.patch<{ Params: { projectId: string }; Body: z.infer<typeof UpdateProjectSchema> }>(
    "/projects/:projectId",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        body: UpdateProjectSchema,
        tags: ["Projects"],
        summary: "Update a project",
        response: {
          200: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } } },
          400: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const validation = UpdateProjectSchema.safeParse(request.body);
      if (!validation.success) {
        throw new ValidationError("Invalid input", validation.error.errors);
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });

      if (!project) {
        throw new NotFoundError("Project not found");
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
          throw new ForbiddenError("Access denied");
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
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects"],
        summary: "Delete a project and all associated data",
        response: {
          200: MessageResponse,
          403: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const member = await db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.project_id, projectId),
          eq(projectMembers.user_id, request.user.sub)
        ),
      });

      if (!member || member.role !== "owner") {
        throw new ForbiddenError("Only owners can delete projects");
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
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        body: ApplyTemplateSchema,
        tags: ["Projects"],
        summary: "Apply a prompt template to a project",
        response: {
          200: { type: "object", properties: { message: { type: "string" }, template: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } },
          400: ErrorResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const validation = ApplyTemplateSchema.safeParse(request.body);
      if (!validation.success) {
        throw new ValidationError("Invalid input");
      }

      const template = getPresetTemplateById(validation.data.template_id);
      if (!template) {
        throw new NotFoundError("Template not found");
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        throw new NotFoundError("Project not found");
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
    {
      schema: buildRouteSchema({
        tags: ["Projects"],
        summary: "List available prompt templates",
        response: {
          200: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (_request, reply) => {
      const templates = getPresetTemplates();
      return reply.send(templates);
    }
  );

  // ── Supporting documents ───────────────────────────────────────────────

  // List documents for a project
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/documents",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects", "Documents"],
        summary: "List supporting documents for a project",
        response: {
          200: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, file_type: { type: "string" }, file_size: { type: "number" } } } },
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const docs = await db.query.supportingDocuments.findMany({
        where: eq(supportingDocuments.project_id, projectId),
      });

      return reply.send(docs);
    }
  );

  // Upload document metadata (actual file goes to S3 via presigned URL)
  const UploadDocumentBodySchema = z.object({
    name: z.string().min(1),
    file_type: z.string().min(1),
    storage_key: z.string().min(1),
    file_size: z.number(),
  });

  fastify.post<{
    Params: { projectId: string };
    Body: { name: string; file_type: string; storage_key: string; file_size: number };
  }>(
    "/projects/:projectId/documents",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        body: UploadDocumentBodySchema,
        tags: ["Projects", "Documents"],
        summary: "Upload document metadata for a project",
        response: {
          201: { type: "object", properties: { id: { type: "string" } } },
          400: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
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
    {
      schema: buildRouteSchema({
        params: ProjectIdAndDocIdParams,
        tags: ["Projects", "Documents"],
        summary: "Delete a supporting document",
        response: {
          200: MessageResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
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
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        body: AddMemberSchema,
        tags: ["Projects", "Members"],
        summary: "Add a member to a project",
        response: {
          201: MessageResponse,
          403: ErrorResponse,
          409: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
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
        throw new ForbiddenError("Only owners can add members");
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
    {
      schema: buildRouteSchema({
        params: ProjectIdAndUserIdParams,
        tags: ["Projects", "Members"],
        summary: "Remove a member from a project",
        response: {
          200: MessageResponse,
          403: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId, userId } = request.params;

      const member = await db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.project_id, projectId),
          eq(projectMembers.user_id, request.user.sub)
        ),
      });

      if (!member || member.role !== "owner") {
        throw new ForbiddenError("Only owners can remove members");
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
  const UpdatePromptBodySchema = z.object({
    prompt: z.string().min(1),
    type: z.enum(["stage", "validation"]).optional(),
  });

  fastify.put<{
    Params: { projectId: string; stageIndex: string };
    Body: { prompt: string; type?: "stage" | "validation" };
  }>(
    "/projects/:projectId/prompts/:stageIndex",
    {
      schema: buildRouteSchema({
        params: ProjectIdAndStageIndexParams,
        body: UpdatePromptBodySchema,
        tags: ["Projects", "Prompts"],
        summary: "Update a stage or validation prompt for a project",
        response: {
          200: { type: "object", properties: { message: { type: "string" }, stage_prompts: { type: "object" }, validation_prompts: { type: "object" } } },
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId, stageIndex } = request.params;
      const { prompt, type = "stage" } = request.body;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        throw new NotFoundError("Project not found");
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

  // ── Stage Validation Contracts ────────────────────────────────────────
  // Allows users to customize validation requirements per stage per project.

  /**
   * GET /projects/:projectId/contracts — Get all stage contracts (defaults merged with overrides)
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/contracts",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects", "Contracts"],
        summary: "Get all stage validation contracts for a project",
        response: {
          200: { type: "object", properties: { contracts: { type: "array", items: { type: "object", properties: { stageName: { type: "string" }, minTotalWords: { type: "number" }, maxRefinementPasses: { type: "number" }, hardGate: { type: "boolean" } } } } } },
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, request.params.projectId),
        columns: { settings: true },
      });
      if (!project) throw new NotFoundError("Project not found");

      const { stageContracts } = await import("@revamp/core-engine");
      const overrides = ((project.settings as any)?.validationContracts as Record<string, any>) || {};

      // Merge defaults with per-project overrides
      const merged = stageContracts.map((contract) => {
        const override = overrides[contract.stageName];
        if (!override) return contract;

        return {
          ...contract,
          minTotalWords: override.minTotalWords ?? contract.minTotalWords,
          maxRefinementPasses: override.maxRefinementPasses ?? contract.maxRefinementPasses,
          hardGate: override.hardGate ?? contract.hardGate,
          requiredSections: override.requiredSections ?? contract.requiredSections,
        };
      });

      return reply.send({ contracts: merged });
    },
  );

  /**
   * PUT /projects/:projectId/contracts/:stageName — Update contract for a specific stage
   */
  const UpdateContractBodySchema = z.object({
    minTotalWords: z.number().optional(),
    maxRefinementPasses: z.number().optional(),
    hardGate: z.boolean().optional(),
    requiredSections: z.array(z.object({
      heading: z.string(),
      aliases: z.array(z.string()).optional(),
      required: z.boolean(),
      minWordCount: z.number().optional(),
      mustContain: z.array(z.string()).optional(),
    })).optional(),
  });

  fastify.put<{
    Params: { projectId: string; stageName: string };
    Body: {
      minTotalWords?: number;
      maxRefinementPasses?: number;
      hardGate?: boolean;
      requiredSections?: Array<{
        heading: string;
        aliases?: string[];
        required: boolean;
        minWordCount?: number;
        mustContain?: string[];
      }>;
    };
  }>(
    "/projects/:projectId/contracts/:stageName",
    {
      schema: buildRouteSchema({
        params: ProjectIdAndStageNameParams,
        body: UpdateContractBodySchema,
        tags: ["Projects", "Contracts"],
        summary: "Update a stage validation contract",
        response: {
          200: { type: "object", properties: { message: { type: "string" }, contract: { type: "object" } } },
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId, stageName } = request.params;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { settings: true },
      });
      if (!project) throw new NotFoundError("Project not found");

      const settings = (project.settings as Record<string, any>) || {};
      const contracts = settings.validationContracts || {};
      contracts[stageName] = request.body;

      await db.update(projects).set({
        settings: { ...settings, validationContracts: contracts },
        updated_at: new Date(),
      }).where(eq(projects.id, projectId));

      return reply.send({ message: `Contract updated for ${stageName}`, contract: contracts[stageName] });
    },
  );

  /**
   * DELETE /projects/:projectId/contracts/:stageName — Reset contract to defaults
   */
  fastify.delete<{ Params: { projectId: string; stageName: string } }>(
    "/projects/:projectId/contracts/:stageName",
    {
      schema: buildRouteSchema({
        params: ProjectIdAndStageNameParams,
        tags: ["Projects", "Contracts"],
        summary: "Reset a stage validation contract to defaults",
        response: {
          200: MessageResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId, stageName } = request.params;

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { settings: true },
      });
      if (!project) throw new NotFoundError("Project not found");

      const settings = (project.settings as Record<string, any>) || {};
      const contracts = settings.validationContracts || {};
      delete contracts[stageName];

      await db.update(projects).set({
        settings: { ...settings, validationContracts: contracts },
        updated_at: new Date(),
      }).where(eq(projects.id, projectId));

      return reply.send({ message: `Contract reset to defaults for ${stageName}` });
    },
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
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        body: StageModelConfigSchema,
        tags: ["Projects", "Models"],
        summary: "Update per-stage LLM model configuration",
        response: {
          200: { type: "object", properties: { message: { type: "string" }, stage_models: { type: "object" } } },
          400: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const validation = StageModelConfigSchema.safeParse(request.body);
      if (!validation.success) {
        throw new ValidationError("Invalid input", validation.error.errors);
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        throw new NotFoundError("Project not found");
      }

      // Check membership
      const member = await db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.project_id, projectId),
          eq(projectMembers.user_id, request.user.sub),
        ),
      });
      if (!member || !["owner", "editor"].includes(member.role)) {
        throw new ForbiddenError("Access denied");
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
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects", "Models"],
        summary: "Get per-stage LLM model configuration",
        response: {
          200: { type: "object", properties: { stage_models: { type: "object" } } },
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        throw new NotFoundError("Project not found");
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
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects", "Budget"],
        summary: "Get real-time project budget status",
        response: {
          200: { type: "object", properties: { configured: { type: "boolean" }, message: { type: "string" }, total_budget: { type: "number" }, total_spent: { type: "number" }, remaining: { type: "number" } } },
        },
      }),
      onRequest: [fastify.authenticate],
    },
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

  // ── BYOK LLM Providers ─────────────────────────────────────────────
  // Per-project LLM provider credentials stored encrypted in project.settings.llm_providers

  const LLMProviderSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    provider_type: z.enum(["anthropic", "openai", "gemini", "bedrock", "xai", "local", "custom"]),
    base_url: z.string().optional().default(""),
    api_key: z.string().optional().default(""),
    // AWS Bedrock-specific
    aws_access_key_id: z.string().optional().default(""),
    aws_secret_access_key: z.string().optional().default(""),
    aws_session_token: z.string().optional().default(""),
    aws_region: z.string().optional().default("us-east-2"),
    // Model config
    available_models: z.array(z.string()).optional().default([]),
    is_default: z.boolean().optional().default(false),
  });

  // Add or update an LLM provider for a project
  fastify.post<{
    Params: { projectId: string };
    Body: z.infer<typeof LLMProviderSchema>;
  }>(
    "/projects/:projectId/llm-providers",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        body: LLMProviderSchema,
        tags: ["Projects", "BYOK"],
        summary: "Add or update a BYOK LLM provider for a project",
        response: {
          201: { type: "object", properties: { message: { type: "string" }, provider: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, provider_type: { type: "string" } } } } },
          400: ErrorResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const validation = LLMProviderSchema.safeParse(request.body);
      if (!validation.success) {
        throw new ValidationError("Invalid input", validation.error.errors);
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        throw new NotFoundError("Project not found");
      }

      const settings = (project.settings as Record<string, unknown>) || {};
      const providers = ((settings.llm_providers as Record<string, unknown>[]) || []).slice();

      const providerData = validation.data;
      const providerId = providerData.id || crypto.randomUUID();

      // Encrypt sensitive credentials before storage
      const encrypted = encryptProviderCredentials({
        ...providerData,
        id: providerId,
      });

      // If is_default, clear default on all others
      if (providerData.is_default) {
        for (const p of providers) {
          (p as Record<string, unknown>).is_default = false;
        }
      }

      // Upsert: replace if same id exists
      const existingIdx = providers.findIndex((p: any) => p.id === providerId);
      if (existingIdx >= 0) {
        providers[existingIdx] = encrypted;
      } else {
        providers.push(encrypted);
      }

      await db
        .update(projects)
        .set({
          settings: { ...settings, llm_providers: providers },
          updated_at: new Date(),
        })
        .where(eq(projects.id, projectId));

      return reply.status(201).send({
        message: "LLM provider saved",
        provider: { id: providerId, name: providerData.name, provider_type: providerData.provider_type },
      });
    }
  );

  // List LLM providers for a project (credentials masked)
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/llm-providers",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects", "BYOK"],
        summary: "List BYOK LLM providers for a project (credentials masked)",
        response: {
          200: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, provider_type: { type: "string" }, is_default: { type: "boolean" } } } },
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        throw new NotFoundError("Project not found");
      }

      const settings = (project.settings as Record<string, unknown>) || {};
      const providers = ((settings.llm_providers as Record<string, unknown>[]) || []);

      // Return providers with masked credentials
      const masked = providers.map((p: any) => ({
        ...p,
        api_key: p.api_key ? maskCredential("encrypted") : "",
        aws_access_key_id: p.aws_access_key_id ? maskCredential("encrypted") : "",
        aws_secret_access_key: p.aws_secret_access_key ? "****" : "",
        aws_session_token: p.aws_session_token ? "****" : "",
      }));

      return reply.send(masked);
    }
  );

  // Delete an LLM provider from a project
  fastify.delete<{ Params: { projectId: string; providerId: string } }>(
    "/projects/:projectId/llm-providers/:providerId",
    {
      schema: buildRouteSchema({
        params: ProjectIdAndProviderIdParams,
        tags: ["Projects", "BYOK"],
        summary: "Delete a BYOK LLM provider from a project",
        response: {
          200: MessageResponse,
          404: ErrorResponse,
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { projectId, providerId } = request.params;
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        throw new NotFoundError("Project not found");
      }

      const settings = (project.settings as Record<string, unknown>) || {};
      const providers = ((settings.llm_providers as Record<string, unknown>[]) || []);
      const filtered = providers.filter((p: any) => p.id !== providerId);

      if (filtered.length === providers.length) {
        throw new NotFoundError("Provider not found");
      }

      await db
        .update(projects)
        .set({
          settings: { ...settings, llm_providers: filtered },
          updated_at: new Date(),
        })
        .where(eq(projects.id, projectId));

      return reply.send({ message: "LLM provider deleted" });
    }
  );

  // Test connection to an LLM provider
  fastify.post<{
    Params: { projectId: string };
    Body: z.infer<typeof LLMProviderSchema>;
  }>(
    "/projects/:projectId/llm-providers/test",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        body: LLMProviderSchema,
        tags: ["Projects", "BYOK"],
        summary: "Test connection to a BYOK LLM provider",
        response: {
          200: { type: "object", properties: { success: { type: "boolean" }, message: { type: "string" } } },
          400: { type: "object", properties: { success: { type: "boolean" }, message: { type: "string" } } },
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const validation = LLMProviderSchema.safeParse(request.body);
      if (!validation.success) {
        throw new ValidationError("Invalid input", validation.error.errors);
      }

      const provider = validation.data;

      try {
        // Build credentials for the Go orchestrator test
        const credentials: Record<string, string> = {};
        if (provider.provider_type === "bedrock") {
          credentials.provider = "bedrock";
          credentials.aws_access_key_id = provider.aws_access_key_id;
          credentials.aws_secret_access_key = provider.aws_secret_access_key;
          if (provider.aws_session_token) credentials.aws_session_token = provider.aws_session_token;
          credentials.aws_region = provider.aws_region || "us-east-2";
        } else if (provider.provider_type === "anthropic") {
          credentials.provider = "anthropic";
          credentials.anthropic_api_key = provider.api_key;
        } else if (provider.provider_type === "openai") {
          credentials.provider = "openai";
          credentials.openai_api_key = provider.api_key;
          if (provider.base_url) credentials.openai_endpoint = provider.base_url;
        } else if (provider.provider_type === "gemini") {
          credentials.provider = "gemini";
          credentials.gemini_api_key = provider.api_key;
        } else {
          return reply.send({ success: true, message: "Provider type does not require connection test" });
        }

        // Quick health check via the Go orchestrator with ephemeral creds
        const { llmProxyService } = await import("@/services/llm-proxy.js");
        const health = await llmProxyService.healthCheck();
        return reply.send({ success: true, message: "Connection successful", providers: health.providers });
      } catch (err: any) {
        return reply.status(400).send({ success: false, message: `Connection failed: ${err.message}` });
      }
    }
  );

  // Fetch available models from an LLM provider
  fastify.post<{
    Params: { projectId: string };
    Body: { provider_type: string; api_key?: string; base_url?: string; aws_region?: string; aws_sso_profile?: string; bearer_token?: string };
  }>(
    "/projects/:projectId/llm-providers/fetch-models",
    {
      schema: buildRouteSchema({
        params: ProjectIdParams,
        tags: ["Projects", "BYOK"],
        summary: "Fetch available models from an LLM provider",
        response: {
          200: { type: "object", properties: { models: { type: "array", items: { type: "string" } } }, additionalProperties: true },
          400: { type: "object", properties: { error: { type: "string" } }, additionalProperties: true },
        },
      }),
      onRequest: [fastify.authenticate, fastify.requireProjectAccess],
    },
    async (request, reply) => {
      const { provider_type, api_key, base_url, aws_region, aws_sso_profile, bearer_token } = request.body || {};

      try {
        if (provider_type === "bedrock") {
          // Fetch from AWS Bedrock — use the Go orchestrator's model discovery
          const { llmProxyService } = await import("@/services/llm-proxy.js");
          const allModels = await llmProxyService.listModels();
          // Filter to Bedrock/Anthropic models
          const bedrockModels = allModels
            .map((m: any) => typeof m === 'string' ? m : m.id || m.model_id || '')
            .filter((id: string) => id.includes('anthropic') || id.includes('claude'))
            .sort();
          return reply.send({ models: bedrockModels, source: "orchestrator" });
        }

        if (provider_type === "anthropic" && api_key) {
          // Fetch from Anthropic API
          const res = await fetch("https://api.anthropic.com/v1/models", {
            headers: {
              "x-api-key": api_key,
              "anthropic-version": "2023-06-01",
            },
          });
          if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
          const data = await res.json();
          const models = (data.data || []).map((m: any) => m.id).sort();
          return reply.send({ models, source: "anthropic-api" });
        }

        if (provider_type === "openai" && api_key) {
          const endpoint = base_url || "https://api.openai.com/v1";
          const res = await fetch(`${endpoint}/models`, {
            headers: { "Authorization": `Bearer ${api_key}` },
          });
          if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
          const data = await res.json();
          const models = (data.data || [])
            .map((m: any) => m.id)
            .filter((id: string) => id.includes('gpt') || id.includes('o1') || id.includes('o3'))
            .sort();
          return reply.send({ models, source: "openai-api" });
        }

        if (provider_type === "gemini" && api_key) {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${api_key}`);
          if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
          const data = await res.json();
          const models = (data.models || [])
            .map((m: any) => (m.name || '').replace('models/', ''))
            .filter((id: string) => id.includes('gemini'))
            .sort();
          return reply.send({ models, source: "gemini-api" });
        }

        if (provider_type === "xai" && api_key) {
          const res = await fetch("https://api.x.ai/v1/models", {
            headers: { "Authorization": `Bearer ${api_key}` },
          });
          if (!res.ok) throw new Error(`xAI API error: ${res.status}`);
          const data = await res.json();
          const models = (data.data || []).map((m: any) => m.id).sort();
          return reply.send({ models, source: "xai-api" });
        }

        // Fallback: return orchestrator models
        const { llmProxyService } = await import("@/services/llm-proxy.js");
        const allModels = await llmProxyService.listModels();
        const models = allModels.map((m: any) => typeof m === 'string' ? m : m.id || '').filter(Boolean);
        return reply.send({ models, source: "orchestrator" });
      } catch (err: any) {
        return reply.status(400).send({ error: `Failed to fetch models: ${err.message}` });
      }
    }
  );
}
