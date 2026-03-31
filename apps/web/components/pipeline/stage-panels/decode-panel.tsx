'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  Play, Brain, Eye, Target, Sparkles, Cpu,
  FileText, GitBranch, Database, AlertTriangle,
  HelpCircle, Rocket, Link2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { BreeOutputTab } from '@/components/pipeline/bree-output-tab';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { SubtaskProgressList } from '@/components/pipeline/subtask-progress-list';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

// ─── Section Extractor ───────────────────────────────────────────

/** Extract a top-level section (# PART N) including all sub-content until next # heading. */
function extractPart(text: string, partName: string): string | null {
  const escaped = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)#\\s+(?:PART\\s+\\d+:\\s*)?${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n#\\s|$)`, 'i').exec(text);
  return match ? match[1].trim() : null;
}


// ─── Business Rule Parser ────────────────────────────────────────

interface BusinessRule {
  id: string;
  name: string;
  description: string;
  type: string;
  confidence: string;
  sourcePython: string;
  sourceCobol: string;
  codeSnippets: string[];
}

function parseBusinessRules(section: string): BusinessRule[] {
  const blocks = section.split(/\n(?=####\s+BR-)/);
  return blocks.filter((b) => /^####\s+BR-/.test(b)).map((block) => {
    const idMatch = block.match(/^####\s+(BR-\d+):\s*(.+)/);
    const field = (label: string) => {
      const m = block.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, 'i'));
      return m ? m[1].replace(/\*+/g, '').trim() : '';
    };
    const snippets: string[] = [];
    const codeRegex = /```(?:python|cobol|javascript)?\n([\s\S]*?)```/g;
    let cm;
    while ((cm = codeRegex.exec(block)) !== null) snippets.push(cm[1].trim());

    return {
      id: idMatch?.[1] || '',
      name: idMatch?.[2]?.trim() || field('Rule Name'),
      description: field('Description'),
      type: field('Type'),
      confidence: field('Confidence'),
      sourcePython: field('Source \\(Python\\)') || field('Source'),
      sourceCobol: field('Source \\(COBOL\\)'),
      codeSnippets: snippets,
    };
  });
}

// ─── Workflow Parser ─────────────────────────────────────────────

interface Workflow {
  id: string;
  name: string;
  actor: string;
  trigger: string;
  steps: string[][]; // table rows
}

function parseWorkflows(section: string): Workflow[] {
  const blocks = section.split(/\n(?=###\s+(?:Workflow|System Workflow)\s+\d+)/);
  return blocks.filter((b) => /^###\s+(?:Workflow|System Workflow)\s+\d+/.test(b)).map((block) => {
    const nameMatch = block.match(/^###\s+(?:(?:System )?Workflow\s+\d+:\s*)(.+)/);
    const field = (label: string) => {
      const m = block.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, 'i'));
      return m ? m[1].replace(/\*+/g, '').trim() : '';
    };
    // Parse first markdown table as steps
    const tableLines = block.split('\n').filter((l) => /^\|/.test(l) && !/^[\s|:-]+$/.test(l));
    const steps = tableLines.slice(1).map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));

    return {
      id: field('Workflow ID') || '',
      name: nameMatch?.[1]?.trim() || '',
      actor: field('Actor'),
      trigger: field('Trigger'),
      steps,
    };
  });
}

// ─── Debt Item Parser ────────────────────────────────────────────

interface DebtItem {
  id: string;
  name: string;
  description: string;
  impact: string;
  recommendation: string;
}

function parseDebtItems(section: string): DebtItem[] {
  const blocks = section.split(/\n(?=###\s+Debt Item\s+\d+)/);
  return blocks.filter((b) => /^###\s+Debt Item/.test(b)).map((block) => {
    const nameMatch = block.match(/^###\s+Debt Item\s+\d+:\s*(.+)/);
    const field = (label: string) => {
      const m = block.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, 'i'));
      return m ? m[1].replace(/\*+/g, '').trim() : '';
    };
    // Description is typically multi-line after the heading
    const descMatch = block.match(/\n-\s+\*\*Description\*\*:\s*(.+)/i);
    return {
      id: nameMatch?.[0]?.match(/Debt Item\s+(\d+)/)?.[1] || '',
      name: nameMatch?.[1]?.trim() || '',
      description: descMatch?.[1] || field('Description'),
      impact: field('Impact') || field('Risk'),
      recommendation: field('Recommendation') || field('Resolution'),
    };
  });
}

// ─── Entity Parser ───────────────────────────────────────────────

interface DomainEntity {
  id: string;
  name: string;
  description: string;
  cobolSnippet: string;
  pythonSnippet: string;
  fieldMapping: string[][]; // table rows
  divergence: string;
  rules: string;
}

function parseEntities(section: string): DomainEntity[] {
  const blocks = section.split(/\n(?=###\s+Entity\s+\d+)/);
  return blocks.filter((b) => /^###\s+Entity/.test(b)).map((block) => {
    const nameMatch = block.match(/^###\s+Entity\s+\d+:\s*(.+)/);
    const field = (label: string) => {
      const m = block.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, 'i'));
      return m ? m[1].replace(/\*+/g, '').trim() : '';
    };
    const snippets: { lang: string; code: string }[] = [];
    const codeRegex = /```(cobol|python)\n([\s\S]*?)```/g;
    let cm;
    while ((cm = codeRegex.exec(block)) !== null) snippets.push({ lang: cm[1], code: cm[2].trim() });

    // Parse field mapping table
    const tableLines = block.split('\n').filter((l) => /^\|/.test(l) && !/^[\s|:-]+$/.test(l));
    const rows = tableLines.slice(1).map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));

    const divMatch = block.match(/🔴[^*]*\*\*:\n([\s\S]*?)(?=\n\*\*|$)/);

    return {
      id: field('Entity ID'),
      name: nameMatch?.[1]?.trim() || field('Entity Name'),
      description: field('Description'),
      cobolSnippet: snippets.find((s) => s.lang === 'cobol')?.code || '',
      pythonSnippet: snippets.find((s) => s.lang === 'python')?.code || '',
      fieldMapping: rows,
      divergence: divMatch?.[1]?.trim() || '',
      rules: field('Business Rules Applied'),
    };
  });
}

// ─── Question Parser ─────────────────────────────────────────────

interface OpenQuestion {
  id: string;
  question: string;
  whyMatters: string;
  impact: string;
  resolution: string;
}

function parseQuestions(section: string): OpenQuestion[] {
  const blocks = section.split(/\n(?=###\s+Q\d+)/);
  return blocks.filter((b) => /^###\s+Q\d+/.test(b)).map((block) => {
    const idMatch = block.match(/^###\s+(Q\d+):\s*(.+)/);
    const field = (label: string) => {
      const m = block.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, 'i'));
      return m ? m[1].replace(/\*+/g, '').trim() : '';
    };
    return {
      id: idMatch?.[1] || '',
      question: idMatch?.[2]?.trim() || '',
      whyMatters: field('Why It Matters'),
      impact: field('Impact'),
      resolution: field('Resolution Path'),
    };
  });
}

// ─── Readiness Task Parser ───────────────────────────────────────

interface ReadinessTask {
  name: string;
  owner: string;
  deadline: string;
  deliverable: string;
  checked: boolean;
}

function parseReadinessTasks(section: string): ReadinessTask[] {
  const tasks: ReadinessTask[] = [];
  const taskRegex = /- \[([ x])\] \*\*([^*]+)\*\*:?\s*([^\n]*)\n([\s\S]*?)(?=\n- \[|$)/gi;
  let m;
  while ((m = taskRegex.exec(section)) !== null) {
    const detail = m[4];
    const field = (label: string) => {
      const fm = detail.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, 'i'));
      return fm ? fm[1].trim() : '';
    };
    tasks.push({
      name: (m[2] + (m[3] ? ': ' + m[3] : '')).trim(),
      owner: field('Owner'),
      deadline: field('Deadline'),
      deliverable: field('Deliverable'),
      checked: m[1] === 'x',
    });
  }
  return tasks;
}

// ─── Pre-execution dimensions ────────────────────────────────────

const DECODE_DIMENSIONS = [
  { key: 'businessRules', label: 'Business Rules', icon: Target, color: 'text-blue-500' },
  { key: 'workflows', label: 'Workflows', icon: Sparkles, color: 'text-purple-500' },
  { key: 'dataModels', label: 'Data Models', icon: Brain, color: 'text-green-500' },
  { key: 'integrations', label: 'Integrations', icon: AlertTriangle, color: 'text-orange-500' },
];

// ─── Tab definitions ─────────────────────────────────────────────

type TabKey = 'rules' | 'workflows' | 'entities' | 'debt' | 'questions' | 'readiness' | 'bree' | 'output';

const TABS: Array<{ key: TabKey; label: string; icon: typeof FileText }> = [
  { key: 'rules', label: 'Business Rules', icon: Target },
  { key: 'workflows', label: 'Workflows', icon: GitBranch },
  { key: 'entities', label: 'Data Model', icon: Database },
  { key: 'debt', label: 'Tech Debt', icon: AlertTriangle },
  { key: 'questions', label: 'Open Questions', icon: HelpCircle },
  { key: 'readiness', label: 'Readiness', icon: Rocket },
  { key: 'bree', label: 'BREE Analysis', icon: Cpu },
  { key: 'output', label: 'Full Output', icon: Link2 },
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
  const logs = usePipelineStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);
  const [activeTab, setActiveTab] = useState<TabKey>('rules');
  const [deepAnalysis, setDeepAnalysis] = useState(project?.deep_analysis ?? false);
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  // ─── Parsed sections ────────────────────────────────────────
  const rulesSection = useMemo(() => stage.output ? extractPart(stage.output, 'BUSINESS RULES') : null, [stage.output]);
  const workflowsSection = useMemo(() => stage.output ? extractPart(stage.output, 'WORKFLOWS') : null, [stage.output]);
  const entitiesSection = useMemo(() => stage.output ? extractPart(stage.output, 'DATA MODEL') : null, [stage.output]);
  const debtSection = useMemo(() => stage.output ? extractPart(stage.output, 'TECHNICAL DEBT') : null, [stage.output]);
  const questionsSection = useMemo(() => stage.output ? extractPart(stage.output, 'OPEN QUESTIONS') : null, [stage.output]);
  const readinessSection = useMemo(() => {
    if (!stage.output) return null;
    const readiness = extractPart(stage.output, 'MIGRATION READINESS');
    const recommendations = extractPart(stage.output, 'RECOMMENDATIONS');
    return [readiness, recommendations].filter(Boolean).join('\n\n---\n\n') || null;
  }, [stage.output]);

  // ─── Structured data ───────────────────────────────────────
  const businessRules = useMemo(() => rulesSection ? parseBusinessRules(rulesSection) : [], [rulesSection]);
  const workflows = useMemo(() => workflowsSection ? parseWorkflows(workflowsSection) : [], [workflowsSection]);
  const debtItems = useMemo(() => debtSection ? parseDebtItems(debtSection) : [], [debtSection]);
  const entities = useMemo(() => entitiesSection ? parseEntities(entitiesSection) : [], [entitiesSection]);
  const questions = useMemo(() => questionsSection ? parseQuestions(questionsSection) : [], [questionsSection]);
  const readinessTasks = useMemo(() => readinessSection ? parseReadinessTasks(readinessSection) : [], [readinessSection]);

  // ─── Stats ──────────────────────────────────────────────────
  const stats = useMemo(() => ({
    rules: businessRules.length,
    workflows: workflows.length,
    entities: entities.length,
    debtItems: debtItems.length,
    questions: questions.length,
  }), [businessRules, workflows, entities, debtItems, questions]);

  const handleRefine = useCallback((updated: string) => {
    usePipelineStore.getState().setStageOutput(stageIndex, updated);
  }, [stageIndex]);

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
        <div className="flex flex-col flex-1 min-h-0">
          {/* Stats Bar — sticky */}
          <div className="flex-shrink-0 flex items-center gap-4 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs">
            <span className="flex items-center gap-1.5 text-slate-500">
              <Target className="w-3.5 h-3.5" />
              {stats.rules} business rules
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <GitBranch className="w-3.5 h-3.5" />
              {stats.workflows} workflows
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <Database className="w-3.5 h-3.5" />
              {stats.entities} entities
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <AlertTriangle className="w-3.5 h-3.5" />
              {stats.debtItems} debt items
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <HelpCircle className="w-3.5 h-3.5" />
              {stats.questions} open questions
            </span>
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
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="flex-1 min-h-0 overflow-auto p-4">

          {/* ── Tab: Business Rules ─────────────────────────────── */}
          {activeTab === 'rules' && (
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {businessRules.length > 0 ? (
                businessRules.map((br, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 text-[10px] font-mono">{br.id}</Badge>
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{br.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {br.type && <Badge variant="outline" className="text-[9px]">{br.type}</Badge>}
                        {br.confidence && (
                          <Badge className={cn('text-[9px]',
                            br.confidence.toLowerCase().includes('verified') ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                          )}>{br.confidence}</Badge>
                        )}
                      </div>
                    </div>
                    <CardContent className="p-3 space-y-2 text-[11px]">
                      {br.description && (
                        <p className="text-slate-600 dark:text-slate-400 leading-relaxed">{br.description}</p>
                      )}
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[10px]">
                        {br.sourcePython && (
                          <span className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">Python:</span> <code className="font-mono text-primary-600 dark:text-primary-400">{br.sourcePython}</code></span>
                        )}
                        {br.sourceCobol && (
                          <span className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">COBOL:</span> <code className="font-mono text-primary-600 dark:text-primary-400">{br.sourceCobol}</code></span>
                        )}
                      </div>
                      {br.codeSnippets.length > 0 && (
                        <details className="group">
                          <summary className="text-[10px] font-medium text-slate-500 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300">
                            Show code ({br.codeSnippets.length} snippet{br.codeSnippets.length > 1 ? 's' : ''})
                          </summary>
                          {br.codeSnippets.map((snippet, j) => (
                            <pre key={j} className="mt-1 p-2 rounded bg-slate-950 text-slate-300 text-[10px] font-mono overflow-x-auto leading-relaxed">{snippet}</pre>
                          ))}
                        </details>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : rulesSection ? (
                <RefinableMarkdown text={`# Business Rules\n\n${rulesSection}`} onSectionRefined={handleRefine} onRefineRequest={onRefineRequest} />
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">No business rules found</div>
              )}
            </div>
          )}

          {/* ── Tab: Workflows ──────────────────────────────────── */}
          {activeTab === 'workflows' && (
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {workflows.length > 0 ? (
                workflows.map((wf, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {wf.id && <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400 text-[10px] font-mono">{wf.id}</Badge>}
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{wf.name}</span>
                      </div>
                      {wf.actor && <Badge variant="outline" className="text-[9px]">{wf.actor}</Badge>}
                    </div>
                    <CardContent className="p-3 space-y-2 text-[11px]">
                      {wf.trigger && (
                        <div className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">Trigger:</span> {wf.trigger}</div>
                      )}
                      {wf.steps.length > 0 && (
                        <div className="rounded border border-slate-200 dark:border-slate-700 overflow-auto">
                          <table className="w-full text-[10px]">
                            <thead className="bg-slate-50 dark:bg-slate-800">
                              <tr className="border-b border-slate-200 dark:border-slate-700">
                                <th className="text-left py-1.5 px-2 text-slate-500 font-semibold w-8">#</th>
                                <th className="text-left py-1.5 px-2 text-slate-500 font-semibold">Action</th>
                                <th className="text-left py-1.5 px-2 text-slate-500 font-semibold">Actor</th>
                                <th className="text-left py-1.5 px-2 text-slate-500 font-semibold">Response</th>
                                <th className="text-left py-1.5 px-2 text-slate-500 font-semibold">Rules</th>
                              </tr>
                            </thead>
                            <tbody>
                              {wf.steps.map((row, j) => (
                                <tr key={j} className="border-b border-slate-100 dark:border-slate-800">
                                  <td className="py-1 px-2 text-slate-400 font-mono">{row[0]}</td>
                                  <td className="py-1 px-2 text-slate-700 dark:text-slate-300">{row[1]}</td>
                                  <td className="py-1 px-2 text-slate-500">{row[2]}</td>
                                  <td className="py-1 px-2 text-slate-500">{row[3]}</td>
                                  <td className="py-1 px-2 font-mono text-primary-600 dark:text-primary-400">{row[4]}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : workflowsSection ? (
                <RefinableMarkdown text={`# Workflows\n\n${workflowsSection}`} onSectionRefined={handleRefine} onRefineRequest={onRefineRequest} />
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">No workflows found</div>
              )}
            </div>
          )}

          {/* ── Tab: Data Model ─────────────────────────────────── */}
          {activeTab === 'entities' && (
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {entities.length > 0 ? (
                entities.map((ent, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400 text-[10px] font-mono">{ent.id}</Badge>
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{ent.name}</span>
                      </div>
                      {ent.rules && <span className="text-[9px] font-mono text-slate-400">{ent.rules}</span>}
                    </div>
                    <CardContent className="p-3 space-y-2 text-[11px]">
                      {ent.description && <p className="text-slate-600 dark:text-slate-400">{ent.description}</p>}

                      {/* Code snippets side by side */}
                      {(ent.cobolSnippet || ent.pythonSnippet) && (
                        <div className="grid grid-cols-2 gap-2">
                          {ent.cobolSnippet && (
                            <div>
                              <span className="text-[9px] font-semibold text-slate-500 uppercase">COBOL</span>
                              <pre className="mt-0.5 p-2 rounded bg-slate-950 text-slate-300 text-[9px] font-mono overflow-x-auto leading-relaxed max-h-32 overflow-y-auto">{ent.cobolSnippet}</pre>
                            </div>
                          )}
                          {ent.pythonSnippet && (
                            <div>
                              <span className="text-[9px] font-semibold text-slate-500 uppercase">Python</span>
                              <pre className="mt-0.5 p-2 rounded bg-slate-950 text-slate-300 text-[9px] font-mono overflow-x-auto leading-relaxed max-h-32 overflow-y-auto">{ent.pythonSnippet}</pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Field mapping table */}
                      {ent.fieldMapping.length > 0 && (
                        <details className="group">
                          <summary className="text-[10px] font-medium text-slate-500 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300">
                            Field mapping ({ent.fieldMapping.length} fields)
                          </summary>
                          <div className="mt-1 rounded border border-slate-200 dark:border-slate-700 overflow-auto">
                            <table className="w-full text-[9px]">
                              <thead className="bg-slate-50 dark:bg-slate-800">
                                <tr><th className="text-left py-1 px-2 text-slate-500">COBOL</th><th className="text-left py-1 px-2 text-slate-500">Python</th><th className="text-left py-1 px-2 text-slate-500">Type</th><th className="text-left py-1 px-2 text-slate-500">Status</th><th className="text-left py-1 px-2 text-slate-500">Notes</th></tr>
                              </thead>
                              <tbody>
                                {ent.fieldMapping.map((row, j) => (
                                  <tr key={j} className="border-t border-slate-100 dark:border-slate-800">
                                    <td className="py-0.5 px-2 font-mono">{row[0]}</td>
                                    <td className="py-0.5 px-2 font-mono">{row[1]}</td>
                                    <td className="py-0.5 px-2">{row[2]}</td>
                                    <td className="py-0.5 px-2">{row[4]}</td>
                                    <td className="py-0.5 px-2 text-slate-400">{row[5]}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      )}

                      {ent.divergence && (
                        <div className="p-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/30 text-[10px] text-red-700 dark:text-red-400">
                          <span className="font-semibold">Data Model Divergence:</span> {ent.divergence.split('\n')[0]}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : entitiesSection ? (
                <RefinableMarkdown text={`# Data Model\n\n${entitiesSection}`} onSectionRefined={handleRefine} onRefineRequest={onRefineRequest} />
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">No data model found</div>
              )}
            </div>
          )}

          {/* ── Tab: Tech Debt ──────────────────────────────────── */}
          {activeTab === 'debt' && (
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {debtItems.length > 0 ? (
                debtItems.map((d, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 text-[10px] font-mono">TD-{d.id}</Badge>
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{d.name}</span>
                      </div>
                    </div>
                    <CardContent className="p-3 space-y-1.5 text-[11px]">
                      {d.description && <p className="text-slate-600 dark:text-slate-400 leading-relaxed">{d.description}</p>}
                      {d.impact && <div className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">Impact:</span> {d.impact}</div>}
                      {d.recommendation && <div className="text-slate-500"><span className="font-semibold text-slate-700 dark:text-slate-300">Recommendation:</span> {d.recommendation}</div>}
                    </CardContent>
                  </Card>
                ))
              ) : debtSection ? (
                <RefinableMarkdown text={`# Technical Debt\n\n${debtSection}`} onSectionRefined={handleRefine} onRefineRequest={onRefineRequest} />
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">No tech debt items found</div>
              )}
            </div>
          )}

          {/* ── Tab: Open Questions ─────────────────────────────── */}
          {activeTab === 'questions' && (
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {questions.length > 0 ? (
                questions.map((q, i) => (
                  <Card key={i} className="overflow-hidden">
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 text-[10px] font-mono">{q.id}</Badge>
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{q.question}</span>
                      </div>
                      {q.impact && (
                        <Badge className={cn('text-[9px]',
                          q.impact.toLowerCase().includes('critical') ? 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400' :
                          q.impact.toLowerCase().includes('high') ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400' :
                          'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                        )}>{q.impact}</Badge>
                      )}
                    </div>
                    <CardContent className="p-3 space-y-1.5 text-[11px]">
                      {q.whyMatters && <p className="text-slate-600 dark:text-slate-400 leading-relaxed">{q.whyMatters}</p>}
                      {q.resolution && (
                        <div className="text-slate-500">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">Resolution:</span> {q.resolution}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              ) : questionsSection ? (
                <RefinableMarkdown text={`# Open Questions\n\n${questionsSection}`} onSectionRefined={handleRefine} onRefineRequest={onRefineRequest} />
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">No open questions found</div>
              )}
            </div>
          )}

          {/* ── Tab: Readiness ──────────────────────────────────── */}
          {activeTab === 'readiness' && (
            <div className="flex-1 min-h-0 overflow-auto space-y-3">
              {readinessTasks.length > 0 ? (
                <>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span>{readinessTasks.filter((t) => t.checked).length} / {readinessTasks.length} tasks complete</span>
                    <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all"
                        style={{ width: `${(readinessTasks.filter((t) => t.checked).length / readinessTasks.length) * 100}%` }}
                      />
                    </div>
                  </div>
                  {readinessTasks.map((task, i) => (
                    <Card key={i} className={cn('overflow-hidden', task.checked && 'opacity-60')}>
                      <CardContent className="p-3 flex items-start gap-3">
                        <input type="checkbox" checked={task.checked} readOnly className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-primary-600" />
                        <div className="flex-1 min-w-0 space-y-1">
                          <p className={cn('text-xs font-medium text-slate-700 dark:text-slate-300', task.checked && 'line-through')}>{task.name}</p>
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-slate-500">
                            {task.owner && <span><span className="font-semibold text-slate-600 dark:text-slate-400">Owner:</span> {task.owner}</span>}
                            {task.deadline && <span><span className="font-semibold text-slate-600 dark:text-slate-400">Deadline:</span> {task.deadline}</span>}
                          </div>
                          {task.deliverable && <p className="text-[10px] text-slate-400">{task.deliverable}</p>}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </>
              ) : readinessSection ? (
                <RefinableMarkdown text={`# Readiness\n\n${readinessSection}`} onSectionRefined={handleRefine} onRefineRequest={onRefineRequest} />
              ) : (
                <div className="flex items-center justify-center h-40 text-sm text-slate-400">No readiness assessment found</div>
              )}
            </div>
          )}

          {/* ── Tab: BREE Analysis ──────────────────────────────── */}
          {activeTab === 'bree' && (
            <div className="flex-1 min-h-0 overflow-auto">
              <BreeOutputTab stageName="DECODE" />
            </div>
          )}

          {/* ── Tab: Full Output ────────────────────────────────── */}
          {activeTab === 'output' && (
            <div className="flex-1 min-h-0 overflow-auto">
              <RefinableMarkdown text={stage.output} onSectionRefined={handleRefine} onRefineRequest={onRefineRequest} />
            </div>
          )}

          </div>{/* end scrollable tab content */}
        </div>
      )}
    </div>
  );
}
