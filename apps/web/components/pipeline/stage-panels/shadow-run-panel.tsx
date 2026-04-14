'use client';

import { Play, Eye, ArrowLeftRight, Timer, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StageOutput } from '@/components/pipeline/stage-output';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { AgentBotGrid } from '@/components/pipeline/agent-bot-grid';
import { useStagePanel } from '@/lib/hooks/use-stage-panel';
import { DynamicStageTabs } from './dynamic-stage-tabs';
import { getStageTabConfig } from './stage-tab-configs';
import type { StagePanelProps } from './types';

export default function ShadowRunPanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest,
}: StagePanelProps) {
  const { logs, isRunning, hasOutput, canRun: canExecute } = useStagePanel(stage, stageIndex, streamingText, isExecuting);

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
          <AgentBotGrid
            subtasks={stage.subtasks}
            overallProgress={stage.subtaskProgress}
            isExecuting={isExecuting}
            message="Running parallel validation..."
            subtitle="Comparing legacy vs modern outputs"
          />
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Shadow Run Activity" />}
        </>
      )}

      {/* ── After execution ──────────────────────────────────────── */}
      {stage.output && !isRunning && (
        <DynamicStageTabs
          output={stage.output}
          stageIndex={stageIndex}
          config={getStageTabConfig('SHADOW_RUN')}
          onRefineRequest={onRefineRequest}
        />
      )}
    </div>
  );
}
