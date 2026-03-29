import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// ─── Stage Names & Labels ──────────────────────────────────────────

export const STAGE_NAMES = [
  'SCAN',
  'DECODE',
  'BLUEPRINT',
  'SPEC_LOCK',
  'ARCHITECT',
  'FORGE',
  'SHADOW_RUN',
  'EVOLVE',
] as const;

export type StageName = typeof STAGE_NAMES[number];

export const STAGE_LABELS: Record<string, string> = {
  SCAN: 'Scan',
  DECODE: 'Decode',
  BLUEPRINT: 'Blueprint',
  SPEC_LOCK: 'Spec Lock',
  ARCHITECT: 'Architect',
  FORGE: 'Forge',
  SHADOW_RUN: 'Shadow Run',
  EVOLVE: 'Evolve',
};

// ─── Stage Approval ────────────────────────────────────────────────

const STAGES_REQUIRING_APPROVAL = new Set<string>([
  'SPEC_LOCK',
  'BLUEPRINT',
  'ARCHITECT',
]);

export function stageRequiresApproval(stage: string): boolean {
  return STAGES_REQUIRING_APPROVAL.has(stage);
}

// ─── Types ─────────────────────────────────────────────────────────

export type StageStatus =
  | 'idle'
  | 'pending'
  | 'locked'
  | 'generating'
  | 'validating'
  | 'completed'
  | 'approved'
  | 'failed'
  | 'skipped';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'not_required';

export interface StageArtifact {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
  createdAt: string;
}

export interface StageValidation {
  passed: boolean;
  score: number;
  criteria: Array<{
    name: string;
    passed: boolean;
    score: number;
    feedback: string;
  }>;
  summary: string;
  validatedAt: string;
}

export interface ScanSubtaskState {
  id: string;
  type: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
  agentName?: string;
}

export interface StageState {
  name: string;
  /** Human-readable display label (e.g. "Spec Lock") */
  label: string;
  status: StageStatus;
  output: string;
  streamingOutput: string;
  approvalStatus: ApprovalStatus;
  startedAt: string | null;
  completedAt: string | null;
  validation: StageValidation | null;
  artifacts: StageArtifact[];
  subtasks: ScanSubtaskState[];
  tokenUsage: { input: number; output: number; cost: number } | null;
  errorMessage: string | null;
  /** Alias for errorMessage — used by some components as stage.error */
  error?: string | null;
}

interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface UsageByModel {
  [model: string]: { inputTokens: number; outputTokens: number; cost: number; count: number };
}

interface UsageByStage {
  [stageName: string]: { inputTokens: number; outputTokens: number; cost: number; count: number };
}

interface ModernizedFile {
  path: string;
  name?: string;
  content: string;
  language?: string;
  size?: number;
}

interface FeatureFile {
  path: string;
  content: string;
  scenarioCount: number;
  passCount: number;
  failCount: number;
}

interface PipelineState {
  stages: StageState[];
  activeStageIndex: number;
  currentPipelineRunId: string | null;
  currentProjectId: string | null;
  streamingText: string;
  toolCalls: any[];
  logs: any[];
  stageModelOverrides: Record<string, string>;
  stageEvaluatorModelOverrides: Record<string, string>;
  stagePromptOverrides: Record<string, string>;
  stageValidationPromptOverrides: Record<string, string>;
  activeTemplateId: string | null;
  deepAnalysis: boolean;
  runUsage: RunUsage;
  modernizedFiles: ModernizedFile[];
  featureFiles: FeatureFile[];
  /** True when any stage is currently in 'generating' or 'validating' state */
  isGenerating: boolean;
  runUsageByModel: UsageByModel;
  runUsageByStage: UsageByStage;
  lastUsageEventAt: string | null;

  // Actions
  initPipeline: (projectId: string, pipelineRunId: string) => void;
  setActiveStage: (index: number) => void;
  advanceToNextStage: () => void;
  setStageStatus: (index: number, status: StageStatus) => void;
  setStageOutput: (index: number, output: string) => void;
  appendStreamingText: (text: string) => void;
  clearStreamingText: () => void;
  setStageApproval: (index: number, status: 'approved' | 'rejected') => void;
  setStageValidation: (index: number, validation: StageValidation) => void;
  resetStage: (index: number) => void;
  addLog: (entry: any) => void;
  clearLogs: () => void;
  addToolCall: (toolCall: any) => void;
  setStageModelOverride: (stageName: string, modelId: string) => void;
  setStageEvaluatorModelOverride: (stageName: string, modelId: string) => void;
  setStagePromptOverride: (stageName: string, prompt: string) => void;
  clearStagePromptOverride: (stageName: string) => void;
  setStageValidationPromptOverride: (stageName: string, prompt: string) => void;
  clearStageValidationPromptOverride: (stageName: string) => void;
  setActiveTemplateId: (id: string | null) => void;
  setDeepAnalysis: (value: boolean) => void;
  addStageArtifact: (index: number, artifact: StageArtifact) => void;
  addScanSubtask: (index: number, subtask: ScanSubtaskState) => void;
  updateScanSubtask: (index: number, subtaskId: string, updates: Partial<ScanSubtaskState>) => void;
  updateRunUsage: (delta: Partial<RunUsage> & { model?: string; stageName?: string }) => void;
  addModernizedFile: (file: ModernizedFile) => void;
  updateModernizedFile: (path: string, content: string) => void;
  addFeatureFile: (file: FeatureFile) => void;
  clearFeatureFiles: () => void;
}

// ─── Default stage factory ─────────────────────────────────────────

function createDefaultStage(name: string): StageState {
  return {
    name,
    label: STAGE_LABELS[name] ?? name,
    status: 'idle',
    output: '',
    streamingOutput: '',
    approvalStatus: stageRequiresApproval(name) ? 'pending' : 'not_required',
    startedAt: null,
    completedAt: null,
    validation: null,
    artifacts: [],
    subtasks: [],
    tokenUsage: null,
    errorMessage: null,
  };
}

function createDefaultStages(): StageState[] {
  return STAGE_NAMES.map((name) => createDefaultStage(name));
}

// ─── Store ─────────────────────────────────────────────────────────

export const usePipelineStore = create<PipelineState>()(
  persist(
    (set, get) => ({
      stages: createDefaultStages(),
      activeStageIndex: 0,
      currentPipelineRunId: null,
      currentProjectId: null,
      streamingText: '',
      toolCalls: [],
      logs: [],
      stageModelOverrides: {},
      stageEvaluatorModelOverrides: {},
      stagePromptOverrides: {},
      stageValidationPromptOverrides: {},
      activeTemplateId: null,
      deepAnalysis: false,
      runUsage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      modernizedFiles: [],
      featureFiles: [],
      isGenerating: false,
      runUsageByModel: {},
      runUsageByStage: {},
      lastUsageEventAt: null,

      initPipeline: (projectId, pipelineRunId) => {
        set({
          stages: createDefaultStages(),
          activeStageIndex: 0,
          currentPipelineRunId: pipelineRunId,
          currentProjectId: projectId,
          streamingText: '',
          toolCalls: [],
          logs: [],
          runUsage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          modernizedFiles: [],
          featureFiles: [],
          isGenerating: false,
          runUsageByModel: {},
          runUsageByStage: {},
          lastUsageEventAt: null,
        });
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
          stages[index] = { ...stages[index], status };
          if (status === 'generating') {
            stages[index].startedAt = new Date().toISOString();
            stages[index].errorMessage = null;
            stages[index].error = null;
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
        set((state) => ({ streamingText: state.streamingText + text }));
      },

      clearStreamingText: () => set({ streamingText: '' }),

      setStageApproval: (index, status) => {
        set((state) => {
          const stages = [...state.stages];
          stages[index] = {
            ...stages[index],
            approvalStatus: status,
            status: status === 'approved' ? 'approved' : stages[index].status,
          };
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
          stages[index] = createDefaultStage(stages[index].name);
          return { stages, streamingText: '' };
        });
      },

      addLog: (entry) => {
        set((state) => ({ logs: [...state.logs, entry].slice(-500) }));
      },

      clearLogs: () => set({ logs: [] }),

      addToolCall: (toolCall) => {
        set((state) => ({ toolCalls: [...state.toolCalls, toolCall].slice(-100) }));
      },

      setStageModelOverride: (stageName, modelId) => {
        set((state) => ({
          stageModelOverrides: { ...state.stageModelOverrides, [stageName]: modelId },
        }));
      },

      setStageEvaluatorModelOverride: (stageName, modelId) => {
        set((state) => ({
          stageEvaluatorModelOverrides: { ...state.stageEvaluatorModelOverrides, [stageName]: modelId },
        }));
      },

      setStagePromptOverride: (stageName, prompt) => {
        set((state) => ({
          stagePromptOverrides: { ...state.stagePromptOverrides, [stageName]: prompt },
        }));
      },

      clearStagePromptOverride: (stageName) => {
        set((state) => {
          const overrides = { ...state.stagePromptOverrides };
          delete overrides[stageName];
          return { stagePromptOverrides: overrides };
        });
      },

      setStageValidationPromptOverride: (stageName, prompt) => {
        set((state) => ({
          stageValidationPromptOverrides: {
            ...state.stageValidationPromptOverrides,
            [stageName]: prompt,
          },
        }));
      },

      clearStageValidationPromptOverride: (stageName) => {
        set((state) => {
          const overrides = { ...state.stageValidationPromptOverrides };
          delete overrides[stageName];
          return { stageValidationPromptOverrides: overrides };
        });
      },

      setActiveTemplateId: (id) => set({ activeTemplateId: id }),

      setDeepAnalysis: (value) => set({ deepAnalysis: value }),

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

      updateRunUsage: (delta) => {
        set((state) => {
          const model = delta.model;
          const stageName = delta.stageName;
          const dIn = delta.inputTokens ?? 0;
          const dOut = delta.outputTokens ?? 0;
          const dCost = delta.cost ?? 0;

          const runUsageByModel = { ...state.runUsageByModel };
          if (model) {
            const prev = runUsageByModel[model] ?? { inputTokens: 0, outputTokens: 0, cost: 0, count: 0 };
            runUsageByModel[model] = {
              inputTokens: prev.inputTokens + dIn,
              outputTokens: prev.outputTokens + dOut,
              cost: prev.cost + dCost,
              count: prev.count + 1,
            };
          }

          const runUsageByStage = { ...state.runUsageByStage };
          if (stageName) {
            const prev = runUsageByStage[stageName] ?? { inputTokens: 0, outputTokens: 0, cost: 0, count: 0 };
            runUsageByStage[stageName] = {
              inputTokens: prev.inputTokens + dIn,
              outputTokens: prev.outputTokens + dOut,
              cost: prev.cost + dCost,
              count: prev.count + 1,
            };
          }

          return {
            runUsage: {
              inputTokens: state.runUsage.inputTokens + dIn,
              outputTokens: state.runUsage.outputTokens + dOut,
              cost: state.runUsage.cost + dCost,
            },
            runUsageByModel,
            runUsageByStage,
            lastUsageEventAt: new Date().toISOString(),
          };
        });
      },

      addModernizedFile: (file) => {
        set((state) => {
          const existing = state.modernizedFiles.findIndex((f) => f.path === file.path);
          if (existing >= 0) {
            const files = [...state.modernizedFiles];
            files[existing] = file;
            return { modernizedFiles: files };
          }
          return { modernizedFiles: [...state.modernizedFiles, file] };
        });
      },

      updateModernizedFile: (path, content) => {
        set((state) => {
          const files = state.modernizedFiles.map((f) =>
            f.path === path ? { ...f, content, size: content.length } : f
          );
          return { modernizedFiles: files };
        });
      },

      addFeatureFile: (file) => {
        set((state) => {
          const existing = state.featureFiles.findIndex((f) => f.path === file.path);
          if (existing >= 0) {
            const files = [...state.featureFiles];
            files[existing] = file;
            return { featureFiles: files };
          }
          return { featureFiles: [...state.featureFiles, file] };
        });
      },

      clearFeatureFiles: () => set({ featureFiles: [] }),
    }),
    {
      name: 'pipeline-storage',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? localStorage : ({} as Storage),
      ),
      // Exclude large streaming/output fields from persistence
      partialize: (state) => ({
        activeStageIndex: state.activeStageIndex,
        currentPipelineRunId: state.currentPipelineRunId,
        currentProjectId: state.currentProjectId,
        stageModelOverrides: state.stageModelOverrides,
        stageEvaluatorModelOverrides: state.stageEvaluatorModelOverrides,
        stagePromptOverrides: state.stagePromptOverrides,
        stageValidationPromptOverrides: state.stageValidationPromptOverrides,
        activeTemplateId: state.activeTemplateId,
        deepAnalysis: state.deepAnalysis,
        stages: state.stages.map((s) => ({
          ...s,
          output: '', // strip large output — rehydrated from API
          streamingOutput: '',
        })),
      }),
    },
  ),
);

// ─── Selectors / Helpers ────────────────────────────────────────────

/**
 * Returns true if a stage at the given index can be executed.
 * All previous stages must be completed or approved.
 */
export function canExecuteStage(stages: StageState[], index: number): boolean {
  if (index === 0) return true;
  for (let i = 0; i < index; i++) {
    const s = stages[i].status;
    if (s !== 'completed' && s !== 'approved') return false;
  }
  return true;
}

/**
 * Returns a human-readable reason why a stage cannot be executed yet.
 */
export function getStageBlockReason(stages: StageState[], index: number): string | null {
  if (index === 0) return null;
  for (let i = 0; i < index; i++) {
    const s = stages[i];
    if (s.status !== 'completed' && s.status !== 'approved') {
      return `"${STAGE_LABELS[s.name] ?? s.name}" must be completed before this stage can run.`;
    }
  }
  return null;
}
