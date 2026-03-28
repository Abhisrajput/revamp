'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Users, AlertCircle, CheckCircle, Database,
  Cpu, HardDrive, Activity, FileText, Coins,
  Server, Download,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';

// ─── TYPES ──────────────────────────────────────────────────────

type AdminTab = 'overview' | 'users' | 'usage' | 'audit';

interface HealthData {
  status: 'healthy' | 'degraded';
  timestamp: string;
  uptime: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  services: {
    database: { status: string };
    redis: { status: string; latency_ms?: number };
    llm_orchestrator: { status: string; providers?: Record<string, string> };
    s3_storage: { status: string };
  };
}

interface PlatformStats {
  total_users: number;
  total_projects: number;
  total_pipeline_runs: number;
  pipeline_status_breakdown: Record<string, number>;
  total_llm_tokens: number;
  total_llm_cost_usd: number;
  total_llm_requests: number;
  recent_pipelines: Array<{
    id: string;
    status: string;
    current_stage: string | null;
    created_at: string;
  }>;
}

interface AdminUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  role: string;
  is_active: boolean;
  last_login: string | null;
  created_at: string;
}

interface LLMUsageData {
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: Array<{
    model: string;
    count: number;
    cost: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  created_at: string;
}

// ─── TABS ───────────────────────────────────────────────────────

const TABS: { id: AdminTab; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'usage', label: 'LLM Usage', icon: Coins },
  { id: 'audit', label: 'Audit Logs', icon: FileText },
];

// ─── MAIN PAGE ──────────────────────────────────────────────────

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  return (
    <div>
      <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-6">
        Admin Dashboard
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

      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'usage' && <UsageTab />}
      {activeTab === 'audit' && <AuditTab />}
    </div>
  );
}

// ─── OVERVIEW TAB ───────────────────────────────────────────────

function OverviewTab() {
  const { data: health } = useQuery<HealthData>({
    queryKey: ['admin', 'health'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/health');
      return res.data;
    },
    refetchInterval: 30_000,
  });

  const { data: stats } = useQuery<PlatformStats>({
    queryKey: ['admin', 'stats'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/stats');
      return res.data;
    },
    staleTime: 15_000,
  });

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  return (
    <div className="space-y-6">
      {/* Service Health */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {health?.services &&
          Object.entries(health.services).map(([name, service]) => {
            const isOk = service.status === 'ok';
            const labels: Record<string, { label: string; icon: React.ElementType }> = {
              database: { label: 'PostgreSQL', icon: Database },
              redis: { label: 'Redis', icon: Server },
              llm_orchestrator: { label: 'LLM Orchestrator', icon: Cpu },
              s3_storage: { label: 'S3/MinIO', icon: HardDrive },
            };
            const meta = labels[name] || { label: name, icon: Server };
            const Icon = meta.icon;

            return (
              <Card key={name} className="bg-white dark:bg-slate-800 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-slate-400" />
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      {meta.label}
                    </span>
                  </div>
                  <Badge
                    className={
                      isOk
                        ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                        : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                    }
                  >
                    {isOk ? (
                      <CheckCircle className="w-3 h-3 mr-1" />
                    ) : (
                      <AlertCircle className="w-3 h-3 mr-1" />
                    )}
                    {service.status}
                  </Badge>
                </div>
                {'latency_ms' in service && service.latency_ms !== undefined && (
                  <p className="text-xs text-slate-400 mt-1">{service.latency_ms}ms latency</p>
                )}
              </Card>
            );
          })}
      </div>

      {/* System Info */}
      {health && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-white dark:bg-slate-800 p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">Status</p>
            <p className={`text-2xl font-bold mt-1 capitalize ${
              health.status === 'healthy' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
            }`}>
              {health.status}
            </p>
          </Card>
          <Card className="bg-white dark:bg-slate-800 p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">Uptime</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
              {formatUptime(health.uptime)}
            </p>
          </Card>
          <Card className="bg-white dark:bg-slate-800 p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">Memory</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
              {health.memory.heapUsed}MB / {health.memory.heapTotal}MB
            </p>
          </Card>
        </div>
      )}

      {/* Platform Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="bg-white dark:bg-slate-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className="w-4 h-4 text-slate-400" />
              <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Users</p>
            </div>
            <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">
              {stats.total_users}
            </p>
          </Card>
          <Card className="bg-white dark:bg-slate-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="w-4 h-4 text-slate-400" />
              <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Projects</p>
            </div>
            <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">
              {stats.total_projects}
            </p>
          </Card>
          <Card className="bg-white dark:bg-slate-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Activity className="w-4 h-4 text-slate-400" />
              <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Pipeline Runs</p>
            </div>
            <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">
              {stats.total_pipeline_runs}
            </p>
          </Card>
          <Card className="bg-white dark:bg-slate-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Coins className="w-4 h-4 text-slate-400" />
              <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">LLM Cost</p>
            </div>
            <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">
              ${stats.total_llm_cost_usd.toFixed(2)}
            </p>
          </Card>
        </div>
      )}

      {/* Recent Pipeline Runs */}
      {stats && stats.recent_pipelines.length > 0 && (
        <Card className="bg-white dark:bg-slate-800 p-6">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
            Recent Pipeline Runs
          </h3>
          <div className="space-y-2">
            {stats.recent_pipelines.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    className={
                      run.status === 'completed'
                        ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                        : run.status === 'running'
                          ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                          : run.status === 'failed'
                            ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                    }
                  >
                    {run.status}
                  </Badge>
                  <span className="text-sm font-mono text-slate-600 dark:text-slate-400">
                    {run.current_stage || 'N/A'}
                  </span>
                </div>
                <span className="text-xs text-slate-400">
                  {new Date(run.created_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── USERS TAB ──────────────────────────────────────────────────

function UsersTab() {
  const { data } = useQuery<{ users: AdminUser[]; pagination: { total: number } }>({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/users');
      return res.data;
    },
  });

  const usersList = data?.users || [];

  return (
    <Card className="bg-white dark:bg-slate-800">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            User Management
          </h2>
          <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
            {data?.pagination.total || 0} total
          </Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">User</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Email</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Role</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Status</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Last Login</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Joined</th>
              </tr>
            </thead>
            <tbody>
              {usersList.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                >
                  <td className="py-3 px-4 text-sm text-slate-900 dark:text-slate-50">
                    {[user.first_name, user.last_name].filter(Boolean).join(' ') || 'N/A'}
                  </td>
                  <td className="py-3 px-4 text-sm text-slate-600 dark:text-slate-400">
                    {user.email}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <Badge
                      className={
                        user.role === 'admin'
                          ? 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400'
                          : user.role === 'architect'
                            ? 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }
                    >
                      {user.role}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <Badge
                      className={
                        user.is_active
                          ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }
                    >
                      {user.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-sm text-slate-600 dark:text-slate-400">
                    {user.last_login ? new Date(user.last_login).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="py-3 px-4 text-sm text-slate-600 dark:text-slate-400">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

// ─── USAGE TAB ──────────────────────────────────────────────────

function UsageTab() {
  const { data } = useQuery<LLMUsageData>({
    queryKey: ['admin', 'llm-usage'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/llm-usage');
      return res.data;
    },
  });

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-white dark:bg-slate-800 p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Total Cost</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">${data.total_cost_usd.toFixed(2)}</p>
        </Card>
        <Card className="bg-white dark:bg-slate-800 p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Total Tokens</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
            {data.total_tokens >= 1_000_000
              ? `${(data.total_tokens / 1_000_000).toFixed(1)}M`
              : `${(data.total_tokens / 1_000).toFixed(1)}K`}
          </p>
        </Card>
        <Card className="bg-white dark:bg-slate-800 p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">API Calls</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">{data.total_requests}</p>
        </Card>
      </div>

      {/* By Model */}
      {data.by_model.length > 0 && (
        <Card className="bg-white dark:bg-slate-800 p-6">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
            Usage by Model
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-left py-2 text-slate-600 dark:text-slate-400">Model</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Calls</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Input Tokens</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Output Tokens</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.by_model.map((m) => (
                  <tr key={m.model} className="border-b border-slate-100 dark:border-slate-700/50">
                    <td className="py-2 font-mono text-slate-900 dark:text-slate-100">{m.model}</td>
                    <td className="py-2 text-right text-slate-600 dark:text-slate-400">{m.count}</td>
                    <td className="py-2 text-right text-slate-600 dark:text-slate-400">{m.input_tokens.toLocaleString()}</td>
                    <td className="py-2 text-right text-slate-600 dark:text-slate-400">{m.output_tokens.toLocaleString()}</td>
                    <td className="py-2 text-right font-medium text-slate-900 dark:text-slate-100">${m.cost.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── AUDIT TAB ──────────────────────────────────────────────────

function AuditTab() {
  const { data } = useQuery<{ logs: AuditLog[]; pagination: { total: number } }>({
    queryKey: ['admin', 'audit-logs'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/audit-logs');
      return res.data;
    },
  });

  const logs = data?.logs || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
          Audit Logs
        </h2>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => {
            const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
            window.open(`${baseUrl}/admin/export/audit-logs`, '_blank');
          }}
        >
          <Download className="w-4 h-4" />
          Export CSV
        </Button>
      </div>

      <Card className="bg-white dark:bg-slate-800">
        <div className="p-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-left py-2 text-slate-600 dark:text-slate-400">Action</th>
                  <th className="text-left py-2 text-slate-600 dark:text-slate-400">Resource</th>
                  <th className="text-left py-2 text-slate-600 dark:text-slate-400">IP</th>
                  <th className="text-left py-2 text-slate-600 dark:text-slate-400">Time</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                  >
                    <td className="py-2">
                      <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono text-xs">
                        {log.action}
                      </Badge>
                    </td>
                    <td className="py-2 text-slate-600 dark:text-slate-400">
                      {log.resource_type}
                      {log.resource_id && (
                        <span className="text-xs text-slate-400 ml-1">
                          ({log.resource_id.slice(0, 8)}...)
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-slate-500 dark:text-slate-400 font-mono text-xs">
                      {log.ip_address || '-'}
                    </td>
                    <td className="py-2 text-slate-500 dark:text-slate-400 text-xs">
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-400">
                      No audit logs recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}
