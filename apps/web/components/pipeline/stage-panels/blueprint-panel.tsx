'use client';

import { useState, useMemo } from 'react';
import { Play, Map, Layers, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { MermaidDiagram } from '@/components/pipeline/mermaid-diagram';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// --- Mermaid Extraction ---

function extractMermaidBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

export default function BlueprintPanel({
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
  const [activeTab, setActiveTab] = useState<'map' | 'dependencies' | 'output'>('map');
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  // Extract mermaid diagrams from output
  const diagrams = useMemo(() => {
    if (!stage.output) return [];
    return extractMermaidBlocks(stage.output);
  }, [stage.output]);

  const tabs = [
    { key: 'map', label: 'Capability Map', icon: Map },
    { key: 'dependencies', label: 'Dependencies', icon: Link2 },
    { key: 'output', label: 'Full Output', icon: Layers },
  ] as const;

  return (
    <div className="space-y-4">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Map className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Business Capability Mining
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                This stage maps business capabilities to system components, identifies service boundaries,
                and creates a dependency visualization for migration waves.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant="outline" className="text-[10px]">Capability Mapping</Badge>
                <Badge variant="outline" className="text-[10px]">Service Boundaries</Badge>
                <Badge variant="outline" className="text-[10px]">Dependency Analysis</Badge>
                <Badge variant="outline" className="text-[10px]">Migration Waves</Badge>
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
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Blueprint Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2',
                  activeTab === key
                    ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          {activeTab === 'map' && (
            <div className="space-y-3">
              {diagrams.length > 0 ? (
                diagrams.map((chart, i) => (
                  <MermaidDiagram
                    key={i}
                    chart={chart}
                    filename={`capability-map-${i + 1}`}
                  />
                ))
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-6">
                  No capability diagrams found in output
                </p>
              )}
            </div>
          )}

          {activeTab === 'dependencies' && (
            <div className="space-y-3">
              {diagrams.length > 1 ? (
                <MermaidDiagram chart={diagrams[diagrams.length - 1]} filename="dependency-graph" />
              ) : diagrams.length === 1 ? (
                <MermaidDiagram chart={diagrams[0]} filename="dependency-graph" />
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-6">
                  No dependency diagrams found
                </p>
              )}
            </div>
          )}

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
