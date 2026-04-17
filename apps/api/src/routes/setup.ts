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

  // ─── Identity Provider registration (Step 2 of the wizard) ─────────

  app.post("/setup/idp/azure", async (req: any, reply) => {
    const { token, tenantId, clientId, clientSecret } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    const kc = new KeycloakAdmin();
    await kc.createIdentityProvider("revamp", {
      alias: "azure",
      providerId: "oidc",
      displayName: "Microsoft / Azure AD",
      config: {
        authorizationUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
        jwksUrl: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        clientId,
        clientSecret,
        defaultScope: "openid profile email",
        syncMode: "FORCE",
      },
    });
    return { ok: true };
  });

  app.post("/setup/idp/okta", async (req: any, reply) => {
    const { token, domain, clientId, clientSecret } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    const kc = new KeycloakAdmin();
    await kc.createIdentityProvider("revamp", {
      alias: "okta",
      providerId: "oidc",
      displayName: "Okta",
      config: {
        authorizationUrl: `https://${domain}/oauth2/v1/authorize`,
        tokenUrl: `https://${domain}/oauth2/v1/token`,
        userInfoUrl: `https://${domain}/oauth2/v1/userinfo`,
        jwksUrl: `https://${domain}/oauth2/v1/keys`,
        issuer: `https://${domain}`,
        clientId,
        clientSecret,
        defaultScope: "openid profile email groups",
        syncMode: "FORCE",
      },
    });
    return { ok: true };
  });

  app.post("/setup/idp/google", async (req: any, reply) => {
    const { token, hostedDomain, clientId, clientSecret } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    const kc = new KeycloakAdmin();
    await kc.createIdentityProvider("revamp", {
      alias: "google",
      providerId: "google",
      displayName: "Google Workspace",
      config: {
        clientId,
        clientSecret,
        hostedDomain,
        defaultScope: "openid profile email",
      },
    });
    return { ok: true };
  });

  app.post("/setup/idp/saml", async (req: any, reply) => {
    const { token, alias, singleSignOnServiceUrl, entityId } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    const kc = new KeycloakAdmin();
    await kc.createIdentityProvider("revamp", {
      alias: alias || "saml",
      providerId: "saml",
      displayName: "SAML 2.0 IdP",
      config: {
        singleSignOnServiceUrl,
        entityId: entityId || "revamp",
        postBindingResponse: "true",
        nameIDPolicyFormat:
          "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      },
    });
    return { ok: true };
  });

  app.post("/setup/idp/oidc", async (req: any, reply) => {
    const {
      token,
      alias,
      authorizationUrl,
      tokenUrl,
      userInfoUrl,
      jwksUrl,
      issuer,
      clientId,
      clientSecret,
    } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    const kc = new KeycloakAdmin();
    await kc.createIdentityProvider("revamp", {
      alias: alias || "oidc",
      providerId: "oidc",
      displayName: "OIDC IdP",
      config: {
        authorizationUrl,
        tokenUrl,
        userInfoUrl,
        jwksUrl,
        issuer,
        clientId,
        clientSecret,
        defaultScope: "openid profile email",
      },
    });
    return { ok: true };
  });
};

export default setupRoutes;
