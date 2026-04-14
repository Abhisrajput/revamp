'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '@revamp/ui/components/card';
import { Button } from '@revamp/ui/components/button';
import { Input } from '@revamp/ui/components/input';
import { Badge } from '@revamp/ui/components/badge';
import { useAuthStore } from '@revamp/core';
import { apiClient } from '@/lib/api-client';
import {
  Save, Bell, Shield, Cpu,
  CheckCircle, Settings2, ToggleLeft,
  RefreshCw, HardDrive,
} from 'lucide-react';

// ─── TYPES ──────────────────────────────────────────────────────

type SettingsTab = 'profile' | 'llm' | 'notifications' | 'features' | 'performance';

interface ModelInfo {
  id: string;
  provider: string;
  input_price_per_1m: number;
  output_price_per_1m: number;
}

interface UsageSummary {
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: Array<{
    model: string;
    tokens: number;
    cost: number;
    requests: number;
  }>;
}

// ─── TABS ───────────────────────────────────────────────────────

const TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'profile', label: 'Profile', icon: Settings2 },
  { id: 'llm', label: 'LLM Providers', icon: Cpu },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'features', label: 'Feature Toggles', icon: ToggleLeft },
  { id: 'performance', label: 'Performance', icon: HardDrive },
];

// ─── MAIN PAGE ──────────────────────────────────────────────────

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  return (
    <div>
      <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-6">
        Settings
      </h1>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-6 border-b border-slate-200 dark:border-slate-700">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
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
      {activeTab === 'profile' && <ProfileTab />}
      {activeTab === 'llm' && <LLMProvidersTab />}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'features' && <FeatureTogglesTab />}
      {activeTab === 'performance' && <PerformanceTab />}
    </div>
  );
}

// ─── PROFILE TAB ────────────────────────────────────────────────

function ProfileTab() {
  const user = useAuthStore((s) => s.user);
  const [isSaving, setIsSaving] = useState(false);
  const [profile, setProfile] = useState({
    fullName: user?.name || '',
    email: user?.email || '',
  });

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await apiClient.patch('/auth/profile', {
        first_name: profile.fullName.split(' ')[0],
        last_name: profile.fullName.split(' ').slice(1).join(' '),
      });
    } catch {
      // Silently handle — profile update is non-critical
    }
    setIsSaving(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="bg-white dark:bg-slate-800 lg:col-span-2">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-6">
            Profile Information
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Full Name
              </label>
              <Input
                type="text"
                value={profile.fullName}
                onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
                placeholder="Your name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Email Address
              </label>
              <Input
                type="email"
                value={profile.email}
                onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                placeholder="your@email.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Password
              </label>
              <Button variant="outline" className="w-full">
                Change Password
              </Button>
            </div>
            <Button onClick={handleSave} disabled={isSaving} className="w-full gap-2">
              <Save className="w-4 h-4" />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="bg-white dark:bg-slate-800">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
            Account
          </h3>
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-slate-600 dark:text-slate-400">Status</p>
              <p className="font-medium text-green-600 dark:text-green-400">Active</p>
            </div>
            <div>
              <p className="text-slate-600 dark:text-slate-400">Role</p>
              <p className="font-medium text-slate-900 dark:text-slate-50 capitalize">
                {user?.role || 'User'}
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* Security */}
      <Card className="bg-white dark:bg-slate-800 lg:col-span-3">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-6 flex items-center gap-2">
            <Shield className="w-5 h-5" />
            Security
          </h2>
          <div className="space-y-3">
            {[
              { title: 'Two-Factor Authentication', desc: 'Add an extra layer of security', action: 'Enable' },
              { title: 'API Tokens', desc: 'Manage API access tokens', action: 'Manage' },
            ].map((item) => (
              <div
                key={item.title}
                className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg"
              >
                <div>
                  <p className="font-medium text-slate-900 dark:text-slate-50">{item.title}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">{item.desc}</p>
                </div>
                <Button variant="outline" size="sm">{item.action}</Button>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── LLM PROVIDERS TAB ─────────────────────────────────────────

function LLMProvidersTab() {
  const { data: models, isLoading: modelsLoading } = useQuery<{ models: ModelInfo[] }>({
    queryKey: ['usage', 'models'],
    queryFn: async () => {
      const res = await apiClient.get('/usage/models');
      return res.data;
    },
    staleTime: 60_000,
  });

  const { data: summary } = useQuery<UsageSummary>({
    queryKey: ['usage', 'summary'],
    queryFn: async () => {
      const res = await apiClient.get('/usage/summary');
      return res.data;
    },
    staleTime: 30_000,
  });

  // Group models by provider
  const providers = models?.models.reduce(
    (acc, m) => {
      if (!acc[m.provider]) acc[m.provider] = [];
      acc[m.provider].push(m);
      return acc;
    },
    {} as Record<string, ModelInfo[]>,
  ) || {};

  const providerMeta: Record<string, { name: string; color: string; configEnv: string }> = {
    anthropic: {
      name: 'Anthropic (Claude)',
      color: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
      configEnv: 'ANTHROPIC_API_KEY',
    },
    openai: {
      name: 'OpenAI',
      color: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
      configEnv: 'OPENAI_API_KEY',
    },
    google: {
      name: 'Google (Gemini)',
      color: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
      configEnv: 'GOOGLE_AI_API_KEY',
    },
  };

  return (
    <div className="space-y-6">
      {/* Usage Summary */}
      {summary && summary.total_requests > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-white dark:bg-slate-800 p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total Cost</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
              ${summary.total_cost_usd.toFixed(2)}
            </p>
          </Card>
          <Card className="bg-white dark:bg-slate-800 p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total Tokens</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
              {summary.total_tokens >= 1_000_000
                ? `${(summary.total_tokens / 1_000_000).toFixed(1)}M`
                : `${(summary.total_tokens / 1_000).toFixed(1)}K`}
            </p>
          </Card>
          <Card className="bg-white dark:bg-slate-800 p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">API Calls</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
              {summary.total_requests}
            </p>
          </Card>
        </div>
      )}

      {/* Provider Cards */}
      {modelsLoading ? (
        <div className="space-y-4 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-slate-200 dark:bg-slate-700 rounded-lg" />
          ))}
        </div>
      ) : (
        Object.entries(providers).map(([provider, providerModels]) => {
          const meta = providerMeta[provider] || {
            name: provider,
            color: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
            configEnv: 'UNKNOWN',
          };

          return (
            <Card key={provider} className="bg-white dark:bg-slate-800">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <Badge className={meta.color}>{meta.name}</Badge>
                    <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                      {meta.configEnv}
                    </span>
                  </div>
                  <Badge className="bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400">
                    <CheckCircle className="w-3 h-3 mr-1" />
                    Configured via Go Orchestrator
                  </Badge>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-700">
                        <th className="text-left py-2 text-slate-600 dark:text-slate-400 font-medium">Model</th>
                        <th className="text-right py-2 text-slate-600 dark:text-slate-400 font-medium">Input $/1M</th>
                        <th className="text-right py-2 text-slate-600 dark:text-slate-400 font-medium">Output $/1M</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providerModels.map((m) => (
                        <tr
                          key={m.id}
                          className="border-b border-slate-100 dark:border-slate-700/50 last:border-0"
                        >
                          <td className="py-2 font-mono text-slate-900 dark:text-slate-100">{m.id}</td>
                          <td className="py-2 text-right text-slate-600 dark:text-slate-400">
                            ${m.input_price_per_1m.toFixed(2)}
                          </td>
                          <td className="py-2 text-right text-slate-600 dark:text-slate-400">
                            ${m.output_price_per_1m.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          );
        })
      )}

      {/* Info Note */}
      <Card className="bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800">
        <div className="p-4 text-sm text-blue-700 dark:text-blue-300">
          <p className="font-medium mb-1">LLM Provider Configuration</p>
          <p>
            API keys are managed through the Go LLM Orchestrator service. Set them as environment
            variables (<code className="text-xs bg-blue-100 dark:bg-blue-900/30 px-1 py-0.5 rounded">
            ANTHROPIC_API_KEY</code>, <code className="text-xs bg-blue-100 dark:bg-blue-900/30 px-1 py-0.5 rounded">
            OPENAI_API_KEY</code>, <code className="text-xs bg-blue-100 dark:bg-blue-900/30 px-1 py-0.5 rounded">
            GOOGLE_AI_API_KEY</code>) or configure them in the orchestrator&apos;s config file.
            The orchestrator handles multi-provider routing, circuit breakers, and load balancing.
          </p>
        </div>
      </Card>
    </div>
  );
}

// ─── NOTIFICATIONS TAB ──────────────────────────────────────────

function NotificationsTab() {
  const [notifications, setNotifications] = useState({
    projectUpdates: true,
    stageCompletion: true,
    approvalRequests: true,
    weeklyDigest: true,
    costAlerts: false,
  });

  const notifItems = [
    {
      id: 'projectUpdates',
      title: 'Project Updates',
      description: 'Get notified when projects are created or updated',
    },
    {
      id: 'stageCompletion',
      title: 'Stage Completion',
      description: 'Receive alerts when pipeline stages complete or fail',
    },
    {
      id: 'approvalRequests',
      title: 'Approval Requests',
      description: 'Get notified when a stage requires your approval',
    },
    {
      id: 'weeklyDigest',
      title: 'Weekly Digest',
      description: 'Summary of weekly activity and token usage',
    },
    {
      id: 'costAlerts',
      title: 'Cost Alerts',
      description: 'Alert when project LLM costs exceed configured thresholds',
    },
  ];

  return (
    <Card className="bg-white dark:bg-slate-800">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-6 flex items-center gap-2">
          <Bell className="w-5 h-5" />
          Notification Preferences
        </h2>
        <div className="space-y-3">
          {notifItems.map((notif) => (
            <div
              key={notif.id}
              className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg"
            >
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-50">{notif.title}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">{notif.description}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifications[notif.id as keyof typeof notifications]}
                  onChange={(e) =>
                    setNotifications({ ...notifications, [notif.id]: e.target.checked })
                  }
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-300 dark:bg-slate-600 rounded-full peer peer-checked:bg-primary-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
              </label>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Button className="gap-2">
            <Save className="w-4 h-4" />
            Save Preferences
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ─── PERFORMANCE TAB ──────────────────────────────────────────────

interface ServiceHealthData {
  status: string;
  uptime: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  services: {
    database: { status: string };
    redis: { status: string; latency_ms?: number };
    llm_orchestrator: { status: string; providers?: Record<string, string> };
    s3_storage: { status: string };
  };
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function PerformanceTab() {
  const queryClient = useQueryClient();
  const [cleared, setCleared] = useState<string | null>(null);

  const { data: health, isLoading: healthLoading, refetch: refetchHealth } = useQuery<ServiceHealthData>({
    queryKey: ['admin', 'health'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/health');
      return res.data;
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  const showCleared = (msg: string) => {
    setCleared(msg);
    setTimeout(() => setCleared(null), 3000);
  };

  const handleResetAppState = () => {
    try {
      const authData = localStorage.getItem('auth-store');
      localStorage.removeItem('revamp-pipeline-store');
      queryClient.clear();
      if (!authData) {
        localStorage.clear();
      }
      showCleared('App state reset — reloading...');
      setTimeout(() => window.location.reload(), 500);
    } catch { /* ignore */ }
  };

  const handleExportConfig = () => {
    try {
      const config: Record<string, unknown> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key === 'auth-store') continue;
        try {
          config[key] = JSON.parse(localStorage.getItem(key) || '');
        } catch {
          config[key] = localStorage.getItem(key);
        }
      }
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aignite-config-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showCleared('Configuration exported');
    } catch { /* ignore */ }
  };

  const handleImportConfig = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const config = JSON.parse(text) as Record<string, unknown>;
        for (const [key, value] of Object.entries(config)) {
          if (key === 'auth-store') continue;
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        showCleared('Configuration imported — reloading...');
        setTimeout(() => window.location.reload(), 500);
      } catch {
        showCleared('Import failed — invalid file format');
      }
    };
    input.click();
  };

  return (
    <div className="space-y-6">
      {/* Status banner */}
      {cleared && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 text-sm">
          <CheckCircle className="w-4 h-4" />
          {cleared}
        </div>
      )}

      {/* ── Service Health (compact) ─────────────────────── */}
      <Card className="bg-white dark:bg-slate-800">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Service Health
            </h2>
            <div className="flex items-center gap-3">
              {health && (
                <Badge className={health.status === 'healthy'
                  ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                  : 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                }>
                  {health.status === 'healthy' ? 'All Systems Operational' : 'Degraded'}
                </Badge>
              )}
              <Button variant="ghost" size="sm" onClick={() => refetchHealth()} className="gap-1.5 text-xs">
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {healthLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-pulse">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-16 bg-slate-100 dark:bg-slate-700 rounded-lg" />
              ))}
            </div>
          ) : health ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { name: 'PostgreSQL', key: 'database' as const, detail: null },
                  { name: 'Redis', key: 'redis' as const, detail: health.services.redis.latency_ms != null ? `${health.services.redis.latency_ms}ms latency` : null },
                  { name: 'LLM Orchestrator', key: 'llm_orchestrator' as const, detail: health.services.llm_orchestrator.providers ? Object.keys(health.services.llm_orchestrator.providers).join(', ') : null },
                  { name: 'S3 Storage', key: 's3_storage' as const, detail: null },
                ].map((svc) => {
                  const ok = health.services[svc.key]?.status === 'ok';
                  return (
                    <div key={svc.key} className="p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusDot ok={ok} />
                        <p className="text-sm font-medium text-slate-900 dark:text-slate-50">{svc.name}</p>
                      </div>
                      <p className={`text-xs ${ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {ok ? 'Connected' : 'Unreachable'}
                      </p>
                      {svc.detail && ok && (
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 truncate">{svc.detail}</p>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-6 mt-4 pt-3 border-t border-slate-100 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
                <span>Uptime: <span className="font-mono text-slate-700 dark:text-slate-300">{formatUptime(health.uptime)}</span></span>
                <span>Memory: <span className="font-mono text-slate-700 dark:text-slate-300">{health.memory.heapUsed}MB / {health.memory.heapTotal}MB</span></span>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">Unable to reach API server.</p>
          )}

          <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">
            For detailed pipeline stats and LLM cost breakdown, see the{' '}
            <a href="/dashboard" className="text-primary-600 dark:text-primary-400 hover:underline">Dashboard</a>.
          </p>
        </div>
      </Card>

      {/* ── Maintenance ──────────────────────────────────── */}
      <Card className="bg-white dark:bg-slate-800">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4 flex items-center gap-2">
            <Settings2 className="w-5 h-5" />
            Maintenance
          </h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-50">Reset App State</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Clear cached data and pipeline state. Use when the app feels stale or sluggish.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleResetAppState} className="gap-1.5">
                <RefreshCw className="w-3.5 h-3.5" />
                Reset
              </Button>
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-50">Export Configuration</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Download prompt overrides, model preferences, and feature toggles as JSON.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleExportConfig} className="gap-1.5">
                <Save className="w-3.5 h-3.5" />
                Export
              </Button>
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-50">Import Configuration</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Restore a previously exported configuration file.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleImportConfig} className="gap-1.5">
                <Save className="w-3.5 h-3.5 rotate-180" />
                Import
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── FEATURE TOGGLES TAB ────────────────────────────────────────

function FeatureTogglesTab() {
  const [features, setFeatures] = useState({
    deepAnalysis: true,
    extendedThinking: false,
    parallelStages: false,
    autoApproval: false,
    codeReviewAgent: true,
  });

  const featureItems = [
    {
      id: 'deepAnalysis',
      title: 'Deep Analysis Mode',
      description: 'Enable deep semantic analysis during SCAN and DECODE stages. Uses more tokens but provides richer insights.',
      tag: 'Recommended',
      tagColor: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    },
    {
      id: 'extendedThinking',
      title: 'Extended Thinking',
      description: 'Use extended thinking mode for complex reasoning during BLUEPRINT and ARCHITECT stages.',
      tag: 'Beta',
      tagColor: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
    },
    {
      id: 'parallelStages',
      title: 'Parallel Stage Execution',
      description: 'Allow independent stages to run in parallel when possible (e.g., SPEC_LOCK + ARCHITECT).',
      tag: 'Experimental',
      tagColor: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
    },
    {
      id: 'autoApproval',
      title: 'Auto-Approve Low-Risk Stages',
      description: 'Automatically approve SCAN and DECODE gates when validation passes above 90%.',
      tag: null,
      tagColor: '',
    },
    {
      id: 'codeReviewAgent',
      title: 'Code Review Agent',
      description: 'Run a review agent on generated code during FORGE to check for quality and security issues.',
      tag: 'Recommended',
      tagColor: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    },
  ];

  return (
    <Card className="bg-white dark:bg-slate-800">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-2 flex items-center gap-2">
          <ToggleLeft className="w-5 h-5" />
          Feature Toggles
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          Configure advanced features for your modernization pipeline.
        </p>
        <div className="space-y-3">
          {featureItems.map((feature) => (
            <div
              key={feature.id}
              className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-slate-900 dark:text-slate-50">{feature.title}</p>
                  {feature.tag && (
                    <Badge className={`${feature.tagColor} text-[10px]`}>{feature.tag}</Badge>
                  )}
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">{feature.description}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer ml-4">
                <input
                  type="checkbox"
                  checked={features[feature.id as keyof typeof features]}
                  onChange={(e) =>
                    setFeatures({ ...features, [feature.id]: e.target.checked })
                  }
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-300 dark:bg-slate-600 rounded-full peer peer-checked:bg-primary-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" />
              </label>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Button className="gap-2">
            <Save className="w-4 h-4" />
            Save Feature Settings
          </Button>
        </div>
      </div>
    </Card>
  );
}
