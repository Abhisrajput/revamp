import { create } from 'zustand';
import { useAuthStore } from './auth-store';
import {
  type StageStatus,
  type StageValidation,
  type StageArtifact,
  type ApprovalHistoryEntry,
  type ScanSubtaskState,
  type StageState,
  createDefaultStage,
  createDefaultStages,
} from '../types/stage';

// ─── Types ─────────────────────────────────────────────────────────

interface PipelineStoreState {
  // ─── State ───────────────────────────────────────────────────
  // Server-synced state (React Query → unified sync effect → here)
  stages: StageState[];
  isGenerating: boolean;
  // UI-only state
  activeStageIndex: number;
  currentPipelineRunId: string | null;
  currentProjectId: string | null;
  streamingText: string;

  // ─── UI Actions (pure client-side) ───────────────────────────
  initPipeline: (projectId: string, pipelineRunId: string) => void;
  setActiveStage: (index: number) => void;
  advanceToNextStage: () => void;
  appendStreamingText: (text: string) => void;
  clearStreamingText: () => void;
  resetStage: (index: number) => void;
  rerunStage: (index: number, user?: string) => void;

  // ─── Execution Actions (called by SSE handler during streaming) ──
  // TODO: Migrate to React Query mutations + cache invalidation
  setStageStatus: (index: number, status: StageStatus) => void;
  setStageOutput: (index: number, output: string) => void;
  setStageApproval: (index: number, status: 'approved' | 'rejected' | 'pending', comment?: string) => void;
  setStageValidation: (index: number, validation: StageValidation) => void;
  setPendingApproval: (index: number) => void;
  addStageArtifact: (index: number, artifact: StageArtifact) => void;
  addScanSubtask: (index: number, subtask: ScanSubtaskState) => void;
  updateScanSubtask: (index: number, subtaskId: string, updates: Partial<ScanSubtaskState>) => void;
}

// ─── Session persistence for pipeline state ─────────────────────────
// Persists the full pipeline state (identity + stages) to sessionStorage
// so timers, approval status, subtasks, and progress survive page refresh.

import { getSessionStorage } from '../api/storage';

const PIPELINE_STATE_KEY = 'revamp:pipeline-state';

function savePipelineState(state: {
  projectId: string | null;
  runId: string | null;
  stages: StageState[];
  activeStageIndex: number;
}) {
  try {
    getSessionStorage().setItem(PIPELINE_STATE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded — non-fatal */ }
}

function loadPipelineState(): {
  projectId: string | null;
  runId: string | null;
  stages: StageState[];
  activeStageIndex: number;
} | null {
  try {
    const raw = getSessionStorage().getItem(PIPELINE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Validate shape
    if (!parsed.stages || !Array.isArray(parsed.stages)) return null;
    // Normalize transient statuses that can't survive refresh.
    // 'generating'/'validating' are in-flight states — if the page refreshed,
    // the execution is gone. Map them to 'completed' (the sync effect will
    // correct to the DB value on the next poll). This prevents the ApprovalGate
    // from unmounting/remounting which resets the countdown timer.
    for (const stage of parsed.stages) {
      if (stage.status === 'generating' || stage.status === 'validating') {
        stage.status = stage.output ? 'completed' : 'pending';
      }
    }
    return parsed;
  } catch { return null; }
}

// Debounce saves — at most every 2 seconds
let stateTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveState() {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const s = usePipelineStore.getState();
    savePipelineState({
      projectId: s.currentProjectId,
      runId: s.currentPipelineRunId,
      stages: s.stages,
      activeStageIndex: s.activeStageIndex,
    });
  }, 2000);
}

// ─── Store ─────────────────────────────────────────────────────────

const savedState = loadPipelineState();

export const usePipelineStore = create<PipelineStoreState>()(
  (set, get) => ({
    stages: savedState?.stages ?? createDefaultStages(),
    activeStageIndex: savedState?.activeStageIndex ?? 0,
    currentPipelineRunId: savedState?.runId ?? null,
    currentProjectId: savedState?.projectId ?? null,
    streamingText: '',
    isGenerating: false,

    initPipeline: (projectId, pipelineRunId) => {
      // If same pipeline, don't reset stages — preserves timers across refresh
      const current = get();
      if (current.currentPipelineRunId === pipelineRunId && current.currentProjectId === projectId) {
        return;
      }
      set({
        stages: createDefaultStages(),
        activeStageIndex: 0,
        currentPipelineRunId: pipelineRunId,
        currentProjectId: projectId,
        streamingText: '',
        isGenerating: false,
      });
      savePipelineState({ projectId, runId: pipelineRunId, stages: createDefaultStages(), activeStageIndex: 0 });
    },

    setActiveStage: (index) => set({ activeStageIndex: index }),

    advanceToNextStage: () => {
      const { activeStageIndex, stages } = get();
      if (activeStageIndex < stages.length - 1) {
        set({ activeStageIndex: activeStageIndex + 1 });
      }
    },

    setStageStatus: (index, status) => {
      set((state) => {
        const stages = [...state.stages];
        const prevStatus = stages[index].status;
        stages[index] = { ...stages[index], status };
        if (status === 'generating') {
          // Only reset startedAt when transitioning from a non-running state
          // (fresh execution / re-run). Preserve it on idempotent re-applies
          // from backend sync so the elapsed timer survives page refreshes.
          const wasRunning = prevStatus === 'generating' || prevStatus === 'validating';
          if (!wasRunning || !stages[index].startedAt) {
            stages[index].startedAt = new Date().toISOString();
            stages[index].completedAt = null; // Reset so elapsed timer restarts
            stages[index].errorMessage = null;
            stages[index].error = null;
          }
        }
        if (status === 'completed' || status === 'failed' || status === 'approved') {
          stages[index].completedAt = new Date().toISOString();
        }
        const isGenerating = stages.some(
          (s) => s.status === 'generating' || s.status === 'validating',
        );
        return { stages, isGenerating };
      });
    },

    setStageOutput: (index, output) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = { ...stages[index], output };
        return { stages };
      });
    },

    appendStreamingText: (text) => {
      const MAX_STREAMING_CHARS = 150_000;
      set((state) => {
        const newText = state.streamingText + text;
        return {
          streamingText: newText.length > MAX_STREAMING_CHARS
            ? newText.slice(newText.length - MAX_STREAMING_CHARS)
            : newText,
        };
      });
    },

    clearStreamingText: () => set({ streamingText: '' }),

    setStageApproval: (index, status, comment = '') => {
      set((state) => {
        const stages = [...state.stages];
        const stage = stages[index];

        // Only record real approval actions in history (not config states)
        const isRealAction = status === 'approved' || status === 'rejected';
        // Resolve user display name from auth store
        const authUser = useAuthStore.getState().user;
        const userName = authUser?.name
          || (authUser?.first_name ? `${authUser.first_name} ${authUser.last_name || ''}`.trim() : null)
          || authUser?.email
          || 'User';

        const history = isRealAction
          ? [...stage.approvalHistory, {
              action: status as 'approved' | 'rejected',
              timestamp: new Date().toISOString(),
              user: userName,
              comment,
              confidenceScore: stage.validation?.score,
            }]
          : stage.approvalHistory;

        stages[index] = {
          ...stage,
          approvalStatus: status,
          status: status === 'approved' ? 'approved' : stage.status,
          pendingApprovalSince: status === 'approved' ? null : stage.pendingApprovalSince,
          approvalHistory: history,
        };

        // If approved, unlock next stage
        if (status === 'approved' && index + 1 < stages.length) {
          if (stages[index + 1].status === 'idle' || stages[index + 1].status === 'locked') {
            stages[index + 1] = { ...stages[index + 1], status: 'pending' };
          }
        }

        return { stages };
      });
    },

    setStageValidation: (index, validation) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = { ...stages[index], validation };
        return { stages };
      });
    },

    resetStage: (index) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = {
          ...createDefaultStage(stages[index].name),
          approvalHistory: stages[index].approvalHistory, // preserve history
          runCount: stages[index].runCount, // preserve run count
        };
        return { stages, streamingText: '' };
      });
    },

    rerunStage: (index, user) => {
      set((state) => {
        const stages = [...state.stages];
        const current = stages[index];

        const authUser = useAuthStore.getState().user;
        const resolvedUser = user
          || authUser?.name
          || (authUser?.first_name ? `${authUser.first_name} ${authUser.last_name || ''}`.trim() : null)
          || authUser?.email
          || 'User';

        const entry: ApprovalHistoryEntry = {
          action: 'rerun',
          timestamp: new Date().toISOString(),
          user: resolvedUser,
          comment: 'Stage re-run initiated',
        };

        stages[index] = {
          ...current,
          status: 'pending',
          output: '',
          approvalStatus: 'not_required',
          previousValidation: current.validation || current.previousValidation,
          validation: null,
          pendingApprovalSince: null,
          errorMessage: null,
          error: null,
          approvalHistory: [...current.approvalHistory, entry],
        };

        // Cascade: reset all downstream stages (they depend on this output)
        for (let i = index + 1; i < stages.length; i++) {
          if (stages[i].status === 'completed' || stages[i].status === 'approved') {
            stages[i] = {
              ...createDefaultStage(stages[i].name),
              approvalHistory: stages[i].approvalHistory,
              runCount: stages[i].runCount,
            };
          }
        }

        return { stages, activeStageIndex: index, streamingText: '' };
      });
    },

    setPendingApproval: (index) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = {
          ...stages[index],
          approvalStatus: 'pending',
          pendingApprovalSince: new Date().toISOString(),
        };
        return { stages };
      });
    },

    addStageArtifact: (index, artifact) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = {
          ...stages[index],
          artifacts: [...stages[index].artifacts, artifact],
        };
        return { stages };
      });
    },

    addScanSubtask: (index, subtask) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = {
          ...stages[index],
          subtasks: [...stages[index].subtasks, subtask],
        };
        return { stages };
      });
    },

    updateScanSubtask: (index, subtaskId, updates) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = {
          ...stages[index],
          subtasks: stages[index].subtasks.map((st) =>
            st.id === subtaskId ? { ...st, ...updates } : st,
          ),
        };
        return { stages };
      });
    },
  }),
);

// Auto-save state to sessionStorage on every change (debounced)
usePipelineStore.subscribe(debouncedSaveState);

