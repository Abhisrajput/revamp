/**
 * Approval gate component
 * Displays approval status and allows approve/reject actions
 */

import React, { useState } from 'react';
import { ApprovalGate as ApprovalGateType } from '@revamp/shared-types/pipeline';

export interface ApprovalGateComponentProps {
  gate: ApprovalGateType;
  onApprove?: (notes: string) => Promise<void>;
  onReject?: (notes: string) => Promise<void>;
  isLoading?: boolean;
  className?: string;
}

const statusStyles = {
  PENDING: { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-300' },
  APPROVED: { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-300' },
  REJECTED: { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-300' },
};

export const ApprovalGateComponent: React.FC<ApprovalGateComponentProps> = ({
  gate,
  onApprove,
  onReject,
  isLoading = false,
  className = '',
}) => {
  const [showModal, setShowModal] = useState(false);
  const [notes, setNotes] = useState('');
  const [action, setAction] = useState<'approve' | 'reject' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const styles = statusStyles[gate.status];
  const progressPercent = (gate.currentApprovals / gate.requiredApprovers) * 100;

  const handleAction = async (actionType: 'approve' | 'reject') => {
    setAction(actionType);
    setShowModal(true);
  };

  const handleSubmit = async () => {
    if (!action) return;

    setIsSubmitting(true);
    try {
      if (action === 'approve' && onApprove) {
        await onApprove(notes);
      } else if (action === 'reject' && onReject) {
        await onReject(notes);
      }
      setShowModal(false);
      setNotes('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={`${styles.bg} ${styles.border} border rounded-lg p-4 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className={`${styles.text} font-semibold text-lg`}>
            Approval Required
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            Stage: <span className="font-mono">{gate.stageName}</span>
          </p>
        </div>

        <div className={`px-3 py-1 rounded-full font-semibold text-sm ${styles.text}`}>
          {gate.status}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex justify-between text-sm text-gray-700 mb-2">
          <span>Approvals: {gate.currentApprovals}/{gate.requiredApprovers}</span>
          <span>{Math.round(progressPercent)}%</span>
        </div>

        <div className="w-full bg-gray-300 rounded-full h-2">
          <div
            className="bg-green-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Approvers list */}
      <div className="mb-4">
        <h4 className="font-semibold text-sm text-gray-800 mb-2">
          Approvers
        </h4>
        <div className="space-y-2">
          {gate.approvers.map((approver, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 text-sm"
            >
              <div
                className={`w-2 h-2 rounded-full ${
                  approver.approved ? 'bg-green-500' : 'bg-gray-400'
                }`}
              />
              <span className="text-gray-700">{approver.email}</span>
              {approver.approved && (
                <span className="text-green-600 text-xs">✓ Approved</span>
              )}
              {approver.notes && (
                <span className="text-gray-500 text-xs italic">
                  "{approver.notes}"
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Dates */}
      <div className="mb-4 text-xs text-gray-600 space-y-1">
        <p>Requested: {new Date(gate.requestedAt).toLocaleString()}</p>
        {gate.respondedAt && (
          <p>Responded: {new Date(gate.respondedAt).toLocaleString()}</p>
        )}
      </div>

      {/* Actions */}
      {gate.status === 'PENDING' && (
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => handleAction('approve')}
            disabled={isLoading || isSubmitting}
            className="flex-1 bg-green-500 hover:bg-green-600 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded transition"
          >
            Approve
          </button>

          <button
            onClick={() => handleAction('reject')}
            disabled={isLoading || isSubmitting}
            className="flex-1 bg-red-500 hover:bg-red-600 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded transition"
          >
            Reject
          </button>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96">
            <h4 className="font-bold text-lg mb-4">
              {action === 'approve' ? 'Approve' : 'Reject'} Gate
            </h4>

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add optional notes..."
              className="w-full border rounded px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={4}
            />

            <div className="flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                disabled={isSubmitting}
                className="flex-1 bg-gray-300 hover:bg-gray-400 disabled:bg-gray-200 text-gray-800 py-2 px-4 rounded"
              >
                Cancel
              </button>

              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className={`flex-1 ${
                  action === 'approve'
                    ? 'bg-green-500 hover:bg-green-600'
                    : 'bg-red-500 hover:bg-red-600'
                } disabled:bg-gray-400 text-white py-2 px-4 rounded`}
              >
                {isSubmitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApprovalGateComponent;
