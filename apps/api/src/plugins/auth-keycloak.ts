/**
 * Fastify auth plugin backed by Keycloak JWKS.
 *
 * Decorates:
 *   - app.requireAuth: preHandler that enforces a valid Keycloak bearer token.
 *     Populates BOTH request.keycloakUser AND (req as any).user from the token's
 *     claims, then UPSERTs the REVAMP users row keyed on keycloak_sub.
 *   - app.requireRole(role): preHandler that requires a specific realm role.
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
import { users } from "@/db/schema.js";
import { eq } from "drizzle-orm";

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
  /** Always null for Keycloak-authenticated users until org-scoping is wired in Task 7. */
  organization_id: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireAuth (Keycloak path). Undefined on the legacy JWT path. */
    keycloakUser?: KeycloakUser;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      role: RevampRole,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
async function projectUser(claims: KeycloakClaims): Promise<{ id: string }> {
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
    return { id: existing.id };
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

  return { id: inserted.id };
}

const plugin: FastifyPluginAsync = async (app) => {
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token)
      return reply.code(401).send({ error: "Missing bearer token" });
    try {
      const claims = await verifyKeycloakToken(token);
      const { id } = await projectUser(claims);
      const userPayload = {
        id,
        keycloak_sub: claims.sub,
        email: claims.email,
        role: claims.role,
        roles: claims.roles,
        // Fields expected by existing route handlers that read request.user.sub,
        // request.user.organization_id, and request.user.role.
        sub: id,                    // routes use sub as the REVAMP user primary key
        organization_id: null as string | null,  // Keycloak users are not yet org-scoped; routes that require org_id must be revisited in Task 7
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

  app.decorate("requireAuth", requireAuth);
  app.decorate("requireRole", requireRole);
};

export default fp(plugin, { name: "auth-keycloak" });
