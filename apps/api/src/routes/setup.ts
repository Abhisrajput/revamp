import type { FastifyPluginAsync } from "fastify";
import { verifyBootstrapToken, markSetupComplete, isSetupComplete } from "@/services/setup-token.js";
import { KeycloakAdmin } from "@/services/keycloak-admin.js";

const setupRoutes: FastifyPluginAsync = async (app) => {
  app.get("/setup/status", async () => ({ complete: await isSetupComplete() }));

  app.post("/setup/verify-token", async (req: any, reply) => {
    const { token } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    return { ok: true };
  });

  // Step 1 — create realm admin
  app.post("/setup/realm-admin", async (req: any, reply) => {
    const { token, email, firstName, lastName } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    const kc = new KeycloakAdmin();
    const sub = await kc.createUser("revamp", { email, firstName, lastName, enabled: true });
    await kc.assignRealmRoleToUser("revamp", sub, "admin");
    // Note: password setting moves to Task 12 (wizard UI); the created user has
    // no credential here and must get one via Keycloak's password-reset flow OR
    // via an admin reset API call that Task 12 will add.
    return { ok: true, userId: sub };
  });

  // Step 6 — finalize
  app.post("/setup/finalize", async (req: any, reply) => {
    const { token } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    await markSetupComplete();
    return { ok: true };
  });
};

export default setupRoutes;
