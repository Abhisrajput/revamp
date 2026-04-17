import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("fetch", fetchMock);

import { KeycloakAdmin } from "@/services/keycloak-admin.js";

const ok = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("KeycloakAdmin", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.KEYCLOAK_ADMIN_BASE_URL = "http://kc";
    process.env.KEYCLOAK_ADMIN_USERNAME = "admin";
    process.env.KEYCLOAK_ADMIN_PASSWORD = "pwd";
  });

  it("login() posts admin credentials and caches the access token", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ access_token: "tkn", expires_in: 60, token_type: "Bearer" }),
    );
    const kc = new KeycloakAdmin();
    await kc.login();
    const firstCall = fetchMock.mock.calls[0][0] as string;
    expect(firstCall).toContain("/realms/master/protocol/openid-connect/token");
    // Reuses the token on the next call
    await kc.login();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("createUser() POSTs to /admin/realms/revamp/users and returns the created id from Location header", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: "tkn", expires_in: 60, token_type: "Bearer" }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 201,
          headers: { Location: "http://kc/admin/realms/revamp/users/abc-123" },
        }),
      );
    const kc = new KeycloakAdmin();
    const id = await kc.createUser("revamp", {
      email: "u@example.com",
      firstName: "U",
      lastName: "Ser",
      requiredActions: ["UPDATE_PASSWORD"],
    });
    expect(id).toBe("abc-123");
  });

  it("findUserByEmail() returns existing user id or null", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: "tkn", expires_in: 60, token_type: "Bearer" }))
      .mockResolvedValueOnce(ok([{ id: "xyz", email: "u@example.com" }]));
    const kc = new KeycloakAdmin();
    const id = await kc.findUserByEmail("revamp", "u@example.com");
    expect(id).toBe("xyz");

    fetchMock.mockResolvedValueOnce(ok([]));
    const missing = await kc.findUserByEmail("revamp", "nobody@example.com");
    expect(missing).toBeNull();
  });

  it("createIdentityProvider() POSTs broker config to /admin/realms/revamp/identity-provider/instances", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: "tkn", expires_in: 60, token_type: "Bearer" }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const kc = new KeycloakAdmin();
    await kc.createIdentityProvider("revamp", {
      alias: "azure",
      providerId: "saml",
      config: { singleSignOnServiceUrl: "https://login.microsoftonline.com/.../saml2" },
    });
    const call = fetchMock.mock.calls[1][0] as string;
    expect(call).toContain("/admin/realms/revamp/identity-provider/instances");
  });
});
