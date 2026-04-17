"use server";

const API = process.env.FASTIFY_INTERNAL_URL ?? "http://localhost:8787";

async function apiPost(path: string, body: any) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

export async function verifyToken(token: string) {
  return apiPost("/setup/verify-token", { token });
}

export async function createRealmAdmin(
  token: string,
  input: { email: string; password: string; firstName: string; lastName: string },
) {
  return apiPost("/setup/realm-admin", { token, ...input });
}

export async function finalize(token: string) {
  return apiPost("/setup/finalize", { token });
}

export async function createIdpAzure(
  token: string,
  params: { tenantId: string; clientId: string; clientSecret: string },
) {
  return apiPost("/setup/idp/azure", { token, ...params });
}

export async function createIdpOkta(
  token: string,
  params: { domain: string; clientId: string; clientSecret: string },
) {
  return apiPost("/setup/idp/okta", { token, ...params });
}

export async function createIdpGoogle(
  token: string,
  params: { hostedDomain: string; clientId: string; clientSecret: string },
) {
  return apiPost("/setup/idp/google", { token, ...params });
}

export async function createIdpSaml(
  token: string,
  params: { alias?: string; singleSignOnServiceUrl: string; entityId?: string },
) {
  return apiPost("/setup/idp/saml", { token, ...params });
}

export async function createIdpOidc(
  token: string,
  params: {
    alias?: string;
    authorizationUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    jwksUrl: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
  },
) {
  return apiPost("/setup/idp/oidc", { token, ...params });
}

// ─── Step 3: Attribute mapping ────────────────────────────────────────────

export async function createAttributeMapping(
  token: string,
  params: {
    idpAlias: string;
    emailAttr: string;
    firstNameAttr: string;
    lastNameAttr: string;
    groupAttr: string;
    roleMap: Record<string, "admin" | "architect" | "developer" | "sme">;
  },
) {
  return apiPost("/setup/mapping", { token, ...params });
}

// ─── Step 3b: MFA policy ──────────────────────────────────────────────────

export async function setMfaPolicy(
  token: string,
  policy: "all" | "admins_only" | "optional",
) {
  return apiPost("/setup/mfa", { token, policy });
}

// ─── Step 4: Test IdP connection ─────────────────────────────────────────

export async function getIdpTestUrl(alias: string): Promise<{ ok: boolean; body: { url?: string } | null }> {
  const r = await fetch(`${API}/setup/test-idp/${encodeURIComponent(alias)}`);
  return { ok: r.ok, body: await r.json().catch(() => null) };
}

// ─── Step 5: Bulk user CSV import ─────────────────────────────────────────

export async function importUsersFromCsv(
  token: string,
  rows: Array<{
    email: string;
    firstName: string;
    lastName: string;
    role: "admin" | "architect" | "developer" | "sme";
  }>,
) {
  return apiPost("/setup/users-csv", { token, rows });
}
