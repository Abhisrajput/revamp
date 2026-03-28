'use client';

import { memo, useState } from 'react';
import { Settings2, Sparkles, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ModelSelector } from './model-selector';
import { PromptTemplateSelector } from './prompt-template-selector';

// ─── Component ──────────────────────────────────────────────────

interface QuickSettingsProps {
  /** Currently selected execution model for this stage */
  model: string;
  onModelChange: (modelId: string) => void;
  /** Currently selected evaluator/validation model for this stage */
  evaluatorModel: string;
  onEvaluatorModelChange: (modelId: string) => void;
  /** Currently selected prompt template */
  templateId: string;
  onTemplateChange: (templateId: string) => void;
  /** Deep analysis toggle */
  deepAnalysis: boolean;
  onDeepAnalysisChange: (enabled: boolean) => void;
  /** Skip LLM evaluation toggle */
  skipLlmEval: boolean;
  onSkipLlmEvalChange: (skip: boolean) => void;
  /** Current stage name for contextual labeling */
  stageName?: string;
  className?: string;
}

export const QuickSettings = memo(function QuickSettings({
  model,
  onModelChange,
  evaluatorModel,
  onEvaluatorModelChange,
  templateId,
  onTemplateChange,
  deepAnalysis,
  onDeepAnalysisChange,
  skipLlmEval,
  onSkipLlmEvalChange,
  stageName,
  className,
}: QuickSettingsProps) {
  const [showValidation, setShowValidation] = useState(true);

  return (
    <div className={cn('space-y-3', className)}>
      {/* Section Header */}
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <Settings2 className="w-3 h-3" />
        Quick Settings
        {stageName && (
          <span className="text-[10px] font-normal normal-case tracking-normal text-slate-400 dark:text-slate-500">
            &middot; {stageName}
          </span>
        )}
      </div>

      {/* ─── Execution Model ────────────────────────────────── */}
      <ModelSelector
        value={model}
        onChange={onModelChange}
        label="Execution Model"
      />

      {/* ─── Validation Section ─────────────────────────────── */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden">
        <button
          onClick={() => setShowValidation(!showValidation)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-750 transition-colors"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-3 h-3" />
            Validation
          </span>
          {showValidation ? (
            <ChevronUp className="w-3 h-3 text-slate-400" />
          ) : (
            <ChevronDown className="w-3 h-3 text-slate-400" />
          )}
        </button>

        {showValidation && (
          <div className="px-2.5 py-2 space-y-2.5">
            {/* Evaluator Model */}
            <ModelSelector
              value={evaluatorModel}
              onChange={onEvaluatorModelChange}
              label="Evaluator Model"
            />

            {/* Skip LLM Eval Toggle */}
            <div className="flex items-center justify-between">
              <label
                htmlFor="skip-llm-eval-toggle"
                className="text-[10px] font-medium text-slate-500 dark:text-slate-400 cursor-pointer"
              >
                Skip LLM Eval
              </label>
              <button
                id="skip-llm-eval-toggle"
                role="switch"
                aria-checked={skipLlmEval}
                onClick={() => onSkipLlmEvalChange(!skipLlmEval)}
                className={cn(
                  'relative inline-flex h-4 w-7 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                  skipLlmEval
                    ? 'bg-amber-500'
                    : 'bg-slate-300 dark:bg-slate-600',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform',
                    skipLlmEval ? 'translate-x-[14px]' : 'translate-x-[3px]',
                  )}
                />
              </button>
            </div>
            {skipLlmEval && (
              <p className="text-[9px] text-amber-600 dark:text-amber-400 -mt-1">
                Only deterministic + contract checks (faster, no LLM cost)
              </p>
            )}

            {/* Validation method info */}
            <div className="text-[9px] text-slate-400 dark:text-slate-500 space-y-0.5 border-t border-slate-100 dark:border-slate-700 pt-1.5">
              <p className="font-medium text-slate-500 dark:text-slate-400">3-Phase Validation:</p>
              <p>1. Deterministic checks (35%)</p>
              <p>2. Contract enforcement (30%)</p>
              <p>3. LLM evaluation (35%)</p>
            </div>
          </div>
        )}
      </div>

      {/* ─── Template Selector ──────────────────────────────── */}
      <PromptTemplateSelector value={templateId} onChange={onTemplateChange} />

      {/* ─── Deep Analysis Toggle ───────────────────────────── */}
      <div className="flex items-center justify-between">
        <label
          htmlFor="deep-analysis-toggle"
          className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400 cursor-pointer"
        >
          <Sparkles className="w-3 h-3" />
          Deep Analysis
        </label>
        <button
          id="deep-analysis-toggle"
          role="switch"
          aria-checked={deepAnalysis}
          onClick={() => onDeepAnalysisChange(!deepAnalysis)}
          className={cn(
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/20',
            deepAnalysis
              ? 'bg-primary-600'
              : 'bg-slate-300 dark:bg-slate-600',
          )}
        >
          <span
            className={cn(
              'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
              deepAnalysis ? 'translate-x-[18px]' : 'translate-x-[3px]',
            )}
          />
        </button>
      </div>
      {deepAnalysis && (
        <p className="text-[10px] text-primary-600 dark:text-primary-400 -mt-1.5 pl-4.5">
          Comprehensive extraction with higher token usage
        </p>
      )}
    </div>
  );
});
