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
