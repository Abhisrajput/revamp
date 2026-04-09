'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Users, CheckCircle,
  Cpu, Activity, FileText, Coins,
  Download, FolderOpen, Zap, Clock,
  ArrowUpRight, ArrowDownRight, TrendingUp,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/lib/stores/auth-store';
import Link from 'next/link';
// Link is used in User Management (project badges) and LivePipelineFeed
import { MetricCard } from '@/components/dashboard/metric-card';
import { ServiceHealthGrid } from '@/components/dashboard/service-health-grid';
import { PipelineActivityChart } from '@/components/dashboard/pipeline-activity-chart';
import { LivePipelineFeed } from '@/components/dashboard/live-pipeline-feed';

// ─── TYPES ──────────────────────────────────────────────────────

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
    project_id?: string;
    status: string;
    current_stage: string | null;
    started_at?: string;
    created_at: string;
    project?: { id: string; name: string };
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
  user_display: string | null;
  project_name: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

type AuditCategory = 'All' | 'AI' | 'Pipeline' | 'Auth' | 'File' | 'Settings' | 'Team';

const ACTION_CATEGORY: Record<string, AuditCategory> = {
  PIPELINE_STARTED: 'Pipeline', STAGE_STARTED: 'AI', STAGE_COMPLETED: 'AI',
  STAGE_APPROVED: 'Pipeline', STAGE_REJECTED: 'Pipeline',
  LOGIN: 'Auth', SIGNUP: 'Auth', LOGOUT: 'Auth', PASSWORD_RESET: 'Auth',
  PROJECT_CREATED: 'Settings', PROJECT_UPDATED: 'Settings', PROJECT_DELETED: 'Settings',
  FILE_UPLOADED: 'File', FILE_DELETED: 'File',
  MEMBER_ADDED: 'Team', MEMBER_REMOVED: 'Team', MEMBER_ROLE_CHANGED: 'Team', USER_UPDATED: 'Team',
};
const ACTION_COLORS: Record<string, string> = {
  PIPELINE_STARTED: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  STAGE_STARTED: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  STAGE_COMPLETED: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  STAGE_APPROVED: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
  STAGE_REJECTED: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
};
const ACTION_LABELS: Record<string, string> = {
  PIPELINE_STARTED: 'Pipeline Started', STAGE_STARTED: 'Stage Execution',
  STAGE_COMPLETED: 'Stage Completed', STAGE_APPROVED: 'Stage Approved', STAGE_REJECTED: 'Stage Rejected',
};
const AUDIT_CATEGORIES: AuditCategory[] = ['All', 'AI', 'Pipeline', 'Auth', 'File', 'Settings', 'Team'];

function formatAuditAction(action: string): string {
  return ACTION_LABELS[action] || action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function getAuditActionColor(action: string): string {
  return ACTION_COLORS[action] || 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
}
function getAuditCategory(action: string): AuditCategory {
  return ACTION_CATEGORY[action] || 'Pipeline';
}
function formatAuditChanges(log: AuditLog): string {
  const changes = log.changes;
  if (!changes || Object.keys(changes).length === 0) return '';
  const parts: string[] = [];
  if (changes.stageName) parts.push(`Stage: ${changes.stageName}`);
  if (log.project_name) parts.push(`Project: ${log.project_name}`);
  else if (changes.projectId) parts.push(`Project: ${(changes.projectId as string).slice(0, 8)}...`);
  if (changes.comment) parts.push(`"${(changes.comment as string).slice(0, 60)}"`);
  if (changes.model) parts.push(`Model: ${changes.model}`);
  if (parts.length === 0) return Object.entries(changes).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)}`).join(', ');
  return parts.join(' · ');
}

// ─── ROLE-BASED SECTIONS ────────────────────────────────────────

interface DashboardSection {
  id: string;
  label: string;
  icon: React.ElementType;
  roles: string[]; // which roles can see this section
}

const DASHBOARD_SECTIONS: DashboardSection[] = [
  { id: 'overview', label: 'Overview', icon: Activity, roles: ['admin', 'architect', 'developer', 'sme'] },
  { id: 'projects', label: 'My Projects', icon: FolderOpen, roles: ['admin', 'architect', 'developer', 'sme'] },
  { id: 'users', label: 'User Management', icon: Users, roles: ['admin'] },
  { id: 'usage', label: 'LLM Usage', icon: Coins, roles: ['admin', 'architect'] },
  { id: 'audit', label: 'Audit Logs', icon: FileText, roles: ['admin'] },
];

// ─── MAIN PAGE ──────────────────────────────────────────────────

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const userRole = user?.role || 'developer';

  const visibleSections = DASHBOARD_SECTIONS.filter((s) =>
    s.roles.includes(userRole),
  );

  const [activeSection, setActiveSection] = useState(visibleSections[0]?.id || 'overview');

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
            Dashboard
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {userRole === 'admin'
              ? 'Platform overview and administration'
              : userRole === 'architect'
                ? 'Architecture overview and usage insights'
                : 'Your projects and pipeline activity'}
          </p>
        </div>
        <Badge className="bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-300 capitalize">
          {userRole}
        </Badge>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 mb-6 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
        {visibleSections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                isActive
                  ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {section.label}
            </button>
          );
        })}
      </div>

      {/* Section content */}
      {activeSection === 'overview' && <OverviewSection userRole={userRole} />}
      {activeSection === 'projects' && <ProjectsSection />}
      {activeSection === 'users' && <UsersSection />}
      {activeSection === 'usage' && <UsageSection />}
      {activeSection === 'audit' && <AuditSection />}
    </div>
  );
}

// ─── OVERVIEW SECTION ───────────────────────────────────────────

function OverviewSection({ userRole }: { userRole: string }) {
  const { data: health } = useQuery<HealthData>({
    queryKey: ['admin', 'health'],
    queryFn: async () => (await apiClient.get('/admin/health')).data,
    refetchInterval: 30_000,
    enabled: userRole === 'admin',
  });

  const { data: stats } = useQuery<PlatformStats>({
    queryKey: ['admin', 'stats'],
    queryFn: async () => (await apiClient.get('/admin/stats')).data,
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
      {/* ─── Metric Cards ──────────────────────────────────────── */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {userRole === 'admin' && (
            <MetricCard
              title="Users"
              value={stats.total_users}
              icon={Users}
              color="primary"
              subtitle="Active platform users"
            />
          )}
          <MetricCard
            title="Projects"
            value={stats.total_projects}
            icon={FolderOpen}
            color="emerald"
            subtitle="Modernization projects"
          />
          <MetricCard
            title="Pipeline Runs"
            value={stats.total_pipeline_runs}
            icon={Activity}
            color="cyan"
            subtitle={`${stats.pipeline_status_breakdown?.running || 0} active`}
            pulse={(stats.pipeline_status_breakdown?.running || 0) > 0}
          />
          <MetricCard
            title="LLM Cost"
            value={`$${stats.total_llm_cost_usd?.toFixed(2) || '0.00'}`}
            icon={Coins}
            color="amber"
            subtitle={`${((stats.total_llm_tokens || 0) / 1000).toFixed(0)}K tokens used`}
          />
        </div>
      )}

      {/* ─── Service Health (admin only) ───────────────────────── */}
      {userRole === 'admin' && health?.services && (
        <ServiceHealthGrid services={health.services} />
      )}

      {/* ─── System Info (admin only) ──────────────────────────── */}
      {userRole === 'admin' && health && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard
            title="Status"
            value={health.status === 'healthy' ? 'Healthy' : 'Degraded'}
            icon={CheckCircle}
            color={health.status === 'healthy' ? 'emerald' : 'red'}
            pulse={health.status === 'healthy'}
          />
          <MetricCard
            title="Uptime"
            value={formatUptime(health.uptime)}
            icon={Clock}
            color="primary"
          />
          <MetricCard
            title="Memory"
            value={`${health.memory.heapUsed}MB`}
            icon={Cpu}
            color="cyan"
            subtitle={`of ${health.memory.heapTotal}MB heap`}
          />
        </div>
      )}

      {/* ─── Token Usage & Cost ─────────────────────────────────── */}
      <TokenUsageSummary />

      {/* ─── Pipeline Activity Chart + Live Feed ───────────────── */}
      {stats && stats.recent_pipelines.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <PipelineActivityChart runs={stats.recent_pipelines} />
          <LivePipelineFeed runs={stats.recent_pipelines} />
        </div>
      )}
    </div>
  );
}

// ─── PROJECTS SECTION ───────────────────────────────────────────

function ProjectsSection() {
  const { data: projects, isLoading } = useQuery<any[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await apiClient.get('/projects');
      return res.data?.projects || res.data || [];
    },
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-36 bg-slate-200 dark:bg-slate-700 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  const projectList = Array.isArray(projects) ? projects : [];

  if (projectList.length === 0) {
    return (
      <Card className="bg-[#f9faf9] dark:bg-slate-800 p-8 border-[#e2e8e4] dark:border-slate-700 text-center">
        <FolderOpen className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
        <p className="text-slate-500 dark:text-slate-400 mb-4">No projects yet</p>
        <Link href="/projects/new">
          <Button className="bg-primary-600 hover:bg-primary-700 text-white rounded-xl">
            Create Your First Project
          </Button>
        </Link>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {projectList.slice(0, 9).map((project: any) => (
        <Link key={project.id} href={`/projects/${project.id}`}>
          <Card className="bg-[#f9faf9] dark:bg-slate-800 p-5 border-[#e2e8e4] dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-700 hover:shadow-md transition-all duration-200 cursor-pointer group h-full">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-[15px] font-semibold text-slate-900 dark:text-slate-50 group-hover:text-primary-700 dark:group-hover:text-primary-400 transition-colors truncate">
                {project.name}
              </h3>
              <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] shrink-0 ml-2">
                {project.target_stack || 'TBD'}
              </Badge>
            </div>
            {project.description && (
              <p className="text-[13px] text-slate-500 dark:text-slate-400 line-clamp-2 mb-3">
                {project.description}
              </p>
            )}
            <div className="flex items-center gap-3 text-[11px] text-slate-400 dark:text-slate-500">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(project.created_at).toLocaleDateString()}
              </span>
              {project.target_cloud && (
                <span className="flex items-center gap-1 capitalize">
                  <Zap className="w-3 h-3" />
                  {project.target_cloud}
                </span>
              )}
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

// ─── USERS SECTION (Admin only) ─────────────────────────────────

function UsersSection() {
  const { data } = useQuery<{ users: AdminUser[]; pagination: { total: number } }>({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/users');
      return res.data;
    },
  });

  const usersList = data?.users || [];

  return (
    <Card className="bg-[#f9faf9] dark:bg-slate-800 border-[#e2e8e4] dark:border-slate-700">
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
              <tr className="border-b border-[#e2e8e4] dark:border-slate-700">
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">User</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Email</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Role</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Projects</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Status</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-slate-600 dark:text-slate-400">Last Login</th>
              </tr>
            </thead>
            <tbody>
              {usersList.map((u) => (
                <tr
                  key={u.id}
                  className="border-b border-[#e2e8e4] dark:border-slate-700 hover:bg-white dark:hover:bg-slate-700/50"
                >
                  <td className="py-3 px-4 text-sm text-slate-900 dark:text-slate-50">
                    {[u.first_name, u.last_name].filter(Boolean).join(' ') || 'N/A'}
                  </td>
                  <td className="py-3 px-4 text-sm text-slate-600 dark:text-slate-400">
                    {u.email}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <Badge
                      className={
                        u.role === 'admin'
                          ? 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400'
                          : u.role === 'architect'
                            ? 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }
                    >
                      {u.role}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-sm">
                    {(u as any).projects?.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {(u as any).projects.map((p: any) => (
                          <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-1.5 group">
                            <span className="text-xs text-primary-600 dark:text-primary-400 group-hover:underline">{p.name}</span>
                            <span className="text-[9px] text-slate-400">({p.role})</span>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <span className="text-slate-400 text-xs">No projects</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <Badge
                      className={
                        u.is_active
                          ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }
                    >
                      {u.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-sm text-slate-600 dark:text-slate-400">
                    {u.last_login ? new Date(u.last_login).toLocaleDateString() : 'Never'}
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

// ─── TOKEN USAGE SUMMARY (visible to all roles) ────────────────

const MODEL_PRICING: Record<string, { input: number; output: number; label: string }> = {
  'claude-opus-4-6':            { input: 5.0,   output: 25.0,  label: 'Claude Opus 4.6' },
  'claude-sonnet-4-6':          { input: 3.0,   output: 15.0,  label: 'Claude Sonnet 4.6' },
  'claude-haiku-4-5-20251001':  { input: 1.0,   output: 5.0,   label: 'Claude Haiku 4.5' },
  'gpt-4o':                     { input: 2.50,  output: 10.0,  label: 'GPT-4o' },
  'gpt-4o-mini':                { input: 0.15,  output: 0.60,  label: 'GPT-4o Mini' },
  'gpt-4.1':                    { input: 2.0,   output: 8.0,   label: 'GPT-4.1' },
  'gpt-4.1-mini':               { input: 0.40,  output: 1.60,  label: 'GPT-4.1 Mini' },
  'o3-mini':                    { input: 1.10,  output: 4.40,  label: 'o3-mini' },
  'gemini-2.0-flash':           { input: 0.10,  output: 0.40,  label: 'Gemini 2.0 Flash' },
  'gemini-2.5-pro':             { input: 1.25,  output: 10.0,  label: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash':           { input: 0.15,  output: 0.60,  label: 'Gemini 2.5 Flash' },
};

function getProviderFromModel(model: string): { name: string; color: string } {
  if (model.startsWith('claude')) return { name: 'Anthropic', color: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' };
  if (model.startsWith('gpt') || model.startsWith('o3')) return { name: 'OpenAI', color: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' };
  if (model.startsWith('gemini')) return { name: 'Google', color: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' };
  return { name: 'Other', color: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' };
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

function TokenUsageSummary() {
  const { data } = useQuery<LLMUsageData>({
    queryKey: ['admin', 'llm-usage'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/llm-usage');
      return res.data;
    },
    staleTime: 30_000,
  });

  if (!data || data.total_requests === 0) return null;

  const totalInputTokens = data.by_model.reduce((sum, m) => sum + m.input_tokens, 0);
  const totalOutputTokens = data.by_model.reduce((sum, m) => sum + m.output_tokens, 0);
  const inputPct = data.total_tokens > 0 ? (totalInputTokens / data.total_tokens) * 100 : 50;

  return (
    <>
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
        Token Usage & Cost
      </h3>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Summary stats */}
        <Card className="bg-[#f9faf9] dark:bg-slate-800 p-5 border-[#e2e8e4] dark:border-slate-700">
          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Coins className="w-4 h-4 text-slate-400" />
                <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Total Cost</p>
              </div>
              <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">
                ${data.total_cost_usd.toFixed(2)}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-[#e2e8e4] dark:border-slate-700">
              <div>
                <p className="text-[11px] text-slate-400 uppercase">Total Tokens</p>
                <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                  {fmtTokens(data.total_tokens)}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-slate-400 uppercase">API Calls</p>
                <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                  {data.total_requests}
                </p>
              </div>
            </div>
            {/* Input / Output breakdown bar */}
            <div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                <span className="flex items-center gap-1">
                  <ArrowUpRight className="w-3 h-3 text-blue-500" />
                  Input: {fmtTokens(totalInputTokens)}
                </span>
                <span className="flex items-center gap-1">
                  <ArrowDownRight className="w-3 h-3 text-emerald-500" />
                  Output: {fmtTokens(totalOutputTokens)}
                </span>
              </div>
              <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden flex">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${inputPct}%` }}
                />
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${100 - inputPct}%` }}
                />
              </div>
            </div>
          </div>
        </Card>

        {/* Right: Model breakdown with pricing */}
        <Card className="bg-[#f9faf9] dark:bg-slate-800 p-5 border-[#e2e8e4] dark:border-slate-700 lg:col-span-2">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-slate-400" />
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              Cost by Model
            </h4>
          </div>
          {data.by_model.length > 0 ? (
            <div className="space-y-2.5">
              {data.by_model.map((m) => {
                const provider = getProviderFromModel(m.model);
                const pricing = MODEL_PRICING[m.model];
                const pct = data.total_tokens > 0
                  ? ((m.input_tokens + m.output_tokens) / data.total_tokens) * 100
                  : 0;

                return (
                  <div key={m.model} className="flex items-center gap-3">
                    <Badge className={`${provider.color} text-[10px] min-w-[70px] justify-center py-0.5`}>
                      {provider.name}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="text-slate-700 dark:text-slate-300 font-mono truncate">
                          {pricing?.label || m.model}
                        </span>
                        <span className="text-slate-500 dark:text-slate-400 shrink-0 ml-2">
                          {fmtTokens(m.input_tokens + m.output_tokens)} · ${m.cost.toFixed(4)}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                        <div
                          className="bg-primary-500 h-1.5 rounded-full transition-all"
                          style={{ width: `${Math.max(pct, 1)}%` }}
                        />
                      </div>
                      {pricing && (
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                          ${pricing.input}/1M input · ${pricing.output}/1M output
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-slate-400 dark:text-slate-500">No model usage data yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}

// ─── USAGE SECTION (Admin + Architect) ──────────────────────────

function UsageSection() {
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
        <Card className="bg-[#f9faf9] dark:bg-slate-800 p-4 border-[#e2e8e4] dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Total Cost</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">${data.total_cost_usd.toFixed(2)}</p>
        </Card>
        <Card className="bg-[#f9faf9] dark:bg-slate-800 p-4 border-[#e2e8e4] dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Total Tokens</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
            {data.total_tokens >= 1_000_000
              ? `${(data.total_tokens / 1_000_000).toFixed(1)}M`
              : `${(data.total_tokens / 1_000).toFixed(1)}K`}
          </p>
        </Card>
        <Card className="bg-[#f9faf9] dark:bg-slate-800 p-4 border-[#e2e8e4] dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">API Calls</p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">{data.total_requests}</p>
        </Card>
      </div>

      {/* By Model — enhanced with pricing info */}
      {data.by_model.length > 0 && (
        <Card className="bg-[#f9faf9] dark:bg-slate-800 p-6 border-[#e2e8e4] dark:border-slate-700">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
            Usage by Model
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e2e8e4] dark:border-slate-700">
                  <th className="text-left py-2 text-slate-600 dark:text-slate-400">Model</th>
                  <th className="text-left py-2 text-slate-600 dark:text-slate-400">Provider</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Calls</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Input Tokens</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Output Tokens</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Cost</th>
                  <th className="text-right py-2 text-slate-600 dark:text-slate-400">Rate (per 1M)</th>
                </tr>
              </thead>
              <tbody>
                {data.by_model.map((m) => {
                  const provider = getProviderFromModel(m.model);
                  const pricing = MODEL_PRICING[m.model];
                  return (
                    <tr key={m.model} className="border-b border-[#e2e8e4]/60 dark:border-slate-700/50">
                      <td className="py-2.5 font-mono text-slate-900 dark:text-slate-100">
                        {pricing?.label || m.model}
                      </td>
                      <td className="py-2.5">
                        <Badge className={`${provider.color} text-[10px] py-0`}>
                          {provider.name}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-right text-slate-600 dark:text-slate-400">{m.count}</td>
                      <td className="py-2.5 text-right text-slate-600 dark:text-slate-400">{m.input_tokens.toLocaleString()}</td>
                      <td className="py-2.5 text-right text-slate-600 dark:text-slate-400">{m.output_tokens.toLocaleString()}</td>
                      <td className="py-2.5 text-right font-medium text-slate-900 dark:text-slate-100">${m.cost.toFixed(4)}</td>
                      <td className="py-2.5 text-right text-xs text-slate-400 dark:text-slate-500">
                        {pricing
                          ? `$${pricing.input} in / $${pricing.output} out`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Model Pricing Reference */}
      <Card className="bg-[#f9faf9] dark:bg-slate-800 p-6 border-[#e2e8e4] dark:border-slate-700">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-1">
          Model Pricing Reference
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          Estimated cost per 1M tokens (USD) for available models
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(['Anthropic', 'OpenAI', 'Google'] as const).map((providerName) => {
            const models = Object.entries(MODEL_PRICING).filter(
              ([key]) => getProviderFromModel(key).name === providerName,
            );
            const providerMeta = getProviderFromModel(models[0]?.[0] || '');
            return (
              <div key={providerName}>
                <Badge className={`${providerMeta.color} text-xs mb-2`}>
                  {providerName}
                </Badge>
                <div className="space-y-1.5">
                  {models.map(([key, pricing]) => (
                    <div key={key} className="flex items-center justify-between text-xs">
                      <span className="text-slate-700 dark:text-slate-300">{pricing.label}</span>
                      <span className="text-slate-400 dark:text-slate-500 font-mono">
                        ${pricing.input} / ${pricing.output}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ─── AUDIT SECTION (Admin only) ─────────────────────────────────

function AuditSection() {
  const [activeFilter, setActiveFilter] = useState<AuditCategory>('All');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data } = useQuery<{ logs: AuditLog[]; pagination: { total: number } }>({
    queryKey: ['admin', 'audit-logs'],
    queryFn: async () => {
      const res = await apiClient.get('/admin/audit-logs?limit=100');
      return res.data;
    },
  });

  const allLogs = data?.logs || [];
  const logs = activeFilter === 'All' ? allLogs : allLogs.filter(l => getAuditCategory(l.action) === activeFilter);

  const categoryCounts: Record<AuditCategory, number> = { All: allLogs.length, AI: 0, Pipeline: 0, Auth: 0, File: 0, Settings: 0, Team: 0 };
  for (const log of allLogs) {
    const cat = getAuditCategory(log.action);
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Audit Logs</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">{allLogs.length} events recorded</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => {
          const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';
          window.open(`${baseUrl}/admin/export/audit-logs`, '_blank');
        }}>
          <Download className="w-4 h-4" />
          Export CSV
        </Button>
      </div>

      {/* Category Filters */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
        {AUDIT_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveFilter(cat)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeFilter === cat
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            {cat}
            {categoryCounts[cat] > 0 && <span className="ml-1.5 text-[10px] opacity-60">{categoryCounts[cat]}</span>}
          </button>
        ))}
      </div>

      {/* Log Entries */}
      <Card className="bg-[#f9faf9] dark:bg-slate-800 border-[#e2e8e4] dark:border-slate-700">
        <div className="divide-y divide-[#e2e8e4] dark:divide-slate-700/50">
          {logs.map((log) => {
            const isExpanded = expandedId === log.id;
            const details = formatAuditChanges(log);
            return (
              <div
                key={log.id}
                className="px-4 py-3 hover:bg-white dark:hover:bg-slate-700/30 transition-colors cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge className={`${getAuditActionColor(log.action)} text-xs font-medium shrink-0`}>
                      {formatAuditAction(log.action)}
                    </Badge>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-700 dark:text-slate-300">
                          {log.project_name || log.resource_type.replace(/_/g, ' ')}
                        </span>
                        <span className="text-xs text-slate-400 dark:text-slate-500">
                          by {log.user_display || 'system'}
                        </span>
                      </div>
                      {details && <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{details}</p>}
                    </div>
                  </div>
                  <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums shrink-0">
                    {new Date(log.created_at).toLocaleString()}
                  </span>
                </div>
                {isExpanded && (
                  <div className="mt-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-md text-xs space-y-1.5">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                      <div><span className="text-slate-400">Performed by:</span> <span className="ml-1 text-slate-600 dark:text-slate-300 font-medium">{log.user_display || 'System'}</span></div>
                      <div><span className="text-slate-400">Category:</span> <span className="ml-1 text-slate-600 dark:text-slate-300">{getAuditCategory(log.action)}</span></div>
                      {log.project_name && (
                        <div><span className="text-slate-400">Project:</span> <span className="ml-1 text-slate-600 dark:text-slate-300 font-medium">{log.project_name}</span></div>
                      )}
                      <div><span className="text-slate-400">IP Address:</span> <span className="ml-1 font-mono text-slate-600 dark:text-slate-300">{log.ip_address || '-'}</span></div>
                      {(log.changes as any)?.stageName && (
                        <div><span className="text-slate-400">Stage:</span> <span className="ml-1 text-slate-600 dark:text-slate-300 font-medium">{(log.changes as any).stageName}</span></div>
                      )}
                      {(log.changes as any)?.model && (
                        <div><span className="text-slate-400">Model:</span> <span className="ml-1 font-mono text-slate-600 dark:text-slate-300">{(log.changes as any).model}</span></div>
                      )}
                      {(log.changes as any)?.comment && (
                        <div className="col-span-2"><span className="text-slate-400">Comment:</span> <span className="ml-1 text-slate-600 dark:text-slate-300 italic">"{(log.changes as any).comment}"</span></div>
                      )}
                      {log.user_agent && (
                        <div className="col-span-2"><span className="text-slate-400">Browser:</span> <span className="ml-1 text-slate-500 dark:text-slate-400 text-[11px]">{log.user_agent.replace(/Mozilla\/5\.0\s*/, '').slice(0, 80)}</span></div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {logs.length === 0 && (
            <div className="py-12 text-center text-slate-400">
              No audit logs {activeFilter !== 'All' ? `in "${activeFilter}" category` : 'recorded yet'}.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
