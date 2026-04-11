'use client';

import { useRef, useEffect, memo, useMemo } from 'react';
import DOMPurify from 'dompurify';
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
/** Minimal table cleanup — just normalize separator rows */
function cleanupTables(text: string): string {
  return text.replace(/^([\s|:\-]+)$/gm, (line) => {
    const trimmed = line.trim();
    if (/^\|/.test(trimmed) && trimmed.includes('-')) {
      const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
      if (cells.length >= 1 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c.trim()))) {
        return '|' + cells.map((c) => {
          const t = c.trim();
          if (t.startsWith(':') && t.endsWith(':')) return ':---:';
          if (t.endsWith(':')) return '---:';
          return '---';
        }).join('|') + '|';
      }
    }
    return line;
  });
}

function normalizeMarkdown(text: string): string {
  // Convert HTML break tags to newlines
  let out = text.replace(/<br\s*\/?>/gi, '\n');

  // If the text already has plenty of newlines, skip re-insertion.
  // Heuristic: fewer than 1 newline per 500 chars means newlines were stripped.
  const newlineCount = (out.match(/\n/g) || []).length;
  if (out.length > 200 && newlineCount > out.length / 500) {
    // Still reassemble broken tables even if we skip other normalization
    return cleanupTables(out);
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

  // Reassemble tables that got broken by the above newline insertions
  out = cleanupTables(out);

  return out;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
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
    let html = '<div class="table-wrapper"><table>';
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
    html += '</table></div>';
    result.push(html);
    tableRows = [];
    tableAlignments = [];
    inTable = false;
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.startsWith('```') && !inCodeBlock) {
      if (inTable) flushTable();
      inCodeBlock = true;
      codeLanguage = line.slice(3).trim();
      codeLines = [];
      continue;
    }

    if (line.startsWith('```') && inCodeBlock) {
      inCodeBlock = false;
      if (codeLanguage === 'mermaid') {
        // Mark mermaid blocks for client-side rendering
        const mermaidCode = codeLines.map(l => l.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")).join('\n');
        result.push(
          `<div class="mermaid-block" data-chart="${escapeHtml(mermaidCode)}"><pre class="mermaid">${codeLines.join('\n')}</pre></div>`
        );
      } else {
        const langLabel = codeLanguage ? `<span class="code-lang">${escapeHtml(codeLanguage)}</span>` : '';
        result.push(
          `<div class="code-block">${langLabel}<pre><code>${codeLines.join('\n')}</code></pre></div>`
        );
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(escapeHtml(line));
      continue;
    }

    // Table separator detection (may or may not start with |)
    // e.g. |---|---|, ---|---|, |:---:|---:|, --------|--------|, |---------|
    // Also handles malformed separators that are just dashes with optional pipes
    {
      const trimmedLine = line.trim();
      // Check if line is entirely dashes, pipes, colons, and spaces (a separator row)
      if (/^[\s|:\-]+$/.test(trimmedLine) && trimmedLine.includes('-') && trimmedLine.length >= 3) {
        const stripped = trimmedLine.replace(/^\|/, '').replace(/\|$/, '');
        const sepCells = stripped.split('|').filter((c) => c.trim().length > 0);
        if (sepCells.length >= 1 && sepCells.every((c) => /^\s*:?-+:?\s*$/.test(c.trim()))) {
          // Use column count from header row if separator has fewer cells
          const headerColCount = tableRows.length > 0 ? tableRows[0].length : sepCells.length;
          tableAlignments = [];
          for (let ci = 0; ci < headerColCount; ci++) {
            const cell = sepCells[ci]?.trim() ?? '';
            if (cell.startsWith(':') && cell.endsWith(':')) tableAlignments.push('center');
            else if (cell.endsWith(':')) tableAlignments.push('right');
            else tableAlignments.push('left');
          }
          inTable = true;
          continue;
        }
      }
    }

    // Table data rows — accept lines starting with | (trailing | optional)
    if (line.trim().startsWith('|') && line.trim().includes('|', 1)) {
      let trimmed = line.trim();
      if (!trimmed.endsWith('|')) trimmed += '|';
      const cells = trimmed.slice(1, -1).split('|');
      tableRows.push(cells);
      inTable = true;
      continue;
    }

    // If we were in a table and this line isn't a table row, flush
    // But allow blank lines within tables (LLM sometimes inserts them)
    if (inTable) {
      if (line.trim() === '') {
        // Peek ahead: if a line within the next 2 starts with | or is a separator, stay in table
        let stayInTable = false;
        for (let peek = 1; peek <= 2 && li + peek < lines.length; peek++) {
          const nextLine = lines[li + peek].trim();
          if (nextLine.startsWith('|') || (/^[\s|:\-]+$/.test(nextLine) && nextLine.includes('-'))) {
            stayInTable = true;
            break;
          }
          if (nextLine !== '') break; // non-empty non-table line = flush
        }
        if (stayInTable) continue;
      }
      flushTable();
    }

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

  const contentRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const raw = renderMarkdown(normalizeMarkdown(output));
    // Sanitize to prevent XSS from LLM-generated or user-injected content.
    // Allow class/style attrs and data-chart for mermaid, but block javascript: URLs.
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-chart', 'data-rendered'],
      ADD_TAGS: ['style'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    });
  }, [output]);

  // Render mermaid diagrams after HTML is mounted
  useEffect(() => {
    if (!contentRef.current) return;
    const mermaidBlocks = contentRef.current.querySelectorAll('.mermaid-block');
    if (mermaidBlocks.length === 0) return;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
          securityLevel: 'loose',
          flowchart: { htmlLabels: true, curve: 'basis' },
          fontSize: 11,
        } as any);

        for (const block of mermaidBlocks) {
          if (block.getAttribute('data-rendered')) continue;
          const chart = block.getAttribute('data-chart');
          if (!chart) continue;
          try {
            const id = `mermaid-so-${Math.random().toString(36).slice(2, 7)}`;
            const { svg } = await mermaid.render(id, chart);
            block.innerHTML = svg;
            block.setAttribute('data-rendered', 'true');
            (block as HTMLElement).style.cssText = 'overflow: auto; background: white; border-radius: 0.5rem; border: 1px solid #e2e8f0; padding: 0.5rem; margin: 0.75rem 0;';
          } catch {
            // leave raw code if render fails
          }
        }
      } catch {
        // mermaid import failed
      }
    })();
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-4',
        isStreaming && 'scroll-smooth'
      )}
    >
      <style>{`
        .stage-output { overflow-wrap: break-word; word-break: break-word; overflow: visible; position: relative; }
        .stage-output h1 { font-size: 1.25rem; font-weight: 700; margin: 1rem 0 0.5rem; color: var(--heading-color, #0f172a); clear: both; }
        .stage-output h2 { font-size: 1.125rem; font-weight: 600; margin: 0.75rem 0 0.375rem; color: var(--heading-color, #0f172a); clear: both; }
        .stage-output h3 { font-size: 1rem; font-weight: 600; margin: 0.5rem 0 0.25rem; color: var(--heading-color, #0f172a); clear: both; }
        .stage-output p { margin: 0.25rem 0; line-height: 1.625; overflow-wrap: break-word; }
        .stage-output li { margin-left: 1.5rem; list-style-type: disc; line-height: 1.625; overflow-wrap: break-word; }
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
        .stage-output .table-wrapper {
          overflow-x: auto; margin: 0.75rem 0; border-radius: 0.375rem;
          border: 1px solid #e2e8f0; max-width: 100%; clear: both;
        }
        .stage-output table {
          border-collapse: collapse; font-size: 0.75rem;
          table-layout: auto; min-width: 100%;
        }
        .stage-output th {
          background: #f1f5f9; font-weight: 600; text-align: left;
          padding: 0.375rem 0.5rem; border: 1px solid #e2e8f0;
          font-size: 0.7rem;
        }
        .stage-output td {
          padding: 0.375rem 0.5rem; border: 1px solid #e2e8f0;
          vertical-align: top; font-size: 0.7rem;
        }
        .stage-output tbody tr:nth-child(even) { background: #f8fafc; }
        .dark .stage-output .table-wrapper { border-color: #334155; }
        .dark .stage-output th { background: #1e293b; border-color: #334155; color: #f1f5f9; }
        .dark .stage-output td { border-color: #334155; color: #cbd5e1; }
        .dark .stage-output tbody tr:nth-child(even) { background: #0f172a; }
        .dark .stage-output h1, .dark .stage-output h2, .dark .stage-output h3 { color: #f1f5f9; }
        .dark .stage-output .inline-code { background: #334155; color: #e2e8f0; }
        .dark .stage-output hr { border-color: #334155; }
      `}</style>

      <div
        ref={contentRef}
        className="stage-output text-sm text-slate-700 dark:text-slate-300"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {isStreaming && (
        <span className="inline-block w-2 h-4 ml-0.5 bg-primary-600 animate-pulse rounded-sm align-text-bottom" />
      )}
    </div>
  );
});
