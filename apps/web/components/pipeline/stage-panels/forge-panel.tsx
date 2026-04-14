'use client';

import { useState, useMemo, useCallback, useRef } from 'react';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Play, Hammer, FileCode, Terminal as TerminalIcon,
  GitBranch, Download, FolderTree as FolderTreeIcon,
  CheckCircle, XCircle, Minus, Table2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { FileTree, type FileNode } from '@/components/pipeline/file-tree';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { AgentActivity } from '@/components/pipeline/agent-activity';
import { ConfidenceGauge } from '@/components/pipeline/confidence-gauge';
import { CodeEditor } from '@/components/editor/code-editor';
import { AgentBotGrid } from '@/components/pipeline/agent-bot-grid';
import { usePipelineActivityStore } from '@/lib/stores/pipeline-activity-store';
import { useStagePanel } from '@/lib/hooks/use-stage-panel';
import { useUIPreferencesStore } from '@/lib/stores/ui-preferences-store';
import { useAuthStore } from '@/lib/stores/auth-store';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { inferLanguage, buildFileTree } from '@/lib/utils/file-tree';
import type { StagePanelProps } from './types';

export default function ForgePanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  pipelineRunId,
}: StagePanelProps) {
  const { logs, isRunning, hasOutput, canRun: canExecute } = useStagePanel(stage, stageIndex, streamingText, isExecuting);
  const toolCalls = usePipelineActivityStore((s) => s.toolCalls);
  const modernizedFiles = usePipelineActivityStore((s) => s.modernizedFiles);
  const setGithubSyncOpen = useUIPreferencesStore((s) => s.setGithubSyncOpen);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<'code' | 'terminal' | 'agent' | 'traceability'>('code');
  const currentPipelineRunId = pipelineRunId;
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState(400);

  // Build file tree from modernized files
  const fileTree = useMemo(() => buildFileTree(modernizedFiles), [modernizedFiles]);

  // Get selected file content
  const currentFile = useMemo(() => {
    if (!selectedFile) return null;
    return modernizedFiles.find((f) => f.path === selectedFile) || null;
  }, [selectedFile, modernizedFiles]);

  const handleFileClick = useCallback((node: FileNode, path: string) => {
    if (node.type === 'file') {
      setSelectedFile(node.path || path);
      setActivePane('code');
    }
  }, []);

  // Load modernized files from API on mount (for rehydration after refresh)
  useEffect(() => {
    if (!currentPipelineRunId || modernizedFiles.length > 0) return;
    if (stage.status !== 'completed' && stage.status !== 'approved') return;

    (async () => {
      try {
        const res = await apiClient.get(`/pipeline/${currentPipelineRunId}/modernized-files`);
        const files = res.data?.files || [];
        if (files.length === 0) return;

        // Fetch content for each file and add to store
        for (const file of files) {
          try {
            const detail = await apiClient.get(`/pipeline/${currentPipelineRunId}/modernized-files/${file.id}`);
            if (detail.data?.content) {
              usePipelineActivityStore.getState().addModernizedFile({
                path: detail.data.file_path,
                content: detail.data.content,
                language: detail.data.language,
                size: detail.data.file_size,
              });
            }
          } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
    })();
  }, [currentPipelineRunId, stage.status]);

  // Measure editor container for Monaco pixel height
  useEffect(() => {
    const el = editorContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.floor(entry.contentRect.height);
        if (h > 0) setEditorHeight(h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activePane]);

  // Traceability data
  const { data: traceabilityData } = useQuery<{ entries: any[] }>({
    queryKey: ['traceability', currentPipelineRunId],
    queryFn: async () => (await apiClient.get(`/pipeline/${currentPipelineRunId}/traceability`)).data,
    enabled: !!currentPipelineRunId && modernizedFiles.length > 0,
    staleTime: 30_000,
  });

  const traceability = traceabilityData?.entries || [];

  const panes = [
    { key: 'code', label: 'Code', icon: FileCode },
    { key: 'traceability', label: 'Traceability', icon: Table2 },
    { key: 'terminal', label: 'Build Output', icon: TerminalIcon },
    { key: 'agent', label: 'Agent', icon: Hammer },
  ] as const;

  return (
    <div className="space-y-4">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && modernizedFiles.length === 0 && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Hammer className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Code Forge
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                AI pair programming generates production-ready code aligned to the target architecture.
                Uses an agent with file system tools to create, edit, and test code iteratively.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant="outline" className="text-[10px]">Code Generation</Badge>
                <Badge variant="outline" className="text-[10px]">Interactive Editing</Badge>
                <Badge variant="outline" className="text-[10px]">Build & Test</Badge>
                <Badge variant="outline" className="text-[10px]">GitHub Sync</Badge>
              </div>
            </CardContent>
          </Card>

          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Start Code Generation
              </Button>
            </div>
          )}
        </>
      )}

      {/* During execution: streaming + agent activity */}
      {isRunning && (
        <>
          <AgentBotGrid
            subtasks={stage.subtasks}
            overallProgress={stage.subtaskProgress}
            message="Generating modernized code..."
            subtitle="Writing files, tests, and configuration"
          />
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {toolCalls.length > 0 && <AgentActivity toolCalls={toolCalls} />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Forge Activity" />}
        </>
      )}

      {/* After execution / code generated: 3-panel IDE layout */}
      {(modernizedFiles.length > 0 || (stage.output && !isRunning)) && (
        <>
          {/* Stats Bar */}
          <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <FileCode className="w-3.5 h-3.5" />
                {modernizedFiles.length} files generated
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <FolderTreeIcon className="w-3.5 h-3.5" />
                {(modernizedFiles.reduce((sum, f) => sum + (f.size || 0), 0) / 1024).toFixed(1)} KB total
              </span>
            </div>
            <div className="flex items-center gap-2">
              {stage.validation && (
                <ConfidenceGauge score={stage.validation.score * 100} size={32} showScore={false} />
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => setGithubSyncOpen(true)}
                disabled={modernizedFiles.length === 0}
              >
                <GitBranch className="w-3 h-3" />
                Push to GitHub
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={async () => {
                  if (!pipelineRunId) return;
                  try {
                    const token = useAuthStore.getState().token;
                    const response = await apiClient.get(
                      `/export/project/${pipelineRunId}/code`,
                      {
                        responseType: 'blob',
                        headers: token ? { Authorization: `Bearer ${token}` } : {},
                      },
                    );
                    const url = window.URL.createObjectURL(new Blob([response.data]));
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `modernized-code-${pipelineRunId.slice(0, 7)}.zip`;
                    a.click();
                    window.URL.revokeObjectURL(url);
                  } catch {
                    // Fallback: client-side ZIP via JSZip if API not available
                    console.warn('ZIP export endpoint not available');
                  }
                }}
              >
                <Download className="w-3 h-3" />
                Download ZIP
              </Button>
            </div>
          </div>

          {/* IDE Layout */}
          <div className="grid grid-cols-1 md:grid-cols-[250px_1fr] gap-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" style={{ height: '500px' }}>
            {/* Left: File Tree */}
            <div className="border-r border-slate-200 dark:border-slate-700 overflow-hidden">
              <FileTree
                nodes={fileTree}
                selectedPath={selectedFile || undefined}
                onFileClick={handleFileClick}
                showSearch
                maxHeight="462px"
                className="border-0 rounded-none"
              />
            </div>

            {/* Right: Code / Terminal / Agent */}
            <div className="flex flex-col h-full min-h-0">
              {/* Pane Tabs */}
              <div className="flex-shrink-0 flex items-center gap-0 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                {panes.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setActivePane(key)}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                      activePane === key
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 border-b-2 border-primary-600'
                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300',
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Pane Content */}
              <div ref={editorContainerRef} className="flex-1 overflow-hidden min-h-0">
                {activePane === 'code' && (
                  currentFile ? (
                    <CodeEditor
                      value={currentFile.content}
                      language={inferLanguage(currentFile.name || currentFile.path)}
                      height={`${editorHeight}px`}
                      readOnly
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-sm text-slate-400">
                      Select a file to view
                    </div>
                  )
                )}

                {activePane === 'traceability' && (
                  <div className="p-3 overflow-auto h-full">
                    {traceability.length > 0 ? (
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-700">
                            <th className="text-left py-1.5 px-2 text-slate-500 font-semibold">Rule</th>
                            <th className="text-left py-1.5 px-2 text-slate-500 font-semibold">Target File</th>
                            <th className="text-left py-1.5 px-2 text-slate-500 font-semibold">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {traceability.map((entry: any, i: number) => (
                            <tr key={i} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                              <td className="py-1.5 px-2">
                                <span className="font-mono text-primary-600 dark:text-primary-400">{entry.rule_id}</span>
                                {entry.rule_text && <p className="text-[9px] text-slate-400 mt-0.5 truncate max-w-[200px]">{entry.rule_text}</p>}
                              </td>
                              <td className="py-1.5 px-2">
                                <button
                                  onClick={() => { setSelectedFile(entry.target_file_path); setActivePane('code'); }}
                                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-mono"
                                >
                                  {entry.target_file_path}
                                </button>
                              </td>
                              <td className="py-1.5 px-2">
                                <Badge className={cn('text-[9px] px-1.5',
                                  entry.status === 'implemented' ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' :
                                    entry.status === 'partial' ? 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' :
                                    'bg-slate-100 dark:bg-slate-700 text-slate-500',
                                )}>
                                  {entry.status === 'implemented' && <CheckCircle className="w-2.5 h-2.5 mr-0.5 inline" />}
                                  {entry.status === 'partial' && <Minus className="w-2.5 h-2.5 mr-0.5 inline" />}
                                  {entry.status === 'skipped' && <XCircle className="w-2.5 h-2.5 mr-0.5 inline" />}
                                  {entry.status}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="flex items-center justify-center h-full text-sm text-slate-400">
                        Run FORGE to generate traceability data
                      </div>
                    )}
                  </div>
                )}

                {activePane === 'terminal' && (
                  <TerminalLog
                    logs={logs}
                    title="Build Output"
                    maxHeight="100%"
                    className="border-0 rounded-none h-full"
                  />
                )}

                {activePane === 'agent' && (
                  <AgentActivity
                    toolCalls={toolCalls}
                    maxHeight="100%"
                    className="border-0 rounded-none h-full"
                  />
                )}
              </div>
            </div>
          </div>

          {/* Full analysis output (collapsible) */}
          {stage.output && (
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 py-2">
                View full stage output
              </summary>
              <StageOutput output={stage.output} isStreaming={false} />
            </details>
          )}
        </>
      )}
    </div>
  );
}
