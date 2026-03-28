'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Download, ZoomIn, ZoomOut, Maximize2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// --- Types ---

interface MermaidDiagramProps {
  chart: string;
  className?: string;
  filename?: string;
  onExportPng?: (dataUrl: string) => void;
}

// --- Sanitization Helpers ---

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

function sanitizeMermaidChart(chart: string): string {
  return chart
    .split('\n')
    .flatMap((line) => expandGroupedEdges(normalizeClassAssignment(line)))
    .join('\n');
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

export const MermaidDiagram = memo(function MermaidDiagram({ chart, className, filename = 'diagram', onExportPng }: MermaidDiagramProps) {
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
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
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
      const { svg } = await mermaid.render(id, sanitized);

      if (renderId !== renderIdRef.current) return; // Stale render

      if (containerRef.current) {
        containerRef.current.innerHTML = svg;
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
    <div className={cn('relative rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-950 overflow-hidden', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-900/50">
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
        <div className="flex items-center gap-2 px-3 py-2 bg-yellow-900/30 border-b border-yellow-700/50">
          <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
          <span className="text-xs text-yellow-400">Diagram render error — showing raw source</span>
        </div>
      )}

      {/* Diagram Container */}
      <div className="overflow-auto p-4" style={{ maxHeight: '500px' }}>
        <div
          ref={containerRef}
          className="flex items-center justify-center transition-transform duration-200"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  );
});
