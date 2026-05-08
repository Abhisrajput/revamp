/**
 * Pipeline Cache — IndexedDB storage for large stage outputs.
 *
 * localStorage caps at 5MB and can't hold 88K+ stage outputs.
 * IndexedDB has no practical size limit (hundreds of MB).
 *
 * Stores:
 *   - Stage outputs (text content, up to 100K+ per stage)
 *
 * Cache key: `{pipelineRunId}:{stageName}`
 * TTL: 7 days (auto-cleanup on open)
 */

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'revamp-pipeline-cache';
const DB_VERSION = 1;
const STORE_OUTPUTS = 'stage-outputs';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedOutput {
  key: string; // pipelineRunId:stageName
  pipelineRunId: string;
  stageName: string;
  content: string;
  charCount: number;
  cachedAt: number; // timestamp
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available on server'));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_OUTPUTS)) {
          const store = db.createObjectStore(STORE_OUTPUTS, { keyPath: 'key' });
          store.createIndex('by-pipeline', 'pipelineRunId');
          store.createIndex('by-cached', 'cachedAt');
        }
      },
    });

    // Auto-cleanup expired entries
    dbPromise.then(async (db) => {
      const cutoff = Date.now() - TTL_MS;
      const tx = db.transaction(STORE_OUTPUTS, 'readwrite');
      const index = tx.store.index('by-cached');
      let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff));
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
    }).catch(() => { /* cleanup is non-fatal */ });
  }
  return dbPromise;
}

// ─── Stage Outputs ──────────────────────────────────────────────

export async function getCachedOutput(pipelineRunId: string, stageName: string): Promise<string | null> {
  try {
    const db = await getDB();
    const key = `${pipelineRunId}:${stageName}`;
    const cached = await db.get(STORE_OUTPUTS, key) as CachedOutput | undefined;
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > TTL_MS) {
      await db.delete(STORE_OUTPUTS, key);
      return null;
    }
    return cached.content;
  } catch {
    return null;
  }
}

export async function setCachedOutput(pipelineRunId: string, stageName: string, content: string): Promise<void> {
  try {
    const db = await getDB();
    await db.put(STORE_OUTPUTS, {
      key: `${pipelineRunId}:${stageName}`,
      pipelineRunId,
      stageName,
      content,
      charCount: content.length,
      cachedAt: Date.now(),
    } as CachedOutput);
  } catch { /* non-fatal */ }
}

export async function getCachedOutputsForRun(pipelineRunId: string): Promise<Record<string, string>> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_OUTPUTS, 'readonly');
    const index = tx.store.index('by-pipeline');
    const entries = await index.getAll(pipelineRunId) as CachedOutput[];
    const result: Record<string, string> = {};
    const now = Date.now();
    for (const entry of entries) {
      if (now - entry.cachedAt < TTL_MS) {
        result[entry.stageName] = entry.content;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ─── Utilities ──────────────────────────────────────────────────

/** Purge all IndexedDB caches — called by hard refresh (Ctrl+Shift+R) */
export async function clearAllCache(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(STORE_OUTPUTS);
  } catch { /* non-fatal */ }
}
