'use client';

import { useState, useMemo } from 'react';
import { Play, FileCheck, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// --- Gherkin Parser ---

interface GherkinScenario {
  feature: string;
  scenario: string;
  steps: string[];
  tags: string[];
}

function extractGherkinScenarios(text: string): GherkinScenario[] {
  const scenarios: GherkinScenario[] = [];
  const featureBlocks = text.split(/(?=Feature:)/);

  for (const block of featureBlocks) {
    const featureMatch = block.match(/Feature:\s*(.+)/);
    if (!featureMatch) continue;
    const featureName = featureMatch[1].trim();

    const scenarioRegex = /(?:@[\w-]+\s*)*Scenario(?:\s+Outline)?:\s*(.+?)(?=\n(?:Scenario|Feature:|$))/gs;
    let match;
    while ((match = scenarioRegex.exec(block)) !== null) {
      const fullBlock = match[0];
      const scenarioName = match[1].trim();

      // Extract tags
      const tagMatches = fullBlock.match(/@[\w-]+/g) || [];

      // Extract steps
      const steps = fullBlock
        .split('\n')
        .filter((line) => /^\s*(Given|When|Then|And|But)\s/.test(line))
        .map((line) => line.trim());

      scenarios.push({
        feature: featureName,
        scenario: scenarioName,
        steps,
        tags: tagMatches,
      });
    }
  }

  return scenarios;
}

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
  const [activeTab, setActiveTab] = useState<'scenarios' | 'output'>('scenarios');
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  const scenarios = useMemo(() => {
    if (!stage.output) return [];
    return extractGherkinScenarios(stage.output);
  }, [stage.output]);

  // Group scenarios by feature
  const featureGroups = useMemo(() => {
    const groups = new Map<string, GherkinScenario[]>();
    for (const s of scenarios) {
      const existing = groups.get(s.feature) || [];
      existing.push(s);
      groups.set(s.feature, existing);
    }
    return groups;
  }, [scenarios]);

  return (
    <div className="space-y-4">
      {/* Pre-execution */}
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
                Captures behavioral requirements as BDD/Gherkin scenarios and acceptance criteria.
                These specs become the behavioral contract between legacy and modernized systems.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant="outline" className="text-[10px]">Gherkin Scenarios</Badge>
                <Badge variant="outline" className="text-[10px]">Acceptance Criteria</Badge>
                <Badge variant="outline" className="text-[10px]">Edge Cases</Badge>
                <Badge variant="outline" className="text-[10px]">Data Contracts</Badge>
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

      {/* During execution */}
      {isRunning && (
        <>
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Spec Lock Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
            <button
              onClick={() => setActiveTab('scenarios')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                activeTab === 'scenarios'
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700',
              )}
            >
              <BookOpen className="w-3.5 h-3.5" />
              Scenarios ({scenarios.length})
            </button>
            <button
              onClick={() => setActiveTab('output')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                activeTab === 'output'
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700',
              )}
            >
              <FileCheck className="w-3.5 h-3.5" />
              Full Output
            </button>
          </div>

          {/* Scenario Viewer */}
          {activeTab === 'scenarios' && (
            <div className="space-y-4">
              {scenarios.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-6">
                  No Gherkin scenarios detected in output
                </p>
              ) : (
                Array.from(featureGroups.entries()).map(([feature, featureScenarios]) => (
                  <Card key={feature} className="bg-slate-50 dark:bg-slate-900 overflow-hidden">
                    <div className="px-4 py-2 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                      <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                        Feature: {feature}
                      </h4>
                    </div>
                    <CardContent className="p-0 divide-y divide-slate-200 dark:divide-slate-700">
                      {featureScenarios.map((scenario, idx) => (
                        <div key={idx} className="px-4 py-3">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-medium text-slate-900 dark:text-slate-50">
                              Scenario: {scenario.scenario}
                            </span>
                            {scenario.tags.map((tag) => (
                              <Badge key={tag} variant="outline" className="text-[9px] px-1 py-0">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          <div className="space-y-1 font-mono">
                            {scenario.steps.map((step, stepIdx) => {
                              const keyword = step.split(' ')[0];
                              const rest = step.slice(keyword.length);
                              const keywordColor =
                                keyword === 'Given' ? 'text-blue-500' :
                                keyword === 'When' ? 'text-yellow-500' :
                                keyword === 'Then' ? 'text-green-500' :
                                'text-slate-400';
                              return (
                                <p key={stepIdx} className="text-[11px] text-slate-600 dark:text-slate-400">
                                  <span className={cn('font-semibold', keywordColor)}>{keyword}</span>
                                  {rest}
                                </p>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))
              )}
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
