import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRemoteJWKSet = vi.hoisted(() => vi.fn());
const mockJwtVerify = vi.hoisted(() => vi.fn());

vi.mock("jose", () => ({
  createRemoteJWKSet: mockRemoteJWKSet,
  jwtVerify: mockJwtVerify,
}));

import { verifyKeycloakToken, __resetJwksCacheForTests } from "@/services/keycloak-jwks.js";

describe("verifyKeycloakToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetJwksCacheForTests();
    process.env.KEYCLOAK_ISSUER = "http://kc/realms/revamp";
    process.env.KEYCLOAK_JWKS_URI = "http://kc/realms/revamp/protocol/openid-connect/certs";
    process.env.KEYCLOAK_AUDIENCE = "revamp-web,revamp-vscode";
  });

  it("returns claims on a valid token", async () => {
    mockRemoteJWKSet.mockReturnValue("jwks-fn");
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: "user-uuid",
        email: "u@example.com",
        preferred_username: "u",
        name: "U Ser",
        iss: "http://kc/realms/revamp",
        aud: "revamp-web",
        exp: Math.floor(Date.now() / 1000) + 600,
        realm_access: { roles: ["developer"] },
      },
      protectedHeader: { alg: "RS256" },
    });

    const claims = await verifyKeycloakToken("eyJ...token...");
    expect(claims.sub).toBe("user-uuid");
    expect(claims.email).toBe("u@example.com");
    expect(claims.roles).toEqual(["developer"]);
  });

  it("throws on wrong issuer", async () => {
    mockRemoteJWKSet.mockReturnValue("jwks-fn");
    mockJwtVerify.mockRejectedValueOnce(new Error("unexpected \"iss\" claim value"));
    await expect(verifyKeycloakToken("bad")).rejects.toThrow(/iss/);
  });

  it("throws on expired token", async () => {
    mockRemoteJWKSet.mockReturnValue("jwks-fn");
    mockJwtVerify.mockRejectedValueOnce(new Error("\"exp\" claim timestamp check failed"));
    await expect(verifyKeycloakToken("expired")).rejects.toThrow(/exp/);
  });

  it("throws when realm_access.roles is missing", async () => {
    mockRemoteJWKSet.mockReturnValue("jwks-fn");
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: "u",
        email: "u@example.com",
        iss: "http://kc/realms/revamp",
        aud: "revamp-web",
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      protectedHeader: { alg: "RS256" },
    });
    await expect(verifyKeycloakToken("no-roles")).rejects.toThrow(/realm_access/);
  });

  it("picks the highest-privilege role from realm_access.roles", async () => {
    mockRemoteJWKSet.mockReturnValue("jwks-fn");
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: "u",
        email: "u@example.com",
        iss: "http://kc/realms/revamp",
        aud: "revamp-web",
        exp: Math.floor(Date.now() / 1000) + 600,
        realm_access: { roles: ["developer", "admin", "sme"] },
      },
      protectedHeader: { alg: "RS256" },
    });
    const claims = await verifyKeycloakToken("multi-role");
    expect(claims.role).toBe("admin");
  });

  it("throws when KEYCLOAK_AUDIENCE is unset", async () => {
    delete process.env.KEYCLOAK_AUDIENCE;
    await expect(verifyKeycloakToken("any-token")).rejects.toThrow(/KEYCLOAK_AUDIENCE/);
  });

  it("throws when KEYCLOAK_AUDIENCE is blank", async () => {
    process.env.KEYCLOAK_AUDIENCE = "   ";
    await expect(verifyKeycloakToken("any-token")).rejects.toThrow(/KEYCLOAK_AUDIENCE/);
  });
});
