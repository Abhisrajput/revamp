/**
 * Storage adapter — platform-agnostic persistence interface.
 *
 * Multica pattern: stores define their persistence needs through this interface.
 * Each platform (web, VS Code, desktop) provides its own implementation.
 *
 * Web: sessionStorage/localStorage (auto-detected as default)
 * VS Code: ExtensionContext.globalState (set via setPersistStorage)
 * Desktop: electron-store (set via setPersistStorage)
 */

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ─── Global singleton (set by platform provider) ────────────────

let _sessionStorage: StorageAdapter | null = null;
let _persistStorage: StorageAdapter | null = null;

// Stable SSR fallback singletons — reused across all calls during server rendering
// so that Zustand persist reads/writes go to the same Map within a single SSR pass.
const _ssrSessionMem = new Map<string, string>();
const _ssrPersistMem = new Map<string, string>();

const _ssrSessionAdapter: StorageAdapter = {
  getItem: (k) => _ssrSessionMem.get(k) ?? null,
  setItem: (k, v) => _ssrSessionMem.set(k, v),
  removeItem: (k) => { _ssrSessionMem.delete(k); },
};

const _ssrPersistAdapter: StorageAdapter = {
  getItem: (k) => _ssrPersistMem.get(k) ?? null,
  setItem: (k, v) => _ssrPersistMem.set(k, v),
  removeItem: (k) => { _ssrPersistMem.delete(k); },
};

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

/**
 * Get session storage. In the browser, falls back to window.sessionStorage
 * directly — this ensures Zustand persist hydrates correctly regardless of
 * module evaluation order (auth-store.ts may load before providers.tsx).
 * On SSR, returns a stable in-memory singleton.
 */
export function getSessionStorage(): StorageAdapter {
  if (_sessionStorage) return _sessionStorage;
  if (typeof window !== 'undefined') return window.sessionStorage;
  return _ssrSessionAdapter;
}

/**
 * Get persistent storage. In the browser, falls back to window.localStorage
 * directly — this ensures Zustand persist hydrates correctly regardless of
 * module evaluation order. On SSR, returns a stable in-memory singleton.
 */
export function getPersistStorage(): StorageAdapter {
  if (_persistStorage) return _persistStorage;
  if (typeof window !== 'undefined') return window.localStorage;
  return _ssrPersistAdapter;
}
