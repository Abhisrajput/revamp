'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, Save, Loader2, Cpu, ShieldCheck, ChevronDown,
  FileText, Users, MessageSquare, Settings as SettingsIcon,
  Sparkles, Check, X, Plus, Trash2, Upload, ToggleLeft, ToggleRight,
  Zap, Brain, Shield, Eye, Code2,
} from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { Input } from '@revamp/ui/components/input';
import { Badge } from '@revamp/ui/components/badge';
import { apiClient } from '@/lib/api-client';
import { LLMProviderSettings, type LLMProvider, type StageLLMConfig } from '@/components/settings/llm-provider-settings';
import { StageContractsEditor } from '@/components/settings/stage-contracts-editor';
import { STAGE_NAMES, STAGE_LABELS } from '@revamp/core';
import Link from 'next/link';

// ─── Constants ────────────────────────────────────────────────

const TABS = [
  { id: 'llm', label: 'LLM & Models', icon: Cpu, description: 'Providers, models & validation' },
  { id: 'prompts', label: 'Prompts', icon: MessageSquare, description: 'Templates & stage prompts' },
  { id: 'contracts', label: 'Validation', icon: ShieldCheck, description: 'Stage validation contracts' },
  { id: 'team', label: 'Team & Approval', icon: Users, description: 'Members & gates' },
  { id: 'config', label: 'Configuration', icon: SettingsIcon, description: 'Project settings' },
];

const STAGE_ICONS: Record<string, typeof Eye> = {
  SCAN: Eye,
  DECODE: Brain,
  BLUEPRINT: Code2,
  SPEC_LOCK: Shield,
  ARCHITECT: Zap,
  FORGE: Sparkles,
  SHADOW_RUN: ToggleLeft,
  EVOLVE: ToggleRight,
};

const APPROVAL_STAGES = ['BLUEPRINT', 'SPEC_LOCK', 'ARCHITECT', 'SHADOW_RUN'] as const;

const ROLES = [
  { id: 'admin', label: 'Admin', color: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400' },
  { id: 'architect', label: 'Architect', color: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' },
  { id: 'developer', label: 'Developer', color: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  { id: 'sme', label: 'SME', color: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400' },
];

const TEMPLATE_CATEGORIES = [
  { id: 'Foundation', icon: Shield, color: 'border-blue-100 dark:border-blue-900' },
  { id: 'Web Apps', icon: Code2, color: 'border-emerald-100 dark:border-emerald-900' },
  { id: 'Architecture', icon: Zap, color: 'border-purple-100 dark:border-purple-900' },
  { id: 'Infrastructure', icon: Cpu, color: 'border-orange-100 dark:border-orange-900' },
  { id: 'Strategy', icon: Brain, color: 'border-rose-100 dark:border-rose-900' },
  { id: 'Design', icon: Sparkles, color: 'border-cyan-100 dark:border-cyan-900' },
];

// ─── Section header ──────────────────────────────────────────

function SectionCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#f9faf9] dark:bg-slate-900 rounded-2xl border border-[#e2e8e4] dark:border-slate-800 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function SectionHeader({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description?: string;
  icon?: typeof Cpu;
}) {
  return (
    <div className="px-6 pt-5 pb-4">
      <div className="flex items-center gap-2.5">
        {Icon && <Icon className="w-[18px] h-[18px] text-primary-600 dark:text-primary-400" />}
        <h3 className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">{title}</h3>
      </div>
      {description && (
        <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1 ml-[30px]">{description}</p>
      )}
    </div>
  );
}

function SectionBody({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-6 pb-6 ${className}`}>{children}</div>;
}

// ─── Component ─────────────────────────────────────────────

export default function ProjectSettingsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('llm');

  // ─── Data Queries ────────────────────────────────────────
  const { data: project, isLoading } = useQuery<any>({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/projects/${projectId}`);
      return res.data;
    },
  });

  const { data: presetTemplates } = useQuery<any[]>({
    queryKey: ['preset-templates'],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/templates/presets');
        return res.data;
      } catch {
        return [];
      }
    },
  });

  // ─── LLM Tab State ─────────────────────────────────────
  const [defaultExecutionModel, setDefaultExecutionModel] = useState('claude-sonnet-4-20250514');
  const [defaultEvaluatorModel, setDefaultEvaluatorModel] = useState('claude-3-5-haiku-20241022');
  const [validationWeights, setValidationWeights] = useState({
    deterministic: 35,
    contract: 30,
    llmEval: 35,
  });
  const [validationDirty, setValidationDirty] = useState(false);

  // ─── LLM Provider State ──────────────────────────────
  const [llmProviders, setLlmProviders] = useState<LLMProvider[]>([]);
  const [stageLlmConfigs, setStageLlmConfigs] = useState<StageLLMConfig[]>([]);
  const [providersDirty, setProvidersDirty] = useState(false);

  // ─── Prompts Tab State ──────────────────────────────────
  const [editedPromptIndex, setEditedPromptIndex] = useState<number | null>(null);
  const [editedPromptText, setEditedPromptText] = useState('');
  const [editedValidationPromptIndex, setEditedValidationPromptIndex] = useState<number | null>(null);
  const [editedValidationPromptText, setEditedValidationPromptText] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // ─── Team Tab State ─────────────────────────────────────
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('developer');
  const [approvalMatrix, setApprovalMatrix] = useState<Record<string, string>>({
    BLUEPRINT: 'architect',
    SPEC_LOCK: 'architect',
    ARCHITECT: 'architect',
    SHADOW_RUN: 'admin',
  });
  const [approvalDirty, setApprovalDirty] = useState(false);

  // ─── Config Tab State ───────────────────────────────────
  const [generalForm, setGeneralForm] = useState({
    name: '',
    description: '',
    confidenceThreshold: 75,
    maxTokens: 16384,
    autoApprovalEnabled: false,
    autoApprovalTimeoutHours: 3,
  });
  const [codebaseForm, setCodebaseForm] = useState({
    target_stack: '',
    target_cloud: '',
  });
  const [deepAnalysis, setDeepAnalysis] = useState<Record<string, boolean>>({});
  const [configDirty, setConfigDirty] = useState(false);

  // ─── Sync state when project loads ──────────────────────
  useEffect(() => {
    if (!project) return;
    const settings = (project.settings ?? {}) as Record<string, unknown>;

    const llmConfig = settings.llmModels || {};
    if (llmConfig.defaultExecution) setDefaultExecutionModel(llmConfig.defaultExecution);
    if (llmConfig.defaultEvaluator) setDefaultEvaluatorModel(llmConfig.defaultEvaluator);

    const savedProviders = settings.llmProviders || [];
    const savedStageConfigs = settings.stageLlmConfigs || [];
    setLlmProviders(savedProviders);
    setStageLlmConfigs(savedStageConfigs);
    setProvidersDirty(false);

    const vw = settings.validationWeights || {};
    setValidationWeights({
      deterministic: vw.deterministic ?? 35,
      contract: vw.contract ?? 30,
      llmEval: vw.llmEval ?? 35,
    });
    setValidationDirty(false);

    setSelectedTemplateId(project.prompt_template_id || null);

    const am = settings.approvalMatrix || {};
    setApprovalMatrix({
      BLUEPRINT: am.BLUEPRINT || 'architect',
      SPEC_LOCK: am.SPEC_LOCK || 'architect',
      ARCHITECT: am.ARCHITECT || 'architect',
      SHADOW_RUN: am.SHADOW_RUN || 'admin',
    });
    setApprovalDirty(false);

    setGeneralForm({
      name: project.name || '',
      description: project.description || '',
      confidenceThreshold: settings.confidenceThreshold ?? 75,
      maxTokens: settings.maxTokens ?? 16384,
      autoApprovalEnabled: settings.autoApprovalEnabled ?? false,
      autoApprovalTimeoutHours: settings.autoApprovalTimeoutHours ?? 3,
    });
    setCodebaseForm({
      target_stack: project.target_stack || '',
      target_cloud: project.target_cloud || '',
    });
    setDeepAnalysis((project.deep_analysis as Record<string, boolean>) || {});
    setConfigDirty(false);
  }, [project]);

  // ─── Update Helpers ─────────────────────────────────────
  const updateConfig = useCallback(
    <K extends keyof typeof generalForm>(key: K, value: (typeof generalForm)[K]) => {
      setGeneralForm((prev) => ({ ...prev, [key]: value }));
      setConfigDirty(true);
    },
    [],
  );

  const updateCodebase = useCallback(
    <K extends keyof typeof codebaseForm>(key: K, value: (typeof codebaseForm)[K]) => {
      setCodebaseForm((prev) => ({ ...prev, [key]: value }));
      setConfigDirty(true);
    },
    [],
  );

  // ─── Mutations ──────────────────────────────────────────
  const saveProviders = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/projects/${projectId}`, {
        settings: {
          llmProviders: llmProviders,
          stageLlmConfigs: stageLlmConfigs,
          llmModels: {
            defaultExecution: defaultExecutionModel,
            defaultEvaluator: defaultEvaluatorModel,
          },
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setProvidersDirty(false);
    },
  });

  const saveValidation = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/projects/${projectId}`, {
        settings: { validationWeights },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setValidationDirty(false);
    },
  });

  const savePrompt = useMutation({
    mutationFn: async ({ stageIndex, prompt, type }: { stageIndex: number; prompt: string; type: string }) => {
      const res = await apiClient.put(`/projects/${projectId}/prompts/${stageIndex}`, {
        prompt,
        type,
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setEditedPromptIndex(null);
    },
  });

  const applyTemplate = useMutation({
    mutationFn: async (templateId: string) => {
      await apiClient.post(`/projects/${projectId}/apply-template`, {
        template_id: templateId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const sendInvite = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/projects/${projectId}/invitations`, {
        email: inviteEmail,
        role: inviteRole,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setInviteEmail('');
    },
  });

  const saveApproval = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/projects/${projectId}`, {
        settings: { approvalMatrix },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setApprovalDirty(false);
    },
  });

  const saveConfig = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/projects/${projectId}`, {
        name: generalForm.name,
        description: generalForm.description,
        target_stack: codebaseForm.target_stack,
        target_cloud: codebaseForm.target_cloud,
        deep_analysis: deepAnalysis,
        settings: {
          confidenceThreshold: generalForm.confidenceThreshold,
          maxTokens: generalForm.maxTokens,
          autoApprovalEnabled: generalForm.autoApprovalEnabled,
          autoApprovalTimeoutHours: generalForm.autoApprovalTimeoutHours,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setConfigDirty(false);
    },
  });

  // ─── Derived ────────────────────────────────────────────

  const stagePrompts = useMemo(
    () => (project?.stage_prompts as Record<string, string>) || {},
    [project],
  );

  const validationPrompts = useMemo(
    () => (project?.validation_prompts as Record<string, string>) || {},
    [project],
  );

  const groupedTemplates = useMemo(() => {
    if (!presetTemplates?.length) return {};
    const groups: Record<string, any[]> = {};
    presetTemplates.forEach((t) => {
      const cat = t.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    });
    return groups;
  }, [presetTemplates]);

  // ─── Loading ────────────────────────────────────────────
  if (isLoading || !project) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
          <p className="text-sm text-slate-400">Loading settings...</p>
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Link
            href={`/projects/${projectId}`}
            className="flex items-center gap-1.5 text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 transition-colors group"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
              Settings
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {project.name}
            </p>
          </div>
        </div>
      </div>

      {/* Horizontal tabs */}
      <div className="flex gap-1 mb-6 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                isActive
                  ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className={`space-y-5 ${activeTab === 'prompts' ? 'max-w-6xl' : 'max-w-3xl'}`}>
          {/* ════════════════════════════════════════════════ */}
          {/* LLM TAB                                         */}
          {/* ════════════════════════════════════════════════ */}
          {activeTab === 'llm' && (
            <>
              <LLMProviderSettings
                projectId={projectId}
                providers={llmProviders}
                stageConfigs={stageLlmConfigs}
                onProvidersChange={setLlmProviders}
                onStageConfigsChange={setStageLlmConfigs}
                defaultExecutionModel={defaultExecutionModel}
                onDefaultExecutionModelChange={setDefaultExecutionModel}
                defaultEvaluatorModel={defaultEvaluatorModel}
                onDefaultEvaluatorModelChange={setDefaultEvaluatorModel}
                onDirty={() => setProvidersDirty(true)}
                onSaveNow={() => saveProviders.mutate()}
              />

              <div className="flex justify-end">
                <Button
                  onClick={() => saveProviders.mutate()}
                  disabled={saveProviders.isPending || !providersDirty}
                  className={providersDirty
                    ? "rounded-xl bg-primary-600 hover:bg-primary-700 text-white shadow-sm"
                    : "rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 shadow-sm cursor-not-allowed"
                  }
                >
                  {saveProviders.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                  {providersDirty ? 'Save LLM Config' : 'LLM Config Saved'}
                </Button>
              </div>

              {/* 3-Phase Validation */}
              <SectionCard>
                <SectionHeader
                  icon={ShieldCheck}
                  title="Validation Scoring Weights"
                  description="Adjust the weight distribution for the composite validation score. Weights must sum to 100%."
                />
                <SectionBody>
                  <div className="grid grid-cols-3 gap-4">
                    {[
                      { key: 'deterministic' as const, label: 'Deterministic', desc: '9 automated checks', color: 'bg-blue-50 dark:bg-blue-950/30 border-blue-100 dark:border-blue-900' },
                      { key: 'contract' as const, label: 'Contract', desc: 'Format & artifact checks', color: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900' },
                      { key: 'llmEval' as const, label: 'LLM Evaluation', desc: 'AI-scored quality', color: 'bg-purple-50 dark:bg-purple-950/30 border-purple-100 dark:border-purple-900' },
                    ].map(({ key, label, desc, color }) => (
                      <div key={key} className={`p-4 rounded-xl border ${color}`}>
                        <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-200">{label}</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 mb-3">{desc}</p>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={validationWeights[key]}
                            onChange={(e) => {
                              setValidationWeights((prev) => ({ ...prev, [key]: Number(e.target.value) }));
                              setValidationDirty(true);
                            }}
                            className="w-16 text-center text-sm rounded-lg h-9"
                          />
                          <span className="text-[13px] text-slate-400 font-medium">%</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {validationWeights.deterministic + validationWeights.contract + validationWeights.llmEval !== 100 && (
                    <p className="text-xs text-red-500 dark:text-red-400 flex items-center gap-1.5 mt-3 bg-red-50 dark:bg-red-950/20 px-3 py-2 rounded-lg">
                      <X className="w-3.5 h-3.5" />
                      Weights must sum to 100% (currently {validationWeights.deterministic + validationWeights.contract + validationWeights.llmEval}%)
                    </p>
                  )}

                  {validationDirty && (
                    <div className="flex justify-end pt-4 mt-4 border-t border-[#e2e8e4] dark:border-slate-800">
                      <Button
                        onClick={() => saveValidation.mutate()}
                        disabled={saveValidation.isPending || validationWeights.deterministic + validationWeights.contract + validationWeights.llmEval !== 100}
                        className="rounded-xl bg-primary-600 hover:bg-primary-700 text-white shadow-sm"
                      >
                        {saveValidation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                        Save Weights
                      </Button>
                    </div>
                  )}
                </SectionBody>
              </SectionCard>
            </>
          )}

          {/* ════════════════════════════════════════════════ */}
          {/* PROMPTS TAB                                     */}
          {/* ════════════════════════════════════════════════ */}
          {activeTab === 'prompts' && (
            <>
              {/* Template Card Grid */}
              <SectionCard>
                <SectionHeader
                  icon={Sparkles}
                  title="Prompt Templates"
                  description="Apply a curated template to pre-fill all 8 stage prompts."
                />
                <SectionBody>
                  {selectedTemplateId && (
                    <div className="flex items-center gap-2 mb-4 text-[13px] text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-950/20 px-3 py-2 rounded-lg">
                      <Check className="w-3.5 h-3.5" />
                      Active template: <span className="font-medium">{selectedTemplateId}</span>
                    </div>
                  )}

                  {presetTemplates && presetTemplates.length > 0 ? (
                    <div className="space-y-5">
                      {TEMPLATE_CATEGORIES.map((cat) => {
                        const templates = groupedTemplates[cat.id];
                        if (!templates?.length) return null;
                        const CatIcon = cat.icon;
                        return (
                          <div key={cat.id}>
                            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2.5">
                              <CatIcon className="w-3 h-3" />
                              {cat.id}
                            </h4>
                            <div className="grid grid-cols-2 gap-3">
                              {templates.map((t: any) => {
                                const isActive = selectedTemplateId === t.id;
                                return (
                                  <button
                                    key={t.id}
                                    onClick={() => {
                                      setSelectedTemplateId(t.id);
                                      applyTemplate.mutate(t.id);
                                    }}
                                    className={`text-left p-4 rounded-xl border-2 transition-all duration-200 ${
                                      isActive
                                        ? 'border-primary-400 dark:border-primary-600 bg-primary-50/60 dark:bg-primary-950/20'
                                        : 'border-[#e2e8e4] dark:border-slate-800 hover:border-slate-200 dark:hover:border-slate-700 bg-[#f9faf9] dark:bg-slate-900'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2 mb-1">
                                      <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">{t.name}</p>
                                      {isActive && <Check className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400" />}
                                    </div>
                                    <p className="text-[12px] text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-2">{t.description}</p>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { id: 'lean-modernization-multi-project', name: 'Lean Multi-Project', cat: 'Foundation', desc: 'Low-token prompts for repeatable migrations' },
                        { id: 'python-spa-modernization', name: 'Python + SPA', cat: 'Web Apps', desc: 'Flask/Django + Vue/React stack migrations' },
                        { id: 'model-agnostic-baseline', name: 'Model-Agnostic', cat: 'Foundation', desc: 'Provider-neutral prompts for any LLM' },
                        { id: 'microservices-decomposition', name: 'Microservices', cat: 'Architecture', desc: 'Monolith-to-microservices decomposition' },
                        { id: 'event-driven', name: 'Event-Driven', cat: 'Architecture', desc: 'Event-sourcing & CQRS patterns' },
                        { id: 'api-first', name: 'API-First', cat: 'Architecture', desc: 'API gateway + contract-first design' },
                        { id: 'cloud-native', name: 'Cloud-Native', cat: 'Infrastructure', desc: 'Kubernetes + containers + serverless' },
                        { id: 'strangler-fig', name: 'Strangler Fig', cat: 'Strategy', desc: 'Incremental migration with anti-corruption layers' },
                        { id: 'ddd', name: 'Domain-Driven Design', cat: 'Design', desc: 'Bounded contexts & aggregate boundaries' },
                      ].map((t) => {
                        const isActive = selectedTemplateId === t.id;
                        return (
                          <button
                            key={t.id}
                            onClick={() => {
                              setSelectedTemplateId(t.id);
                              applyTemplate.mutate(t.id);
                            }}
                            className={`text-left p-4 rounded-xl border-2 transition-all duration-200 ${
                              isActive
                                ? 'border-primary-400 dark:border-primary-600 bg-primary-50/60 dark:bg-primary-950/20'
                                : 'border-[#e2e8e4] dark:border-slate-800 hover:border-slate-200 dark:hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-50">{t.name}</p>
                              {isActive && <Check className="w-3 h-3 text-primary-600 dark:text-primary-400" />}
                            </div>
                            <Badge className="text-[9px] mb-1.5 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-medium">{t.cat}</Badge>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{t.desc}</p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </SectionBody>
              </SectionCard>

              {/* Per-Stage Prompt & Validation Prompt Editing (side by side) */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <SectionCard>
                <SectionHeader
                  icon={MessageSquare}
                  title="Stage Prompts"
                  description="Customize the AI prompt for each pipeline stage."
                />
                <SectionBody>
                  <div className="space-y-1.5">
                    {STAGE_NAMES.map((name, index) => {
                      const prompt = stagePrompts[String(index)] || '';
                      const isEditing = editedPromptIndex === index;
                      const Icon = STAGE_ICONS[name] || Eye;
                      return (
                        <div key={name} className="rounded-xl border border-[#e2e8e4] dark:border-slate-800 overflow-hidden">
                          <button
                            onClick={() => {
                              if (isEditing) {
                                setEditedPromptIndex(null);
                              } else {
                                setEditedPromptIndex(index);
                                setEditedPromptText(prompt);
                              }
                            }}
                            className="w-full flex items-center justify-between p-3.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                                <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                              </div>
                              <div>
                                <span className="text-[13px] font-medium text-slate-900 dark:text-slate-50">
                                  {STAGE_LABELS[name]}
                                </span>
                                {prompt && (
                                  <span className="ml-2 text-[11px] text-slate-400 dark:text-slate-500">
                                    {prompt.length} chars
                                  </span>
                                )}
                              </div>
                            </div>
                            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isEditing ? 'rotate-180' : ''}`} />
                          </button>
                          {isEditing && (
                            <div className="px-4 pb-4 space-y-3 border-t border-[#e2e8e4] dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30">
                              <textarea
                                className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-[#f9faf9] dark:bg-slate-950 px-4 py-3 text-[13px] text-slate-900 dark:text-slate-100 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 min-h-[140px] mt-3 resize-y"
                                value={editedPromptText}
                                onChange={(e) => setEditedPromptText(e.target.value)}
                                placeholder={`Enter the system prompt for ${STAGE_LABELS[name]}...`}
                              />
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] text-slate-400">
                                  {editedPromptText.length} characters · ~{Math.ceil(editedPromptText.length / 4)} tokens
                                </span>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="ghost"
                                    onClick={() => setEditedPromptIndex(null)}
                                    className="rounded-xl text-[13px] h-9"
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    onClick={() => savePrompt.mutate({ stageIndex: index, prompt: editedPromptText, type: 'stage' })}
                                    disabled={savePrompt.isPending}
                                    className="rounded-xl bg-primary-600 hover:bg-primary-700 text-white text-[13px] h-9"
                                  >
                                    {savePrompt.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
                                    Save
                                  </Button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </SectionBody>
              </SectionCard>

              {/* Per-Stage Validation Prompt Editing */}
              <SectionCard>
                <SectionHeader
                  icon={ShieldCheck}
                  title="Validation Prompts"
                  description="Customize the validation prompt used to evaluate each stage's output."
                />
                <SectionBody>
                  <div className="space-y-1.5">
                    {STAGE_NAMES.map((name, index) => {
                      const prompt = validationPrompts[String(index)] || '';
                      const isEditing = editedValidationPromptIndex === index;
                      const Icon = STAGE_ICONS[name] || Eye;
                      return (
                        <div key={name} className="rounded-xl border border-[#e2e8e4] dark:border-slate-800 overflow-hidden">
                          <button
                            onClick={() => {
                              if (isEditing) {
                                setEditedValidationPromptIndex(null);
                              } else {
                                setEditedValidationPromptIndex(index);
                                setEditedValidationPromptText(prompt);
                              }
                            }}
                            className="w-full flex items-center justify-between p-3.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-7 h-7 rounded-lg bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
                                <Icon className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                              </div>
                              <div>
                                <span className="text-[13px] font-medium text-slate-900 dark:text-slate-50">
                                  {STAGE_LABELS[name]}
                                </span>
                                {prompt && (
                                  <span className="ml-2 text-[11px] text-slate-400 dark:text-slate-500">
                                    {prompt.length} chars
                                  </span>
                                )}
                              </div>
                            </div>
                            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isEditing ? 'rotate-180' : ''}`} />
                          </button>
                          {isEditing && (
                            <div className="px-4 pb-4 space-y-3 border-t border-[#e2e8e4] dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/30">
                              <textarea
                                className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-[#f9faf9] dark:bg-slate-950 px-4 py-3 text-[13px] text-slate-900 dark:text-slate-100 font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 min-h-[140px] mt-3 resize-y"
                                value={editedValidationPromptText}
                                onChange={(e) => setEditedValidationPromptText(e.target.value)}
                                placeholder={`Enter the validation prompt for ${STAGE_LABELS[name]}...`}
                              />
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] text-slate-400">
                                  {editedValidationPromptText.length} characters · ~{Math.ceil(editedValidationPromptText.length / 4)} tokens
                                </span>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="ghost"
                                    onClick={() => setEditedValidationPromptIndex(null)}
                                    className="rounded-xl text-[13px] h-9"
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    onClick={() => savePrompt.mutate({ stageIndex: index, prompt: editedValidationPromptText, type: 'validation' })}
                                    disabled={savePrompt.isPending}
                                    className="rounded-xl bg-primary-600 hover:bg-primary-700 text-white text-[13px] h-9"
                                  >
                                    {savePrompt.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
                                    Save
                                  </Button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </SectionBody>
              </SectionCard>
              </div>
            </>
          )}

          {/* ════════════════════════════════════════════════ */}
          {/* VALIDATION CONTRACTS TAB                        */}
          {/* ════════════════════════════════════════════════ */}
          {activeTab === 'contracts' && (
            <StageContractsEditor projectId={projectId} />
          )}

          {/* ════════════════════════════════════════════════ */}
          {/* TEAM & APPROVAL TAB                             */}
          {/* ════════════════════════════════════════════════ */}
          {activeTab === 'team' && (
            <>
              {/* Team Members */}
              <SectionCard>
                <SectionHeader
                  icon={Users}
                  title="Team Members"
                  description="Manage who has access to this project and their roles."
                />
                <SectionBody>
                  {/* Invite Form */}
                  <div className="flex gap-2 mb-5 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-[#e2e8e4] dark:border-slate-800">
                    <Input
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="colleague@company.com"
                      className="flex-1 rounded-xl h-10 text-[13px]"
                    />
                    <div className="relative w-36">
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                        className="w-full appearance-none rounded-xl border border-slate-200 dark:border-slate-700 bg-[#f9faf9] dark:bg-slate-800 text-[13px] text-slate-900 dark:text-slate-100 pl-3 pr-8 h-10 focus:outline-none focus:ring-2 focus:ring-primary-500/30"
                      >
                        {ROLES.map((r) => (
                          <option key={r.id} value={r.id}>{r.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    </div>
                    <Button
                      onClick={() => sendInvite.mutate()}
                      disabled={!inviteEmail || sendInvite.isPending}
                      className="rounded-xl bg-primary-600 hover:bg-primary-700 text-white h-10"
                    >
                      {sendInvite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
                      Invite
                    </Button>
                  </div>

                  {/* Members List */}
                  {project.members && project.members.length > 0 ? (
                    <div className="space-y-2">
                      {project.members.map((m: any) => {
                        const roleInfo = ROLES.find((r) => r.id === m.role) || ROLES[2];
                        return (
                          <div key={m.id} className="flex items-center justify-between p-3.5 rounded-xl border border-[#e2e8e4] dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-semibold text-sm shrink-0">
                                {(m.user?.first_name?.[0] || m.user?.email?.[0] || '?').toUpperCase()}
                              </div>
                              <div>
                                <p className="text-[13px] font-medium text-slate-900 dark:text-slate-50">
                                  {m.user?.first_name
                                    ? `${m.user.first_name} ${m.user.last_name || ''}`
                                    : m.user?.email || 'Unknown'}
                                </p>
                                <p className="text-[12px] text-slate-400 dark:text-slate-500">{m.user?.email}</p>
                              </div>
                            </div>
                            <Badge className={`${roleInfo.color} font-medium text-[11px] px-2.5 py-0.5 rounded-lg`}>
                              {roleInfo.label}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-10">
                      <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-3">
                        <Users className="w-5 h-5 text-slate-400" />
                      </div>
                      <p className="text-[13px] text-slate-500 dark:text-slate-400">No team members yet</p>
                      <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-1">Invite collaborators above</p>
                    </div>
                  )}
                </SectionBody>
              </SectionCard>

              {/* Approval Gates */}
              <SectionCard>
                <SectionHeader
                  icon={Shield}
                  title="Approval Gates"
                  description="Configure which role must approve each gated stage."
                />
                <SectionBody>
                  <div className="space-y-2">
                    {APPROVAL_STAGES.map((name) => {
                      const Icon = STAGE_ICONS[name] || Eye;
                      return (
                        <div key={name} className="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                              <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                            </div>
                            <span className="text-[13px] font-medium text-slate-700 dark:text-slate-300">
                              {STAGE_LABELS[name]}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              <select
                                value={approvalMatrix[name] || 'architect'}
                                onChange={(e) => {
                                  setApprovalMatrix((prev) => ({ ...prev, [name]: e.target.value }));
                                  setApprovalDirty(true);
                                }}
                                className="appearance-none rounded-xl border border-slate-200 dark:border-slate-700 bg-[#f9faf9] dark:bg-slate-800 text-[13px] text-slate-900 dark:text-slate-100 pl-3 pr-8 h-9 focus:outline-none focus:ring-2 focus:ring-primary-500/30"
                              >
                                {ROLES.map((r) => (
                                  <option key={r.id} value={r.id}>{r.label}</option>
                                ))}
                              </select>
                              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                            </div>
                            <Badge className="bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 text-[10px] px-2 py-0.5 rounded-md font-medium">
                              Gate
                            </Badge>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Auto-Approval */}
                  <div className="mt-5 p-4 rounded-xl border border-[#e2e8e4] dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Auto-Approval Timeout</p>
                        <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">
                          Stages auto-approve if no action taken within the timeout
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={168}
                          value={generalForm.autoApprovalTimeoutHours}
                          onChange={(e) => {
                            updateConfig('autoApprovalTimeoutHours', Number(e.target.value));
                            setApprovalDirty(true);
                          }}
                          className="w-16 text-center text-sm rounded-lg h-9"
                        />
                        <span className="text-[12px] text-slate-400 font-medium">hrs</span>
                        <button
                          onClick={() => {
                            updateConfig('autoApprovalEnabled', !generalForm.autoApprovalEnabled);
                            setApprovalDirty(true);
                          }}
                          className={`ml-2 relative w-11 h-6 rounded-full transition-colors duration-200 ${
                            generalForm.autoApprovalEnabled
                              ? 'bg-primary-500'
                              : 'bg-slate-200 dark:bg-slate-700'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                              generalForm.autoApprovalEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  </div>

                  {approvalDirty && (
                    <div className="flex justify-end pt-4 mt-4 border-t border-[#e2e8e4] dark:border-slate-800">
                      <Button
                        onClick={() => saveApproval.mutate()}
                        disabled={saveApproval.isPending}
                        className="rounded-xl bg-primary-600 hover:bg-primary-700 text-white shadow-sm"
                      >
                        {saveApproval.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                        Save Approval Config
                      </Button>
                    </div>
                  )}
                </SectionBody>
              </SectionCard>
            </>
          )}

          {/* ════════════════════════════════════════════════ */}
          {/* CONFIGURATION TAB                               */}
          {/* ════════════════════════════════════════════════ */}
          {activeTab === 'config' && (
            <>
              {/* General */}
              <SectionCard>
                <SectionHeader icon={SettingsIcon} title="General" description="Project name, description, and core settings" />
                <SectionBody>
                  <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                          Project Name
                        </label>
                        <Input
                          value={generalForm.name}
                          onChange={(e) => updateConfig('name', e.target.value)}
                          className="rounded-xl h-10 text-[13px]"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                            Confidence %
                          </label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={generalForm.confidenceThreshold}
                            onChange={(e) => updateConfig('confidenceThreshold', Number(e.target.value))}
                            className="rounded-xl h-10 text-[13px]"
                          />
                        </div>
                        <div>
                          <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                            Max Tokens
                          </label>
                          <Input
                            type="number"
                            value={generalForm.maxTokens}
                            onChange={(e) => updateConfig('maxTokens', Number(e.target.value))}
                            className="rounded-xl h-10 text-[13px]"
                          />
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                        Description
                      </label>
                      <textarea
                        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-[#f9faf9] dark:bg-slate-950 px-4 py-3 text-[13px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 min-h-[80px] resize-y"
                        value={generalForm.description}
                        onChange={(e) => updateConfig('description', e.target.value)}
                      />
                    </div>
                  </div>
                </SectionBody>
              </SectionCard>

              {/* Codebase */}
              <SectionCard>
                <SectionHeader icon={Code2} title="Codebase" description="Source and target stack configuration" />
                <SectionBody>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                        Source Type
                      </label>
                      <Input
                        value={project.source_type || 'Not set'}
                        readOnly
                        className="rounded-xl h-10 text-[13px] bg-slate-50 dark:bg-slate-900 text-slate-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                        Source URL
                      </label>
                      <Input
                        value={project.source_url || 'Not set'}
                        readOnly
                        className="rounded-xl h-10 text-[13px] bg-slate-50 dark:bg-slate-900 text-slate-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                        Target Stack
                      </label>
                      <Input
                        value={codebaseForm.target_stack}
                        onChange={(e) => updateCodebase('target_stack', e.target.value)}
                        placeholder="e.g., java-spring"
                        className="rounded-xl h-10 text-[13px]"
                      />
                    </div>
                    <div>
                      <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-2">
                        Target Cloud
                      </label>
                      <Input
                        value={codebaseForm.target_cloud}
                        onChange={(e) => updateCodebase('target_cloud', e.target.value)}
                        placeholder="e.g., aws"
                        className="rounded-xl h-10 text-[13px]"
                      />
                    </div>
                  </div>
                </SectionBody>
              </SectionCard>

              {/* Deep Analysis */}
              <SectionCard>
                <SectionHeader
                  icon={Brain}
                  title="Deep Analysis Mode"
                  description="Enable multi-agent review+refine loops per stage"
                />
                <SectionBody>
                  <div className="grid grid-cols-2 gap-2">
                    {STAGE_NAMES.map((name, index) => {
                      const enabled = deepAnalysis[String(index)] || false;
                      const Icon = STAGE_ICONS[name] || Eye;
                      return (
                        <button
                          key={name}
                          onClick={() => {
                            setDeepAnalysis((prev) => ({ ...prev, [String(index)]: !enabled }));
                            setConfigDirty(true);
                          }}
                          className="flex items-center justify-between p-3 rounded-xl border border-[#e2e8e4] dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors text-left"
                        >
                          <span className="flex items-center gap-2.5 text-[13px] text-slate-700 dark:text-slate-300">
                            <div className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                              <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                            </div>
                            {STAGE_LABELS[name]}
                          </span>
                          <div
                            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 ${
                              enabled ? 'bg-primary-500' : 'bg-slate-200 dark:bg-slate-700'
                            }`}
                          >
                            <span
                              className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                                enabled ? 'translate-x-[21px]' : 'translate-x-[3px]'
                              }`}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </SectionBody>
              </SectionCard>

              {/* Supporting Documents */}
              <SectionCard>
                <SectionHeader
                  icon={FileText}
                  title="Supporting Documents"
                  description="Requirements docs, architecture diagrams, and other reference materials"
                />
                <SectionBody>
                  {project.supportingDocuments && project.supportingDocuments.length > 0 ? (
                    <div className="space-y-2">
                      {project.supportingDocuments.map((doc: any) => (
                        <div key={doc.id} className="flex items-center justify-between p-3.5 rounded-xl border border-[#e2e8e4] dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                              <FileText className="w-4 h-4 text-slate-400" />
                            </div>
                            <div>
                              <p className="text-[13px] font-medium text-slate-900 dark:text-slate-50">{doc.name}</p>
                              <p className="text-[12px] text-slate-400 dark:text-slate-500">
                                {doc.file_type} · {(doc.file_size / 1024).toFixed(1)} KB
                              </p>
                            </div>
                          </div>
                          <button className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/20 text-slate-400 hover:text-red-500 transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-10">
                      <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-3">
                        <FileText className="w-5 h-5 text-slate-400" />
                      </div>
                      <p className="text-[13px] text-slate-500 dark:text-slate-400">No documents uploaded</p>
                      <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-1">Upload reference materials below</p>
                    </div>
                  )}
                  <Button
                    variant="outline"
                    className="mt-4 w-full rounded-xl h-10 border-dashed border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    Upload Document
                  </Button>
                </SectionBody>
              </SectionCard>

              {/* Save All Config */}
              {configDirty && (
                <div className="flex justify-end pt-2">
                  <Button
                    onClick={() => saveConfig.mutate()}
                    disabled={saveConfig.isPending}
                    className="rounded-xl bg-primary-600 hover:bg-primary-700 text-white shadow-sm"
                  >
                    {saveConfig.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                    Save Configuration
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
    </div>
  );
}
