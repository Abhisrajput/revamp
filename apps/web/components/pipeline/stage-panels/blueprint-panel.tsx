'use client';

import { Play, Map } from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { Card, CardContent } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { AgentBotGrid } from '@/components/pipeline/agent-bot-grid';
import { useStagePanel } from '@revamp/core/hooks/use-stage-panel';
import { DynamicStageTabs } from './dynamic-stage-tabs';
import { getStageTabConfig } from './stage-tab-configs';
import type { StagePanelProps } from './types';

// ─── Component ────────────────────────────────────────────────────

export default function BlueprintPanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest,
}: StagePanelProps) {
  const { isRunning, hasOutput, canRun: canExecute } = useStagePanel(stage, stageIndex, streamingText, isExecuting);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Map className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Business Capability Blueprint
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Maps DECODE business capabilities into bounded contexts with service boundaries,
                data ownership, and phased migration waves. Every capability traces to business
                rules (BR-IDs) for SPEC_LOCK coverage.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant="outline" className="text-[10px]">Capability Inventory</Badge>
                <Badge variant="outline" className="text-[10px]">Bounded Contexts</Badge>
                <Badge variant="outline" className="text-[10px]">Migration Waves</Badge>
                <Badge variant="outline" className="text-[10px]">Mermaid Diagrams</Badge>
              </div>
            </CardContent>
          </Card>

          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Mine Business Capabilities
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
            message="Mapping bounded contexts..."
            subtitle="Building capability map and migration waves"
          />
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {/* Activity logs shown in Bottom Dock Terminal tab */}
        </>
      )}

      {/* After execution — Dynamic Tabs */}
      {stage.output && !isRunning && (
        <DynamicStageTabs
          output={stage.output}
          stageIndex={stageIndex}
          config={getStageTabConfig('BLUEPRINT')}
          onRefineRequest={onRefineRequest}
        />
      )}
    </div>
  );
}
