'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  Play, Hammer, FileCode, Terminal as TerminalIcon,
  GitBranch, Download, FolderTree as FolderTreeIcon,
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
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { useUIPreferencesStore } from '@/lib/stores/ui-preferences-store';
import { useAuthStore } from '@/lib/stores/auth-store';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// --- Language detection ---

function inferLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', java: 'java', rs: 'rust', rb: 'ruby',
    cs: 'csharp', sql: 'sql', yaml: 'yaml', yml: 'yaml', json: 'json',
    md: 'markdown', html: 'html', css: 'css', scss: 'scss',
    sh: 'shell', bash: 'shell', dockerfile: 'dockerfile',
    xml: 'xml', toml: 'toml', tf: 'hcl',
  };
  return langMap[ext] || 'plaintext';
}

// --- Build FileNode tree from modernized files ---

function buildFileTree(files: { path: string; name: string }[]): FileNode[] {
  const root: FileNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        current.push({ name: part, type: 'file', path: file.path });
      } else {
        let dir = current.find((n) => n.name === part && n.type === 'dir');
        if (!dir) {
          dir = { name: part, type: 'dir', children: [] };
          current.push(dir);
        }
        current = dir.children!;
      }
    }
  }

  return root;
}

export default function ForgePanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  pipelineRunId,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const toolCalls = usePipelineStore((s) => s.toolCalls);
  const modernizedFiles = usePipelineStore((s) => s.modernizedFiles);
  const updateModernizedFile = usePipelineStore((s) => s.updateModernizedFile);
  const stages = usePipelineStore((s) => s.stages);
  const setGithubSyncOpen = useUIPreferencesStore((s) => s.setGithubSyncOpen);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<'code' | 'terminal' | 'agent'>('code');

  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

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

  const handleCodeChange = useCallback((value: string | undefined) => {
    if (selectedFile && value !== undefined) {
      updateModernizedFile(selectedFile, value);
    }
  }, [selectedFile, updateModernizedFile]);

  const panes = [
    { key: 'code', label: 'Code', icon: FileCode },
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
                {(modernizedFiles.reduce((sum, f) => sum + f.size, 0) / 1024).toFixed(1)} KB total
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
            <div className="flex flex-col">
              {/* Pane Tabs */}
              <div className="flex items-center gap-0 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
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
              <div className="flex-1 overflow-hidden">
                {activePane === 'code' && (
                  currentFile ? (
                    <CodeEditor
                      value={currentFile.content}
                      onChange={handleCodeChange}
                      language={inferLanguage(currentFile.name)}
                      height="100%"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-sm text-slate-400">
                      Select a file to view
                    </div>
                  )
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
