'use client';

import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Bot, Plus, X, Eye, EyeOff, Server, Zap, Cpu, ShieldCheck,
  KeyRound, ChevronDown, Star, RefreshCw, Loader2,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useAvailableModels } from '@/components/pipeline/mission-control/model-selector';

// ─── Types ────────────────────────────────────────────────────

export interface LLMProvider {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key_encrypted: string;
  available_models: string[];
  is_default: boolean;
}

export interface StageLLMConfig {
  id: string;
  stage_index: number;
  provider_id: string;
  model_name: string;
  temperature: number;
  max_tokens: number;
  role: 'primary' | 'validation';
}

// ─── Presets ──────────────────────────────────────────────────

const PRESET_PROVIDERS = [
  { name: 'Anthropic (Claude)', provider_type: 'anthropic', base_url: 'https://api.anthropic.com/v1', models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
  { name: 'OpenAI (GPT)', provider_type: 'openai', base_url: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview', 'o3-mini'] },
  { name: 'Google (Gemini)', provider_type: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
  { name: 'AWS Bedrock', provider_type: 'bedrock', base_url: '/api/ai/bedrock/v1', models: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-3-5-sonnet-20241022-v2:0'] },
  { name: 'Google (Vertex AI)', provider_type: 'vertexai', base_url: '/api/ai/vertexai/v1', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'] },
  { name: 'Azure AI Foundry', provider_type: 'azure', base_url: '', models: [] },
  { name: 'xAI (Grok)', provider_type: 'xai', base_url: 'https://api.x.ai/v1', models: ['grok-4-0709', 'grok-4-1-fast-reasoning', 'grok-3', 'grok-3-mini'] },
  { name: 'Local / Generic', provider_type: 'generic', base_url: 'http://localhost:11434/v1', models: ['llama3', 'codellama', 'mistral'] },
  { name: 'Custom', provider_type: 'custom', base_url: '', models: [] },
];

const STAGE_NAMES = [
  'SCAN', 'DECODE', 'BLUEPRINT', 'SPEC_LOCK',
  'ARCHITECT', 'FORGE', 'SHADOW_RUN', 'EVOLVE',
];

const STAGE_LABELS: Record<string, string> = {
  SCAN: 'Setup & Configuration',
  DECODE: 'Intent Extraction',
  BLUEPRINT: 'Business Capability Mining',
  SPEC_LOCK: 'Behavior Lock-in',
  ARCHITECT: 'Modernization Approach',
  FORGE: 'Co-Create',
  SHADOW_RUN: 'Parallel Run & Cutover',
  EVOLVE: 'Continuous Modernization',
};

// ─── Helpers ─────────────────────────────────────────────────

function generateId(): string {
  return `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateConfigId(): string {
  return `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Component ───────────────────────────────────────────────

interface LLMProviderSettingsProps {
  /** Project ID for API calls */
  projectId?: string;
  providers: LLMProvider[];
  stageConfigs: StageLLMConfig[];
  onProvidersChange: (providers: LLMProvider[]) => void;
  onStageConfigsChange: (configs: StageLLMConfig[]) => void;
  /** Default execution model for all stages */
  defaultExecutionModel: string;
  onDefaultExecutionModelChange: (model: string) => void;
  /** Default evaluator model for all stages */
  defaultEvaluatorModel: string;
  onDefaultEvaluatorModelChange: (model: string) => void;
  /** Called when any data changes so parent can mark dirty */
  onDirty?: () => void;
  /** Called to trigger immediate save (for credential updates) */
  onSaveNow?: () => void;
}

export function LLMProviderSettings({
  projectId,
  providers,
  stageConfigs,
  onProvidersChange,
  onStageConfigsChange,
  defaultExecutionModel,
  onDefaultExecutionModelChange,
  defaultEvaluatorModel,
  onDefaultEvaluatorModelChange,
  onDirty,
  onSaveNow,
}: LLMProviderSettingsProps) {
  // ─── New provider form ─────────────────────────────────
  const [selectedPreset, setSelectedPreset] = useState('');
  const [newName, setNewName] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newModels, setNewModels] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  // AWS Bedrock credential fields
  const [bedrockAuthMode, setBedrockAuthMode] = useState<'api_key' | 'iam' | 'sso'>('sso');
  const [awsAccessKey, setAwsAccessKey] = useState('');
  const [awsSecretKey, setAwsSecretKey] = useState('');
  const [awsSessionToken, setAwsSessionToken] = useState('');
  const [awsRegion, setAwsRegion] = useState('us-east-2');
  const [bedrockApiKey, setBedrockApiKey] = useState('');
  const [awsSSOProfile, setAwsSSOProfile] = useState('');

  // Google Vertex AI credential fields
  const [vertexAuthMode, setVertexAuthMode] = useState<'adc' | 'service_account' | 'access_token'>('adc');
  const [vertexProjectId, setVertexProjectId] = useState('');
  const [vertexLocation, setVertexLocation] = useState('us-central1');
  const [vertexSAJson, setVertexSAJson] = useState('');
  const [vertexAccessToken, setVertexAccessToken] = useState('');

  // Azure AI Foundry credential fields
  const [azureAuthMode, setAzureAuthMode] = useState<'api_key' | 'ad_token'>('api_key');
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [azureApiKey, setAzureApiKey] = useState('');
  const [azureADToken, setAzureADToken] = useState('');
  const [azureApiVersion, setAzureApiVersion] = useState('2024-12-01-preview');
  const [azureDeployments, setAzureDeployments] = useState('');

  // Update key form
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editKeyValue, setEditKeyValue] = useState('');
  const [showEditKey, setShowEditKey] = useState(false);

  // Bedrock credential editing (for existing providers)
  const [editBedrockAuthMode, setEditBedrockAuthMode] = useState<'api_key' | 'iam' | 'sso'>('sso');
  const [editAwsSSOProfile, setEditAwsSSOProfile] = useState('');
  const [editAwsAccessKey, setEditAwsAccessKey] = useState('');
  const [editAwsSecretKey, setEditAwsSecretKey] = useState('');
  const [editAwsSessionToken, setEditAwsSessionToken] = useState('');
  const [editAwsRegion, setEditAwsRegion] = useState('us-east-2');
  const [editBedrockApiKey, setEditBedrockApiKey] = useState('');

  // Edit models form
  const [editingModelsId, setEditingModelsId] = useState<string | null>(null);
  const [editModelsValue, setEditModelsValue] = useState('');

  // Fetch models
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);

  const handleFetchModels = useCallback(async () => {
    if (!projectId) return;
    const preset = PRESET_PROVIDERS.find(p => p.name === selectedPreset);
    if (!preset) return;

    setFetchingModels(true);
    setFetchModelsError(null);
    try {
      const body: Record<string, string> = { provider_type: preset.provider_type };
      if (newApiKey.trim()) body.api_key = newApiKey.trim();
      if (newBaseUrl.trim()) body.base_url = newBaseUrl.trim();
      if (preset.provider_type === 'bedrock') {
        body.aws_region = awsRegion || 'us-east-2';
        if (awsSSOProfile) body.aws_sso_profile = awsSSOProfile;
        if (bedrockApiKey) body.bearer_token = bedrockApiKey;
      }

      const res = await apiClient.post(`/projects/${projectId}/llm-providers/fetch-models`, body);
      const models = res.data?.models || [];
      if (models.length > 0) {
        setNewModels(models.join(', '));
      } else {
        setFetchModelsError('No models found');
      }
    } catch (err: any) {
      setFetchModelsError(err.response?.data?.error || err.message || 'Failed to fetch models');
    } finally {
      setFetchingModels(false);
    }
  }, [projectId, selectedPreset, newApiKey, newBaseUrl, awsRegion, awsSSOProfile, bedrockApiKey]);

  // ─── Dynamic model options ─────────────────────────────
  /** Build model list from configured providers, falling back to orchestrator models */
  const { models: orchestratorModels } = useAvailableModels();
  const modelOptions = useMemo(() => {
    if (providers.length === 0) return orchestratorModels;
    const models: Array<{ id: string; label: string; provider: string }> = [];
    for (const p of providers) {
      for (const m of p.available_models) {
        models.push({ id: m, label: m, provider: p.name });
      }
    }
    return models.length > 0 ? models : orchestratorModels;
  }, [providers, orchestratorModels]);

  // ─── Preset handler ────────────────────────────────────
  const handlePresetChange = useCallback((preset: string) => {
    setSelectedPreset(preset);
    const found = PRESET_PROVIDERS.find(p => p.name === preset);
    if (found) {
      setNewName(found.name);
      setNewBaseUrl(found.base_url);
      setNewModels(found.models.join(', '));
    }
    setBedrockAuthMode('api_key');
    setAwsAccessKey('');
    setAwsSecretKey('');
    setAwsSessionToken('');
    setAwsRegion('us-east-2');
    setBedrockApiKey('');
  }, []);

  const isApiKeyOptional = selectedPreset === 'AWS Bedrock' || selectedPreset === 'Google (Vertex AI)' || selectedPreset === 'Azure AI Foundry' || selectedPreset === 'Local / Generic';

  // ─── Add provider ──────────────────────────────────────
  const handleAddProvider = useCallback(() => {
    if (!newName.trim() || !newBaseUrl.trim() || (!isApiKeyOptional && !newApiKey.trim())) return;

    const models = newModels.split(',').map(m => m.trim()).filter(Boolean);
    const preset = PRESET_PROVIDERS.find(p => p.name === selectedPreset);
    const providerType = preset?.provider_type || 'openai_compatible';

    // For AWS Bedrock, encode credentials
    let apiKeyValue = newApiKey.trim() || 'none';
    if (selectedPreset === 'AWS Bedrock') {
      if (bedrockAuthMode === 'api_key' && bedrockApiKey.trim()) {
        apiKeyValue = JSON.stringify({ bearerToken: bedrockApiKey.trim(), region: awsRegion.trim() || 'us-east-2' });
      } else if (bedrockAuthMode === 'iam' && awsAccessKey.trim() && awsSecretKey.trim()) {
        apiKeyValue = JSON.stringify({
          accessKeyId: awsAccessKey.trim(),
          secretAccessKey: awsSecretKey.trim(),
          ...(awsSessionToken.trim() ? { sessionToken: awsSessionToken.trim() } : {}),
          region: awsRegion.trim() || 'us-east-2',
        });
      } else if (bedrockAuthMode === 'sso') {
        apiKeyValue = JSON.stringify({
          ssoProfile: awsSSOProfile.trim() || '',
          region: awsRegion.trim() || 'us-east-2',
        });
      } else {
        apiKeyValue = 'none';
      }
    } else if (selectedPreset === 'Google (Vertex AI)') {
      apiKeyValue = JSON.stringify({
        projectId: vertexProjectId.trim(),
        location: vertexLocation.trim() || 'us-central1',
        ...(vertexAuthMode === 'service_account' && vertexSAJson.trim() ? { serviceAccountJson: vertexSAJson.trim() } : {}),
        ...(vertexAuthMode === 'access_token' && vertexAccessToken.trim() ? { accessToken: vertexAccessToken.trim() } : {}),
      });
    } else if (selectedPreset === 'Azure AI Foundry') {
      apiKeyValue = JSON.stringify({
        endpoint: azureEndpoint.trim(),
        apiVersion: azureApiVersion.trim() || '2024-12-01-preview',
        deployments: azureDeployments.trim(),
        ...(azureAuthMode === 'api_key' && azureApiKey.trim() ? { apiKey: azureApiKey.trim() } : {}),
        ...(azureAuthMode === 'ad_token' && azureADToken.trim() ? { adToken: azureADToken.trim() } : {}),
      });
    }

    const isFirstProvider = providers.length === 0;
    const newProvider: LLMProvider = {
      id: generateId(),
      name: newName.trim(),
      provider_type: providerType,
      base_url: newBaseUrl.trim(),
      api_key_encrypted: apiKeyValue,
      available_models: models,
      is_default: isFirstProvider,
    };

    onProvidersChange([...providers, newProvider]);
    onDirty?.();

    // Reset form
    setNewName('');
    setNewBaseUrl('');
    setNewApiKey('');
    setNewModels('');
    setSelectedPreset('');
    setShowAddForm(false);
    setBedrockAuthMode('api_key');
    setAwsAccessKey('');
    setAwsSecretKey('');
    setAwsSessionToken('');
    setAwsRegion('us-east-2');
    setBedrockApiKey('');
  }, [
    newName, newBaseUrl, newApiKey, newModels, selectedPreset, isApiKeyOptional,
    bedrockAuthMode, bedrockApiKey, awsAccessKey, awsSecretKey, awsSessionToken, awsRegion,
    providers, onProvidersChange, onDirty,
  ]);

  // ─── Delete provider ──────────────────────────────────
  const handleDeleteProvider = useCallback((id: string) => {
    const updated = providers.filter(p => p.id !== id);
    // If deleted was default, make first remaining the default
    if (updated.length > 0 && !updated.some(p => p.is_default)) {
      updated[0].is_default = true;
    }
    onProvidersChange(updated);

    // Remove stage configs referencing this provider
    const updatedConfigs = stageConfigs.filter(c => c.provider_id !== id);
    if (updatedConfigs.length !== stageConfigs.length) {
      onStageConfigsChange(updatedConfigs);
    }

    onDirty?.();
  }, [providers, stageConfigs, onProvidersChange, onStageConfigsChange, onDirty]);

  // ─── Set default ──────────────────────────────────────
  const handleSetDefault = useCallback((id: string) => {
    const updated = providers.map(p => ({ ...p, is_default: p.id === id }));
    onProvidersChange(updated);
    onDirty?.();
  }, [providers, onProvidersChange, onDirty]);

  // ─── Update API key ───────────────────────────────────
  const handleUpdateKey = useCallback((id: string) => {
    const provider = providers.find(p => p.id === id);
    const isBedrock = provider?.provider_type === 'bedrock';

    let apiKeyValue: string;
    if (isBedrock) {
      apiKeyValue = 'none';
      if (editBedrockAuthMode === 'api_key' && editBedrockApiKey.trim()) {
        apiKeyValue = JSON.stringify({ bearerToken: editBedrockApiKey.trim(), region: editAwsRegion.trim() || 'us-east-2' });
      } else if (editBedrockAuthMode === 'iam' && editAwsAccessKey.trim() && editAwsSecretKey.trim()) {
        apiKeyValue = JSON.stringify({
          accessKeyId: editAwsAccessKey.trim(),
          secretAccessKey: editAwsSecretKey.trim(),
          ...(editAwsSessionToken.trim() ? { sessionToken: editAwsSessionToken.trim() } : {}),
          region: editAwsRegion.trim() || 'us-east-2',
        });
      } else if (editBedrockAuthMode === 'sso') {
        apiKeyValue = JSON.stringify({
          ssoProfile: editAwsSSOProfile.trim() || '',
          region: editAwsRegion.trim() || 'us-east-2',
        });
      }
    } else {
      if (!editKeyValue.trim()) return;
      apiKeyValue = editKeyValue.trim();
    }

    const updated = providers.map(p => p.id === id ? { ...p, api_key_encrypted: apiKeyValue } : p);
    onProvidersChange(updated);
    onDirty?.();
    // Auto-save credential updates immediately — don't require a second "Save" click
    setTimeout(() => onSaveNow?.(), 200);

    setEditingKeyId(null);
    setEditKeyValue('');
    setShowEditKey(false);
    setEditBedrockAuthMode('api_key');
    setEditAwsAccessKey('');
    setEditAwsSecretKey('');
    setEditAwsSessionToken('');
    setEditAwsRegion('us-east-2');
    setEditBedrockApiKey('');
  }, [
    providers, editKeyValue, editBedrockAuthMode, editBedrockApiKey,
    editAwsAccessKey, editAwsSecretKey, editAwsSessionToken, editAwsRegion,
    onProvidersChange, onDirty,
  ]);

  // ─── Update models ────────────────────────────────────
  const handleUpdateModels = useCallback((id: string) => {
    const models = editModelsValue.split(',').map(m => m.trim()).filter(Boolean);
    if (models.length === 0) return;

    const updated = providers.map(p => p.id === id ? { ...p, available_models: models } : p);
    onProvidersChange(updated);

    // Remove stage configs referencing models no longer available
    const updatedConfigs = stageConfigs.filter(c => {
      if (c.provider_id !== id) return true;
      return models.includes(c.model_name);
    });
    if (updatedConfigs.length !== stageConfigs.length) {
      onStageConfigsChange(updatedConfigs);
    }

    onDirty?.();
    setEditingModelsId(null);
    setEditModelsValue('');
  }, [editModelsValue, providers, stageConfigs, onProvidersChange, onStageConfigsChange, onDirty]);

  // ─── Stage config ─────────────────────────────────────
  const handleStageConfig = useCallback((stageIndex: number, role: 'primary' | 'validation', providerId: string, modelName: string) => {
    // Prevent same model for both roles
    const oppositeRole = role === 'primary' ? 'validation' : 'primary';
    const conflict = stageConfigs.find(
      c => c.stage_index === stageIndex && c.role === oppositeRole && c.provider_id === providerId && c.model_name === modelName,
    );
    if (conflict) return; // silently block

    const existing = stageConfigs.find(c => c.stage_index === stageIndex && c.role === role);
    let updatedConfigs: StageLLMConfig[];

    if (existing) {
      updatedConfigs = stageConfigs.map(c =>
        c.id === existing.id
          ? { ...c, provider_id: providerId, model_name: modelName }
          : c,
      );
    } else {
      updatedConfigs = [...stageConfigs, {
        id: generateConfigId(),
        stage_index: stageIndex,
        provider_id: providerId,
        model_name: modelName,
        temperature: 0.7,
        max_tokens: 4096,
        role,
      }];
    }

    onStageConfigsChange(updatedConfigs);
    onDirty?.();
  }, [stageConfigs, onStageConfigsChange, onDirty]);

  const handleRemoveStageConfig = useCallback((configId: string) => {
    onStageConfigsChange(stageConfigs.filter(c => c.id !== configId));
    onDirty?.();
  }, [stageConfigs, onStageConfigsChange, onDirty]);

  // ─── Render ────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* ─── Registered Providers ─────────────────────────── */}
      <Card className="bg-[#f9faf9] dark:bg-slate-900 rounded-2xl border-[#e2e8e4] dark:border-slate-800 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4" /> LLM Providers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Register cloud providers (Anthropic, OpenAI, Google Gemini, xAI Grok, AWS Bedrock), local models, or a custom endpoint. Credentials are stored securely with the project.
          </p>

          {/* Provider list */}
          {providers.length > 0 ? (
            <div className="space-y-2">
              {providers.map(p => (
                <div key={p.id} className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <Bot className="h-4 w-4 text-slate-400 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-50">{p.name}</span>
                          {p.is_default && <Badge className="text-[10px] px-1.5 py-0">Default</Badge>}
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{p.provider_type}</Badge>
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono truncate">{p.base_url}</div>
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {p.available_models.slice(0, 5).map(m => (
                            <Badge key={m} variant="outline" className="text-[10px] px-1 py-0">{m}</Badge>
                          ))}
                          {p.available_models.length > 5 && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0">+{p.available_models.length - 5}</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs px-2"
                        onClick={() => {
                          if (editingKeyId === p.id) {
                            setEditingKeyId(null);
                          } else {
                            setEditingKeyId(p.id);
                            setEditingModelsId(null);
                            setEditKeyValue('');
                            setShowEditKey(false);
                            if (p.provider_type === 'bedrock' && p.api_key_encrypted && p.api_key_encrypted !== 'none') {
                              try {
                                const creds = JSON.parse(p.api_key_encrypted);
                                if (creds.ssoProfile !== undefined || creds.sso_profile !== undefined) {
                                  setEditBedrockAuthMode('sso');
                                  setEditAwsSSOProfile(creds.ssoProfile || creds.sso_profile || '');
                                } else if (creds.bearerToken) {
                                  setEditBedrockAuthMode('api_key');
                                  setEditBedrockApiKey(creds.bearerToken);
                                } else if (creds.accessKeyId || creds.aws_access_key_id) {
                                  setEditBedrockAuthMode('iam');
                                  setEditAwsAccessKey(creds.accessKeyId || '');
                                  setEditAwsSecretKey(creds.secretAccessKey || '');
                                  setEditAwsSessionToken(creds.sessionToken || '');
                                } else {
                                  setEditBedrockAuthMode('sso');
                                  setEditAwsSSOProfile('');
                                }
                                setEditAwsRegion(creds.region || 'us-east-2');
                              } catch {
                                setEditAwsAccessKey('');
                                setEditAwsSecretKey('');
                                setEditAwsSessionToken('');
                                setEditAwsRegion('us-east-2');
                              }
                            }
                          }
                        }}
                      >
                        <KeyRound className="h-3 w-3 mr-1" />
                        {p.provider_type === 'bedrock' ? 'Credentials' : 'Key'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs px-2"
                        onClick={() => {
                          if (editingModelsId === p.id) {
                            setEditingModelsId(null);
                          } else {
                            setEditingModelsId(p.id);
                            setEditingKeyId(null);
                            setEditModelsValue(p.available_models.join(', '));
                          }
                        }}
                      >
                        Models
                      </Button>
                      {!p.is_default && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => handleSetDefault(p.id)}>
                          <Star className="h-3 w-3" />
                        </Button>
                      )}
                      <button
                        onClick={() => handleDeleteProvider(p.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-500 transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Update Key / Credentials */}
                  {editingKeyId === p.id && (
                    p.provider_type === 'bedrock' ? (
                      <div className="space-y-2 pl-7 pt-2 border-t border-slate-200 dark:border-slate-700">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant={editBedrockAuthMode === 'api_key' ? 'default' : 'outline'}
                            onClick={() => setEditBedrockAuthMode('api_key')}
                            type="button"
                            className="h-7 text-xs"
                          >
                            Bedrock API Key
                          </Button>
                          <Button
                            size="sm"
                            variant={editBedrockAuthMode === 'iam' ? 'default' : 'outline'}
                            onClick={() => setEditBedrockAuthMode('iam')}
                            type="button"
                            className="h-7 text-xs"
                          >
                            IAM Credentials
                          </Button>
                          <Button
                            size="sm"
                            variant={editBedrockAuthMode === 'sso' ? 'default' : 'outline'}
                            onClick={() => setEditBedrockAuthMode('sso')}
                            type="button"
                            className="h-7 text-xs"
                          >
                            AWS SSO
                          </Button>
                        </div>
                        {editBedrockAuthMode === 'sso' ? (
                          <div>
                            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                              SSO Profile <span className="text-slate-400">(from ~/.aws/config, leave empty for default)</span>
                            </label>
                            <Input
                              value={editAwsSSOProfile}
                              onChange={e => setEditAwsSSOProfile(e.target.value)}
                              placeholder="default"
                              className="mt-1"
                            />
                            <p className="text-xs text-slate-400 mt-1">
                              Run <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">aws sso login</code> first
                            </p>
                          </div>
                        ) : editBedrockAuthMode === 'api_key' ? (
                          <div>
                            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                              Bedrock API Key <span className="text-slate-400">(12-hour token)</span>
                            </label>
                            <div className="flex gap-2 mt-1">
                              <Input
                                type={showEditKey ? 'text' : 'password'}
                                value={editBedrockApiKey}
                                onChange={e => setEditBedrockApiKey(e.target.value)}
                                placeholder="bedrock-api-key-..."
                                className="text-xs h-8"
                              />
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setShowEditKey(!showEditKey)}>
                                {showEditKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">AWS Access Key ID</label>
                                <Input
                                  type={showEditKey ? 'text' : 'password'}
                                  value={editAwsAccessKey}
                                  onChange={e => setEditAwsAccessKey(e.target.value)}
                                  placeholder="AKIA..."
                                  className="text-xs h-8 mt-1"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">AWS Secret Access Key</label>
                                <Input
                                  type={showEditKey ? 'text' : 'password'}
                                  value={editAwsSecretKey}
                                  onChange={e => setEditAwsSecretKey(e.target.value)}
                                  placeholder="wJalr..."
                                  className="text-xs h-8 mt-1"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                                Session Token <span className="text-slate-400">(temporary credentials)</span>
                              </label>
                              <Input
                                type={showEditKey ? 'text' : 'password'}
                                value={editAwsSessionToken}
                                onChange={e => setEditAwsSessionToken(e.target.value)}
                                placeholder="IQoJb3..."
                                className="text-xs h-8 mt-1"
                              />
                            </div>
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setShowEditKey(!showEditKey)}>
                              {showEditKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                          </>
                        )}
                        <div>
                          <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Region</label>
                          <Input
                            value={editAwsRegion}
                            onChange={e => setEditAwsRegion(e.target.value)}
                            placeholder="us-east-2"
                            className="text-xs h-8 mt-1"
                          />
                        </div>
                        <div className="flex gap-2 pt-1">
                          <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdateKey(p.id)}>Save Credentials</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditingKeyId(null); setShowEditKey(false); }}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2 items-center pl-7 pt-2 border-t border-slate-200 dark:border-slate-700">
                        <Input
                          type={showEditKey ? 'text' : 'password'}
                          value={editKeyValue}
                          onChange={e => setEditKeyValue(e.target.value)}
                          placeholder="Paste new API key..."
                          className="text-xs h-8"
                        />
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setShowEditKey(!showEditKey)}>
                          {showEditKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </Button>
                        <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdateKey(p.id)} disabled={!editKeyValue.trim()}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditingKeyId(null); setEditKeyValue(''); setShowEditKey(false); }}>
                          Cancel
                        </Button>
                      </div>
                    )
                  )}

                  {/* Edit Models */}
                  {editingModelsId === p.id && (
                    <div className="flex gap-2 items-center pl-7 pt-2 border-t border-slate-200 dark:border-slate-700">
                      <Input
                        value={editModelsValue}
                        onChange={e => setEditModelsValue(e.target.value)}
                        placeholder="model-1, model-2, model-3"
                        className="text-xs h-8"
                      />
                      <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdateModels(p.id)} disabled={!editModelsValue.trim()}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditingModelsId(null); setEditModelsValue(''); }}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
              <Bot className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
              <p className="text-sm text-slate-500 dark:text-slate-400">No providers configured</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">The built-in AI gateway will be used as fallback.</p>
            </div>
          )}

          {/* Add Provider Toggle / Form */}
          {!showAddForm ? (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Provider
            </Button>
          ) : (
            <div className="space-y-3 border border-slate-200 dark:border-slate-700 rounded-lg p-4 bg-slate-50/50 dark:bg-slate-900/30">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-900 dark:text-slate-50">Add Provider</span>
                <button
                  onClick={() => { setShowAddForm(false); setSelectedPreset(''); setNewName(''); setNewBaseUrl(''); setNewApiKey(''); setNewModels(''); }}
                  className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Quick Setup */}
              <div>
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Quick Setup</label>
                <div className="relative mt-1">
                  <select
                    value={selectedPreset}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    className="w-full appearance-none rounded-md border border-slate-200 dark:border-slate-600 bg-[#f9faf9] dark:bg-slate-700 text-sm text-slate-900 dark:text-slate-100 pl-3 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                  >
                    <option value="">Select a provider preset...</option>
                    {PRESET_PROVIDERS.map(p => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </div>

              {/* Contextual hints */}
              {selectedPreset === 'Local / Generic' && (
                <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-3 py-2">
                  If using Ollama, enable CORS: <code className="font-mono font-semibold">OLLAMA_ORIGINS=* ollama serve</code>. Any OpenAI-compatible local server works.
                </p>
              )}
              {selectedPreset === 'Anthropic (Claude)' && (
                <p className="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded px-3 py-2">
                  Anthropic uses its native Messages API. Auth and message format are handled automatically. Get your API key at <code className="font-mono font-semibold">console.anthropic.com</code>.
                </p>
              )}
              {selectedPreset === 'xAI (Grok)' && (
                <p className="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded px-3 py-2">
                  xAI uses an OpenAI-compatible API. Get your API key at <code className="font-mono font-semibold">console.x.ai</code>.
                </p>
              )}
              {selectedPreset === 'AWS Bedrock' && (
                <div className="space-y-2">
                  <p className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 rounded px-3 py-2">
                    AWS Bedrock routes through the backend proxy. Provide your own AWS credentials below, or leave blank to use backend environment variables.
                  </p>
                  <p className="text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 rounded px-3 py-2">
                    <strong>Model IDs:</strong> Models prefixed with <code className="font-mono font-semibold">us.</code> use cross-region inference. Use on-demand IDs if your account restricts regions.
                  </p>
                </div>
              )}

              {/* Name + Base URL */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Provider Name</label>
                  <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g., OpenAI Production" className="mt-1" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Base URL</label>
                  <Input value={newBaseUrl} onChange={e => setNewBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="mt-1" />
                </div>
              </div>

              {/* API Key / AWS Credentials */}
              {selectedPreset === 'AWS Bedrock' ? (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={bedrockAuthMode === 'api_key' ? 'default' : 'outline'}
                      onClick={() => setBedrockAuthMode('api_key')}
                      type="button"
                      className="h-7 text-xs"
                    >
                      Bedrock API Key
                    </Button>
                    <Button
                      size="sm"
                      variant={bedrockAuthMode === 'iam' ? 'default' : 'outline'}
                      onClick={() => setBedrockAuthMode('iam')}
                      type="button"
                      className="h-7 text-xs"
                    >
                      IAM Credentials
                    </Button>
                    <Button
                      size="sm"
                      variant={bedrockAuthMode === 'sso' ? 'default' : 'outline'}
                      onClick={() => setBedrockAuthMode('sso')}
                      type="button"
                      className="h-7 text-xs"
                    >
                      AWS SSO
                    </Button>
                  </div>
                  {bedrockAuthMode === 'sso' ? (
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        SSO Profile <span className="text-slate-400">(from ~/.aws/config, leave empty for default)</span>
                      </label>
                      <Input
                        value={awsSSOProfile}
                        onChange={e => setAwsSSOProfile(e.target.value)}
                        placeholder="default"
                        className="mt-1"
                      />
                      <p className="text-xs text-slate-400 mt-1">
                        Run <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">aws sso login</code> first to authenticate
                      </p>
                    </div>
                  ) : bedrockAuthMode === 'api_key' ? (
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        Bedrock API Key <span className="text-slate-400">(12-hour token)</span>
                      </label>
                      <div className="flex gap-2 mt-1">
                        <Input
                          type={showApiKey ? 'text' : 'password'}
                          value={bedrockApiKey}
                          onChange={e => setBedrockApiKey(e.target.value)}
                          placeholder="bedrock-api-key-..."
                        />
                        <Button size="icon" variant="ghost" onClick={() => setShowApiKey(!showApiKey)} type="button">
                          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-medium text-slate-700 dark:text-slate-300">AWS Access Key ID</label>
                          <Input
                            type={showApiKey ? 'text' : 'password'}
                            value={awsAccessKey}
                            onChange={e => setAwsAccessKey(e.target.value)}
                            placeholder="AKIA..."
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-slate-700 dark:text-slate-300">AWS Secret Access Key</label>
                          <Input
                            type={showApiKey ? 'text' : 'password'}
                            value={awsSecretKey}
                            onChange={e => setAwsSecretKey(e.target.value)}
                            placeholder="wJalr..."
                            className="mt-1"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                          Session Token <span className="text-slate-400">(temporary credentials)</span>
                        </label>
                        <Input
                          type={showApiKey ? 'text' : 'password'}
                          value={awsSessionToken}
                          onChange={e => setAwsSessionToken(e.target.value)}
                          placeholder="IQoJb3..."
                          className="mt-1"
                        />
                      </div>
                      <Button size="icon" variant="ghost" onClick={() => setShowApiKey(!showApiKey)} type="button">
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </>
                  )}
                  <div>
                    <label className="text-xs font-medium text-slate-700 dark:text-slate-300">AWS Region</label>
                    <Input
                      value={awsRegion}
                      onChange={e => setAwsRegion(e.target.value)}
                      placeholder="us-east-2"
                      className="mt-1"
                    />
                  </div>
                </div>
              ) : selectedPreset === 'Google (Vertex AI)' ? (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Button size="sm" variant={vertexAuthMode === 'adc' ? 'default' : 'outline'} onClick={() => setVertexAuthMode('adc')} type="button" className="h-7 text-xs">ADC (Default)</Button>
                    <Button size="sm" variant={vertexAuthMode === 'service_account' ? 'default' : 'outline'} onClick={() => setVertexAuthMode('service_account')} type="button" className="h-7 text-xs">Service Account</Button>
                    <Button size="sm" variant={vertexAuthMode === 'access_token' ? 'default' : 'outline'} onClick={() => setVertexAuthMode('access_token')} type="button" className="h-7 text-xs">Access Token</Button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">GCP Project ID</label>
                      <Input value={vertexProjectId} onChange={e => setVertexProjectId(e.target.value)} placeholder="my-gcp-project" className="mt-1" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Location / Region</label>
                      <Input value={vertexLocation} onChange={e => setVertexLocation(e.target.value)} placeholder="us-central1" className="mt-1" />
                    </div>
                  </div>
                  {vertexAuthMode === 'service_account' && (
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Service Account JSON Key</label>
                      <textarea
                        value={vertexSAJson}
                        onChange={e => setVertexSAJson(e.target.value)}
                        placeholder='{"type": "service_account", "project_id": "...", ...}'
                        rows={4}
                        className="mt-1 w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-mono"
                      />
                    </div>
                  )}
                  {vertexAuthMode === 'access_token' && (
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        Access Token <span className="text-slate-400">(1-hour, from gcloud auth print-access-token)</span>
                      </label>
                      <Input type={showApiKey ? 'text' : 'password'} value={vertexAccessToken} onChange={e => setVertexAccessToken(e.target.value)} placeholder="ya29.a0..." className="mt-1" />
                    </div>
                  )}
                  {vertexAuthMode === 'adc' && (
                    <p className="text-xs text-slate-400">Uses Application Default Credentials. Run <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">gcloud auth application-default login</code> locally or deploy on GCP.</p>
                  )}
                </div>
              ) : selectedPreset === 'Azure AI Foundry' ? (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Button size="sm" variant={azureAuthMode === 'api_key' ? 'default' : 'outline'} onClick={() => setAzureAuthMode('api_key')} type="button" className="h-7 text-xs">API Key</Button>
                    <Button size="sm" variant={azureAuthMode === 'ad_token' ? 'default' : 'outline'} onClick={() => setAzureAuthMode('ad_token')} type="button" className="h-7 text-xs">Azure AD Token</Button>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Azure OpenAI Endpoint</label>
                    <Input value={azureEndpoint} onChange={e => setAzureEndpoint(e.target.value)} placeholder="https://my-resource.openai.azure.com" className="mt-1" />
                  </div>
                  {azureAuthMode === 'api_key' ? (
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">API Key</label>
                      <Input type={showApiKey ? 'text' : 'password'} value={azureApiKey} onChange={e => setAzureApiKey(e.target.value)} placeholder="abc123..." className="mt-1" />
                    </div>
                  ) : (
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        Azure AD Token <span className="text-slate-400">(from az account get-access-token)</span>
                      </label>
                      <Input type={showApiKey ? 'text' : 'password'} value={azureADToken} onChange={e => setAzureADToken(e.target.value)} placeholder="eyJ0eX..." className="mt-1" />
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">API Version</label>
                      <Input value={azureApiVersion} onChange={e => setAzureApiVersion(e.target.value)} placeholder="2024-12-01-preview" className="mt-1" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        Deployments <span className="text-slate-400">(comma-separated)</span>
                      </label>
                      <Input value={azureDeployments} onChange={e => setAzureDeployments(e.target.value)} placeholder="gpt-4o, gpt-4o-mini" className="mt-1" />
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">API Key</label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      type={showApiKey ? 'text' : 'password'}
                      value={newApiKey}
                      onChange={e => setNewApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                    <Button size="icon" variant="ghost" onClick={() => setShowApiKey(!showApiKey)} type="button">
                      {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              )}

              {/* Models */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Available Models</label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] gap-1 text-primary-600 hover:text-primary-700"
                    onClick={handleFetchModels}
                    disabled={fetchingModels || !selectedPreset}
                    title="Fetch available models from the provider"
                  >
                    {fetchingModels ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    {fetchingModels ? 'Fetching...' : 'Fetch Models'}
                  </Button>
                </div>
                <Input value={newModels} onChange={e => setNewModels(e.target.value)} placeholder="gpt-4o, gpt-4-turbo, gpt-3.5-turbo" className="mt-1" />
                {fetchModelsError && (
                  <p className="text-[10px] text-red-500 mt-1">{fetchModelsError}</p>
                )}
              </div>

              <Button
                size="sm"
                onClick={handleAddProvider}
                disabled={!newName.trim() || !newBaseUrl.trim() || (!isApiKeyOptional && !newApiKey.trim())}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Provider
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Project Default Models ───────────────────────── */}
      <Card className="bg-[#f9faf9] dark:bg-slate-900 rounded-2xl border-[#e2e8e4] dark:border-slate-800 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" />
            Project Default Models
          </CardTitle>
          <CardDescription>
            Default models used across all stages. Per-stage overrides below take precedence.
            {providers.length > 0 && (
              <span className="ml-1 text-primary-600 dark:text-primary-400">
                Models sourced from {providers.length} configured provider{providers.length > 1 ? 's' : ''}.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                <Cpu className="w-3.5 h-3.5 text-blue-500" />
                Execution Model
              </label>
              <div className="relative">
                <select
                  value={defaultExecutionModel}
                  onChange={(e) => { onDefaultExecutionModelChange(e.target.value); onDirty?.(); }}
                  className="w-full appearance-none rounded-lg border border-slate-300 dark:border-slate-600 bg-[#f9faf9] dark:bg-slate-700 text-sm text-slate-900 dark:text-slate-100 pl-3 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
              <p className="text-[11px] text-slate-400 mt-1">Generates stage output content</p>
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                Evaluator Model
              </label>
              <div className="relative">
                <select
                  value={defaultEvaluatorModel}
                  onChange={(e) => { onDefaultEvaluatorModelChange(e.target.value); onDirty?.(); }}
                  className="w-full appearance-none rounded-lg border border-slate-300 dark:border-slate-600 bg-[#f9faf9] dark:bg-slate-700 text-sm text-slate-900 dark:text-slate-100 pl-3 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
              <p className="text-[11px] text-slate-400 mt-1">Scores output via 3-phase validation</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Per-Stage LLM Assignment ─────────────────────── */}
      <Card className="bg-[#f9faf9] dark:bg-slate-900 rounded-2xl border-[#e2e8e4] dark:border-slate-800 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" /> Per-Stage Model Overrides
          </CardTitle>
          <CardDescription>
            Override the default model for specific stages. Leave empty to use project defaults.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Column headers */}
          <div className="grid grid-cols-[160px_1fr_1fr] gap-3 text-[10px] text-slate-400 font-medium uppercase tracking-wider px-1">
            <span>Stage</span>
            <span>Execution Model</span>
            <span>Evaluator Model</span>
          </div>

          <div className="space-y-1">
            {STAGE_NAMES.map((stageName, i) => {
              const primaryConfig = stageConfigs.find(c => c.stage_index === i && c.role === 'primary');
              const validationConfig = stageConfigs.find(c => c.stage_index === i && c.role === 'validation');

              return (
                <div key={i} className="grid grid-cols-[160px_1fr_1fr] gap-3 items-center p-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
                    {STAGE_LABELS[stageName]}
                  </span>

                  {/* Execution / Primary */}
                  <div className="relative">
                    <select
                      value={primaryConfig ? `${primaryConfig.provider_id}::${primaryConfig.model_name}` : ''}
                      onChange={e => {
                        if (!e.target.value) {
                          if (primaryConfig) handleRemoveStageConfig(primaryConfig.id);
                          return;
                        }
                        if (providers.length > 0) {
                          const [pid, ...rest] = e.target.value.split('::');
                          handleStageConfig(i, 'primary', pid, rest.join('::'));
                        } else {
                          // No providers — use model ID directly with '__default__' provider sentinel
                          handleStageConfig(i, 'primary', '__default__', e.target.value);
                        }
                      }}
                      className="w-full appearance-none rounded-md border border-slate-200 dark:border-slate-600 bg-[#f9faf9] dark:bg-slate-700 text-[11px] text-slate-900 dark:text-slate-100 pl-2 pr-6 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                    >
                      <option value="">Project default</option>
                      {providers.length > 0
                        ? providers.flatMap(p =>
                            p.available_models.map(m => (
                              <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                                [{p.name}] {m}
                              </option>
                            ))
                          )
                        : modelOptions.map(m => (
                            <option key={`__default__::${m.id}`} value={`__default__::${m.id}`}>
                              {m.label} ({m.provider})
                            </option>
                          ))
                      }
                    </select>
                    <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                  </div>

                  {/* Evaluator / Validation */}
                  <div className="relative">
                    <select
                      value={validationConfig ? `${validationConfig.provider_id}::${validationConfig.model_name}` : ''}
                      onChange={e => {
                        if (!e.target.value) {
                          if (validationConfig) handleRemoveStageConfig(validationConfig.id);
                          return;
                        }
                        if (providers.length > 0) {
                          const [pid, ...rest] = e.target.value.split('::');
                          handleStageConfig(i, 'validation', pid, rest.join('::'));
                        } else {
                          handleStageConfig(i, 'validation', '__default__', e.target.value);
                        }
                      }}
                      className="w-full appearance-none rounded-md border border-slate-200 dark:border-slate-600 bg-[#f9faf9] dark:bg-slate-700 text-[11px] text-slate-900 dark:text-slate-100 pl-2 pr-6 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                    >
                      <option value="">Project default</option>
                      {providers.length > 0
                        ? providers.flatMap(p =>
                            p.available_models.map(m => (
                              <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                                [{p.name}] {m}
                              </option>
                            ))
                          )
                        : modelOptions.map(m => (
                            <option key={`__default__::${m.id}`} value={`__default__::${m.id}`}>
                              {m.label} ({m.provider})
                            </option>
                          ))
                      }
                    </select>
                    <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
