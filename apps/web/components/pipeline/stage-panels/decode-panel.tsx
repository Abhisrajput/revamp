'use client';

import { useState } from 'react';
import { Play, Brain, Eye, Target, Sparkles, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StageOutput } from '@/components/pipeline/stage-output';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { AgentBotGrid } from '@/components/pipeline/agent-bot-grid';
import { useStagePanel } from '@/lib/hooks/use-stage-panel';
import { cn } from '@/lib/utils';
import { DynamicStageTabs } from './dynamic-stage-tabs';
import { getStageTabConfig } from './stage-tab-configs';
import type { StagePanelProps } from './types';

// ─── Pre-execution dimensions ────────────────────────────────────

const DECODE_DIMENSIONS = [
  { key: 'businessRules', label: 'Business Rules', icon: Target, color: 'text-blue-500' },
  { key: 'workflows', label: 'Workflows', icon: Sparkles, color: 'text-purple-500' },
  { key: 'dataModels', label: 'Data Models', icon: Brain, color: 'text-green-500' },
  { key: 'integrations', label: 'Integrations', icon: AlertTriangle, color: 'text-orange-500' },
];

// ─── Component ───────────────────────────────────────────────────

export default function DecodePanel({
  stage,
  stageIndex,
  project,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest,
}: StagePanelProps) {
  const { logs, isRunning, hasOutput, canRun } = useStagePanel(stage, stageIndex, streamingText, isExecuting);
  const [deepAnalysis, setDeepAnalysis] = useState(project?.deep_analysis ?? false);

  const tabConfig = getStageTabConfig('DECODE');

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                    Intent Extraction Mode
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Deep analysis examines every file for hidden business logic — takes longer but produces more thorough results.
                  </p>
                </div>
                <button
                  onClick={() => setDeepAnalysis(!deepAnalysis)}
                  className={cn(
                    'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                    deepAnalysis ? 'bg-primary-600' : 'bg-slate-300 dark:bg-slate-600',
                  )}
                >
                  <span className={cn(
                    'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                    deepAnalysis ? 'translate-x-6' : 'translate-x-1',
                  )} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <Eye className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs text-slate-500">
                  {deepAnalysis ? 'Deep analysis enabled — every file will be analyzed' : 'Standard analysis — focuses on key entry points'}
                </span>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3">
            {DECODE_DIMENSIONS.map(({ key, label, icon: Icon, color }) => (
              <Card key={key} className="bg-slate-50 dark:bg-slate-900">
                <CardContent className="p-3">
                  <div className="flex items-center gap-2">
                    <Icon className={cn('w-4 h-4', color)} />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                    Will be extracted from legacy code
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          {canRun && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Extract Business Intent
              </Button>
            </div>
          )}
        </>
      )}

      {/* During execution — show one bot per planned subtask */}
      {isRunning && (
        <>
          <AgentBotGrid
            subtasks={stage.subtasks}
            overallProgress={stage.subtaskProgress}
            isExecuting={isExecuting}
            message="Extracting business intent..."
            subtitle="Director and specialists are analyzing the codebase"
          />
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Decode Activity" />}
        </>
      )}

      {/* After execution — Dynamic Tabs */}
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
