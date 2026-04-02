'use client';

import { memo } from 'react';
import { StageOutput } from '@/components/pipeline/stage-output';

interface TabFallbackProps {
  /** The full stage output to render as markdown when section parsing fails */
  stageOutput: string | undefined;
  /** Label shown when there's truly no output at all */
  emptyLabel?: string;
}

/**
 * Guardrail fallback for stage panel tabs.
 * When section parsers can't find or parse content, this renders the full
 * stage output as rich markdown (with tables, code blocks, Mermaid diagrams)
 * instead of showing a useless "No data found" message.
 */
export const TabFallback = memo(function TabFallback({
  stageOutput,
  emptyLabel = 'No output available',
}: TabFallbackProps) {
  if (!stageOutput) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-slate-400">
        {emptyLabel}
      </div>
    );
  }

  return <StageOutput output={stageOutput} isStreaming={false} />;
});
