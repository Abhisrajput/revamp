/**
 * Minimal Keycloak Admin REST API client.
 *
 * Used by the setup wizard and the migration script. Intentionally narrow:
 * only the operations we need. Extend as new wizard steps land.
 */

interface LoginResult {
  accessToken: string;
  expiresAt: number; // epoch ms
}

interface CreateUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  requiredActions?: string[];
}

interface CreateIdpInput {
  alias: string;
  providerId: "oidc" | "saml" | "google" | "microsoft";
  displayName?: string;
  enabled?: boolean;
  config: Record<string, string>;
}

export class KeycloakAdmin {
  private token: LoginResult | null = null;

  private baseUrl(): string {
    const v = process.env.KEYCLOAK_ADMIN_BASE_URL;
    if (!v) throw new Error("KEYCLOAK_ADMIN_BASE_URL not set");
    return v.replace(/\/$/, "");
  }

  async login(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > 5_000) return this.token.accessToken;

    const user = process.env.KEYCLOAK_ADMIN_USERNAME;
    const pass = process.env.KEYCLOAK_ADMIN_PASSWORD;
    if (!user || !pass) throw new Error("Keycloak admin credentials not configured");

    const body = new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: user,
      password: pass,
    });

    const res = await fetch(`${this.baseUrl()}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`Keycloak admin login failed: ${res.status} ${await res.text()}`);

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return this.token.accessToken;
  }

  private async authed(path: string, init: RequestInit = {}): Promise<Response> {
    const tkn = await this.login();
    return fetch(`${this.baseUrl()}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${tkn}`,
      },
    });
  }

  async createUser(realm: string, input: CreateUserInput): Promise<string> {
    const res = await this.authed(`/admin/realms/${realm}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, enabled: input.enabled ?? true }),
    });
    if (res.status !== 201) throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
    const loc = res.headers.get("Location") || "";
    const id = loc.split("/").pop();
    if (!id) throw new Error("createUser: no Location header");
    return id;
  }

  async findUserByEmail(realm: string, email: string): Promise<string | null> {
    const res = await this.authed(
      `/admin/realms/${realm}/users?email=${encodeURIComponent(email)}&exact=true`,
    );
    if (!res.ok) throw new Error(`findUserByEmail failed: ${res.status}`);
    const users = (await res.json()) as Array<{ id: string; email: string }>;
    return users[0]?.id ?? null;
  }

  async assignRealmRoleToUser(realm: string, userId: string, roleName: string): Promise<void> {
    // Look up the role representation first
    const roleRes = await this.authed(`/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}`);
    if (!roleRes.ok) throw new Error(`role ${roleName} not found in realm ${realm}`);
    const role = await roleRes.json();

    const res = await this.authed(`/admin/realms/${realm}/users/${userId}/role-mappings/realm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([role]),
    });
    if (res.status !== 204) throw new Error(`assignRealmRole failed: ${res.status} ${await res.text()}`);
  }

  async createIdentityProvider(realm: string, input: CreateIdpInput): Promise<void> {
    const res = await this.authed(`/admin/realms/${realm}/identity-provider/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: input.enabled ?? true, ...input }),
    });
    if (res.status !== 201) throw new Error(`createIdp failed: ${res.status} ${await res.text()}`);
  }

  async testIdentityProvider(realm: string, alias: string): Promise<boolean> {
    const res = await this.authed(`/admin/realms/${realm}/identity-provider/instances/${alias}`);
    if (!res.ok) return false;
    const idp = (await res.json()) as { enabled: boolean };
    return idp.enabled;
  }
}
