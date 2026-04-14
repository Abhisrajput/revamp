

import { useState, useCallback } from 'react';
import {
  GitBranch,
  Check,
  AlertTriangle,
  Loader2,
  Upload,
  Shield,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { Card } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { cn } from '@revamp/ui/utils';

// --- Types ---

interface GitHubSyncDialogProps {
  /** Whether the dialog panel is visible */
  open: boolean;
  /** Files to push */
  files: Array<{ path: string; content: string }>;
  /** Callback when push completes */
  onPushComplete?: (result: PushResult) => void;
  /** Additional CSS class */
  className?: string;
}

interface PushResult {
  owner: string;
  repo: string;
  branch: string;
  commit_hash: string;
  changed_files: number;
  summary: string;
}

// --- Component ---

export function GitHubSyncDialog({
  open,
  files,
  onPushComplete,
  className,
}: GitHubSyncDialogProps) {
  const [token, setToken] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [commitMessage, setCommitMessage] = useState('feat: modernized codebase via AIgnite');
  const [authUser, setAuthUser] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<PushResult | null>(null);

  const handleAuthenticate = useCallback(async () => {
    if (!token.trim()) return;
    setIsAuthenticating(true);
    setError(null);

    try {
      const res = await fetch('/api/github/validate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, repo_url: repoUrl || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.valid) throw new Error(data.error || 'Validation failed');
      setAuthUser(data.login);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auth failed');
      setAuthUser(null);
    } finally {
      setIsAuthenticating(false);
    }
  }, [token, repoUrl]);

  const handlePush = useCallback(async () => {
    if (!token.trim() || !repoUrl.trim() || files.length === 0) return;
    setIsPushing(true);
    setError(null);

    try {
      const res = await fetch('/api/github/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          repo_url: repoUrl,
          branch: branch || undefined,
          commit_message: commitMessage,
          files,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Push failed');
      setLastResult(data);
      onPushComplete?.(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setIsPushing(false);
    }
  }, [token, repoUrl, branch, commitMessage, files, onPushComplete]);

  if (!open) return null;

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center gap-2 mb-3">
        <GitBranch className="h-5 w-5 text-slate-600 dark:text-slate-400" />
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Push to GitHub
        </h3>
        {authUser && (
          <Badge variant="outline" className="ml-auto text-xs border-green-500 text-green-600">
            <Check className="h-3 w-3 mr-1" />
            {authUser}
          </Badge>
        )}
      </div>

      {/* Token */}
      <div>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
          <Shield className="h-3 w-3 inline mr-1" />
          Personal Access Token
        </label>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_xxxx or github_pat_xxxx"
            className="flex-1 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            disabled={isPushing}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleAuthenticate}
            disabled={!token.trim() || isAuthenticating || isPushing}
          >
            {isAuthenticating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
          </Button>
        </div>
      </div>

      {/* Repo URL */}
      <div>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
          Repository URL
        </label>
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo or owner/repo"
          className="w-full text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          disabled={isPushing}
        />
      </div>

      {/* Branch & Commit Message */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Branch (optional)
          </label>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            className="w-full text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            disabled={isPushing}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Commit Message
          </label>
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="feat: modernized code"
            className="w-full text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            disabled={isPushing}
          />
        </div>
      </div>

      {/* File summary */}
      <Card className="p-3 bg-slate-50 dark:bg-slate-900">
        <p className="text-xs text-slate-600 dark:text-slate-400">
          <span className="font-medium text-slate-900 dark:text-slate-100">{files.length}</span>
          {' '}file(s) ready to push
          {files.length > 0 && (
            <span className="ml-2 text-slate-400">
              ({(files.reduce((acc, f) => acc + f.content.length, 0) / 1024).toFixed(1)} KB total)
            </span>
          )}
        </p>
      </Card>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}

      {/* Success */}
      {lastResult && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <Check className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
          <div className="text-xs text-green-700 dark:text-green-300">
            <p className="font-medium">{lastResult.summary}</p>
            <a
              href={`https://github.com/${lastResult.owner}/${lastResult.repo}/commit/${lastResult.commit_hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-1 text-green-600 hover:underline"
            >
              View commit <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      )}

      {/* Push button */}
      <Button
        className="w-full"
        onClick={handlePush}
        disabled={!token.trim() || !repoUrl.trim() || files.length === 0 || isPushing}
      >
        {isPushing ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Pushing to GitHub...
          </>
        ) : (
          <>
            <Upload className="h-4 w-4 mr-2" />
            Push {files.length} File(s) to GitHub
          </>
        )}
      </Button>
    </div>
  );
}
