'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Play, FileCheck, BookOpen, FlaskConical, AlertTriangle,
  Table2, ClipboardList, CheckCircle, XCircle, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { FileTree, type FileNode } from '@/components/pipeline/file-tree';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// ─── Parsers ──────────────────────────────────────────────────────

interface FeatureFileBlock {
  path: string;
  content: string;
  scenarios: GherkinScenario[];
}

interface GherkinScenario {
  feature: string;
  scenario: string;
  steps: string[];
  tags: string[];
  isOutline: boolean;
}

interface TestResult {
  index: number;
  feature: string;
  scenario: string;
  tags: string;
  result: 'PASS' | 'FAIL';
  duration: string;
  failureReason: string;
}

interface ValidationFinding {
  index: number;
  severity: 'Critical' | 'Warning' | 'Info';
  finding: string;
  evidence: string;
  recommendation: string;
}

interface TraceabilityRow {
  ruleId: string;
  ruleDescription: string;
  featureFile: string;
  scenarios: string;
  coverage: string;
  regressionCheck: string;
}

/** Extract ```gherkin blocks with # File: headers */
function extractFeatureFiles(text: string): FeatureFileBlock[] {
  const files: FeatureFileBlock[] = [];
  const blockPattern = /```gherkin\n([\s\S]*?)```/g;
  let match;

  while ((match = blockPattern.exec(text)) !== null) {
    const content = match[1].trim();
    const pathMatch = content.match(/^#\s*File:\s*(.+)/m);
    const path = pathMatch ? pathMatch[1].trim() : `feature-${files.length + 1}.feature`;

    const scenarios = parseGherkinScenarios(content, path);
    files.push({ path, content, scenarios });
  }

  return files;
}

function parseGherkinScenarios(text: string, featurePath: string): GherkinScenario[] {
  const scenarios: GherkinScenario[] = [];
  const featureMatch = text.match(/Feature:\s*(.+)/);
  const featureName = featureMatch ? featureMatch[1].trim() : featurePath;

  const scenarioPattern = /(?:(@[\w@. -]+)\s*\n\s*)?Scenario(?: Outline)?:\s*(.+?)(?=\n(?:\s*@|\s*Scenario|\s*Feature:|$))/gs;
  let match;

  while ((match = scenarioPattern.exec(text)) !== null) {
    const tagLine = match[1] || '';
    const fullBlock = match[0];
    const scenarioName = match[2].trim();
    const isOutline = fullBlock.includes('Scenario Outline:');

    const tags = tagLine.match(/@[\w.-]+/g) || [];
    const steps = fullBlock
      .split('\n')
      .filter((line) => /^\s*(Given|When|Then|And|But)\s/.test(line))
      .map((line) => line.trim());

    scenarios.push({ feature: featureName, scenario: scenarioName, steps, tags, isOutline });
  }

  return scenarios;
}

/** Extract test execution results from markdown table */
function extractTestResults(text: string): TestResult[] {
  const results: TestResult[] = [];
  const section = extractSection(text, 'Test Execution Results');
  if (!section) return results;

  const rows = section.split('\n').filter((line) =>
    /^\|/.test(line) && !/^[\s|:-]+$/.test(line) && !/^\|\s*#\s*\|/.test(line)
  );

  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 6) continue;

    const idx = parseInt(cells[0], 10);
    if (isNaN(idx)) continue;

    results.push({
      index: idx,
      feature: cells[1],
      scenario: cells[2],
      tags: cells[3],
      result: cells[4].includes('PASS') ? 'PASS' : 'FAIL',
      duration: cells[5],
      failureReason: cells[6] || '—',
    });
  }

  return results;
}

/** Extract validation findings from markdown table */
function extractValidationFindings(text: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const section = extractSection(text, 'Validation Findings');
  if (!section) return findings;

  const rows = section.split('\n').filter((line) =>
    /^\|/.test(line) && !/^[\s|:-]+$/.test(line) && !/^\|\s*#\s*\|/.test(line)
  );

  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;

    // Index can be a number (1, 2) or an ID (VF-1, VF-2)
    const idCell = cells[0];
    const idx = parseInt(idCell.replace(/\D+/g, ''), 10);
    if (isNaN(idx) && !idCell) continue;

    const severityRaw = cells[1];
    const severity = /critical/i.test(severityRaw) ? 'Critical'
      : /warning|high/i.test(severityRaw) ? 'Warning' : 'Info';

    findings.push({
      index: idx || findings.length + 1,
      severity,
      finding: cells[2],
      evidence: cells[3],
      recommendation: cells[4] || '',
    });
  }

  return findings;
}

/** Extract traceability matrix rows from markdown table */
function extractTraceability(text: string): TraceabilityRow[] {
  const rows: TraceabilityRow[] = [];
  const section = extractSection(text, 'Traceability Matrix');
  if (!section) return rows;

  const lines = section.split('\n').filter((line) =>
    /^\|/.test(line) && !/^[\s|:-]+$/.test(line) && !/^\|\s*Rule ID\s*\|/.test(line)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;

    rows.push({
      ruleId: cells[0],
      ruleDescription: cells[1],
      featureFile: cells[2],
      scenarios: cells[3],
      coverage: cells[4],
      regressionCheck: cells[5] || '',
    });
  }

  return rows;
}

/** Extract a markdown section by heading */
function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingMatch = new RegExp(`(?:^|\\n)(#{1,3})\\s*(?:\\d+\\.?\\s*)?${escaped}[^\\n]*\\n`, 'i').exec(text);
  if (!headingMatch) return null;
  const level = headingMatch[1].length;
  const startIndex = headingMatch.index + headingMatch[0].length;
  const endMatch = new RegExp(`\\n#{1,${level}}\\s`).exec(text.slice(startIndex));
  const content = endMatch ? text.slice(startIndex, startIndex + endMatch.index) : text.slice(startIndex);
  return content.trim() || null;
}

/** Build file tree from feature file paths */
function buildFeatureTree(files: FeatureFileBlock[]): FileNode[] {
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

// ─── Component ────────────────────────────────────────────────────

type TabKey = 'features' | 'results' | 'findings' | 'traceability' | 'regression' | 'output';

const TABS: Array<{ key: TabKey; label: string; icon: typeof BookOpen }> = [
  { key: 'features', label: 'Features', icon: BookOpen },
  { key: 'results', label: 'Test Results', icon: FlaskConical },
  { key: 'findings', label: 'Findings', icon: AlertTriangle },
  { key: 'traceability', label: 'Traceability', icon: Table2 },
  { key: 'regression', label: 'Regression', icon: ClipboardList },
  { key: 'output', label: 'Full Output', icon: FileCheck },
];

export default function SpecLockPanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  onApprove: _onApprove,
  onReject: _onReject,
  isExecuting,
  onRefineRequest,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);
  const [activeTab, setActiveTab] = useState<TabKey>('features');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  // ─── Parse output ──────────────────────────────────────────────
  const featureFiles = useMemo(() => {
    if (!stage.output) return [];
    return extractFeatureFiles(stage.output);
  }, [stage.output]);

  const testResults = useMemo(() => {
    if (!stage.output) return [];
    return extractTestResults(stage.output);
  }, [stage.output]);

  const findings = useMemo(() => {
    if (!stage.output) return [];
    return extractValidationFindings(stage.output);
  }, [stage.output]);

  const traceability = useMemo(() => {
    if (!stage.output) return [];
    return extractTraceability(stage.output);
  }, [stage.output]);

  const regressionSection = useMemo(() => {
    if (!stage.output) return null;
    return extractSection(stage.output, 'Regression Checklist');
  }, [stage.output]);

  // ─── Derived stats ─────────────────────────────────────────────
  const totalScenarios = featureFiles.reduce((sum, f) => sum + f.scenarios.length, 0);
  const passCount = testResults.filter((r) => r.result === 'PASS').length;
  const failCount = testResults.filter((r) => r.result === 'FAIL').length;
  const passRate = testResults.length > 0 ? Math.round((passCount / testResults.length) * 100) : 0;
  const criticalFindings = findings.filter((f) => f.severity === 'Critical').length;

  // ─── Feature file tree ─────────────────────────────────────────
  const fileTree = useMemo(() => buildFeatureTree(featureFiles), [featureFiles]);
  const currentFile = useMemo(() => {
    if (!selectedFile) return featureFiles[0] || null;
    return featureFiles.find((f) => f.path === selectedFile) || null;
  }, [selectedFile, featureFiles]);

  const handleFileClick = useCallback((node: FileNode) => {
    if (node.type === 'file') {
      setSelectedFile(node.path || null);
      setActiveTab('features');
    }
  }, []);

  // Auto-select first file
  useEffect(() => {
    if (featureFiles.length > 0 && !selectedFile) {
      setSelectedFile(featureFiles[0].path);
    }
  }, [featureFiles, selectedFile]);

  // Populate store feature files
  useEffect(() => {
    if (featureFiles.length === 0) return;
    const store = usePipelineStore.getState();
    store.clearFeatureFiles();
    for (const f of featureFiles) {
      const pass = testResults.filter((r) => r.feature === f.scenarios[0]?.feature && r.result === 'PASS').length;
      const fail = testResults.filter((r) => r.feature === f.scenarios[0]?.feature && r.result === 'FAIL').length;
      store.addFeatureFile({
        path: f.path,
        content: f.content,
        scenarioCount: f.scenarios.length,
        passCount: pass,
        failCount: fail,
      });
    }
  }, [featureFiles, testResults]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Pre-execution ────────────────────────────────────────── */}
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
                findings, and full traceability back to DECODE business rules.
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

          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Generate BDD Specs
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── During execution ─────────────────────────────────────── */}
      {isRunning && (
        <>
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Spec Lock Activity" />}
        </>
      )}

      {/* ── After execution ──────────────────────────────────────── */}
      {stage.output && !isRunning && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Stats Bar — sticky */}
          <div className="flex-shrink-0 flex items-center justify-between bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <BookOpen className="w-3.5 h-3.5" />
                {featureFiles.length} feature files
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <FlaskConical className="w-3.5 h-3.5" />
                {totalScenarios} scenarios
              </span>
              <span className={cn(
                'flex items-center gap-1.5 font-medium',
                passRate >= 80 ? 'text-emerald-600' : passRate >= 50 ? 'text-amber-600' : 'text-red-600',
              )}>
                <CheckCircle className="w-3.5 h-3.5" />
                {passCount} passed
              </span>
              {failCount > 0 && (
                <span className="flex items-center gap-1.5 text-red-600 font-medium">
                  <XCircle className="w-3.5 h-3.5" />
                  {failCount} failed
                </span>
              )}
              {criticalFindings > 0 && (
                <span className="flex items-center gap-1.5 text-orange-600 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {criticalFindings} critical findings
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge className={cn(
                'text-[10px]',
                passRate >= 80 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                  : passRate >= 50 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
              )}>
                {passRate}% pass rate
              </Badge>
            </div>
          </div>

          {/* Tab Bar — sticky */}
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
                {key === 'results' && testResults.length > 0 && (
                  <span className="text-[9px] ml-0.5 opacity-70">({testResults.length})</span>
                )}
                {key === 'findings' && findings.length > 0 && (
                  <span className="text-[9px] ml-0.5 opacity-70">({findings.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable area */}
          <div className="flex-1 min-h-0 overflow-auto p-4">

          {/* ── Tab: Features ─────────────────────────────────────── */}
          {activeTab === 'features' && (
            <div className="grid grid-cols-[220px_1fr] rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" style={{ height: 'calc(100vh - 280px)' }}>
              {/* File tree sidebar */}
              <div className="border-r border-slate-200 dark:border-slate-700 overflow-auto">
                <FileTree
                  nodes={fileTree}
                  selectedPath={selectedFile || undefined}
                  onFileClick={handleFileClick}
                  showSearch={false}
                  className="border-0 rounded-none"
                />
              </div>

              {/* Gherkin viewer */}
              <div className="overflow-auto bg-slate-950">
                {currentFile ? (
                  <GherkinViewer content={currentFile.content} />
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-slate-400">
                    Select a .feature file to view
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Tab: Test Results ──────────────────────────────────── */}
          {activeTab === 'results' && (
            <div className="flex-1 min-h-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {testResults.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold w-8">#</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Feature</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Scenario</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Tags</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold w-16">Result</th>
                      <th className="text-right py-2 px-3 text-slate-500 font-semibold w-16">Time</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Failure Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testResults.map((r) => (
                      <tr key={r.index} className={cn(
                        'border-b border-slate-100 dark:border-slate-800',
                        r.result === 'FAIL' && 'bg-red-50/50 dark:bg-red-950/20',
                      )}>
                        <td className="py-1.5 px-3 text-slate-400 font-mono">{r.index}</td>
                        <td className="py-1.5 px-3 text-slate-600 dark:text-slate-400">{r.feature}</td>
                        <td className="py-1.5 px-3 font-medium text-slate-900 dark:text-slate-50">{r.scenario}</td>
                        <td className="py-1.5 px-3">
                          <div className="flex flex-wrap gap-1">
                            {r.tags.split(/\s+/).filter(Boolean).map((tag) => (
                              <Badge key={tag} variant="outline" className="text-[8px] px-1 py-0">{tag}</Badge>
                            ))}
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-center">
                          {r.result === 'PASS' ? (
                            <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 text-[9px] px-1.5">
                              <CheckCircle className="w-2.5 h-2.5 mr-0.5 inline" />
                              PASS
                            </Badge>
                          ) : (
                            <Badge className="bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 text-[9px] px-1.5">
                              <XCircle className="w-2.5 h-2.5 mr-0.5 inline" />
                              FAIL
                            </Badge>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-slate-400">{r.duration}</td>
                        <td className="py-1.5 px-3 text-slate-500 max-w-[250px]">
                          {r.result === 'FAIL' ? (
                            <span className="text-red-600 dark:text-red-400">{r.failureReason}</span>
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No test execution results found in output
                </div>
              )}
              {testResults.length > 0 && (
                <div className="sticky bottom-0 bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-500 flex items-center gap-3">
                  <span className="font-semibold">{testResults.length} scenarios executed</span>
                  <span className="text-emerald-600">{passCount} passed</span>
                  <span className="text-red-600">{failCount} failed</span>
                  <span className={cn(
                    'font-medium',
                    passRate >= 80 ? 'text-emerald-600' : passRate >= 50 ? 'text-amber-600' : 'text-red-600',
                  )}>
                    ({passRate}% pass rate)
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Validation Findings ───────────────────────────── */}
          {activeTab === 'findings' && (
            <div className="space-y-3">
              {findings.length > 0 ? (
                <>
                  {/* Summary badges */}
                  <div className="flex gap-2">
                    {criticalFindings > 0 && (
                      <Badge className="bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 text-[10px]">
                        {criticalFindings} Critical
                      </Badge>
                    )}
                    {findings.filter((f) => f.severity === 'Warning').length > 0 && (
                      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 text-[10px]">
                        {findings.filter((f) => f.severity === 'Warning').length} Warning
                      </Badge>
                    )}
                    {findings.filter((f) => f.severity === 'Info').length > 0 && (
                      <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 text-[10px]">
                        {findings.filter((f) => f.severity === 'Info').length} Info
                      </Badge>
                    )}
                  </div>

                  {/* Findings cards */}
                  <div className="space-y-2">
                    {findings.map((f) => (
                      <Card key={f.index} className={cn(
                        'overflow-hidden',
                        f.severity === 'Critical' && 'border-red-200 dark:border-red-800',
                        f.severity === 'Warning' && 'border-amber-200 dark:border-amber-800',
                        f.severity === 'Info' && 'border-blue-200 dark:border-blue-800',
                      )}>
                        <CardContent className="p-3">
                          <div className="flex items-start gap-2">
                            <div className="mt-0.5">
                              {f.severity === 'Critical' && <XCircle className="w-3.5 h-3.5 text-red-500" />}
                              {f.severity === 'Warning' && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
                              {f.severity === 'Info' && <Info className="w-3.5 h-3.5 text-blue-500" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <Badge className={cn(
                                  'text-[9px] px-1.5',
                                  f.severity === 'Critical' && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                                  f.severity === 'Warning' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                                  f.severity === 'Info' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
                                )}>
                                  {f.severity}
                                </Badge>
                                <span className="text-xs font-medium text-slate-900 dark:text-slate-50 truncate">
                                  {f.finding}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                <span className="font-semibold text-slate-600 dark:text-slate-300">Evidence:</span> {f.evidence}
                              </p>
                              {f.recommendation && (
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                  <span className="font-semibold text-slate-600 dark:text-slate-300">Action:</span> {f.recommendation}
                                </p>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No validation findings found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Traceability Matrix ───────────────────────────── */}
          {activeTab === 'traceability' && (
            <div className="flex-1 min-h-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {traceability.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Rule ID</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Description</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Feature File</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Scenarios</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Coverage</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Regression</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traceability.map((row, i) => (
                      <tr key={i} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="py-1.5 px-3">
                          <span className="font-mono text-primary-600 dark:text-primary-400 font-semibold">
                            {row.ruleId}
                          </span>
                        </td>
                        <td className="py-1.5 px-3 text-slate-600 dark:text-slate-400 max-w-[200px] truncate">
                          {row.ruleDescription}
                        </td>
                        <td className="py-1.5 px-3">
                          <button
                            onClick={() => {
                              const match = featureFiles.find((f) => f.path.includes(row.featureFile) || row.featureFile.includes(f.path.split('/').pop() || ''));
                              if (match) {
                                setSelectedFile(match.path);
                                setActiveTab('features');
                              }
                            }}
                            className="text-blue-600 dark:text-blue-400 hover:underline font-mono text-[10px]"
                          >
                            {row.featureFile}
                          </button>
                        </td>
                        <td className="py-1.5 px-3 font-mono text-slate-500">{row.scenarios}</td>
                        <td className="py-1.5 px-3 text-center">
                          <Badge className={cn(
                            'text-[9px] px-1.5',
                            row.coverage.toLowerCase().startsWith('full') && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
                            row.coverage.toLowerCase().startsWith('partial') && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                            row.coverage.toLowerCase().startsWith('missing') && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                          )}>
                            {row.coverage.toLowerCase().startsWith('full') && <CheckCircle className="w-2.5 h-2.5 mr-0.5 inline" />}
                            {row.coverage.toLowerCase().startsWith('partial') && <AlertTriangle className="w-2.5 h-2.5 mr-0.5 inline" />}
                            {row.coverage.toLowerCase().startsWith('missing') && <XCircle className="w-2.5 h-2.5 mr-0.5 inline" />}
                            {row.coverage}
                          </Badge>
                        </td>
                        <td className="py-1.5 px-3 text-slate-500">{row.regressionCheck}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No traceability data found in output
                </div>
              )}
              {traceability.length > 0 && (
                <div className="sticky bottom-0 bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-500 flex items-center gap-3">
                  <span className="font-semibold">{traceability.length} business rules mapped</span>
                  <span className="text-emerald-600">
                    {traceability.filter((r) => r.coverage.toLowerCase().startsWith('full')).length} fully covered
                  </span>
                  <span className="text-amber-600">
                    {traceability.filter((r) => r.coverage.toLowerCase().startsWith('partial')).length} partial
                  </span>
                  <span className="text-red-600">
                    {traceability.filter((r) => r.coverage.toLowerCase().startsWith('missing')).length} missing
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Regression Checklist ──────────────────────────── */}
          {activeTab === 'regression' && (
            <div className="flex-1 min-h-0 rounded-lg border border-slate-200 dark:border-slate-700 p-4 overflow-auto">
              {regressionSection ? (
                <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
                  <RegressionMarkdown content={regressionSection} />
                </div>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No regression checklist found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Full Output ───────────────────────────────────── */}
          {activeTab === 'output' && (
            <div className="flex-1 min-h-0 overflow-auto">
              <RefinableMarkdown
                text={stage.output}
                onSectionRefined={(updated) => {
                  usePipelineStore.getState().setStageOutput(stageIndex, updated);
                }}
                onRefineRequest={onRefineRequest}
              />
            </div>
          )}

          </div>{/* end scrollable tab content */}
        </div>
      )}
    </div>
  );
}

// ─── Regression Markdown Renderer ─────────────────────────────────

// ─── Gherkin Syntax Viewer ──────────────────────────────────────

function GherkinViewer({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <pre className="p-4 text-[12px] font-mono leading-relaxed">
      {lines.map((line, i) => {
        const trimmed = line.trimStart();
        let cls = 'text-slate-400'; // default

        if (/^#/.test(trimmed)) cls = 'text-slate-500 italic';
        else if (/^@/.test(trimmed)) cls = 'text-amber-400';
        else if (/^Feature:/.test(trimmed)) cls = 'text-blue-400 font-bold';
        else if (/^Scenario Outline:/.test(trimmed)) cls = 'text-purple-400 font-semibold';
        else if (/^Scenario:/.test(trimmed)) cls = 'text-purple-400 font-semibold';
        else if (/^Background:/.test(trimmed)) cls = 'text-cyan-400 font-semibold';
        else if (/^Examples:/.test(trimmed)) cls = 'text-cyan-400 font-semibold';
        else if (/^\s*(Given|When|Then|And|But)\s/.test(line)) cls = 'text-green-400';
        else if (/^\|/.test(trimmed)) cls = 'text-slate-300';

        return (
          <div key={i} className="flex">
            <span className="w-8 text-right text-slate-600 select-none mr-4 shrink-0">{i + 1}</span>
            <span className={cls}>{line || '\u00A0'}</span>
          </div>
        );
      })}
    </pre>
  );
}

function RegressionMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');

  return (
    <div className="space-y-3">
      {lines.map((line, i) => {
        const headingMatch = line.match(/^###\s+(.+)/);
        if (headingMatch) {
          return (
            <h4 key={i} className="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-3 first:mt-0">
              {headingMatch[1]}
            </h4>
          );
        }

        const checkMatch = line.match(/^-\s+\[([ x])\]\s+(.+)/);
        if (checkMatch) {
          const checked = checkMatch[1] === 'x';
          return (
            <label key={i} className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-400 cursor-default">
              <input
                type="checkbox"
                checked={checked}
                readOnly
                className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-primary-600"
              />
              <span>{checkMatch[2]}</span>
            </label>
          );
        }

        if (line.trim() === '') return null;

        return (
          <p key={i} className="text-[11px] text-slate-500 dark:text-slate-400">
            {line}
          </p>
        );
      })}
    </div>
  );
}
