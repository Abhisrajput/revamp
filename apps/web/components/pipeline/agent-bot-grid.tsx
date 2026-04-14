'use client';

/**
 * Agent Bot Grid — renders one TypingBot per planned subtask from the Director.
 * Bots are clickable — shows a Multica-style popover with live agent activity.
 * Color-coded by status (running, completed, failed).
 */

import { useState } from 'react';
import { TypingBot } from '@/components/ui/typing-bot';
import { CheckCircle2, XCircle, Loader2, Bot, FileText, Pencil, Eye, Clock, X } from 'lucide-react';
import type { ScanSubtaskState } from '@/lib/stores/pipeline-types';
import { usePipelineActivityStore } from '@/lib/stores/pipeline-activity-store';
import { cn } from '@/lib/utils';

interface AgentBotGridProps {
  subtasks: ScanSubtaskState[];
  message: string;
  subtitle?: string;
  /** Current execution phase (e.g. 'composing', 'validating') — shown when all subtasks are done */
  currentPhase?: string | null;
  /** Whether the stage is still executing */
  isExecuting?: boolean;
  /** Optional overall progress across ALL gap-fill rounds (deduped by title).
   *  When provided, the progress bar uses these counts instead of the visible
   *  `subtasks` array — so adding a fresh gap-fill round doesn't reset the bar. */
  overallProgress?: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    rounds: number;
  };
}

// Convert subtask type to a friendly display name
function formatTitle(s: ScanSubtaskState): string {
  return s.title || s.label || s.type
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function StatusIcon({ status }: { status: ScanSubtaskState['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-500" />;
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />;
    default:
      return <span className="w-2 h-2 rounded-full bg-slate-400" />;
  }
}

// ─── Agent Detail Popover ────────────────────────────────────────

function AgentDetailPopover({ subtask, onClose }: { subtask: ScanSubtaskState; onClose: () => void }) {
  const logs = usePipelineActivityStore((s) => s.logs);
  const toolCalls = usePipelineActivityStore((s) => s.toolCalls);

  // Filter activity to THIS specific subtask using subtaskId/subtaskType
  // (added to SSE events by use-stage-execution.ts)
  const matchesSubtask = (item: any) => {
    // Strong match: subtaskId or subtaskType directly on the event
    if (item.subtaskId === subtask.id) return true;
    if (item.subtaskType === subtask.type) return true;
    // Medium match: agent name
    if (item.agentName && subtask.agentName && item.agentName === subtask.agentName) return true;
    return false;
  };

  const agentToolCalls = toolCalls.filter(matchesSubtask).slice(-15);
  const agentLogs = logs.filter((l) =>
    (l.message && typeof l.message === 'string' && l.message.includes(subtask.type))
  ).slice(-10);

  const elapsed = subtask.duration
    ? `${(subtask.duration / 1000).toFixed(1)}s`
    : subtask.status === 'running' ? 'Running...' : '—';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl w-[480px] max-h-[70vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center',
              subtask.status === 'running' && 'bg-amber-100 dark:bg-amber-900/30',
              subtask.status === 'completed' && 'bg-green-100 dark:bg-green-900/30',
              subtask.status === 'failed' && 'bg-red-100 dark:bg-red-900/30',
              subtask.status === 'pending' && 'bg-slate-100 dark:bg-slate-800',
            )}>
              <Bot className={cn(
                'w-4 h-4',
                subtask.status === 'running' && 'text-amber-600',
                subtask.status === 'completed' && 'text-green-600',
                subtask.status === 'failed' && 'text-red-600',
                subtask.status === 'pending' && 'text-slate-400',
              )} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {subtask.agentName || formatTitle(subtask)}
              </h3>
              <p className="text-[10px] text-slate-400">{formatTitle(subtask)} • {elapsed}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Status bar */}
        <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/50 flex items-center gap-3 text-[11px]">
          <span className="flex items-center gap-1">
            <StatusIcon status={subtask.status} />
            <span className="font-medium capitalize">{subtask.status}</span>
          </span>
          {agentToolCalls.length > 0 && (
            <span className="text-slate-400">{agentToolCalls.length} tool calls</span>
          )}
          {subtask.duration && (
            <span className="flex items-center gap-1 text-slate-400">
              <Clock className="w-3 h-3" />
              {elapsed}
            </span>
          )}
        </div>

        {/* Activity stream */}
        <div className="overflow-y-auto max-h-[45vh] px-4 py-3 space-y-2">
          {subtask.status === 'pending' && (
            <p className="text-sm text-slate-400 text-center py-4">Waiting to start...</p>
          )}

          {/* Tool calls — like Multica's Read/Edit/result display */}
          {agentToolCalls.length > 0 && (
            <div className="space-y-1.5">
              {agentToolCalls.map((tc, i) => {
                const name = tc.toolName || tc.name || tc.tool || '';
                const displayName = name
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, (c: string) => c.toUpperCase());
                const isRead = /read|scan|analyz|fetch|load/i.test(name);
                const isWrite = /edit|write|compos|generat|refin/i.test(name);
                const isCheck = /validat|check|contract|evaluat/i.test(name);
                const details = tc.input?.details || tc.input?.message || (typeof tc.input === 'string' ? tc.input : '');

                return (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    {isRead ? (
                      <Eye className="w-3 h-3 mt-0.5 text-blue-500 flex-shrink-0" />
                    ) : isWrite ? (
                      <Pencil className="w-3 h-3 mt-0.5 text-amber-500 flex-shrink-0" />
                    ) : isCheck ? (
                      <CheckCircle2 className="w-3 h-3 mt-0.5 text-purple-500 flex-shrink-0" />
                    ) : (
                      <FileText className="w-3 h-3 mt-0.5 text-slate-400 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-slate-600 dark:text-slate-300">
                        {displayName || 'Processing'}
                      </span>
                      {tc.status && (
                        <span className={cn(
                          'ml-1.5 text-[9px] px-1 py-0.5 rounded',
                          tc.status === 'completed' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                          tc.status === 'running' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                          tc.status === 'failed' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                        )}>
                          {tc.status}
                        </span>
                      )}
                      {details && (
                        <p className="text-slate-400 truncate mt-0.5">
                          {typeof details === 'string' ? details.slice(0, 100) : JSON.stringify(details).slice(0, 100)}
                        </p>
                      )}
                      {tc.output && (
                        <p className="text-green-600 dark:text-green-400 truncate mt-0.5">
                          result: {typeof tc.output === 'string' ? tc.output.slice(0, 80) : 'OK'}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Logs */}
          {agentLogs.length > 0 && agentToolCalls.length === 0 && (
            <div className="space-y-1">
              {agentLogs.map((log, i) => (
                <div key={i} className="text-[11px] text-slate-500 dark:text-slate-400">
                  {typeof log.message === 'string' ? log.message : JSON.stringify(log.data || log.message || '').slice(0, 100)}
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {subtask.status === 'failed' && subtask.error && (
            <div className="mt-2 p-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <p className="text-[11px] text-red-600 dark:text-red-400">{subtask.error}</p>
            </div>
          )}

          {/* Output preview */}
          {subtask.output && (
            <div className="mt-2">
              <p className="text-[10px] font-medium text-slate-500 mb-1">Output preview:</p>
              <pre className="text-[10px] text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 rounded-md p-2 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
                {subtask.output.slice(0, 500)}{subtask.output.length > 500 ? '...' : ''}
              </pre>
            </div>
          )}

          {/* Empty state */}
          {agentToolCalls.length === 0 && agentLogs.length === 0 && !subtask.output && !subtask.error && (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-4 justify-center">
              {subtask.status === 'running' ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Agent is working...</>
              ) : subtask.status === 'completed' ? (
                <><CheckCircle2 className="w-4 h-4 text-green-500" /> Completed{subtask.duration ? ` in ${(subtask.duration / 1000).toFixed(1)}s` : ''}</>
              ) : subtask.status === 'pending' ? (
                <>Waiting to start...</>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BotCardGrid({ subtasks, cols }: { subtasks: ScanSubtaskState[]; cols: number }) {
  const [selectedBot, setSelectedBot] = useState<ScanSubtaskState | null>(null);

  return (
    <>
      <div
        className="grid gap-4 max-w-3xl"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {subtasks.map((subtask) => (
          <button
            key={subtask.id}
            onClick={() => setSelectedBot(subtask)}
            className={cn(
              'flex flex-col items-center gap-2 p-3 rounded-xl border transition-all cursor-pointer',
              'hover:shadow-md hover:scale-[1.02] active:scale-[0.98]',
              subtask.status === 'completed' && 'border-green-200 bg-green-50/50 dark:border-green-900/40 dark:bg-green-900/10',
              subtask.status === 'failed' && 'border-red-200 bg-red-50/50 dark:border-red-900/40 dark:bg-red-900/10',
              subtask.status === 'running' && 'border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-900/10',
              (subtask.status === 'pending' || !subtask.status) && 'border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-900/30 opacity-60',
            )}
          >
            <div
              className={cn(
                subtask.status !== 'running' && 'opacity-50 grayscale',
                subtask.status === 'completed' && 'grayscale-0 opacity-100',
              )}
            >
              <TypingBot size="md" centered={false} />
            </div>

            <div className="text-center w-full">
              <div className="flex items-center justify-center gap-1.5 mb-0.5">
                <StatusIcon status={subtask.status} />
                <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                  {formatTitle(subtask)}
                </span>
              </div>
              {subtask.agentName && (
                <p className="text-[9px] text-slate-400 truncate">{subtask.agentName}</p>
              )}
              {subtask.status === 'completed' && subtask.duration && (
                <p className="text-[9px] text-green-600 dark:text-green-400 mt-0.5">
                  {(subtask.duration / 1000).toFixed(1)}s
                </p>
              )}
              {subtask.status === 'failed' && subtask.error && (
                <p className="text-[9px] text-red-500 truncate mt-0.5" title={subtask.error}>
                  {subtask.error.slice(0, 30)}
                </p>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Agent detail popover */}
      {selectedBot && (
        <AgentDetailPopover subtask={selectedBot} onClose={() => setSelectedBot(null)} />
      )}
    </>
  );
}

export function AgentBotGrid({ subtasks, message, subtitle, currentPhase, isExecuting, overallProgress }: AgentBotGridProps) {
  // No subtasks yet — show a single big centered bot
  if (!subtasks || subtasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-4">
        <TypingBot size="xl" />
        <div className="text-center">
          <p className="text-base font-semibold text-slate-700 dark:text-slate-200">{message}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
        </div>
      </div>
    );
  }

  // Multiple subtasks — show a grid of smaller bots, one per agent
  const cols = subtasks.length <= 2 ? 2 : subtasks.length <= 4 ? 2 : 3;

  // Progress: prefer overallProgress (covers all gap-fill rounds, deduped) so
  // a fresh round doesn't reset the bar. Fall back to the visible-batch counts
  // when no overall data was provided (e.g. SCAN, or before sync hydrates).
  // Running counts as 0.5 so the bar advances smoothly as subtasks transition.
  const completedCount = overallProgress?.completed
    ?? subtasks.filter((s) => s.status === 'completed').length;
  const runningCount = overallProgress?.running
    ?? subtasks.filter((s) => s.status === 'running').length;
  const failedCount = overallProgress?.failed
    ?? subtasks.filter((s) => s.status === 'failed').length;
  const total = overallProgress?.total ?? subtasks.length;
  const rounds = overallProgress?.rounds ?? 1;
  // When all subtasks are done but stage is still running, we're in composition/validation phase
  const allSubtasksDone = completedCount + failedCount >= total && total > 0;
  const inPostPhase = allSubtasksDone && isExecuting;
  const postPhaseLabel = currentPhase
    ? currentPhase.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Composing results';

  // Progress: subtasks are 0-80%, composition/validation is 80-100%
  const subtaskPct = total > 0
    ? Math.min(80, Math.round(((completedCount + runningCount * 0.5) / total) * 80))
    : 0;
  const progressPct = inPostPhase
    ? Math.min(95, subtaskPct + (currentPhase?.includes('validat') ? 15 : 10))
    : subtaskPct;

  return (
    <div className="flex flex-col items-center py-6 gap-5 flex-1 min-h-0 overflow-y-auto">
      {/* Header message — sticky so the progress bar stays visible while scrolling */}
      <div className="text-center w-full max-w-md sticky top-0 bg-white dark:bg-slate-950 z-10 pb-2">
        <p className="text-base font-semibold text-slate-700 dark:text-slate-200">
          {inPostPhase ? postPhaseLabel + '...' : message}
        </p>
        {inPostPhase ? (
          <p className="text-xs text-slate-400 mt-1">All specialists finished — merging results</p>
        ) : subtitle ? (
          <p className="text-xs text-slate-400 mt-1">{subtitle}</p>
        ) : null}

        {/* Animated progress bar */}
        <div className="mt-3 px-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
              {inPostPhase ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin text-primary-500" />
                  {postPhaseLabel}
                </span>
              ) : (
                <>
                  {completedCount} / {total} agents complete
                  {failedCount > 0 && (
                    <span className="ml-1.5 text-red-500">({failedCount} failed)</span>
                  )}
                  {rounds > 1 && (
                    <span className="ml-1.5 text-slate-400">• round {rounds}</span>
                  )}
                </>
              )}
            </span>
            <span className="text-[11px] font-mono text-primary-600 dark:text-primary-400 tabular-nums">
              {progressPct}%
            </span>
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            {/* Fill: completed + half-credit for running, animates smoothly */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary-500 to-primary-400 transition-[width] duration-700 ease-out"
              style={{ width: `${progressPct}%` }}
            />
            {/* Animated shimmer overlay to convey active work while subtasks run */}
            {runningCount > 0 && (
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-transparent via-white/40 to-transparent animate-shimmer"
                style={{ width: `${progressPct}%` }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Grid of bots — clickable */}
      <BotCardGrid subtasks={subtasks} cols={cols} />
    </div>
  );
}
