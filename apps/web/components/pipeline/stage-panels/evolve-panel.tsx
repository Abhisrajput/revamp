'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Play, TrendingUp, MessageSquare, Send, FileCode,
  Loader2, User, Bot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { FileTree, type FileNode } from '@/components/pipeline/file-tree';
import { CodeEditor } from '@/components/editor/code-editor';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { useEvolveChat } from '@/lib/hooks/use-evolve-chat';
import { cn } from '@/lib/utils';
import { DynamicStageTabs } from './dynamic-stage-tabs';
import { getStageTabConfig } from './stage-tab-configs';
import type { StageTabConfig, SpecialTab } from './dynamic-stage-tabs';
import type { StagePanelProps } from './types';

// ─── IDE Helpers ─────────────────────────────────────────────────

function inferLanguage(filename: string | undefined): string {
  if (!filename) return 'plaintext';
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

function buildFileTree(files: { path: string }[]): FileNode[] {
  const root: FileNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
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

// ─── IDE + Chat Panel ────────────────────────────────────────────

interface IDEChatPanelProps {
  pipelineRunId: string | null;
}

function IDEChatPanel({ pipelineRunId }: IDEChatPanelProps) {
  const modernizedFiles = usePipelineStore((s) => s.modernizedFiles);
  const updateModernizedFile = usePipelineStore((s) => s.updateModernizedFile);
  const [chatInput, setChatInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState(500);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { messages: chatHistory, sendMessage, isStreaming: isChatStreaming, clearHistory } = useEvolveChat(pipelineRunId);

  const fileTree = useMemo(() => buildFileTree(modernizedFiles), [modernizedFiles]);
  const currentFile = useMemo(() => {
    if (!selectedFile) return modernizedFiles[0] || null;
    return modernizedFiles.find((f) => f.path === selectedFile) || null;
  }, [selectedFile, modernizedFiles]);

  const handleFileClick = useCallback((node: FileNode) => {
    if (node.type === 'file') {
      setSelectedFile(node.path || null);
    }
  }, []);

  const handleCodeChange = useCallback((value: string | undefined) => {
    if (selectedFile && value !== undefined) {
      updateModernizedFile(selectedFile, value);
    }
  }, [selectedFile, updateModernizedFile]);

  // Measure editor container to give Monaco an explicit pixel height
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
  }, []);

  const handleSendChat = useCallback(() => {
    if (!chatInput.trim()) return;
    sendMessage(chatInput.trim());
    setChatInput('');
  }, [chatInput, sendMessage]);

  useEffect(() => {
    if (chatHistory.length > 0) {
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, [chatHistory.length, chatHistory[chatHistory.length - 1]?.content]);

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" style={{ height: 'calc(100vh - 380px)', minHeight: '350px', maxHeight: 'calc(100vh - 380px)' }}>
      <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: '180px minmax(0, 1fr) 300px' }}>
        {/* File Tree */}
        <div className="border-r border-slate-200 dark:border-slate-700 overflow-y-auto bg-white dark:bg-slate-900">
          {modernizedFiles.length > 0 ? (
            <FileTree
              nodes={fileTree}
              selectedPath={selectedFile || undefined}
              onFileClick={handleFileClick}
              showSearch
              maxHeight="calc(100vh - 380px)"
              className="border-0 rounded-none"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-slate-400 p-3 text-center">
              Run FORGE first to generate code
            </div>
          )}
        </div>

        {/* Code Editor */}
        <div className="border-r border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col h-full">
          {currentFile && (
            <div className="flex-shrink-0 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-[10px] font-mono text-slate-500 truncate">
              {currentFile.path}
            </div>
          )}
          <div ref={editorContainerRef} className="flex-1 min-h-0">
            {currentFile ? (
              <CodeEditor
                value={currentFile.content}
                onChange={handleCodeChange}
                language={inferLanguage(currentFile.name || currentFile.path)}
                height={`${editorHeight}px`}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-slate-400">
                {modernizedFiles.length > 0 ? 'Select a file to edit' : 'No files yet'}
              </div>
            )}
          </div>
        </div>

        {/* Chat Panel */}
        <div className="flex flex-col h-full overflow-hidden bg-slate-50 dark:bg-slate-900">
          {/* Chat Header */}
          <div className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
            <div className="flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-primary-600" />
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">AI Assistant</span>
            </div>
            {chatHistory.length > 0 && (
              <button
                onClick={clearHistory}
                disabled={isChatStreaming}
                className="text-[10px] text-slate-400 hover:text-red-500 transition-colors disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
            {chatHistory.length === 0 ? (
              <div className="text-center py-8">
                <MessageSquare className="w-6 h-6 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                <p className="text-[11px] text-slate-500 mb-3">
                  Ask about the code or request changes
                </p>
                <div className="flex flex-col gap-1.5">
                  {[
                    'Refactor this function',
                    'Add error handling',
                    'Explain this logic',
                    'Add unit tests',
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setChatInput(suggestion)}
                      className="text-[10px] px-2.5 py-1.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-primary-300 hover:text-primary-600 transition-colors text-left"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chatHistory.map((msg) => (
                <div key={msg.id} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                  {msg.role === 'assistant' && (
                    <div className="w-5 h-5 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="w-3 h-3 text-primary-600 dark:text-primary-400" />
                    </div>
                  )}
                  <div className={cn(
                    'rounded-lg px-2.5 py-1.5 text-[11px] max-w-[85%] whitespace-pre-wrap',
                    msg.role === 'user'
                      ? 'bg-primary-600 text-white rounded-br-sm'
                      : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-bl-sm',
                  )}>
                    {msg.content || (
                      isChatStreaming && msg.role === 'assistant' ? (
                        <span className="flex items-center gap-1.5 text-slate-400">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Thinking...
                        </span>
                      ) : null
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center shrink-0 mt-0.5">
                      <User className="w-3 h-3 text-slate-500" />
                    </div>
                  )}
                </div>
              ))
            )}
            {isChatStreaming && chatHistory.length > 0 && chatHistory[chatHistory.length - 1]?.content && (
              <div className="flex items-center gap-1.5 pl-7">
                <span className="w-1 h-1 rounded-full bg-primary-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 rounded-full bg-primary-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 rounded-full bg-primary-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="flex-shrink-0 border-t border-slate-200 dark:border-slate-700 p-2 bg-white dark:bg-slate-800">
            <div className="flex gap-1.5">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); }
                }}
                placeholder="Ask or request changes..."
                disabled={isChatStreaming}
                className="flex-1 text-[11px] rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50"
              />
              <Button
                size="sm"
                className="h-7 w-7 p-0"
                onClick={handleSendChat}
                disabled={!chatInput.trim() || isChatStreaming}
              >
                {isChatStreaming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export default function EvolvePanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest,
  pipelineRunId,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);

  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  // Build tab config with IDE as a special "before" tab
  const tabConfig = useMemo((): StageTabConfig => {
    const base = getStageTabConfig('EVOLVE');

    const ideTab: SpecialTab = {
      id: 'ide',
      title: 'IDE',
      icon: FileCode,
      position: 'before',
      priority: 0,
      render: () => <IDEChatPanel pipelineRunId={pipelineRunId} />,
    };

    return {
      ...base,
      specialTabs: [ideTab, ...(base.specialTabs ?? [])],
    };
  }, [pipelineRunId]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Evolve & Operate
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Post-cutover operations plan with quantified KPI targets, operational runbook,
                legacy decommission timeline, and prioritized modernization backlog.
                Includes interactive chat for ongoing refinement.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant="outline" className="text-[10px]">KPI Dashboard</Badge>
                <Badge variant="outline" className="text-[10px]">Operational Runbook</Badge>
                <Badge variant="outline" className="text-[10px]">Decommission Plan</Badge>
                <Badge variant="outline" className="text-[10px]">Backlog</Badge>
                <Badge variant="outline" className="text-[10px]">Interactive Chat</Badge>
              </div>
            </CardContent>
          </Card>

          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Generate Operations Plan
              </Button>
            </div>
          )}
        </>
      )}

      {/* During execution */}
      {isRunning && (
        <>
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Evolve Activity" />}
        </>
      )}

      {/* After execution -- Dynamic Tabs (with IDE as special tab) */}
      {stage.output && !isRunning && (
        <DynamicStageTabs
          output={stage.output}
          stageIndex={stageIndex}
          config={tabConfig}
          onRefineRequest={onRefineRequest}
        />
      )}
    </div>
  );
}
