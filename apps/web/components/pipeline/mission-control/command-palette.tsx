'use client';

import {
  memo,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from 'react';
import {
  Search,
  Play,
  Square,
  SkipForward,
  RotateCcw,
  PanelLeft,
  PanelRight,
  PanelBottom,
  Terminal as TerminalIcon,
  Download,
  GitBranch,
  ScanSearch,
  BrainCircuit,
  Map as MapIcon,
  ShieldCheck,
  Building2,
  Hammer,
  PlayCircle,
  Rocket,
  RefreshCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIPreferencesStore } from '@revamp/core/stores/ui-preferences-store';

// ─── Types ──────────────────────────────────────────────────────

export interface PaletteAction {
  id: string;
  label: string;
  shortcut?: string;
  icon: React.ComponentType<{ className?: string }>;
  category: 'pipeline' | 'navigation' | 'ui' | 'tools';
  handler: () => void;
  disabled?: boolean;
}

// ─── Category labels ────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  pipeline: 'Pipeline',
  navigation: 'Navigation',
  ui: 'UI',
  tools: 'Tools',
};

// ─── Component ──────────────────────────────────────────────────

interface CommandPaletteProps {
  actions: PaletteAction[];
}

export const CommandPalette = memo(function CommandPalette({
  actions,
}: CommandPaletteProps) {
  const commandPaletteOpen = useUIPreferencesStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useUIPreferencesStore((s) => s.setCommandPaletteOpen);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter actions by query
  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    );
  }, [actions, query]);

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<string, PaletteAction[]>();
    for (const action of filtered) {
      const group = map.get(action.category) ?? [];
      group.push(action);
      map.set(action.category, group);
    }
    return map;
  }, [filtered]);

  // Flat list for keyboard navigation
  const flatList = useMemo(() => filtered, [filtered]);

  // Reset on open
  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [commandPaletteOpen]);

  // Keep selectedIndex in bounds
  useEffect(() => {
    if (selectedIndex >= flatList.length) {
      setSelectedIndex(Math.max(0, flatList.length - 1));
    }
  }, [flatList.length, selectedIndex]);

  const close = useCallback(() => {
    setCommandPaletteOpen(false);
  }, [setCommandPaletteOpen]);

  const executeAction = useCallback(
    (action: PaletteAction) => {
      if (action.disabled) return;
      close();
      // Delay to allow modal to close
      requestAnimationFrame(() => action.handler());
    },
    [close],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, flatList.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatList[selectedIndex]) {
            executeAction(flatList[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          close();
          break;
      }
    },
    [flatList, selectedIndex, executeAction, close],
  );

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!commandPaletteOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
        onClick={close}
      />

      {/* Palette */}
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] pointer-events-none">
        <div
          className={cn(
            'w-full max-w-lg rounded-xl shadow-2xl pointer-events-auto',
            'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700',
            'overflow-hidden',
          )}
          onKeyDown={handleKeyDown}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
            <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              placeholder="Type a command..."
              className={cn(
                'flex-1 bg-transparent text-sm text-slate-900 dark:text-slate-100',
                'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                'focus:outline-none',
              )}
            />
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-[10px] text-slate-500 dark:text-slate-400 font-mono">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div
            ref={listRef}
            className="max-h-[320px] overflow-auto py-2"
          >
            {flatList.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
                No matching commands
              </div>
            ) : (
              Array.from(grouped.entries()).map(([category, items]) => (
                <div key={category}>
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    {CATEGORY_LABELS[category] ?? category}
                  </div>
                  {items.map((action) => {
                    const globalIndex = flatList.indexOf(action);
                    const isSelected = globalIndex === selectedIndex;
                    const Icon = action.icon;

                    return (
                      <button
                        key={action.id}
                        data-index={globalIndex}
                        onClick={() => executeAction(action)}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                        disabled={action.disabled}
                        className={cn(
                          'flex items-center gap-3 w-full px-4 py-2 text-sm text-left transition-colors',
                          isSelected
                            ? 'bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-300'
                            : 'text-slate-700 dark:text-slate-300',
                          action.disabled && 'opacity-40 cursor-not-allowed',
                        )}
                      >
                        <Icon className="w-4 h-4 flex-shrink-0 opacity-60" />
                        <span className="flex-1">{action.label}</span>
                        {action.shortcut && (
                          <kbd className="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">
                            {action.shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
});

// ─── Default action builder ─────────────────────────────────────

const STAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  SCAN: ScanSearch,
  DECODE: BrainCircuit,
  BLUEPRINT: MapIcon,
  SPEC_LOCK: ShieldCheck,
  ARCHITECT: Building2,
  FORGE: Hammer,
  SHADOW_RUN: PlayCircle,
  EVOLVE: Rocket,
};

const STAGE_LABELS: Record<string, string> = {
  SCAN: 'Setup & Configuration',
  DECODE: 'Intent Extraction',
  BLUEPRINT: 'Business Capability Mining',
  SPEC_LOCK: 'Behavior Lock-in',
  ARCHITECT: 'Modernization Approach',
  FORGE: 'Co-Create',
  SHADOW_RUN: 'Parallel Run & Cutover',
  EVOLVE: 'Continuous Modernization',
};

interface ActionBuildParams {
  onExecute: () => void;
  onStop: () => void;
  onAdvance: () => void;
  onRerun: () => void;
  onHardRefresh: () => void;
  onStageClick: (index: number) => void;
  onToggleLeftRail: () => void;
  onToggleRightPanel: () => void;
  onToggleBottomDock: () => void;
  onTogglePromptEditor: () => void;
  onOpenExport: () => void;
  onOpenGitHub: () => void;
  isGenerating: boolean;
  activeStageIndex: number;
}

export function buildPaletteActions(params: ActionBuildParams): PaletteAction[] {
  const actions: PaletteAction[] = [
    // Pipeline
    {
      id: 'execute',
      label: 'Execute Current Stage',
      shortcut: 'Ctrl+Enter',
      icon: Play,
      category: 'pipeline',
      handler: params.onExecute,
      disabled: params.isGenerating,
    },
    {
      id: 'stop',
      label: 'Stop Execution',
      shortcut: 'Escape',
      icon: Square,
      category: 'pipeline',
      handler: params.onStop,
      disabled: !params.isGenerating,
    },
    {
      id: 'advance',
      label: 'Advance to Next Stage',
      icon: SkipForward,
      category: 'pipeline',
      handler: params.onAdvance,
    },
    {
      id: 'rerun',
      label: 'Re-run Current Stage',
      icon: RotateCcw,
      category: 'pipeline',
      handler: params.onRerun,
    },
    {
      id: 'hard-refresh',
      label: 'Hard Refresh — Purge Cache & Re-sync',
      shortcut: 'Ctrl+Shift+R',
      icon: RefreshCcw,
      category: 'pipeline',
      handler: params.onHardRefresh,
    },

    // Navigation — one per stage
    ...Object.entries(STAGE_LABELS).map(([name, label], i) => ({
      id: `goto-${name}`,
      label: `Go to ${label}`,
      shortcut: `Cmd+${i + 1}`,
      icon: STAGE_ICONS[name] ?? ScanSearch,
      category: 'navigation' as const,
      handler: () => params.onStageClick(i),
    })),

    // UI
    {
      id: 'toggle-left',
      label: 'Toggle Left Rail',
      shortcut: 'Cmd+B',
      icon: PanelLeft,
      category: 'ui',
      handler: params.onToggleLeftRail,
    },
    {
      id: 'toggle-right',
      label: 'Toggle Inspector',
      shortcut: 'Cmd+.',
      icon: PanelRight,
      category: 'ui',
      handler: params.onToggleRightPanel,
    },
    {
      id: 'toggle-dock',
      label: 'Toggle Bottom Dock',
      shortcut: 'Cmd+J',
      icon: PanelBottom,
      category: 'ui',
      handler: params.onToggleBottomDock,
    },
    {
      id: 'toggle-prompt',
      label: 'Toggle Prompt Editor',
      shortcut: 'Cmd+Shift+P',
      icon: TerminalIcon,
      category: 'ui',
      handler: params.onTogglePromptEditor,
    },

    // Tools
    {
      id: 'export',
      label: 'Export Project',
      shortcut: 'Cmd+E',
      icon: Download,
      category: 'tools',
      handler: params.onOpenExport,
    },
    {
      id: 'github',
      label: 'GitHub Sync',
      icon: GitBranch,
      category: 'tools',
      handler: params.onOpenGitHub,
    },
  ];

  return actions;
}
