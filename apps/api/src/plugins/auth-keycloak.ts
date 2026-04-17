/**
 * Fastify auth plugin backed by Keycloak JWKS.
 *
 * Decorates:
 *   - app.requireAuth / app.authenticate (alias): preHandler that enforces a valid
 *     Keycloak bearer token. Populates BOTH request.keycloakUser AND (req as any).user
 *     from the token's claims, then UPSERTs the REVAMP users row keyed on keycloak_sub.
 *   - app.requireRole(role): preHandler that requires a specific realm role.
 *   - app.authorize(roles[]): preHandler that requires one of the listed RevampRoles.
 *   - app.requireProjectAdmin: preHandler for admin or project-owner access.
 *   - app.requireProjectAccess: preHandler for project membership check (:projectId param).
 *   - app.requirePipelineAccess: preHandler for pipeline membership check (:pipelineRunId param).
 *
 * Why request.keycloakUser AND request.user:
 *   The 14 existing route files access request.user.sub / .role / .organization_id.
 *   @fastify/jwt augments FastifyRequest.user via its FastifyJWT.payload declaration;
 *   the Keycloak plugin never calls jwtVerify(), so request.user is undefined in
 *   Keycloak mode unless explicitly set here. We write both properties so all routes
 *   work without modification. (req as any).user sidesteps the TypeScript type conflict
 *   between the two module augmentations — the long-term fix (merging declarations) is
 *   a separate type-cleanup task.
 *
 * Schema notes:
 *   - users.role is varchar(50) with default "developer" — safe to write any RevampRole.
 *   - users has first_name/last_name, not a single name column. The Keycloak
 *     `name` claim (display name) is stored in first_name on insert/update.
 *     Task 7 will backfill proper name splits for migrated users.
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import {
  verifyKeycloakToken,
  type KeycloakClaims,
  type RevampRole,
} from "@/services/keycloak-jwks.js";
import { db } from "@/db/index.js";
import { users, projectMembers, projects, pipelineRuns } from "@/db/schema.js";
import { eq, and } from "drizzle-orm";

/**
 * Keycloak user shape populated on request.keycloakUser after requireAuth.
 * Exported so route handlers can import the type for type-narrowing.
 */
export interface KeycloakUser {
  id: string;
  keycloak_sub: string;
  email: string;
  role: RevampRole;
  roles: string[];
  /** Alias for id — populated so existing routes that read request.user.sub continue to work. */
  sub: string;
  /** Sourced from the REVAMP users row (users table is the source of truth for org membership). Null for new users who have not yet been assigned to an org. */
  organization_id: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireAuth (Keycloak path). Undefined on the legacy JWT path. */
    keycloakUser?: KeycloakUser;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Backward-compat alias for requireAuth — existing routes call fastify.authenticate.
     *  Typed as `any` to match the auth-legacy module augmentation (TS2717 otherwise). */
    authenticate: any;
    requireRole: (
      role: RevampRole,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Typed to match the auth-legacy declaration exactly (avoids TS2717). */
    authorize: (roles: RevampRole[]) => any;
    requireProjectAdmin: any;
    requireProjectAccess: any;
    requirePipelineAccess: any;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

/**
 * UPSERT a REVAMP user row keyed on keycloak_sub.
 *
 * On first login: inserts with email, role, first_name (from display name).
 * On subsequent logins: updates email, role, last_login, updated_at.
 */
async function projectUser(
  claims: KeycloakClaims,
): Promise<{ id: string; organization_id: string | null }> {
  const existing = await db.query.users.findFirst({
    where: eq(users.keycloak_sub, claims.sub),
  });

  if (existing) {
    await db
      .update(users)
      .set({
        email: claims.email,
        ...(claims.name ? { first_name: claims.name } : {}),
        role: claims.role,
        last_login: new Date(),
        updated_at: new Date(),
      })
      .where(eq(users.id, existing.id));
    return { id: existing.id, organization_id: existing.organization_id ?? null };
  }

  const [inserted] = await db
    .insert(users)
    .values({
      keycloak_sub: claims.sub,
      email: claims.email,
      first_name: claims.name ?? claims.email,
      role: claims.role,
      last_login: new Date(),
    })
    .returning({ id: users.id });

  // New users have no org yet — setup wizard or admin will assign them.
  return { id: inserted.id, organization_id: null };
}

const plugin: FastifyPluginAsync = async (app) => {
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token)
      return reply.code(401).send({ error: "Missing bearer token" });
    try {
      const claims = await verifyKeycloakToken(token);
      const projected = await projectUser(claims);
      const userPayload = {
        id: projected.id,
        keycloak_sub: claims.sub,
        email: claims.email,
        role: claims.role,
        roles: claims.roles,
        // Fields expected by existing route handlers that read request.user.sub,
        // request.user.organization_id, and request.user.role.
        sub: projected.id,          // routes use sub as the REVAMP user primary key
        organization_id: projected.organization_id,  // sourced from the REVAMP users row — the source of truth for org membership
      };
      req.keycloakUser = userPayload;
      // Backward-compat: existing route files access request.user.sub / .role / .organization_id.
      // The legacy @fastify/jwt plugin populated request.user via JWT verification; the Keycloak
      // plugin never called jwtVerify(), so request.user stays undefined without this assignment.
      // Using (req as any) sidesteps the TypeScript conflict between @fastify/jwt's FastifyJWT
      // payload declaration and this plugin's shape — the correct long-term fix is to merge the
      // module augmentation, but that is deferred to a dedicated type-cleanup task.
      (req as any).user = userPayload;
    } catch (err) {
      req.log.warn({ err }, "keycloak token validation failed");
      return reply.code(401).send({ error: "Invalid or expired token" });
    }
  };

  const requireRole =
    (role: RevampRole) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(req, reply);
      if (reply.sent) return;
      if (!req.keycloakUser || !req.keycloakUser.roles.includes(role)) {
        return reply.code(403).send({ error: `Role '${role}' required` });
      }
    };

  // ─── authorize — enforce bearer + check a RevampRole membership ────────────
  // Ported from auth-legacy. Keycloak path: requireAuth populates (req as any).user.role.
  const authorize =
    (roles: RevampRole[]) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(req, reply);
      if (reply.sent) return;
      const user = (req as any).user;
      if (!user || !roles.includes(user.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
    };

  // ─── requireProjectAdmin — system admin OR project owner ─────────────────
  const requireProjectAdmin = async (
    req: FastifyRequest<{ Params: { projectId?: string } }>,
    reply: FastifyReply,
  ) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const user = (req as any).user;
    if (user?.role === "admin") return;
    const projectId = req.params?.projectId;
    if (!projectId) return reply.code(400).send({ error: "Project ID is required" });
    const membership = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.project_id, projectId),
        eq(projectMembers.user_id, user.sub),
      ),
    });
    if (!membership || membership.role !== "owner") {
      return reply.code(403).send({ error: "Forbidden — requires system admin or project owner role" });
    }
  };

  // ─── requireProjectAccess — user must be a project member or admin ────────
  const requireProjectAccess = async (
    req: FastifyRequest<{ Params: { projectId?: string } }>,
    reply: FastifyReply,
  ) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const user = (req as any).user;
    if (user?.role === "admin") return;
    const projectId = req.params?.projectId;
    if (!projectId) return reply.code(400).send({ error: "Project ID is required" });
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      columns: { organization_id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const membership = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.project_id, projectId),
        eq(projectMembers.user_id, user.sub),
      ),
    });
    if (!membership) return reply.code(403).send({ error: "Access denied — not a project member" });
  };

  // ─── requirePipelineAccess — user must have access to the pipeline's project ─
  const requirePipelineAccess = async (
    req: FastifyRequest<{ Params: { pipelineRunId?: string } }>,
    reply: FastifyReply,
  ) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const user = (req as any).user;
    if (user?.role === "admin") return;
    const pipelineRunId = req.params?.pipelineRunId;
    if (!pipelineRunId) return reply.code(400).send({ error: "Pipeline run ID is required" });
    const run = await db.query.pipelineRuns.findFirst({
      where: eq(pipelineRuns.id, pipelineRunId),
      columns: { project_id: true },
    });
    if (!run) return reply.code(404).send({ error: "Pipeline run not found" });
    const membership = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.project_id, run.project_id),
        eq(projectMembers.user_id, user.sub),
      ),
    });
    if (!membership) return reply.code(403).send({ error: "Access denied — not a project member" });
  };

  app.decorate("requireAuth", requireAuth);
  // Backward-compat alias — 144 existing route handlers call fastify.authenticate.
  // Both enforce a valid bearer token; keeping the alias avoids a blanket rename
  // across every route file during the Keycloak rollout.
  app.decorate("authenticate", requireAuth);
  app.decorate("requireRole", requireRole);
  app.decorate("authorize", authorize);
  app.decorate("requireProjectAdmin", requireProjectAdmin);
  app.decorate("requireProjectAccess", requireProjectAccess);
  app.decorate("requirePipelineAccess", requirePipelineAccess);
};

export default fp(plugin, { name: "auth-keycloak" });
