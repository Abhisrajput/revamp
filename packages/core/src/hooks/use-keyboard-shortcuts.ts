

import { useEffect, useRef } from 'react';

/**
 * Generic keyboard shortcut hook.
 *
 * @param shortcuts - A map of shortcut descriptors to handler functions.
 *   Descriptor format: `"<modifier>+<key>"` where modifier is one of:
 *   `ctrl`, `meta`, `alt`, `shift`, or combinations joined by `+`.
 *   Key should match `event.key` (case-insensitive).
 *
 * @example
 * useKeyboardShortcuts({
 *   'ctrl+s': () => save(),
 *   'meta+k': () => openPalette(),
 *   'alt+ArrowRight': () => nextStage(),
 * });
 */
export function useKeyboardShortcuts(shortcuts: Record<string, () => void>): void {
  const shortcutsRef = useRef(shortcuts);

  // Keep ref up-to-date without re-binding the event listener
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('ctrl');
      if (e.metaKey) parts.push('meta');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      parts.push(e.key.toLowerCase());

      const descriptor = parts.join('+');

      // Also check without shift prefix for bare keys
      const cb = shortcutsRef.current[descriptor];
      if (cb) {
        e.preventDefault();
        cb();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

// ─── Pipeline-specific shortcuts ───────────────────────────────────

interface PipelineShortcutOptions {
  onExecute: () => void;
  onStop: () => void;
  onNextStage: () => void;
  onPrevStage: () => void;
  onToggleLogs: () => void;
  onHardRefresh?: () => void;
  isExecuting: boolean;
}

/**
 * Binds the standard pipeline keyboard shortcuts.
 * Ctrl+Enter → execute, Alt+Arrow → navigate stages, etc.
 */
export function usePipelineShortcuts(options: PipelineShortcutOptions): void {
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Ctrl+Enter → execute / stop
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (optsRef.current.isExecuting) {
          optsRef.current.onStop();
        } else {
          optsRef.current.onExecute();
        }
        return;
      }

      // Alt+ArrowRight → next stage
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        optsRef.current.onNextStage();
        return;
      }

      // Alt+ArrowLeft → prev stage
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        optsRef.current.onPrevStage();
        return;
      }

      // Cmd+J → toggle logs / bottom dock
      if (meta && e.key === 'j') {
        e.preventDefault();
        optsRef.current.onToggleLogs();
        return;
      }

      // Ctrl+Shift+R → hard refresh (purge cache, re-sync from API)
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        optsRef.current.onHardRefresh?.();
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
