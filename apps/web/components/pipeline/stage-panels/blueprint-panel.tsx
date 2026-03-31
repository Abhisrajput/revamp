'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Play, Map, Layers, Link2, GitBranch, Table2, Maximize2, X,
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

interface NamedDiagram {
  name: string;
  chart: string;
}

function extractNamedDiagrams(text: string): NamedDiagram[] {
  const diagrams: NamedDiagram[] = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    const headingMatch = before.match(/(?:^|\n)(#{1,4})\s+[\d.]*\s*(.*?)\s*$/);
    const name = headingMatch
      ? headingMatch[2].replace(/\(Mermaid\)/i, '').replace(/\*+/g, '').trim()
      : `Diagram ${diagrams.length + 1}`;
    diagrams.push({ name, chart: match[1].trim() });
  }
  return diagrams;
}

// ─── Popout Modal ───────────────────────────────────────────────

function DiagramModal({ diagram, onClose }: { diagram: NamedDiagram; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-[96vw] h-[94vh] bg-slate-950 rounded-xl border border-slate-700 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2 bg-gradient-to-b from-slate-950/90 to-transparent pointer-events-none">
          <span className="text-xs font-semibold text-slate-300 pointer-events-auto">{diagram.name}</span>
          <button
            onClick={onClose}
            className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-900/80 hover:bg-slate-800 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Close
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <MermaidDiagram
            chart={diagram.chart}
            filename={diagram.name.toLowerCase().replace(/\s+/g, '-')}
            fillHeight
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Extract a markdown section including all its sub-headings (stops at same or higher level). */
function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingMatch = new RegExp(`(?:^|\\n)(#{1,3})\\s*(?:\\d+\\.?\\s*)?${escaped}[^\\n]*\\n`, 'i').exec(text);
  if (!headingMatch) return null;

  const level = headingMatch[1].length;
  const startIndex = headingMatch.index + headingMatch[0].length;
  const endPattern = new RegExp(`\\n#{1,${level}}\\s`);
  const endMatch = endPattern.exec(text.slice(startIndex));
  const content = endMatch
    ? text.slice(startIndex, startIndex + endMatch.index)
    : text.slice(startIndex);
  return content.trim() || null;
}

/** Parse a markdown table with header-aware column mapping. */
function parseTable(section: string, columnAliases: Record<string, string[]>): Record<string, string>[] {
  const tableLines = section.split('\n').filter((l) => /^\|/.test(l));
  if (tableLines.length < 2) return [];

  // First pipe-row is the header
  const headerCells = tableLines[0].split('|').map((c) => c.trim().toLowerCase().replace(/\*+/g, '')).filter(Boolean);

  // Build column index map using aliases
  const colMap: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(columnAliases)) {
    const idx = headerCells.findIndex((h) => aliases.some((a) => h.includes(a)));
    if (idx !== -1) colMap[field] = idx;
  }

  const rows: Record<string, string>[] = [];
  for (const line of tableLines.slice(1)) {
    if (/^[\s|:-]+$/.test(line)) continue; // separator row
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    const row: Record<string, string> = {};
    for (const [field, idx] of Object.entries(colMap)) {
      row[field] = cells[idx] ?? '';
    }
    if (Object.values(row).some(Boolean)) rows.push(row);
  }
  return rows;
}

function extractCapabilities(text: string): CapabilityRow[] {
  const section = extractSection(text, 'Capability Inventory');
  if (!section) return [];
  return parseTable(section, {
    id: ['id'],
    capability: ['capability', 'name'],
    domain: ['domain', 'context'],
    currentModules: ['module', 'current'],
    businessRules: ['rule', 'br-'],
    dataEntities: ['entit', 'data'],
    complexity: ['complex'],
    priority: ['priori'],
  }) as unknown as CapabilityRow[];
}

function extractWaves(text: string): MigrationWave[] {
  const section = extractSection(text, 'Migration Waves');
  if (!section) return [];
  return parseTable(section, {
    wave: ['wave'],
    timeline: ['timeline', 'time', 'week', 'sprint'],
    services: ['service', 'name'],
    dependencies: ['depend', 'objective', 'prerequisite'],
    risk: ['risk'],
    criteria: ['criteria', 'go/no-go', 'success'],
  }) as unknown as MigrationWave[];
}

interface BoundedContext {
  name: string;
  canonicalName: string;
  capabilities: string;
  entities: string[];
  apiSurface: string[];
  eventsPublished: string[];
  eventsConsumed: string[];
  dataStore: string;
  team: string;
  sla: string;
  dependencies: string;
}

function extractBoundedContexts(text: string): BoundedContext[] {
  const section = extractSection(text, 'Bounded Contexts');
  if (!section) return [];

  // Split by ### Context headings
  const contextBlocks = section.split(/\n(?=###\s+Context\s)/i).filter((b) => /^###\s+Context/i.test(b));

  return contextBlocks.map((block) => {
    const nameMatch = block.match(/^###\s+(?:Context\s*\d+:\s*)?(.+)/i);
    const field = (label: string) => {
      const re = new RegExp(`\\*\\*${label}[:\\*]*\\*?\\*?\\s*(.+)`, 'i');
      const m = block.match(re);
      return m ? m[1].replace(/`/g, '').trim() : '';
    };
    const listAfter = (label: string): string[] => {
      const re = new RegExp(`\\*\\*${label}[^*]*\\*\\*[:\\s]*\\n([\\s\\S]*?)(?=\\n\\*\\*|$)`, 'i');
      const m = block.match(re);
      if (!m) return [];
      return m[1].split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').replace(/`/g, '').trim()).filter(Boolean);
    };

    return {
      name: nameMatch ? nameMatch[1].trim() : 'Unknown',
      canonicalName: field('Canonical Name'),
      capabilities: field('Capabilities'),
      entities: listAfter('Owned Entities'),
      apiSurface: listAfter('API Surface'),
      eventsPublished: listAfter('Events Published'),
      eventsConsumed: listAfter('Events Consumed'),
      dataStore: field('Data Store'),
      team: field('Team'),
      sla: field('SLA'),
      dependencies: field('Cross-Context Dependencies'),
    };
  });
}

function extractDecisions(text: string): BoundaryDecision[] {
  const section = extractSection(text, 'Service Boundary Decisions');
  if (!section) return [];
  return parseTable(section, {
    decision: ['decision'],
    boundary: ['boundary'],
    rationale: ['rationale', 'reason'],
    tradeoff: ['tradeoff', 'trade-off'],
  }) as unknown as BoundaryDecision[];
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
  const [activeDiagramIdx, setActiveDiagramIdx] = useState(0);
  const [popoutDiagram, setPopoutDiagram] = useState<NamedDiagram | null>(null);
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  const diagrams = useMemo(() => stage.output ? extractNamedDiagrams(stage.output) : [], [stage.output]);
  const handlePopout = useCallback((d: NamedDiagram) => setPopoutDiagram(d), []);
  const capabilities = useMemo(() => stage.output ? extractCapabilities(stage.output) : [], [stage.output]);
  const waves = useMemo(() => stage.output ? extractWaves(stage.output) : [], [stage.output]);
  const decisions = useMemo(() => stage.output ? extractDecisions(stage.output) : [], [stage.output]);
  const boundedContexts = useMemo(() => stage.output ? extractBoundedContexts(stage.output) : [], [stage.output]);


  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Popout modal */}
      {popoutDiagram && <DiagramModal diagram={popoutDiagram} onClose={() => setPopoutDiagram(null)} />}

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
        <div className="flex flex-col flex-1 min-h-0">
          {/* Stats Bar — sticky */}
          <div className="flex-shrink-0 flex items-center justify-between bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <Table2 className="w-3.5 h-3.5" />
                {capabilities.length} capabilities
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <Layers className="w-3.5 h-3.5" />
                {boundedContexts.length} contexts
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

          {/* Tab Bar — sticky */}
          <div className="flex-shrink-0 flex gap-0.5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
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

          {/* Tab content — scrollable */}
          <div className="flex-1 min-h-0 overflow-auto p-4">

          {/* ── Tab: Capabilities ──────────────────────────────────── */}
          {activeTab === 'capabilities' && (
            <div className="flex-1 min-h-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
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
            <div className="flex-1 min-h-0 overflow-auto space-y-3">
              {boundedContexts.length > 0 ? (
                <>
                  {/* Service Boundary Decisions table */}
                  {decisions.length > 0 && (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
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

                  {/* Context cards */}
                  {boundedContexts.map((ctx, i) => (
                    <Card key={i} className="overflow-hidden">
                      <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge className="bg-primary-100 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400 text-[10px] font-mono">{ctx.canonicalName || `context-${i + 1}`}</Badge>
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{ctx.name}</span>
                        </div>
                        {ctx.capabilities && (
                          <span className="text-[10px] font-mono text-slate-400">{ctx.capabilities}</span>
                        )}
                      </div>
                      <CardContent className="p-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[11px]">
                        {/* Owned Entities */}
                        {ctx.entities.length > 0 && (
                          <div>
                            <h5 className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Owned Entities</h5>
                            <ul className="space-y-0.5">
                              {ctx.entities.map((e, j) => (
                                <li key={j} className="text-slate-500 font-mono text-[10px]">{e}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* API Surface */}
                        {ctx.apiSurface.length > 0 && (
                          <div>
                            <h5 className="font-semibold text-slate-700 dark:text-slate-300 mb-1">API Surface</h5>
                            <ul className="space-y-0.5">
                              {ctx.apiSurface.map((a, j) => (
                                <li key={j} className="text-slate-500 font-mono text-[10px] truncate" title={a}>{a}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Events Published */}
                        {ctx.eventsPublished.length > 0 && (
                          <div>
                            <h5 className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Events Published</h5>
                            <div className="flex flex-wrap gap-1">
                              {ctx.eventsPublished.map((e, j) => (
                                <Badge key={j} variant="outline" className="text-[9px] font-mono">{e.split('(')[0].trim()}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Events Consumed */}
                        {ctx.eventsConsumed.length > 0 && (
                          <div>
                            <h5 className="font-semibold text-slate-700 dark:text-slate-300 mb-1">Events Consumed</h5>
                            <div className="flex flex-wrap gap-1">
                              {ctx.eventsConsumed.map((e, j) => (
                                <Badge key={j} variant="outline" className="text-[9px] font-mono bg-amber-50 dark:bg-amber-900/10">{e.split('(')[0].trim()}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Data Store + Team + SLA row */}
                        <div className="col-span-2 flex flex-wrap gap-x-6 gap-y-1 pt-2 border-t border-slate-100 dark:border-slate-800">
                          {ctx.dataStore && (
                            <p className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">Data Store:</span> {ctx.dataStore}</p>
                          )}
                          {ctx.team && (
                            <p className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">Team:</span> {ctx.team}</p>
                          )}
                          {ctx.sla && (
                            <p className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">SLA:</span> {ctx.sla}</p>
                          )}
                          {ctx.dependencies && (
                            <p className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">Dependencies:</span> {ctx.dependencies}</p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
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
            <div className="flex-1 min-h-0 space-y-3 overflow-auto">
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
                      <div className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Risk:</span>{' '}
                        <Badge className={cn('text-[9px] px-1.5',
                          w.risk.toLowerCase().includes('high') && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                          w.risk.toLowerCase().includes('medium') && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                          w.risk.toLowerCase().includes('low') && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
                        )}>{w.risk}</Badge>
                      </div>
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
            <div className="flex flex-col flex-1 min-h-0 gap-3">
              {diagrams.length > 0 ? (
                <>
                  {/* Diagram sub-tabs */}
                  <div className="flex-shrink-0 flex items-center gap-1 overflow-x-auto pb-0.5">
                    {diagrams.map((d, i) => (
                      <button
                        key={i}
                        onClick={() => setActiveDiagramIdx(i)}
                        className={cn(
                          'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap',
                          activeDiagramIdx === i
                            ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                            : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300',
                        )}
                      >
                        <Map className="w-3 h-3" />
                        {d.name}
                      </button>
                    ))}
                  </div>

                  {/* Active diagram */}
                  {diagrams[activeDiagramIdx] && (
                    <div className="flex-1 min-h-0 flex flex-col">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">{diagrams[activeDiagramIdx].name}</h4>
                        <button
                          onClick={() => handlePopout(diagrams[activeDiagramIdx])}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                          <Maximize2 className="w-3 h-3" />
                          Pop Out
                        </button>
                      </div>
                      <div className="flex-1 min-h-0 overflow-auto">
                        <MermaidDiagram chart={diagrams[activeDiagramIdx].chart} filename={diagrams[activeDiagramIdx].name.toLowerCase().replace(/\s+/g, '-')} />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No Mermaid diagrams found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Full Output ───────────────────────────────────── */}
          {activeTab === 'output' && (
            <div className="flex-1 min-h-0 overflow-auto">
              <RefinableMarkdown
                text={stage.output}
                onSectionRefined={(updated) => {
                  usePipelineStore.getState().setStageOutput(stageIndex, updated);
                }}
                onRefineRequest={onRefineRequest}
              />
            </div>
          )}

          </div>{/* end scrollable tab content */}
        </div>
      )}
    </div>
  );
}
