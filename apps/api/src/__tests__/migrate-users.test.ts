import { describe, it, expect, vi, beforeEach } from "vitest";

const findUserByEmailMock = vi.hoisted(() => vi.fn());
const createUserMock      = vi.hoisted(() => vi.fn());
const assignRoleMock      = vi.hoisted(() => vi.fn());
const updateMock          = vi.hoisted(() => vi.fn(async () => ({})));
const mockUsers = vi.hoisted(() => [
  { id: "1", email: "a@example.com", first_name: "A", last_name: "One", role: "developer", keycloak_sub: null },
  { id: "2", email: "b@example.com", first_name: "B", last_name: "Two", role: "admin",     keycloak_sub: null },
  { id: "3", email: "c@example.com", first_name: "C", last_name: "Three", role: "developer", keycloak_sub: "already-linked" },
]);

vi.mock("@/services/keycloak-admin.js", () => ({
  KeycloakAdmin: vi.fn().mockImplementation(function () {
    return {
      login: vi.fn(),
      findUserByEmail: findUserByEmailMock,
      createUser: createUserMock,
      assignRealmRoleToUser: assignRoleMock,
    };
  }),
}));

vi.mock("@/db/index.js", () => ({
  db: {
    query: { users: { findMany: vi.fn(async () => mockUsers) } },
    update: () => ({ set: () => ({ where: updateMock }) }),
  },
}));

vi.mock("@/db/schema.js", () => ({ users: { id: {}, keycloak_sub: {} } }));

import { linkUsersToKeycloak } from "../../scripts/migrate-users-to-keycloak.js";

describe("linkUsersToKeycloak", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates Keycloak users for each un-linked REVAMP user", async () => {
    findUserByEmailMock.mockResolvedValue(null);
    createUserMock.mockImplementation(async () => `kc-${Math.random()}`);

    const result = await linkUsersToKeycloak({ realm: "revamp", dryRun: false });
    expect(createUserMock).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it("reuses existing Keycloak user when email already present", async () => {
    findUserByEmailMock.mockImplementation(async (_: string, email: string) =>
      email === "a@example.com" ? "existing-kc-id" : null,
    );
    createUserMock.mockImplementation(async () => `kc-${Math.random()}`);

    const result = await linkUsersToKeycloak({ realm: "revamp", dryRun: false });
    expect(result.linked_existing).toBe(1);
    expect(result.created).toBe(1);
  });

  it("dry run does not call createUser or update", async () => {
    findUserByEmailMock.mockResolvedValue(null);
    const result = await linkUsersToKeycloak({ realm: "revamp", dryRun: true });
    expect(createUserMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.would_create).toBe(2);
  });
});
