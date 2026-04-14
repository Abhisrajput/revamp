'use client';

import { memo } from 'react';
import { FileUp, FileText, Trash2, FolderGit2, GitBranch, Cloud, Code2, Settings, Calendar, Tag, Layers } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { QuickSettings } from './quick-settings';
import { CostSummaryCard } from './cost-summary-card';
import type { StageState } from '@/lib/stores/pipeline-types';

// ─── Types ──────────────────────────────────────────────────────

interface SupportingDoc {
  id: string;
  name: string;
  size: number;
}

interface LeftRailProps {
  // Stage info (for contextual labels)
  stages: StageState[];
  activeStageIndex: number;

  // Quick settings — LLM models
  model: string;
  onModelChange: (modelId: string) => void;
  composerModel: string;
  onComposerModelChange: (modelId: string) => void;
  evaluatorModel: string;
  onEvaluatorModelChange: (modelId: string) => void;
  templateId: string;
  onTemplateChange: (templateId: string) => void;
  deepAnalysis: boolean;
  onDeepAnalysisChange: (enabled: boolean) => void;
  skipLlmEval: boolean;
  onSkipLlmEvalChange: (skip: boolean) => void;

  // Project data
  projectId: string;
  project?: any;

  // Supporting docs (optional)
  supportingDocs?: SupportingDoc[];
  onUploadDoc?: () => void;
  onRemoveDoc?: (id: string) => void;

  className?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ─── Component ──────────────────────────────────────────────────

export const LeftRail = memo(function LeftRail({
  stages,
  activeStageIndex,
  model,
  onModelChange,
  composerModel,
  onComposerModelChange,
  evaluatorModel,
  onEvaluatorModelChange,
  templateId,
  onTemplateChange,
  deepAnalysis,
  onDeepAnalysisChange,
  skipLlmEval,
  onSkipLlmEvalChange,
  projectId,
  project,
  supportingDocs = [],
  onUploadDoc,
  onRemoveDoc,
  className,
}: LeftRailProps) {
  const activeStage = stages[activeStageIndex];

  return (
    <div
      className={cn(
        'flex flex-col h-full overflow-y-auto overflow-x-hidden',
        className,
      )}
    >
      {/* ─── Project Overview ─────────────────────────────── */}
      {project && (
        <div className="px-3 pt-3 pb-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <FolderGit2 className="w-3 h-3" />
              Project
            </span>
            <Link
              href={`/projects/${projectId}/settings`}
              className="text-[10px] text-primary-600 dark:text-primary-400 hover:underline flex items-center gap-0.5"
            >
              <Settings className="w-2.5 h-2.5" />
              Settings
            </Link>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 p-2.5 space-y-2">
            <p className="text-[12px] font-medium text-slate-900 dark:text-slate-50 truncate" title={project.name}>
              {project.name}
            </p>
            {project.description && (
              <p className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-2">
                {project.description}
              </p>
            )}

            {/* Tags row */}
            <div className="flex flex-wrap gap-1.5">
              {project.status && (
                <span className="inline-flex items-center gap-1 text-[9px] bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded capitalize">
                  <Tag className="w-2.5 h-2.5" />
                  {project.status}
                </span>
              )}
              {project.source_type && (
                <span className="inline-flex items-center gap-1 text-[9px] bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-1.5 py-0.5 rounded capitalize">
                  <Layers className="w-2.5 h-2.5" />
                  {project.source_type}
                </span>
              )}
              {project.target_stack && (
                <span className="inline-flex items-center gap-1 text-[9px] bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded">
                  <Code2 className="w-2.5 h-2.5" />
                  {project.target_stack}
                </span>
              )}
              {project.target_cloud && (
                <span className="inline-flex items-center gap-1 text-[9px] bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 px-1.5 py-0.5 rounded">
                  <Cloud className="w-2.5 h-2.5" />
                  {project.target_cloud.toUpperCase()}
                </span>
              )}
            </div>

            {/* Settings details */}
            <div className="space-y-1 pt-0.5 border-t border-slate-100 dark:border-slate-700">
              {(project.source_url || project.repository_url) && (
                <div className="flex items-start gap-1.5">
                  <GitBranch className="w-3 h-3 text-slate-400 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[9px] text-slate-400 dark:text-slate-500 uppercase tracking-wide">Repository</p>
                    <p className="text-[10px] text-slate-600 dark:text-slate-300 truncate" title={project.source_url || project.repository_url}>
                      {(project.source_url || project.repository_url || '').replace(/^https?:\/\/(github|gitlab)\.com\//, '')}
                    </p>
                  </div>
                </div>
              )}
              {project.source_branch && (
                <div className="flex items-start gap-1.5">
                  <GitBranch className="w-3 h-3 text-slate-400 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[9px] text-slate-400 dark:text-slate-500 uppercase tracking-wide">Branch</p>
                    <p className="text-[10px] text-slate-600 dark:text-slate-300">{project.source_branch}</p>
                  </div>
                </div>
              )}
              {project.created_at && (
                <div className="flex items-start gap-1.5">
                  <Calendar className="w-3 h-3 text-slate-400 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[9px] text-slate-400 dark:text-slate-500 uppercase tracking-wide">Created</p>
                    <p className="text-[10px] text-slate-600 dark:text-slate-300">{new Date(project.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Divider ───────────────────────────────────────── */}
      {project && <div className="mx-3 border-t border-slate-200 dark:border-slate-700" />}

      {/* ─── Quick Settings ────────────────────────────────── */}
      <div className="px-3 pt-3 pb-3">
        <QuickSettings
          model={model}
          onModelChange={onModelChange}
          composerModel={composerModel}
          onComposerModelChange={onComposerModelChange}
          evaluatorModel={evaluatorModel}
          onEvaluatorModelChange={onEvaluatorModelChange}
          projectModels={(() => {
            try {
              const providers = (project?.settings as any)?.llmProviders || (project?.settings as any)?.llm_providers || [];
              return providers.flatMap((p: any) => p.available_models || []);
            } catch { return []; }
          })()}
          templateId={templateId}
          onTemplateChange={onTemplateChange}
          deepAnalysis={deepAnalysis}
          onDeepAnalysisChange={onDeepAnalysisChange}
          skipLlmEval={skipLlmEval}
          onSkipLlmEvalChange={onSkipLlmEvalChange}
          stageName={activeStage?.label}
        />
      </div>

      {/* ─── Divider ───────────────────────────────────────── */}
      <div className="mx-3 border-t border-slate-200 dark:border-slate-700" />

      {/* ─── Cost Summary ──────────────────────────────────── */}
      <div className="px-3 py-3">
        <CostSummaryCard projectId={projectId} />
      </div>

      {/* ─── Divider ───────────────────────────────────────── */}
      <div className="mx-3 border-t border-slate-200 dark:border-slate-700" />

      {/* ─── Supporting Docs ───────────────────────────────── */}
      <div className="px-3 py-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <FileUp className="w-3 h-3" />
            Docs
          </span>
          {onUploadDoc && (
            <button
              onClick={onUploadDoc}
              className="text-[10px] text-primary-600 dark:text-primary-400 hover:underline"
            >
              + Add
            </button>
          )}
        </div>

        {supportingDocs.length === 0 ? (
          <p className="text-[10px] text-slate-400 dark:text-slate-500 italic">
            No supporting docs
          </p>
        ) : (
          <div className="space-y-1">
            {supportingDocs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-1.5 group text-xs text-slate-600 dark:text-slate-400"
              >
                <FileText className="w-3 h-3 flex-shrink-0 text-slate-400" />
                <span className="flex-1 truncate" title={doc.name}>
                  {doc.name}
                </span>
                <span className="text-[9px] text-slate-400 dark:text-slate-500 flex-shrink-0">
                  {formatFileSize(doc.size)}
                </span>
                {onRemoveDoc && (
                  <button
                    onClick={() => onRemoveDoc(doc.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-600"
                    title="Remove"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Spacer ────────────────────────────────────────── */}
      <div className="flex-1" />
    </div>
  );
});
