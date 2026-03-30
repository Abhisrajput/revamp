'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Play, TrendingUp, MessageSquare, Send, FileCode,
  BarChart3, Rocket, Loader2, User, Bot,
  Calendar, ClipboardList, Target,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { FileTree, type FileNode } from '@/components/pipeline/file-tree';
import { CodeEditor } from '@/components/editor/code-editor';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { useEvolveChat } from '@/lib/hooks/use-evolve-chat';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// ─── Parsers ──────────────────────────────────────────────────────

interface KpiRow {
  kpi: string;
  baseline: string;
  target30: string;
  target90: string;
  owner: string;
}

interface BacklogItem {
  index: number;
  item: string;
  priority: string;
  category: string;
  effort: string;
  sprint: string;
  status: string;
}

interface DecommissionPhase {
  phase: string;
  timeline: string;
  action: string;
  dependencies: string;
  rollback: string;
}

function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^#{1,3}\\s*${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$)`, 'im');
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

function extractKpis(text: string): KpiRow[] {
  const section = extractSection(text, 'KPI Dashboard');
  if (!section) return [];

  const rows: KpiRow[] = [];
  const lines = section.split('\n').filter((l) =>
    /^\|/.test(l) && !/^[\s|:-]+$/.test(l) && !/^\|\s*KPI\s*\|/.test(l)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    rows.push({
      kpi: cells[0],
      baseline: cells[1],
      target30: cells[2],
      target90: cells[3],
      owner: cells[4] || '',
    });
  }
  return rows;
}

function extractBacklog(text: string): BacklogItem[] {
  const section = extractSection(text, 'Modernization Backlog');
  if (!section) return [];

  const rows: BacklogItem[] = [];
  const lines = section.split('\n').filter((l) =>
    /^\|/.test(l) && !/^[\s|:-]+$/.test(l) && !/^\|\s*#\s*\|/.test(l)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 6) continue;
    const idx = parseInt(cells[0], 10);
    if (isNaN(idx)) continue;
    rows.push({
      index: idx,
      item: cells[1],
      priority: cells[2],
      category: cells[3],
      effort: cells[4],
      sprint: cells[5],
      status: cells[6] || 'Pending',
    });
  }
  return rows;
}

function extractDecommission(text: string): DecommissionPhase[] {
  const section = extractSection(text, 'Decommission Plan') || extractSection(text, 'Legacy Decommission Plan');
  if (!section) return [];

  const rows: DecommissionPhase[] = [];
  const lines = section.split('\n').filter((l) =>
    /^\|/.test(l) && !/^[\s|:-]+$/.test(l) && !/^\|\s*Phase\s*\|/.test(l)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    rows.push({
      phase: cells[0],
      timeline: cells[1],
      action: cells[2],
      dependencies: cells[3],
      rollback: cells[4] || '',
    });
  }
  return rows;
}

// ─── Component ────────────────────────────────────────────────────

type TabKey = 'ide' | 'kpis' | 'backlog' | 'decommission' | 'runbook' | 'output';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Target }> = [
  { key: 'ide', label: 'IDE', icon: FileCode },
  { key: 'kpis', label: 'KPI Dashboard', icon: Target },
  { key: 'backlog', label: 'Backlog', icon: ClipboardList },
  { key: 'decommission', label: 'Decommission', icon: Calendar },
  { key: 'runbook', label: 'Runbook', icon: FileCode },
  { key: 'output', label: 'Full Output', icon: BarChart3 },
];

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
  const modernizedFiles = usePipelineStore((s) => s.modernizedFiles);
  const updateModernizedFile = usePipelineStore((s) => s.updateModernizedFile);
  const [activeTab, setActiveTab] = useState<TabKey>('ide');
  const [chatInput, setChatInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState(500);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  const { messages: chatHistory, sendMessage, isStreaming: isChatStreaming, clearHistory } = useEvolveChat(pipelineRunId);

  // ─── Parse output ──────────────────────────────────────────────
  const kpis = useMemo(() => stage.output ? extractKpis(stage.output) : [], [stage.output]);
  const backlog = useMemo(() => stage.output ? extractBacklog(stage.output) : [], [stage.output]);
  const decommission = useMemo(() => stage.output ? extractDecommission(stage.output) : [], [stage.output]);
  const runbookSection = useMemo(() => stage.output ? extractSection(stage.output, 'Operational Runbook') : null, [stage.output]);

  // ─── Code editor ───────────────────────────────────────────────
  const fileTree = useMemo(() => buildFileTree(modernizedFiles), [modernizedFiles]);
  const currentFile = useMemo(() => {
    if (!selectedFile) return modernizedFiles[0] || null;
    return modernizedFiles.find((f) => f.path === selectedFile) || null;
  }, [selectedFile, modernizedFiles]);

  const handleFileClick = useCallback((node: FileNode) => {
    if (node.type === 'file') {
      setSelectedFile(node.path || null);
      setActiveTab('ide');
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
  }, [activeTab]);

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

  // Stats
  const p0Items = backlog.filter((b) => b.priority === 'P0').length;
  const totalEffort = backlog.reduce((sum, b) => {
    const match = b.effort.match(/(\d+)/);
    return sum + (match ? parseInt(match[1], 10) : 0);
  }, 0);

  return (
    <div className="space-y-4">
      {/* ── Pre-execution ────────────────────────────────────────── */}
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

      {/* ── During execution ─────────────────────────────────────── */}
      {isRunning && (
        <>
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Evolve Activity" />}
        </>
      )}

      {/* ── After execution ──────────────────────────────────────── */}
      {stage.output && !isRunning && (
        <>
          {/* Stats Bar */}
          <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <Target className="w-3.5 h-3.5" />
                {kpis.length} KPIs tracked
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <ClipboardList className="w-3.5 h-3.5" />
                {backlog.length} backlog items
              </span>
              {p0Items > 0 && (
                <span className="flex items-center gap-1.5 text-red-600 font-medium">
                  <Rocket className="w-3.5 h-3.5" />
                  {p0Items} P0 items
                </span>
              )}
              <span className="flex items-center gap-1.5 text-slate-500">
                <Calendar className="w-3.5 h-3.5" />
                {decommission.length} phases
              </span>
            </div>
            {totalEffort > 0 && (
              <Badge variant="outline" className="text-[10px]">
                ~{totalEffort}d total effort
              </Badge>
            )}
          </div>

          {/* Tab Bar */}
          <div className="flex gap-0.5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap',
                  activeTab === key
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
                {key === 'ide' && chatHistory.length > 0 && (
                  <span className="text-[9px] ml-0.5 opacity-70">({chatHistory.length})</span>
                )}
                {key === 'backlog' && backlog.length > 0 && (
                  <span className="text-[9px] ml-0.5 opacity-70">({backlog.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* ── Tab: KPI Dashboard ─────────────────────────────────── */}
          {activeTab === 'kpis' && (
            <div className="space-y-3">
              {kpis.length > 0 ? (
                <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto" style={{ maxHeight: '460px' }}>
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                      <tr className="border-b border-slate-200 dark:border-slate-700">
                        <th className="text-left py-2 px-3 text-slate-500 font-semibold">KPI</th>
                        <th className="text-center py-2 px-3 text-slate-500 font-semibold">Current</th>
                        <th className="text-center py-2 px-3 text-slate-500 font-semibold">30-Day Target</th>
                        <th className="text-center py-2 px-3 text-slate-500 font-semibold">90-Day Target</th>
                        <th className="text-left py-2 px-3 text-slate-500 font-semibold">Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kpis.map((k, i) => (
                        <tr key={i} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                          <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-50">{k.kpi}</td>
                          <td className="py-2 px-3 text-center font-mono text-slate-500">{k.baseline}</td>
                          <td className="py-2 px-3 text-center font-mono text-amber-600 dark:text-amber-400 font-medium">{k.target30}</td>
                          <td className="py-2 px-3 text-center font-mono text-emerald-600 dark:text-emerald-400 font-medium">{k.target90}</td>
                          <td className="py-2 px-3 text-slate-500">{k.owner}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No KPI data found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: IDE (File Tree + Code Editor + Chat) ─────────── */}
          {activeTab === 'ide' && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" style={{ height: 'calc(100vh - 320px)', minHeight: '350px', maxHeight: 'calc(100vh - 320px)' }}>
              <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: '180px minmax(0, 1fr) 300px' }}>
                {/* File Tree */}
                <div className="border-r border-slate-200 dark:border-slate-700 overflow-y-auto bg-white dark:bg-slate-900">
                  {modernizedFiles.length > 0 ? (
                    <FileTree
                      nodes={fileTree}
                      selectedPath={selectedFile || undefined}
                      onFileClick={handleFileClick}
                      showSearch
                      maxHeight="calc(100vh - 320px)"
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

                {/* Chat Panel — fixed height, internal scroll only */}
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
          )}

          {/* ── Tab: Backlog ────────────────────────────────────────── */}
          {activeTab === 'backlog' && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto" style={{ maxHeight: '460px' }}>
              {backlog.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold w-8">#</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Item</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Priority</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Category</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Effort</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Sprint</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backlog.map((b) => (
                      <tr key={b.index} className={cn(
                        'border-b border-slate-100 dark:border-slate-800',
                        b.priority === 'P0' && 'bg-red-50/50 dark:bg-red-950/10',
                      )}>
                        <td className="py-1.5 px-3 text-slate-400 font-mono">{b.index}</td>
                        <td className="py-1.5 px-3 font-medium text-slate-900 dark:text-slate-50">{b.item}</td>
                        <td className="py-1.5 px-3 text-center">
                          <Badge className={cn(
                            'text-[9px] px-1.5',
                            b.priority === 'P0' && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                            b.priority === 'P1' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                            b.priority === 'P2' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
                            b.priority === 'P3' && 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
                          )}>
                            {b.priority}
                          </Badge>
                        </td>
                        <td className="py-1.5 px-3 text-slate-500">{b.category}</td>
                        <td className="py-1.5 px-3 text-center font-mono text-slate-500">{b.effort}</td>
                        <td className="py-1.5 px-3 text-center font-mono text-primary-600 dark:text-primary-400">{b.sprint}</td>
                        <td className="py-1.5 px-3 text-center">
                          <Badge variant="outline" className="text-[9px]">{b.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No backlog data found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Decommission ───────────────────────────────────── */}
          {activeTab === 'decommission' && (
            <div className="space-y-3">
              {decommission.length > 0 ? (
                decommission.map((phase, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px] font-mono">{phase.timeline}</Badge>
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{phase.phase}</span>
                      </div>
                    </div>
                    <CardContent className="p-3 space-y-1.5">
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Action:</span> {phase.action}
                      </p>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Dependencies:</span> {phase.dependencies}
                      </p>
                      {phase.rollback && (
                        <p className="text-[11px] text-slate-600 dark:text-slate-400">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">Rollback:</span> {phase.rollback}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No decommission plan found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Runbook ─────────────────────────────────────────── */}
          {activeTab === 'runbook' && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 max-h-[460px] overflow-auto">
              {runbookSection ? (
                <RefinableMarkdown
                  text={`## Operational Runbook\n\n${runbookSection}`}
                  onSectionRefined={(updated) => {
                    usePipelineStore.getState().setStageOutput(stageIndex, updated);
                  }}
                  onRefineRequest={onRefineRequest}
                />
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No operational runbook found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Full Output ───────────────────────────────────── */}
          {activeTab === 'output' && (
            <RefinableMarkdown
              text={stage.output}
              onSectionRefined={(updated) => {
                usePipelineStore.getState().setStageOutput(stageIndex, updated);
              }}
              onRefineRequest={onRefineRequest}
            />
          )}
        </>
      )}
    </div>
  );
}
