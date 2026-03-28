'use client';

import { useState, memo, useCallback } from 'react';
import {
  ShieldCheck,
  CheckCircle,
  XCircle,
  Clock,
} from 'lucide-react';
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
