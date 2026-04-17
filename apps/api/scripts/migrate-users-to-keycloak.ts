/**
 * One-off idempotent migration: link each REVAMP users row to a Keycloak user.
 *
 * Usage:
 *   pnpm --filter @revamp/api exec tsx scripts/migrate-users-to-keycloak.ts [--dry-run]
 *
 * Behavior:
 *   - Skips rows where keycloak_sub is already set.
 *   - If a Keycloak user with the row's email already exists, link to it (no new user created).
 *   - Otherwise create a Keycloak user with UPDATE_PASSWORD required-action.
 *   - Assign the REVAMP user's current role as a Keycloak realm role.
 *   - Write keycloak_sub back to the REVAMP row.
 *
 * Safe to re-run after partial failure.
 */

import "dotenv/config";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { KeycloakAdmin } from "../src/services/keycloak-admin.js";

export interface MigrateOptions {
  realm: string;
  dryRun: boolean;
}

export interface MigrateResult {
  total: number;
  skipped: number;         // already linked
  linked_existing: number; // email already in Keycloak; linked
  created: number;         // new Keycloak user
  would_create: number;    // dry-run only
}

export async function linkUsersToKeycloak(opts: MigrateOptions): Promise<MigrateResult> {
  const kc = new KeycloakAdmin();
  await kc.login();

  const rows = await db.query.users.findMany();
  const result: MigrateResult = {
    total: rows.length,
    skipped: 0,
    linked_existing: 0,
    created: 0,
    would_create: 0,
  };

  for (const row of rows) {
    if (row.keycloak_sub) {
      result.skipped++;
      continue;
    }

    if (opts.dryRun) {
      result.would_create++;
      continue;
    }

    const existing = await kc.findUserByEmail(opts.realm, row.email);
    let sub: string;
    if (existing) {
      sub = existing;
      result.linked_existing++;
    } else {
      sub = await kc.createUser(opts.realm, {
        email: row.email,
        firstName: row.first_name ?? row.email,
        lastName: row.last_name ?? ".",
        enabled: true,
        requiredActions: ["UPDATE_PASSWORD"],
      });
      if (row.role) {
        try {
          await kc.assignRealmRoleToUser(opts.realm, sub, row.role);
        } catch (err) {
          console.warn(`[migrate] role assignment failed for ${row.email}:`, err);
        }
      }
      result.created++;
    }

    await db.update(users).set({ keycloak_sub: sub }).where(eq(users.id, row.id));
  }

  return result;
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  const realm = process.env.KEYCLOAK_REALM ?? "revamp";
  linkUsersToKeycloak({ realm, dryRun }).then(
    (r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
