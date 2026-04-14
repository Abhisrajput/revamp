'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { Button } from '@revamp/ui/components/button';
import {
  Cpu, GitBranch, Layers, Activity, CheckCircle2,
  Clock, AlertTriangle, ChevronDown, ChevronUp,
  Puzzle, Network, Server, Code2, Braces,
  CircleDot, ArrowRight, Shield, X,
  Terminal, Database, Zap, ExternalLink, BarChart3,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Link from 'next/link';

// ─── API ───────────────────────────────────────────────────────────

const BREE_API = 'http://localhost:8081';

// ─── Types ─────────────────────────────────────────────────────────

interface LanguageItem {
  id: string;
  display_name: string;
  tier: string;
  family: string;
  parser_status: string;
  where_it_lives: string;
}
interface TierInfo {
  tier: string;
  build_months: string;
  language_count: number;
  languages: string[];
}
interface FamilyInfo {
  family: string;
  members: string[];
  shared_characteristics: string;
  llm_prompt_focus: string;
  key_concepts: string[];
}
interface ReadinessEntry {
  language_id: string;
  display_name: string;
  parser_status: string;
  has_registered_parser: boolean;
  nir_coverage_pct: number;
  estimated_dev_effort: string;
  recommended_backend: string;
}
interface ReadinessData {
  entries: ReadinessEntry[];
  overall_coverage: number;
  languages_with_parser: number;
  languages_without_parser: number;
}
interface PolyglotPattern {
  name: string;
  languages: string[];
  description: string;
  boundary_count: number;
}
interface BreeState {
  health: { status: string; service: string; version: string } | null;
  languages: { languages: LanguageItem[]; total: number } | null;
  tiers: { tiers: TierInfo[] } | null;
  families: FamilyInfo[] | null;
  readiness: ReadinessData | null;
  patterns: { patterns: PolyglotPattern[] } | null;
  loading: boolean;
  error: string | null;
}

// ─── Styles ────────────────────────────────────────────────────────

const CSS = `
@keyframes bree-up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes bree-draw{from{stroke-dashoffset:var(--c)}to{stroke-dashoffset:var(--o)}}
@keyframes bree-bar{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.b-enter{opacity:0;animation:bree-up .65s cubic-bezier(.16,1,.3,1) forwards}
.b-dot{background-image:radial-gradient(circle at 1px 1px,rgba(148,163,184,.06) 1px,transparent 0);background-size:20px 20px}
.dark .b-dot{background-image:radial-gradient(circle at 1px 1px,rgba(148,163,184,.03) 1px,transparent 0)}
`;

// ─── Tier/Status/Family Config ─────────────────────────────────────

const T: Record<string, {
  text: string; bg: string; border: string; badge: string;
  bar: string; dot: string; hover: string; grad: string;
}> = {
  'Tier 1': {
    text: 'text-rose-600 dark:text-rose-400',
    bg: 'bg-rose-500/[.03] dark:bg-rose-500/[.05]',
    border: 'border-rose-200/50 dark:border-rose-500/15',
    badge: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/10 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20',
    bar: 'bg-rose-500', dot: 'bg-rose-500',
    hover: 'hover:shadow-lg hover:shadow-rose-500/[.08] hover:-translate-y-0.5',
    grad: 'from-rose-500 to-rose-400',
  },
  'Tier 2': {
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/[.03] dark:bg-amber-500/[.05]',
    border: 'border-amber-200/50 dark:border-amber-500/15',
    badge: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/10 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
    bar: 'bg-amber-500', dot: 'bg-amber-500',
    hover: 'hover:shadow-lg hover:shadow-amber-500/[.08] hover:-translate-y-0.5',
    grad: 'from-amber-500 to-amber-400',
  },
  'Tier 3': {
    text: 'text-sky-600 dark:text-sky-400',
    bg: 'bg-sky-500/[.03] dark:bg-sky-500/[.05]',
    border: 'border-sky-200/50 dark:border-sky-500/15',
    badge: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/10 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20',
    bar: 'bg-sky-500', dot: 'bg-sky-500',
    hover: 'hover:shadow-lg hover:shadow-sky-500/[.08] hover:-translate-y-0.5',
    grad: 'from-sky-500 to-sky-400',
  },
  'Tier 4': {
    text: 'text-slate-500 dark:text-slate-400',
    bg: 'bg-slate-500/[.02] dark:bg-slate-400/[.03]',
    border: 'border-slate-200/50 dark:border-slate-600/20',
    badge: 'bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-600/10 dark:bg-slate-500/10 dark:text-slate-400 dark:ring-slate-400/15',
    bar: 'bg-slate-400', dot: 'bg-slate-400',
    hover: 'hover:shadow-lg hover:shadow-slate-400/[.08] hover:-translate-y-0.5',
    grad: 'from-slate-400 to-slate-300 dark:from-slate-500 dark:to-slate-400',
  },
};

const S: Record<string, { pill: string; dot: string }> = {
  Partial:   { pill: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300', dot: 'bg-violet-500' },
  Stub:      { pill: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300', dot: 'bg-blue-500' },
  Available: { pill: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300', dot: 'bg-emerald-500' },
  Planned:   { pill: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-300', dot: 'bg-yellow-500' },
  Community: { pill: 'bg-slate-50 text-slate-600 dark:bg-slate-500/10 dark:text-slate-400', dot: 'bg-slate-400' },
};

const FCLR: Record<string, { border: string; dot: string }> = {
  'IBM i':            { border: 'border-l-blue-500',    dot: 'bg-blue-500' },
  'Mainframe (z/OS)': { border: 'border-l-indigo-500',  dot: 'bg-indigo-500' },
  'NATURAL/Adabas':   { border: 'border-l-purple-500',  dot: 'bg-purple-500' },
  'SAP/ABAP':         { border: 'border-l-teal-500',    dot: 'bg-teal-500' },
  'Windows Legacy':   { border: 'border-l-cyan-500',    dot: 'bg-cyan-500' },
  'Web Legacy':       { border: 'border-l-orange-500',  dot: 'bg-orange-500' },
  'Scientific':       { border: 'border-l-emerald-500', dot: 'bg-emerald-500' },
  'Safety-Critical':  { border: 'border-l-red-500',     dot: 'bg-red-500' },
  'Database Logic':   { border: 'border-l-amber-500',   dot: 'bg-amber-500' },
};

// ─── Component ─────────────────────────────────────────────────────

export default function BreeEnginePage() {
  const [state, setState] = useState<BreeState>({
    health: null, languages: null, tiers: null,
    families: null, readiness: null, patterns: null,
    loading: true, error: null,
  });
  const [showAll, setShowAll] = useState(false);
  const [selectedFamily, setSelectedFamily] = useState<FamilyInfo | null>(null);
  const [selectedPattern, setSelectedPattern] = useState<PolyglotPattern | null>(null);

  const closeModal = useCallback(() => {
    setSelectedFamily(null);
    setSelectedPattern(null);
  }, []);

  const handlePromptSaved = useCallback((familyName: string, newPrompt: string) => {
    setState(prev => ({
      ...prev,
      families: prev.families?.map(f =>
        f.family === familyName ? { ...f, llm_prompt_focus: newPrompt } : f
      ) ?? null,
    }));
    // Also update the selected family in place
    setSelectedFamily(prev =>
      prev && prev.family === familyName ? { ...prev, llm_prompt_focus: newPrompt } : prev
    );
  }, []);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [closeModal]);

  useEffect(() => {
    const eps = [
      { k: 'health', p: '/health' },
      { k: 'languages', p: '/api/v1/languages' },
      { k: 'tiers', p: '/api/v1/tiers' },
      { k: 'families', p: '/api/v1/families' },
      { k: 'readiness', p: '/api/v1/readiness' },
      { k: 'patterns', p: '/api/v1/polyglot/patterns' },
    ];
    Promise.allSettled(
      eps.map(async (e) => {
        const r = await fetch(`${BREE_API}${e.p}`);
        if (!r.ok) throw new Error(`${e.k}: ${r.status}`);
        return { k: e.k, d: await r.json() };
      })
    ).then((results) => {
      const next: Partial<BreeState> = { loading: false, error: null };
      for (const r of results)
        if (r.status === 'fulfilled')
          (next as Record<string, unknown>)[r.value.k] = r.value.d;
      if (results.every((r) => r.status === 'rejected'))
        next.error = 'BREE Engine unreachable at ' + BREE_API;
      setState((p) => ({ ...p, ...next } as BreeState));
    });
  }, []);

  const online = state.health?.status === 'ok';
  const tk = (t: string) => t.split(' \u2014')[0];

  /* ── Loading ── */
  if (state.loading) return (
    <div className="max-w-[1200px] mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-4">
        <div className="w-11 h-11 rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
        <div className="space-y-2 flex-1">
          <div className="h-5 w-40 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
          <div className="h-3 w-64 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
        </div>
      </div>
      <div className="h-[180px] rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
      <div className="grid grid-cols-2 gap-4">
        {[0,1,2,3].map(i => <div key={i} className="h-48 rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" style={{ animationDelay: `${i*80}ms` }} />)}
      </div>
      <div className="h-64 rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
    </div>
  );

  /* ── Error ── */
  if (state.error && !state.languages) return (
    <div className="max-w-[1200px] mx-auto px-6 py-8">
      <Card className="overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-red-500 via-orange-400 to-red-500" />
        <CardContent className="p-16 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-5">
            <AlertTriangle className="w-7 h-7 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-2">BREE Engine Offline</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-6 max-w-md mx-auto">{state.error}</p>
          <code className="inline-flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-slate-900 dark:bg-slate-800 text-emerald-400 text-sm font-mono">
            <Terminal className="w-4 h-4 text-slate-500" />
            cd services/bree-engine &amp;&amp; cargo run
          </code>
        </CardContent>
      </Card>
    </div>
  );

  /* ── Data ── */
  const rd = state.readiness?.entries || [];
  const vis = showAll ? rd : rd.slice(0, 12);
  const covPct = Math.round((state.readiness?.overall_coverage || 0) * 100);
  const tiers = state.tiers?.tiers || [];
  const totalLangs = state.languages?.total || 0;
  const activeParsers = state.readiness?.languages_with_parser || 0;
  const numFamilies = state.families?.length || 0;

  return (
    <>
      <style>{CSS}</style>
      <div className="b-dot min-h-[calc(100vh-64px)]">
        {/* Status strip */}
        <div className={cn('h-[2px]', online ? 'bg-emerald-500' : 'bg-red-500')} />

        <div className="max-w-[1200px] mx-auto px-6 py-8 space-y-10">

          {/* ═══ HEADER ═══ */}
          <header className="b-enter flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4" style={{ animationDelay: '0ms' }}>
            <div className="flex items-center gap-3.5">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-md shadow-primary-600/20">
                <Cpu className="w-[22px] h-[22px] text-white" />
              </div>
              <div>
                <div className="flex items-baseline gap-2.5">
                  <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50 tracking-tight">
                    BREE Engine
                  </h1>
                  <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                    v{state.health?.version || '0.1.0'}
                  </span>
                </div>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Plugin-based legacy language detection &amp; analysis
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <Link href="/bree-engine/analyze">
                <Button size="sm" className="gap-1.5 shadow-sm">
                  <Zap className="w-3.5 h-3.5" /> Analyze
                </Button>
              </Link>
              <Link href={`${BREE_API}/api/docs`} target="_blank">
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ExternalLink className="w-3.5 h-3.5" /> API Docs
                </Button>
              </Link>
              <StatusPill online={online} />
            </div>
          </header>

          {/* ═══ OVERVIEW CARD ═══ */}
          <Card className="b-enter overflow-hidden" style={{ animationDelay: '80ms' }}>
            <CardContent className="p-0">
              <div className="flex flex-col lg:flex-row">
                {/* Left: Metrics */}
                <div className="grid grid-cols-2 gap-px bg-slate-200/50 dark:bg-slate-800/50 lg:w-[340px] shrink-0">
                  <Metric icon={Code2} label="Languages" value={totalLangs} sub="4 priority tiers" iconColor="text-blue-500" />
                  <Metric icon={CheckCircle2} label="Active Parsers" value={activeParsers} sub={`of ${totalLangs} registered`} iconColor="text-emerald-500" />
                  <Metric icon={Network} label="Families" value={numFamilies} sub="LLM strategies" iconColor="text-violet-500" />
                  <Metric icon={BarChart3} label="Patterns" value={state.patterns?.patterns.length || 0} sub="Polyglot boundaries" iconColor="text-orange-500" />
                </div>

                {/* Center: Donut */}
                <div className="flex items-center justify-center px-8 py-6 lg:py-0 border-t lg:border-t-0 lg:border-l border-slate-200/50 dark:border-slate-800/50">
                  <Donut pct={covPct} />
                </div>

                {/* Right: Tier Distribution */}
                <div className="flex-1 px-6 py-6 border-t lg:border-t-0 lg:border-l border-slate-200/50 dark:border-slate-800/50 flex flex-col justify-center min-w-0">
                  <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                    Tier Distribution
                  </p>
                  <TierBar tiers={tiers} />
                  <div className="flex items-center gap-4 mt-4 text-[11px] text-slate-400 dark:text-slate-500">
                    <span className="font-mono">{totalLangs} languages</span>
                    <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600" />
                    <span className="font-mono">{activeParsers} parsers</span>
                    <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600" />
                    <span className="font-mono">{numFamilies} families</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ═══ TIER CARDS ═══ */}
          <section className="b-enter" style={{ animationDelay: '180ms' }}>
            <SectionHead icon={Layers} title="Language Tiers" right={
              <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">Build priority timeline</span>
            } />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {tiers.map((tier, idx) => {
                const key = tk(tier.tier);
                const c = T[key] || T['Tier 4'];
                return (
                  <Card key={tier.tier} className={cn(
                    'overflow-hidden transition-all duration-200',
                    c.border, c.bg, c.hover,
                  )}>
                    <div className={cn('h-[3px] bg-gradient-to-r', c.grad)} />
                    <CardContent className="p-5 pt-4">
                      <div className="flex items-start justify-between mb-3.5">
                        <div className="flex items-center gap-3">
                          <span className={cn('text-[28px] font-bold font-mono leading-none tabular-nums', c.text)}>
                            {idx + 1}
                          </span>
                          <div>
                            <p className={cn('text-sm font-semibold', c.text)}>{tier.tier}</p>
                            <p className="text-[11px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">
                              {tier.build_months}
                            </p>
                          </div>
                        </div>
                        <Badge variant="secondary" className="text-[10px] font-mono tabular-nums">
                          {tier.language_count}
                        </Badge>
                      </div>
                      <div className="h-px bg-slate-200/60 dark:bg-slate-700/30 mb-3.5" />
                      <div className="flex flex-wrap gap-1.5">
                        {tier.languages.map(lang => (
                          <span key={lang} className={cn('inline-flex items-center px-2 py-[3px] rounded-md text-[11px] font-medium', c.badge)}>
                            {lang}
                          </span>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          {/* ═══ READINESS TABLE ═══ */}
          <section className="b-enter" style={{ animationDelay: '280ms' }}>
            <SectionHead icon={Puzzle} title="Parser Readiness" right={
              <Badge variant="secondary" className="text-[10px] font-mono">
                {activeParsers}/{rd.length} active
              </Badge>
            } />
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-900/60">
                      {['Language','Status','Parser','NIR Coverage','Dev Effort','Backend'].map((h, i) => (
                        <th key={h} className={cn(
                          'text-left py-2.5 px-4 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-200 dark:border-slate-800',
                          i === 4 && 'hidden lg:table-cell',
                          i === 5 && 'hidden xl:table-cell',
                        )}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {vis.map((e, i) => {
                      const s = S[e.parser_status] || S.Community;
                      const pct = Math.round(e.nir_coverage_pct * 100);
                      return (
                        <tr key={e.language_id} className={cn(
                          'border-b border-slate-100 dark:border-slate-800/40 transition-colors',
                          'hover:bg-slate-50/80 dark:hover:bg-slate-800/20',
                          i % 2 === 1 && 'bg-slate-50/40 dark:bg-slate-900/20',
                        )}>
                          <td className="py-2 px-4 font-medium text-slate-900 dark:text-slate-100">{e.language_id}</td>
                          <td className="py-2 px-4">
                            <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold', s.pill)}>
                              <span className={cn('w-1.5 h-1.5 rounded-full', s.dot)} />
                              {e.parser_status}
                            </span>
                          </td>
                          <td className="py-2 px-4">
                            {e.has_registered_parser
                              ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                              : <Clock className="w-4 h-4 text-slate-300 dark:text-slate-600" />}
                          </td>
                          <td className="py-2 px-4">
                            <div className="flex items-center gap-2.5">
                              <div className="w-[72px] h-[5px] bg-slate-200 dark:bg-slate-700/60 rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    'h-full rounded-full origin-left',
                                    pct >= 60 ? 'bg-emerald-500' : pct >= 30 ? 'bg-blue-500' : pct > 0 ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600',
                                  )}
                                  style={{ width: `${Math.max(pct, 3)}%`, animation: 'bree-bar .8s ease-out forwards', transformOrigin: 'left' }}
                                />
                              </div>
                              <span className={cn(
                                'text-[11px] font-mono tabular-nums font-semibold w-7 text-right',
                                pct >= 60 ? 'text-emerald-600 dark:text-emerald-400' :
                                pct >= 30 ? 'text-blue-600 dark:text-blue-400' :
                                'text-slate-500 dark:text-slate-400',
                              )}>
                                {pct}%
                              </span>
                            </div>
                          </td>
                          <td className="py-2 px-4 text-[12px] text-slate-500 dark:text-slate-400 hidden lg:table-cell">{e.estimated_dev_effort}</td>
                          <td className="py-2 px-4 text-[12px] text-slate-500 dark:text-slate-400 font-mono hidden xl:table-cell">{e.recommended_backend}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rd.length > 12 && (
                <button
                  onClick={() => setShowAll(!showAll)}
                  className="w-full py-2.5 text-[12px] text-primary-600 dark:text-primary-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors flex items-center justify-center gap-1 border-t border-slate-200 dark:border-slate-800"
                >
                  {showAll
                    ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
                    : <><ChevronDown className="w-3.5 h-3.5" /> Show all {rd.length} languages</>}
                </button>
              )}
            </Card>
          </section>

          {/* ═══ FAMILIES ═══ */}
          <section className="b-enter" style={{ animationDelay: '380ms' }}>
            <SectionHead icon={GitBranch} title="Language Families" right={
              <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">LLM prompt strategy per family</span>
            } />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {(state.families || []).map(fam => {
                const fc = FCLR[fam.family] || { border: 'border-l-slate-400', dot: 'bg-slate-400' };
                return (
                  <Card
                    key={fam.family}
                    className={cn(
                      'border-l-[3px] hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-pointer',
                      fc.border,
                    )}
                    onClick={() => setSelectedFamily(fam)}
                  >
                    <CardContent className="p-4 pt-4">
                      <div className="flex items-center gap-2 mb-2.5">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', fc.dot)} />
                        <h3 className="text-[13px] font-bold text-slate-900 dark:text-slate-50 truncate">{fam.family}</h3>
                      </div>
                      <p className="text-[12px] text-slate-500 dark:text-slate-400 leading-relaxed mb-3 line-clamp-2">
                        {fam.shared_characteristics}
                      </p>
                      <div className="flex flex-wrap gap-1 mb-3">
                        {fam.members.map(m => (
                          <span key={m} className="px-1.5 py-[2px] rounded text-[10px] font-semibold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                            {m}
                          </span>
                        ))}
                      </div>
                      {fam.key_concepts.length > 0 && (
                        <div className="border-t border-slate-200/50 dark:border-slate-800/50 pt-2.5">
                          <ul className="space-y-0.5">
                            {fam.key_concepts.slice(0, 3).map((c, i) => (
                              <li key={i} className="text-[11px] text-slate-400 dark:text-slate-500 flex items-start gap-1.5">
                                <CircleDot className="w-2.5 h-2.5 mt-0.5 shrink-0 opacity-40" />
                                <span>{c}</span>
                              </li>
                            ))}
                            {fam.key_concepts.length > 3 && (
                              <li className="text-[10px] text-primary-500 dark:text-primary-400 pl-4 font-medium">
                                +{fam.key_concepts.length - 3} more — click to expand
                              </li>
                            )}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          {/* ═══ POLYGLOT ═══ */}
          <section className="b-enter" style={{ animationDelay: '460ms' }}>
            <SectionHead icon={Activity} title="Polyglot Patterns" right={
              <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">Cross-language boundary detection</span>
            } />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {(state.patterns?.patterns || []).map(p => (
                <Card
                  key={p.name}
                  className="hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 group cursor-pointer"
                  onClick={() => setSelectedPattern(p)}
                >
                  <CardContent className="p-4 pt-4">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="text-[13px] font-bold text-slate-900 dark:text-slate-50">{p.name}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono font-semibold whitespace-nowrap ml-2 tabular-nums">
                        {p.boundary_count}
                      </span>
                    </div>
                    <p className="text-[12px] text-slate-500 dark:text-slate-400 leading-relaxed mb-3 line-clamp-2">{p.description}</p>
                    <div className="flex items-center gap-1 flex-wrap">
                      {p.languages.map((l, i) => (
                        <span key={l} className="flex items-center gap-1">
                          <span className="text-[11px] px-2 py-[2px] rounded-md bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-300 font-semibold ring-1 ring-inset ring-primary-600/10 dark:ring-primary-400/20">
                            {l}
                          </span>
                          {i < p.languages.length - 1 && (
                            <ArrowRight className="w-3 h-3 text-slate-300 dark:text-slate-600 group-hover:text-primary-500 transition-colors" />
                          )}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          {/* ═══ DETAIL MODALS ═══ */}
          {selectedFamily && (
            <FamilyModal
              family={selectedFamily}
              readiness={rd.filter(e => selectedFamily.members.includes(e.language_id))}
              onClose={closeModal}
              onPromptSaved={handlePromptSaved}
            />
          )}
          {selectedPattern && (
            <PatternModal
              pattern={selectedPattern}
              families={state.families || []}
              onClose={closeModal}
            />
          )}

          {/* ═══ FOOTER ═══ */}
          <footer className="b-enter border-t border-slate-200 dark:border-slate-800 pt-5 pb-2" style={{ animationDelay: '540ms' }}>
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-slate-400 dark:text-slate-500">
              <span className="flex items-center gap-1.5 font-mono">
                <Server className="w-3 h-3" /> {BREE_API}
              </span>
              <div className="flex items-center gap-5">
                <span className="flex items-center gap-1.5"><Braces className="w-3 h-3" /> Rust + Axum</span>
                <span className="flex items-center gap-1.5"><Database className="w-3 h-3" /> {totalLangs} parsers</span>
                <span className="flex items-center gap-1.5"><Shield className="w-3 h-3" /> LanguageParser trait</span>
              </div>
            </div>
          </footer>
        </div>
      </div>
    </>
  );
}

// ─── Sub-components ────────────────────────────────────────────────

function StatusPill({ online }: { online: boolean }) {
  return (
    <div className={cn(
      'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors',
      online
        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
        : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20',
    )}>
      <span className="relative flex h-2 w-2">
        {online && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />}
        <span className={cn('relative inline-flex rounded-full h-2 w-2', online ? 'bg-emerald-500' : 'bg-red-500')} />
      </span>
      {online ? 'Online' : 'Offline'}
    </div>
  );
}

function SectionHead({ icon: Icon, title, right }: {
  icon: typeof Layers; title: string; right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-2.5">
        <div className="w-1 h-5 rounded-full bg-primary-500" />
        <Icon className="w-4 h-4 text-slate-400 dark:text-slate-500" />
        <h2 className="text-[15px] font-bold text-slate-900 dark:text-slate-50 tracking-tight">{title}</h2>
      </div>
      {right}
    </div>
  );
}

function Metric({ icon: Icon, label, value, sub, iconColor }: {
  icon: typeof Code2; label: string; value: number; sub: string; iconColor: string;
}) {
  return (
    <div className="bg-white dark:bg-slate-950 p-4 flex flex-col justify-between min-h-[88px]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{label}</span>
        <Icon className={cn('w-4 h-4', iconColor)} />
      </div>
      <div>
        <span className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-50">{value}</span>
        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{sub}</p>
      </div>
    </div>
  );
}

function Donut({ pct }: { pct: number }) {
  const size = 130;
  const sw = 10;
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  const color = pct >= 60 ? 'stroke-emerald-500' : pct >= 30 ? 'stroke-primary-500' : 'stroke-amber-500';

  return (
    <div className="relative">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={sw}
          className="stroke-slate-200 dark:stroke-slate-800"
        />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={sw}
          strokeLinecap="round" className={color}
          strokeDasharray={circ} strokeDashoffset={offset}
          style={{
            '--c': circ, '--o': offset,
            animation: 'bree-draw 1.4s cubic-bezier(.16,1,.3,1) forwards',
          } as React.CSSProperties}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center rotate-0">
        <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-50 leading-none">
          {pct}<span className="text-sm font-semibold text-slate-400">%</span>
        </span>
        <span className="text-[9px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">
          Estimated
        </span>
      </div>
    </div>
  );
}

function TierBar({ tiers }: { tiers: TierInfo[] }) {
  const total = tiers.reduce((s, t) => s + t.language_count, 0) || 1;
  const colors = ['bg-rose-500', 'bg-amber-500', 'bg-sky-500', 'bg-slate-400'];
  const labels = ['T1', 'T2', 'T3', 'T4'];

  return (
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden gap-[2px]">
        {tiers.map((t, i) => (
          <div
            key={t.tier}
            className={cn(colors[i], 'transition-all duration-700 first:rounded-l-full last:rounded-r-full')}
            style={{ width: `${(t.language_count / total) * 100}%` }}
            title={`${tk(t.tier)}: ${t.language_count} languages`}
          />
        ))}
      </div>
      <div className="flex gap-5 mt-2.5">
        {tiers.map((t, i) => (
          <div key={t.tier} className="flex items-center gap-1.5">
            <div className={cn('w-2 h-2 rounded-[2px]', colors[i])} />
            <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
              {labels[i]}
            </span>
            <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 font-mono tabular-nums">
              {t.language_count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function tk(t: string) { return t.split(' \u2014')[0]; }

// ─── Detail Modals ─────────────────────────────────────────────────

function ModalBackdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200/60 dark:border-slate-700/60 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          <X className="w-4 h-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

function FamilyModal({ family, readiness, onClose, onPromptSaved }: {
  family: FamilyInfo;
  readiness: ReadinessEntry[];
  onClose: () => void;
  onPromptSaved: (family: string, newPrompt: string) => void;
}) {
  const fc = FCLR[family.family] || { border: 'border-l-slate-400', dot: 'bg-slate-400' };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(family.llm_prompt_focus);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const res = await fetch(`${BREE_API}/api/v1/families/${encodeURIComponent(family.family)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_prompt_focus: draft }),
      });
      if (res.ok) {
        setSaveStatus('saved');
        setEditing(false);
        onPromptSaved(family.family, draft);
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <div className={cn('h-1 rounded-t-2xl', fc.dot.replace('bg-', 'bg-gradient-to-r from-').concat(' to-transparent'))} />
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-1">
          <span className={cn('w-3 h-3 rounded-full shrink-0', fc.dot)} />
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">{family.family}</h2>
        </div>
        <p className="text-[13px] text-slate-500 dark:text-slate-400 leading-relaxed mb-5 ml-6">
          {family.shared_characteristics}
        </p>

        {/* Members with readiness */}
        <div className="mb-5">
          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2.5">
            Languages ({family.members.length})
          </p>
          <div className="grid gap-2">
            {family.members.map(m => {
              const r = readiness.find(e => e.language_id === m);
              const pct = r ? Math.round(r.nir_coverage_pct * 100) : 0;
              const s = r ? (S[r.parser_status] || S.Community) : S.Community;
              return (
                <div key={m} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 font-mono">{m}</span>
                    {r && (
                      <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold', s.pill)}>
                        <span className={cn('w-1.5 h-1.5 rounded-full', s.dot)} />
                        {r.parser_status}
                      </span>
                    )}
                  </div>
                  {r && (
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-[5px] bg-slate-200 dark:bg-slate-700/60 rounded-full overflow-hidden">
                        <div
                          className={cn('h-full rounded-full', pct >= 60 ? 'bg-emerald-500' : pct >= 30 ? 'bg-blue-500' : 'bg-amber-500')}
                          style={{ width: `${Math.max(pct, 3)}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-mono font-semibold text-slate-500 dark:text-slate-400 w-7 text-right tabular-nums">{pct}%</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Key Concepts — full list */}
        {family.key_concepts.length > 0 && (
          <div className="mb-5">
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2.5">
              Key Concepts ({family.key_concepts.length})
            </p>
            <ul className="space-y-1.5">
              {family.key_concepts.map((c, i) => (
                <li key={i} className="text-[12px] text-slate-600 dark:text-slate-300 flex items-start gap-2">
                  <CircleDot className="w-3 h-3 mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* LLM Prompt Strategy — Editable */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              LLM Prompt Strategy
            </p>
            <div className="flex items-center gap-2">
              {saveStatus === 'saved' && (
                <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Saved
                </span>
              )}
              {saveStatus === 'error' && (
                <span className="text-[10px] font-medium text-red-500 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Failed
                </span>
              )}
              {!editing ? (
                <button
                  onClick={() => { setDraft(family.llm_prompt_focus); setEditing(true); }}
                  className="px-2 py-0.5 text-[10px] font-medium text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded transition-colors"
                >
                  Edit
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => { setEditing(false); setSaveStatus('idle'); }}
                    className="px-2 py-0.5 text-[10px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 rounded transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving || draft === family.llm_prompt_focus}
                    className="px-2.5 py-0.5 text-[10px] font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="rounded-lg bg-primary-50/50 dark:bg-primary-900/10 border border-primary-200/40 dark:border-primary-700/20">
            {editing ? (
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={4}
                className="w-full px-3.5 py-3 text-[12px] text-primary-800 dark:text-primary-200 leading-relaxed bg-transparent resize-y outline-none rounded-lg min-h-[80px]"
                autoFocus
              />
            ) : (
              <p className="px-3.5 py-3 text-[12px] text-primary-800 dark:text-primary-200 leading-relaxed">
                {family.llm_prompt_focus}
              </p>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-400 dark:text-slate-500">
            Persisted to BREE Engine &middot; Changes apply immediately to analysis prompts
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-slate-200/60 dark:border-slate-800/60 flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
        >
          Close <span className="ml-1 text-[10px] text-slate-400 font-mono">ESC</span>
        </button>
      </div>
    </ModalBackdrop>
  );
}

function PatternModal({ pattern, families, onClose }: {
  pattern: PolyglotPattern;
  families: FamilyInfo[];
  onClose: () => void;
}) {
  // Find which family this pattern's languages belong to
  const relatedFamilies = families.filter(f =>
    f.members.some(m => pattern.languages.includes(m))
  );

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="h-1 rounded-t-2xl bg-gradient-to-r from-primary-500 to-primary-300 dark:from-primary-600 dark:to-primary-400" />
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-1 pr-8">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">{pattern.name}</h2>
          <span className="text-[11px] px-2.5 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 font-mono font-bold tabular-nums whitespace-nowrap">
            {pattern.boundary_count} boundaries
          </span>
        </div>
        <p className="text-[13px] text-slate-600 dark:text-slate-300 leading-relaxed mb-5">
          {pattern.description}
        </p>

        {/* Language Flow */}
        <div className="mb-5">
          <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
            Language Stack
          </p>
          <div className="flex items-center gap-2 flex-wrap px-3 py-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            {pattern.languages.map((l, i) => (
              <span key={l} className="flex items-center gap-2">
                <span className="text-[13px] px-3 py-1 rounded-md bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300 font-bold ring-1 ring-inset ring-primary-600/10 dark:ring-primary-400/20">
                  {l}
                </span>
                {i < pattern.languages.length - 1 && (
                  <ArrowRight className="w-4 h-4 text-slate-400 dark:text-slate-500" />
                )}
              </span>
            ))}
          </div>
        </div>

        {/* Related Family Details */}
        {relatedFamilies.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2.5">
              Related Families
            </p>
            <div className="space-y-3">
              {relatedFamilies.map(f => {
                const fc = FCLR[f.family] || { border: 'border-l-slate-400', dot: 'bg-slate-400' };
                return (
                  <div key={f.family} className={cn('px-3.5 py-3 rounded-lg border-l-[3px] bg-slate-50 dark:bg-slate-800/30', fc.border)}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={cn('w-2 h-2 rounded-full', fc.dot)} />
                      <span className="text-[12px] font-bold text-slate-900 dark:text-slate-100">{f.family}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      {f.shared_characteristics}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-slate-200/60 dark:border-slate-800/60 flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
        >
          Close <span className="ml-1 text-[10px] text-slate-400 font-mono">ESC</span>
        </button>
      </div>
    </ModalBackdrop>
  );
}
