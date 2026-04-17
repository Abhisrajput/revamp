/**
 * Live smoke test for Keycloak integration.
 *
 * Connects to Keycloak admin, asserts realm + clients + roles are present,
 * issues a token for a temporary user, and validates it via verifyKeycloakToken.
 * Cleans up afterward. Zero LLM tokens consumed.
 *
 * Usage:
 *   pnpm --filter @revamp/api exec tsx scripts/verify-keycloak-live.ts
 *
 * Required env vars:
 *   KEYCLOAK_ADMIN_BASE_URL       (e.g. http://localhost:8080)
 *   KEYCLOAK_ADMIN_USERNAME       (master-realm admin user)
 *   KEYCLOAK_ADMIN_PASSWORD       (master-realm admin password)
 *   KEYCLOAK_ISSUER               (e.g. http://localhost:8080/realms/revamp)
 *   KEYCLOAK_JWKS_URI             (e.g. http://localhost:8080/realms/revamp/protocol/openid-connect/certs)
 *   KEYCLOAK_AUDIENCE             (e.g. revamp-web,revamp-vscode)
 */

import "dotenv/config";
import { KeycloakAdmin } from "../src/services/keycloak-admin.js";
import { verifyKeycloakToken } from "../src/services/keycloak-jwks.js";

const REALM = "revamp";

async function getMasterAdminToken(baseUrl: string): Promise<string> {
  const r = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: process.env.KEYCLOAK_ADMIN_USERNAME!,
      password: process.env.KEYCLOAK_ADMIN_PASSWORD!,
    }),
  });
  if (!r.ok) throw new Error(`Admin login failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { access_token: string };
  return j.access_token;
}

async function main() {
  const base = (process.env.KEYCLOAK_ADMIN_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const issuer = process.env.KEYCLOAK_ISSUER;
  if (!issuer) throw new Error("KEYCLOAK_ISSUER not set");

  const admin = await getMasterAdminToken(base);
  const h = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" };

  // 1) realm sanity
  const realmRes = await fetch(`${base}/admin/realms/${REALM}`, { headers: h });
  if (!realmRes.ok) throw new Error(`Realm '${REALM}' not found (${realmRes.status})`);
  const realm = (await realmRes.json()) as { enabled: boolean };
  if (!realm.enabled) throw new Error(`Realm '${REALM}' is disabled`);

  const clients = (await fetch(`${base}/admin/realms/${REALM}/clients`, { headers: h }).then((r) => r.json())) as any[];
  const clientIds = clients.map((c) => c.clientId);
  for (const id of ["revamp-web", "revamp-vscode"]) {
    if (!clientIds.includes(id)) throw new Error(`Client '${id}' missing`);
  }

  const roles = (await fetch(`${base}/admin/realms/${REALM}/roles`, { headers: h }).then((r) => r.json())) as any[];
  const roleNames = roles.map((r: any) => r.name);
  for (const role of ["admin", "architect", "developer", "sme"]) {
    if (!roleNames.includes(role)) throw new Error(`Role '${role}' missing`);
  }

  console.log("✓ realm, clients, roles present");

  // 2) create temp user
  const email = `smoke-${Date.now()}@example.com`;
  const kc = new KeycloakAdmin();
  await kc.login();
  const sub = await kc.createUser(REALM, {
    email,
    firstName: "Smoke",
    lastName: "Test",
    enabled: true,
  });
  // Clear Keycloak's auto-attached UPDATE_PROFILE required-action so the direct-grant works
  const userBody = await fetch(`${base}/admin/realms/${REALM}/users/${sub}`, { headers: h }).then((r) => r.json());
  await fetch(`${base}/admin/realms/${REALM}/users/${sub}`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ ...userBody, requiredActions: [] }),
  });
  await kc.assignRealmRoleToUser(REALM, sub, "developer");
  // Set a credential via the admin API
  await fetch(`${base}/admin/realms/${REALM}/users/${sub}/reset-password`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ type: "password", value: "smoke-pwd-123", temporary: false }),
  });
  console.log(`✓ created temp user ${email} / ${sub}`);

  // 3) enable direct grant temporarily + clear PKCE (for this smoke test only)
  const webClient = clients.find((c: any) => c.clientId === "revamp-web");
  const webId = webClient.id;
  const origDG = webClient.directAccessGrantsEnabled;
  const origPkce = webClient.attributes?.["pkce.code.challenge.method"];

  const patchedWeb = {
    ...webClient,
    directAccessGrantsEnabled: true,
    attributes: { ...webClient.attributes, "pkce.code.challenge.method": "" },
  };
  await fetch(`${base}/admin/realms/${REALM}/clients/${webId}`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify(patchedWeb),
  });

  try {
    // 4) exchange creds for a token
    const tRes = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "revamp-web",
        username: email,
        password: "smoke-pwd-123",
      }),
    });
    if (!tRes.ok) throw new Error(`Token exchange failed: ${tRes.status} ${await tRes.text()}`);
    const t = (await tRes.json()) as { access_token: string };

    // 5) verify via our validator
    const claims = await verifyKeycloakToken(t.access_token);
    if (claims.email !== email) throw new Error(`Email mismatch: ${claims.email}`);
    if (claims.role !== "developer") throw new Error(`Role mismatch: ${claims.role}`);
    console.log(`✓ verified token for ${claims.email} with role ${claims.role}`);
  } finally {
    // 6) cleanup
    await fetch(`${base}/admin/realms/${REALM}/users/${sub}`, {
      method: "DELETE",
      headers: h,
    });
    await fetch(`${base}/admin/realms/${REALM}/clients/${webId}`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({
        ...webClient,
        directAccessGrantsEnabled: origDG,
        attributes: {
          ...webClient.attributes,
          "pkce.code.challenge.method": origPkce ?? "S256",
        },
      }),
    });
    console.log("✓ cleaned up");
  }

  console.log("\n✅ Keycloak live smoke test passed");
}

main().catch((err) => {
  console.error("\n❌ SMOKE TEST FAILED\n", err);
  process.exit(1);
});
