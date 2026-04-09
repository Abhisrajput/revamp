'use client';

import { useState, useEffect, memo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck, CheckCircle, Clock, RotateCcw,
  MessageSquare, Send, AlertTriangle, TrendingUp, Timer,
  ChevronDown, ChevronRight, Terminal,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  type StageValidation,
  type ApprovalHistoryEntry,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from '@/lib/stores/pipeline-store';

// --- Types ---

interface ApprovalGateProps {
  stage: string;
  status: 'pending' | 'approved' | 'not_required';
  requiredRole: string;
  onApprove: (comment?: string) => void;
  onRerun: (promptOverride?: string) => void;
  userRole: string;
  gateId?: string;
  validation?: StageValidation | null;
  confidenceThreshold?: number;
  approvalHistory?: ApprovalHistoryEntry[];
  autoApprovalEnabled?: boolean;
  autoApprovalTimeoutHours?: number;
  pendingApprovalSince?: string | null;
}

// ─── Countdown Hook ─────────────────────────────────────────────

function useCountdown(
  enabled: boolean,
  pendingApprovalSince: string | null | undefined,
  timeoutHours: number,
  onExpire: () => void,
) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || !pendingApprovalSince || timeoutHours <= 0) {
      setRemaining(null);
      return;
    }

    const deadline = new Date(pendingApprovalSince).getTime() + timeoutHours * 3600_000;

    const tick = () => {
      const diff = deadline - Date.now();
      if (diff <= 0) {
        setRemaining(0);
        onExpire();
        return;
      }
      setRemaining(diff);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [enabled, pendingApprovalSince, timeoutHours, onExpire]);

  return remaining;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// --- Status Config ---

const statusConfig = {
  pending: { icon: Clock, label: 'Awaiting Review', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  approved: { icon: CheckCircle, label: 'Approved', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  not_required: { icon: CheckCircle, label: 'No Review Needed', color: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
} as const;

// --- Component ---

export const ApprovalGate = memo(function ApprovalGate({
  stage,
  status,
  requiredRole,
  onApprove,
  onRerun,
  userRole,
  gateId,
  validation,
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  approvalHistory = [],
  autoApprovalEnabled = false,
  autoApprovalTimeoutHours = 3,
  pendingApprovalSince,
}: ApprovalGateProps) {
  const [comment, setComment] = useState('');
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');

  const canAct = userRole === requiredRole || userRole === 'admin' || userRole === 'developer';
  const cfg = statusConfig[status] || statusConfig.pending;
  const StatusIcon = cfg.icon;

  const score = validation?.score ?? null;
  const belowThreshold = score !== null && score < confidenceThreshold;

  const hasComment = comment.trim().length > 0;

  // Auto-approval countdown — fires onApprove when timer expires
  const handleAutoApprove = useCallback(() => {
    if (status === 'pending' && !belowThreshold) {
      onApprove('Auto-approved after timeout');
    }
  }, [status, belowThreshold, onApprove]);

  const remaining = useCountdown(
    autoApprovalEnabled && status === 'pending',
    pendingApprovalSince,
    autoApprovalTimeoutHours,
    handleAutoApprove,
  );

  const handleApprove = useCallback(() => {
    if (belowThreshold || !hasComment) return;
    onApprove(comment.trim());
    setComment('');
  }, [comment, onApprove, belowThreshold, hasComment]);

  const handleRerun = useCallback(() => {
    if (!hasComment) return;
    onRerun(promptDraft.trim() || undefined);
    setComment('');
    setPromptDraft('');
    setShowPromptEditor(false);
  }, [onRerun, hasComment, promptDraft]);

  return (
    <Card className="border-dashed">
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-slate-500 dark:text-slate-400" />
            <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
              Approval Gate
            </span>
            <Badge variant="outline" className="text-xs">{stage}</Badge>
          </div>
          <Badge className={cn('border-transparent', cfg.color)}>
            <StatusIcon className="h-3 w-3 mr-1" />
            {cfg.label}
          </Badge>
        </div>

        {/* Confidence Gate */}
        {score !== null && (
          <div className={cn(
            'mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
            belowThreshold
              ? 'border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400'
              : 'border-green-200 dark:border-green-800/40 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400',
          )}>
            {belowThreshold ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <TrendingUp className="w-4 h-4 shrink-0" />
            )}
            <span>
              <strong>Confidence Gate:</strong> {score}%
              {' '}(required: {confidenceThreshold}%)
              {belowThreshold && ' — Re-run to improve score before approving'}
            </span>
          </div>
        )}

        {/* Auto-approval countdown timer */}
        {autoApprovalEnabled && status === 'pending' && remaining !== null && remaining > 0 && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-cyan-200 dark:border-cyan-800/40 bg-cyan-50 dark:bg-cyan-950/20 px-3 py-2 text-xs text-cyan-700 dark:text-cyan-400">
            <Timer className="w-4 h-4 shrink-0 animate-pulse" />
            <span>
              <strong>Auto-approval in:</strong>{' '}
              <span className="font-mono">{formatCountdown(remaining)}</span>
              {belowThreshold && (
                <span className="text-red-500 ml-1">(blocked — confidence below threshold)</span>
              )}
            </span>
          </div>
        )}

        {/* Validation dimension breakdown */}
        {validation?.dimensionScores && validation.dimensionScores.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {validation.dimensionScores.map((dim) => (
              <div key={dim.name} className="flex items-center gap-2 text-xs">
                <span className="text-slate-500 w-32 truncate">{dim.name}</span>
                <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all',
                      dim.score >= 75 ? 'bg-green-400' : dim.score >= 50 ? 'bg-amber-400' : 'bg-red-400',
                    )}
                    style={{ width: `${dim.score}%` }}
                  />
                </div>
                <span className={cn('font-mono w-10 text-right',
                  dim.score >= 75 ? 'text-green-600' : dim.score >= 50 ? 'text-amber-600' : 'text-red-600',
                )}>
                  {dim.score}%
                </span>
                <span className="text-slate-400 w-10 text-right">{Math.round(dim.weight * 100)}%w</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions — Approve & Next OR Re-run (NO reject) */}
        {status === 'pending' && canAct && (
          <div className="mt-3 space-y-2">
            <textarea
              placeholder="Add a comment before approving or re-running..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className={cn(
                'w-full text-sm rounded-lg border bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-600 resize-none',
                !hasComment ? 'border-amber-300 dark:border-amber-700' : 'border-slate-300',
              )}
            />
            {!hasComment && (
              <p className="text-[10px] text-amber-500">A comment is required to approve or re-run.</p>
            )}

            {/* Prompt editor toggle for re-run with edited prompt */}
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowPromptEditor(!showPromptEditor)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                {showPromptEditor ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <Terminal className="w-3 h-3" />
                Edit prompt before re-running
              </button>
              {showPromptEditor && (
                <div className="px-3 pb-2">
                  <textarea
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    placeholder="Enter a custom prompt override for this re-run... Leave empty to use the default prompt."
                    rows={4}
                    className="w-full text-xs rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-mono leading-relaxed p-2 resize focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRerun}
                disabled={!hasComment}
                className="gap-1"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {promptDraft.trim() ? 'Re-run with Edited Prompt' : 'Re-run Stage'}
              </Button>
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={belowThreshold || !hasComment}
                className="gap-1"
                title={belowThreshold ? `Confidence ${score}% is below the ${confidenceThreshold}% threshold` : !hasComment ? 'Add a comment first' : undefined}
              >
                <CheckCircle className="h-3.5 w-3.5" />
                Approve & Next
              </Button>
            </div>
            {belowThreshold && (
              <p className="text-xs text-red-500 text-right">
                Approval blocked — confidence {score}% is below {confidenceThreshold}% threshold. Re-run to improve.
              </p>
            )}
          </div>
        )}

        {/* Already approved */}
        {status === 'approved' && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-green-600 dark:text-green-400">
              Stage approved{score ? ` with ${score}% confidence` : ''}
            </p>
            <div className="flex items-center gap-2">
              <input
                placeholder="Comment required to re-run..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="flex-1 text-xs px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
              />
              <Button size="sm" variant="outline" onClick={handleRerun} disabled={!hasComment} className="gap-1 text-xs">
                <RotateCcw className="h-3 w-3" />
                Re-run
              </Button>
            </div>
          </div>
        )}

        {/* No permission notice */}
        {status === 'pending' && !canAct && (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            You do not have the required role ({requiredRole}) to approve this stage.
          </p>
        )}

        {/* Approval History */}
        {approvalHistory.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-2">History</p>
            <div className="space-y-1 max-h-28 overflow-y-auto">
              {approvalHistory.slice().reverse().map((entry, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className={cn('font-medium',
                    entry.action === 'approved' ? 'text-green-500' :
                    entry.action === 'rerun' ? 'text-amber-500' :
                    entry.action === 'auto_approved' ? 'text-cyan-500' :
                    'text-slate-400',
                  )}>
                    {entry.action === 'approved' ? 'Approved' :
                     entry.action === 'rerun' ? 'Re-run' :
                     entry.action === 'auto_approved' ? 'Auto-approved' :
                     entry.action}
                  </span>
                  <span className="text-slate-400">by {entry.user}</span>
                  {entry.confidenceScore != null && (
                    <span className="text-slate-400">({entry.confidenceScore}%)</span>
                  )}
                  <span className="text-slate-300 ml-auto">
                    {new Date(entry.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Comment Thread */}
        {gateId && <ApprovalCommentThread gateId={gateId} />}
      </CardContent>
    </Card>
  );
});

// ─── Comment Thread ─────────────────────────────────────────────

function ApprovalCommentThread({ gateId }: { gateId: string }) {
  const queryClient = useQueryClient();
  const [newComment, setNewComment] = useState('');

  const { data } = useQuery<{ comments: Array<{ id: string; content: string; action?: string; user_display?: string; created_at: string }> }>({
    queryKey: ['approval-comments', gateId],
    queryFn: async () => (await apiClient.get(`/approval-gates/${gateId}/comments`)).data,
    staleTime: 10_000,
  });

  const addComment = useMutation({
    mutationFn: async () => (await apiClient.post(`/approval-gates/${gateId}/comments`, {
      content: newComment.trim(),
      action: 'comment',
    })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approval-comments', gateId] });
      setNewComment('');
    },
  });

  const comments = data?.comments || [];
  if (comments.length === 0 && !newComment) return null;

  return (
    <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-1.5 mb-2">
        <MessageSquare className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Discussion</span>
      </div>

      {comments.length > 0 && (
        <div className="space-y-1.5 mb-2 max-h-32 overflow-y-auto">
          {comments.map(c => (
            <div key={c.id} className="text-xs bg-slate-50 dark:bg-slate-900 rounded-lg p-2">
              <span className="font-medium text-slate-700 dark:text-slate-300">{c.user_display || 'User'}</span>
              <span className="text-slate-400 ml-1.5 text-[9px]">
                {new Date(c.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <p className="text-slate-600 dark:text-slate-400 mt-0.5">{c.content}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <input
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newComment.trim()) addComment.mutate(); }}
          placeholder="Add a comment..."
          className="flex-1 text-xs px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
        />
        <button
          onClick={() => newComment.trim() && addComment.mutate()}
          disabled={!newComment.trim() || addComment.isPending}
          className="p-1.5 text-primary-600 hover:text-primary-700 disabled:text-slate-300 transition-colors"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
