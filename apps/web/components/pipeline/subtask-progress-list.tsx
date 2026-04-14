'use client';

import type { ScanSubtaskState } from '@/lib/stores/pipeline-types';
import { CheckCircle2, Circle, Loader2, XCircle, Bot } from 'lucide-react';

const TYPE_LABELS: Record<string, string> = {
  // SCAN subtasks
  'architecture-analysis': 'Architecture Analysis',
  'tech-stack-deepdive': 'Technology Stack',
  'legacy-patterns': 'Legacy Patterns',
  'data-layer': 'Data Layer',
  'security-scan': 'Security Scan',
  'business-capabilities': 'Business Capabilities',
  // DECODE subtasks
  'business-rules-extraction': 'Business Rules Extraction',
  'data-flow-analysis': 'Data Flow Analysis',
  'workflow-extraction': 'Workflow Extraction',
  'domain-entity-modeling': 'Domain Entity Modeling',
  'integration-mapping': 'Integration Mapping',
  'constraints-debt-analysis': 'Constraints & Tech Debt',
};

function StatusIcon({ status }: { status: ScanSubtaskState['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />;
    case 'running':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
    default:
      return <Circle className="h-4 w-4 text-zinc-500 shrink-0" />;
  }
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

export function SubtaskProgressList({ subtasks = [] }: { subtasks?: ScanSubtaskState[] }) {

  if (!subtasks || subtasks.length === 0) return null;

  const completed = subtasks.filter((t: ScanSubtaskState) => t.status === 'completed').length;
  const failed = subtasks.filter((t: ScanSubtaskState) => t.status === 'failed').length;
  const total = subtasks.length;

  return (
    <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Agent Subtasks
        </h4>
        <span className="text-xs text-zinc-500">
          {completed}/{total} complete
          {failed > 0 && <span className="text-red-500 ml-1">({failed} failed)</span>}
        </span>
      </div>

      <div className="space-y-1">
        {subtasks.map((subtask: ScanSubtaskState, i: number) => (
          <div
            key={subtask.id}
            className={`flex items-center gap-2 py-1.5 px-2 rounded text-sm transition-colors ${
              subtask.status === 'running'
                ? 'bg-blue-500/10 border border-blue-500/20'
                : subtask.status === 'completed'
                ? 'bg-zinc-800/30'
                : subtask.status === 'failed'
                ? 'bg-red-500/5'
                : 'bg-transparent'
            }`}
          >
            {/* Timeline line */}
            <div className="flex flex-col items-center shrink-0">
              <StatusIcon status={subtask.status} />
              {i < subtasks.length - 1 && (
                <div className={`w-px h-3 mt-0.5 ${
                  subtask.status === 'completed' ? 'bg-emerald-500/30' : 'bg-zinc-700'
                }`} />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`font-medium truncate ${
                  subtask.status === 'running' ? 'text-blue-400' :
                  subtask.status === 'failed' ? 'text-red-400' :
                  subtask.status === 'completed' ? 'text-zinc-300' :
                  'text-zinc-500'
                }`}>
                  {TYPE_LABELS[subtask.type] || subtask.title}
                </span>
              </div>
              {subtask.agentName && (
                <div className="flex items-center gap-1 text-xs text-zinc-500 mt-0.5">
                  <Bot className="h-3 w-3" />
                  <span className="truncate">{subtask.agentName}</span>
                  {subtask.duration && (
                    <span className="text-zinc-600 ml-auto shrink-0">
                      {formatDuration(subtask.duration)}
                    </span>
                  )}
                </div>
              )}
              {subtask.status === 'failed' && subtask.error && (
                <p className="text-xs text-red-400/80 mt-0.5 truncate">{subtask.error}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
