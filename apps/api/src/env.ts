import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load root .env first (monorepo settings), then local overrides
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

// ─── Required environment validation ─────────────────────────────
// In production, refuse to boot without critical secrets.
// In development, warn but allow startup for convenience.

const isProduction = process.env.NODE_ENV === "production";

const REQUIRED_IN_PRODUCTION = ["JWT_SECRET", "DATABASE_URL"];

for (const key of REQUIRED_IN_PRODUCTION) {
  if (!process.env[key]) {
    if (isProduction) {
      throw new Error(
        `FATAL: Required environment variable ${key} is not set. ` +
        `Refusing to start in production without it.`
      );
    } else {
      console.warn(`[env] WARNING: ${key} is not set. This must be configured before deploying to production.`);
    }
  }
}
