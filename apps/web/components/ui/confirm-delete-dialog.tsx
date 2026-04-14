'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@revamp/ui/components/dialog';

interface ConfirmDeleteDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** The name the user must type to confirm deletion */
  confirmText: string;
  /** Title shown in the dialog header */
  title?: string;
  /** Description text explaining the consequences */
  description?: string;
  /** Callback when deletion is confirmed */
  onConfirm: () => void;
  /** Whether the delete operation is in progress */
  isDeleting?: boolean;
}

/**
 * Type-to-confirm delete dialog.
 * Requires the user to type the exact entity name before the delete button is enabled.
 */
export const ConfirmDeleteDialog = memo(function ConfirmDeleteDialog({
  open,
  onOpenChange,
  confirmText,
  title = 'Delete Project',
  description,
  onConfirm,
  isDeleting = false,
}: ConfirmDeleteDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const isMatch = inputValue === confirmText;

  // Reset input when dialog opens/closes
  useEffect(() => {
    if (!open) setInputValue('');
  }, [open]);

  const handleConfirm = useCallback(() => {
    if (isMatch && !isDeleting) {
      onConfirm();
    }
  }, [isMatch, isDeleting, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && isMatch && !isDeleting) {
        e.preventDefault();
        onConfirm();
      }
    },
    [isMatch, isDeleting, onConfirm],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <DialogTitle className="text-slate-900 dark:text-slate-50">
                {title}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {description ||
                  'This action cannot be undone. This will permanently delete the project and all associated data including pipeline runs, artifacts, and configurations.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            To confirm, type{' '}
            <span className="font-mono font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-1.5 py-0.5 rounded">
              {confirmText}
            </span>{' '}
            below:
          </p>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={confirmText}
            autoFocus
            disabled={isDeleting}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <DialogFooter className="mt-4 gap-2 sm:gap-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!isMatch || isDeleting}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDeleting ? (
              <>
                <svg
                  className="mr-2 h-4 w-4 animate-spin"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Deleting...
              </>
            ) : (
              'Delete permanently'
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
