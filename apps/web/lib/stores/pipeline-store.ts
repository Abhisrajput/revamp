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
  SCAN: 'Setup',
  DECODE: 'Intent Extraction',
  BLUEPRINT: 'Business Capability Map',
  SPEC_LOCK: 'Behavior Lock-in',
  ARCHITECT: 'Modernization Approach',
  FORGE: 'CoCreate',
  SHADOW_RUN: 'Parallel Run',
  EVOLVE: 'Continuous Modernization',
};

// ─── Stage Approval ────────────────────────────────────────────────

const STAGES_REQUIRING_APPROVAL = new Set<string>([
  'SCAN',
  'DECODE',
  'BLUEPRINT',
  'SPEC_LOCK',
  'ARCHITECT',
  'FORGE',
  'SHADOW_RUN',
  'EVOLVE',
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

export interface ValidationDimensionScore {
  name: string;
  score: number;
  weight: number;
  details: string;
}

export interface ValidationFinding {
  id: string;
  category: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  codeLocation?: string;
}

export interface StageValidation {
  passed: boolean;
  score: number;  // 0-100 composite confidence score
  criteria: Array<{
    name: string;
    passed: boolean;
    score: number;
    feedback: string;
  }>;
  dimensionScores?: ValidationDimensionScore[];
  findings?: ValidationFinding[];
  summary: string;
  validatedAt: string;
}

export interface ApprovalHistoryEntry {
  action: 'approved' | 'rejected' | 'rerun' | 'auto_approved' | 'failed';
  timestamp: string;
  user: string;
  comment: string;
  autoApproved?: boolean;
  confidenceScore?: number;
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
  /** Preserved on re-run for comparison */
  previousValidation: StageValidation | null;
  /** Full audit trail of approve/reject/rerun actions */
  approvalHistory: ApprovalHistoryEntry[];
  /** ISO timestamp when approval was first requested */
  pendingApprovalSince: string | null;
  artifacts: StageArtifact[];
  subtasks: ScanSubtaskState[];
  tokenUsage: { input: number; output: number; cost: number } | null;
  errorMessage: string | null;
  /** Alias for errorMessage — used by some components as stage.error */
  error?: string | null;
  /** Number of times this stage has been executed */
  runCount: number;
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
  setStageApproval: (index: number, status: 'approved' | 'rejected', comment?: string) => void;
  setStageValidation: (index: number, validation: StageValidation) => void;
  resetStage: (index: number) => void;
  /** Re-run a stage: preserves previous validation, clears output, cascades reset to downstream stages */
  rerunStage: (index: number, user?: string) => void;
  /** Mark stage as awaiting approval (sets pendingApprovalSince) */
  setPendingApproval: (index: number) => void;
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
    previousValidation: null,
    approvalHistory: [],
    pendingApprovalSince: null,
    artifacts: [],
    subtasks: [],
    runCount: 0,
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

      setStageApproval: (index, status, comment = '') => {
        set((state) => {
          const stages = [...state.stages];
          const stage = stages[index];

          // Only record real approval actions in history (not config states)
          const isRealAction = status === 'approved' || status === 'rejected';
          const history = isRealAction
            ? [...stage.approvalHistory, {
                action: status as 'approved' | 'rejected',
                timestamp: new Date().toISOString(),
                user: 'User',
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

      rerunStage: (index, user = 'User') => {
        set((state) => {
          const stages = [...state.stages];
          const current = stages[index];

          // Preserve previous validation for comparison, clear current
          const entry: ApprovalHistoryEntry = {
            action: 'rerun',
            timestamp: new Date().toISOString(),
            user,
            comment: 'Stage re-run initiated',
          };

          stages[index] = {
            ...current,
            status: 'pending',
            output: '',
            streamingOutput: '',
            approvalStatus: stageRequiresApproval(current.name) ? 'pending' : 'not_required',
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
      version: 4,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? localStorage : ({} as Storage),
      ),
      migrate: (persisted: any, version: number) => {
        if (persisted && Array.isArray(persisted.stages)) {
          persisted.stages = persisted.stages.map((s: any) => {
            // v3: clean stale data, add new fields, reset stages with no output
            const hasRealOutput = !!(s.output && s.output.length > 10);
            const isStaleCompleted = (s.status === 'completed' || s.status === 'approved') && !hasRealOutput;
            return {
              ...s,
              label: STAGE_LABELS[s.name] ?? s.name,
              // Reset stale "completed" stages that have no output back to pending
              status: isStaleCompleted ? 'pending' : s.status,
              approvalStatus: isStaleCompleted ? 'not_required' : s.approvalStatus,
              // Clean 'not_required' from history
              approvalHistory: (s.approvalHistory || []).filter(
                (e: any) => e.action !== 'not_required',
              ),
              previousValidation: s.previousValidation ?? null,
              pendingApprovalSince: s.pendingApprovalSince ?? null,
              runCount: s.runCount ?? 0,
            };
          });
        }
        return persisted;
      },
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

/** Default confidence threshold — can be overridden per-project via settings.confidenceThreshold */
export const DEFAULT_CONFIDENCE_THRESHOLD = 75;

/**
 * Returns true if a stage at the given index can be executed.
 * Rules:
 *   - All previous stages must be completed or approved
 *   - Current stage must NOT have a pending approval gate
 */
export function canExecuteStage(stages: StageState[], index: number): boolean {
  const current = stages[index];
  // Block if awaiting approval — user must approve/reject first
  if (current?.approvalStatus === 'pending' && current?.pendingApprovalSince) return false;

  if (index === 0) return true;
  for (let i = 0; i < index; i++) {
    const s = stages[i].status;
    if (s !== 'completed' && s !== 'approved') return false;
  }
  return true;
}

/** Returns true if approval should be blocked due to low confidence score. */
export function isApprovalBlocked(stage: StageState, threshold = DEFAULT_CONFIDENCE_THRESHOLD): boolean {
  if (!stage.validation) return false;
  return stage.validation.score < threshold;
}

/** Returns true if this stage has been executed at least once. */
export function hasBeenExecuted(stage: StageState): boolean {
  return stage.runCount > 0 || stage.status === 'completed' || stage.status === 'approved' || stage.status === 'failed';
}

/**
 * Central guard: should the approval gate UI be shown for this stage?
 *
 * Rules (matching legacy-bridge):
 *   - Stage must have completed successfully (status = 'completed' or 'approved')
 *   - Stage must require approval
 *   - Stage must NOT be failed/pending/generating
 *   - Approval gate is for reviewing OUTPUT, not for recovering from errors
 */
export function shouldShowApprovalGate(stage: StageState): boolean {
  // Never show approval gate for failed, pending, generating, or idle stages
  if (stage.status === 'failed' || stage.status === 'pending' || stage.status === 'idle' ||
      stage.status === 'generating' || stage.status === 'validating' || stage.status === 'locked') {
    return false;
  }
  // Only show for stages that require approval
  if (!stageRequiresApproval(stage.name)) return false;
  // Show when completed (awaiting review) or already approved (can re-run)
  return stage.status === 'completed' || stage.status === 'approved';
}

/**
 * Returns a human-readable reason why a stage cannot be executed yet.
 */
export function getStageBlockReason(stages: StageState[], index: number): string | null {
  // Check if current stage has pending approval
  const current = stages[index];
  if (current?.approvalStatus === 'pending') {
    return `This stage is awaiting approval. Review and approve or reject before re-running.`;
  }

  if (index === 0) return null;
  for (let i = 0; i < index; i++) {
    const s = stages[i];
    if (s.status !== 'completed' && s.status !== 'approved') {
      return `"${STAGE_LABELS[s.name] ?? s.name}" must be completed before this stage can run.`;
    }
  }
  return null;
}
