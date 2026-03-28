import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fp from "fastify-plugin";
import { db } from "@/db/index.js";
import { projectMembers, projects, pipelineRuns } from "@/db/schema.js";
import { eq, and } from "drizzle-orm";

export type UserRole = "admin" | "architect" | "developer" | "sme";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: any;
    authorize: (roles: UserRole[]) => any;
    requireProjectAdmin: any;
    requireProjectAccess: any;
    requirePipelineAccess: any;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      email: string;
      role: UserRole;
      organization_id: string;
    };
  }
}

export const authPlugin = fp(async function authPlugin(fastify: FastifyInstance) {
  // ─── P1 Fix: Refuse to boot with the default JWT secret in production ───
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret && process.env.NODE_ENV === "production") {
    throw new Error(
      "FATAL: JWT_SECRET environment variable is not set. " +
      "Refusing to start in production with a default secret."
    );
  }
  if (!jwtSecret) {
    console.warn(
      "[auth] WARNING: JWT_SECRET is not set — using insecure default. " +
      "Set JWT_SECRET in .env before deploying to production."
    );
  }

  await fastify.register(fastifyJwt, {
    secret: jwtSecret || "dev-secret-change-in-production",
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || "24h",
    },
  });

  // ─── authenticate — verify JWT, return early on failure ─────────
  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (error) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
  );

  // ─── authorize — verify JWT + check role membership ─────────────
  fastify.decorate(
    "authorize",
    (roles: UserRole[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          await request.jwtVerify();
          if (!roles.includes(request.user.role)) {
            return reply.status(403).send({ error: "Forbidden" });
          }
        } catch (error) {
          return reply.status(401).send({ error: "Unauthorized" });
        }
      }
  );

  // ─── requireProjectAdmin — system admin OR project owner ────────
  fastify.decorate(
    "requireProjectAdmin",
    async (request: FastifyRequest<{ Params: { projectId?: string } }>, reply: FastifyReply) => {
      try {
        if (!request.user?.sub) {
          await request.jwtVerify();
        }

        if (request.user.role === "admin") return;

        const projectId = request.params?.projectId;
        if (!projectId) {
          return reply.status(400).send({ error: "Project ID is required" });
        }

        const membership = await db.query.projectMembers.findFirst({
          where: and(
            eq(projectMembers.project_id, projectId),
            eq(projectMembers.user_id, request.user.sub),
          ),
        });

        if (!membership || membership.role !== "owner") {
          return reply.status(403).send({
            error: "Forbidden — requires system admin or project owner role",
          });
        }
      } catch (error) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
  );

  // ─── requireProjectAccess — user must be a member of the project or admin ──
  // Use on any route with :projectId param to enforce project-level authorization.
  fastify.decorate(
    "requireProjectAccess",
    async (request: FastifyRequest<{ Params: { projectId?: string } }>, reply: FastifyReply) => {
      try {
        if (!request.user?.sub) {
          await request.jwtVerify();
        }

        if (request.user.role === "admin") return;

        const projectId = request.params?.projectId;
        if (!projectId) {
          return reply.status(400).send({ error: "Project ID is required" });
        }

        // Check organization match
        const project = await db.query.projects.findFirst({
          where: eq(projects.id, projectId),
          columns: { organization_id: true, visibility: true },
        });

        if (!project) {
          return reply.status(404).send({ error: "Project not found" });
        }

        // Same organization → access granted for non-private projects
        if (project.organization_id === request.user.organization_id && project.visibility !== "private") {
          return;
        }

        // Explicit membership required for private projects or cross-org access
        const membership = await db.query.projectMembers.findFirst({
          where: and(
            eq(projectMembers.project_id, projectId),
            eq(projectMembers.user_id, request.user.sub),
          ),
        });

        if (!membership) {
          return reply.status(403).send({ error: "Access denied — not a project member" });
        }
      } catch (error) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
  );

  // ─── requirePipelineAccess — user must have access to the pipeline's project ──
  // Use on any route with :pipelineRunId param.
  fastify.decorate(
    "requirePipelineAccess",
    async (request: FastifyRequest<{ Params: { pipelineRunId?: string } }>, reply: FastifyReply) => {
      try {
        if (!request.user?.sub) {
          await request.jwtVerify();
        }

        if (request.user.role === "admin") return;

        const pipelineRunId = request.params?.pipelineRunId;
        if (!pipelineRunId) {
          return reply.status(400).send({ error: "Pipeline run ID is required" });
        }

        // Look up the pipeline's project
        const run = await db.query.pipelineRuns.findFirst({
          where: eq(pipelineRuns.id, pipelineRunId),
          columns: { project_id: true },
        });

        if (!run) {
          return reply.status(404).send({ error: "Pipeline run not found" });
        }

        // Check project access
        const project = await db.query.projects.findFirst({
          where: eq(projects.id, run.project_id),
          columns: { organization_id: true, visibility: true },
        });

        if (!project) {
          return reply.status(404).send({ error: "Project not found" });
        }

        if (project.organization_id === request.user.organization_id && project.visibility !== "private") {
          return;
        }

        const membership = await db.query.projectMembers.findFirst({
          where: and(
            eq(projectMembers.project_id, run.project_id),
            eq(projectMembers.user_id, request.user.sub),
          ),
        });

        if (!membership) {
          return reply.status(403).send({ error: "Access denied — not a project member" });
        }
      } catch (error) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
  );
});
