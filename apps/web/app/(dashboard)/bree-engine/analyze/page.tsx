'use client';

import { useState, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Play, CheckCircle2, XCircle,
  GitBranch, Skull, Gauge, FileSearch, Brain,
  Loader2, Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const BREE_API = 'http://localhost:8081';

interface AnalysisState {
  status: 'idle' | 'running' | 'complete' | 'error';
  steps: StepStatus[];
  report: Record<string, unknown> | null;
  mermaid: string | null;
  error: string | null;
}

interface StepStatus {
  name: string;
  status: 'pending' | 'running' | 'done';
  detail?: string;
}

export default function AnalyzePage() {
  const [state, setState] = useState<AnalysisState>({
    status: 'idle', steps: [], report: null, mermaid: null, error: null,
  });
  const [sampleCode, setSampleCode] = useState(SAMPLE_COBOL);
  const [sampleName, setSampleName] = useState('ACCTPROC.cbl');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const runAnalysis = async () => {
    setState({
      status: 'running',
      steps: [
        { name: 'Detection', status: 'pending' },
        { name: 'Parsing', status: 'pending' },
        { name: 'Deep Analysis', status: 'pending' },
        { name: 'Report', status: 'pending' },
      ],
      report: null, mermaid: null, error: null,
    });

    try {
      // Use SSE streaming
      const res = await fetch(`${BREE_API}/api/v1/analyze/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ path: sampleName, content: sampleCode }] }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      if (!reader) throw new Error('No response body');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            // Next line is data
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (parsed.step === 'detection' && parsed.status === 'running') {
                setState(s => ({ ...s, steps: s.steps.map((st, i) => i === 0 ? { ...st, status: 'running' } : st) }));
              }
              if (parsed.step === 'detection' && parsed.status === 'done') {
                setState(s => ({ ...s, steps: s.steps.map((st, i) => i === 0 ? { ...st, status: 'done', detail: `${parsed.languages} languages` } : st) }));
              }
              if (parsed.step === 'parsing' && parsed.status === 'running') {
                setState(s => ({ ...s, steps: s.steps.map((st, i) => i === 1 ? { ...st, status: 'running' } : st) }));
              }
              if (parsed.step === 'parsing' && parsed.status === 'done') {
                setState(s => ({ ...s, steps: s.steps.map((st, i) => i === 1 ? { ...st, status: 'done', detail: `${parsed.parsed} files` } : st) }));
              }
              if (parsed.step === 'analysis' && parsed.status === 'running') {
                setState(s => ({ ...s, steps: s.steps.map((st, i) => i === 2 ? { ...st, status: 'running' } : st) }));
              }
              if (parsed.step === 'analysis' && parsed.status === 'done') {
                setState(s => ({
                  ...s,
                  steps: s.steps.map((st, i) => i === 2 ? { ...st, status: 'done', detail: `${parsed.business_rules} rules` } : st),
                  report: parsed,
                }));
              }
              if (parsed.status === 'complete' && parsed.files) {
                setState(s => ({ ...s, status: 'complete', steps: s.steps.map(st => ({ ...st, status: 'done' as const })) }));
              }
            } catch {
              // Mermaid data (not JSON)
              if (data.includes('graph TD')) {
                setState(s => ({ ...s, mermaid: data }));
              }
            }
          }
        }
      }

      // Also fetch the full JSON report
      const fullRes = await fetch(`${BREE_API}/api/v1/analyze/graph`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ path: sampleName, content: sampleCode }] }),
      });
      const fullReport = await fullRes.json();
      setState(s => ({ ...s, status: 'complete', report: fullReport }));

    } catch (e) {
      setState(s => ({ ...s, status: 'error', error: String(e) }));
    }
  };

  const report = state.report as Record<string, unknown> | null;
  const deadCode = report?.dead_code as Record<string, unknown> | undefined;
  const complexity = report?.complexity as Record<string, unknown> | undefined;
  const callGraph = report?.call_graph as Record<string, unknown> | undefined;
  const dataLineage = report?.data_lineage as Record<string, unknown> | undefined;
  const businessRules = report?.business_rules as Record<string, unknown> | undefined;
  const actualCoverage = report?.actual_coverage as {
    file_coverages: Array<{ file: string; language: string; coverage_pct: number; meaningful_lines: number; covered_lines: number; skipped_lines: number; skipped_samples: string[] }>;
    overall: { actual_coverage_pct: number; total_meaningful_lines: number; total_covered_lines: number };
  } | undefined;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Run Analysis</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Paste legacy code to analyze — detects language, parses, extracts business rules, generates call graph
          </p>
        </div>
        <a href="/bree-engine" className="text-sm text-primary-600 dark:text-primary-400 hover:underline">
          ← Back to Matrix
        </a>
      </div>

      {/* Input */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Source Code</label>
                <input
                  type="text"
                  value={sampleName}
                  onChange={e => setSampleName(e.target.value)}
                  className="text-xs px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700 w-40"
                  placeholder="filename.cbl"
                />
              </div>
              <textarea
                ref={textareaRef}
                value={sampleCode}
                onChange={e => setSampleCode(e.target.value)}
                rows={16}
                className="w-full font-mono text-xs bg-slate-950 text-green-400 p-3 rounded-lg border border-slate-700 resize-y"
                placeholder="Paste your legacy code here..."
              />
              <div className="flex items-center justify-between mt-3">
                <div className="flex gap-2">
                  {SAMPLES.map(s => (
                    <button key={s.name} onClick={() => { setSampleCode(s.code); setSampleName(s.name); }}
                      className="text-[10px] px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700">
                      {s.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={runAnalysis}
                  disabled={state.status === 'running' || !sampleCode.trim()}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    state.status === 'running'
                      ? 'bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-wait'
                      : 'bg-primary-600 text-white hover:bg-primary-700'
                  )}
                >
                  {state.status === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {state.status === 'running' ? 'Analyzing...' : 'Run Analysis'}
                </button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Pipeline Steps */}
        <div>
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Pipeline Steps</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {state.steps.length === 0 ? (
                <p className="text-xs text-slate-400">Click &quot;Run Analysis&quot; to start</p>
              ) : state.steps.map((step, i) => (
                <div key={i} className="flex items-center gap-3">
                  {step.status === 'pending' && <div className="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-slate-600" />}
                  {step.status === 'running' && <Loader2 className="w-5 h-5 text-primary-500 animate-spin" />}
                  {step.status === 'done' && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                  <div>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">{step.name}</p>
                    {step.detail && <p className="text-[10px] text-slate-400">{step.detail}</p>}
                  </div>
                </div>
              ))}
              {state.error && (
                <div className="flex items-center gap-2 text-red-500 text-xs">
                  <XCircle className="w-4 h-4" /> {state.error}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Results */}
      {state.status === 'complete' && report && (
        <div className="space-y-4">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <MiniCard icon={Skull} label="Dead Code" value={`${(deadCode?.unreachable_paragraphs as unknown[])?.length || 0} paragraphs`} color="text-red-500" />
            <MiniCard icon={Gauge} label="Avg Complexity" value={`${(complexity?.average_complexity as number)?.toFixed(1) || '0'}`} color="text-amber-500" />
            <MiniCard icon={GitBranch} label="Call Graph" value={`${(callGraph?.stats as Record<string, number>)?.total_nodes || 0} nodes`} color="text-blue-500" />
            <MiniCard icon={FileSearch} label="Fields Tracked" value={`${(dataLineage as Record<string, number>)?.total_fields || 0}`} color="text-violet-500" />
            <MiniCard icon={Brain} label="Business Rules" value={`${(businessRules as Record<string, number>)?.total_rules || 0}`} color="text-emerald-500" />
            <MiniCard icon={Activity} label="Actual Coverage" value={actualCoverage ? `${(actualCoverage.overall.actual_coverage_pct * 100).toFixed(1)}%` : '—'} color="text-cyan-500" />
          </div>

          {/* Dead Code */}
          {deadCode && (deadCode.unreachable_paragraphs as unknown[])?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Skull className="w-4 h-4 text-red-500" /> Dead Code</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left py-2 text-slate-500">Name</th><th className="text-left py-2 text-slate-500">Type</th><th className="text-left py-2 text-slate-500">File</th><th className="text-left py-2 text-slate-500">Confidence</th>
                  </tr></thead>
                  <tbody>
                    {(deadCode.unreachable_paragraphs as Array<Record<string, unknown>>)?.map((p, i) => (
                      <tr key={i} className="border-b border-slate-100 dark:border-slate-800"><td className="py-1.5 font-mono text-red-600 dark:text-red-400">{String(p.name)}</td><td className="py-1.5 text-slate-500">{String(p.kind)}</td><td className="py-1.5 text-slate-500">{String(p.file)}:{String(p.line)}</td><td className="py-1.5"><Badge variant="secondary" className="text-[10px]">{Math.round(Number(p.confidence) * 100)}%</Badge></td></tr>
                    ))}
                    {(deadCode.unused_variables as Array<Record<string, unknown>>)?.slice(0, 5).map((v, i) => (
                      <tr key={`v-${i}`} className="border-b border-slate-100 dark:border-slate-800"><td className="py-1.5 font-mono text-amber-600 dark:text-amber-400">{String(v.name)}</td><td className="py-1.5 text-slate-500">variable</td><td className="py-1.5 text-slate-500">{String(v.file)}</td><td className="py-1.5"><Badge variant="secondary" className="text-[10px]">{Math.round(Number(v.confidence) * 100)}%</Badge></td></tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Complexity */}
          {complexity && (complexity.functions as unknown[])?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Gauge className="w-4 h-4 text-amber-500" /> Cyclomatic Complexity</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left py-2 text-slate-500">Function</th><th className="text-left py-2 text-slate-500">Complexity</th><th className="text-left py-2 text-slate-500">Decisions</th><th className="text-left py-2 text-slate-500">Risk</th>
                  </tr></thead>
                  <tbody>
                    {(complexity.functions as Array<Record<string, unknown>>)?.slice(0, 10).map((f, i) => (
                      <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-1.5 font-mono">{String(f.name)}</td>
                        <td className="py-1.5 font-bold">{String(f.complexity)}</td>
                        <td className="py-1.5 text-slate-500">{String(f.decision_points)}</td>
                        <td className="py-1.5"><span className={cn('text-[10px] px-1.5 py-0.5 rounded',
                          f.risk === 'low' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                          f.risk === 'moderate' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                          f.risk === 'high' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                          'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        )}>{String(f.risk)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Business Rules */}
          {businessRules && (businessRules.rules as unknown[])?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Brain className="w-4 h-4 text-emerald-500" /> Business Rules Extracted</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left py-2 text-slate-500 w-20">ID</th><th className="text-left py-2 text-slate-500">Type</th><th className="text-left py-2 text-slate-500">Description</th><th className="text-left py-2 text-slate-500">Confidence</th>
                  </tr></thead>
                  <tbody>
                    {(businessRules.rules as Array<Record<string, unknown>>)?.map((r, i) => (
                      <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-1.5 font-mono text-primary-600 dark:text-primary-400">{String(r.id)}</td>
                        <td className="py-1.5"><Badge variant="secondary" className="text-[10px]">{String(r.rule_type)}</Badge></td>
                        <td className="py-1.5 text-slate-700 dark:text-slate-300 max-w-md truncate">{String(r.description)}</td>
                        <td className="py-1.5 text-slate-500">{Math.round(Number(r.confidence) * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Actual Parse Coverage */}
          {actualCoverage && actualCoverage.file_coverages.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4 text-cyan-500" /> Actual Parse Coverage</CardTitle></CardHeader>
              <CardContent>
                <div className="mb-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold font-mono text-slate-900 dark:text-slate-50">
                      {(actualCoverage.overall.actual_coverage_pct * 100).toFixed(1)}%
                    </span>
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      of {actualCoverage.overall.total_meaningful_lines} meaningful lines parsed
                    </span>
                  </div>
                  <div className="mt-2 h-2.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all', actualCoverage.overall.actual_coverage_pct >= 0.7 ? 'bg-emerald-500' : actualCoverage.overall.actual_coverage_pct >= 0.4 ? 'bg-amber-500' : 'bg-red-500')}
                      style={{ width: `${actualCoverage.overall.actual_coverage_pct * 100}%` }}
                    />
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-1.5 text-xs text-slate-500">File</th>
                      <th className="text-left py-1.5 text-xs text-slate-500">Language</th>
                      <th className="text-right py-1.5 text-xs text-slate-500">Coverage</th>
                      <th className="text-right py-1.5 text-xs text-slate-500">Lines</th>
                      <th className="text-right py-1.5 text-xs text-slate-500">Skipped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actualCoverage.file_coverages.map(fc => (
                      <tr key={fc.file} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-1.5 font-mono text-xs">{fc.file}</td>
                        <td className="py-1.5 text-xs">{fc.language}</td>
                        <td className={cn('py-1.5 text-right font-mono font-semibold text-xs', fc.coverage_pct >= 0.7 ? 'text-emerald-600 dark:text-emerald-400' : fc.coverage_pct >= 0.4 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400')}>
                          {(fc.coverage_pct * 100).toFixed(1)}%
                        </td>
                        <td className="py-1.5 text-right text-xs text-slate-500">{fc.covered_lines}/{fc.meaningful_lines}</td>
                        <td className="py-1.5 text-right text-xs text-slate-500">{fc.skipped_lines}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {actualCoverage.file_coverages.some(fc => fc.skipped_samples.length > 0) && (
                  <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase mb-1.5">Skipped Lines (parser gaps)</p>
                    {actualCoverage.file_coverages.map(fc =>
                      fc.skipped_samples.map((s, i) => (
                        <p key={`${fc.file}-${i}`} className="text-[11px] font-mono text-red-500 dark:text-red-400">{s}</p>
                      ))
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Call Graph Mermaid */}
          {state.mermaid && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><GitBranch className="w-4 h-4 text-blue-500" /> Call Graph (Mermaid)</CardTitle></CardHeader>
              <CardContent>
                <pre className="text-xs font-mono bg-slate-950 text-slate-300 p-4 rounded-lg overflow-x-auto whitespace-pre">
                  {state.mermaid}
                </pre>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function MiniCard({ icon: Icon, label, value, color }: { icon: typeof Play; label: string; value: string; color: string }) {
  return (
    <Card><CardContent className="p-3">
      <div className="flex items-center gap-2 mb-1"><Icon className={cn('w-3.5 h-3.5', color)} /><span className="text-[10px] text-slate-500 uppercase">{label}</span></div>
      <p className="text-lg font-bold text-slate-900 dark:text-slate-50">{value}</p>
    </CardContent></Card>
  );
}

const SAMPLE_COBOL = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ACCTPROC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-ACCOUNT.
           05 ACCT-NUMBER       PIC X(10).
           05 ACCT-TYPE         PIC X(01).
              88 IS-CHECKING    VALUE 'C'.
              88 IS-SAVINGS     VALUE 'S'.
              88 IS-LOAN        VALUE 'L'.
           05 ACCT-BALANCE      PIC S9(9)V99.
           05 ACCT-STATUS       PIC X(01).
              88 IS-ACTIVE      VALUE 'A'.
              88 IS-CLOSED      VALUE 'X'.
              88 IS-FROZEN      VALUE 'F'.
       01  WS-TRANSACTION.
           05 TXN-AMOUNT        PIC S9(7)V99.
           05 TXN-TYPE          PIC X(02).
           05 TXN-DATE          PIC 9(08).
       01  WS-WORK-FIELDS.
           05 WS-FEE            PIC S9(5)V99.
           05 WS-INTEREST       PIC S9(7)V99.
           05 WS-TAX            PIC S9(5)V99.
           05 WS-NET-AMOUNT     PIC S9(9)V99.
           05 WS-MSG            PIC X(80).
           05 WS-RETURN-CODE    PIC S9(04) COMP.
           05 WS-COUNTER        PIC 9(05).
           05 WS-UNUSED-FLD     PIC X(20).
       01  WS-SQLCODE           PIC S9(09) COMP.
       COPY ACCTCPY.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT
           PERFORM 2000-VALIDATE-ACCT
           IF WS-RETURN-CODE = 0
               PERFORM 3000-PROCESS-TXN
               PERFORM 4000-CALC-FEES
               PERFORM 5000-UPDATE-DB
           END-IF
           PERFORM 9000-CLEANUP
           STOP RUN.
       1000-INIT.
           MOVE ZEROS TO WS-RETURN-CODE
           MOVE ZEROS TO WS-FEE
           MOVE ZEROS TO WS-INTEREST
           MOVE ZEROS TO WS-COUNTER
           EXEC SQL
               SELECT ACCT_BAL, ACCT_TYPE, ACCT_STATUS
               INTO :ACCT-BALANCE, :ACCT-TYPE, :ACCT-STATUS
               FROM ACCOUNTS
               WHERE ACCT_NO = :ACCT-NUMBER
           END-EXEC.
       2000-VALIDATE-ACCT.
           IF IS-CLOSED
               MOVE 'Account is closed' TO WS-MSG
               MOVE 8 TO WS-RETURN-CODE
           END-IF
           IF IS-FROZEN
               MOVE 'Account is frozen' TO WS-MSG
               MOVE 4 TO WS-RETURN-CODE
           END-IF
           IF TXN-AMOUNT > ACCT-BALANCE AND IS-CHECKING
               IF TXN-TYPE = 'WD'
                   MOVE 'Insufficient funds' TO WS-MSG
                   MOVE 12 TO WS-RETURN-CODE
               END-IF
           END-IF.
       3000-PROCESS-TXN.
           EVALUATE TXN-TYPE
               WHEN 'DP'
                   ADD TXN-AMOUNT TO ACCT-BALANCE
               WHEN 'WD'
                   SUBTRACT TXN-AMOUNT FROM ACCT-BALANCE
               WHEN 'TR'
                   PERFORM 3100-TRANSFER THRU 3100-EXIT
               WHEN 'FE'
                   PERFORM 4000-CALC-FEES
                   SUBTRACT WS-FEE FROM ACCT-BALANCE
               WHEN OTHER
                   MOVE 'Unknown txn type' TO WS-MSG
                   MOVE 16 TO WS-RETURN-CODE
           END-EVALUATE
           ADD 1 TO WS-COUNTER.
       3100-TRANSFER.
           CALL 'XFERPRG' USING ACCT-NUMBER TXN-AMOUNT
           IF WS-RETURN-CODE NOT = 0
               MOVE 'Transfer failed' TO WS-MSG
           END-IF.
       3100-EXIT.
           EXIT.
       4000-CALC-FEES.
           IF IS-CHECKING
               COMPUTE WS-FEE = TXN-AMOUNT * 0.015
               IF WS-FEE < 5.00
                   MOVE 5.00 TO WS-FEE
               END-IF
           END-IF
           IF IS-SAVINGS
               COMPUTE WS-INTEREST = ACCT-BALANCE * 0.035 / 12
               COMPUTE WS-TAX = WS-INTEREST * 0.28
               COMPUTE WS-NET-AMOUNT = WS-INTEREST - WS-TAX
           END-IF
           IF IS-LOAN
               COMPUTE WS-FEE = TXN-AMOUNT * 0.025
           END-IF.
       5000-UPDATE-DB.
           EXEC SQL
               UPDATE ACCOUNTS
               SET ACCT_BAL = :ACCT-BALANCE,
                   LAST_TXN_DT = :TXN-DATE,
                   TXN_COUNT = TXN_COUNT + 1
               WHERE ACCT_NO = :ACCT-NUMBER
           END-EXEC
           IF WS-SQLCODE NOT = 0
               MOVE 'Database update failed' TO WS-MSG
               MOVE 20 TO WS-RETURN-CODE
           END-IF
           EXEC CICS
               SEND MAP('ACCTMAP') MAPSET('ACCTSET')
           END-EXEC.
       9000-CLEANUP.
           DISPLAY 'Processed: ' WS-COUNTER ' transactions'
           DISPLAY 'Final balance: ' ACCT-BALANCE.
       9999-DEAD-PARA.
           DISPLAY 'THIS IS NEVER CALLED'.
           GO TO 9999-DEAD-PARA.`;

const SAMPLES = [
  { name: 'ACCTPROC.cbl', label: 'COBOL', code: SAMPLE_COBOL },
  { name: 'ORDER.rpgle', label: 'RPG', code: `**free
dcl-s orderId char(10);
dcl-s total packed(9:2);
dcl-ds orderDs qualified;
  id char(10);
  amount packed(7:2);
  status char(1);
end-ds;
dcl-proc processOrder export;
  dcl-pi *n;
    inOrder likeds(orderDs);
  end-pi;
  if inOrder.status = 'A';
    total += inOrder.amount;
  endif;
  exec sql
    update orders set processed = 'Y'
    where order_id = :inOrder.id;
end-proc;
begsr calcTax;
  total = total * 1.08;
endsr;` },
  { name: 'frmOrder.frm', label: 'VB6', code: `VERSION 5.00
Begin VB.Form frmOrder
   Begin VB.CommandButton cmdProcess
   End
   Begin VB.TextBox txtAmount
   End
End
Attribute VB_Name = "frmOrder"
Option Explicit
Private Sub cmdProcess_Click()
  Dim conn As New ADODB.Connection
  conn.Open "DSN=OrderDB"
  If Val(txtAmount.Text) > 1000 Then
    Set approval = CreateObject("Workflow.Approver")
    approval.RequestApproval
  End If
  On Error Resume Next
  conn.Execute "INSERT INTO orders VALUES(" & txtAmount.Text & ")"
End Sub
Public Function GetTotal() As Currency
  GetTotal = Val(txtAmount.Text) * 1.08
End Function` },
];
