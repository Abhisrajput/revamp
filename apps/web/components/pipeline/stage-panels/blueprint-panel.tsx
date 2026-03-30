'use client';

import { useState, useMemo } from 'react';
import {
  Play, Map, Layers, Link2, GitBranch, Table2,
} from 'lucide-react';
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

// ─── Parsers ──────────────────────────────────────────────────────

interface CapabilityRow {
  id: string;
  capability: string;
  domain: string;
  currentModules: string;
  businessRules: string;
  dataEntities: string;
  complexity: string;
  priority: string;
}

interface MigrationWave {
  wave: string;
  timeline: string;
  services: string;
  dependencies: string;
  risk: string;
  criteria: string;
}

interface BoundaryDecision {
  decision: string;
  boundary: string;
  rationale: string;
  tradeoff: string;
}

function extractMermaidBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^#{1,3}\\s*${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$)`, 'im');
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

function extractCapabilities(text: string): CapabilityRow[] {
  const section = extractSection(text, 'Capability Inventory');
  if (!section) return [];

  const rows: CapabilityRow[] = [];
  const lines = section.split('\n').filter((l) =>
    /^\|/.test(l) && !/^[\s|:-]+$/.test(l) && !/^\|\s*ID\s*\|/.test(l)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 7) continue;
    rows.push({
      id: cells[0],
      capability: cells[1],
      domain: cells[2],
      currentModules: cells[3],
      businessRules: cells[4],
      dataEntities: cells[5],
      complexity: cells[6],
      priority: cells[7] || '',
    });
  }
  return rows;
}

function extractWaves(text: string): MigrationWave[] {
  const section = extractSection(text, 'Migration Waves');
  if (!section) return [];

  const rows: MigrationWave[] = [];
  const lines = section.split('\n').filter((l) =>
    /^\|/.test(l) && !/^[\s|:-]+$/.test(l) && !/^\|\s*Wave\s*\|/.test(l)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;
    rows.push({
      wave: cells[0],
      timeline: cells[1],
      services: cells[2],
      dependencies: cells[3],
      risk: cells[4],
      criteria: cells[5] || '',
    });
  }
  return rows;
}

function extractDecisions(text: string): BoundaryDecision[] {
  const section = extractSection(text, 'Service Boundary Decisions');
  if (!section) return [];

  const rows: BoundaryDecision[] = [];
  const lines = section.split('\n').filter((l) =>
    /^\|/.test(l) && !/^[\s|:-]+$/.test(l) && !/^\|\s*Decision\s*\|/.test(l)
  );

  for (const line of lines) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    rows.push({
      decision: cells[0],
      boundary: cells[1],
      rationale: cells[2],
      tradeoff: cells[3] || '',
    });
  }
  return rows;
}

// ─── Component ────────────────────────────────────────────────────

type TabKey = 'capabilities' | 'contexts' | 'waves' | 'diagrams' | 'output';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Map }> = [
  { key: 'capabilities', label: 'Capabilities', icon: Table2 },
  { key: 'contexts', label: 'Bounded Contexts', icon: Layers },
  { key: 'waves', label: 'Migration Waves', icon: GitBranch },
  { key: 'diagrams', label: 'Diagrams', icon: Map },
  { key: 'output', label: 'Full Output', icon: Link2 },
];

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
  const [activeTab, setActiveTab] = useState<TabKey>('capabilities');
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  const diagrams = useMemo(() => stage.output ? extractMermaidBlocks(stage.output) : [], [stage.output]);
  const capabilities = useMemo(() => stage.output ? extractCapabilities(stage.output) : [], [stage.output]);
  const waves = useMemo(() => stage.output ? extractWaves(stage.output) : [], [stage.output]);
  const decisions = useMemo(() => stage.output ? extractDecisions(stage.output) : [], [stage.output]);
  const contextsSection = useMemo(() => stage.output ? extractSection(stage.output, 'Bounded Contexts') : null, [stage.output]);

  const domains = useMemo(() => [...new Set(capabilities.map((c) => c.domain))], [capabilities]);

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
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Blueprint Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <>
          {/* Stats Bar */}
          <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <Table2 className="w-3.5 h-3.5" />
                {capabilities.length} capabilities
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <Layers className="w-3.5 h-3.5" />
                {domains.length} domains
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <GitBranch className="w-3.5 h-3.5" />
                {waves.length} migration waves
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <Map className="w-3.5 h-3.5" />
                {diagrams.length} diagrams
              </span>
            </div>
          </div>

          {/* Tab Bar */}
          <div className="flex gap-0.5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
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
              </button>
            ))}
          </div>

          {/* ── Tab: Capabilities ──────────────────────────────────── */}
          {activeTab === 'capabilities' && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto" style={{ maxHeight: '460px' }}>
              {capabilities.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">ID</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Capability</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Domain</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Rules</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Entities</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Complexity</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {capabilities.map((c, i) => (
                      <tr key={i} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="py-1.5 px-3 font-mono text-primary-600 dark:text-primary-400 font-semibold">{c.id}</td>
                        <td className="py-1.5 px-3 font-medium text-slate-900 dark:text-slate-50">{c.capability}</td>
                        <td className="py-1.5 px-3 text-slate-500">{c.domain}</td>
                        <td className="py-1.5 px-3 font-mono text-[10px] text-slate-500">{c.businessRules}</td>
                        <td className="py-1.5 px-3 text-slate-500 text-[10px]">{c.dataEntities}</td>
                        <td className="py-1.5 px-3 text-center">
                          <Badge className={cn('text-[9px] px-1.5',
                            c.complexity.toLowerCase().includes('high') && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                            c.complexity.toLowerCase().includes('medium') && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                            c.complexity.toLowerCase().includes('low') && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
                          )}>{c.complexity}</Badge>
                        </td>
                        <td className="py-1.5 px-3 text-center">
                          <Badge variant="outline" className="text-[9px]">{c.priority}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No capability inventory found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Bounded Contexts ──────────────────────────────── */}
          {activeTab === 'contexts' && (
            <div className="space-y-3 max-h-[460px] overflow-auto">
              {contextsSection ? (
                <>
                  {decisions.length > 0 && (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto mb-3">
                      <table className="w-full text-[11px]">
                        <thead className="bg-slate-50 dark:bg-slate-800">
                          <tr className="border-b border-slate-200 dark:border-slate-700">
                            <th className="text-left py-2 px-3 text-slate-500 font-semibold">Decision</th>
                            <th className="text-left py-2 px-3 text-slate-500 font-semibold">Boundary</th>
                            <th className="text-left py-2 px-3 text-slate-500 font-semibold">Rationale</th>
                            <th className="text-left py-2 px-3 text-slate-500 font-semibold">Tradeoff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {decisions.map((d, i) => (
                            <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                              <td className="py-1.5 px-3 font-medium text-slate-900 dark:text-slate-50">{d.decision}</td>
                              <td className="py-1.5 px-3 font-mono text-[10px] text-primary-600">{d.boundary}</td>
                              <td className="py-1.5 px-3 text-slate-500">{d.rationale}</td>
                              <td className="py-1.5 px-3 text-slate-500">{d.tradeoff}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <RefinableMarkdown
                    text={`## Bounded Contexts\n\n${contextsSection}`}
                    onSectionRefined={(updated) => {
                      usePipelineStore.getState().setStageOutput(stageIndex, updated);
                    }}
                    onRefineRequest={onRefineRequest}
                  />
                </>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No bounded context definitions found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Migration Waves ───────────────────────────────── */}
          {activeTab === 'waves' && (
            <div className="space-y-3">
              {waves.length > 0 ? (
                waves.map((w, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-primary-100 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400 text-[10px] font-mono">{w.wave}</Badge>
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{w.services}</span>
                      </div>
                      <Badge variant="outline" className="text-[10px]">{w.timeline}</Badge>
                    </div>
                    <CardContent className="p-3 space-y-1.5">
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Dependencies:</span> {w.dependencies}
                      </p>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Risk:</span>{' '}
                        <Badge className={cn('text-[9px] px-1.5',
                          w.risk.toLowerCase().includes('high') && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                          w.risk.toLowerCase().includes('medium') && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                          w.risk.toLowerCase().includes('low') && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
                        )}>{w.risk}</Badge>
                      </p>
                      {w.criteria && (
                        <p className="text-[11px] text-slate-600 dark:text-slate-400">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">Go/No-Go:</span> {w.criteria}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No migration waves found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Diagrams ──────────────────────────────────────── */}
          {activeTab === 'diagrams' && (
            <div className="space-y-3">
              {diagrams.length > 0 ? (
                diagrams.map((chart, i) => (
                  <MermaidDiagram key={i} chart={chart} filename={`blueprint-diagram-${i + 1}`} />
                ))
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No Mermaid diagrams found in output
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
        </>
      )}
    </div>
  );
}
