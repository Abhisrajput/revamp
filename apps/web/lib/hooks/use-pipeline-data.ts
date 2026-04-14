'use client';

/**
 * usePipelineData — unified hook for pipeline state.
 *
 * This is the Multica-pattern bridge: React Query owns server state,
 * Zustand owns UI state, this hook merges them for components.
 *
 * Components should use this instead of reading usePipelineStore directly.
 * Over time, direct store reads will be migrated here.
 */

import { useMemo } from 'react';
import { usePipelineStore } from '@revamp/core';
import {
  usePipelineStatus,
  useAllStageOutputs,
  useInvalidatePipeline,
  type PipelineStatus,
  type ApprovalGate,
  type StageStatus,
  STAGE_NAMES,
  STAGE_LABELS,
  stageRequiresApproval,
} from '@revamp/core';

// ─── Status mapping ─────────────────────────────────────────────
// Backend uses different status names than frontend.
// This is the single place that maps them.

function mapBackendStatus(backendStatus: string): StageStatus {
  switch (backendStatus) {
    case 'in_progress': return 'generating';
    case 'awaiting_approval': return 'completed'; // completed but needs approval
    case 'approved': return 'approved';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
    default: return 'idle';
  }
}

function mapApprovalStatus(gate: ApprovalGate | undefined, backendStatus: string): 'pending' | 'approved' | 'rejected' | 'not_required' {
  if (!gate) {
    // No gate = stage doesn't require approval OR hasn't completed yet
    return stageRequiresApproval(backendStatus) ? 'not_required' : 'not_required';
  }
  return gate.status as 'pending' | 'approved' | 'rejected';
}

// ─── Merged stage view ──────────────────────────────────────────

export interface MergedStageState {
  name: string;
  label: string;
  index: number;
  // Server state (from React Query)
  status: StageStatus;
  output: string | null;
  confidenceScore: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'not_required';
  approvalGate: ApprovalGate | null;
  // UI state (from Zustand)
  isActive: boolean;
  streamingText: string;
}

export interface PipelineData {
  /** All 8 stages with merged server + UI state */
  stages: MergedStageState[];
  /** Currently active stage index */
  activeStageIndex: number;
  /** Pipeline run ID */
  runId: string | null;
  /** Overall pipeline status */
  pipelineStatus: string | null;
  /** Current stage name from backend */
  currentStage: string | null;
  /** Subtasks for the active stage */
  subtasks: any[];
  subtaskProgress: any | null;
  /** Whether data is loading */
  isLoading: boolean;
  /** Invalidation helpers */
  invalidate: ReturnType<typeof useInvalidatePipeline>;
  /** Raw pipeline status data (for advanced use) */
  raw: PipelineStatus | null;
}

/**
 * Main hook for pipeline data. Merges React Query (server truth)
 * with Zustand (UI state) into a single view.
 */
export function usePipelineData(runId: string | null): PipelineData {
  const { data: statusData, isLoading: statusLoading } = usePipelineStatus(runId);
  const { data: allOutputs, isLoading: outputsLoading } = useAllStageOutputs(runId, STAGE_NAMES as unknown as string[]);
  const invalidate = useInvalidatePipeline();

  // UI-only state from Zustand
  const activeStageIndex = usePipelineStore((s) => s.activeStageIndex);
  const streamingText = usePipelineStore((s) => s.streamingText);

  const stages = useMemo(() => {
    return (STAGE_NAMES as readonly string[]).map((name, index) => {
      const progress = statusData?.stage_progress?.[name];
      const gate = statusData?.approval_gates?.find(g => g.stage_name === name);
      const backendStatus = progress?.status || 'idle';

      return {
        name,
        label: STAGE_LABELS[name] ?? name,
        index,
        // Server state
        status: mapBackendStatus(backendStatus),
        output: allOutputs?.[name] ?? null,
        confidenceScore: progress?.confidenceScore ?? null,
        startedAt: progress?.startedAt ?? null,
        updatedAt: progress?.updatedAt ?? null,
        approvalStatus: mapApprovalStatus(gate, name),
        approvalGate: gate ?? null,
        // UI state
        isActive: index === activeStageIndex,
        streamingText: index === activeStageIndex ? streamingText : '',
      };
    });
  }, [statusData, allOutputs, activeStageIndex, streamingText]);

  return {
    stages,
    activeStageIndex,
    runId,
    pipelineStatus: statusData?.status ?? null,
    currentStage: statusData?.current_stage ?? null,
    subtasks: statusData?.current_stage_subtasks ?? [],
    subtaskProgress: statusData?.current_stage_progress ?? null,
    isLoading: statusLoading || outputsLoading,
    invalidate,
    raw: statusData ?? null,
  };
}
