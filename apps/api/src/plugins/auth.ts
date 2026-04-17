/**
 * Auth plugin dispatcher.
 *
 * LEGACY_AUTH_ENABLED=true → legacy JWT + bcrypt path (plugins/auth-legacy.ts).
 * default                  → Keycloak JWKS path (plugins/auth-keycloak.ts).
 *
 * Legacy path kept during the Keycloak rollout window; removed after migration 3.
 *
 * Named exports preserved for backward-compat with existing importers:
 *   - authPlugin: named alias for the default fp export (server.ts uses this form).
 *   - UserRole: re-exported from auth-legacy so routes/auth.ts keeps compiling.
 */

import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

// Re-export UserRole so existing importers (routes/auth.ts) keep compiling.
export type { UserRole } from "./auth-legacy.js";

const plugin: FastifyPluginAsync = async (app) => {
  if (process.env.LEGACY_AUTH_ENABLED === "true") {
    const legacy = await import("./auth-legacy.js");
    await app.register(legacy.authPlugin);
    return;
  }
  const keycloak = await import("./auth-keycloak.js");
  await app.register(keycloak.default);
};

export const authPlugin = fp(plugin, { name: "auth" });
export default authPlugin;
