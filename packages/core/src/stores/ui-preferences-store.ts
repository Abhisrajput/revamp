import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getPersistStorage } from '../api/storage';

export type Theme = 'light' | 'dark' | 'system';
export type InspectorTab = 'validation' | 'approval' | 'artifacts' | 'context';
export type BottomDockTab = 'terminal' | 'agent' | 'tokens' | 'history' | 'audit';

export interface PanelConstraints {
  leftRailMin: number;
  leftRailMax: number;
  inspectorMin: number;
  inspectorMax: number;
  bottomDockMin: number;
  bottomDockMax: number;
}

export const PANEL_CONSTRAINTS: PanelConstraints = {
  leftRailMin: 200,
  leftRailMax: 400,
  inspectorMin: 240,
  inspectorMax: 500,
  bottomDockMin: 120,
  bottomDockMax: 480,
};

interface UIPreferencesState {
  // General
  sidebarCollapsed: boolean;
  theme: Theme;

  // Mission control layout
  leftRailCollapsed: boolean;
  rightPanelCollapsed: boolean;
  bottomDockCollapsed: boolean;
  promptEditorOpen: boolean;
  commandPaletteOpen: boolean;
  exportDialogOpen: boolean;
  githubSyncOpen: boolean;

  // Active tabs
  inspectorTab: InspectorTab;
  bottomDockTab: BottomDockTab;

  // Panel widths (px)
  leftRailWidth: number;
  rightPanelWidth: number;
  inspectorWidth: number;
  bottomDockHeight: number;

  setRightPanelWidth: (width: number) => void;

  // Actions
  toggleSidebar: () => void;
  setTheme: (theme: Theme) => void;
  toggleLeftRail: () => void;
  toggleRightPanel: () => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  toggleBottomDock: () => void;
  togglePromptEditor: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setExportDialogOpen: (open: boolean) => void;
  setGithubSyncOpen: (open: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setBottomDockTab: (tab: BottomDockTab) => void;
  setLeftRailWidth: (width: number) => void;
  setInspectorWidth: (width: number) => void;
  setBottomDockHeight: (height: number) => void;
}

export const useUIPreferencesStore = create<UIPreferencesState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: 'system',

      leftRailCollapsed: false,
      rightPanelCollapsed: false,
      bottomDockCollapsed: false,
      promptEditorOpen: false,
      commandPaletteOpen: false,
      exportDialogOpen: false,
      githubSyncOpen: false,

      inspectorTab: 'validation',
      bottomDockTab: 'terminal',

      leftRailWidth: 280,
      rightPanelWidth: 320,
      inspectorWidth: 320,
      bottomDockHeight: 200,

      setRightPanelWidth: (width: number) =>
        set({ rightPanelWidth: Math.max(200, Math.min(600, width)) }),

      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      setTheme: (theme) => set({ theme }),

      toggleLeftRail: () =>
        set((state) => ({ leftRailCollapsed: !state.leftRailCollapsed })),

      toggleRightPanel: () =>
        set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed })),

      setRightPanelCollapsed: (collapsed) => set({ rightPanelCollapsed: collapsed }),

      toggleBottomDock: () =>
        set((state) => ({ bottomDockCollapsed: !state.bottomDockCollapsed })),

      togglePromptEditor: () =>
        set((state) => ({ promptEditorOpen: !state.promptEditorOpen })),

      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      setExportDialogOpen: (open) => set({ exportDialogOpen: open }),
      setGithubSyncOpen: (open) => set({ githubSyncOpen: open }),

      setInspectorTab: (tab) => set({ inspectorTab: tab }),
      setBottomDockTab: (tab) => set({ bottomDockTab: tab }),

      setLeftRailWidth: (width) =>
        set({
          leftRailWidth: Math.min(
            Math.max(width, PANEL_CONSTRAINTS.leftRailMin),
            PANEL_CONSTRAINTS.leftRailMax,
          ),
        }),

      setInspectorWidth: (width) =>
        set({
          inspectorWidth: Math.min(
            Math.max(width, PANEL_CONSTRAINTS.inspectorMin),
            PANEL_CONSTRAINTS.inspectorMax,
          ),
        }),

      setBottomDockHeight: (height) =>
        set({
          bottomDockHeight: Math.min(
            Math.max(height, PANEL_CONSTRAINTS.bottomDockMin),
            PANEL_CONSTRAINTS.bottomDockMax,
          ),
        }),
    }),
    {
      name: 'ui-preferences',
      storage: createJSONStorage(() =>
        getPersistStorage(),
      ),
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        theme: state.theme,
        leftRailCollapsed: state.leftRailCollapsed,
        rightPanelCollapsed: state.rightPanelCollapsed,
        rightPanelWidth: state.rightPanelWidth,
        bottomDockCollapsed: state.bottomDockCollapsed,
        inspectorTab: state.inspectorTab,
        bottomDockTab: state.bottomDockTab,
        leftRailWidth: state.leftRailWidth,
        inspectorWidth: state.inspectorWidth,
        bottomDockHeight: state.bottomDockHeight,
      }),
    },
  ),
);
