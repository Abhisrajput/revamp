'use client';

import { memo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Cpu, FileCode2, AlertTriangle, CheckCircle, BarChart3,
  Network, Play, Loader2, ChevronDown, ChevronRight,
  GitBranch, Database, Code2, Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { usePipelineStore } from '@/lib/stores/pipeline-store';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';

// ─── Component ──────────────────────────────────────────────────

interface BreeOutputTabProps {
  stageName: string;
  className?: string;
}

export const BreeOutputTab = memo(function BreeOutputTab({ stageName, className }: BreeOutputTabProps) {
  const pipelineRunId = usePipelineStore((s) => s.currentPipelineRunId);
  const [deepData, setDeepData] = useState<any>(null);

  // Load basic BREE data from pipeline artifacts
  const { data: basicData, isLoading } = useQuery<any>({
    queryKey: ['bree-artifact', pipelineRunId, stageName],
    queryFn: async () => {
      if (!pipelineRunId) return null;
      const res = await apiClient.get(`/pipeline/${pipelineRunId}/artifacts/${stageName}`);
      const artifacts = res.data?.artifacts ?? res.data ?? [];
      const breeArt = artifacts.find((a: any) => a.artifact_type === 'bree_analysis');
      if (breeArt?.metadata) return breeArt.metadata;
      const scoutArt = artifacts.find((a: any) => a.artifact_type === 'scout_assessment');
      if (scoutArt?.metadata?.assessment) return { _scout: true, ...scoutArt.metadata.assessment };
      return null;
    },
    staleTime: 30_000,
    enabled: !!pipelineRunId,
  });

  // BREE health
  const { data: breeHealth } = useQuery<any>({
    queryKey: ['bree-health'],
    queryFn: async () => { try { return (await apiClient.get('/bree/readiness')).data; } catch { return null; } },
    staleTime: 60_000,
  });

  // Deep analysis mutation — calls server-side endpoint that reads files from disk
  const deepAnalysis = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post('/bree/deep-analyze', {
        pipeline_run_id: pipelineRunId,
        stage_name: stageName,
      });
      return res.data;
    },
    onSuccess: (data) => setDeepData(data),
  });

  const breeOnline = !!breeHealth;

  if (isLoading) {
    return (
      <div className={cn('p-4 space-y-3', className)}>
        {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-slate-200 dark:bg-slate-700 rounded-lg animate-pulse" />)}
      </div>
    );
  }

  if (!basicData && !deepData) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500', className)}>
        <Cpu className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-sm font-medium">No BREE Analysis Data</p>
        <p className="text-xs mt-1">
          {breeOnline ? 'Run the stage to generate analysis.' : 'BREE Engine is offline.'}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('p-4 space-y-4 overflow-auto', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-primary-500" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">BREE Engine Analysis</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn('text-[9px]', breeOnline
            ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-500',
          )}>
            {breeOnline ? 'online' : 'offline'}
          </Badge>
          {!deepData && breeOnline && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={() => deepAnalysis.mutate()}
              disabled={deepAnalysis.isPending}
            >
              {deepAnalysis.isPending ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing...</>
              ) : (
                <><Zap className="w-3 h-3" /> Run Deep Analysis</>
              )}
            </Button>
          )}
          {deepData && (
            <Badge className="text-[9px] bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400">
              deep analysis complete
            </Badge>
          )}
        </div>
      </div>

      {/* ─── BASIC SECTION (always shown) ──────────────────────── */}

      {/* Language Detection */}
      {basicData?.languages && (
        <Section title="Language Detection" icon={FileCode2}>
          <div className="space-y-1.5">
            {basicData.languages.primary?.map((lang: any, i: number) => (
              <LangRow key={`p-${i}`} lang={lang} tier="primary" />
            ))}
            {basicData.languages.secondary?.map((lang: any, i: number) => (
              <LangRow key={`s-${i}`} lang={lang} tier="secondary" />
            ))}
            {basicData.languages.configuration?.map((lang: any, i: number) => (
              <LangRow key={`c-${i}`} lang={lang} tier="config" />
            ))}
          </div>
        </Section>
      )}

      {/* From full BREE scan result */}
      {basicData?.scanResult?.language_profile && (
        <Section title="Language Profile" icon={FileCode2}>
          <div className="space-y-1.5">
            {[...(basicData.scanResult.language_profile.primary || []),
              ...(basicData.scanResult.language_profile.secondary || [])].map((lang: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-700 dark:text-slate-300">{lang.display_name}</span>
                  <Badge className="text-[9px] px-1 py-0 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400">
                    {lang.file_count} files
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-slate-500 tabular-nums">
                  <span>{lang.total_lines?.toLocaleString()} lines</span>
                  <span className="text-[9px] text-slate-400">{Math.round((lang.confidence || 0) * 100)}%</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Complexity (from scout) */}
      {basicData?.complexity && (
        <Section title="Complexity Overview" icon={BarChart3}>
          {typeof basicData.complexity === 'string' ? (
            <p className="text-xs text-slate-600 dark:text-slate-400">{basicData.complexity}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {basicData.complexity.level && <StatCard label="Level" value={basicData.complexity.level} warn={basicData.complexity.level === 'high'} />}
              {basicData.complexity.totalFiles && <StatCard label="Total Files" value={String(basicData.complexity.totalFiles)} />}
              {basicData.complexity.totalLines && <StatCard label="Total Lines" value={basicData.complexity.totalLines.toLocaleString()} />}
              {basicData.complexity.estimatedComponents && <StatCard label="Components" value={String(basicData.complexity.estimatedComponents)} />}
              {basicData.complexity.largestModule && (
                <div className="col-span-2 bg-slate-50 dark:bg-slate-900 rounded p-2">
                  <p className="text-[9px] text-slate-400 uppercase tracking-wider">Largest Module</p>
                  <p className="text-xs font-mono text-slate-700 dark:text-slate-300 mt-0.5">{basicData.complexity.largestModule}</p>
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {/* Risks (from scout) */}
      {basicData?.risks && Array.isArray(basicData.risks) && basicData.risks.length > 0 && (
        <Section title="Identified Risks" icon={AlertTriangle}>
          <div className="space-y-1.5">
            {basicData.risks.map((risk: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-[11px]">
                <AlertTriangle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                <span className="text-slate-600 dark:text-slate-400">
                  {typeof risk === 'string' ? risk : risk.description || risk.message || JSON.stringify(risk)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ─── DEEP ANALYSIS SECTION (after button click) ────────── */}

      {deepData && (
        <>
          <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-amber-500" />
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Deep Analysis Results</span>
            </div>
          </div>

          {/* Deep Language Profile */}
          {deepData.languageProfile?.primary?.length > 0 && (
            <Section title="Language Profile (Deep Scan)" icon={FileCode2}>
              <div className="space-y-1.5">
                {[...(deepData.languageProfile.primary || []), ...(deepData.languageProfile.secondary || [])].map((lang: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-700 dark:text-slate-300">{lang.display_name || lang.language_id}</span>
                      <Badge className="text-[9px] px-1 py-0 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                        {lang.file_count} files
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-slate-500 tabular-nums">
                      <span>{(lang.total_lines || 0).toLocaleString()} lines</span>
                      <span className="text-[9px] text-slate-400">{Math.round((lang.confidence || 0) * 100)}%</span>
                    </div>
                  </div>
                ))}
              </div>
              {deepData.languageProfile.stats && (
                <div className="flex gap-3 mt-2 pt-2 border-t border-slate-100 dark:border-slate-700 text-[10px] text-slate-400">
                  <span>{deepData.languageProfile.stats.total_files} files scanned</span>
                  <span>{deepData.languageProfile.stats.classified_files} classified</span>
                  <span>{deepData.languageProfile.stats.unclassified_files} unclassified</span>
                </div>
              )}
            </Section>
          )}

          {/* Files Analyzed count */}
          {deepData.filesAnalyzed > 0 && (
            <p className="text-[10px] text-slate-400 text-right">
              {deepData.filesAnalyzed} source files sent to BREE for analysis
            </p>
          )}

          {/* Analysis Summary */}
          {deepData.analysisReport?.summary && (
            <Section title="Analysis Summary" icon={BarChart3}>
              <div className="grid grid-cols-3 gap-2">
                <StatCard label="Files" value={String(deepData.analysisReport.summary.total_files || 0)} />
                <StatCard label="Lines" value={(deepData.analysisReport.summary.total_lines || 0).toLocaleString()} />
                <StatCard label="Languages" value={String(deepData.analysisReport.summary.languages_detected || 0)} />
                <StatCard label="Parsers Used" value={String(deepData.analysisReport.summary.parsers_used || 0)} />
                <StatCard label="Files Parsed" value={String(deepData.analysisReport.summary.files_parsed || 0)} />
                <StatCard label="Cross-lang Calls" value={String(deepData.analysisReport.summary.cross_language_calls || 0)} />
              </div>
            </Section>
          )}

          {/* Dead Code */}
          {deepData.graphAnalysis?.dead_code && (
            <Section title="Dead Code Analysis" icon={Code2}>
              <div className="grid grid-cols-2 gap-2">
                <StatCard
                  label="Dead Code"
                  value={`${((deepData.graphAnalysis.dead_code.dead_code_pct || 0) * 100).toFixed(0)}%`}
                  warn={(deepData.graphAnalysis.dead_code.dead_code_pct || 0) > 0.1}
                />
                <StatCard label="Unreachable" value={`${(deepData.graphAnalysis.dead_code.unreachable_paragraphs || []).length}`} />
              </div>
              {(deepData.graphAnalysis.dead_code.unused_variables || []).length > 0 && (
                <CollapsibleList
                  title={`${deepData.graphAnalysis.dead_code.unused_variables.length} unused variables`}
                  items={deepData.graphAnalysis.dead_code.unused_variables.map((v: any) => typeof v === 'string' ? v : v.name || JSON.stringify(v))}
                />
              )}
            </Section>
          )}

          {/* Complexity (deep) */}
          {deepData.graphAnalysis?.complexity && (
            <Section title="Cyclomatic Complexity" icon={BarChart3}>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <StatCard label="Average" value={deepData.graphAnalysis.complexity.average_complexity?.toFixed(1) || '0'} />
                <StatCard label="Maximum" value={String(deepData.graphAnalysis.complexity.max_complexity || 0)} warn={(deepData.graphAnalysis.complexity.max_complexity || 0) > 10} />
              </div>
              {deepData.graphAnalysis.complexity.functions?.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-auto">
                  {deepData.graphAnalysis.complexity.functions
                    .sort((a: any, b: any) => b.complexity - a.complexity)
                    .slice(0, 15)
                    .map((f: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-[11px] py-0.5">
                        <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{f.name}</span>
                        <Badge className={cn('text-[9px] px-1.5',
                          f.risk === 'critical' || f.risk === 'high'
                            ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                            : f.risk === 'medium'
                              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                              : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
                        )}>
                          {f.complexity} ({f.risk})
                        </Badge>
                      </div>
                    ))}
                </div>
              )}
            </Section>
          )}

          {/* Business Rules */}
          {deepData.graphAnalysis?.business_rules?.total_rules > 0 && (
            <Section title="Business Rules Extracted" icon={CheckCircle}>
              <p className="text-xs text-slate-500 mb-2">
                {deepData.graphAnalysis.business_rules.total_rules} rules found —{' '}
                {deepData.graphAnalysis.business_rules.rules?.filter((r: any) => r.confidence >= 0.9).length || 0} high confidence
              </p>
              <div className="space-y-1.5 max-h-60 overflow-auto">
                {deepData.graphAnalysis.business_rules.rules?.slice(0, 20).map((rule: any, i: number) => (
                  <div key={i} className="text-[11px] py-1.5 px-2 bg-slate-50 dark:bg-slate-900 rounded border-l-2 border-primary-400">
                    <div className="flex items-center justify-between gap-2">
                      <Badge className="text-[8px] px-1 py-0 bg-slate-200 dark:bg-slate-700 text-slate-500 shrink-0">{rule.rule_type}</Badge>
                      <span className="text-[9px] text-slate-400 tabular-nums">{Math.round((rule.confidence || 0) * 100)}%</span>
                    </div>
                    <p className="text-slate-700 dark:text-slate-300 mt-0.5">{rule.description}</p>
                    {rule.hardcoded_values?.length > 0 && (
                      <p className="text-[9px] text-amber-600 dark:text-amber-400 mt-0.5">
                        Hardcoded: {rule.hardcoded_values.map((v: any) => typeof v === 'string' ? v : v.value).join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Call Graph */}
          {deepData.graphAnalysis?.call_graph && (
            <Section title="Call Graph" icon={Network}>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <StatCard label="Nodes" value={String(deepData.graphAnalysis.call_graph.stats?.total_nodes || 0)} />
                <StatCard label="Edges" value={String(deepData.graphAnalysis.call_graph.stats?.total_edges || 0)} />
              </div>
              {deepData.graphAnalysis.call_graph.mermaid && (
                <div className="mt-2">
                  <MermaidDiagram chart={deepData.graphAnalysis.call_graph.mermaid} className="max-h-96" />
                </div>
              )}
            </Section>
          )}

          {/* Data Lineage */}
          {deepData.graphAnalysis?.data_lineage && (
            <Section title="Data Lineage" icon={Database}>
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Total Fields" value={String(deepData.graphAnalysis.data_lineage.total_fields || 0)} />
                <StatCard label="Read+Write" value={String(deepData.graphAnalysis.data_lineage.read_write || 0)} />
                {deepData.graphAnalysis.data_lineage.write_only > 0 && (
                  <StatCard label="Write Only" value={String(deepData.graphAnalysis.data_lineage.write_only)} warn />
                )}
                {deepData.graphAnalysis.data_lineage.read_only > 0 && (
                  <StatCard label="Read Only" value={String(deepData.graphAnalysis.data_lineage.read_only)} />
                )}
              </div>
            </Section>
          )}

          {/* Requirements Documents — filter out empty skeletons */}
          {deepData.requirements?.documents?.filter((doc: any) =>
            (doc.functional_requirements?.length > 0) ||
            (doc.data_dictionary?.length > 0) ||
            (doc.hardcoded_values?.length > 0) ||
            (doc.integration_points?.database_tables?.length > 0) ||
            (doc.integration_points?.external_programs?.length > 0) ||
            (doc.integration_points?.copybooks?.length > 0)
          ).length > 0 && (
            <Section title="Requirements Documents" icon={FileCode2}>
              {deepData.requirements.documents.filter((doc: any) =>
                (doc.functional_requirements?.length > 0) ||
                (doc.data_dictionary?.length > 0) ||
                (doc.hardcoded_values?.length > 0) ||
                (doc.integration_points?.database_tables?.length > 0) ||
                (doc.integration_points?.external_programs?.length > 0) ||
                (doc.integration_points?.copybooks?.length > 0)
              ).map((doc: any, i: number) => (
                <div key={i} className="p-2 bg-slate-50 dark:bg-slate-900 rounded mb-2 last:mb-0">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">{doc.program_id}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{doc.program_description}</p>
                  <div className="flex flex-wrap gap-2 mt-1.5">
                    <MiniStat label="Requirements" value={doc.functional_requirements?.length || 0} />
                    <MiniStat label="Data Fields" value={doc.data_dictionary?.length || 0} />
                    <MiniStat label="Hardcoded Values" value={doc.hardcoded_values?.length || 0} warn={(doc.hardcoded_values?.length || 0) > 0} />
                    <MiniStat label="DB Tables" value={doc.integration_points?.database_tables?.length || 0} />
                    <MiniStat label="External Programs" value={doc.integration_points?.external_programs?.length || 0} />
                    <MiniStat label="Copybooks" value={doc.integration_points?.copybooks?.length || 0} />
                  </div>
                  {doc.process_flow?.length > 0 && (
                    <p className="text-[9px] text-slate-400 mt-1.5 font-mono">
                      Flow: {doc.process_flow.map((s: any) => s.paragraph).join(' → ')}
                    </p>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* Dependencies */}
          {deepData.analysisReport?.dependencies?.length > 0 && (
            <Section title="Dependencies" icon={GitBranch}>
              <div className="space-y-1 max-h-40 overflow-auto">
                {deepData.analysisReport.dependencies.slice(0, 15).map((dep: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{dep.from_module}</span>
                    <span className="text-slate-400">→</span>
                    <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{dep.to_module}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Polyglot Boundaries */}
          {deepData.analysisReport?.polyglot_boundaries?.length > 0 && (
            <Section title="Cross-Language Boundaries" icon={Code2}>
              <div className="space-y-1.5">
                {deepData.analysisReport.polyglot_boundaries.map((pb: any, i: number) => (
                  <div key={i} className="text-[11px] p-1.5 bg-slate-50 dark:bg-slate-900 rounded">
                    <span className="font-mono text-blue-600 dark:text-blue-400">{pb.from_language}</span>
                    <span className="text-slate-400 mx-1">({pb.mechanism})</span>
                    <span className="text-slate-400">→</span>
                    <span className="font-mono text-green-600 dark:text-green-400 ml-1">{pb.to_language}</span>
                    <span className="text-slate-400 text-[9px] ml-2">line {pb.line}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Priority Scores */}
          {deepData.analysisReport?.priority_scores?.length > 0 && (
            <Section title="Modernization Priority" icon={Zap}>
              <div className="space-y-1">
                {deepData.analysisReport.priority_scores.map((p: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-slate-400 w-4">#{p.rank}</span>
                      <span className="text-slate-700 dark:text-slate-300">{p.display_name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className="text-[9px] px-1 py-0 bg-slate-100 dark:bg-slate-700 text-slate-500">{p.tier}</Badge>
                      <span className="text-slate-400 tabular-nums text-[10px]">{p.weighted_score?.toFixed(1)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* LLM Strategy */}
          {deepData.llmStrategy?.recommendation && (
            <Section title="LLM Strategy Recommendation" icon={Cpu}>
              <p className="text-xs text-slate-600 dark:text-slate-300">{deepData.llmStrategy.recommendation}</p>
              {deepData.llmStrategy.families_detected?.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {deepData.llmStrategy.families_detected.map((fam: any, i: number) => (
                    <div key={i} className="p-2 bg-slate-50 dark:bg-slate-900 rounded text-[11px]">
                      <p className="font-medium text-slate-700 dark:text-slate-300">{fam.family}</p>
                      <p className="text-slate-400 mt-0.5">Languages: {fam.languages_in_project?.join(', ')}</p>
                      {fam.prompt_focus && <p className="text-slate-500 mt-0.5 italic">{fam.prompt_focus}</p>}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}
        </>
      )}

      {/* Deep analysis error */}
      {deepAnalysis.isError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800/50">
          <p className="text-xs text-red-700 dark:text-red-400">Deep analysis failed. BREE Engine may not have access to the codebase files.</p>
        </div>
      )}
    </div>
  );
});

// ─── Sub-components ─────────────────────────────────────────────

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className="w-3.5 h-3.5 text-slate-400" />
        <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">{title}</h4>
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-slate-50 dark:bg-slate-900 rounded p-2 text-center">
      <p className={cn('text-lg font-bold', warn ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100')}>
        {value}
      </p>
      <p className="text-[9px] text-slate-400 uppercase tracking-wider">{label}</p>
    </div>
  );
}

function MiniStat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <span className={cn('text-[9px] px-1.5 py-0.5 rounded', warn
      ? 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
      : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
    )}>
      {value} {label}
    </span>
  );
}

function LangRow({ lang, tier }: { lang: any; tier: string }) {
  const name = typeof lang === 'string' ? lang : lang.display_name || lang.language_id || lang;
  const tierColors: Record<string, string> = {
    primary: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    secondary: 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
    config: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      <Badge className={cn('text-[9px] px-1.5 py-0', tierColors[tier] || tierColors.secondary)}>{tier}</Badge>
      <span className="text-slate-700 dark:text-slate-300">{name}</span>
      {typeof lang === 'object' && lang.file_count && (
        <span className="text-slate-400 text-[10px] ml-auto">{lang.file_count} files · {lang.total_lines?.toLocaleString()} lines</span>
      )}
    </div>
  );
}

function CollapsibleList({ title, items }: { title: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
      </button>
      {open && (
        <div className="mt-1 pl-4 space-y-0.5 max-h-32 overflow-auto">
          {items.map((item, i) => (
            <p key={i} className="text-[10px] font-mono text-slate-500">{item}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function CollapsibleCode({ title, code }: { title: string; code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-slate-900 text-slate-300 text-[10px] rounded overflow-auto max-h-48 font-mono">{code}</pre>
      )}
    </div>
  );
}
