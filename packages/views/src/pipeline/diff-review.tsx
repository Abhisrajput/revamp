

import { useState, useMemo, memo } from 'react';
import { Check, X, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { Badge } from '@revamp/ui/components/badge';
import { cn } from '@revamp/ui/utils';

// --- Types ---

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffReviewProps {
  /** Original file content (left side) */
  original: string;
  /** Modified file content (right side) */
  modified: string;
  /** File name for display */
  fileName: string;
  /** Language for syntax context */
  language?: string;
  /** Callback when user accepts the diff */
  onAccept?: () => void;
  /** Callback when user rejects the diff */
  onReject?: () => void;
  /** Whether to show accept/reject actions */
  showActions?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Maximum visible height before scroll */
  maxHeight?: string;
}

// --- Simple line-based diff algorithm ---

function computeDiff(original: string, modified: string): DiffLine[] {
  const oldLines = original.split('\n');
  const newLines = modified.split('\n');
  // Simple LCS-based diff for reasonable file sizes
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const diffItems: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffItems.unshift({ type: 'unchanged', content: oldLines[i - 1], oldLineNum: i, newLineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffItems.unshift({ type: 'added', content: newLines[j - 1], newLineNum: j });
      j--;
    } else if (i > 0) {
      diffItems.unshift({ type: 'removed', content: oldLines[i - 1], oldLineNum: i });
      i--;
    }
  }

  return diffItems;
}

// --- Component ---

export const DiffReview = memo(function DiffReview({
  original,
  modified,
  fileName,
  language,
  onAccept,
  onReject,
  showActions = true,
  className,
  maxHeight = '500px',
}: DiffReviewProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const diffLines = useMemo(() => computeDiff(original, modified), [original, modified]);

  const stats = useMemo(() => {
    const added = diffLines.filter((l) => l.type === 'added').length;
    const removed = diffLines.filter((l) => l.type === 'removed').length;
    const unchanged = diffLines.filter((l) => l.type === 'unchanged').length;
    return { added, removed, unchanged, total: diffLines.length };
  }, [diffLines]);

  const handleCopyModified = async () => {
    try {
      await navigator.clipboard.writeText(modified);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available
    }
  };

  return (
    <div className={cn('rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            {isCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          <span className="text-xs font-mono text-slate-700 dark:text-slate-300 truncate">
            {fileName}
          </span>
          {language && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {language}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-green-600 dark:text-green-400 tabular-nums">+{stats.added}</span>
          <span className="text-[10px] text-red-600 dark:text-red-400 tabular-nums">-{stats.removed}</span>
          <button
            onClick={handleCopyModified}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            title="Copy modified version"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Diff content */}
      {!isCollapsed && (
        <div className="overflow-auto font-mono text-xs" style={{ maxHeight }}>
          <table className="w-full border-collapse">
            <tbody>
              {diffLines.map((line, idx) => (
                <tr
                  key={idx}
                  className={cn(
                    line.type === 'added' && 'bg-green-50 dark:bg-green-900/10',
                    line.type === 'removed' && 'bg-red-50 dark:bg-red-900/10',
                  )}
                >
                  {/* Old line number */}
                  <td className="w-10 px-2 py-0 text-right text-[10px] text-slate-400 select-none border-r border-slate-100 dark:border-slate-800">
                    {line.type !== 'added' ? line.oldLineNum : ''}
                  </td>
                  {/* New line number */}
                  <td className="w-10 px-2 py-0 text-right text-[10px] text-slate-400 select-none border-r border-slate-100 dark:border-slate-800">
                    {line.type !== 'removed' ? line.newLineNum : ''}
                  </td>
                  {/* Diff marker */}
                  <td className={cn(
                    'w-5 px-1 py-0 text-center select-none',
                    line.type === 'added' && 'text-green-600 dark:text-green-400',
                    line.type === 'removed' && 'text-red-600 dark:text-red-400',
                  )}>
                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                  </td>
                  {/* Content */}
                  <td className={cn(
                    'px-2 py-0 whitespace-pre-wrap',
                    line.type === 'added' && 'text-green-800 dark:text-green-300',
                    line.type === 'removed' && 'text-red-800 dark:text-red-300 line-through opacity-70',
                    line.type === 'unchanged' && 'text-slate-600 dark:text-slate-400',
                  )}>
                    {line.content}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions */}
      {showActions && !isCollapsed && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <span className="text-[10px] text-slate-500">
            {stats.added} additions, {stats.removed} deletions, {stats.unchanged} unchanged
          </span>
          <div className="flex gap-2">
            {onReject && (
              <Button
                size="sm"
                variant="outline"
                onClick={onReject}
                className="h-7 text-xs gap-1 text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-900/20"
              >
                <X className="w-3 h-3" />
                Reject
              </Button>
            )}
            {onAccept && (
              <Button
                size="sm"
                onClick={onAccept}
                className="h-7 text-xs gap-1"
              >
                <Check className="w-3 h-3" />
                Accept
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
