'use client';

import { useState, useMemo } from 'react';
import {
  Play, Building2, GitCompare, BarChart3, Cpu,
  Cloud, Shield, Zap, Scale,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { MermaidDiagram } from '@/components/pipeline/mermaid-diagram';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// --- Extract mermaid ---

function extractMermaidBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

// --- Architecture section detection ---

function extractSection(text: string, heading: string): string | null {
  const regex = new RegExp(`##\\s+${heading}[\\s\\S]*?(?=\\n##\\s|$)`, 'i');
  const match = text.match(regex);
  return match ? match[0] : null;
}

export default function ArchitectPanel({
  stage,
  stageIndex,
  project,
  streamingText,
  onExecute,
  onApprove: _onApprove,
  onReject: _onReject,
  isExecuting,
  onRefineRequest,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);
  const [activeTab, setActiveTab] = useState<'architecture' | 'strategy' | 'tradeoffs' | 'output'>('architecture');
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  const diagrams = useMemo(() => {
    if (!stage.output) return [];
    return extractMermaidBlocks(stage.output);
  }, [stage.output]);

  const tabs = [
    { key: 'architecture', label: 'Architecture', icon: Building2 },
    { key: 'strategy', label: 'Migration Strategy', icon: GitCompare },
    { key: 'tradeoffs', label: 'Tradeoffs', icon: Scale },
    { key: 'output', label: 'Full Output', icon: BarChart3 },
  ] as const;

  const architectureQualities = [
    { icon: Zap, label: 'Performance', color: 'text-yellow-500' },
    { icon: Shield, label: 'Security', color: 'text-green-500' },
    { icon: Cloud, label: 'Scalability', color: 'text-blue-500' },
    { icon: Cpu, label: 'Maintainability', color: 'text-purple-500' },
  ];

  return (
    <div className="space-y-4">
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
                Design target architecture with technology selection, migration roadmap,
                and tradeoff analysis. Cloud-specific deployment architecture for{' '}
                {project?.target_cloud?.toUpperCase() || 'your cloud provider'}.
              </p>
              <div className="grid grid-cols-4 gap-2 mt-3">
                {architectureQualities.map(({ icon: Icon, label, color }) => (
                  <div key={label} className="flex flex-col items-center p-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                    <Icon className={cn('w-4 h-4', color)} />
                    <span className="text-[10px] text-slate-500 mt-1">{label}</span>
                  </div>
                ))}
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
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Architect Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors',
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

          {/* Architecture Diagrams */}
          {activeTab === 'architecture' && (
            <div className="space-y-3">
              {diagrams.length > 0 ? (
                diagrams.map((chart, i) => (
                  <MermaidDiagram
                    key={i}
                    chart={chart}
                    filename={`architecture-${i + 1}`}
                  />
                ))
              ) : (
                <Card className="bg-slate-50 dark:bg-slate-900">
                  <CardContent className="p-6 text-center">
                    <Building2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <p className="text-sm text-slate-500">No architecture diagrams found</p>
                    <p className="text-xs text-slate-400 mt-1">
                      Switch to Full Output to see the complete analysis
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Migration Strategy */}
          {activeTab === 'strategy' && (
            <div>
              {(() => {
                const strategySection = extractSection(stage.output, 'Migration Strategy|Migration Roadmap|Migration Plan');
                return strategySection ? (
                  <RefinableMarkdown
                    text={strategySection}
                    onSectionRefined={(updated) => {
                      // Re-integrate section into full output
                      const fullOutput = stage.output!.replace(strategySection, updated);
                      usePipelineStore.getState().setStageOutput(stageIndex, fullOutput);
                    }}
                    onRefineRequest={onRefineRequest}
                  />
                ) : (
                  <RefinableMarkdown
                    text={stage.output}
                    onSectionRefined={(updated) => {
                      usePipelineStore.getState().setStageOutput(stageIndex, updated);
                    }}
                    onRefineRequest={onRefineRequest}
                  />
                );
              })()}
            </div>
          )}

          {/* Tradeoffs */}
          {activeTab === 'tradeoffs' && (
            <div>
              {(() => {
                const tradeoffSection = extractSection(stage.output, 'Tradeoffs|Trade-offs|Considerations');
                return tradeoffSection ? (
                  <RefinableMarkdown
                    text={tradeoffSection}
                    onSectionRefined={(updated) => {
                      const fullOutput = stage.output!.replace(tradeoffSection, updated);
                      usePipelineStore.getState().setStageOutput(stageIndex, fullOutput);
                    }}
                    onRefineRequest={onRefineRequest}
                  />
                ) : (
                  <RefinableMarkdown
                    text={stage.output}
                    onSectionRefined={(updated) => {
                      usePipelineStore.getState().setStageOutput(stageIndex, updated);
                    }}
                    onRefineRequest={onRefineRequest}
                  />
                );
              })()}
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
