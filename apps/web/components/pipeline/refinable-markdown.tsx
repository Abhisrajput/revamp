'use client';

import { useState, useCallback, useRef, useEffect, memo, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { Pencil, X, Loader2, Send } from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { cn } from '@/lib/utils';
import {
  parseMarkdownSections,
  replaceSectionContent,
  getPreSectionText,
  getPostSectionText,
  type MarkdownSection,
} from '@revamp/core/utils/markdown-sections';
import { StageOutput } from './stage-output';

// --- Types ---

interface RefinableMarkdownProps {
  /** The full markdown text */
  text: string;
  /** Called when a section has been refined with updated full text */
  onSectionRefined: (updatedText: string) => void;
  /** Function to call for refinement — receives context and returns refined content */
  onRefineRequest?: (context: {
    sectionTitle: string;
    sectionContent: string;
    userFeedback: string;
    fullText: string;
  }) => Promise<string>;
  /** Disable refinement controls */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

interface RefineState {
  sectionTitle: string;
  feedback: string;
  loading: boolean;
  error: string | null;
}

// --- Component ---

export const RefinableMarkdown = memo(function RefinableMarkdown({
  text,
  onSectionRefined,
  onRefineRequest,
  disabled = false,
  className,
}: RefinableMarkdownProps) {
  const [refineState, setRefineState] = useState<RefineState | null>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Focus textarea when refine opens
  useEffect(() => {
    if (refineState && !refineState.loading && feedbackRef.current) {
      feedbackRef.current.focus();
    }
  }, [refineState?.sectionTitle]);

  const normalizedText = useMemo(() => normalizeMarkdown(text), [text]);
  const sections = useMemo(() => parseMarkdownSections(normalizedText), [normalizedText]);

  const handleRefine = useCallback(
    async (section: MarkdownSection) => {
      if (!refineState || refineState.loading || !refineState.feedback.trim() || !onRefineRequest) return;

      setRefineState((prev) => (prev ? { ...prev, loading: true, error: null } : null));

      try {
        const newContent = await onRefineRequest({
          sectionTitle: section.title,
          sectionContent: section.content,
          userFeedback: refineState.feedback,
          fullText: normalizedText,
        });

        if (!mountedRef.current) return;
        const updated = replaceSectionContent(normalizedText, section, newContent);
        onSectionRefined(updated);
        setRefineState(null);
      } catch (err: unknown) {
        if (mountedRef.current) {
          const message = err instanceof Error ? err.message : 'Refinement failed. Please try again.';
          setRefineState((prev) => (prev ? { ...prev, loading: false, error: message } : null));
        }
      }
    },
    [refineState, normalizedText, onSectionRefined, onRefineRequest],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, section: MarkdownSection) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleRefine(section);
      }
      if (e.key === 'Escape') {
        setRefineState(null);
      }
    },
    [handleRefine],
  );

  // If no sections found, refinement disabled, or output is very large, render as plain output.
  // Large outputs (>20K) cause section parsing to produce overlapping fragments.
  if (disabled || !onRefineRequest || sections.length === 0 || normalizedText.length > 20000) {
    return <StageOutput output={normalizedText} isStreaming={false} />;
  }

  const preText = getPreSectionText(normalizedText, sections);
  const postText = getPostSectionText(normalizedText, sections);

  return (
    <div className={cn('rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 overflow-hidden', className)}>
      <div className="p-4 space-y-0">
        {/* Pre-section content */}
        {preText.trim() && (
          <div
            className="stage-output text-sm text-slate-700 dark:text-slate-300 mb-2"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimple(preText)) }}
          />
        )}

        {sections.map((section) => {
          const isRefining = refineState?.sectionTitle === section.title;

          return (
            <div key={`${section.title}-${section.startOffset}`} className="group relative">
              {/* Section heading with refine button */}
              <div className="flex items-center gap-2 mt-3">
                <div
                  className="stage-output text-sm text-slate-700 dark:text-slate-300 flex-1 font-semibold"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimple(section.heading)) }}
                />
                {!isRefining && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-xs text-slate-500 hover:text-primary-600"
                    onClick={() =>
                      setRefineState({ sectionTitle: section.title, feedback: '', loading: false, error: null })
                    }
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    Refine
                  </Button>
                )}
              </div>

              {/* Refine input area */}
              {isRefining && (
                <div className="my-2 rounded-lg border border-primary-200 dark:border-primary-800 bg-white dark:bg-slate-950 p-3 space-y-2">
                  <textarea
                    ref={feedbackRef}
                    placeholder={`How should "${section.title}" be improved?`}
                    value={refineState.feedback}
                    onChange={(e) =>
                      setRefineState((prev) => (prev ? { ...prev, feedback: e.target.value, error: null } : null))
                    }
                    onKeyDown={(e) => handleKeyDown(e, section)}
                    className="w-full text-sm min-h-[60px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 resize-none"
                    disabled={refineState.loading}
                  />
                  {refineState.error && (
                    <p className="text-xs text-red-600 dark:text-red-400 px-1">{refineState.error}</p>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-400">
                      ⌘+Enter to submit · Esc to cancel
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={refineState.loading}
                        onClick={() => setRefineState(null)}
                      >
                        <X className="h-3 w-3 mr-1" />
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!refineState.feedback.trim() || refineState.loading}
                        onClick={() => handleRefine(section)}
                      >
                        {refineState.loading ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Send className="h-3 w-3 mr-1" />
                        )}
                        Regenerate
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Section content */}
              <div
                className="stage-output text-sm text-slate-700 dark:text-slate-300 overflow-x-auto"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimple(section.content)) }}
              />
            </div>
          );
        })}

        {/* Post-section content */}
        {postText.trim() && (
          <div
            className="stage-output text-sm text-slate-700 dark:text-slate-300 mt-2"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimple(postText)) }}
          />
        )}
      </div>
    </div>
  );
});

/** Sanitize HTML output from markdown renderer to prevent XSS */
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  });
}

// --- Simple markdown renderer (reuses logic from StageOutput) ---

function normalizeMarkdown(text: string): string {
  let out = text.replace(/<br\s*\/?>/gi, '\n');
  const newlineCount = (out.match(/\n/g) || []).length;
  if (out.length > 200 && newlineCount > out.length / 500) return out;
  out = out.replace(/([^\n])(\s*)(#{1,3} )/g, '$1\n\n$3');
  out = out.replace(/([^\n])(\s*)(\*\*[A-Z][^*]{1,60}:?\*\*)/g, '$1\n$3');
  out = out.replace(/([^\n])(\s{2,})([-*] )/g, '$1\n$3');
  out = out.replace(/([^\n])(\s{2,})(\d+\. )/g, '$1\n$3');
  out = out.replace(/([^\n])(```)/g, '$1\n$2');
  out = out.replace(/([^\n])(\s*---+\s*)/g, '$1\n$2');
  out = out.replace(/([^\n])(\s*\|[^|]+\|)/g, '$1\n$2');
  out = out.replace(/([^\n])([\u2705\u26A0\uFE0F\u{1F534}\u{1F4CA}\u{1F6A8}])/gu, '$1\n$2');
  out = out.replace(/\n{4,}/g, '\n\n\n');
  return out;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  return out;
}

function renderSimple(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = '';
  let inTable = false;
  let tableRows: string[][] = [];
  let tableAlignments: string[] = [];

  function flushTable() {
    if (tableRows.length === 0) return;
    let html = '<div class="overflow-x-auto my-3 border border-slate-200 dark:border-slate-700 rounded-md"><table class="w-full border-collapse text-[11px]" style="table-layout:auto">';
    for (let r = 0; r < tableRows.length; r++) {
      const tag = r === 0 ? 'th' : 'td';
      if (r === 0) html += '<thead>';
      if (r === 1) html += '<tbody>';
      html += '<tr>';
      for (let c = 0; c < tableRows[r].length; c++) {
        const align = tableAlignments[c] ? ` style="text-align:${tableAlignments[c]}"` : '';
        const cls = r === 0
          ? 'bg-slate-100 dark:bg-slate-800 font-semibold text-left px-2 py-1.5 border border-slate-200 dark:border-slate-700 text-[10px]'
          : 'px-2 py-1.5 border border-slate-200 dark:border-slate-700 break-words align-top';
        html += `<${tag} class="${cls}"${align}>${formatInline(tableRows[r][c].trim())}</${tag}>`;
      }
      html += '</tr>';
      if (r === 0) html += '</thead>';
    }
    if (tableRows.length > 1) html += '</tbody>';
    html += '</table></div>';
    result.push(html);
    tableRows = [];
    tableAlignments = [];
    inTable = false;
  }

  for (const line of lines) {
    if (line.startsWith('```') && !inCodeBlock) {
      if (inTable) flushTable();
      inCodeBlock = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
      continue;
    }
    if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false;
      const label = codeLang ? `<span class="text-[10px] text-slate-500 uppercase tracking-wider">${escapeHtml(codeLang)}</span>` : '';
      result.push(`<div class="my-2 rounded bg-slate-800 border border-slate-700 overflow-hidden">${label ? `<div class="px-3 py-1 bg-slate-900/60">${label}</div>` : ''}<pre class="px-3 py-2 overflow-x-auto"><code class="text-xs text-slate-200 font-mono">${codeLines.join('\n')}</code></pre></div>`);
      continue;
    }
    if (inCodeBlock) { codeLines.push(escapeHtml(line)); continue; }

    // Table detection
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line.trim().slice(1, -1).split('|');
      if (cells.every((c) => /^\s*:?-+:?\s*$/.test(c))) {
        tableAlignments = cells.map((c) => {
          const t = c.trim();
          if (t.startsWith(':') && t.endsWith(':')) return 'center';
          if (t.endsWith(':')) return 'right';
          return 'left';
        });
        inTable = true;
        continue;
      }
      tableRows.push(cells);
      inTable = true;
      continue;
    }
    if (inTable) flushTable();

    if (line.startsWith('### ')) { result.push(`<h3 class="text-base font-semibold mt-3 mb-1 text-slate-900 dark:text-slate-100">${escapeHtml(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('## ')) { result.push(`<h2 class="text-lg font-semibold mt-4 mb-1 text-slate-900 dark:text-slate-100">${escapeHtml(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('# ')) { result.push(`<h1 class="text-xl font-bold mt-4 mb-2 text-slate-900 dark:text-slate-100">${escapeHtml(line.slice(2))}</h1>`); continue; }
    if (/^[-*] /.test(line)) { result.push(`<li class="ml-4 list-disc text-sm leading-relaxed">${formatInline(line.slice(2))}</li>`); continue; }
    if (/^\d+\. /.test(line)) { result.push(`<li class="ml-4 list-decimal text-sm leading-relaxed">${formatInline(line.replace(/^\d+\.\s/, ''))}</li>`); continue; }
    if (/^---+$/.test(line.trim())) { result.push('<hr class="my-3 border-slate-200 dark:border-slate-700" />'); continue; }
    if (line.trim() === '') { result.push('<div class="h-2" />'); continue; }
    result.push(`<p class="text-sm leading-relaxed">${formatInline(line)}</p>`);
  }

  if (inTable) flushTable();
  if (inCodeBlock && codeLines.length > 0) {
    result.push(`<div class="my-2 rounded bg-slate-800 border border-slate-700 overflow-hidden"><pre class="px-3 py-2 overflow-x-auto"><code class="text-xs text-slate-200 font-mono">${codeLines.join('\n')}</code></pre></div>`);
  }

  return result.join('\n');
}
