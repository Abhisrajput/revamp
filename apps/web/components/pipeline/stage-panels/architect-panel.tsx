'use client';

import { Play, Building2 } from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { Card, CardContent } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { AgentBotGrid } from '@/components/pipeline/agent-bot-grid';
import { useStagePanel } from '@/lib/hooks/use-stage-panel';
import { DynamicStageTabs } from './dynamic-stage-tabs';
import { getStageTabConfig } from './stage-tab-configs';
import type { StagePanelProps } from './types';

export default function ArchitectPanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest,
  project,
}: StagePanelProps) {
  const { logs, isRunning, hasOutput, canRun: canExecute } = useStagePanel(stage, stageIndex, streamingText, isExecuting);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Building2 className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Architecture Design
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Designs the target architecture with technology decision matrix, phased migration
                roadmap with BDD-based go/no-go gates, risk register, and concrete cost model
                for {project?.target_cloud?.toUpperCase() || 'your cloud provider'}.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant="outline" className="text-[10px]">Component Inventory</Badge>
                <Badge variant="outline" className="text-[10px]">Tech Decision Matrix</Badge>
                <Badge variant="outline" className="text-[10px]">Migration Roadmap</Badge>
                <Badge variant="outline" className="text-[10px]">Risk Register</Badge>
                <Badge variant="outline" className="text-[10px]">Cost Model</Badge>
              </div>
            </CardContent>
          </Card>

          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Design Architecture
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
            isExecuting={isExecuting}
            message="Designing target architecture..."
            subtitle="Choosing patterns and infrastructure"
          />
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Architect Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <DynamicStageTabs
          output={stage.output}
          stageIndex={stageIndex}
          config={getStageTabConfig('ARCHITECT')}
          onRefineRequest={onRefineRequest}
        />
      )}
    </div>
  );
}
