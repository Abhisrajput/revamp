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

async function fetchAvailableModels(): Promise<ModelOption[]> {
  if (cachedModels) return cachedModels;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const response = await apiClient.get('/usage/models');
      const data = response.data;
      const models: ModelOption[] = [];

      // Handle both { models: [...] } and { models: { id: {...} } } formats
      const raw = data.models || data;
      if (Array.isArray(raw)) {
        for (const m of raw) {
          models.push({
            id: m.id,
            label: m.name || m.id,
            provider: m.provider || 'unknown',
            contextWindow: m.context_size || m.contextWindow,
          });
        }
      } else if (typeof raw === 'object') {
        for (const [id, info] of Object.entries(raw as Record<string, any>)) {
          models.push({
            id,
            label: info.name || id,
            provider: info.provider || 'unknown',
            contextWindow: info.context_size || info.contextWindow,
          });
        }
      }

      // Sort: Anthropic first, then OpenAI, then Google, then others
      const providerOrder: Record<string, number> = { anthropic: 0, openai: 1, gemini: 2, google: 2 };
      models.sort((a, b) => {
        const pa = providerOrder[a.provider.toLowerCase()] ?? 9;
        const pb = providerOrder[b.provider.toLowerCase()] ?? 9;
        if (pa !== pb) return pa - pb;
        return a.id.localeCompare(b.id);
      });

      cachedModels = models;
      return models;
    } catch {
      // Fallback: return empty — UI will show "No models available"
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
                {model.label} ({model.provider})
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
