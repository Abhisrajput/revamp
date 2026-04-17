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
