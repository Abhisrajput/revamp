'use client';

import { useState, memo, useMemo } from 'react';
import { ChevronDown, ChevronRight, Wrench, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// --- Types ---

export interface ToolCall {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  input?: Record<string, unknown>;
  output?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

interface AgentActivityProps {
  toolCalls: ToolCall[];
  className?: string;
  maxHeight?: string;
}

// --- Status Icons ---

function StatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />;
    case 'completed':
      return <CheckCircle className="h-3.5 w-3.5 text-green-400" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-400" />;
  }
}

// --- Tool Name Colors ---

const TOOL_COLORS: Record<string, string> = {
  readFile: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  writeFile: 'bg-green-500/20 text-green-400 border-green-500/30',
  editFile: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  listFiles: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  searchCode: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  shellExec: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
};

function getToolColor(toolName: string): string {
  return TOOL_COLORS[toolName] || 'bg-slate-500/20 text-slate-400 border-slate-500/30';
}

// --- Format Duration ---

function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- Tool Call Item ---

const ToolCallItem = memo(function ToolCallItem({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-slate-700/50 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-slate-500 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-slate-500 shrink-0" />
        )}
        <StatusIcon status={call.status} />
        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 border', getToolColor(call.toolName))}>
          {call.toolName}
        </Badge>
        <span className="text-xs text-slate-400 truncate flex-1">
          {call.input ? summarizeInput(call.toolName, call.input) : ''}
        </span>
        {call.durationMs != null && (
          <span className="text-[10px] text-slate-500 tabular-nums shrink-0">
            {formatDuration(call.durationMs)}
          </span>
        )}
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t border-slate-700/50 bg-slate-900/30">
          {call.input && (
            <div className="px-3 py-2 border-b border-slate-700/30">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Input</span>
              <pre className="text-xs text-slate-300 mt-1 overflow-x-auto whitespace-pre-wrap font-mono">
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </div>
          )}
          {call.output && (
            <div className="px-3 py-2">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Output</span>
              <pre className="text-xs text-slate-300 mt-1 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
                {call.output.length > 2000 ? call.output.slice(0, 2000) + '\n... (truncated)' : call.output}
              </pre>
            </div>
          )}
          {!call.input && !call.output && (
            <p className="text-xs text-slate-500 px-3 py-2">No data available</p>
          )}
        </div>
      )}
    </div>
  );
});

// --- Summarize tool input for preview ---

function summarizeInput(_toolName: string, input: Record<string, unknown>): string {
  if (input.path) return String(input.path);
  if (input.filePath) return String(input.filePath);
  if (input.command) return String(input.command).slice(0, 60);
  if (input.query) return String(input.query).slice(0, 60);
  if (input.pattern) return String(input.pattern).slice(0, 60);

  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  return `${keys[0]}: ${String(input[keys[0]]).slice(0, 40)}`;
}

// --- Main Component ---

export const AgentActivity = memo(function AgentActivity({ toolCalls = [], className, maxHeight = '400px' }: AgentActivityProps) {
  const calls = toolCalls ?? [];
  const { completedCount, failedCount, runningCount } = useMemo(() => ({
    completedCount: calls.filter((c) => c.status === 'completed').length,
    failedCount: calls.filter((c) => c.status === 'failed').length,
    runningCount: calls.filter((c) => c.status === 'running').length,
  }), [calls]);

  return (
    <div className={cn('rounded-lg border border-slate-700 bg-slate-950 overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-xs font-medium text-slate-400">Agent Activity</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {runningCount > 0 && (
            <span className="flex items-center gap-1 text-blue-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {runningCount}
            </span>
          )}
          {completedCount > 0 && (
            <span className="flex items-center gap-1 text-green-400">
              <CheckCircle className="h-3 w-3" />
              {completedCount}
            </span>
          )}
          {failedCount > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <XCircle className="h-3 w-3" />
              {failedCount}
            </span>
          )}
        </div>
      </div>

      {/* Tool Calls */}
      <div className="overflow-y-auto p-2 space-y-1.5" style={{ maxHeight }}>
        {calls.length === 0 ? (
          <p className="text-xs text-slate-600 text-center py-6">
            No tool calls yet
          </p>
        ) : (
          calls.map((call) => (
            <ToolCallItem key={call.id} call={call} />
          ))
        )}
      </div>
    </div>
  );
});
