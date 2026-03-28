'use client';

import { memo, useMemo } from 'react';
import { FileText, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Inline preset template metadata ────────────────────────────
// Sourced from @revamp/core-engine preset-templates (9 templates)

type TemplateCategory = 'Foundation' | 'Web Apps' | 'Architecture' | 'Infrastructure' | 'Strategy' | 'Design';

interface TemplateOption {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
}

const CATEGORIES: TemplateCategory[] = [
  'Foundation', 'Web Apps', 'Architecture', 'Infrastructure', 'Strategy', 'Design',
];

export const PRESET_TEMPLATES: TemplateOption[] = [
  { id: 'lean-modernization-multi-project', name: 'Lean Multi-Project Migration', description: 'Low-token, low-iteration prompts optimized for repeatable legacy modernization programs.', category: 'Foundation' },
  { id: 'model-agnostic-baseline', name: 'Model-Agnostic Baseline', description: 'Provider-neutral stage prompts that work across OpenAI, Anthropic, Gemini, Bedrock, and compatible gateways.', category: 'Foundation' },
  { id: 'python-spa-modernization', name: 'Python + SPA Modernization', description: 'Optimized for Flask/Django + Vue/React style apps and similar API + frontend legacy stacks.', category: 'Web Apps' },
  { id: 'microservices', name: 'Microservices Decomposition', description: 'Break monolithic legacy systems into independently deployable microservices with clear domain boundaries.', category: 'Architecture' },
  { id: 'api-first', name: 'API-First Modernization', description: 'Transform legacy systems into API-driven architectures with OpenAPI specs and contract-first development.', category: 'Architecture' },
  { id: 'event-driven', name: 'Event-Driven Architecture', description: 'Modernize to an event-driven system with message queues, event sourcing, and CQRS patterns.', category: 'Architecture' },
  { id: 'cloud-native', name: 'Cloud-Native Migration', description: 'Lift-and-shift with re-architecture for cloud-native services (containers, serverless, managed services).', category: 'Infrastructure' },
  { id: 'strangler-fig', name: 'Strangler Fig Pattern', description: 'Incrementally replace legacy components while keeping the system running, using facade routing.', category: 'Strategy' },
  { id: 'ddd-refactor', name: 'Domain-Driven Design Refactor', description: 'Restructure legacy code around domain models using DDD tactical patterns (aggregates, entities, value objects).', category: 'Design' },
];

// ─── Component ──────────────────────────────────────────────────

interface PromptTemplateSelectorProps {
  value: string; // template ID or '' for default
  onChange: (templateId: string) => void;
  /** Compact mode hides the label */
  compact?: boolean;
  className?: string;
}

export const PromptTemplateSelector = memo(function PromptTemplateSelector({
  value,
  onChange,
  compact = false,
  className,
}: PromptTemplateSelectorProps) {
  const selected = useMemo(
    () => PRESET_TEMPLATES.find((t) => t.id === value),
    [value],
  );

  // Group templates by category for the optgroup display
  const grouped = useMemo(() => {
    const map = new Map<string, TemplateOption[]>();
    for (const cat of CATEGORIES) {
      const templates = PRESET_TEMPLATES.filter((t) => t.category === cat);
      if (templates.length > 0) map.set(cat, templates);
    }
    return map;
  }, []);

  return (
    <div className={cn('space-y-1', className)}>
      {!compact && (
        <label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <FileText className="w-3 h-3" />
          Template
        </label>
      )}
      <div className="relative">
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
          <option value="">Default (Stage-specific)</option>
          {Array.from(grouped.entries()).map(([category, templates]) => (
            <optgroup key={category} label={category}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
      </div>
      {selected && !compact && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 line-clamp-2">
          {selected.description}
        </p>
      )}
    </div>
  );
});
