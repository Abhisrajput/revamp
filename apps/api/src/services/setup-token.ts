import crypto from "crypto";
import { db } from "@/db/index.js";
import { revampSettings } from "@/db/schema.js";
import { eq } from "drizzle-orm";

const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/**
 * Ensure the single revamp_settings row exists. If fresh (setup_complete=false, no token),
 * generate a bootstrap token, log it, and return the plaintext ONE TIME.
 */
export async function ensureBootstrapToken(log: { info: (msg: string) => void }): Promise<void> {
  const existing = await db.query.revampSettings.findFirst();
  if (existing && existing.setup_complete) return;
  if (existing?.bootstrap_token_hash) return; // already generated; don't regenerate

  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = hash(token);

  if (existing) {
    await db
      .update(revampSettings)
      .set({ bootstrap_token_hash: tokenHash, updated_at: new Date() })
      .where(eq(revampSettings.id, 1));
  } else {
    await db
      .insert(revampSettings)
      .values({ id: 1, setup_complete: false, bootstrap_token_hash: tokenHash });
  }

  log.info(`[SETUP] Bootstrap token: ${token} — paste into /setup to complete installation`);
  log.info(`[SETUP] Valid until setup completes. Re-run the API to re-log if lost.`);
}

export async function verifyBootstrapToken(candidate: string): Promise<boolean> {
  const row = await db.query.revampSettings.findFirst();
  if (!row || !row.bootstrap_token_hash) return false;
  return hash(candidate) === row.bootstrap_token_hash;
}

export async function markSetupComplete(): Promise<void> {
  await db
    .update(revampSettings)
    .set({ setup_complete: true, bootstrap_token_hash: null, updated_at: new Date() })
    .where(eq(revampSettings.id, 1));
}

export async function isSetupComplete(): Promise<boolean> {
  const row = await db.query.revampSettings.findFirst();
  return !!row?.setup_complete;
}
