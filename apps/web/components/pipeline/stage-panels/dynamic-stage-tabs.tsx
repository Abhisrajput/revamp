'use client';

import { useState, useMemo, memo, type ReactNode } from 'react';
import {
  FileText, Target, GitBranch, Database, AlertTriangle, HelpCircle,
  Rocket, Building2, BarChart3, Layers, BookOpen, Shield, Timer,
  Link2, ClipboardList, Calendar, FileCode, ArrowLeftRight,
  FlaskConical, Map as MapIcon, Maximize2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { parseMarkdownSections } from '@/lib/utils/markdown-sections';
import { StageOutput } from '@/components/pipeline/stage-output';
import { MermaidDiagram } from '@/components/pipeline/mermaid-diagram';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { usePipelineStore } from '@revamp/core/stores/pipeline-store';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────

interface TabStats {
  subHeadings: number;
  tableRows: number;
  codeBlocks: number;
  mermaidDiagrams: number;
  listItems: number;
}

export interface SpecialTab {
  id: string;
  title: string;
  icon: LucideIcon;
  position: 'before' | 'after';
  priority?: number;
  render: () => ReactNode;
}

export interface StageTabConfig {
  stageName: string;
  specialTabs?: SpecialTab[];
  prioritySections?: string[];
  includeFullOutput?: boolean;
}

interface DynamicStageTabsProps {
  output: string;
  stageIndex: number;
  config: StageTabConfig;
  onRefineRequest?: (context: {
    sectionTitle: string;
    sectionContent: string;
    userFeedback: string;
    fullText: string;
  }) => Promise<string>;
}

// ─── Icon Map ─────────────────────────────────────────────────

const SECTION_ICON_MAP: Array<{ keywords: string[]; icon: LucideIcon }> = [
  { keywords: ['executive summary', 'summary', 'overview'], icon: FileText },
  { keywords: ['business rule', 'rules inventory'], icon: Target },
  { keywords: ['workflow', 'process flow', 'user workflow', 'system workflow'], icon: GitBranch },
  { keywords: ['data model', 'data flow', 'entity', 'domain entit', 'persistence', 'er diagram'], icon: Database },
  { keywords: ['technical debt', 'tech debt', 'constraint', 'debt inventory'], icon: AlertTriangle },
  { keywords: ['open question', 'clarification', 'question'], icon: HelpCircle },
  { keywords: ['readiness', 'recommendation', 'migration readiness'], icon: Rocket },
  { keywords: ['architecture', 'target architecture', 'system design'], icon: Building2 },
  { keywords: ['technology decision', 'tech decision', 'technology stack'], icon: BarChart3 },
  { keywords: ['roadmap', 'migration roadmap', 'migration wave', 'wave'], icon: GitBranch },
  { keywords: ['risk register', 'risk'], icon: AlertTriangle },
  { keywords: ['cost model', 'cost', 'pricing', 'budget'], icon: BarChart3 },
  { keywords: ['capability', 'inventory'], icon: Layers },
  { keywords: ['bounded context', 'context'], icon: Layers },
  { keywords: ['diagram', 'mermaid'], icon: MapIcon },
  { keywords: ['feature file', 'gherkin', 'bdd', 'feature'], icon: BookOpen },
  { keywords: ['test execution', 'test result', 'test matrix'], icon: FlaskConical },
  { keywords: ['finding', 'validation finding'], icon: AlertTriangle },
  { keywords: ['traceability', 'trace'], icon: ClipboardList },
  { keywords: ['regression'], icon: ClipboardList },
  { keywords: ['comparison', 'behavioral'], icon: ArrowLeftRight },
  { keywords: ['performance', 'latency'], icon: Timer },
  { keywords: ['deviation'], icon: AlertTriangle },
  { keywords: ['verdict', 'cutover'], icon: Shield },
  { keywords: ['kpi', 'dashboard', 'metric'], icon: Target },
  { keywords: ['backlog', 'modernization backlog'], icon: ClipboardList },
  { keywords: ['decommission', 'legacy decommission'], icon: Calendar },
  { keywords: ['runbook', 'operational'], icon: FileCode },
  { keywords: ['integration', 'api', 'external'], icon: Link2 },
  { keywords: ['assumption', 'assumptions log'], icon: FileText },
  { keywords: ['security', 'auth'], icon: Shield },
  { keywords: ['service boundary', 'service'], icon: Building2 },
  { keywords: ['data ownership'], icon: Database },
];

function resolveIcon(title: string): LucideIcon {
  const lower = title.toLowerCase();
  // Try longest keywords first for precision
  for (const entry of SECTION_ICON_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.icon;
    }
  }
  return FileText;
}

// ─── Stats ────────────────────────────────────────────────────

function computeStats(content: string): TabStats {
  return {
    subHeadings: (content.match(/^#{3,4}\s/gm) || []).length,
    tableRows: Math.max(0, (content.match(/^\|[^-|]/gm) || []).length - 1), // exclude header row
    codeBlocks: (content.match(/^\s*```(?!mermaid)/gm) || []).length,
    mermaidDiagrams: (content.match(/^\s*```mermaid/gm) || []).length,
    listItems: (content.match(/^[-*]\s/gm) || []).length,
  };
}

function totalStats(sections: Array<{ stats: TabStats }>): TabStats {
  return sections.reduce(
    (acc, s) => ({
      subHeadings: acc.subHeadings + s.stats.subHeadings,
      tableRows: acc.tableRows + s.stats.tableRows,
      codeBlocks: acc.codeBlocks + s.stats.codeBlocks,
      mermaidDiagrams: acc.mermaidDiagrams + s.stats.mermaidDiagrams,
      listItems: acc.listItems + s.stats.listItems,
    }),
    { subHeadings: 0, tableRows: 0, codeBlocks: 0, mermaidDiagrams: 0, listItems: 0 },
  );
}

// ─── Title Cleanup & Slugify ─────────────────────────────────

/** Clean up section titles: remove "PART N:", "STAGE N:", numbering prefixes, emojis */
function cleanTitle(raw: string): string {
  return raw
    .replace(/^(?:PART|STAGE|SECTION)\s+\d+\s*[:—–-]\s*/i, '') // strip "PART 1: "
    .replace(/^(?:DECODE|BLUEPRINT|SPEC.?LOCK|ARCHITECT|FORGE|SHADOW.?RUN|EVOLVE)\s*[:—–-]\s*/i, '') // strip stage name prefix
    .replace(/^\d+\.\s*/, '') // strip "1. " numbering
    .trim();
}

function slugify(title: string): string {
  return cleanTitle(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Mermaid Extraction ───────────────────────────────────────

interface NamedDiagram {
  name: string;
  chart: string;
}

function extractDiagrams(content: string): NamedDiagram[] {
  const diagrams: NamedDiagram[] = [];
  const regex = /\s*```mermaid\s*\n([\s\S]*?)\s*```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const before = content.slice(0, match.index);
    const headingMatch = before.match(/(?:^|\n)#{1,4}\s+[\d.]*\s*(.*?)\s*$/);
    const name = headingMatch
      ? headingMatch[1].replace(/\(Mermaid\)/i, '').replace(/\*+/g, '').trim()
      : `Diagram ${diagrams.length + 1}`;
    diagrams.push({ name, chart: match[1].trim() });
  }
  return diagrams;
}

/** Sub-tab viewer for sections with Mermaid diagrams */
function DiagramSection({ content, heading }: { content: string; heading: string }) {
  const diagrams = useMemo(() => extractDiagrams(content), [content]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [popout, setPopout] = useState(false);

  if (diagrams.length === 0) {
    return <StageOutput output={`${heading}\n\n${content}`} isStreaming={false} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Diagram sub-tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        {diagrams.map((d, i) => (
          <button
            key={i}
            onClick={() => setActiveIdx(i)}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
              i === activeIdx
                ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
            )}
          >
            {d.name}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setPopout(true)}
          className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          title="Pop out diagram"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Active diagram */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4 bg-white dark:bg-slate-900 min-h-[300px]">
        <MermaidDiagram
          chart={diagrams[activeIdx]?.chart ?? ''}
          filename={diagrams[activeIdx]?.name ?? 'diagram'}
        />
      </div>

      {/* Non-diagram content (tables, text, etc.) below */}
      {(() => {
        const textOnly = content.replace(/\s*```mermaid[\s\S]*?```/g, '').trim();
        if (!textOnly) return null;
        return (
          <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
            <StageOutput output={textOnly} isStreaming={false} />
          </div>
        );
      })()}

      {/* Popout modal */}
      {popout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={() => setPopout(false)}>
          <div
            className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                {diagrams[activeIdx]?.name}
              </h3>
              <button onClick={() => setPopout(false)} className="text-slate-400 hover:text-slate-600">
                &times;
              </button>
            </div>
            <MermaidDiagram
              chart={diagrams[activeIdx]?.chart ?? ''}
              filename={diagrams[activeIdx]?.name ?? 'diagram'}
              fillHeight
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────

export const DynamicStageTabs = memo(function DynamicStageTabs({
  output,
  stageIndex,
  config,
  onRefineRequest,
}: DynamicStageTabsProps) {
  const { specialTabs = [], prioritySections = [], includeFullOutput = true } = config;

  // Parse sections from output — clean titles, merge tiny fragments, maintain document order
  const parsed = useMemo(() => {
    const rawSections = parseMarkdownSections(output);

    // Step 1: Tag each section with display info
    const seenSlugs = new Map<string, number>();
    const tagged = rawSections.map((s) => {
      const displayTitle = cleanTitle(s.title);
      let id = slugify(s.title);
      // Ensure unique IDs — append index suffix on collision
      const count = seenSlugs.get(id) ?? 0;
      seenSlugs.set(id, count + 1);
      if (count > 0) id = `${id}-${count}`;
      return {
        ...s,
        displayTitle,
        id,
        icon: resolveIcon(displayTitle),
        stats: computeStats(s.content),
        contentLength: s.content.length,
      };
    });

    // Step 2: Merge small sections (< 300 chars or title < 4 words) into previous section
    // This prevents fragments like "File: .env (lines 1-50)" or "AWS S3" from becoming tabs
    const MIN_CONTENT_LENGTH = 300;
    const MIN_TITLE_WORDS = 3;
    const merged: typeof tagged = [];

    for (const section of tagged) {
      const titleWords = section.displayTitle.split(/\s+/).length;
      const isTiny = section.contentLength < MIN_CONTENT_LENGTH && titleWords < MIN_TITLE_WORDS;
      const isFragment = section.displayTitle.startsWith('File:') ||
        section.displayTitle.startsWith('or:') ||
        section.displayTitle.match(/^[A-Z]{2,5}$/) || // "AWS", "GCP", etc.
        section.displayTitle.match(/^\d/) || // starts with number
        section.displayTitle.includes('lines ');

      if ((isTiny || isFragment) && merged.length > 0) {
        // Merge into previous section
        const prev = merged[merged.length - 1];
        prev.content += `\n\n${section.heading}\n\n${section.content}`;
        prev.stats = computeStats(prev.content);
        prev.contentLength = prev.content.length;
        prev.endOffset = section.endOffset;
      } else {
        merged.push({ ...section });
      }
    }

    // Step 3: Cap at 10 tabs — if still too many, group remaining under "Additional Details"
    if (merged.length > 10) {
      const keep = merged.slice(0, 9);
      const rest = merged.slice(9);
      const groupedContent = rest.map(s => `${s.heading}\n\n${s.content}`).join('\n\n');
      keep.push({
        ...rest[0],
        displayTitle: `Additional Details (${rest.length} sections)`,
        id: 'additional-details',
        icon: FileText,
        content: groupedContent,
        stats: computeStats(groupedContent),
        contentLength: groupedContent.length,
        endOffset: rest[rest.length - 1].endOffset,
      });
      return keep;
    }

    return merged;
  }, [output]);

  // Sort by priority config
  const sortedSections = useMemo(() => {
    if (prioritySections.length === 0) return parsed;

    const lowerPriority = prioritySections.map((p) => p.toLowerCase());
    const prioritized: typeof parsed = [];
    const rest: typeof parsed = [];

    // First pass: find sections matching priority list (in order)
    for (const pName of lowerPriority) {
      const match = parsed.find(
        (s) => s.displayTitle.toLowerCase().includes(pName.toLowerCase()) || pName.toLowerCase().includes(s.displayTitle.toLowerCase()),
      );
      if (match && !prioritized.includes(match)) {
        prioritized.push(match);
      }
    }

    // Second pass: remaining sections in document order
    for (const s of parsed) {
      if (!prioritized.includes(s)) {
        rest.push(s);
      }
    }

    return [...prioritized, ...rest];
  }, [parsed, prioritySections]);

  // Build full tab list: before-specials + dynamic + after-specials + full output
  const allTabs = useMemo(() => {
    const beforeSpecials = specialTabs
      .filter((t) => t.position === 'before')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    const afterSpecials = specialTabs
      .filter((t) => t.position === 'after')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    const dynamicTabs = sortedSections.map((s) => ({
      id: s.id,
      title: s.displayTitle,
      icon: s.icon,
      type: 'dynamic' as const,
      section: s,
    }));

    const specialBefore = beforeSpecials.map((t) => ({
      id: t.id,
      title: t.title,
      icon: t.icon,
      type: 'special' as const,
      render: t.render,
    }));

    const specialAfter = afterSpecials.map((t) => ({
      id: t.id,
      title: t.title,
      icon: t.icon,
      type: 'special' as const,
      render: t.render,
    }));

    const fullOutput = includeFullOutput
      ? [{
          id: 'full-output',
          title: 'Full Output',
          icon: FileText as LucideIcon,
          type: 'full-output' as const,
        }]
      : [];

    return [...specialBefore, ...dynamicTabs, ...specialAfter, ...fullOutput];
  }, [sortedSections, specialTabs, includeFullOutput]);

  // Aggregate stats
  const aggStats = useMemo(() => totalStats(sortedSections), [sortedSections]);

  // Active tab state
  const [activeTabId, setActiveTabId] = useState<string>(() =>
    allTabs.length > 0 ? allTabs[0].id : 'full-output',
  );

  // Ensure active tab exists (output may change)
  const resolvedActiveId = allTabs.find((t) => t.id === activeTabId) ? activeTabId : allTabs[0]?.id ?? 'full-output';
  const activeTab = allTabs.find((t) => t.id === resolvedActiveId);

  // Refine handler
  const handleRefine = (updated: string) => {
    usePipelineStore.getState().setStageOutput(stageIndex, updated);
  };

  // If no sections parsed, render entire output as markdown
  if (parsed.length === 0) {
    return <StageOutput output={output} isStreaming={false} />;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Stats Bar */}
      <div className="flex-shrink-0 flex items-center gap-4 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs">
        <span className="text-slate-500 font-medium">{sortedSections.length} sections</span>
        {aggStats.subHeadings > 0 && (
          <span className="text-slate-400">{aggStats.subHeadings} sub-sections</span>
        )}
        {aggStats.tableRows > 0 && (
          <span className="text-slate-400">{aggStats.tableRows} table rows</span>
        )}
        {aggStats.codeBlocks > 0 && (
          <span className="text-slate-400">{aggStats.codeBlocks} code blocks</span>
        )}
        {aggStats.mermaidDiagrams > 0 && (
          <span className="text-slate-400">{aggStats.mermaidDiagrams} diagrams</span>
        )}
      </div>

      {/* Tab Bar */}
      <div className="flex-shrink-0 flex gap-0.5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
        {allTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === resolvedActiveId;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap',
                isActive
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300',
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.title}
              {'section' in tab && tab.section && tab.section.stats.subHeadings > 0 && (
                <span className={cn(
                  'ml-1 text-[10px] px-1.5 py-0.5 rounded-full',
                  isActive ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                )}>
                  {tab.section.stats.subHeadings}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {activeTab?.type === 'dynamic' && 'section' in activeTab && activeTab.section && (
          activeTab.section.stats.mermaidDiagrams > 0 ? (
            <DiagramSection
              content={activeTab.section.content}
              heading={activeTab.section.heading}
            />
          ) : (
            <StageOutput
              output={`${activeTab.section.heading}\n\n${activeTab.section.content}`}
              isStreaming={false}
            />
          )
        )}

        {activeTab?.type === 'special' && 'render' in activeTab && activeTab.render()}

        {activeTab?.type === 'full-output' && (
          <RefinableMarkdown
            text={output}
            onSectionRefined={handleRefine}
            onRefineRequest={onRefineRequest}
          />
        )}
      </div>
    </div>
  );
});
