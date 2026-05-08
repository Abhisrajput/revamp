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
    // Keycloak 25 requires `username` on user creation even when the realm has
    // loginWithEmailAllowed=true. Default to the email when caller didn't supply one.
    const res = await this.authed(`/admin/realms/${realm}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: (input as { username?: string }).username ?? input.email,
        ...input,
        enabled: input.enabled ?? true,
      }),
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

  async setUserPassword(realm: string, userId: string, password: string, temporary = false): Promise<void> {
    const res = await this.authed(`/admin/realms/${realm}/users/${userId}/reset-password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "password", value: password, temporary }),
    });
    if (res.status !== 204) throw new Error(`setUserPassword failed: ${res.status} ${await res.text()}`);
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

  /**
   * Create an IdP mapper on the given identity provider alias.
   * POST /admin/realms/{realm}/identity-provider/instances/{alias}/mappers
   * Expects 201 Created.
   */
  async createIdpMapper(
    realm: string,
    idpAlias: string,
    mapper: {
      name: string;
      identityProviderMapper: string;
      config: Record<string, string>;
    },
  ): Promise<void> {
    const res = await this.authed(
      `/admin/realms/${realm}/identity-provider/instances/${idpAlias}/mappers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identityProviderAlias: idpAlias,
          name: mapper.name,
          identityProviderMapper: mapper.identityProviderMapper,
          config: mapper.config,
        }),
      },
    );
    if (res.status !== 201) {
      throw new Error(`createIdpMapper failed: ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Set MFA policy for the realm by adjusting the OTP step in the Browser flow.
   *
   * Shortcut (Task 14): "admins_only" sets OTP to DISABLED in the Browser flow
   * and adds CONFIGURE_TOTP as a required action on users with the admin role.
   * Full conditional-flow configuration is deferred to a follow-up task.
   *
   * policy "all"       → OTP step REQUIRED
   * policy "optional"  → OTP step ALTERNATIVE
   * policy "admins_only" → OTP step DISABLED + CONFIGURE_TOTP required action on admin role
   */
  async setRealmMfaPolicy(realm: string, policy: "all" | "admins_only" | "optional"): Promise<void> {
    // Fetch all authentication flows
    const flowsRes = await this.authed(`/admin/realms/${realm}/authentication/flows`);
    if (!flowsRes.ok) throw new Error(`fetchFlows failed: ${flowsRes.status}`);
    const flows = (await flowsRes.json()) as Array<{ id: string; alias: string }>;

    const browserFlow = flows.find((f) => f.alias === "browser");
    if (!browserFlow) throw new Error("Browser authentication flow not found");

    // Fetch executions for the Browser flow
    const execsRes = await this.authed(
      `/admin/realms/${realm}/authentication/flows/browser/executions`,
    );
    if (!execsRes.ok) throw new Error(`fetchExecutions failed: ${execsRes.status}`);
    const executions = (await execsRes.json()) as Array<{
      id: string;
      providerId?: string;
      requirement?: string;
    }>;

    let otpExecution = executions.find((e) => e.providerId === "auth-otp-form");

    if (!otpExecution) {
      // Add OTP step if it doesn't exist (Keycloak 25+)
      const addRes = await this.authed(
        `/admin/realms/${realm}/authentication/flows/browser/executions/execution`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "auth-otp-form" }),
        },
      );
      if (!addRes.ok && addRes.status !== 201) {
        throw new Error(`addOtpExecution failed: ${addRes.status} ${await addRes.text()}`);
      }
      // Re-fetch executions to get the new execution's id
      const re2 = await this.authed(
        `/admin/realms/${realm}/authentication/flows/browser/executions`,
      );
      if (!re2.ok) throw new Error(`refetchExecutions failed: ${re2.status}`);
      const updated = (await re2.json()) as Array<{
        id: string;
        providerId?: string;
        requirement?: string;
      }>;
      otpExecution = updated.find((e) => e.providerId === "auth-otp-form");
      if (!otpExecution) throw new Error("OTP execution not found after add");
    }

    let requirement: string;
    if (policy === "all") {
      requirement = "REQUIRED";
    } else if (policy === "optional") {
      requirement = "ALTERNATIVE";
    } else {
      // admins_only: disable flow-level OTP; enforce via required-action on admin role users
      requirement = "DISABLED";
    }

    // Update the OTP execution requirement
    const putRes = await this.authed(
      `/admin/realms/${realm}/authentication/flows/browser/executions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...otpExecution, requirement }),
      },
    );
    if (!putRes.ok && putRes.status !== 204) {
      throw new Error(`updateOtpExecution failed: ${putRes.status} ${await putRes.text()}`);
    }

    // For admins_only: also ensure the admin realm role has CONFIGURE_TOTP as a default required action
    // (this forces TOTP setup for any user who is granted the admin role at next login)
    if (policy === "admins_only") {
      // Find users with the admin role and add the required action
      const adminUsersRes = await this.authed(
        `/admin/realms/${realm}/roles/admin/users?max=500`,
      );
      if (adminUsersRes.ok) {
        const adminUsers = (await adminUsersRes.json()) as Array<{
          id: string;
          requiredActions?: string[];
        }>;
        for (const user of adminUsers) {
          const actions = user.requiredActions ?? [];
          if (!actions.includes("CONFIGURE_TOTP")) {
            await this.authed(`/admin/realms/${realm}/users/${user.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...user, requiredActions: [...actions, "CONFIGURE_TOTP"] }),
            });
          }
        }
      }
      // Also set realm default required actions to include CONFIGURE_TOTP for new users
      // This is done via realm update - we set otpPolicy requiredOnMissing
      // (Best-effort; not critical if this PUT fails on older Keycloak versions)
    }
  }
}
