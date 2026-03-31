'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Play, Building2, GitCompare, BarChart3,
  Map, AlertTriangle, DollarSign, CheckCircle, Maximize2, X,
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

interface TechDecision {
  category: string;
  chosen: string;
  alt1: string;
  alt2: string;
  rationale: string;
}

interface RoadmapPhase {
  phase: string;
  sprintRange: string;
  deliverables: string;
  gate: string;
  dependencies: string;
  risk: string;
}

interface RiskRow {
  index: number;
  risk: string;
  probability: string;
  impact: string;
  severity: string;
  mitigation: string;
  owner: string;
  contingency: string;
}

interface CostRow {
  resource: string;
  monthly: string;
  annual: string;
  notes: string;
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
    // Look backwards from the match to find the closest heading
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
        {/* Minimal header — overlaid top-right */}
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
        {/* Diagram fills entire modal */}
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

function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingMatch = new RegExp(`(?:^|\\n)(#{1,3})\\s*(?:\\d+\\.?\\s*)?${escaped}[^\\n]*\\n`, 'i').exec(text);
  if (!headingMatch) return null;
  const level = headingMatch[1].length;
  const startIndex = headingMatch.index + headingMatch[0].length;
  const endMatch = new RegExp(`\\n#{1,${level}}\\s`).exec(text.slice(startIndex));
  const content = endMatch ? text.slice(startIndex, startIndex + endMatch.index) : text.slice(startIndex);
  return content.trim() || null;
}

function parseTableRows(section: string | null, skipHeader: RegExp): string[][] {
  if (!section) return [];
  return section.split('\n')
    .filter((l) => /^\|/.test(l) && !/^[\s|:-]+$/.test(l) && !skipHeader.test(l))
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));
}

function extractTechDecisions(text: string): TechDecision[] {
  const section = extractSection(text, 'Technology Decision');
  const rows = parseTableRows(section, /^\|\s*Category\s*\|/);
  return rows.filter((c) => c.length >= 5).map((c) => ({
    category: c[0], chosen: c[1], alt1: c[2], alt2: c[3], rationale: c[4],
  }));
}

function extractRoadmap(text: string): RoadmapPhase[] {
  const section = extractSection(text, 'Migration Roadmap');
  const rows = parseTableRows(section, /^\|\s*Phase\s*\|/);
  return rows.filter((c) => c.length >= 5).map((c) => ({
    phase: c[0], sprintRange: c[1], deliverables: c[2], gate: c[3],
    dependencies: c[4], risk: c[5] || '',
  }));
}

function extractRisks(text: string): RiskRow[] {
  const section = extractSection(text, 'Risk Register');
  const rows = parseTableRows(section, /^\|\s*#\s*\|/);
  return rows.filter((c) => c.length >= 6).map((c) => {
    const idx = parseInt(c[0], 10);
    if (isNaN(idx)) return null;
    return {
      index: idx, risk: c[1], probability: c[2], impact: c[3],
      severity: c[4], mitigation: c[5], owner: c[6] || '', contingency: c[7] || '',
    };
  }).filter(Boolean) as RiskRow[];
}

function extractCosts(text: string): CostRow[] {
  const section = extractSection(text, 'Cost Model');
  const rows = parseTableRows(section, /^\|\s*Resource\s*\|/);
  return rows.filter((c) => c.length >= 3).map((c) => ({
    resource: c[0], monthly: c[1], annual: c[2], notes: c[3] || '',
  }));
}

// ─── Component ────────────────────────────────────────────────────

type TabKey = 'architecture' | 'tech' | 'roadmap' | 'risks' | 'costs' | 'output';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Building2 }> = [
  { key: 'architecture', label: 'Architecture', icon: Map },
  { key: 'tech', label: 'Tech Decisions', icon: BarChart3 },
  { key: 'roadmap', label: 'Roadmap', icon: GitCompare },
  { key: 'risks', label: 'Risk Register', icon: AlertTriangle },
  { key: 'costs', label: 'Cost Model', icon: DollarSign },
  { key: 'output', label: 'Full Output', icon: Building2 },
];

export default function ArchitectPanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  onApprove: _onApprove,
  onReject: _onReject,
  isExecuting,
  onRefineRequest,
  project,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);
  const [activeTab, setActiveTab] = useState<TabKey>('architecture');
  const [activeDiagramIdx, setActiveDiagramIdx] = useState(0);
  const [popoutDiagram, setPopoutDiagram] = useState<NamedDiagram | null>(null);
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  const diagrams = useMemo(() => stage.output ? extractNamedDiagrams(stage.output) : [], [stage.output]);
  const techDecisions = useMemo(() => stage.output ? extractTechDecisions(stage.output) : [], [stage.output]);
  const roadmap = useMemo(() => stage.output ? extractRoadmap(stage.output) : [], [stage.output]);
  const risks = useMemo(() => stage.output ? extractRisks(stage.output) : [], [stage.output]);
  const costs = useMemo(() => stage.output ? extractCosts(stage.output) : [], [stage.output]);
  const archSection = useMemo(() => stage.output ? extractSection(stage.output, 'Target Architecture') : null, [stage.output]);
  const handlePopout = useCallback((d: NamedDiagram) => setPopoutDiagram(d), []);

  const highRisks = risks.filter((r) => r.severity.toLowerCase().includes('high') || r.severity.toLowerCase().includes('critical')).length;
  const totalSprints = roadmap.length > 0 ? roadmap[roadmap.length - 1].sprintRange : '';

  const activeDiagram = diagrams[activeDiagramIdx] ?? null;

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
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Architect Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Stats Bar — sticky */}
          <div className="flex-shrink-0 flex items-center justify-between bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-2">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <Map className="w-3.5 h-3.5" />
                {diagrams.length} diagrams
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <BarChart3 className="w-3.5 h-3.5" />
                {techDecisions.length} tech decisions
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <GitCompare className="w-3.5 h-3.5" />
                {roadmap.length} phases
              </span>
              {highRisks > 0 && (
                <span className="flex items-center gap-1.5 text-red-600 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {highRisks} high risks
                </span>
              )}
              <span className="flex items-center gap-1.5 text-slate-500">
                <DollarSign className="w-3.5 h-3.5" />
                {costs.length} cost items
              </span>
            </div>
            {totalSprints && (
              <Badge variant="outline" className="text-[10px]">{totalSprints}</Badge>
            )}
          </div>

          {/* Tab Bar */}
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
                {key === 'risks' && risks.length > 0 && (
                  <span className="text-[9px] ml-0.5 opacity-70">({risks.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 min-h-0 overflow-auto p-4">

          {/* ── Tab: Architecture ──────────────────────────────────── */}
          {activeTab === 'architecture' && (
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
                  {activeDiagram && (
                    <div className="flex-1 min-h-0 flex flex-col">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">{activeDiagram.name}</h4>
                        <button
                          onClick={() => handlePopout(activeDiagram)}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                          <Maximize2 className="w-3 h-3" />
                          Pop Out
                        </button>
                      </div>
                      <div className="flex-1 min-h-0 overflow-auto">
                        <MermaidDiagram chart={activeDiagram.chart} filename={activeDiagram.name.toLowerCase().replace(/\s+/g, '-')} />
                      </div>
                    </div>
                  )}
                </>
              ) : archSection ? (
                <div className="flex-1 min-h-0 overflow-auto">
                  <RefinableMarkdown
                    text={`## Target Architecture\n\n${archSection}`}
                    onSectionRefined={(updated) => {
                      usePipelineStore.getState().setStageOutput(stageIndex, updated);
                    }}
                    onRefineRequest={onRefineRequest}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No architecture content found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Tech Decisions ────────────────────────────────── */}
          {activeTab === 'tech' && (
            <div className="flex-1 min-h-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {techDecisions.length > 0 ? (
                <table className="w-full text-[11px] table-fixed">
                  <colgroup>
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '54%' }} />
                  </colgroup>
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Category</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Chosen</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Alt 1</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Alt 2</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Rationale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {techDecisions.map((d, i) => (
                      <tr key={i} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 align-top">
                        <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-50">{d.category.replace(/\*+/g, '')}</td>
                        <td className="py-2 px-3">
                          <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 text-[10px] whitespace-normal">
                            <CheckCircle className="w-2.5 h-2.5 mr-0.5 inline flex-shrink-0" />
                            {d.chosen.replace(/\*+/g, '')}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-slate-400">{d.alt1}</td>
                        <td className="py-2 px-3 text-slate-400">{d.alt2}</td>
                        <td className="py-2 px-3 text-slate-500 leading-relaxed">{d.rationale.replace(/\*+/g, '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No technology decisions found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Roadmap ────────────────────────────────────────── */}
          {activeTab === 'roadmap' && (
            <div className="flex-1 min-h-0 space-y-3 overflow-auto">
              {roadmap.length > 0 ? (
                roadmap.map((p, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-primary-100 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400 text-[10px] font-mono">{p.phase}</Badge>
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{p.deliverables}</span>
                      </div>
                      <Badge variant="outline" className="text-[10px] font-mono">{p.sprintRange}</Badge>
                    </div>
                    <CardContent className="p-3 space-y-1.5">
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Go/No-Go:</span> {p.gate}
                      </p>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Dependencies:</span> {p.dependencies}
                      </p>
                      {p.risk && (
                        <div className="text-[11px] text-slate-600 dark:text-slate-400">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">Risk:</span>{' '}
                          <Badge className={cn('text-[9px] px-1.5',
                            p.risk.toLowerCase().includes('high') && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                            p.risk.toLowerCase().includes('medium') && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                            p.risk.toLowerCase().includes('low') && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
                          )}>{p.risk}</Badge>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No migration roadmap found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Risk Register ──────────────────────────────────── */}
          {activeTab === 'risks' && (
            <div className="flex-1 min-h-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {risks.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold w-8">#</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Risk</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Prob</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Impact</th>
                      <th className="text-center py-2 px-3 text-slate-500 font-semibold">Severity</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Mitigation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {risks.map((r) => (
                      <tr key={r.index} className={cn(
                        'border-b border-slate-100 dark:border-slate-800',
                        (r.severity.toLowerCase().includes('high') || r.severity.toLowerCase().includes('critical')) && 'bg-red-50/50 dark:bg-red-950/10',
                      )}>
                        <td className="py-1.5 px-3 text-slate-400 font-mono">{r.index}</td>
                        <td className="py-1.5 px-3 font-medium text-slate-900 dark:text-slate-50">{r.risk}</td>
                        <td className="py-1.5 px-3 text-center text-slate-500">{r.probability}</td>
                        <td className="py-1.5 px-3 text-center text-slate-500">{r.impact}</td>
                        <td className="py-1.5 px-3 text-center">
                          <Badge className={cn('text-[9px] px-1.5',
                            r.severity.toLowerCase().includes('high') && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                            r.severity.toLowerCase().includes('medium') && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                            r.severity.toLowerCase().includes('low') && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
                          )}>{r.severity}</Badge>
                        </td>
                        <td className="py-1.5 px-3 text-slate-500 max-w-[200px]">{r.mitigation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No risk register found in output
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Cost Model ─────────────────────────────────────── */}
          {activeTab === 'costs' && (
            <div className="flex-1 min-h-0 rounded-lg border border-slate-200 dark:border-slate-700 overflow-auto">
              {costs.length > 0 ? (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 z-10">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Resource</th>
                      <th className="text-right py-2 px-3 text-slate-500 font-semibold">Monthly</th>
                      <th className="text-right py-2 px-3 text-slate-500 font-semibold">Annual</th>
                      <th className="text-left py-2 px-3 text-slate-500 font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costs.map((c, i) => (
                      <tr key={i} className={cn(
                        'border-b border-slate-100 dark:border-slate-800',
                        c.resource.toLowerCase().includes('total') && 'bg-slate-50 dark:bg-slate-800 font-bold',
                      )}>
                        <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-50">{c.resource}</td>
                        <td className="py-2 px-3 text-right font-mono text-emerald-600 dark:text-emerald-400">{c.monthly}</td>
                        <td className="py-2 px-3 text-right font-mono text-slate-500">{c.annual}</td>
                        <td className="py-2 px-3 text-slate-500">{c.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">
                  No cost model found in output
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
