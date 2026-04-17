/**
 * Validate Keycloak-issued access tokens (RS256) against the realm JWKS.
 *
 * Caches the JWKS fetcher for the process lifetime — `createRemoteJWKSet` handles
 * key rotation internally by refreshing when an unknown `kid` is presented.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const ROLE_PRIORITY = ["admin", "architect", "developer", "sme"] as const;
export type RevampRole = (typeof ROLE_PRIORITY)[number];

export interface KeycloakClaims {
  sub: string;
  email: string;
  name?: string;
  username?: string;
  roles: string[];
  /** Highest-privilege REVAMP role derived from `roles`. */
  role: RevampRole;
  raw: JWTPayload;
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (cachedJwks) return cachedJwks;
  const uri = process.env.KEYCLOAK_JWKS_URI;
  if (!uri) throw new Error("KEYCLOAK_JWKS_URI not configured");
  cachedJwks = createRemoteJWKSet(new URL(uri));
  return cachedJwks;
}

function getExpectedAudiences(): string[] {
  const raw = process.env.KEYCLOAK_AUDIENCE || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickHighestRole(roles: string[]): RevampRole {
  for (const candidate of ROLE_PRIORITY) {
    if (roles.includes(candidate)) return candidate;
  }
  throw new Error("No REVAMP role present in realm_access.roles");
}

export async function verifyKeycloakToken(token: string): Promise<KeycloakClaims> {
  const issuer = process.env.KEYCLOAK_ISSUER;
  if (!issuer) throw new Error("KEYCLOAK_ISSUER not configured");

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer,
    audience: getExpectedAudiences(),
    algorithms: ["RS256"],
  });

  const realmAccess = (payload as any).realm_access as { roles?: string[] } | undefined;
  if (!realmAccess || !Array.isArray(realmAccess.roles)) {
    throw new Error("Token missing realm_access.roles claim");
  }

  const roles = realmAccess.roles;
  return {
    sub: String(payload.sub ?? ""),
    email: String((payload as any).email ?? ""),
    name: (payload as any).name,
    username: (payload as any).preferred_username,
    roles,
    role: pickHighestRole(roles),
    raw: payload,
  };
}

/** Test hook — clears the module-scoped JWKS cache. Do not call in production paths. */
export function __resetJwksCacheForTests(): void {
  cachedJwks = null;
}
