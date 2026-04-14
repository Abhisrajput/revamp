import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});

// Force UTC for all connections. The schema uses `timestamp without time zone`
// (not timestamptz), so we need PostgreSQL to interpret all timestamps as UTC.
// Without this, timestamps are ambiguous and JavaScript may misinterpret them
// as local time, shifting displayed times by the server's timezone offset.
pool.on("connect", (client) => {
  client.query("SET timezone = 'UTC'");
});

// Log pool errors to prevent silent connection drops
pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err.message);
});

export const db = drizzle(pool, { schema });

// Health check
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// Close connection pool
export async function closeDatabaseConnection(): Promise<void> {
  await pool.end();
}

export type Database = typeof db;
// Connection type compatible with both db and db.transaction() contexts
export type DbConnection = Omit<Database, '$client'>;
