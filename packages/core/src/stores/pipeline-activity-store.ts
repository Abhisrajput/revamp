import { create } from 'zustand';
import type { RunUsage, UsageByModel, UsageByStage, ModernizedFile, FeatureFile } from '../types/stage';
import { getSessionStorage } from '../api/storage';

// ─── Types ─────────────────────────────────────────────────────────

interface PipelineActivityState {
  logs: any[];
  toolCalls: any[];
  runUsage: RunUsage;
  runUsageByModel: UsageByModel;
  runUsageByStage: UsageByStage;
  lastUsageEventAt: string | null;
  modernizedFiles: ModernizedFile[];
  featureFiles: FeatureFile[];

  // Actions
  addLog: (entry: any) => void;
  clearLogs: () => void;
  addToolCall: (toolCall: any) => void;
  updateRunUsage: (delta: Partial<RunUsage> & { model?: string; stageName?: string }) => void;
  addModernizedFile: (file: ModernizedFile) => void;
  updateModernizedFile: (path: string, content: string) => void;
  addFeatureFile: (file: FeatureFile) => void;
  clearFeatureFiles: () => void;
  resetActivity: () => void;
}

// ─── SessionStorage persistence (survives page refresh) ───────────

const STORAGE_KEY = 'revamp-pipeline-activity';

function saveToSession(state: PipelineActivityState) {
  try {
    getSessionStorage().setItem(STORAGE_KEY, JSON.stringify({
      logs: state.logs.slice(-200),
      toolCalls: state.toolCalls.slice(-50),
      runUsage: state.runUsage,
      runUsageByModel: state.runUsageByModel,
      runUsageByStage: state.runUsageByStage,
      lastUsageEventAt: state.lastUsageEventAt,
    }));
  } catch { /* quota exceeded — non-fatal */ }
}

function loadFromSession(): Partial<PipelineActivityState> | null {
  try {
    const raw = getSessionStorage().getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// Debounce saves — at most every 1 second
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveToSession(usePipelineActivityStore.getState());
  }, 1000);
}

// ─── Store ─────────────────────────────────────────────────────────

// Restore from sessionStorage on creation (handles page refresh)
const cached = loadFromSession();

export const usePipelineActivityStore = create<PipelineActivityState>()(
  (set) => ({
    logs: cached?.logs || [],
    toolCalls: cached?.toolCalls || [],
    runUsage: cached?.runUsage || { inputTokens: 0, outputTokens: 0, cost: 0 },
    runUsageByModel: cached?.runUsageByModel || {},
    runUsageByStage: cached?.runUsageByStage || {},
    lastUsageEventAt: cached?.lastUsageEventAt || null,
    modernizedFiles: [],
    featureFiles: [],

    addLog: (entry) => {
      set((state) => ({ logs: [...state.logs, entry].slice(-500) }));
      debouncedSave();
    },

    clearLogs: () => set({ logs: [] }),

    addToolCall: (toolCall) => {
      set((state) => ({ toolCalls: [...state.toolCalls, toolCall].slice(-100) }));
      debouncedSave();
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
      debouncedSave();
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

    resetActivity: () => {
      set({
        logs: [],
        toolCalls: [],
        runUsage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        runUsageByModel: {},
        runUsageByStage: {},
        lastUsageEventAt: null,
        modernizedFiles: [],
        featureFiles: [],
      });
      // NOTE: Do NOT clear sessionStorage here — resetActivity is called on every
      // page mount via initPipeline. Session cache is only cleared when a new
      // stage execution starts (the first updateRunUsage call overwrites the old data).
    },
  }),
);
