'use client';

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { ChevronDown, ChevronRight, Save, RotateCcw, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Component ──────────────────────────────────────────────────

interface InlinePromptEditorProps {
  /** Whether the editor is visible */
  open: boolean;
  /** Toggle visibility */
  onToggle: () => void;
  /** Current prompt text */
  prompt: string;
  /** Save edited prompt */
  onSave: (prompt: string) => void;
  /** Reset to default prompt */
  onReset: () => void;
  /** Stage label for context */
  stageLabel: string;
  /** Label override for the toggle header (defaults to "Stage Prompt") */
  label?: string;
  /** Whether save is pending */
  isSaving?: boolean;
  className?: string;
}

export const InlinePromptEditor = memo(function InlinePromptEditor({
  open,
  onToggle,
  prompt,
  onSave,
  onReset,
  stageLabel,
  label,
  isSaving = false,
  className,
}: InlinePromptEditorProps) {
  const [draft, setDraft] = useState(prompt);
  const [isDirty, setIsDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync draft when prompt changes externally
  useEffect(() => {
    setDraft(prompt);
    setIsDirty(false);
  }, [prompt]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      setIsDirty(e.target.value !== prompt);
    },
    [prompt],
  );

  const handleSave = useCallback(() => {
    onSave(draft);
    setIsDirty(false);
  }, [draft, onSave]);

  const handleReset = useCallback(() => {
    onReset();
    setIsDirty(false);
  }, [onReset]);

  // Auto-resize textarea
  useEffect(() => {
    if (open && textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 480)}px`;
    }
  }, [open, draft]);

  return (
    <div
      className={cn(
        'border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50',
        className,
      )}
    >
      {/* Toggle Header */}
      <button
        onClick={onToggle}
        className={cn(
          'flex items-center gap-2 w-full px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400',
          'hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors',
        )}
      >
        {open ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <Terminal className="w-3 h-3" />
        <span>{label || 'Stage Prompt'}</span>
        <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500">
          {stageLabel}
        </span>
        {isDirty && (
          <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">
            unsaved
          </span>
        )}
      </button>

      {/* Editor Body */}
      {open && (
        <div className="px-4 pb-3 space-y-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleChange}
            spellCheck={false}
            className={cn(
              'w-full rounded-md border border-slate-200 dark:border-slate-600',
              'bg-white dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200',
              'font-mono leading-relaxed p-3 resize',
              'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
              'placeholder:text-slate-400 dark:placeholder:text-slate-500',
            )}
            placeholder="Enter a custom prompt for this stage..."
            rows={4}
          />

          {/* Action buttons */}
          <div className="flex items-center justify-between">
            <button
              onClick={handleReset}
              className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to default
            </button>

            <button
              onClick={handleSave}
              disabled={!isDirty || isSaving}
              className={cn(
                'flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-colors',
                isDirty && !isSaving
                  ? 'bg-primary-600 text-white hover:bg-primary-700'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed',
              )}
            >
              <Save className="w-3 h-3" />
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
