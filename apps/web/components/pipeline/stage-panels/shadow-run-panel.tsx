'use client';

import { useState, useMemo } from 'react';
import {
  Play, Eye, BarChart3, CheckCircle, XCircle,
  ArrowLeftRight, Timer, Zap, Shield,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { InlineConfidence } from '@/components/pipeline/confidence-gauge';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// --- Comparison metric ---

interface ComparisonMetric {
  name: string;
  legacy: string;
  modern: string;
  status: 'pass' | 'fail' | 'warn';
  icon: typeof CheckCircle;
}

function extractComparisonMetrics(text: string): ComparisonMetric[] {
  // This is a heuristic parser — real data would come from structured API response
  const metrics: ComparisonMetric[] = [];

  const patterns = [
    { name: 'Functional Equivalence', regex: /functional\s*equivalence.*?(\d+)%/i },
    { name: 'API Compatibility', regex: /api\s*compatibility.*?(\d+)%/i },
    { name: 'Data Integrity', regex: /data\s*integrity.*?(\d+)%/i },
    { name: 'Performance', regex: /performance.*?(\d+)%/i },
    { name: 'Error Handling', regex: /error\s*handling.*?(\d+)%/i },
  ];

  for (const { name, regex } of patterns) {
    const match = text.match(regex);
    if (match) {
      const pct = parseInt(match[1], 10);
      metrics.push({
        name,
        legacy: 'Baseline',
        modern: `${pct}% match`,
        status: pct >= 95 ? 'pass' : pct >= 80 ? 'warn' : 'fail',
        icon: pct >= 95 ? CheckCircle : pct >= 80 ? Zap : XCircle,
      });
    }
  }

  return metrics;
}

// --- Cutover Readiness Checklist ---

interface CutoverItem {
  id: string;
  label: string;
  description: string;
}

const CUTOVER_CHECKLIST: CutoverItem[] = [
  {
    id: 'bdd-pass',
    label: 'All BDD scenarios pass in parallel run',
    description: 'Every behavior-driven test runs successfully against both legacy and modern systems.',
  },
  {
    id: 'perf-metrics',
    label: 'Performance metrics within acceptable range',
    description: 'Latency, throughput, and resource utilization meet or exceed baseline benchmarks.',
  },
  {
    id: 'data-migration',
    label: 'Data migration validated',
    description: 'All data has been migrated and verified for correctness, completeness, and consistency.',
  },
  {
    id: 'rollback-plan',
    label: 'Rollback plan documented',
    description: 'A tested rollback procedure is in place in case of critical issues post-cutover.',
  },
  {
    id: 'stakeholder-signoff',
    label: 'Stakeholder sign-off received',
    description: 'Business owners and technical leads have approved the cutover readiness report.',
  },
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
  const [activeTab, setActiveTab] = useState<'comparison' | 'tests' | 'checklist' | 'output'>('comparison');
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  const allChecked = CUTOVER_CHECKLIST.every((item) => checkedItems.has(item.id));

  const toggleChecked = (id: string) => {
    setCheckedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const metrics = useMemo(() => {
    if (!stage.output) return [];
    return extractComparisonMetrics(stage.output);
  }, [stage.output]);

  return (
    <div className="space-y-4">
      {/* Pre-execution */}
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
                Runs legacy and modern systems in parallel, comparing outputs for behavioral equivalence.
                Validates that the modernized code produces identical results under test scenarios.
              </p>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div className="flex flex-col items-center p-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <ArrowLeftRight className="w-4 h-4 text-blue-500" />
                  <span className="text-[10px] text-slate-500 mt-1">I/O Comparison</span>
                </div>
                <div className="flex flex-col items-center p-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <Timer className="w-4 h-4 text-orange-500" />
                  <span className="text-[10px] text-slate-500 mt-1">Performance Delta</span>
                </div>
                <div className="flex flex-col items-center p-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <Shield className="w-4 h-4 text-green-500" />
                  <span className="text-[10px] text-slate-500 mt-1">Cutover Readiness</span>
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

      {/* During execution */}
      {isRunning && (
        <>
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Shadow Run Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
            {[
              { key: 'comparison', label: 'Comparison', icon: ArrowLeftRight },
              { key: 'tests', label: 'Test Results', icon: BarChart3 },
              { key: 'checklist', label: 'Cutover Readiness', icon: Shield },
              { key: 'output', label: 'Full Output', icon: Eye },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key as any)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                  activeTab === key
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Comparison Matrix */}
          {activeTab === 'comparison' && (
            <div className="space-y-2">
              {metrics.length > 0 ? (
                metrics.map((metric) => {
                  const StatusIcon = metric.icon;
                  return (
                    <Card key={metric.name} className="bg-slate-50 dark:bg-slate-900">
                      <CardContent className="p-3 flex items-center gap-3">
                        <StatusIcon className={cn(
                          'w-4 h-4 shrink-0',
                          metric.status === 'pass' ? 'text-green-500' :
                          metric.status === 'warn' ? 'text-yellow-500' :
                          'text-red-500',
                        )} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                              {metric.name}
                            </span>
                            <Badge variant="outline" className={cn(
                              'text-[10px]',
                              metric.status === 'pass' ? 'border-green-300 text-green-600' :
                              metric.status === 'warn' ? 'border-yellow-300 text-yellow-600' :
                              'border-red-300 text-red-600',
                            )}>
                              {metric.modern}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4 text-[10px] text-slate-500">
                            <span>Legacy: {metric.legacy}</span>
                            <span>Modern: {metric.modern}</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              ) : (
                <p className="text-sm text-slate-500 text-center py-6">
                  No comparison metrics detected in output
                </p>
              )}
            </div>
          )}

          {/* Test Results */}
          {activeTab === 'tests' && (
            <div>
              {stage.validation?.criteria ? (
                <div className="space-y-2">
                  {stage.validation.criteria.map((criterion) => (
                    <Card key={criterion.name} className="bg-slate-50 dark:bg-slate-900">
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                            {criterion.name}
                          </span>
                          {criterion.passed ? (
                            <Badge className="bg-green-100 text-green-700 text-[10px] border-transparent">Pass</Badge>
                          ) : (
                            <Badge className="bg-red-100 text-red-700 text-[10px] border-transparent">Fail</Badge>
                          )}
                        </div>
                        <InlineConfidence score={criterion.score * 100} />
                        <p className="text-[10px] text-slate-500 mt-1">{criterion.feedback}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500 text-center py-6">
                  No test results available
                </p>
              )}
            </div>
          )}

          {/* Cutover Readiness Checklist */}
          {activeTab === 'checklist' && (
            <div className="space-y-3">
              <Card className="bg-slate-50 dark:bg-slate-900">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="w-4 h-4 text-slate-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                      Cutover Readiness Checklist
                    </h3>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                    All items must be verified before proceeding with cutover.
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-green-500 transition-all duration-300"
                        style={{ width: `${(checkedItems.size / CUTOVER_CHECKLIST.length) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-500 tabular-nums shrink-0">
                      {checkedItems.size}/{CUTOVER_CHECKLIST.length}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {CUTOVER_CHECKLIST.map((item) => {
                const isChecked = checkedItems.has(item.id);
                return (
                  <Card
                    key={item.id}
                    className={cn(
                      'transition-colors cursor-pointer',
                      isChecked
                        ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
                        : 'bg-white dark:bg-slate-900',
                    )}
                    onClick={() => toggleChecked(item.id)}
                  >
                    <CardContent className="p-3 flex items-start gap-3">
                      <div className={cn(
                        'w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors',
                        isChecked
                          ? 'bg-green-500 border-green-500'
                          : 'border-slate-300 dark:border-slate-600',
                      )}>
                        {isChecked && (
                          <CheckCircle className="w-3.5 h-3.5 text-white" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className={cn(
                          'text-sm font-medium',
                          isChecked
                            ? 'text-green-700 dark:text-green-400'
                            : 'text-slate-700 dark:text-slate-300',
                        )}>
                          {item.label}
                        </span>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          {item.description}
                        </p>
                      </div>
                      {isChecked && (
                        <Badge className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[10px] border-transparent shrink-0">
                          Verified
                        </Badge>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              {/* Complete Stage Button */}
              <div className="pt-2 flex justify-center">
                <Button
                  size="lg"
                  disabled={!allChecked}
                  onClick={() => {
                    if (_onApprove && allChecked) {
                      _onApprove('All cutover readiness items verified');
                    }
                  }}
                  className={cn(
                    'gap-2 transition-all',
                    allChecked ? '' : 'opacity-60',
                  )}
                >
                  <CheckCircle className="w-4 h-4" />
                  {allChecked ? 'Complete Stage — Ready for Cutover' : `${CUTOVER_CHECKLIST.length - checkedItems.size} items remaining`}
                </Button>
              </div>
            </div>
          )}

          {/* Full Output */}
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
