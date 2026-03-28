'use client';

import { useRef, useEffect, memo, useMemo } from 'react';
import { cn } from '@/lib/utils';

// --- Types ---

interface StageOutputProps {
  output: string;
  isStreaming: boolean;
}

// --- Helpers ---

/**
 * Normalise markdown that may have lost its newlines during SSE streaming.
 * Detects content that is mostly a single long line and re-inserts line breaks
 * before markdown structural patterns (headings, lists, code fences, etc.).
 * Also converts HTML `<br/>` tags to real newlines.
 */
function normalizeMarkdown(text: string): string {
  // Convert HTML break tags to newlines
  let out = text.replace(/<br\s*\/?>/gi, '\n');

  // If the text already has plenty of newlines, skip re-insertion.
  // Heuristic: fewer than 1 newline per 500 chars means newlines were stripped.
  const newlineCount = (out.match(/\n/g) || []).length;
  if (out.length > 200 && newlineCount > out.length / 500) {
    return out;
  }

  // Re-insert newlines before markdown structural markers that appear mid-line.
  // Two newlines before headings (they need a blank line in markdown).
  out = out.replace(/([^\n])(\s*)(#{1,3} )/g, '$1\n\n$3');

  // Newline before bold section headers like "**Project:**" at apparent line starts
  out = out.replace(/([^\n])(\s*)(\*\*[A-Z][^*]{1,60}:?\*\*)/g, '$1\n$3');

  // Newline before list markers (- item or * item or 1. item)
  out = out.replace(/([^\n])(\s{2,})([-*] )/g, '$1\n$3');
  out = out.replace(/([^\n])(\s{2,})(\d+\. )/g, '$1\n$3');

  // Newline before code fences
  out = out.replace(/([^\n])(```)/g, '$1\n$2');

  // Newline before horizontal rules (three or more dashes with spaces around)
  out = out.replace(/([^\n])(\s*---+\s*)/g, '$1\n$2');

  // Newline before table rows (lines starting with |)
  out = out.replace(/([^\n])(\s*\|[^|]+\|)/g, '$1\n$2');

  // Newline before emoji bullets like ✅ ⚠️ 🔴 📊
  out = out.replace(/([^\n])([\u2705\u26A0\uFE0F\u{1F534}\u{1F4CA}\u{1F6A8}])/gu, '$1\n$2');

  // Collapse any excessive whitespace that was left behind
  out = out.replace(/\n{4,}/g, '\n\n\n');

  return out;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let tableAlignments: string[] = [];

  function flushTable() {
    if (tableRows.length === 0) return;
    let html = '<table>';
    for (let r = 0; r < tableRows.length; r++) {
      const tag = r === 0 ? 'th' : 'td';
      if (r === 0) html += '<thead>';
      if (r === 1) html += '<tbody>';
      html += '<tr>';
      for (let c = 0; c < tableRows[r].length; c++) {
        const align = tableAlignments[c] ? ` style="text-align:${tableAlignments[c]}"` : '';
        html += `<${tag}${align}>${formatInline(tableRows[r][c].trim())}</${tag}>`;
      }
      html += '</tr>';
      if (r === 0) html += '</thead>';
    }
    if (tableRows.length > 1) html += '</tbody>';
    html += '</table>';
    result.push(html);
    tableRows = [];
    tableAlignments = [];
    inTable = false;
  }

  for (const line of lines) {
    if (line.startsWith('```') && !inCodeBlock) {
      if (inTable) flushTable();
      inCodeBlock = true;
      codeLanguage = line.slice(3).trim();
      codeLines = [];
      continue;
    }

    if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false;
      const langLabel = codeLanguage ? `<span class="code-lang">${escapeHtml(codeLanguage)}</span>` : '';
      result.push(
        `<div class="code-block">${langLabel}<pre><code>${codeLines.join('\n')}</code></pre></div>`
      );
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(escapeHtml(line));
      continue;
    }

    // Table detection
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line.trim().slice(1, -1).split('|');
      // Check if this is a separator row (e.g. |---|---|)
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

    // If we were in a table and this line isn't a table row, flush
    if (inTable) flushTable();

    // Headings
    if (line.startsWith('### ')) {
      result.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      result.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      result.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      continue;
    }

    // Unordered list
    if (/^[-*] /.test(line)) {
      result.push(`<li>${formatInline(line.slice(2))}</li>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const content = line.replace(/^\d+\.\s/, '');
      result.push(`<li>${formatInline(content)}</li>`);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      result.push('<hr />');
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      result.push('<br />');
      continue;
    }

    // Paragraph
    result.push(`<p>${formatInline(line)}</p>`);
  }

  // Flush any remaining table or code block
  if (inTable) flushTable();
  if (inCodeBlock && codeLines.length > 0) {
    const langLabel = codeLanguage ? `<span class="code-lang">${escapeHtml(codeLanguage)}</span>` : '';
    result.push(
      `<div class="code-block">${langLabel}<pre><code>${codeLines.join('\n')}</code></pre></div>`
    );
  }

  return result.join('\n');
}

function formatInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  return out;
}

// --- Component ---

export const StageOutput = memo(function StageOutput({ output, isStreaming }: StageOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStreaming && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [output, isStreaming]);

  const html = useMemo(() => renderMarkdown(normalizeMarkdown(output)), [output]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative max-h-[600px] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-4',
        isStreaming && 'scroll-smooth'
      )}
    >
      <style>{`
        .stage-output h1 { font-size: 1.25rem; font-weight: 700; margin: 1rem 0 0.5rem; color: var(--heading-color, #0f172a); }
        .stage-output h2 { font-size: 1.125rem; font-weight: 600; margin: 0.75rem 0 0.375rem; color: var(--heading-color, #0f172a); }
        .stage-output h3 { font-size: 1rem; font-weight: 600; margin: 0.5rem 0 0.25rem; color: var(--heading-color, #0f172a); }
        .stage-output p { margin: 0.25rem 0; line-height: 1.625; }
        .stage-output li { margin-left: 1.5rem; list-style-type: disc; line-height: 1.625; }
        .stage-output hr { border: none; border-top: 1px solid #e2e8f0; margin: 0.75rem 0; }
        .stage-output strong { font-weight: 600; }
        .stage-output em { font-style: italic; }
        .stage-output .inline-code {
          background: #e2e8f0; padding: 0.125rem 0.375rem; border-radius: 0.25rem;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; font-size: 0.8125rem;
        }
        .stage-output .code-block {
          position: relative; margin: 0.75rem 0; border-radius: 0.5rem; overflow: hidden;
          background: #1e293b; border: 1px solid #334155;
        }
        .stage-output .code-block .code-lang {
          display: block; padding: 0.375rem 0.75rem; font-size: 0.6875rem; font-weight: 500;
          color: #94a3b8; background: #0f172a; text-transform: uppercase; letter-spacing: 0.05em;
        }
        .stage-output .code-block pre {
          padding: 0.75rem; overflow-x: auto; margin: 0;
        }
        .stage-output .code-block code {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
          font-size: 0.8125rem; line-height: 1.625; color: #e2e8f0; white-space: pre;
        }
        .stage-output table {
          width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.8125rem;
        }
        .stage-output th {
          background: #f1f5f9; font-weight: 600; text-align: left;
          padding: 0.5rem 0.75rem; border: 1px solid #e2e8f0;
        }
        .stage-output td {
          padding: 0.5rem 0.75rem; border: 1px solid #e2e8f0;
        }
        .stage-output tbody tr:nth-child(even) { background: #f8fafc; }
        .dark .stage-output th { background: #1e293b; border-color: #334155; color: #f1f5f9; }
        .dark .stage-output td { border-color: #334155; }
        .dark .stage-output tbody tr:nth-child(even) { background: #0f172a; }
        .dark .stage-output h1, .dark .stage-output h2, .dark .stage-output h3 { color: #f1f5f9; }
        .dark .stage-output .inline-code { background: #334155; color: #e2e8f0; }
        .dark .stage-output hr { border-color: #334155; }
      `}</style>

      <div
        className="stage-output text-sm text-slate-700 dark:text-slate-300"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {isStreaming && (
        <span className="inline-block w-2 h-4 ml-0.5 bg-primary-600 animate-pulse rounded-sm align-text-bottom" />
      )}
    </div>
  );
});
