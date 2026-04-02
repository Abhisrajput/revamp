'use client';

import { memo, useEffect, useState } from 'react';
import { Cpu, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  contextWindow?: number;
}

// ─── Dynamic model fetching from Go orchestrator via API ────────

let cachedModels: ModelOption[] | null = null;
let fetchPromise: Promise<ModelOption[]> | null = null;

/** Readable names for known models */
const MODEL_LABELS: Record<string, string> = {
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'Claude Haiku 4.5',
  'us.anthropic.claude-haiku-4-6-20251001-v1:0': 'Claude Haiku 4.6',
  'us.anthropic.claude-sonnet-4-5-20251001-v1:0': 'Claude Sonnet 4.5',
  'us.anthropic.claude-sonnet-4-6-20251001-v1:0': 'Claude Sonnet 4.6',
  'us.anthropic.claude-opus-4-5-20251001-v1:0': 'Claude Opus 4.5',
  'us.anthropic.claude-opus-4-6-20251001-v1:0': 'Claude Opus 4.6',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': 'Claude 3.5 Sonnet v2',
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': 'Claude 3.5 Haiku',
  'us.anthropic.claude-3-7-sonnet-20250219-v1:0': 'Claude 3.7 Sonnet',
  'anthropic.claude-3-haiku-20240307-v1:0': 'Claude 3 Haiku',
  'anthropic.claude-3-sonnet-20240229-v1:0': 'Claude 3 Sonnet',
  'anthropic.claude-3-opus-20240229-v1:0': 'Claude 3 Opus',
  'meta.llama3-70b-instruct-v1:0': 'Llama 3 70B',
  'meta.llama3-8b-instruct-v1:0': 'Llama 3 8B',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4-turbo': 'GPT-4 Turbo',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  'gemini-1.5-pro': 'Gemini 1.5 Pro',
};

async function fetchAvailableModels(): Promise<ModelOption[]> {
  if (cachedModels) return cachedModels;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const response = await apiClient.get('/usage/models');
      const data = response.data;
      const models: ModelOption[] = [];

      const raw = data.models || data;
      if (Array.isArray(raw)) {
        for (const m of raw) {
          models.push({
            id: m.id,
            label: MODEL_LABELS[m.id] || m.name || m.id,
            provider: m.provider || 'unknown',
            contextWindow: m.context_size || m.contextWindow,
          });
        }
      } else if (typeof raw === 'object') {
        for (const [id, info] of Object.entries(raw as Record<string, any>)) {
          models.push({
            id,
            label: MODEL_LABELS[id] || (info as any).name || id,
            provider: (info as any).provider || 'unknown',
            contextWindow: (info as any).context_size || (info as any).contextWindow,
          });
        }
      }

      // Sort: newest/best first per provider
      const providerOrder: Record<string, number> = { anthropic: 0, bedrock: 0, openai: 1, gemini: 2, google: 2 };
      const tierOrder = (id: string): number => {
        if (id.includes('opus')) return 0;
        if (id.includes('sonnet-4')) return 1;
        if (id.includes('sonnet')) return 2;
        if (id.includes('haiku-4')) return 3;
        if (id.includes('haiku')) return 4;
        if (id.includes('gpt-4o-mini')) return 5;
        if (id.includes('gpt-4o')) return 1;
        if (id.includes('flash')) return 3;
        return 6;
      };
      models.sort((a, b) => {
        const pa = providerOrder[a.provider.toLowerCase()] ?? 9;
        const pb = providerOrder[b.provider.toLowerCase()] ?? 9;
        if (pa !== pb) return pa - pb;
        return tierOrder(a.id) - tierOrder(b.id);
      });

      cachedModels = models;
      return models;
    } catch {
      return [];
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

/** Invalidate cached models (call after config changes) */
export function invalidateModelCache(): void {
  cachedModels = null;
  fetchPromise = null;
}

// ─── Hook ───────────────────────────────────────────────────────

export function useAvailableModels(): { models: ModelOption[]; loading: boolean } {
  const [models, setModels] = useState<ModelOption[]>(cachedModels || []);
  const [loading, setLoading] = useState(!cachedModels);

  useEffect(() => {
    let cancelled = false;
    fetchAvailableModels().then((m) => {
      if (!cancelled) {
        setModels(m);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  return { models, loading };
}

// ─── Component ──────────────────────────────────────────────────

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  /** Optional label override — defaults to "Model" */
  label?: string;
  /** Compact mode hides the label */
  compact?: boolean;
  className?: string;
}

export const ModelSelector = memo(function ModelSelector({
  value,
  onChange,
  label = 'Model',
  compact = false,
  className,
}: ModelSelectorProps) {
  const { models, loading } = useAvailableModels();
  const selected = models.find((m) => m.id === value);

  // Auto-select first model if current value isn't in the list
  useEffect(() => {
    if (!loading && models.length > 0 && !models.find((m) => m.id === value)) {
      onChange(models[0].id);
    }
  }, [loading, models, value, onChange]);

  return (
    <div className={cn('space-y-1', className)}>
      {!compact && (
        <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Cpu className="w-3 h-3" />
          {label}
        </label>
      )}
      <div className="relative">
        {loading ? (
          <div className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm text-slate-500 pl-2.5 pr-7 py-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading models...
          </div>
        ) : (
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(
              'w-full appearance-none rounded-md border border-slate-200 dark:border-slate-600',
              'bg-white dark:bg-slate-700 text-sm text-slate-900 dark:text-slate-100',
              'pl-2.5 pr-7 py-1.5 cursor-pointer',
              'hover:border-primary-300 dark:hover:border-primary-600',
              'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
              'transition-colors',
            )}
          >
            {models.length === 0 && (
              <option value="">No models available</option>
            )}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        )}
        {!loading && (
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        )}
      </div>
      {selected && !compact && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 truncate">
          {selected.provider} &middot; {selected.id}
          {selected.contextWindow ? ` &middot; ${(selected.contextWindow / 1000).toFixed(0)}k ctx` : ''}
        </p>
      )}
    </div>
  );
});
