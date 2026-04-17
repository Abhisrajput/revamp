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

  // ─── Step 3: Attribute mapping ────────────────────────────────────────────

  app.post("/setup/mapping", async (req: any, reply) => {
    const {
      token,
      idpAlias,
      emailAttr,
      firstNameAttr,
      lastNameAttr,
      groupAttr,
      roleMap,
    } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    if (!idpAlias) return reply.code(400).send({ error: "idpAlias is required" });

    const kc = new KeycloakAdmin();
    const realm = "revamp";

    // Determine mapper type based on whether this is SAML or OIDC
    // For SAML aliases we use saml-user-attribute-idp-mapper, otherwise oidc-*
    const isSaml = String(idpAlias).toLowerCase().includes("saml");
    const attrMapper = isSaml
      ? "saml-user-attribute-idp-mapper"
      : "oidc-user-attribute-idp-mapper";
    const roleMapper = isSaml ? "saml-role-idp-mapper" : "oidc-role-idp-mapper";

    // Create attribute mappers for email, firstName, lastName
    const attrMappings = [
      { name: "email-mapper", claim: emailAttr ?? "email", attribute: "email" },
      { name: "firstname-mapper", claim: firstNameAttr ?? "given_name", attribute: "firstName" },
      { name: "lastname-mapper", claim: lastNameAttr ?? "family_name", attribute: "lastName" },
    ];

    for (const m of attrMappings) {
      await kc.createIdpMapper(realm, idpAlias, {
        name: m.name,
        identityProviderMapper: attrMapper,
        config: {
          claim: m.claim,
          "user.attribute": m.attribute,
          syncMode: "INHERIT",
        },
      });
    }

    // Create role mappers for each entry in roleMap
    const resolvedGroupAttr = groupAttr ?? "groups";
    if (roleMap && typeof roleMap === "object") {
      for (const [groupName, role] of Object.entries(roleMap)) {
        if (!groupName || !role) continue;
        await kc.createIdpMapper(realm, idpAlias, {
          name: `role-mapper-${role}`,
          identityProviderMapper: roleMapper,
          config: {
            claim: resolvedGroupAttr,
            "claim.value": groupName,
            role: String(role),
            syncMode: "INHERIT",
          },
        });
      }
    }

    return { ok: true };
  });

  // ─── Step 3b: MFA policy ──────────────────────────────────────────────────

  app.post("/setup/mfa", async (req: any, reply) => {
    const { token, policy } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    const validPolicies = ["all", "admins_only", "optional"];
    if (!validPolicies.includes(policy)) {
      return reply.code(400).send({ error: `policy must be one of: ${validPolicies.join(", ")}` });
    }
    const kc = new KeycloakAdmin();
    await kc.setRealmMfaPolicy("revamp", policy as "all" | "admins_only" | "optional");
    return { ok: true };
  });

  // ─── Step 4: Test IdP connection ─────────────────────────────────────────

  app.get("/setup/test-idp/:alias", async (req: any, reply) => {
    const { alias } = req.params ?? {};
    const keycloakBase =
      process.env.KEYCLOAK_ADMIN_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:8080";
    const webBase = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3001";
    const callbackUrl = `${webBase}/setup/test-callback`;
    const url =
      `${keycloakBase}/realms/revamp/broker/${encodeURIComponent(alias)}/login` +
      `?client_id=revamp-app&redirect_uri=${encodeURIComponent(callbackUrl)}`;
    return { url };
  });

  // ─── Step 5: Bulk user CSV import ─────────────────────────────────────────

  app.post("/setup/users-csv", async (req: any, reply) => {
    const { token, rows } = req.body ?? {};
    if (!token || !(await verifyBootstrapToken(token))) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }
    if (!Array.isArray(rows)) {
      return reply.code(400).send({ error: "rows must be an array" });
    }

    const kc = new KeycloakAdmin();
    const realm = "revamp";
    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const { email, firstName, lastName, role } = row ?? {};
      if (!email) {
        errors.push(`Row missing email: ${JSON.stringify(row)}`);
        continue;
      }
      try {
        const existing = await kc.findUserByEmail(realm, email);
        if (existing) {
          skipped++;
          continue;
        }
        const userId = await kc.createUser(realm, {
          email,
          firstName,
          lastName,
          enabled: true,
          requiredActions: ["UPDATE_PASSWORD"],
        });
        if (role) {
          await kc.assignRealmRoleToUser(realm, userId, role);
        }
        created++;
      } catch (err: any) {
        errors.push(`${email}: ${err?.message ?? String(err)}`);
      }
    }

    return { ok: true, created, skipped, errors };
  });
};

export default setupRoutes;
