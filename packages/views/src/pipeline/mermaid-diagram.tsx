

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Download, ZoomIn, ZoomOut, Maximize2, AlertTriangle } from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { cn } from '@revamp/ui/utils';

// --- Types ---

interface MermaidDiagramProps {
  chart: string;
  className?: string;
  filename?: string;
  /** When true, the diagram fills its parent height instead of capping at 500px */
  fillHeight?: boolean;
  onExportPng?: (dataUrl: string) => void;
}

// --- Sanitization Helpers ---
// Comprehensive sanitizer that handles ALL known Mermaid rendering issues.
// LLMs produce unpredictable Unicode, markdown artifacts, and syntax variants —
// this normalizes everything to Mermaid-safe ASCII before render.

/** Unicode → plain ASCII. Safe for ALL Mermaid contexts (no HTML entities). */
const UNICODE_TO_ASCII: [RegExp, string][] = [
  // Arrows
  [/↔/g, '<->'], [/⟷/g, '<->'], [/⇔/g, '<=>'],
  [/→/g, '->'], [/⟶/g, '->'], [/⇒/g, '=>'], [/►/g, '>'],
  [/←/g, '<-'], [/⟵/g, '<-'], [/⇐/g, '<='], [/◄/g, '<'],
  // Math
  [/≤/g, '<='], [/≥/g, '>='], [/≠/g, '!='], [/±/g, '+/-'],
  // Bullets & list markers
  [/[•●◦▪▸▹⦿⁃◼]/g, '-'],
  // Dashes
  [/—/g, '-'], [/–/g, '-'], [/‐/g, '-'],
  // Quotes
  [/[""„‟«»]/g, "'"], [/[''‚‛]/g, "'"], [/`/g, "'"],
  // Checkmarks & status symbols
  [/[✓✔☑]/g, 'OK'], [/[✗✘☒✕]/g, 'FAIL'], [/[⚠⚡]/g, '!'],
  // Ellipsis & misc
  [/…/g, '...'], [/™/g, 'TM'], [/©/g, '(c)'], [/®/g, '(R)'],
  [/×/g, 'x'], [/÷/g, '/'],
  // Whitespace variants
  [/[\u00A0\u2002\u2003\u2009\u200A\u200B\uFEFF]/g, ' '],
];

/** Replace all problematic Unicode with plain ASCII. */
function toAscii(text: string): string {
  let clean = text;
  for (const [pattern, replacement] of UNICODE_TO_ASCII) {
    clean = clean.replace(pattern, replacement);
  }
  return clean;
}

function normalizeClassAssignment(line: string): string {
  if (/^\s*classDef\b/.test(line) || !/^\s*class\b/.test(line)) return line;
  const match = line.match(/^(\s*)class\s+([A-Za-z0-9_\-,\s]+)\s+([A-Za-z0-9_-]+)\s*;?\s*$/);
  if (!match) return line;
  const [, indent, idsRaw, className] = match;
  const ids = idsRaw.split(',').map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? `${indent}class ${ids.join(',')} ${className};` : line;
}

function expandGroupedEdges(line: string): string[] {
  if (/^\s*%%/.test(line)) return [line];

  // Left grouped: A,B --> C
  const leftGroup = line.match(
    /^(\s*)([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)+)\s*(-->|-.->|==>)(\|[^|]+\|)?\s*(.+?)\s*;?\s*$/,
  );
  if (leftGroup) {
    const [, indent, sourcesRaw, arrow, label = '', rhs] = leftGroup;
    const sources = sourcesRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const rhsId = rhs.match(/^([A-Za-z0-9_-]+)/)?.[1];
    return sources.map((src, i) => `${indent}${src} ${arrow}${label} ${i === 0 ? rhs : rhsId || rhs};`);
  }

  // Right grouped: A --> B,C
  const rightGroup = line.match(
    /^(\s*)(.+?)\s*(-->|-.->|==>)(\|[^|]+\|)?\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)+)\s*;?\s*$/,
  );
  if (rightGroup) {
    const [, indent, lhs, arrow, label = '', targetsRaw] = rightGroup;
    const targets = targetsRaw.split(',').map((t) => t.trim()).filter(Boolean);
    return targets.map((tgt) => `${indent}${lhs.trim()} ${arrow}${label} ${tgt};`);
  }

  return [line];
}

/** Sanitize all label types and sequence diagram text. Uses plain ASCII only. */
function sanitizeAllLabels(chart: string): string {
  // Node labels: ["..."], [(...)] , {{...}}
  let result = chart.replace(/\["([^\]"]*)"\]/g, (_m, l: string) => `["${toAscii(l)}"]`);
  result = result.replace(/\[\(([^)]*)\)\]/g, (_m, l: string) => `[(${toAscii(l)})]`);
  result = result.replace(/\{\{([^}]*)\}\}/g, (_m, l: string) => `{{${toAscii(l)}}}`);
  // Edge labels |...| — strip brackets/parens which Mermaid interprets as node shapes.
  // SKIP for erDiagram — ER syntax uses ||, |{, o{ as relationship markers, not edge labels.
  if (!/^\s*erDiagram/m.test(result)) {
    result = result.replace(/\|([^|]+)\|/g, (_m, l: string) => {
      const clean = toAscii(l).replace(/[()[\]{}]/g, '');
      return `|${clean}|`;
    });
  }
  // sequenceDiagram: sanitize all free-text lines
  if (/^\s*sequenceDiagram/m.test(result)) {
    /** Clean sequence diagram text: strip <br/>, replace {}/unicode, make Mermaid-safe */
    const cleanSeqText = (text: string): string =>
      toAscii(text)
        .replace(/<br\s*\/?>/gi, ' ')  // <br/> not supported in sequence text
        .replace(/;/g, ',')            // ; is statement terminator in sequenceDiagram
        .replace(/\{/g, '(')           // { } confuse Mermaid parser
        .replace(/\}/g, ')');

    result = result.split('\n')
      // Strip activate/deactivate — LLMs often produce mismatched pairs that crash Mermaid
      .filter((line) => !/^\s*(?:activate|deactivate)\s/.test(line))
      .map((line) => {
        // participant/actor: clean alias labels
        if (/^\s*(?:participant|actor)\s/.test(line)) {
          return line.replace(/^(\s*(?:participant|actor)\s+\S+(?:\s+as\s+))(.+)$/,
            (_m, prefix: string, label: string) => `${prefix}${cleanSeqText(label)}`);
        }
        // Message lines (->> / -->>): clean text after the colon
        if (/^\s*\S+\s*-+>>/.test(line)) {
          const colonIdx = line.indexOf(':');
          if (colonIdx !== -1) {
            return line.slice(0, colonIdx + 1) + ' ' + cleanSeqText(line.slice(colonIdx + 1));
          }
        }
        // Note/rect/alt/else lines
        if (/^\s*(?:Note|rect|alt|else)\b/.test(line)) {
          return cleanSeqText(line);
        }
        return line;
      }).join('\n');
  }
  return result;
}

/** Remove markdown formatting artifacts that LLMs sometimes leave inside mermaid blocks. */
function stripMarkdownArtifacts(chart: string): string {
  return chart
    // Bold **text** → text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Italic *text* → text (but not inside arrows like -->)
    .replace(/(?<![->=])\*([^*\n]+)\*(?![->])/g, '$1')
    // Inline code `text` → text
    .replace(/`([^`]+)`/g, '$1')
    // Stray markdown links [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/** Remove `style` statements that target subgraph IDs (Mermaid v11 doesn't support this). */
function stripSubgraphStyles(chart: string): string {
  // Collect all subgraph IDs (ID is the word before any ["label"])
  const subgraphIds = new Set<string>();
  for (const m of chart.matchAll(/^\s*subgraph\s+([A-Za-z0-9_-]+)/gm)) {
    subgraphIds.add(m[1]);
  }
  if (subgraphIds.size === 0) return chart;

  // Remove style lines that reference subgraph IDs
  return chart.split('\n').filter((line) => {
    const styleMatch = line.match(/^\s*style\s+(\S+)/);
    return !(styleMatch && subgraphIds.has(styleMatch[1]));
  }).join('\n');
}

export function sanitizeMermaidChart(chart: string): string {
  // FIRST: collapse multiline quoted labels into single lines.
  // LLMs produce labels like:  User["👤 User\n(Browser)"]
  // Mermaid only supports single-line labels, so join with space.
  let sanitized = chart.replace(/\["([^"]*?)"\]/gs, (_m, label: string) => {
    return `["${label.replace(/\n/g, ' ')}"]`;
  });
  // Same for round-bracket labels: [(text)]
  sanitized = sanitized.replace(/\[\(([^)]*?)\)\]/gs, (_m, label: string) => {
    return `[(${label.replace(/\n/g, ' ')})]`;
  });

  sanitized = sanitized
    .split('\n')
    .flatMap((line) => expandGroupedEdges(normalizeClassAssignment(line)))
    .join('\n');
  sanitized = stripMarkdownArtifacts(sanitized);
  sanitized = sanitizeAllLabels(sanitized);
  sanitized = stripSubgraphStyles(sanitized);
  return sanitized;
}

// --- SVG to PNG Export ---

async function exportSvgToPng(svgElement: SVGElement, filename: string): Promise<string> {
  const svgData = new XMLSerializer().serializeToString(svgElement);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  return new Promise((resolve, reject) => {
    img.onload = () => {
      const scale = 2; // Retina
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      const dataUrl = canvas.toDataURL('image/png');

      // Trigger download
      const link = document.createElement('a');
      link.download = `${filename}.png`;
      link.href = dataUrl;
      link.click();

      resolve(dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to render SVG to PNG'));
    };
    img.src = url;
  });
}

// --- Component ---

export const MermaidDiagram = memo(function MermaidDiagram({ chart, className, filename = 'diagram', fillHeight, onExportPng }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const renderIdRef = useRef(0);

  const renderChart = useCallback(async () => {
    if (!containerRef.current || !chart?.trim()) return;

    const renderId = ++renderIdRef.current;
    setError(null);
    setRendered(false);

    try {
      // Dynamic import for mermaid (avoid SSR issues)
      const mermaid = (await import('mermaid')).default as any;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        flowchart: { htmlLabels: true, curve: 'basis' },
        themeVariables: {
          primaryColor: '#3b82f6',
          primaryTextColor: '#f1f5f9',
          primaryBorderColor: '#60a5fa',
          lineColor: '#94a3b8',
          secondaryColor: '#1e293b',
          tertiaryColor: '#0f172a',
        },
      });

      const sanitized = sanitizeMermaidChart(chart);
      const id = `mermaid-${renderId}-${Date.now()}`;

      // Validate first with parse(), then render
      // Progressive simplification if parse fails
      const levels = [
        sanitized,
        sanitized.replace(/<br\s*\/?>/gi, ' '),
        sanitized.replace(/<br\s*\/?>/gi, ' ').replace(/\["[^"]*"\]/g, ''),
        sanitized.replace(/<br\s*\/?>/gi, ' ').replace(/\["[^"]*"\]/g, '').replace(/^\s*(?:style|classDef|class)\s.*/gm, '').replace(/\|[^|]*\|/g, ''),
      ];

      let validChart: string | null = null;
      for (let i = 0; i < levels.length; i++) {
        try {
          await mermaid.parse(levels[i]);
          validChart = levels[i];
          break;
        } catch (parseErr) {
          console.warn(`[MermaidDiagram] Parse level ${i} failed:`, parseErr instanceof Error ? parseErr.message?.slice(0, 120) : parseErr);
        }
      }

      if (!validChart) throw new Error('All parse attempts failed');

      const { svg } = await mermaid.render(`${id}`, validChart);

      if (renderId !== renderIdRef.current) return; // Stale render

      if (containerRef.current) {
        containerRef.current.innerHTML = svg;
        // Make SVG responsive — scale to fit container
        const svgEl = containerRef.current.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
        }
        setRendered(true);
      }
    } catch (err) {
      if (renderId !== renderIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to render diagram';
      setError(message);

      // Fallback: show raw chart as code
      if (containerRef.current) {
        containerRef.current.innerHTML = `<pre class="text-xs text-slate-400 p-4 overflow-auto whitespace-pre-wrap">${chart.replace(/</g, '&lt;')}</pre>`;
      }
    }
  }, [chart]);

  useEffect(() => {
    renderChart();
  }, [renderChart]);

  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.25, 3));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.25, 0.25));
  const handleResetZoom = () => setZoom(1);

  const handleExport = async () => {
    const svg = containerRef.current?.querySelector('svg');
    if (!svg) return;
    try {
      const dataUrl = await exportSvgToPng(svg as SVGElement, filename);
      onExportPng?.(dataUrl);
    } catch {
      // Export failed silently
    }
  };

  return (
    <div className={cn(
      'relative rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-950 overflow-hidden',
      fillHeight && 'flex flex-col h-full',
      className,
    )}>
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-900/50">
        <span className="text-xs text-slate-400 font-medium">Diagram</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-slate-400 hover:text-slate-200" onClick={handleZoomOut} title="Zoom out">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-slate-400 tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-slate-400 hover:text-slate-200" onClick={handleZoomIn} title="Zoom in">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-slate-400 hover:text-slate-200" onClick={handleResetZoom} title="Reset zoom">
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
          {rendered && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-slate-400 hover:text-slate-200" onClick={handleExport} title="Export PNG">
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-yellow-900/30 border-b border-yellow-700/50">
          <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
          <span className="text-xs text-yellow-400">Diagram render error — showing raw source</span>
        </div>
      )}

      {/* Diagram Container */}
      <div className={cn('overflow-auto p-4', fillHeight ? 'flex-1 min-h-0' : '')} style={fillHeight ? undefined : { maxHeight: '500px' }}>
        <div
          ref={containerRef}
          className="flex items-center justify-center transition-transform duration-200"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  );
});
