'use client';

import { useState, useMemo } from 'react';
import {
  Play, Eye, CheckCircle, XCircle, AlertTriangle,
  ArrowLeftRight, Timer, Shield, BarChart3,
  TrendingUp, TrendingDown, Minus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// ─── Parsers ──────────────────────────────────────────────────────

interface TestMatrixRow {
  index: number;
  scenario: string;
  tags: string;
  legacyResult: string;
  modernResult: string;
  match: 'MATCH' | 'DEVIATION' | 'REGRESSION' | 'IMPROVEMENT';
  duration: string;
  notes: string;
}

interface DeviationDetail {
  id: string;
  scenario: string;
  severity: 'BLOCKING' | 'Critical' | 'Warning' | 'Info';
  aspect: string;
  legacyValue: string;
  modernValue: string;
  rootCause: string;
  fix: string;
}

interface PerformanceRow {
  operation: string;
  legacyLatency: string;
  modernLatency: string;
  delta: string;
  status: 'FASTER' | 'SLOWER' | 'SAME';
}

interface DeviationSummaryRow {
  index: number;
  deviation: string;
  severity: string;
  category: string;
  rootCause: string;
  fixEffort: string;
  blocking: boolean;
}

interface CutoverVerdict {
  verdict: 'GO' | 'NO-GO' | 'NO-GO WITH CONDITIONS';
  totalScenarios: number;
  matchCount: number;
  deviationCount: number;
  regressionCount: number;
  improvementCount: number;
  blockingIssues: number;
  confidenceScore: number;
  rawSection: string;
}

/** Extract section between heading and next heading */
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

function extractTestMatrix(text: string): TestMatrixRow[] {
  const rows: TestMatrixRow[] = [];
  const section = extractSection(text, 'Test Matrix');
  if (!section) return rows;

  const lines = section.split('\n').filter((line) =>
    /^\|/.test(line) && !/^[\s|:-]+$/.test(line) && !/^\|\s*#\s*\|/.test(line)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 7) continue;

    const idx = parseInt(cells[0].replace(/\D+/g, ''), 10);
    if (isNaN(idx) && !cells[0]) continue;

    const matchStr = cells[5].toUpperCase();
    const match: TestMatrixRow['match'] =
      matchStr.includes('REGRESSION') ? 'REGRESSION' :
      matchStr.includes('DEVIATION') ? 'DEVIATION' :
      matchStr.includes('IMPROVEMENT') ? 'IMPROVEMENT' : 'MATCH';

    rows.push({
      index: idx || rows.length + 1,
      scenario: cells[1],
      tags: cells[2],
      legacyResult: cells[3],
      modernResult: cells[4],
      match,
      duration: cells[6],
      notes: cells[7] || '—',
    });
  }

  return rows;
}

function extractDeviationDetails(text: string): DeviationDetail[] {
  const details: DeviationDetail[] = [];
  const section = extractSection(text, 'Behavioral Comparison');
  if (!section) return details;

  // Split by ### DEVIATION or ### REGRESSION headings
  const blocks = section.split(/(?=###\s+(?:DEVIATION|REGRESSION)\s)/);

  for (const block of blocks) {
    const headingMatch = block.match(/###\s+(?:DEVIATION|REGRESSION)\s+#?(\d+):?\s*(.+)/);
    if (!headingMatch) continue;

    const id = headingMatch[1];
    const scenario = headingMatch[2].trim();
    const severityMatch = block.match(/\*\*Severity:\*\*\s*(\w+)/i);
    const severity = severityMatch ? severityMatch[1].toUpperCase() : 'Warning';

    // Parse table rows
    const tableRows = block.split('\n').filter((line) =>
      /^\|/.test(line) && !/^[\s|:-]+$/.test(line) && !/^\|\s*Aspect\s*\|/.test(line)
    );

    let legacyValue = '';
    let modernValue = '';
    let rootCause = '';
    let fix = '';

    for (const row of tableRows) {
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 3) continue;

      const aspect = cells[0].toLowerCase();
      if (aspect.includes('actual output') || aspect.includes('expected output')) {
        legacyValue = cells[1];
        modernValue = cells[2];
      } else if (aspect.includes('root cause')) {
        rootCause = cells[1] + (cells[2] ? ` → ${cells[2]}` : '');
      } else if (aspect.includes('fix')) {
        fix = cells[1] + (cells[2] ? ` → ${cells[2]}` : '');
      }
    }

    // Fallback: extract from non-table format
    if (!rootCause) {
      const rcMatch = block.match(/\*\*Root Cause\*\*:?\s*(.+)/i);
      if (rcMatch) rootCause = rcMatch[1].trim();
    }
    if (!fix) {
      const fixMatch = block.match(/\*\*Fix (?:Required)?\*\*:?\s*(.+)/i);
      if (fixMatch) fix = fixMatch[1].trim();
    }

    details.push({
      id,
      scenario,
      severity: severity === 'BLOCKING' ? 'BLOCKING' : severity === 'CRITICAL' ? 'Critical' : severity === 'INFO' ? 'Info' : 'Warning',
      aspect: scenario,
      legacyValue,
      modernValue,
      rootCause,
      fix,
    });
  }

  return details;
}

function extractPerformance(text: string): PerformanceRow[] {
  const rows: PerformanceRow[] = [];
  const section = extractSection(text, 'Performance Comparison');
  if (!section) return rows;

  const lines = section.split('\n').filter((line) =>
    /^\|/.test(line) && !/^[\s|:-]+$/.test(line) && !/^\|\s*Operation\s*\|/.test(line)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;

    const statusStr = cells[4]?.toUpperCase() || '';
    const status: PerformanceRow['status'] =
      statusStr.includes('SLOWER') ? 'SLOWER' :
      statusStr.includes('FASTER') ? 'FASTER' : 'SAME';

    rows.push({
      operation: cells[0],
      legacyLatency: cells[1],
      modernLatency: cells[2],
      delta: cells[3],
      status,
    });
  }

  return rows;
}

function extractDeviationSummary(text: string): DeviationSummaryRow[] {
  const rows: DeviationSummaryRow[] = [];
  const section = extractSection(text, 'Deviation Analysis');
  if (!section) return rows;

  const lines = section.split('\n').filter((line) =>
    /^\|/.test(line) && !/^[\s|:-]+$/.test(line) && !/^\|\s*#\s*\|/.test(line)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 6) continue;

    const idx = parseInt(cells[0].replace(/\D+/g, ''), 10);
    if (isNaN(idx) && !cells[0]) continue;

    const blockingStr = cells[6]?.toUpperCase() || cells[5]?.toUpperCase() || '';
    rows.push({
      index: idx || rows.length + 1,
      deviation: cells[1],
      severity: cells[2],
      category: cells[3],
      rootCause: cells[4],
      fixEffort: cells[5],
      blocking: blockingStr.includes('YES'),
    });
  }

  return rows;
}

function extractCutoverVerdict(text: string): CutoverVerdict | null {
  const section = extractSection(text, 'Cutover Verdict');
  if (!section) return null;

  const verdictMatch = section.match(/\*\*\s*(GO|NO-GO(?:\s*WITH CONDITIONS)?)\s*\*\*/i);
  const verdict = verdictMatch
    ? verdictMatch[1].toUpperCase().includes('WITH') ? 'NO-GO WITH CONDITIONS'
      : verdictMatch[1].toUpperCase().includes('NO') ? 'NO-GO' : 'GO'
    : 'NO-GO';

  const confidenceMatch = section.match(/Confidence\s*(?:Score)?:?\s*(\d+)/i);
  const confidence = confidenceMatch ? parseInt(confidenceMatch[1], 10) : 0;

  const scenariosMatch = section.match(/Scenarios\s*tested:?\s*(\d+)/i);
  const matchMatch = section.match(/MATCH:?\s*(\d+)/i);
  const devMatch = section.match(/DEVIATION:?\s*(\d+)/i);
  const regMatch = section.match(/REGRESSION:?\s*(\d+)/i);
  const impMatch = section.match(/IMPROVEMENT:?\s*(\d+)/i);
  const blockingMatch = section.match(/Blocking\s*issues?:?\s*(\d+)/i);

  return {
    verdict,
    totalScenarios: scenariosMatch ? parseInt(scenariosMatch[1], 10) : 0,
    matchCount: matchMatch ? parseInt(matchMatch[1], 10) : 0,
    deviationCount: devMatch ? parseInt(devMatch[1], 10) : 0,
    regressionCount: regMatch ? parseInt(regMatch[1], 10) : 0,
    improvementCount: impMatch ? parseInt(impMatch[1], 10) : 0,
    blockingIssues: blockingMatch ? parseInt(blockingMatch[1], 10) : 0,
    confidenceScore: confidence,
    rawSection: section,
  };
}

// ─── Component ────────────────────────────────────────────────────

type TabKey = 'matrix' | 'comparison' | 'performance' | 'deviations' | 'verdict' | 'output';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Eye }> = [
  { key: 'matrix', label: 'Test Matrix', icon: BarChart3 },
  { key: 'comparison', label: 'Behavioral Diff', icon: ArrowLeftRight },
  { key: 'performance', label: 'Performance', icon: Timer },
  { key: 'deviations', label: 'Deviations', icon: AlertTriangle },
  { key: 'verdict', label: 'Cutover Verdict', icon: Shield },
  { key: 'output', label: 'Full Output', icon: Eye },
];

export default function ShadowRunPanel({
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
  const [activeTab, setActiveTab] = useState<TabKey>('matrix');
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  // ─── Parse output ──────────────────────────────────────────────
  const testMatrix = useMemo(() => stage.output ? extractTestMatrix(stage.output) : [], [stage.output]);
  const deviationDetails = useMemo(() => stage.output ? extractDeviationDetails(stage.output) : [], [stage.output]);
  const performance = useMemo(() => stage.output ? extractPerformance(stage.output) : [], [stage.output]);
  const deviationSummary = useMemo(() => stage.output ? extractDeviationSummary(stage.output) : [], [stage.output]);
  const verdict = useMemo(() => stage.output ? extractCutoverVerdict(stage.output) : null, [stage.output]);

  // ─── Derived stats ─────────────────────────────────────────────
  const matchCount = testMatrix.filter((r) => r.match === 'MATCH').length;
  const devCount = testMatrix.filter((r) => r.match === 'DEVIATION').length;
  const regCount = testMatrix.filter((r) => r.match === 'REGRESSION').length;
  const impCount = testMatrix.filter((r) => r.match === 'IMPROVEMENT').length;
  const matchRate = testMatrix.length > 0 ? Math.round((matchCount / testMatrix.length) * 100) : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Pre-execution ────────────────────────────────────────── */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Eye className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Shadow Run — Parallel Validation
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Simulates every SPEC_LOCK BDD scenario against both the legacy system and FORGE-generated
                modernized code. Compares outputs field-by-field to detect deviations, regressions, and
                performance deltas. Produces a GO/NO-GO cutover recommendation.
              </p>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div className="flex flex-col items-center p-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <ArrowLeftRight className="w-4 h-4 text-blue-500" />
                  <span className="text-[10px] text-slate-500 mt-1">Per-Scenario Diff</span>
                </div>
                <div className="flex flex-col items-center p-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <Timer className="w-4 h-4 text-orange-500" />
                  <span className="text-[10px] text-slate-500 mt-1">Latency Comparison</span>
                </div>
                <div className="flex flex-col items-center p-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <Shield className="w-4 h-4 text-green-500" />
                  <span className="text-[10px] text-slate-500 mt-1">GO / NO-GO Verdict</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Start Shadow Run
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── During execution ─────────────────────────────────────── */}
      {isRunning && (
        <>
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Shadow Run Activity" />}
        </>
      )}

      {/* ── After execution ──────────────────────────────────────── */}
      {stage.output && !isRunning && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Stats Bar — sticky */}
          <div className="flex-shrink-0 flex items-center justify-between bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <BarChart3 className="w-3.5 h-3.5" />
                {testMatrix.length} scenarios tested
              </span>
              <span className="flex items-center gap-1.5 text-emerald-600 font-medium">
                <CheckCircle className="w-3.5 h-3.5" />
                {matchCount} match
              </span>
              {devCount > 0 && (
                <span className="flex items-center gap-1.5 text-amber-600 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {devCount} deviation
                </span>
              )}
              {regCount > 0 && (
                <span className="flex items-center gap-1.5 text-red-600 font-medium">
                  <XCircle className="w-3.5 h-3.5" />
                  {regCount} regression
                </span>
              )}
              {impCount > 0 && (
                <span className="flex items-center gap-1.5 text-blue-600 font-medium">
                  <TrendingUp className="w-3.5 h-3.5" />
                  {impCount} improvement
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {verdict && (
                <Badge className={cn(
                  'text-[10px] font-bold',
                  verdict.verdict === 'GO'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                )}>
                  {verdict.verdict}
                </Badge>
              )}
              <Badge className={cn(
                'text-[10px]',
                matchRate >= 90 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                  : matchRate >= 70 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
              )}>
                {matchRate}% match rate
              </Badge>
              {verdict && verdict.confidenceScore > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {verdict.confidenceScore}/100 confidence
                </Badge>
              )}
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
                {key === 'deviations' && (devCount + regCount) > 0 && (
                  <span className="text-[9px] ml-0.5 opacity-70">({devCount + regCount})</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 min-h-0 overflow-auto p-4">

          {/* ── Tab: Test Matrix ───────────────────────────────────── */}
          {activeTab === 'matrix' && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {testMatrix.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold w-8">#</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Scenario</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Tags</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Legacy</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Modern</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Match</th>
                      <th className="text-right py-2 px-3 text-slate-500 font-semibold">Duration</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testMatrix.map((r) => (
                      <tr key={r.index} className={cn(
                        'border-b border-slate-100 dark:border-slate-800',
                        r.match === 'REGRESSION' && 'bg-red-50/50 dark:bg-red-950/20',
                        r.match === 'DEVIATION' && 'bg-amber-50/50 dark:bg-amber-950/10',
                        r.match === 'IMPROVEMENT' && 'bg-blue-50/50 dark:bg-blue-950/10',
                      )}>
                        <td className="py-1.5 px-3 text-slate-400 font-mono">{r.index}</td>
                        <td className="py-1.5 px-3 font-medium text-slate-900 dark:text-slate-50">{r.scenario}</td>
                        <td className="py-1.5 px-3">
                          <div className="flex flex-wrap gap-1">
                            {r.tags.split(/\s+/).filter(Boolean).map((tag) => (
                              <Badge key={tag} variant="outline" className="text-[8px] px-1 py-0">{tag}</Badge>
                            ))}
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-center text-[10px] font-mono">{r.legacyResult}</td>
                        <td className="py-1.5 px-3 text-center text-[10px] font-mono">{r.modernResult}</td>
                        <td className="py-1.5 px-3 text-center">
                          <MatchBadge match={r.match} />
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-slate-400 text-[10px]">{r.duration}</td>
                        <td className="py-1.5 px-3 text-slate-500 max-w-[200px] truncate text-[10px]">
                          {r.match !== 'MATCH' ? (
                            <span className={r.match === 'REGRESSION' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}>
                              {r.notes}
                            </span>
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600">{r.notes}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No test matrix data found in output
                </div>
              )}
              {testMatrix.length > 0 && (
                <div className="sticky bottom-0 bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-500 flex items-center gap-3">
                  <span className="font-semibold">{testMatrix.length} scenarios</span>
                  <span className="text-emerald-600">{matchCount} MATCH</span>
                  {devCount > 0 && <span className="text-amber-600">{devCount} DEVIATION</span>}
                  {regCount > 0 && <span className="text-red-600">{regCount} REGRESSION</span>}
                  {impCount > 0 && <span className="text-blue-600">{impCount} IMPROVEMENT</span>}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Behavioral Comparison ──────────────────────────── */}
          {activeTab === 'comparison' && (
            <div className="space-y-3">
              {deviationDetails.length > 0 ? (
                deviationDetails.map((d) => (
                  <Card key={d.id} className={cn(
                    'overflow-hidden',
                    d.severity === 'BLOCKING' || d.severity === 'Critical' ? 'border-red-200 dark:border-red-800' : 'border-amber-200 dark:border-amber-800',
                  )}>
                    <div className={cn(
                      'px-4 py-2 border-b flex items-center gap-2',
                      d.severity === 'BLOCKING' || d.severity === 'Critical'
                        ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
                        : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800',
                    )}>
                      <Badge className={cn(
                        'text-[9px] px-1.5',
                        d.severity === 'BLOCKING' || d.severity === 'Critical'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                      )}>
                        {d.severity}
                      </Badge>
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                        #{d.id}: {d.scenario}
                      </span>
                    </div>
                    <CardContent className="p-3 space-y-2">
                      {(d.legacyValue || d.modernValue) && (
                        <div className="grid grid-cols-2 gap-2">
                          <div className="bg-slate-50 dark:bg-slate-800 rounded p-2">
                            <p className="text-[9px] font-semibold text-slate-500 uppercase mb-1">Legacy Output</p>
                            <p className="text-[11px] text-slate-700 dark:text-slate-300 font-mono">{d.legacyValue || '—'}</p>
                          </div>
                          <div className="bg-slate-50 dark:bg-slate-800 rounded p-2">
                            <p className="text-[9px] font-semibold text-slate-500 uppercase mb-1">Modern Output</p>
                            <p className="text-[11px] text-slate-700 dark:text-slate-300 font-mono">{d.modernValue || '—'}</p>
                          </div>
                        </div>
                      )}
                      {d.rootCause && (
                        <p className="text-[11px] text-slate-500">
                          <span className="font-semibold text-slate-600 dark:text-slate-300">Root Cause:</span> {d.rootCause}
                        </p>
                      )}
                      {d.fix && (
                        <p className="text-[11px] text-slate-500">
                          <span className="font-semibold text-slate-600 dark:text-slate-300">Fix:</span>{' '}
                          <span className="font-mono text-primary-600 dark:text-primary-400">{d.fix}</span>
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  {testMatrix.length > 0 && matchCount === testMatrix.length
                    ? 'All scenarios match — no behavioral diffs'
                    : 'No behavioral comparison data found in output'}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Performance ────────────────────────────────────── */}
          {activeTab === 'performance' && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {performance.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Operation</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Legacy (p50/p95/p99)</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Modern (p50/p95/p99)</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Delta</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performance.map((r, i) => (
                      <tr key={i} className={cn(
                        'border-b border-slate-100 dark:border-slate-800',
                        r.status === 'SLOWER' && 'bg-red-50/30 dark:bg-red-950/10',
                      )}>
                        <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-50">{r.operation}</td>
                        <td className="py-2 px-3 text-center font-mono text-slate-500">{r.legacyLatency}</td>
                        <td className="py-2 px-3 text-center font-mono text-slate-500">{r.modernLatency}</td>
                        <td className="py-2 px-3 text-center font-mono font-medium">
                          <span className={cn(
                            r.status === 'FASTER' ? 'text-emerald-600' :
                            r.status === 'SLOWER' ? 'text-red-600' : 'text-slate-500',
                          )}>
                            {r.delta}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-center">
                          <Badge className={cn(
                            'text-[9px] px-1.5 gap-0.5',
                            r.status === 'FASTER' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
                            r.status === 'SLOWER' && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                            r.status === 'SAME' && 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
                          )}>
                            {r.status === 'FASTER' && <TrendingUp className="w-2.5 h-2.5" />}
                            {r.status === 'SLOWER' && <TrendingDown className="w-2.5 h-2.5" />}
                            {r.status === 'SAME' && <Minus className="w-2.5 h-2.5" />}
                            {r.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No performance comparison data found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Deviations ─────────────────────────────────────── */}
          {activeTab === 'deviations' && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {deviationSummary.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold w-8">#</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Deviation</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Severity</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Category</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Root Cause</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Fix Effort</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Blocking</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deviationSummary.map((d) => (
                      <tr key={d.index} className={cn(
                        'border-b border-slate-100 dark:border-slate-800',
                        d.blocking && 'bg-red-50/50 dark:bg-red-950/20',
                      )}>
                        <td className="py-1.5 px-3 text-slate-400 font-mono">{d.index}</td>
                        <td className="py-1.5 px-3 font-medium text-slate-900 dark:text-slate-50">{d.deviation}</td>
                        <td className="py-1.5 px-3 text-center">
                          <Badge className={cn(
                            'text-[9px] px-1.5',
                            d.severity.toLowerCase().includes('critical') && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                            d.severity.toLowerCase().includes('warning') && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                            d.severity.toLowerCase().includes('info') && 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
                          )}>
                            {d.severity}
                          </Badge>
                        </td>
                        <td className="py-1.5 px-3 text-slate-500">{d.category}</td>
                        <td className="py-1.5 px-3 text-slate-500 max-w-[200px] truncate">{d.rootCause}</td>
                        <td className="py-1.5 px-3 text-center font-mono text-slate-500">{d.fixEffort}</td>
                        <td className="py-1.5 px-3 text-center">
                          {d.blocking ? (
                            <Badge className="bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 text-[9px]">YES</Badge>
                          ) : (
                            <span className="text-slate-300 dark:text-slate-600 text-[10px]">No</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  {matchCount === testMatrix.length && testMatrix.length > 0
                    ? 'No deviations — all scenarios match'
                    : 'No deviation analysis found in output'}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Cutover Verdict ───────────────────────────────── */}
          {activeTab === 'verdict' && (
            <div className="space-y-4">
              {verdict ? (
                <>
                  {/* Verdict banner */}
                  <Card className={cn(
                    'overflow-hidden',
                    verdict.verdict === 'GO'
                      ? 'border-emerald-300 dark:border-emerald-700'
                      : 'border-red-300 dark:border-red-700',
                  )}>
                    <div className={cn(
                      'px-6 py-4 text-center',
                      verdict.verdict === 'GO'
                        ? 'bg-emerald-50 dark:bg-emerald-950/20'
                        : 'bg-red-50 dark:bg-red-950/20',
                    )}>
                      <div className="flex items-center justify-center gap-3 mb-2">
                        {verdict.verdict === 'GO' ? (
                          <CheckCircle className="w-8 h-8 text-emerald-500" />
                        ) : (
                          <XCircle className="w-8 h-8 text-red-500" />
                        )}
                        <span className={cn(
                          'text-2xl font-bold',
                          verdict.verdict === 'GO' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
                        )}>
                          {verdict.verdict}
                        </span>
                      </div>
                      {verdict.confidenceScore > 0 && (
                        <p className="text-sm text-slate-600 dark:text-slate-400">
                          Confidence: <span className="font-bold">{verdict.confidenceScore}/100</span>
                        </p>
                      )}
                    </div>
                  </Card>

                  {/* Summary metrics */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    <MetricCard label="Scenarios" value={verdict.totalScenarios || testMatrix.length} color="slate" />
                    <MetricCard label="MATCH" value={verdict.matchCount || matchCount} color="emerald" />
                    <MetricCard label="DEVIATION" value={verdict.deviationCount || devCount} color="amber" />
                    <MetricCard label="REGRESSION" value={verdict.regressionCount || regCount} color="red" />
                    <MetricCard label="Blocking" value={verdict.blockingIssues} color={verdict.blockingIssues > 0 ? 'red' : 'emerald'} />
                  </div>

                  {/* Raw verdict section */}
                  <Card className="bg-slate-50 dark:bg-slate-900">
                    <CardContent className="p-4">
                      <RenderVerdictMarkdown content={verdict.rawSection} />
                    </CardContent>
                  </Card>

                  {/* Approve/Reject for GO verdicts */}
                  {verdict.verdict === 'GO' && (
                    <div className="flex justify-center pt-2">
                      <Button
                        size="lg"
                        onClick={() => _onApprove?.('Shadow Run passed — GO verdict')}
                        className="gap-2 bg-emerald-600 hover:bg-emerald-700"
                      >
                        <CheckCircle className="w-4 h-4" />
                        Approve Cutover — Ready for EVOLVE
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No cutover verdict found in output
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

          </div>{/* end scrollable tab content */}
        </div>
      )}
    </div>
  );
}

// ─── Helper Components ────────────────────────────────────────────

function MatchBadge({ match }: { match: TestMatrixRow['match'] }) {
  const config = {
    MATCH: { class: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400', icon: CheckCircle },
    DEVIATION: { class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400', icon: AlertTriangle },
    REGRESSION: { class: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400', icon: XCircle },
    IMPROVEMENT: { class: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400', icon: TrendingUp },
  };
  const c = config[match];
  const Icon = c.icon;
  return (
    <Badge className={cn('text-[9px] px-1.5 gap-0.5', c.class)}>
      <Icon className="w-2.5 h-2.5" />
      {match}
    </Badge>
  );
}

function MetricCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colorClasses: Record<string, string> = {
    slate: 'text-slate-700 dark:text-slate-300',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
    blue: 'text-blue-600 dark:text-blue-400',
  };

  return (
    <div className="bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-3 text-center">
      <p className={cn('text-xl font-bold tabular-nums', colorClasses[color] || colorClasses.slate)}>
        {value}
      </p>
      <p className="text-[10px] text-slate-500 uppercase font-medium">{label}</p>
    </div>
  );
}

function RenderVerdictMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        if (line.match(/^\*\*.*\*\*$/)) {
          return <p key={i} className="text-xs font-bold text-slate-700 dark:text-slate-300 mt-2">{line.replace(/\*\*/g, '')}</p>;
        }
        if (line.match(/^\d+\./)) {
          return <p key={i} className="text-[11px] text-slate-600 dark:text-slate-400 pl-2">{line}</p>;
        }
        if (line.match(/^-\s/)) {
          return <p key={i} className="text-[11px] text-slate-600 dark:text-slate-400 pl-4">{line}</p>;
        }
        if (line.trim() === '') return null;
        return <p key={i} className="text-[11px] text-slate-600 dark:text-slate-400">{line}</p>;
      })}
    </div>
  );
}
