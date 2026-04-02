'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  FolderGit2, Play, FileText, Cloud,
  Code2, GitBranch, CheckCircle2, Loader2,
  Eye, EyeOff, Trash2, Upload, FolderOpen, X, Cpu, RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { BreeOutputTab } from '@/components/pipeline/bree-output-tab';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { SubtaskProgressList } from '@/components/pipeline/subtask-progress-list';
import { FileTree, type FileNode } from '@/components/pipeline/file-tree';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { usePipelineStore, canExecuteStage, getStageBlockReason, shouldShowApprovalGate } from '@/lib/stores/pipeline-store';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// --- Git Platform Detection ---

export type GitPlatform = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'generic';

export interface ParsedRepo {
  platform: GitPlatform;
  label: string;
  owner?: string;
  repo?: string;
  defaultBranch: string;
}

/**
 * Detects the Git hosting platform from a repository URL.
 * Extracts owner/repo when possible and infers the default branch
 * based on platform conventions.
 */
export function parseRepoUrl(url: string): ParsedRepo {
  const trimmed = url.trim().replace(/\.git$/, '');

  // GitHub
  if (/github\.com/i.test(trimmed)) {
    const match = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
    return {
      platform: 'github',
      label: 'GitHub',
      owner: match?.[1],
      repo: match?.[2],
      defaultBranch: 'main',
    };
  }

  // GitLab (gitlab.com or self-hosted with /gitlab/ path)
  if (/gitlab\.com/i.test(trimmed) || /gitlab/i.test(trimmed)) {
    const match = trimmed.match(/gitlab\.com[/:]([^/]+)\/([^/]+)/i);
    return {
      platform: 'gitlab',
      label: 'GitLab',
      owner: match?.[1],
      repo: match?.[2],
      defaultBranch: 'main',
    };
  }

  // Bitbucket
  if (/bitbucket\.org/i.test(trimmed)) {
    const match = trimmed.match(/bitbucket\.org[/:]([^/]+)\/([^/]+)/i);
    return {
      platform: 'bitbucket',
      label: 'Bitbucket',
      owner: match?.[1],
      repo: match?.[2],
      defaultBranch: 'main',
    };
  }

  // Azure DevOps (dev.azure.com or visualstudio.com)
  if (/dev\.azure\.com/i.test(trimmed) || /visualstudio\.com/i.test(trimmed)) {
    const match = trimmed.match(/dev\.azure\.com\/([^/]+)\/([^/]+)/i);
    return {
      platform: 'azure-devops',
      label: 'Azure DevOps',
      owner: match?.[1],
      repo: match?.[2],
      defaultBranch: 'main',
    };
  }

  // Generic / self-hosted Git
  return {
    platform: 'generic',
    label: 'Git',
    defaultBranch: 'master',
  };
}

// SVG icons for each platform (16x16 viewBox, monochrome to fit dark/light themes)
function GitPlatformIcon({ platform, className }: { platform: GitPlatform; className?: string }) {
  const cls = cn('w-4 h-4 shrink-0', className);

  switch (platform) {
    case 'github':
      return (
        <svg viewBox="0 0 16 16" className={cls} fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      );
    case 'gitlab':
      return (
        <svg viewBox="0 0 16 16" className={cls} fill="currentColor">
          <path d="M8 14.58L10.58 7H5.42L8 14.58z" />
          <path d="M8 14.58L5.42 7H1.16L8 14.58z" opacity="0.7" />
          <path d="M1.16 7L.14 10.14c-.09.28 0 .6.24.78L8 14.58 1.16 7z" opacity="0.5" />
          <path d="M1.16 7h4.26L3.64 1.35a.2.2 0 00-.38 0L1.16 7z" />
          <path d="M8 14.58L10.58 7h4.26L8 14.58z" opacity="0.7" />
          <path d="M14.84 7l1.02 3.14c.09.28 0 .6-.24.78L8 14.58 14.84 7z" opacity="0.5" />
          <path d="M14.84 7H10.58l1.78-5.65a.2.2 0 01.38 0L14.84 7z" />
        </svg>
      );
    case 'bitbucket':
      return (
        <svg viewBox="0 0 16 16" className={cls} fill="currentColor">
          <path d="M.78 1.02A.5.5 0 00.28 1.6l2.17 13.2a.68.68 0 00.66.57h10a.5.5 0 00.5-.43L15.72 1.6a.5.5 0 00-.5-.58H.78zM9.6 10.53H6.43l-.86-4.47h4.88l-.85 4.47z" />
        </svg>
      );
    case 'azure-devops':
      return (
        <svg viewBox="0 0 16 16" className={cls} fill="currentColor">
          <path d="M15 3.62v8.55l-3.15 2.16-5.2-1.9v1.9L3.46 10.2l8.69.67V4.12L15 3.62zM12.15 4.12L6.96 1v2.06L2.56 4.63.99 6.57v4.58l2.47.8V5.6l8.69-1.48z" />
        </svg>
      );
    default:
      return <GitBranch className={cls} />;
  }
}

const PLATFORM_COLORS: Record<GitPlatform, string> = {
  github: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  gitlab: 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  bitbucket: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  'azure-devops': 'bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800',
  generic: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
};

// --- Helpers ---

function buildFileNodesFromFolderStructure(folders: any[]): FileNode[] {
  if (!folders || !Array.isArray(folders)) return [];
  return folders.map((f) => ({
    name: f.name?.replace(/\/$/, '') || 'unknown',
    type: f.type === 'dir' ? 'dir' as const : 'file' as const,
    children: f.children ? buildFileNodesFromFolderStructure(f.children) : undefined,
  }));
}

type SourceTab = 'git' | 'local';

// --- Scan Output Loader (replaces infinite spinner with retry) ---

function ScanOutputLoader({ stageIndex }: { stageIndex: number }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const pipelineRunId = usePipelineStore((s) => s.currentPipelineRunId);

  useEffect(() => {
    if (!pipelineRunId) {
      setLoading(false);
      setError('No pipeline run ID');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchOutput = async () => {
      try {
        const store = usePipelineStore.getState();
        const stage = store.stages[stageIndex];
        if (!stage || stage.output) return; // Already loaded

        const res = await apiClient.get(`/pipeline/${pipelineRunId}/artifacts/${stage.name}`);
        if (cancelled) return;

        const artifacts = res.data as any[];
        const outputArt = artifacts.find((a: any) => a.artifact_type === 'stage_output');
        if (outputArt?.metadata?.content) {
          usePipelineStore.getState().setStageOutput(stageIndex, outputArt.metadata.content);
        } else {
          // No stage_output artifact — check if stage already has partial output (from failed LLM)
          const currentStage = usePipelineStore.getState().stages[stageIndex];
          if (currentStage?.output) {
            // Already has partial output — don't overwrite with error
          } else if (currentStage?.status === 'failed') {
            // Stage failed — don't show "not found" error, the status banner handles it
          } else {
            setError('Stage output not found in artifacts. Try re-running the stage.');
          }
        }
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || 'Failed to load output');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchOutput();
    return () => { cancelled = true; };
  }, [pipelineRunId, stageIndex, retryCount]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading scan output...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
        <span className="text-sm text-amber-700 dark:text-amber-400">{error}</span>
        <button
          onClick={() => setRetryCount((c) => c + 1)}
          className="px-3 py-1 rounded-md text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return null;
}

// --- Component ---

export default function ScanPanel({
  stage,
  stageIndex,
  project,
  streamingText,
  onExecute,
  isExecuting,
  currentPhase,
  onRefineRequest,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const isCompleted = stage.status === 'completed' || stage.status === 'approved';
  // Show post-clone view if project has files (clone worked) — even if LLM analysis failed
  const projectHasFiles = !!(project?.folder_structure && (project.folder_structure as any[]).length > 0);
  const wasExecuted = isCompleted || projectHasFiles || (stage.status === 'failed' && hasOutput);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed' || stage.status === 'completed' || stage.status === 'in_progress') && !isExecuting && canExecuteStage(stages, stageIndex);
  // Show post-clone view if stage was executed (even if output is still loading from API)
  const [showForm, setShowForm] = useState(!wasExecuted);

  // Sync showForm when stage status changes (e.g. after rehydration from backend)
  useEffect(() => {
    if (wasExecuted && showForm) {
      setShowForm(false);
    }
  }, [wasExecuted]);

  // --- Form state ---
  const [sourceTab, setSourceTab] = useState<SourceTab>(
    project?.source_type === 'local' ? 'local' : 'git',
  );
  const [repoUrl, setRepoUrl] = useState(project?.source_url || project?.repository_url || '');
  const [branch, setBranch] = useState(project?.source_branch || project?.repository_branch || 'main');
  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [localPath, setLocalPath] = useState(project?.source_type === 'local' ? (project?.source_url || '') : '');
  const [destinationUrl, setDestinationUrl] = useState(project?.repository_url || '');
  const [isSaving, setIsSaving] = useState(false);
  const [outputTab, setOutputTab] = useState<'output' | 'bree'>('output');
  const [uploadedDocs, setUploadedDocs] = useState<any[]>(project?.supportingDocuments || []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const projectId = project?.id;

  // Track whether the form has been edited from the original project values
  const originalSourceTab: SourceTab = project?.source_type === 'local' ? 'local' : 'git';
  const originalRepoUrl = project?.source_url || project?.repository_url || '';
  const originalBranch = project?.source_branch || project?.repository_branch || 'main';
  const originalLocalPath = project?.source_type === 'local' ? (project?.source_url || '') : '';
  const originalDestinationUrl = project?.repository_url || '';

  const isDirty =
    sourceTab !== originalSourceTab ||
    repoUrl !== originalRepoUrl ||
    branch !== originalBranch ||
    accessToken !== '' ||
    localPath !== originalLocalPath ||
    destinationUrl !== originalDestinationUrl;

  // Build file tree from project folder structure
  const fileNodes = useMemo(() => {
    if (project?.folder_structure) {
      return buildFileNodesFromFolderStructure(
        typeof project.folder_structure === 'string'
          ? JSON.parse(project.folder_structure)
          : project.folder_structure,
      );
    }
    return [];
  }, [project?.folder_structure]);


  // --- Handlers ---

  const [saveError, setSaveError] = useState<string | null>(null);

  const handleCloneRepository = useCallback(async () => {
    if (!projectId) {
      setSaveError('No project ID — please reload the page.');
      return;
    }
    setSaveError(null);
    setIsSaving(true);
    try {
      // Save the updated config to the project
      await apiClient.patch(`/projects/${projectId}`, {
        source_type: sourceTab,
        source_url: sourceTab === 'git' ? repoUrl : localPath,
        source_branch: branch,
        // Store access token in project settings (encrypted at rest by the API)
        ...(accessToken ? { settings: { access_token: accessToken } } : {}),
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to save project config';
      setSaveError(msg);
      setIsSaving(false);
      return;
    }

    // Check preconditions before triggering execution
    const s = usePipelineStore.getState();
    if (!s.currentPipelineRunId) {
      setSaveError('Pipeline run not initialized. Please reload the page and try again.');
      setIsSaving(false);
      return;
    }
    const blockReason = getStageBlockReason(s.stages, stageIndex);
    if (blockReason) {
      setSaveError(blockReason);
      setIsSaving(false);
      return;
    }

    // Log the start of execution so the user sees activity
    usePipelineStore.getState().addLog({
      id: `log-scan-start-${Date.now()}`,
      timestamp: new Date().toISOString(),
      level: 'info',
      message: `Starting ${sourceTab === 'git' ? 'repository clone' : 'codebase scan'}...`,
      detail: sourceTab === 'git' ? repoUrl : localPath,
    });

    // Trigger stage execution
    try {
      onExecute();
      setShowForm(false);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to start execution');
    } finally {
      setIsSaving(false);
    }
  }, [projectId, sourceTab, repoUrl, localPath, branch, accessToken, stageIndex, onExecute]);

  const handleDiscard = useCallback(() => {
    setSourceTab(project?.source_type === 'local' ? 'local' : 'git');
    setRepoUrl(project?.source_url || project?.repository_url || '');
    setBranch(project?.source_branch || project?.repository_branch || 'main');
    setAccessToken('');
    setLocalPath(project?.source_type === 'local' ? (project?.source_url || '') : '');
    setDestinationUrl(project?.repository_url || '');
  }, [project]);

  const handleUploadDocument = useCallback(async (file: File) => {
    if (!projectId) return;
    try {
      // Get presigned upload URL
      const urlRes = await apiClient.post('/storage/upload-url', {
        project_id: projectId,
        filename: file.name,
        content_type: file.type,
      });
      const { upload_url, storage_key } = urlRes.data;

      // Upload file to S3
      await fetch(upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });

      // Register document metadata
      const docRes = await apiClient.post(`/projects/${projectId}/documents`, {
        name: file.name,
        file_type: file.type || 'application/octet-stream',
        storage_key,
        file_size: file.size,
      });

      setUploadedDocs((prev) => [
        ...prev,
        {
          id: docRes.data.id,
          name: file.name,
          file_type: file.type,
          file_size: file.size,
          storage_key,
        },
      ]);
    } catch (err) {
      console.error('Upload failed:', err);
    }
  }, [projectId]);

  const handleDeleteDocument = useCallback(async (docId: string) => {
    if (!projectId) return;
    try {
      await apiClient.delete(`/projects/${projectId}/documents/${docId}`);
      setUploadedDocs((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }, [projectId]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUploadDocument(file);
      e.target.value = '';
    }
  }, [handleUploadDocument]);

  // --- Platform detection ---
  const parsedRepo = useMemo(() => {
    if (sourceTab !== 'git' || !repoUrl.trim()) return null;
    return parseRepoUrl(repoUrl);
  }, [sourceTab, repoUrl]);

  // Auto-set branch when platform changes and user hasn't manually edited it
  const prevPlatformRef = useRef<GitPlatform | null>(null);
  useEffect(() => {
    if (parsedRepo && parsedRepo.platform !== prevPlatformRef.current) {
      // Only auto-set if current branch is a default value (main/master or empty)
      const currentBranchIsDefault = !branch || branch === 'main' || branch === 'master';
      if (currentBranchIsDefault) {
        setBranch(parsedRepo.defaultBranch);
      }
      prevPlatformRef.current = parsedRepo.platform;
    }
  }, [parsedRepo, branch]);

  const canClone = sourceTab === 'git' ? repoUrl.trim().length > 0 : localPath.trim().length > 0;

  return (
    <div className="space-y-4 p-3">
      {/* Pre-execution: Code Acquisition Form */}
      {!isRunning && showForm && (
        <>
          {/* Header */}
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Code Acquisition
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Provide the legacy codebase for analysis and modernization.
            </p>
          </div>

          {/* ─── Codebase Source ───────────────────────────────── */}
          <Card className="border border-slate-200 dark:border-slate-700">
            <CardContent className="p-5 space-y-4">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Codebase Source
              </h4>

              {/* Source Tabs */}
              <div className="flex gap-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden w-fit">
                <button
                  onClick={() => setSourceTab('git')}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
                    sourceTab === 'git'
                      ? 'bg-primary-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750',
                  )}
                >
                  <GitBranch className="w-4 h-4" />
                  Git Repository
                </button>
                <button
                  onClick={() => setSourceTab('local')}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
                    sourceTab === 'local'
                      ? 'bg-primary-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750',
                  )}
                >
                  <FolderOpen className="w-4 h-4" />
                  Local Path
                </button>
              </div>

              {/* Git Repository Fields */}
              {sourceTab === 'git' && (
                <div className="space-y-3">
                  {/* Repository URL */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Repository URL
                    </label>
                    <input
                      type="text"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="https://github.com/acme/legacy-order-system.git"
                      className={cn(
                        'w-full rounded-lg border border-slate-300 dark:border-slate-600',
                        'bg-white dark:bg-slate-800 px-3 py-2.5 text-sm',
                        'text-slate-900 dark:text-slate-50',
                        'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                      )}
                    />
                    {/* Platform detection badge */}
                    {parsedRepo ? (
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
                          PLATFORM_COLORS[parsedRepo.platform],
                        )}>
                          <GitPlatformIcon platform={parsedRepo.platform} className="w-3.5 h-3.5" />
                          {parsedRepo.label}
                        </div>
                        {parsedRepo.owner && parsedRepo.repo && (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {parsedRepo.owner}/{parsedRepo.repo}
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                        Supports GitHub, GitLab, Bitbucket, Azure DevOps, and self-hosted Git URLs.
                      </p>
                    )}
                  </div>

                  {/* Branch */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Branch
                    </label>
                    <input
                      type="text"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      placeholder="main"
                      className={cn(
                        'w-full rounded-lg border border-slate-300 dark:border-slate-600',
                        'bg-white dark:bg-slate-800 px-3 py-2.5 text-sm',
                        'text-slate-900 dark:text-slate-50',
                        'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                      )}
                    />
                  </div>

                  {/* Personal Access Token */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Personal Access Token{' '}
                      <span className="text-slate-400 font-normal">(optional)</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showToken ? 'text' : 'password'}
                        value={accessToken}
                        onChange={(e) => setAccessToken(e.target.value)}
                        placeholder="ghp_... or glpat-... or token"
                        className={cn(
                          'w-full rounded-lg border border-slate-300 dark:border-slate-600',
                          'bg-white dark:bg-slate-800 px-3 py-2.5 pr-10 text-sm',
                          'text-slate-900 dark:text-slate-50',
                          'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                          'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                      >
                        {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                      Required for private repositories. Supports GitHub, GitLab, Bitbucket, and Azure DevOps tokens.
                    </p>
                  </div>
                </div>
              )}

              {/* Local Path Field */}
              {sourceTab === 'local' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Local Path
                  </label>
                  <input
                    type="text"
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder="/path/to/legacy-codebase"
                    className={cn(
                      'w-full rounded-lg border border-slate-300 dark:border-slate-600',
                      'bg-white dark:bg-slate-800 px-3 py-2.5 text-sm',
                      'text-slate-900 dark:text-slate-50',
                      'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                      'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                    )}
                  />
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                    Path to the local directory containing the legacy codebase.
                  </p>
                </div>
              )}

              {/* ─── Supporting Documents ─────────────────────────── */}
              <div className="pt-2 border-t border-slate-100 dark:border-slate-700">
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Supporting Document{' '}
                  <span className="text-slate-400 font-normal">(optional)</span>
                </label>

                {/* File upload area */}
                <div
                  className={cn(
                    'relative flex items-center gap-3 rounded-lg border border-slate-300 dark:border-slate-600',
                    'bg-white dark:bg-slate-800 px-3 py-2.5',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                  >
                    Choose File
                  </button>
                  <span className="text-sm text-slate-400 dark:text-slate-500">
                    {uploadedDocs.length > 0
                      ? `${uploadedDocs.length} file(s) uploaded`
                      : 'No file chosen'}
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFileChange}
                    className="hidden"
                    accept=".md,.txt,.pdf,.doc,.docx,.csv,.json,.yaml,.yml,.xml"
                  />
                  <Upload className="w-4 h-4 text-slate-400 ml-auto" />
                </div>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Upload requirement docs, architecture notes, or migration guides to improve stage context.
                </p>

                {/* Uploaded documents list */}
                {uploadedDocs.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {uploadedDocs.map((doc: any) => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2 bg-slate-50 dark:bg-slate-800/50"
                      >
                        <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                        <span className="text-sm text-slate-700 dark:text-slate-300 flex-1 truncate">
                          {doc.name}
                        </span>
                        {doc.file_size && (
                          <span className="text-xs text-slate-400 tabular-nums shrink-0">
                            ({(doc.file_size / 1024).toFixed(1)} KB)
                          </span>
                        )}
                        <button
                          onClick={() => handleDeleteDocument(doc.id)}
                          className="text-slate-400 hover:text-red-500 transition-colors shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ─── Action Buttons ───────────────────────────────── */}
              <div className="space-y-2 pt-2">
                <div className="flex items-center gap-3">
                  <Button
                    onClick={handleCloneRepository}
                    disabled={!canClone || !canExecute || isSaving}
                    className="gap-2"
                  >
                    {isSaving ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                    {isSaving ? 'Cloning...' : sourceTab === 'git' ? 'Clone Repository' : 'Scan Codebase'}
                  </Button>
                  {isDirty && (
                    <Button
                      variant="outline"
                      onClick={handleDiscard}
                      className="gap-2"
                    >
                      <X className="w-4 h-4" />
                      Discard Changes
                    </Button>
                  )}
                  {isCompleted && (
                    <Button
                      variant="outline"
                      onClick={() => setShowForm(false)}
                      className="gap-2"
                    >
                      <X className="w-4 h-4" />
                      Cancel
                    </Button>
                  )}
                </div>
                {saveError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
                )}
                {!canExecute && !isSaving && canClone && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {stage.approvalStatus === 'pending'
                      ? 'Stage is awaiting approval. Approve or reject before re-running.'
                      : 'Stage cannot execute — check pipeline status.'}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ─── Destination Repository (optional) ───────────── */}
          <Card className="border border-slate-200 dark:border-slate-700">
            <CardContent className="p-5 space-y-3">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Destination Repository{' '}
                <span className="text-slate-400 font-normal text-xs">(optional)</span>
              </h4>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Target Repository URL
                </label>
                <input
                  type="text"
                  value={destinationUrl}
                  onChange={(e) => setDestinationUrl(e.target.value)}
                  placeholder="https://github.com/org/modernized-app.git"
                  className={cn(
                    'w-full rounded-lg border border-slate-300 dark:border-slate-600',
                    'bg-white dark:bg-slate-800 px-3 py-2.5 text-sm',
                    'text-slate-900 dark:text-slate-50',
                    'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                  )}
                />
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Where modernized code will be pushed. Optional.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* ─── Target Configuration Summary ────────────────── */}
          {(project?.target_stack || project?.target_cloud) && (
            <Card className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-2">
                  <Code2 className="w-4 h-4" />
                  <span className="text-xs font-medium">Target Configuration</span>
                </div>
                <div className="flex items-center gap-2">
                  {project?.target_stack && (
                    <Badge className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-transparent text-xs">
                      {project.target_stack}
                    </Badge>
                  )}
                  {project?.target_cloud && (
                    <Badge className="bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border-transparent text-xs">
                      <Cloud className="w-3 h-3 mr-1" />
                      {project.target_cloud.toUpperCase()}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* File Tree Preview */}
          {fileNodes.length > 0 && (
            <FileTree
              nodes={fileNodes}
              showSearch
              maxHeight="250px"
            />
          )}
        </>
      )}

      {/* During execution: progress + subtask timeline + streaming + stop */}
      {isRunning && (
        <>
          {/* Execution progress — stop button is in the header bar */}
          <div className="flex items-center gap-2 px-1 text-sm text-slate-600 dark:text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin text-primary-600" />
            <span>
              {currentPhase
                ? currentPhase.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
                : 'Processing...'}
            </span>
          </div>

          {/* Multi-agent subtask progress timeline */}
          <SubtaskProgressList />

          {streamingText && (
            <StageOutput output={streamingText} isStreaming />
          )}
          {logs.length > 0 && (
            <TerminalLog logs={logs} title="Scan Activity" />
          )}
        </>
      )}

      {/* After execution: post-clone artifacts */}
      {(wasExecuted || hasOutput) && !isRunning && !showForm && (
        <>
          {/* ─── Status Banner ──────────────────────────────── */}
          <div className="flex items-center justify-between">
            <div className={cn(
              'flex items-center gap-2',
              stage.status === 'failed'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-green-600 dark:text-green-400',
            )}>
              <CheckCircle2 className="w-5 h-5" />
              <span className="text-sm font-semibold">
                {stage.status === 'failed'
                  ? 'Codebase cloned — AI analysis needs re-run'
                  : 'Codebase acquired successfully'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* Re-run only when stage completed & not awaiting approval — failed stages use the top bar Re-run */}
              {stage.status !== 'failed' && !shouldShowApprovalGate(stage) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCloneRepository}
                  disabled={isSaving}
                  className="gap-2 text-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {isSaving ? 'Running...' : 'Re-configure & Run'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowForm(true)}
                className="gap-2 text-xs"
              >
                <FolderGit2 className="w-3.5 h-3.5" />
                Re-configure Setup
              </Button>
            </div>
          </div>

          {/* ─── Source URL ───────────────────────────────────── */}
          {(project?.source_url || project?.repository_url) && (
            <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              {parsedRepo ? (
                <GitPlatformIcon platform={parsedRepo.platform} className="w-4 h-4 text-slate-400" />
              ) : (
                <GitBranch className="w-4 h-4 text-slate-400" />
              )}
              <span>Source: {project?.source_url || project?.repository_url}</span>
            </div>
          )}

          {/* ─── Supporting Documents ────────────────────────── */}
          <Card className="border border-slate-200 dark:border-slate-700">
            <CardContent className="p-5 space-y-3">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Supporting Documents
              </h4>

              <div
                className={cn(
                  'relative flex items-center gap-3 rounded-lg border border-slate-300 dark:border-slate-600',
                  'bg-white dark:bg-slate-800 px-3 py-2.5',
                )}
              >
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                >
                  Choose File
                </button>
                <span className="text-sm text-slate-400 dark:text-slate-500">
                  {uploadedDocs.length > 0
                    ? `${uploadedDocs.length} file(s) uploaded`
                    : 'No file chosen'}
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileChange}
                  className="hidden"
                  accept=".md,.txt,.pdf,.doc,.docx,.csv,.json,.yaml,.yml,.xml"
                />
                <Upload className="w-4 h-4 text-slate-400 ml-auto" />
              </div>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Upload requirement docs, architecture notes, or migration guides to improve stage context.
              </p>

              {uploadedDocs.length > 0 && (
                <div className="space-y-1.5">
                  {uploadedDocs.map((doc: any) => (
                    <div
                      key={doc.id}
                      className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2 bg-slate-50 dark:bg-slate-800/50"
                    >
                      <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="text-sm text-slate-700 dark:text-slate-300 flex-1 truncate">
                        {doc.name}
                      </span>
                      {doc.file_size && (
                        <span className="text-xs text-slate-400 tabular-nums shrink-0">
                          ({(doc.file_size / 1024).toFixed(1)} KB)
                        </span>
                      )}
                      <button
                        onClick={() => handleDeleteDocument(doc.id)}
                        className="text-slate-400 hover:text-red-500 transition-colors shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ─── File Structure ───────────────────────────────── */}
          {fileNodes.length > 0 && (
            <Card className="border border-slate-200 dark:border-slate-700">
              <CardContent className="p-5">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
                  File Structure
                </h4>
                <FileTree
                  nodes={fileNodes}
                  showSearch
                  maxHeight="400px"
                />
              </CardContent>
            </Card>
          )}

          {/* ─── Output Tabs (Output / BREE) ──────────────── */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
            <button
              onClick={() => setOutputTab('output')}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                outputTab === 'output'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
              )}
            >
              Stage Output
            </button>
            <button
              onClick={() => setOutputTab('bree')}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5',
                outputTab === 'bree'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
              )}
            >
              <Cpu className="w-3 h-3" />
              BREE Analysis
            </button>
          </div>

          {outputTab === 'output' && (
            <>
              {stage.output ? (
                <StageOutput output={stage.output} isStreaming={false} />
              ) : wasExecuted ? (
                <ScanOutputLoader stageIndex={stageIndex} />
              ) : null}
            </>
          )}

          {outputTab === 'bree' && (
            <BreeOutputTab stageName="SCAN" />
          )}
        </>
      )}
    </div>
  );
}
