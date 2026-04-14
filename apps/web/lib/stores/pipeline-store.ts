import { create } from 'zustand';
import { useAuthStore } from './auth-store';
// Activity store is self-contained — persists to sessionStorage, restores on creation.
import {
  type StageStatus,
  type StageValidation,
  type StageArtifact,
  type ApprovalHistoryEntry,
  type ScanSubtaskState,
  type StageState,
  createDefaultStage,
  createDefaultStages,
} from './pipeline-types';

// ─── Types ─────────────────────────────────────────────────────────

interface PipelineStoreState {
  stages: StageState[];
  activeStageIndex: number;
  currentPipelineRunId: string | null;
  currentProjectId: string | null;
  streamingText: string;
  /** True when any stage is currently in 'generating' or 'validating' state */
  isGenerating: boolean;

  // Actions
  initPipeline: (projectId: string, pipelineRunId: string) => void;
  setActiveStage: (index: number) => void;
  advanceToNextStage: () => void;
  setStageStatus: (index: number, status: StageStatus) => void;
  /** Override startedAt — used by backend sync to restore the real server start time after page refresh. */
  setStageStartedAt: (index: number, startedAt: string | null) => void;
  setStageOutput: (index: number, output: string) => void;
  appendStreamingText: (text: string) => void;
  clearStreamingText: () => void;
  setStageApproval: (index: number, status: 'approved' | 'rejected' | 'pending', comment?: string) => void;
  setStageValidation: (index: number, validation: StageValidation) => void;
  resetStage: (index: number) => void;
  /** Re-run a stage: preserves previous validation, clears output, cascades reset to downstream stages */
  rerunStage: (index: number, user?: string) => void;
  /** Mark stage as awaiting approval (sets pendingApprovalSince) */
  setPendingApproval: (index: number) => void;
  addStageArtifact: (index: number, artifact: StageArtifact) => void;
  addScanSubtask: (index: number, subtask: ScanSubtaskState) => void;
  updateScanSubtask: (index: number, subtaskId: string, updates: Partial<ScanSubtaskState>) => void;
}

// ─── Store ─────────────────────────────────────────────────────────

export const usePipelineStore = create<PipelineStoreState>()(
  (set, get) => ({
    stages: createDefaultStages(),
    activeStageIndex: 0,
    currentPipelineRunId: null,
    currentProjectId: null,
    streamingText: '',
    isGenerating: false,

    initPipeline: (projectId, pipelineRunId) => {
      set({
        stages: createDefaultStages(),
        activeStageIndex: 0,
        currentPipelineRunId: pipelineRunId,
        currentProjectId: projectId,
        streamingText: '',
        isGenerating: false,
      });
      // Activity data (token usage, logs, tool calls) is persisted to sessionStorage
      // and auto-restored on store creation. Do NOT reset it here — it would wipe
      // data that survives page refresh. Activity is only reset when a new stage
      // execution starts (via resetActivity call in use-stage-execution).
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

    setStageStartedAt: (index, startedAt) => {
      set((state) => {
        if (state.stages[index]?.startedAt === startedAt) return state;
        const stages = [...state.stages];
        stages[index] = { ...stages[index], startedAt };
        return { stages };
      });
    },

    setStageOutput: (index, output) => {
      set((state) => {
        const stages = [...state.stages];
        stages[index] = { ...stages[index], output };

        // Cache in IndexedDB (async, non-blocking)
        if (output && state.currentPipelineRunId && typeof window !== 'undefined') {
          import('@/lib/pipeline-cache').then(({ setCachedOutput }) => {
            setCachedOutput(state.currentPipelineRunId!, stages[index].name, output);
          }).catch(() => {});
        }

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
          streamingOutput: '',
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

