/**
 * Storage adapter — platform-agnostic persistence interface.
 *
 * Multica pattern: stores define their persistence needs through this interface.
 * Each platform (web, VS Code, desktop) provides its own implementation.
 *
 * Web: sessionStorage/localStorage
 * VS Code: ExtensionContext.globalState
 * Desktop: electron-store
 */

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ─── Global singleton (set by platform provider) ────────────────

let _sessionStorage: StorageAdapter | null = null;
let _persistStorage: StorageAdapter | null = null;

/**
 * Register the session storage adapter (survives page refresh, tab-scoped).
 * Web: sessionStorage. Desktop: in-memory with file backup.
 */
export function setSessionStorage(adapter: StorageAdapter) {
  _sessionStorage = adapter;
}

/**
 * Register the persistent storage adapter (survives browser close).
 * Web: localStorage. Desktop: electron-store. VS Code: globalState.
 */
export function setPersistStorage(adapter: StorageAdapter) {
  _persistStorage = adapter;
}

export function getSessionStorage(): StorageAdapter {
  if (!_sessionStorage) {
    // Fallback to in-memory if not initialized
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => mem.set(k, v),
      removeItem: (k) => mem.delete(k),
    };
  }
  return _sessionStorage;
}

export function getPersistStorage(): StorageAdapter {
  if (!_persistStorage) {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => mem.set(k, v),
      removeItem: (k) => mem.delete(k),
    };
  }
  return _persistStorage;
}
