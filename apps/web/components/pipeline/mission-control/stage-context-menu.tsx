'use client';

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import {
  Play,
  RotateCcw,
  Clipboard,
  FileText,
  Check,
  Lock,
  Zap,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StageState } from '@revamp/core';
import { usePipelineStore } from '@revamp/core/stores/pipeline-store';
import { canExecuteStage, getStageBlockReason } from '@revamp/core';

// ─── Types ──────────────────────────────────────────────────────

interface ContextMenuAction {
  label: string;
  icon: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

interface StageContextMenuProps {
  children: ReactNode;
  stage: StageState;
  stageIndex: number;
  onExecute: () => void;
  onReset: () => void;
  onNavigate: () => void;
  onCopyOutput: () => void;
  isExecuting: boolean;
}

// ─── Component ──────────────────────────────────────────────────

export function StageContextMenu({
  children,
  stage,
  stageIndex,
  onExecute,
  onReset,
  onNavigate,
  onCopyOutput,
  isExecuting,
}: StageContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Position the menu at the cursor, but keep it within viewport
      const x = Math.min(e.clientX, window.innerWidth - 200);
      const y = Math.min(e.clientY, window.innerHeight - 300);

      setPosition({ x, y });
      setOpen(true);
    },
    [],
  );

  const handleCopy = useCallback(() => {
    onCopyOutput();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    setOpen(false);
  }, [onCopyOutput]);

  // Close on click outside or escape
  useEffect(() => {
    if (!open) return;

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // Build actions based on stage state
  const actions: ContextMenuAction[] = [];
  const stages = usePipelineStore((s) => s.stages);
  const stageExecutable = canExecuteStage(stages, stageIndex);
  const blockReason = getStageBlockReason(stages, stageIndex);

  // Navigate to stage
  actions.push({
    label: 'Go to Stage',
    icon: <Eye className="w-3.5 h-3.5" />,
    shortcut: `\u2318${stageIndex + 1}`,
    onClick: () => { onNavigate(); setOpen(false); },
  });

  // Guardrail: check prerequisites before allowing execution
  const statusAllowsExecute = stage.status === 'pending' || stage.status === 'failed' || stage.status === 'completed';

  if (statusAllowsExecute && stageExecutable) {
    actions.push({
      label: isExecuting ? 'Executing...' : 'Execute Stage',
      icon: <Play className="w-3.5 h-3.5" />,
      shortcut: 'Ctrl+\u23CE',
      disabled: isExecuting,
      onClick: () => { onExecute(); setOpen(false); },
    });
  } else if (statusAllowsExecute && !stageExecutable) {
    // Stage status would allow execution but prerequisites not met
    actions.push({
      label: blockReason || 'Prerequisites not met',
      icon: <Lock className="w-3.5 h-3.5" />,
      disabled: true,
      onClick: () => {},
    });
  } else if (stage.status === 'locked') {
    actions.push({
      label: 'Stage Locked',
      icon: <Lock className="w-3.5 h-3.5" />,
      disabled: true,
      onClick: () => {},
    });
  } else if (stage.status === 'generating' || stage.status === 'validating') {
    actions.push({
      label: 'Running...',
      icon: <Zap className="w-3.5 h-3.5 animate-pulse" />,
      disabled: true,
      onClick: () => {},
    });
  }

  // Reset stage
  if (stage.status !== 'locked') {
    actions.push({
      label: 'Reset Stage',
      icon: <RotateCcw className="w-3.5 h-3.5" />,
      disabled: stage.status === 'generating' || stage.status === 'validating',
      danger: true,
      onClick: () => { onReset(); setOpen(false); },
    });
  }

  // Copy output
  if (stage.output) {
    actions.push({
      label: copied ? 'Copied!' : 'Copy Output',
      icon: copied ? <Check className="w-3.5 h-3.5" /> : <Clipboard className="w-3.5 h-3.5" />,
      onClick: handleCopy,
    });
  }

  // View output
  if (stage.output) {
    actions.push({
      label: 'View Full Output',
      icon: <FileText className="w-3.5 h-3.5" />,
      onClick: () => { onNavigate(); setOpen(false); },
    });
  }

  return (
    <div onContextMenu={handleContextMenu} className="contents">
      {children}

      {open && (
        <div
          ref={menuRef}
          className={cn(
            'fixed z-50 min-w-[180px] rounded-lg overflow-hidden',
            'bg-white dark:bg-slate-800',
            'border border-slate-200 dark:border-slate-700',
            'shadow-lg shadow-black/10 dark:shadow-black/30',
            'animate-in fade-in-0 zoom-in-95',
            'py-1',
          )}
          style={{ left: position.x, top: position.y }}
        >
          {/* Stage name header */}
          <div className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-700">
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              {stage.label}
            </p>
          </div>

          {actions.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              disabled={action.disabled}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors',
                action.disabled
                  ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
                  : action.danger
                    ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                    : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700',
              )}
            >
              {action.icon}
              <span className="flex-1 text-left">{action.label}</span>
              {action.shortcut && (
                <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500">
                  {action.shortcut}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
