import type { FastifyPluginAsync } from "fastify";
import crypto from "crypto";
import { db } from "@/db/index.js";
import { revampSettings } from "@/db/schema.js";

const sha256 = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

const internalTestRoutes: FastifyPluginAsync = async (app) => {
  if (process.env.NODE_ENV === "production") return;

  app.post("/internal/test/reset-setup", async () => {
    await db.delete(revampSettings);
    const token = crypto.randomBytes(24).toString("hex");
    await db.insert(revampSettings).values({
      id: 1,
      setup_complete: false,
      bootstrap_token_hash: sha256(token),
    });
    return { ok: true, token };
  });
};

export default internalTestRoutes;
