'use client';

import { useState } from 'react';
import { useEvolutionMemories } from '@revamp/core';
import type { EvolutionMemory } from '@revamp/core';
import { Card } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { Lightbulb, Filter } from 'lucide-react';

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  legacy_pattern: {
    label: 'Legacy Pattern',
    color: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  },
  error_recovery: {
    label: 'Error Recovery',
    color: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  },
  user_preference: {
    label: 'User Preference',
    color: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  },
  domain_knowledge: {
    label: 'Domain Knowledge',
    color: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
  },
};

const CATEGORIES = ['all', 'legacy_pattern', 'error_recovery', 'user_preference', 'domain_knowledge'] as const;

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.8
    ? 'bg-emerald-500'
    : confidence >= 0.5
      ? 'bg-amber-500'
      : 'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-400 tabular-nums">{pct}%</span>
    </div>
  );
}

function MemoryItem({ memory }: { memory: EvolutionMemory }) {
  const meta = CATEGORY_META[memory.category ?? ''] || CATEGORY_META.domain_knowledge;

  return (
    <div className="px-3 py-3 rounded-lg border border-slate-100 dark:border-slate-700/50 hover:border-slate-200 dark:hover:border-slate-700 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <Badge className={`${meta.color} text-[10px] px-1.5 py-0`}>
          {meta.label}
        </Badge>
        <ConfidenceBar confidence={memory.confidence} />
      </div>

      <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed mb-2">
        {memory.summary}
      </p>

      <div className="flex items-center justify-between text-[10px] text-slate-400 dark:text-slate-500">
        <div className="flex items-center gap-3">
          {memory.sourceStage && (
            <span className="font-mono">{memory.sourceStage}</span>
          )}
          <span className="tabular-nums">used {memory.usageCount ?? 0}x</span>
        </div>
        <span>{new Date(memory.createdAt ?? memory.created_at).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

export function EvolutionMemoryPanel({ agentId }: { agentId: string }) {
  const [category, setCategory] = useState<string>('all');
  const { data: memories, isLoading } = useEvolutionMemories(
    agentId,
    category === 'all' ? undefined : category,
  );

  return (
    <Card className="bg-white dark:bg-slate-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            Evolution Memory
          </h3>
          {memories && (
            <span className="text-xs text-slate-400 tabular-nums">
              ({memories.length})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Filter className="w-3 h-3 text-slate-400" />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="text-[11px] bg-transparent border-none text-slate-500 dark:text-slate-400 cursor-pointer focus:outline-none"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c === 'all' ? 'All categories' : CATEGORY_META[c]?.label || c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-slate-100 dark:bg-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : memories && memories.length > 0 ? (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {memories.map((m) => (
            <MemoryItem key={m.id} memory={m} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400 dark:text-slate-500 text-center py-6">
          No evolution memories yet. They&apos;ll appear after pipeline stages complete.
        </p>
      )}
    </Card>
  );
}
