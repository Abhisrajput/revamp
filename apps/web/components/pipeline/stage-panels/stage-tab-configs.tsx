/**
 * Per-stage tab configuration for DynamicStageTabs.
 *
 * Each config defines:
 *  - prioritySections: preferred tab ordering (matched sections first)
 *  - specialTabs: injected tabs (BREE Analysis, etc.)
 *  - includeFullOutput: whether to append a "Full Output" tab
 */

import { Cpu } from 'lucide-react';
import { BreeOutputTab } from '@/components/pipeline/bree-output-tab';
import type { StageTabConfig, SpecialTab } from './dynamic-stage-tabs';

// ─── BREE Tab Factory ─────────────────────────────────────────

export function createBreeTab(stageName: string): SpecialTab {
  return {
    id: 'bree',
    title: 'BREE Analysis',
    icon: Cpu,
    position: 'after',
    priority: 1,
    render: () => <BreeOutputTab stageName={stageName} />,
  };
}

// ─── Stage Configs ────────────────────────────────────────────

const STAGE_CONFIGS: Record<string, Omit<StageTabConfig, 'stageName'>> = {
  DECODE: {
    prioritySections: [
      'Business Rules',
      'Workflows',
      'Data',
      'Domain Entities',
      'Integration',
      'Technical Debt',
      'Open Questions',
      'Migration Readiness',
    ],
    includeFullOutput: true,
  },

  BLUEPRINT: {
    prioritySections: [
      'Capability Inventory',
      'Bounded Context',
      'Service Boundary',
      'Migration Wave',
      'Data Ownership',
    ],
    includeFullOutput: true,
  },

  SPEC_LOCK: {
    prioritySections: [
      'Feature Files',
      'Test Execution',
      'Validation Finding',
      'Traceability',
      'Regression',
    ],
    includeFullOutput: true,
  },

  ARCHITECT: {
    prioritySections: [
      'Architecture',
      'Technology Decision',
      'Migration Roadmap',
      'Risk Register',
      'Cost Model',
    ],
    includeFullOutput: true,
  },

  SHADOW_RUN: {
    prioritySections: [
      'Test Matrix',
      'Behavioral Comparison',
      'Performance',
      'Deviation',
      'Cutover Verdict',
    ],
    includeFullOutput: true,
  },

  EVOLVE: {
    prioritySections: [
      'KPI Dashboard',
      'Modernization Backlog',
      'Decommission',
      'Operational Runbook',
      'Team',
      'Cost Optimization',
    ],
    includeFullOutput: true,
  },
};

// ─── Accessor ─────────────────────────────────────────────────

export function getStageTabConfig(stageName: string): StageTabConfig {
  const base = STAGE_CONFIGS[stageName] ?? { includeFullOutput: true };

  // Inject BREE tab for DECODE
  const specialTabs: SpecialTab[] = [];
  if (stageName === 'DECODE') {
    specialTabs.push(createBreeTab(stageName));
  }

  return {
    stageName,
    ...base,
    specialTabs: [...(base.specialTabs ?? []), ...specialTabs],
  };
}
