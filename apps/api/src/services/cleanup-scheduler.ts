/**
 * Cleanup Scheduler — periodic background janitor that runs inside the API server.
 *
 * Handles:
 * - Orphaned Node.js dev-server processes (detects & kills stale pnpm/tsx/next siblings)
 * - Stale database records (old activity logs, completed sessions past retention)
 * - Temp file cleanup
 *
 * Runs every CLEANUP_INTERVAL_MS (default: 5 minutes in dev, disabled in prod).
 */

import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

const execAsync = promisify(exec);
import { db } from "@/db/index.js";
import { agentActivityLog, agentSessions } from "@/db/schema.js";
import { lt, sql } from "drizzle-orm";

// ─── CONFIG ──────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = parseInt(
  process.env.CLEANUP_INTERVAL_MS || "300000", // 5 minutes
  10,
);
const ACTIVITY_LOG_RETENTION_DAYS = parseInt(
  process.env.ACTIVITY_LOG_RETENTION_DAYS || "30",
  10,
);
const SESSION_RETENTION_DAYS = parseInt(
  process.env.SESSION_RETENTION_DAYS || "90",
  10,
);
const MAX_NEXT_CACHE_MB = parseInt(
  process.env.MAX_NEXT_CACHE_MB || "1024", // 1GB
  10,
);

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

// ─── PUBLIC API ──────────────────────────────────────────

export function startCleanupScheduler(logger?: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}): void {
  const log = logger || {
    info: (msg: string) => console.log(`[cleanup] ${msg}`),
    warn: (msg: string) => console.warn(`[cleanup] ${msg}`),
    error: (msg: string) => console.error(`[cleanup] ${msg}`),
  };

  if (process.env.NODE_ENV === "production") {
    log.info("Cleanup scheduler disabled in production (use cron instead)");
    return;
  }

  if (intervalHandle) {
    log.warn("Cleanup scheduler already running");
    return;
  }

  log.info(
    `Cleanup scheduler started (interval: ${CLEANUP_INTERVAL_MS / 1000}s)`,
  );

  // Run once on startup after a longer delay to avoid interfering with
  // the critical startup path (Redis connect, route registration, etc.)
  setTimeout(() => runCleanup(log), 30_000);

  intervalHandle = setInterval(() => runCleanup(log), CLEANUP_INTERVAL_MS);
}

export function stopCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// ─── CLEANUP RUNNER ──────────────────────────────────────

async function runCleanup(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}): Promise<void> {
  if (running) return; // Skip if previous run is still going
  running = true;

  try {
    const results: string[] = [];

    // 1. Kill orphaned dev-server processes
    const orphansKilled = await killOrphanedProcesses(log);
    if (orphansKilled > 0) {
      results.push(`killed ${orphansKilled} orphaned processes`);
    }

    // 2. Clean stale DB records
    const dbCleaned = await cleanStaleDbRecords(log);
    if (dbCleaned > 0) {
      results.push(`cleaned ${dbCleaned} stale DB records`);
    }

    // 3. Check .next cache size
    const cacheWarning = await checkCacheSize(log);
    if (cacheWarning) {
      results.push(cacheWarning);
    }

    // 4. Clean temp files
    const tempCleaned = cleanTempFiles(log);
    if (tempCleaned > 0) {
      results.push(`removed ${tempCleaned} temp files`);
    }

    if (results.length > 0) {
      log.info(`Cleanup completed: ${results.join(", ")}`);
    }
  } catch (err) {
    log.error(`Cleanup failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    running = false;
  }
}

// ─── ORPHANED PROCESS CLEANUP ────────────────────────────

async function killOrphanedProcesses(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<number> {
  try {
    // Find all revamp-platform node processes.
    // Uses execAsync instead of execSync to avoid blocking the event loop,
    // which was causing the server to appear hung during the first cleanup pass
    // (10 seconds after startup).
    const { stdout } = await execAsync(
      'ps aux | grep -E "node.*revamp-platform" | grep -v grep',
      { encoding: "utf-8", timeout: 5000 },
    );

    const output = stdout.trim();
    if (!output) return 0;

    const lines = output.split("\n");
    const processes = lines
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[1], 10),
          cpu: parseFloat(parts[2]),
          mem: parseFloat(parts[3]),
          command: parts.slice(10).join(" "),
        };
      })
      .filter((p) => !isNaN(p.pid))
      .sort((a, b) => a.pid - b.pid);

    // Normal operation: 3 API processes + 4 Web processes = 7
    // Current server PID should be among them
    const myPid = process.pid;
    const expectedCount = 7;

    if (processes.length <= expectedCount) return 0;

    // Keep the highest-PID processes (most recent = current servers)
    // Kill everything else
    const toKeep = new Set(
      processes
        .slice(-expectedCount)
        .map((p) => p.pid),
    );

    // Also always keep our own PID and parent
    toKeep.add(myPid);
    if (process.ppid) toKeep.add(process.ppid);

    let killed = 0;
    for (const proc of processes) {
      if (!toKeep.has(proc.pid)) {
        try {
          process.kill(proc.pid, "SIGTERM");
          killed++;
          log.warn(
            `Killed orphaned process PID ${proc.pid}: ${proc.command.slice(0, 80)}`,
          );
        } catch {
          // Process may have already exited
        }
      }
    }

    // Force-kill after 2 seconds if needed
    if (killed > 0) {
      setTimeout(() => {
        for (const proc of processes) {
          if (!toKeep.has(proc.pid)) {
            try {
              process.kill(proc.pid, 0); // Check if still alive
              process.kill(proc.pid, "SIGKILL");
              log.warn(`Force-killed PID ${proc.pid}`);
            } catch {
              // Already dead
            }
          }
        }
      }, 2000);
    }

    return killed;
  } catch {
    // grep returns exit code 1 when no matches — that's fine
    return 0;
  }
}

// ─── STALE DB RECORDS ────────────────────────────────────

async function cleanStaleDbRecords(log: {
  info: (msg: string) => void;
}): Promise<number> {
  let total = 0;

  try {
    // Clean old activity logs
    const activityCutoff = new Date();
    activityCutoff.setDate(
      activityCutoff.getDate() - ACTIVITY_LOG_RETENTION_DAYS,
    );

    const activityResult = await db
      .delete(agentActivityLog)
      .where(lt(agentActivityLog.created_at, activityCutoff))
      .returning({ id: agentActivityLog.id });

    if (activityResult.length > 0) {
      total += activityResult.length;
      log.info(
        `Cleaned ${activityResult.length} activity log entries older than ${ACTIVITY_LOG_RETENTION_DAYS}d`,
      );
    }
  } catch {
    // Table may not exist yet or be empty — non-fatal
  }

  try {
    // Clean old compacted sessions (keep the compaction_summary, remove raw data)
    const sessionCutoff = new Date();
    sessionCutoff.setDate(
      sessionCutoff.getDate() - SESSION_RETENTION_DAYS,
    );

    const sessionResult = await db
      .update(agentSessions)
      .set({ session_data: {} })
      .where(
        sql`${agentSessions.compacted} = true AND ${agentSessions.created_at} < ${sessionCutoff}`,
      )
      .returning({ id: agentSessions.id });

    if (sessionResult.length > 0) {
      total += sessionResult.length;
      log.info(
        `Trimmed session_data from ${sessionResult.length} old compacted sessions`,
      );
    }
  } catch {
    // Non-fatal
  }

  return total;
}

// ─── CACHE SIZE CHECK ────────────────────────────────────

async function checkCacheSize(log: {
  warn: (msg: string) => void;
}): Promise<string | null> {
  try {
    // Check .next cache directory size
    const nextCacheDir = join(
      process.cwd(),
      "..",
      "web",
      ".next",
    );

    if (!existsSync(nextCacheDir)) return null;

    const { stdout } = await execAsync(`du -sm "${nextCacheDir}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });

    const sizeMB = parseInt(stdout.trim().split("\t")[0], 10);

    if (sizeMB > MAX_NEXT_CACHE_MB) {
      log.warn(
        `.next cache is ${sizeMB}MB (limit: ${MAX_NEXT_CACHE_MB}MB) — consider running: rm -rf apps/web/.next`,
      );
      return `.next cache warning: ${sizeMB}MB`;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── TEMP FILE CLEANUP ───────────────────────────────────

function cleanTempFiles(log: {
  info: (msg: string) => void;
}): number {
  let cleaned = 0;

  try {
    // Clean old revamp temp logs (older than 24 hours)
    const tmpDir = "/tmp";
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const files = readdirSync(tmpDir).filter((f) =>
      f.startsWith("revamp-") && f.endsWith(".log"),
    );

    for (const file of files) {
      const fullPath = join(tmpDir, file);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(fullPath);
          cleaned++;
        }
      } catch {
        // File may have been removed by another process
      }
    }

    if (cleaned > 0) {
      log.info(`Removed ${cleaned} old temp log files`);
    }
  } catch {
    // Non-fatal
  }

  return cleaned;
}
