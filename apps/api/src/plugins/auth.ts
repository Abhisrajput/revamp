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
  // JWT_SECRET must always be set — no fallback allowed in any environment.
  // In development, generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      "FATAL: JWT_SECRET environment variable is not set. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  await fastify.register(fastifyJwt, {
    secret: jwtSecret,
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || "24h",
    },
    // Extract JWT from Authorization header first, then fall back to HttpOnly cookie.
    // This supports both API clients (Bearer token) and browsers (cookie).
    cookie: {
      cookieName: "revamp-token",
      signed: false,
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

        const project = await db.query.projects.findFirst({
          where: eq(projects.id, projectId),
          columns: { organization_id: true },
        });

        if (!project) {
          return reply.status(404).send({ error: "Project not found" });
        }

        // Explicit membership is always required — visibility only affects UI discovery
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

        const project = await db.query.projects.findFirst({
          where: eq(projects.id, run.project_id),
          columns: { organization_id: true },
        });

        if (!project) {
          return reply.status(404).send({ error: "Project not found" });
        }

        // Explicit membership is always required
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
