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
import { agentActivityLog, agentSessions, stageRuns, pipelineRuns } from "@/db/schema.js";
import { lt, sql, and, eq, isNull } from "drizzle-orm";

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
// A stage_runs row is treated as orphaned only if BOTH:
//   1. It has been "running" longer than STAGE_RUN_ORPHAN_AGE_MINUTES, AND
//   2. There has been no log activity in STAGE_RUN_HEARTBEAT_MINUTES.
// The age guard prevents brand-new rows from being reaped; the heartbeat guard
// prevents long-but-active runs (e.g. DECODE with multi-round coverage gap-fill,
// which can run 40+ minutes) from being killed mid-flight.
const STAGE_RUN_ORPHAN_AGE_MINUTES = parseInt(
  process.env.STAGE_RUN_ORPHAN_AGE_MINUTES || "60",
  10,
);
const STAGE_RUN_HEARTBEAT_MINUTES = parseInt(
  process.env.STAGE_RUN_HEARTBEAT_MINUTES || "10",
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

  // Immediately reap orphaned stage_runs left over from a previous server
  // crash/restart. This is fast (a single UPDATE) and runs before any client
  // can ask for pipeline status, so the timer/UI never sees stale data.
  reapOrphanedStageRuns(log).catch((err) => {
    log.error(
      `Startup orphaned stage_runs reap failed: ${err instanceof Error ? err.message : err}`,
    );
  });

  // Run the broader cleanup pass after a longer delay to avoid interfering
  // with the critical startup path (Redis connect, route registration, etc.)
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

    // 2b. Reap orphaned 'running' stage_runs from crashed/disconnected runs
    const reaped = await reapOrphanedStageRuns(log);
    if (reaped > 0) {
      results.push(`reaped ${reaped} orphaned stage_runs`);
    }

    // 2c. Prune old stage execution versions (keep latest 3 per stage)
    const pruned = await cleanupOldExecutions();
    if (pruned > 0) {
      results.push(`pruned ${pruned} old stage execution(s)`);
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

// ─── ORPHANED STAGE_RUNS REAPER ──────────────────────────
//
// A stage_runs row stays in status='running' until the SSE handler in
// pipeline.ts marks it completed/failed. If the server crashes mid-stage,
// or the client disconnects in a way the handler can't catch, the row
// gets stranded. Those stale rows poison:
//   - the elapsed timer (via the /status backfill from stage_runs.started_at)
//   - the "is this stage running?" UI signal
// This reaper marks any row stuck >STAGE_RUN_ORPHAN_AGE_MINUTES as aborted
// so the user gets a clean slate to re-run.

async function reapOrphanedStageRuns(log: {
  info: (msg: string) => void;
  error: (msg: string) => void;
}): Promise<number> {
  try {
    // CRITICAL: stage_runs.started_at is `timestamp without time zone` populated
    // by Postgres `NOW()`. Comparing against a JS-computed Date causes a multi-
    // hour timezone offset that false-reaps brand-new rows. Always use SQL
    // `NOW() - INTERVAL` so the comparison stays in DB time.
    //
    // A row is reaped only if it's BOTH:
    //   - older than STAGE_RUN_ORPHAN_AGE_MINUTES (age guard)
    //   - has NO log entries in the last STAGE_RUN_HEARTBEAT_MINUTES (heartbeat)
    // Long-running multi-agent stages like DECODE keep streaming logs as agents
    // execute, so they're protected from premature reaping.

    // Use a single SQL query that joins stage_runs to its most recent log entry.
    // Drizzle's chainable API gets ugly here, so just use raw SQL.
    const result = await db.execute(sql`
      SELECT sr.id,
             sr.pipeline_run_id,
             sr.stage_name
        FROM stage_runs sr
        LEFT JOIN LATERAL (
          SELECT MAX(created_at) AS last_log_at
            FROM stage_execution_logs sel
           WHERE sel.stage_run_id = sr.id
        ) lg ON true
       WHERE sr.status = 'running'
         AND sr.completed_at IS NULL
         AND sr.started_at < NOW() - INTERVAL '${sql.raw(String(STAGE_RUN_ORPHAN_AGE_MINUTES))} minutes'
         AND (
           lg.last_log_at IS NULL
           OR lg.last_log_at < NOW() - INTERVAL '${sql.raw(String(STAGE_RUN_HEARTBEAT_MINUTES))} minutes'
         )
    `);

    // Drizzle's execute() returns { rows } for pg driver
    const orphans = (result as unknown as { rows: Array<{ id: string; pipeline_run_id: string; stage_name: string }> }).rows
      ?? (result as unknown as Array<{ id: string; pipeline_run_id: string; stage_name: string }>);
    if (!orphans || orphans.length === 0) return 0;

    // Mark them aborted by ID list
    const orphanIds = orphans.map((o) => o.id);
    await db.execute(sql`
      UPDATE stage_runs
         SET status = 'aborted',
             completed_at = NOW(),
             error_message = COALESCE(error_message, 'Auto-reaped: orphaned running row (no heartbeat for ${sql.raw(String(STAGE_RUN_HEARTBEAT_MINUTES))}+ minutes)')
       WHERE id = ANY(${sql.raw(`ARRAY[${orphanIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
    `);

    log.info(
      `Reaped ${orphans.length} orphaned stage_runs (older than ${STAGE_RUN_ORPHAN_AGE_MINUTES}m)`,
    );
    return orphans.length;
  } catch (err) {
    log.error(
      `reapOrphanedStageRuns failed: ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
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

// ─── STAGE EXECUTION RETENTION ───────────────────────────
//
// Keep the latest 3 executions per (pipeline_run_id, stage_name).
// Older versions are pruned to prevent unbounded growth from repeated
// re-runs. Runs during the regular cleanup interval.

async function cleanupOldExecutions(): Promise<number> {
  try {
    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT id, pipeline_run_id, stage_name, version,
               ROW_NUMBER() OVER (PARTITION BY pipeline_run_id, stage_name ORDER BY version DESC) as rn
        FROM stage_executions
      )
      DELETE FROM stage_executions
      WHERE id IN (SELECT id FROM ranked WHERE rn > 3)
      RETURNING id
    `);
    const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
    return rows.length;
  } catch (err) {
    console.warn('[Cleanup] Execution retention failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
