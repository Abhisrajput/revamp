'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  Play, BookOpen, FlaskConical, AlertTriangle, ClipboardList,
  FileText, Table2, FileCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { FileTree, type FileNode } from '@/components/pipeline/file-tree';
import { buildFileTree } from '@/lib/utils/file-tree';
import { AgentBotGrid } from '@/components/pipeline/agent-bot-grid';
import { useStagePanel } from '@/lib/hooks/use-stage-panel';
import { cn } from '@/lib/utils';
import { TabFallback } from './tab-fallback';
import type { StagePanelProps } from './types';

// ─── Parsers ──────────────────────────────────────────────────

interface FeatureFileBlock {
  path: string;
  content: string;
  scenarios: number;
}

function extractFeatureFiles(text: string): FeatureFileBlock[] {
  const files: FeatureFileBlock[] = [];
  const blockPattern = /```(?:gherkin|feature)\n([\s\S]*?)```/g;
  let match;
  while ((match = blockPattern.exec(text)) !== null) {
    const content = match[1].trim();
    const pathMatch = content.match(/^#\s*File:\s*(.+)/m);
    const path = pathMatch ? pathMatch[1].trim() : `feature-${files.length + 1}.feature`;
    const scenarios = (content.match(/Scenario[:\s]/g) || []).length;
    files.push({ path, content, scenarios });
  }
  return files;
}

function extractSection(text: string, ...headings: string[]): string | null {
  for (const heading of headings) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(?:^|\\n)(#{1,3})\\s*(?:\\d+\\.?\\s*)?${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n\\1(?!#)\\s|$)`,
      'i',
    );
    const match = pattern.exec(text);
    if (match && match[2].trim()) return match[2].trim();
    const fallback = new RegExp(
      `(?:^|\\n)#{1,3}\\s*(?:\\d+\\.?\\s*)?${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,2}\\s|$)`,
      'i',
    );
    const fm = fallback.exec(text);
    if (fm && fm[1].trim()) return fm[1].trim();
  }
  return null;
}


// ─── Gherkin Syntax Highlighter ──────────────────────────────

function GherkinViewer({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <pre className="p-4 text-[12px] font-mono leading-relaxed overflow-auto bg-slate-950 text-slate-300 rounded-b-lg">
      {lines.map((line, i) => {
        const trimmed = line.trimStart();
        let cls = 'text-slate-400';
        if (/^Feature:/i.test(trimmed)) cls = 'text-blue-400 font-bold';
        else if (/^Scenario Outline:/i.test(trimmed)) cls = 'text-purple-400 font-semibold';
        else if (/^Scenario:/i.test(trimmed)) cls = 'text-purple-400 font-semibold';
        else if (/^Background:/i.test(trimmed)) cls = 'text-cyan-400 font-semibold';
        else if (/^(Given|When|Then|And|But)\s/i.test(trimmed)) cls = 'text-green-400';
        else if (/^@/i.test(trimmed)) cls = 'text-amber-400';
        else if (/^Examples:/i.test(trimmed)) cls = 'text-pink-400 font-semibold';
        else if (/^\|/.test(trimmed)) cls = 'text-slate-300';
        else if (/^#/.test(trimmed)) cls = 'text-slate-600 italic';
        return (
          <div key={i} className="flex hover:bg-slate-900/50">
            <span className="w-8 text-right pr-3 text-slate-600 select-none shrink-0">{i + 1}</span>
            <span className={cls}>{line}</span>
          </div>
        );
      })}
    </pre>
  );
}

// ─── Tab definitions ─────────────────────────────────────────

type TabKey = 'features' | 'results' | 'findings' | 'traceability' | 'regression' | 'output';

const TABS: Array<{ key: TabKey; label: string; icon: typeof FileText }> = [
  { key: 'features', label: 'Feature Files', icon: BookOpen },
  { key: 'results', label: 'Test Results', icon: FlaskConical },
  { key: 'findings', label: 'Findings', icon: AlertTriangle },
  { key: 'traceability', label: 'Traceability', icon: Table2 },
  { key: 'regression', label: 'Regression', icon: ClipboardList },
  { key: 'output', label: 'Full Output', icon: FileText },
];

// ─── Component ───────────────────────────────────────────────

export default function SpecLockPanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest: _onRefineRequest,
}: StagePanelProps) {
  const { logs, isRunning, hasOutput, canRun } = useStagePanel(stage, stageIndex, streamingText, isExecuting);
  const [activeTab, setActiveTab] = useState<TabKey>('features');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // ─── Parsed data ───────────────────────────────────────────
  const featureFiles = useMemo(() => stage.output ? extractFeatureFiles(stage.output) : [], [stage.output]);
  const fileTree = useMemo(() => buildFileTree(featureFiles, 'gherkin'), [featureFiles]);
  const currentFile = useMemo(() => {
    if (!selectedFile) return featureFiles[0] ?? null;
    return featureFiles.find((f) => f.path === selectedFile) ?? featureFiles[0] ?? null;
  }, [featureFiles, selectedFile]);

  const resultsSection = useMemo(() => stage.output ? extractSection(stage.output, 'Test Execution Results', 'Test Results') : null, [stage.output]);
  const findingsSection = useMemo(() => stage.output ? extractSection(stage.output, 'Validation Findings', 'Findings') : null, [stage.output]);
  const traceabilitySection = useMemo(() => stage.output ? extractSection(stage.output, 'Traceability Matrix', 'Traceability') : null, [stage.output]);
  const regressionSection = useMemo(() => stage.output ? extractSection(stage.output, 'Regression Checklist', 'Regression') : null, [stage.output]);

  const stats = useMemo(() => ({
    files: featureFiles.length,
    scenarios: featureFiles.reduce((sum, f) => sum + f.scenarios, 0),
  }), [featureFiles]);

  const handleFileClick = useCallback((node: FileNode) => {
    if (node.type === 'file' && node.path) setSelectedFile(node.path);
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <FileCheck className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Behavior Lock-in
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Generates Cucumber-compatible Gherkin .feature files that lock the behavioral
                contracts of the legacy system. Includes simulated test execution, validation
                findings, and full traceability back to business rules.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant="outline" className="text-[10px]">.feature Files</Badge>
                <Badge variant="outline" className="text-[10px]">Test Execution</Badge>
                <Badge variant="outline" className="text-[10px]">Validation Findings</Badge>
                <Badge variant="outline" className="text-[10px]">Traceability Matrix</Badge>
                <Badge variant="outline" className="text-[10px]">Regression Checklist</Badge>
              </div>
            </CardContent>
          </Card>

          {canRun && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Generate BDD Specs
              </Button>
            </div>
          )}
        </>
      )}

      {/* During execution */}
      {isRunning && (
        <>
          <AgentBotGrid
            subtasks={stage.subtasks}
            overallProgress={stage.subtaskProgress}
            message="Locking behavioral contracts..."
            subtitle="Generating BDD scenarios from business rules"
          />
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Spec Lock Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Stats Bar */}
          <div className="flex-shrink-0 flex items-center gap-4 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs">
            <span className="flex items-center gap-1.5 text-slate-500">
              <BookOpen className="w-3.5 h-3.5" />
              {stats.files} feature files
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <FlaskConical className="w-3.5 h-3.5" />
              {stats.scenarios} scenarios
            </span>
          </div>

          {/* Tab Bar */}
          <div className="flex-shrink-0 flex gap-0.5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
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
                {key === 'features' && stats.files > 0 && (
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400">
                    {stats.files}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 min-h-0 overflow-hidden">

            {/* Feature Files — IDE-like split layout */}
            {activeTab === 'features' && (
              <div className="flex h-full">
                {featureFiles.length > 0 ? (
                  <>
                    {/* File Tree Sidebar */}
                    <div className="w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 overflow-y-auto bg-slate-50 dark:bg-slate-900/50">
                      <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        Feature Files
                      </div>
                      <FileTree
                        nodes={fileTree}
                        onFileClick={handleFileClick}
                        selectedPath={currentFile?.path}
                      />
                    </div>
                    {/* Gherkin Code Viewer */}
                    <div className="flex-1 min-w-0 flex flex-col">
                      {currentFile ? (
                        <>
                          <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-xs shrink-0">
                            <BookOpen className="w-3.5 h-3.5 text-primary-500" />
                            <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{currentFile.path}</span>
                            <span className="text-slate-400 ml-auto shrink-0">{currentFile.scenarios} scenarios</span>
                          </div>
                          <div className="flex-1 overflow-auto">
                            <GherkinViewer content={currentFile.content} />
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center justify-center h-full text-sm text-slate-400">
                          Select a feature file
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 overflow-auto p-4">
                    <TabFallback stageOutput={stage.output} emptyLabel="No feature files found" />
                  </div>
                )}
              </div>
            )}

            {/* Test Results */}
            {activeTab === 'results' && (
              <div className="p-4 overflow-auto h-full">
                {resultsSection ? (
                  <StageOutput output={`## Test Execution Results\n\n${resultsSection}`} isStreaming={false} />
                ) : (
                  <TabFallback stageOutput={stage.output} emptyLabel="No test results found" />
                )}
              </div>
            )}

            {/* Validation Findings */}
            {activeTab === 'findings' && (
              <div className="p-4 overflow-auto h-full">
                {findingsSection ? (
                  <StageOutput output={`## Validation Findings\n\n${findingsSection}`} isStreaming={false} />
                ) : (
                  <TabFallback stageOutput={stage.output} emptyLabel="No validation findings found" />
                )}
              </div>
            )}

            {/* Traceability Matrix */}
            {activeTab === 'traceability' && (
              <div className="p-4 overflow-auto h-full">
                {traceabilitySection ? (
                  <StageOutput output={`## Traceability Matrix\n\n${traceabilitySection}`} isStreaming={false} />
                ) : (
                  <TabFallback stageOutput={stage.output} emptyLabel="No traceability data found" />
                )}
              </div>
            )}

            {/* Regression Checklist */}
            {activeTab === 'regression' && (
              <div className="p-4 overflow-auto h-full">
                {regressionSection ? (
                  <StageOutput output={`## Regression Checklist\n\n${regressionSection}`} isStreaming={false} />
                ) : (
                  <TabFallback stageOutput={stage.output} emptyLabel="No regression checklist found" />
                )}
              </div>
            )}

            {/* Full Output */}
            {activeTab === 'output' && (
              <div className="p-4 overflow-auto h-full">
                <StageOutput output={stage.output} isStreaming={false} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
