'use client';

import { useCallback, type ReactNode, memo } from 'react';
import { ResizeHandle } from './resize-handle';
import { useUIPreferencesStore } from '@/lib/stores/ui-preferences-store';
import { cn } from '@/lib/utils';

interface MissionControlLayoutProps {
  /** Left rail content (stage navigation, quick settings, cost) */
  leftRail: ReactNode;
  /** Center panel content (stage output, inline prompt editor) */
  center: ReactNode;
  /** Right inspector panel content (validation, approval, diagrams) */
  inspector: ReactNode;
  /** Bottom dock content (terminal, agent, tokens, history) */
  bottomDock: ReactNode;
  /** Header bar content */
  header: ReactNode;
}

/**
 * Mission Control — IDE-like 3-column + bottom dock layout
 * for the pipeline execution page.
 *
 * Layout:
 * ┌─────────────────────────────────────────────────┐
 * │                   HEADER                        │
 * ├──────┬─────────────────────┬────────────────────┤
 * │ LEFT │       CENTER        │    INSPECTOR       │
 * │ RAIL │                     │                    │
 * ├──────┴─────────────────────┴────────────────────┤
 * │                BOTTOM DOCK                      │
 * └─────────────────────────────────────────────────┘
 */
export const MissionControlLayout = memo(function MissionControlLayout({
  leftRail,
  center,
  inspector,
  bottomDock,
  header,
}: MissionControlLayoutProps) {
  // Use individual selectors to avoid full-store re-renders
  const leftRailWidth = useUIPreferencesStore((s) => s.leftRailWidth);
  const rightPanelWidth = useUIPreferencesStore((s) => s.rightPanelWidth);
  const bottomDockHeight = useUIPreferencesStore((s) => s.bottomDockHeight);
  const leftRailCollapsed = useUIPreferencesStore((s) => s.leftRailCollapsed);
  const rightPanelCollapsed = useUIPreferencesStore((s) => s.rightPanelCollapsed);
  const bottomDockCollapsed = useUIPreferencesStore((s) => s.bottomDockCollapsed);
  const setLeftRailWidth = useUIPreferencesStore((s) => s.setLeftRailWidth);
  const setRightPanelWidth = useUIPreferencesStore((s) => s.setRightPanelWidth);
  const setBottomDockHeight = useUIPreferencesStore((s) => s.setBottomDockHeight);

  // ─── Resize Handlers ────────────────────────────────────────

  const handleLeftResize = useCallback(
    (delta: number) => {
      setLeftRailWidth(leftRailWidth + delta);
    },
    [leftRailWidth, setLeftRailWidth],
  );

  const handleRightResize = useCallback(
    (delta: number) => {
      // Dragging left (negative delta) should increase right panel width
      setRightPanelWidth(rightPanelWidth - delta);
    },
    [rightPanelWidth, setRightPanelWidth],
  );

  const handleBottomResize = useCallback(
    (delta: number) => {
      // Dragging up (negative delta) should increase dock height
      setBottomDockHeight(bottomDockHeight - delta);
    },
    [bottomDockHeight, setBottomDockHeight],
  );

  // ─── Computed Sizes ─────────────────────────────────────────

  const effectiveLeftWidth = leftRailCollapsed ? 0 : leftRailWidth;
  const effectiveRightWidth = rightPanelCollapsed ? 0 : rightPanelWidth;
  const effectiveBottomHeight = bottomDockCollapsed
    ? 32
    : bottomDockHeight;

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-slate-50 dark:bg-slate-900">
      {/* ─── Header ─────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        {header}
      </div>

      {/* ─── Main Area (columns + bottom dock) ──────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* ─── 3-Column Row ────────────────────────────── */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Left Rail */}
          {!leftRailCollapsed && (
            <>
              <div
                className="flex-shrink-0 overflow-y-auto overflow-x-hidden border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                style={{ width: effectiveLeftWidth }}
              >
                {leftRail}
              </div>
              <ResizeHandle direction="horizontal" onResize={handleLeftResize} />
            </>
          )}

          {/* Center Panel */}
          <div className="flex-1 overflow-auto min-w-0">
            {center}
          </div>

          {/* Right Inspector */}
          {!rightPanelCollapsed && (
            <>
              <ResizeHandle direction="horizontal" onResize={handleRightResize} />
              <div
                className="flex-shrink-0 overflow-y-auto overflow-x-hidden border-l border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                style={{ width: effectiveRightWidth }}
              >
                {inspector}
              </div>
            </>
          )}
        </div>

        {/* ─── Bottom Dock ─────────────────────────────── */}
        {!bottomDockCollapsed && (
          <ResizeHandle direction="vertical" onResize={handleBottomResize} />
        )}
        <div
          className={cn(
            'flex-shrink-0 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden',
            bottomDockCollapsed && 'cursor-pointer',
          )}
          style={{ height: effectiveBottomHeight }}
        >
          {bottomDock}
        </div>
      </div>
    </div>
  );
});
