/**
 * Stage Panels — barrel export with lazy loading.
 * Each panel is dynamically imported to keep the initial pipeline bundle lean.
 */

import dynamic from 'next/dynamic';
import type { StagePanelProps } from './types';
import type { ComponentType } from 'react';

const LoadingFallback = () => (
  <div className="space-y-3 p-4">
    <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/3 animate-pulse" />
    <div className="h-32 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
  </div>
);

export const ScanPanel = dynamic(() => import('./scan-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

export const DecodePanel = dynamic(() => import('./decode-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

export const BlueprintPanel = dynamic(() => import('./blueprint-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

export const SpecLockPanel = dynamic(() => import('./spec-lock-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

export const ArchitectPanel = dynamic(() => import('./architect-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

export const ForgePanel = dynamic(() => import('./forge-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

export const ShadowRunPanel = dynamic(() => import('./shadow-run-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

export const EvolvePanel = dynamic(() => import('./evolve-panel'), {
  loading: LoadingFallback,
  ssr: false,
});

/** Map stage name to its dynamic panel component */
export const STAGE_PANEL_MAP: Record<string, ComponentType<StagePanelProps>> = {
  SCAN: ScanPanel,
  DECODE: DecodePanel,
  BLUEPRINT: BlueprintPanel,
  SPEC_LOCK: SpecLockPanel,
  ARCHITECT: ArchitectPanel,
  FORGE: ForgePanel,
  SHADOW_RUN: ShadowRunPanel,
  EVOLVE: EvolvePanel,
};
