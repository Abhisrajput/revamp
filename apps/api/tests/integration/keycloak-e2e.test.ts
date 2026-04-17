import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import path from "node:path";

describe("Keycloak end-to-end (Testcontainers)", () => {
  let kc: StartedTestContainer;
  let issuerBase: string; // e.g. http://host:port

  beforeAll(async () => {
    kc = await new GenericContainer("quay.io/keycloak/keycloak:25.0")
      .withEnvironment({
        KEYCLOAK_ADMIN: "admin",
        KEYCLOAK_ADMIN_PASSWORD: "admin",
        KC_HTTP_ENABLED: "true",
        KC_HOSTNAME_STRICT: "false",
      })
      .withBindMounts([
        {
          source: path.resolve(__dirname, "../../../..", "infra/docker/keycloak"),
          target: "/opt/keycloak/data/import",
          mode: "ro",
        },
      ])
      .withCommand(["start-dev", "--import-realm"])
      .withExposedPorts(8080)
      .withWaitStrategy(
        Wait.forHttp("/realms/revamp/.well-known/openid-configuration", 8080)
          .forStatusCode(200),
      )
      .withStartupTimeout(180_000)
      .start();

    const host = kc.getHost();
    const port = kc.getMappedPort(8080);
    issuerBase = `http://${host}:${port}`;

    process.env.KEYCLOAK_ISSUER = `${issuerBase}/realms/revamp`;
    process.env.KEYCLOAK_JWKS_URI = `${issuerBase}/realms/revamp/protocol/openid-connect/certs`;
    process.env.KEYCLOAK_AUDIENCE = "revamp-web,revamp-vscode";
  }, 200_000);

  afterAll(async () => {
    if (kc) await kc.stop();
  });

  it("issues a JWT via direct grant and verifyKeycloakToken accepts it", async () => {
    // Get admin token in master realm
    const adminTokenRes = await fetch(
      `${issuerBase}/realms/master/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: "admin",
          password: "admin",
        }),
      },
    );
    expect(adminTokenRes.ok).toBe(true);
    const { access_token: adminToken } = (await adminTokenRes.json()) as { access_token: string };

    // Get the revamp-web client
    const clients = (await fetch(
      `${issuerBase}/admin/realms/revamp/clients?clientId=revamp-web`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    ).then((r) => r.json())) as any[];
    expect(clients.length).toBe(1);
    const web = clients[0];

    // Enable direct-grant + disable PKCE (PKCE breaks direct grant flow in KC 25)
    // + add audience mapper so the token carries aud: revamp-web
    const putRes = await fetch(`${issuerBase}/admin/realms/revamp/clients/${web.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...web,
        directAccessGrantsEnabled: true,
        attributes: { ...web.attributes, "pkce.code.challenge.method": "" },
      }),
    });
    expect(putRes.status).toBe(204);

    // Add an audience protocol mapper so access tokens carry aud: revamp-web
    // (the realm-export has no mapper; without it KC defaults aud to "account")
    const mapperRes = await fetch(
      `${issuerBase}/admin/realms/revamp/clients/${web.id}/protocol-mappers/models`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "revamp-web-audience",
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          config: {
            "included.client.audience": "revamp-web",
            "id.token.claim": "false",
            "access.token.claim": "true",
          },
        }),
      },
    );
    expect(mapperRes.status).toBe(201);

    // Create a test user
    const createRes = await fetch(`${issuerBase}/admin/realms/revamp/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "t-user",
        email: "t@example.com",
        enabled: true,
        emailVerified: true,
        firstName: "T",
        lastName: "User",
        requiredActions: [],
        credentials: [{ type: "password", value: "t-pwd", temporary: false }],
      }),
    });
    expect(createRes.status).toBe(201);
    const userId = createRes.headers.get("Location")!.split("/").pop();

    // PUT the user again to ensure requiredActions is empty.
    // Keycloak 25 can silently add UPDATE_PROFILE even when not requested,
    // which causes "Account is not fully set up" on direct grant.
    const userState = (await fetch(`${issuerBase}/admin/realms/revamp/users/${userId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((r) => r.json())) as any;
    await fetch(`${issuerBase}/admin/realms/revamp/users/${userId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...userState, requiredActions: [] }),
    });

    // Assign 'developer' role
    const roleRes = await fetch(`${issuerBase}/admin/realms/revamp/roles/developer`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const role = await roleRes.json();
    const assignRes = await fetch(
      `${issuerBase}/admin/realms/revamp/users/${userId}/role-mappings/realm`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([role]),
      },
    );
    expect(assignRes.status).toBe(204);

    // Exchange username/password for a token
    const tokenRes = await fetch(
      `${issuerBase}/realms/revamp/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "revamp-web",
          username: "t-user",
          password: "t-pwd",
        }),
      },
    );
    expect(tokenRes.ok).toBe(true);
    const { access_token: userToken } = (await tokenRes.json()) as { access_token: string };

    // Verify via our validator
    const { verifyKeycloakToken, __resetJwksCacheForTests } = await import(
      "../../src/services/keycloak-jwks.js"
    );
    __resetJwksCacheForTests();
    const claims = await verifyKeycloakToken(userToken);
    expect(claims.email).toBe("t@example.com");
    expect(claims.role).toBe("developer");
    expect(claims.roles).toContain("developer");
  }, 120_000);
});
