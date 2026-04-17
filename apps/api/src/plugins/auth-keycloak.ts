/**
 * Fastify auth plugin backed by Keycloak JWKS.
 *
 * Decorates:
 *   - app.requireAuth: preHandler that enforces a valid Keycloak bearer token.
 *     Populates request.keycloakUser from the token's claims and UPSERTs the
 *     REVAMP users row keyed on keycloak_sub.
 *   - app.requireRole(role): preHandler that requires a specific realm role.
 *
 * Why request.keycloakUser and not request.user:
 *   @fastify/jwt already augments FastifyRequest.user (typed via FastifyJWT.payload).
 *   Re-declaring user with a different shape causes a TypeScript conflict because
 *   both declarations exist at compile time even though only one plugin loads at
 *   runtime. Using a separate property avoids this conflict cleanly and lets both
 *   auth worlds coexist during the rollout window.
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
      req.keycloakUser = {
        id,
        keycloak_sub: claims.sub,
        email: claims.email,
        role: claims.role,
        roles: claims.roles,
      };
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
