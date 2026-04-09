'use client';

import { useEffect, useState, memo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Maximize2, Minimize2, Copy, Check } from 'lucide-react';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

let mermaidReady = false;
let mermaidPromise: Promise<void> | null = null;
let renderCounter = 0;

async function ensureMermaid() {
  if (mermaidReady) return;
  if (mermaidPromise) { await mermaidPromise; return; }
  mermaidPromise = (async () => {
    const m = (await import('mermaid')).default;
    m.initialize({
      startOnLoad: false,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
      securityLevel: 'loose',
      flowchart: { htmlLabels: true, curve: 'basis' },
      fontSize: 12,
    } as any);
    mermaidReady = true;
  })();
  await mermaidPromise;
}

export const MermaidDiagram = memo(function MermaidDiagram({ chart, className }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!chart?.trim()) return;
    let cancelled = false;

    (async () => {
      try {
        await ensureMermaid();
        const mermaid = (await import('mermaid')).default;
        const id = `mmd-${++renderCounter}-${Date.now()}`;
        const { svg: rendered } = await mermaid.render(id, chart.trim());
        if (!cancelled) { setSvg(rendered); setError(null); }
      } catch (err: any) {
        if (!cancelled) { setError(err?.message || 'Render failed'); setSvg(''); }
      }
    })();

    return () => { cancelled = true; };
  }, [chart]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(chart);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [chart]);

  if (error) {
    return (
      <div className={cn('rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden', className)}>
        <div className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 flex items-center justify-between">
          <span className="text-[10px] text-slate-500">Mermaid Diagram (render failed)</span>
          <button onClick={handleCopy} className="text-slate-400 hover:text-slate-600 transition-colors">
            {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
        <pre className="p-3 bg-slate-900 text-slate-300 text-[10px] overflow-auto max-h-48 font-mono">{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={cn('flex items-center justify-center py-6 bg-white dark:bg-slate-900 rounded-md border border-slate-200 dark:border-slate-700', className)}>
        <div className="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin mr-2" />
        <span className="text-xs text-slate-400">Rendering diagram...</span>
      </div>
    );
  }

  return (
    <div className={cn(
      'rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden',
      expanded && 'fixed inset-4 z-50 shadow-2xl',
      className,
    )}>
      <div className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 flex items-center justify-between">
        <span className="text-[10px] text-slate-500">Mermaid Diagram</span>
        <div className="flex items-center gap-1.5">
          <button onClick={handleCopy} className="text-slate-400 hover:text-slate-600 transition-colors" title="Copy source">
            {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
          </button>
          <button onClick={() => setExpanded(!expanded)} className="text-slate-400 hover:text-slate-600 transition-colors" title={expanded ? 'Minimize' : 'Expand'}>
            {expanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
      </div>
      <div
        className={cn('overflow-auto bg-white dark:bg-slate-900 p-3', expanded ? 'h-[calc(100%-28px)]' : 'max-h-96')}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {expanded && (
        <div className="fixed inset-0 bg-black/50 -z-10" onClick={() => setExpanded(false)} />
      )}
    </div>
  );
});
