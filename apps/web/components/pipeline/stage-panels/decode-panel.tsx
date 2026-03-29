'use client';

import { useState } from 'react';
import { Play, Brain, Eye, Lightbulb, Target, Sparkles, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge as _Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { BreeOutputTab } from '@/components/pipeline/bree-output-tab';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { SubtaskProgressList } from '@/components/pipeline/subtask-progress-list';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// --- Extraction dimensions ---

const DECODE_DIMENSIONS = [
  { key: 'businessRules', label: 'Business Rules', icon: Target, color: 'text-blue-500' },
  { key: 'workflows', label: 'Workflows', icon: Sparkles, color: 'text-purple-500' },
  { key: 'dataModels', label: 'Data Models', icon: Brain, color: 'text-green-500' },
  { key: 'integrations', label: 'Integrations', icon: Lightbulb, color: 'text-orange-500' },
];

export default function DecodePanel({
  stage,
  stageIndex,
  project,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const setStageDraft = usePipelineStore((s) => s.setStageDraft);
  const stageDrafts = usePipelineStore((s) => s.stageDrafts);
  const stages = usePipelineStore((s) => s.stages);
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);
  const deepAnalysis = (stageDrafts?.['DECODE']?.deepAnalysis as boolean) ?? project?.deep_analysis ?? false;

  return (
    <div className="space-y-4">
      {/* Pre-execution: options */}
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
                  onClick={() => setStageDraft('DECODE', 'deepAnalysis', !deepAnalysis)}
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

          {/* Extraction Dimensions Preview */}
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

          {/* Execute */}
          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Extract Business Intent
              </Button>
            </div>
          )}
        </>
      )}

      {/* During execution */}
      {isRunning && (
        <>
          <SubtaskProgressList />
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Decode Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <DecodeOutputWithBree
          output={stage.output}
          onRefineRequest={onRefineRequest}
        />
      )}
    </div>
  );
}

function DecodeOutputWithBree({ output, onRefineRequest }: { output: string; onRefineRequest?: any }) {
  const [tab, setTab] = useState<'output' | 'bree'>('output');

  return (
    <>
      <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
        <button
          onClick={() => setTab('output')}
          className={cn(
            'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            tab === 'output'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
          )}
        >
          Stage Output
        </button>
        <button
          onClick={() => setTab('bree')}
          className={cn(
            'px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5',
            tab === 'bree'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
          )}
        >
          <Cpu className="w-3 h-3" />
          BREE Analysis
        </button>
      </div>

      {tab === 'output' && (
        <RefinableMarkdown
          text={output}
          onSectionRefined={(updated) => {
            usePipelineStore.getState().setStageOutput(1, updated);
          }}
          onRefineRequest={onRefineRequest}
        />
      )}

      {tab === 'bree' && (
        <BreeOutputTab stageName="DECODE" />
      )}
    </>
  );
}
