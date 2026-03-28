'use client';

import { memo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  Terminal,
  Bot,
  Coins,
  History,
  ClipboardList,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { AgentActivity } from '@/components/pipeline/agent-activity';
import { TokenUsagePanel } from '@/components/pipeline/token-usage';
import { RunHistory } from './run-history';
import { AuditLog } from './audit-log';
import {
  useUIPreferencesStore,
  type BottomDockTab,
} from '@/lib/stores/ui-preferences-store';
import type { LogEntry } from '@/components/pipeline/terminal-log';
import type { ToolCall } from '@/components/pipeline/agent-activity';

// ─── Tab Config ─────────────────────────────────────────────────

const DOCK_TABS: {
  id: BottomDockTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'tokens', label: 'Tokens', icon: Coins },
  { id: 'history', label: 'History', icon: History },
  { id: 'audit', label: 'Audit', icon: ClipboardList },
];

// ─── Component ──────────────────────────────────────────────────

interface BottomDockProps {
  /** Terminal log entries */
  logs: LogEntry[];
  /** Agent tool calls */
  toolCalls: ToolCall[];
  /** Project ID for tokens/history/audit */
  projectId: string;
  /** Current pipeline run ID */
  currentRunId: string | null;
  /** Handler when a historical run is selected */
  onSelectRun?: (runId: string) => void;
  className?: string;
}

export const BottomDock = memo(function BottomDock({
  logs,
  toolCalls,
  projectId,
  currentRunId,
  onSelectRun,
  className,
}: BottomDockProps) {
  // Use individual selectors to avoid full-store re-renders
  const bottomDockTab = useUIPreferencesStore((s) => s.bottomDockTab);
  const setBottomDockTab = useUIPreferencesStore((s) => s.setBottomDockTab);
  const bottomDockCollapsed = useUIPreferencesStore((s) => s.bottomDockCollapsed);
  const toggleBottomDock = useUIPreferencesStore((s) => s.toggleBottomDock);

  const handleTabClick = useCallback(
    (tabId: BottomDockTab) => {
      if (bottomDockCollapsed) {
        // Expand and switch to tab
        toggleBottomDock();
      }
      setBottomDockTab(tabId);
    },
    [bottomDockCollapsed, toggleBottomDock, setBottomDockTab],
  );

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* ─── Tab Bar (always visible) ──────────────────────── */}
      <div className="flex-shrink-0 flex items-center border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 h-[36px]">
        {/* Collapse toggle */}
        <button
          onClick={toggleBottomDock}
          className="flex items-center justify-center w-8 h-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          title={bottomDockCollapsed ? 'Expand dock' : 'Collapse dock'}
        >
          {bottomDockCollapsed ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>

        {/* Tabs */}
        <div className="flex items-center gap-0.5 flex-1 overflow-x-auto">
          {DOCK_TABS.map((tab) => {
            const isActive = bottomDockTab === tab.id;
            const Icon = tab.icon;

            // Show badge for activity
            const showBadge =
              (tab.id === 'terminal' && logs?.some((l) => l.level === 'error')) ||
              (tab.id === 'agent' && toolCalls?.some((tc) => tc.status === 'running'));

            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab.id)}
                className={cn(
                  'relative flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium whitespace-nowrap transition-colors rounded-t',
                  isActive
                    ? 'text-primary-600 dark:text-primary-400 bg-slate-50 dark:bg-slate-900/50'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                )}
              >
                <Icon className="w-3 h-3" />
                {tab.label}
                {showBadge && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                )}
              </button>
            );
          })}
        </div>

        {/* Log count badge */}
        {!bottomDockCollapsed && bottomDockTab === 'terminal' && (
          <span className="text-[9px] text-slate-400 dark:text-slate-500 pr-3">
            {logs.length} entries
          </span>
        )}
      </div>

      {/* ─── Tab Content ──────────────────────────────────── */}
      {!bottomDockCollapsed && (
        <div className="flex-1 overflow-hidden min-h-0">
          {bottomDockTab === 'terminal' && (
            <TerminalLog
              logs={logs}
              maxHeight="100%"
              autoScroll
              collapsed={false}
            />
          )}

          {bottomDockTab === 'agent' && (
            <AgentActivity
              toolCalls={toolCalls}
              maxHeight="100%"
            />
          )}

          {bottomDockTab === 'tokens' && (
            <div className="overflow-auto h-full p-3">
              <TokenUsagePanel projectId={projectId} />
            </div>
          )}

          {bottomDockTab === 'history' && (
            <RunHistory
              projectId={projectId}
              currentRunId={currentRunId}
              onSelectRun={onSelectRun}
            />
          )}

          {bottomDockTab === 'audit' && (
            <AuditLog projectId={projectId} />
          )}
        </div>
      )}
    </div>
  );
});
