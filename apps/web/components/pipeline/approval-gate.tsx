'use client';

import { useState, memo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck,
  CheckCircle,
  XCircle,
  Clock,
  MessageSquare,
  RotateCcw,
  Send,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// --- Types ---

interface ApprovalGateProps {
  stage: string;
  status: 'pending' | 'approved' | 'rejected';
  requiredRole: string;
  onApprove: (comment?: string) => void;
  onReject: (reason: string) => void;
  userRole: string;
  gateId?: string;
}

// --- Status Config ---

const statusConfig = {
  pending: { icon: Clock, label: 'Pending Review', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
  approved: { icon: CheckCircle, label: 'Approved', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  rejected: { icon: XCircle, label: 'Rejected', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
} as const;

// --- Component ---

export const ApprovalGate = memo(function ApprovalGate({
  stage,
  status,
  requiredRole,
  onApprove,
  onReject,
  userRole,
  gateId,
}: ApprovalGateProps) {
  const [comment, setComment] = useState('');
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [reasonError, setReasonError] = useState(false);

  const canAct = userRole === requiredRole || userRole === 'admin';
  const cfg = statusConfig[status];
  const StatusIcon = cfg.icon;

  const handleApprove = useCallback(() => {
    onApprove(comment.trim() || undefined);
    setComment('');
  }, [comment, onApprove]);

  const handleRejectSubmit = useCallback(() => {
    if (!rejectReason.trim()) {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    onReject(rejectReason.trim());
    setRejectReason('');
    setRejectDialogOpen(false);
  }, [rejectReason, onReject]);

  return (
    <>
      <Card className="border-dashed">
        <CardContent className="p-4">
          {/* Header */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <ShieldCheck className="h-5 w-5 text-slate-500 dark:text-slate-400" />
              <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                Approval Gate
              </span>
              <Badge variant="outline" className="text-xs">
                {stage}
              </Badge>
              <Badge variant="outline" className="text-xs">
                Requires: {requiredRole}
              </Badge>
            </div>

            <Badge className={cn('border-transparent', cfg.color)}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {cfg.label}
            </Badge>
          </div>

          {/* Actions */}
          {status === 'pending' && canAct && (
            <div className="mt-3 space-y-2">
              <textarea
                placeholder="Add a comment (optional for approval)..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="w-full text-sm min-h-[60px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-600 resize-none"
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (gateId && comment.trim()) {
                      apiClient.post(`/approval-gates/${gateId}/comments`, {
                        content: comment.trim(),
                        action: 'revision_requested',
                      }).then(() => setComment(''));
                    }
                  }}
                  disabled={!comment.trim()}
                  className="text-amber-600 border-amber-200 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-950/20"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  Request Revision
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setRejectDialogOpen(true)}
                >
                  <XCircle className="h-4 w-4 mr-1" />
                  Reject
                </Button>
                <Button size="sm" onClick={handleApprove}>
                  <CheckCircle className="h-4 w-4 mr-1" />
                  Approve
                </Button>
              </div>
            </div>
          )}

          {/* No permission notice */}
          {status === 'pending' && !canAct && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              You do not have the required role ({requiredRole}) to approve or reject this stage.
            </p>
          )}

          {/* Comment Thread */}
          {gateId && <ApprovalCommentThread gateId={gateId} />}
        </CardContent>
      </Card>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Stage</DialogTitle>
            <DialogDescription>
              Provide a reason for rejecting the {stage} stage. This is required.
            </DialogDescription>
          </DialogHeader>
          <div>
            <textarea
              placeholder="Reason for rejection..."
              value={rejectReason}
              onChange={(e) => {
                setRejectReason(e.target.value);
                if (e.target.value.trim()) setReasonError(false);
              }}
              className={cn(
                'w-full text-sm min-h-[100px] rounded-lg border bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:placeholder:text-slate-600 resize-none',
                reasonError ? 'border-red-500' : 'border-slate-300'
              )}
            />
            {reasonError && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">A reason is required to reject.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRejectSubmit}>
              <XCircle className="h-4 w-4 mr-1" />
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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

  const ACTION_STYLES: Record<string, string> = {
    comment: 'text-slate-500',
    revision_requested: 'text-amber-500',
    revised: 'text-blue-500',
    approved: 'text-emerald-500',
    rejected: 'text-red-500',
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-1.5 mb-2">
        <MessageSquare className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Discussion</span>
        {comments.length > 0 && <Badge className="text-[8px] px-1 py-0 bg-slate-100 dark:bg-slate-700 text-slate-500">{comments.length}</Badge>}
      </div>

      {comments.length > 0 && (
        <div className="space-y-2 mb-2 max-h-40 overflow-y-auto">
          {comments.map(c => (
            <div key={c.id} className="text-xs bg-slate-50 dark:bg-slate-900 rounded-lg p-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="font-medium text-slate-700 dark:text-slate-300">{c.user_display || 'Unknown'}</span>
                <div className="flex items-center gap-1.5">
                  {c.action && c.action !== 'comment' && (
                    <Badge className={cn('text-[8px] px-1 py-0 bg-transparent', ACTION_STYLES[c.action] || '')}>
                      {c.action.replace('_', ' ')}
                    </Badge>
                  )}
                  <span className="text-[9px] text-slate-400">
                    {new Date(c.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
              <p className="text-slate-600 dark:text-slate-400">{c.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* New comment input */}
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
