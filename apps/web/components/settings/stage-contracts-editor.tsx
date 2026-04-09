'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck, ChevronDown, ChevronRight, Plus, Trash2,
  RotateCcw, Save, AlertTriangle, CheckCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────

interface SectionRequirement {
  heading: string;
  aliases?: string[];
  required: boolean;
  minWordCount?: number;
  mustContain?: string[];
}

interface StageContract {
  stageName: string;
  stageIndex: number;
  minTotalWords: number;
  maxRefinementPasses: number;
  hardGate: boolean;
  requiredSections: SectionRequirement[];
  requiredArtifacts: Array<{ type: string; description: string; required: boolean }>;
  requiredPatterns: Array<{ name: string; minOccurrences: number; description: string }>;
}

const STAGE_LABELS: Record<string, string> = {
  SCAN: 'SCAN',
  DECODE: 'Intent Extraction',
  BLUEPRINT: 'Capability Mining',
  SPEC_LOCK: 'Behavior Lock-in',
  ARCHITECT: 'Modernization Approach',
  FORGE: 'Co-Create',
  SHADOW_RUN: 'Parallel Run',
  EVOLVE: 'Continuous Modernization',
};

// ─── Section Editor ─────────────────────────────────────────

function SectionEditor({
  section,
  onChange,
  onRemove,
}: {
  section: SectionRequirement;
  onChange: (updated: SectionRequirement) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={section.heading}
            onChange={(e) => onChange({ ...section, heading: e.target.value })}
            className="flex-1 text-xs font-medium px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            placeholder="Section heading"
          />
          <label className="flex items-center gap-1 text-[10px] text-slate-500">
            <input
              type="checkbox"
              checked={section.required}
              onChange={(e) => onChange({ ...section, required: e.target.checked })}
              className="w-3 h-3"
            />
            Required
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={section.minWordCount ?? ''}
            onChange={(e) => onChange({ ...section, minWordCount: e.target.value ? parseInt(e.target.value) : undefined })}
            className="w-20 text-[10px] px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
            placeholder="Min words"
          />
          <input
            value={(section.mustContain ?? []).join(', ')}
            onChange={(e) => onChange({ ...section, mustContain: e.target.value ? e.target.value.split(',').map(s => s.trim()) : undefined })}
            className="flex-1 text-[10px] px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
            placeholder="Must contain keywords (comma separated)"
          />
          <input
            value={(section.aliases ?? []).join(', ')}
            onChange={(e) => onChange({ ...section, aliases: e.target.value ? e.target.value.split(',').map(s => s.trim()) : undefined })}
            className="flex-1 text-[10px] px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
            placeholder="Aliases (comma separated)"
          />
        </div>
      </div>
      <button onClick={onRemove} className="p-1 text-slate-400 hover:text-red-500 transition-colors mt-1">
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Stage Contract Card ────────────────────────────────────

function StageContractCard({
  contract,
  projectId,
  onSaved,
}: {
  contract: StageContract;
  projectId: string;
  onSaved: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [local, setLocal] = useState<StageContract>(contract);

  // Reset local state when contract changes from server
  useEffect(() => {
    setLocal(contract);
    setDirty(false);
  }, [contract]);

  const update = useCallback((patch: Partial<StageContract>) => {
    setLocal((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  const updateSection = useCallback((index: number, section: SectionRequirement) => {
    setLocal((prev) => {
      const sections = [...prev.requiredSections];
      sections[index] = section;
      return { ...prev, requiredSections: sections };
    });
    setDirty(true);
  }, []);

  const removeSection = useCallback((index: number) => {
    setLocal((prev) => ({
      ...prev,
      requiredSections: prev.requiredSections.filter((_, i) => i !== index),
    }));
    setDirty(true);
  }, []);

  const addSection = useCallback(() => {
    setLocal((prev) => ({
      ...prev,
      requiredSections: [...prev.requiredSections, { heading: 'New Section', required: false, minWordCount: 80 }],
    }));
    setDirty(true);
  }, []);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiClient.put(`/projects/${projectId}/contracts/${contract.stageName}`, {
        minTotalWords: local.minTotalWords,
        maxRefinementPasses: local.maxRefinementPasses,
        hardGate: local.hardGate,
        requiredSections: local.requiredSections,
      });
    },
    onSuccess: () => {
      setDirty(false);
      onSaved();
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      await apiClient.delete(`/projects/${projectId}/contracts/${contract.stageName}`);
    },
    onSuccess: () => {
      setDirty(false);
      onSaved();
    },
  });

  const requiredCount = local.requiredSections.filter((s) => s.required).length;
  const patternCount = local.requiredPatterns.length;

  return (
    <div className={cn(
      'rounded-lg border transition-colors',
      dirty ? 'border-amber-300 dark:border-amber-700' : 'border-slate-200 dark:border-slate-700',
    )}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100 flex-1">
          Stage {contract.stageIndex + 1}: {STAGE_LABELS[contract.stageName] || contract.stageName}
        </span>
        <div className="flex items-center gap-2">
          {local.hardGate ? (
            <Badge className="bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 text-[10px]">Hard Gate</Badge>
          ) : (
            <Badge className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 text-[10px]">Soft Gate</Badge>
          )}
          <span className="text-[10px] text-slate-400 tabular-nums">
            {requiredCount} sections · {patternCount} patterns · {local.minTotalWords}+ words
          </span>
          {dirty && <span className="w-2 h-2 rounded-full bg-amber-400" />}
        </div>
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-200 dark:border-slate-700">
          {/* Global settings */}
          <div className="flex items-center gap-4 pt-3">
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              Min words:
              <input
                type="number"
                value={local.minTotalWords}
                onChange={(e) => update({ minTotalWords: parseInt(e.target.value) || 0 })}
                className="w-20 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              Max refinements:
              <input
                type="number"
                value={local.maxRefinementPasses}
                onChange={(e) => update({ maxRefinementPasses: parseInt(e.target.value) || 0 })}
                className="w-16 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                checked={local.hardGate}
                onChange={(e) => update({ hardGate: e.target.checked })}
                className="w-3.5 h-3.5"
              />
              Hard gate (blocks pipeline)
            </label>
          </div>

          {/* Required Sections */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Required Sections</span>
              <button
                onClick={addSection}
                className="flex items-center gap-1 text-[10px] text-primary-600 hover:text-primary-700 transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add Section
              </button>
            </div>
            <div className="space-y-1.5">
              {local.requiredSections.map((section, i) => (
                <SectionEditor
                  key={`${section.heading}-${i}`}
                  section={section}
                  onChange={(updated) => updateSection(i, updated)}
                  onRemove={() => removeSection(i)}
                />
              ))}
            </div>
          </div>

          {/* Patterns (read-only display) */}
          {local.requiredPatterns.length > 0 && (
            <div>
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Required Patterns</span>
              <div className="mt-1 space-y-1">
                {local.requiredPatterns.map((p) => (
                  <div key={p.name} className="flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                    <CheckCircle className="w-3 h-3 text-green-400" />
                    <span className="font-mono">{p.name}</span>
                    <span>× {p.minOccurrences}+</span>
                    <span className="text-slate-400">— {p.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button
              size="sm"
              variant="outline"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
              className="gap-1 text-xs"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to Defaults
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!dirty || saveMutation.isPending}
              className="gap-1 text-xs"
            >
              <Save className="w-3 h-3" />
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function StageContractsEditor({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ contracts: StageContract[] }>({
    queryKey: ['project-contracts', projectId],
    queryFn: async () => (await apiClient.get(`/projects/${projectId}/contracts`)).data,
    staleTime: 30_000,
  });

  const contracts = data?.contracts ?? [];

  const handleSaved = () => {
    queryClient.invalidateQueries({ queryKey: ['project-contracts', projectId] });
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-primary-600" />
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Stage Validation Contracts</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Configure required sections, word counts, and validation rules per stage.
            Changes override defaults for this project only.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800">
        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Hard-gated stages block pipeline advancement if validation fails. Use carefully.
        </p>
      </div>

      <div className="space-y-2">
        {contracts.map((contract) => (
          <StageContractCard
            key={contract.stageName}
            contract={contract}
            projectId={projectId}
            onSaved={handleSaved}
          />
        ))}
      </div>
    </div>
  );
}
