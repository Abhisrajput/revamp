'use client';

import { memo, useMemo, useState, type ComponentType } from 'react';
import { Play, Square, SkipForward, RotateCcw, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InlinePromptEditor } from './inline-prompt-editor';
import { ElapsedTimer } from '@/components/pipeline/elapsed-timer';
import { STAGE_PANEL_MAP } from '@/components/pipeline/stage-panels';
import { useRefineSection } from '@/lib/hooks/use-refine-section';
import type { StagePanelProps } from '@/components/pipeline/stage-panels/types';
import type { StageState } from '@/lib/stores/pipeline-store';
import { stageRequiresApproval } from '@/lib/stores/pipeline-store';

// ─── Status Badge ───────────────────────────────────────────────

function StatusBadge({ status }: { status: StageState['status'] }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    locked: { bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-500 dark:text-slate-400', label: 'Locked' },
    pending: { bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-600 dark:text-slate-300', label: 'Ready' },
    generating: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', label: 'Generating' },
    validating: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', label: 'Validating' },
    completed: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-300', label: 'Completed' },
    failed: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', label: 'Failed' },
    approved: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-300', label: 'Approved' },
  };

  const c = config[status] ?? config.locked;

  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium', c.bg, c.text)}>
      {c.label}
    </span>
  );
}

// ─── Progress Bar ───────────────────────────────────────────────

function ProgressBar({ progress, isActive }: { progress: number; isActive: boolean }) {
  if (!isActive || progress === 0) return null;

  return (
    <div className="w-full h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
      <div
        className="h-full bg-primary-500 rounded-full transition-all duration-300"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────

interface CenterPanelProps {
  /** Current stage state */
  stage: StageState;
  /** Stage index (0-7) */
  stageIndex: number;
  /** Total number of stages */
  totalStages?: number;
  /** Streaming text from LLM */
  streamingText: string;
  /** Project data */
  project: any;
  /** Pipeline run ID */
  pipelineRunId: string | null;
  /** Stage execution handler */
  onExecute: () => void;
  /** Stop execution */
  onStop?: () => void;
  /** Advance to next stage */
  onAdvance?: () => void;
  /** Re-run current stage */
  onRerun?: () => void;
  /** Approval handler */
  onApprove: (comment?: string) => void;
  /** Rejection handler */
  onReject: (reason: string) => void;
  /** Whether execution is in progress */
  isExecuting: boolean;
  /** Current execution phase */
  currentPhase: string | null;

  // Inline prompt editor
  promptEditorOpen: boolean;
  onTogglePromptEditor: () => void;
  currentPrompt: string;
  onSavePrompt: (prompt: string) => void;
  onResetPrompt: () => void;

  // Validation prompt editor
  validationPrompt?: string;
  onSaveValidationPrompt?: (prompt: string) => void;
  onResetValidationPrompt?: () => void;

  className?: string;
}

export const CenterPanel = memo(function CenterPanel({
  stage,
  stageIndex,
  totalStages = 8,
  streamingText,
  project,
  pipelineRunId,
  onExecute,
  onStop,
  onAdvance,
  onRerun,
  onApprove,
  onReject,
  isExecuting,
  currentPhase,
  promptEditorOpen,
  onTogglePromptEditor,
  currentPrompt,
  onSavePrompt,
  onResetPrompt,
  validationPrompt,
  onSaveValidationPrompt,
  onResetValidationPrompt,
  className,
}: CenterPanelProps) {
  const [validationPromptOpen, setValidationPromptOpen] = useState(false);

  // Resolve the dynamic stage panel component
  const StagePanel: ComponentType<StagePanelProps> | undefined = useMemo(
    () => STAGE_PANEL_MAP[stage.name],
    [stage.name],
  );

  // Refine section hook — wired to API
  const onRefineRequest = useRefineSection(pipelineRunId, stage.name);

  const isActive = stage.status === 'generating' || stage.status === 'validating';

  return (
    <div className={cn('flex flex-col h-full min-w-0', className)}>
      {/* ─── Header ───────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              {stage.label}
            </h2>
            <StatusBadge status={stage.status} />
            {currentPhase && isActive && (
              <span className="text-[10px] text-primary-600 dark:text-primary-400 font-medium truncate">
                {currentPhase}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* Inline action buttons */}
            {isExecuting ? (
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                <Square className="w-3 h-3" />
                Stop
              </button>
            ) : (
              <>
                {stage.status === 'pending' &&
                  !(stageRequiresApproval(stage.name) && stage.approvalStatus === 'pending') && (
                  <button
                    onClick={() => { try { onExecute(); } catch { /* error handled by stage panel */ } }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-primary-600 hover:bg-primary-700 text-white transition-colors"
                  >
                    <Play className="w-3 h-3" />
                    Execute
                  </button>
                )}
                {stage.status === 'failed' && onRerun && (
                  <button
                    onClick={() => { try { onRerun(); } catch { /* silent */ } }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Re-run
                  </button>
                )}
                {(stage.status === 'completed' || stage.status === 'approved') && stageIndex < totalStages - 1 && onAdvance && (
                  <button
                    onClick={onAdvance}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-green-600 hover:bg-green-700 text-white transition-colors"
                  >
                    <SkipForward className="w-3 h-3" />
                    Next
                  </button>
                )}
                {/* Re-run moved to approval gate (requires comment) */}
              </>
            )}

            <ElapsedTimer
              startedAt={stage.startedAt}
              completedAt={stage.completedAt}
            />
          </div>
        </div>

        {/* Progress bar */}
        <ProgressBar progress={stage.progress} isActive={isActive} />
      </div>

      {/* ─── Prompt Editors ──────────────────────────────── */}
      <div className="flex-shrink-0 flex border-b border-slate-200 dark:border-slate-700 max-h-[50vh] overflow-hidden">
        <div className={cn(
          'min-w-0 overflow-y-auto',
          promptEditorOpen && !validationPromptOpen ? 'flex-[2]' : 'flex-1',
          !promptEditorOpen && validationPromptOpen ? 'flex-shrink-0 w-auto' : '',
        )}>
          <InlinePromptEditor
            open={promptEditorOpen}
            onToggle={onTogglePromptEditor}
            prompt={currentPrompt}
            onSave={onSavePrompt}
            onReset={onResetPrompt}
            stageLabel={stage.label}
            className="border-b-0"
          />
        </div>
        {onSaveValidationPrompt && onResetValidationPrompt && (
          <div className={cn(
            'min-w-0 overflow-y-auto border-l border-slate-200 dark:border-slate-700',
            validationPromptOpen && !promptEditorOpen ? 'flex-[2]' : 'flex-1',
            !validationPromptOpen && promptEditorOpen ? 'flex-shrink-0 w-auto' : '',
          )}>
            <InlinePromptEditor
              open={validationPromptOpen}
              onToggle={() => setValidationPromptOpen(!validationPromptOpen)}
              prompt={validationPrompt ?? ''}
              onSave={onSaveValidationPrompt}
              onReset={onResetValidationPrompt}
              stageLabel={stage.label}
              label="Validation Prompt"
              className="border-b-0"
            />
          </div>
        )}
      </div>

      {/* ─── Error Banner ────────────────────────────────── */}
      {stage.status === 'failed' && stage.error && (
        <div className="flex-shrink-0 px-4 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800/40">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                Stage failed
              </p>
              <p className="text-sm text-red-700 dark:text-red-400 mt-0.5">
                {stage.error}
              </p>
            </div>
            <button
              onClick={() => { try { onRerun?.(); } catch { /* silent */ } }}
              className="flex-shrink-0 text-xs font-medium text-red-700 dark:text-red-300 hover:text-red-900 dark:hover:text-red-100 underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ─── Stage Panel Content ──────────────────────────── */}
      <div className="flex-1 min-h-0">
        {StagePanel ? (
          <StagePanel
            stage={stage}
            stageIndex={stageIndex}
            streamingText={streamingText}
            project={project}
            pipelineRunId={pipelineRunId}
            onExecute={onExecute}
            onStop={onStop}
            onApprove={onApprove}
            onReject={onReject}
            isExecuting={isExecuting}
            currentPhase={currentPhase}
            onRefineRequest={onRefineRequest}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-slate-500 dark:text-slate-400">
            Panel for stage &ldquo;{stage.name}&rdquo; not found
          </div>
        )}
      </div>
    </div>
  );
});
