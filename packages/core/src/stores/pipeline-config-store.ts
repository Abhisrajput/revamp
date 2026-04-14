import { getPersistStorage } from '../api/storage';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// ─── Types ─────────────────────────────────────────────────────────

interface PipelineConfigState {
  stageModelOverrides: Record<string, string>;
  stageEvaluatorModelOverrides: Record<string, string>;
  stageComposerModelOverrides: Record<string, string>;
  stagePromptOverrides: Record<string, string>;
  stageValidationPromptOverrides: Record<string, string>;
  activeTemplateId: string | null;
  deepAnalysis: boolean;

  // Actions
  setStageModelOverride: (stageName: string, modelId: string) => void;
  setStageEvaluatorModelOverride: (stageName: string, modelId: string) => void;
  setStageComposerModelOverride: (stageName: string, modelId: string) => void;
  setStagePromptOverride: (stageName: string, prompt: string) => void;
  clearStagePromptOverride: (stageName: string) => void;
  setStageValidationPromptOverride: (stageName: string, prompt: string) => void;
  clearStageValidationPromptOverride: (stageName: string) => void;
  setActiveTemplateId: (id: string | null) => void;
  setDeepAnalysis: (value: boolean) => void;
}

// ─── Store ─────────────────────────────────────────────────────────

export const usePipelineConfigStore = create<PipelineConfigState>()(
  persist(
    (set) => ({
      stageModelOverrides: {},
      stageEvaluatorModelOverrides: {},
      stageComposerModelOverrides: {},
      stagePromptOverrides: {},
      stageValidationPromptOverrides: {},
      activeTemplateId: null,
      deepAnalysis: false,

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

      setStageComposerModelOverride: (stageName, modelId) => {
        set((state) => ({
          stageComposerModelOverrides: { ...state.stageComposerModelOverrides, [stageName]: modelId },
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
    }),
    {
      name: 'pipeline-storage',
      version: 7,
      storage: createJSONStorage(() =>
        getPersistStorage(),
      ),
      migrate: (_persisted: any, version: number) => {
        // Preserve config data across version bumps.
        // Only strip fields that no longer exist in the schema.
        if (version < 7) {
          // v7 was the initial split — extract config fields from old monolithic state
          return {
            stageModelOverrides: _persisted?.stageModelOverrides ?? {},
            stageEvaluatorModelOverrides: _persisted?.stageEvaluatorModelOverrides ?? {},
            stageComposerModelOverrides: _persisted?.stageComposerModelOverrides ?? {},
            stagePromptOverrides: _persisted?.stagePromptOverrides ?? {},
            stageValidationPromptOverrides: _persisted?.stageValidationPromptOverrides ?? {},
            activeTemplateId: _persisted?.activeTemplateId ?? null,
            deepAnalysis: _persisted?.deepAnalysis ?? false,
          };
        }
        return _persisted;
      },
    },
  ),
);
