'use client';

import { useState, useEffect, memo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { StageStepper } from '@/components/pipeline/stage-stepper';

// Lazy-load ExportDialog (heavy — only shown when user clicks Export)
const ExportDialog = dynamic(
  () => import('@/components/pipeline/export-dialog').then(m => ({ default: m.ExportDialog })),
  { ssr: false }
);
import {
  ArrowLeft, Settings, Play, GitBranch, Cloud, Code2,
  Users, Layers, Download, MoreVertical, Trash2, Archive,
  Copy, ExternalLink, Calendar, FileText, Shield,
  Activity, Zap, Coins, ArrowUpRight, ArrowDownRight,
  TrendingUp, Cpu, Radio, ChevronRight,
} from 'lucide-react';
import Link from 'next/link';
import { apiClient } from '@/lib/api-client';
import { usePipelineStore } from '@/lib/stores/pipeline-store';
import { usePipelineActivityStore } from '@/lib/stores/pipeline-activity-store';
import { useAuthStore } from '@/lib/stores/auth-store';
import { STAGE_DISPLAY_LABELS } from '@revamp/shared-types';

// ─── CONSTANTS ─────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = STAGE_DISPLAY_LABELS;

function getStatusColor(status: string) {
  switch (status) {
    case 'active': case 'in_progress':
      return 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400';
    case 'completed':
      return 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400';
    case 'draft':
      return 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400';
    case 'archived':
      return 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400';
    default:
      return 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
  }
}

function getRunStatusColor(status: string) {
  switch (status) {
    case 'completed': return 'bg-green-500';
    case 'running': return 'bg-blue-500 animate-pulse';
    case 'failed': return 'bg-red-500';
    default: return 'bg-slate-400';
  }
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ─── ACTIONS MENU ──────────────────────────────────────────────────

function ActionsMenu({ project, onArchive, onDuplicate, onDelete }: {
  project: any;
  onArchive: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>
        <MoreVertical className="w-4 h-4" />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-50 w-48 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 py-1">
            <button
              onClick={() => { onDuplicate(); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Copy className="w-4 h-4" /> Duplicate Project
            </button>
            <button
              onClick={() => { onArchive(); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Archive className="w-4 h-4" />
              {project.status === 'archived' ? 'Unarchive' : 'Archive'}
            </button>
            {project.source_url && (
              <a
                href={project.source_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                <ExternalLink className="w-4 h-4" /> Open Repository
              </a>
            )}
            <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
            <button
              onClick={() => {
                onDelete();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Trash2 className="w-4 h-4" /> Delete Project
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const projectId = params.id as string;
  const pipelineStages = usePipelineStore((s) => s.stages);
  const setActiveStage = usePipelineStore((s) => s.setActiveStage);
  const token = useAuthStore((s) => s.token);
  const [showExport, setShowExport] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: project, isLoading } = useQuery<any>({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const response = await apiClient.get(`/projects/${projectId}`);
      return response.data;
    },
  });

  // ── Mutations ───────────────────────────────────────────────────

  const archiveMutation = useMutation({
    mutationFn: async () => {
      await apiClient.patch(`/projects/${projectId}`, {
        status: project?.status === 'archived' ? 'draft' : 'archived',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiClient.delete(`/projects/${projectId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      router.push('/projects');
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post('/projects', {
        name: `${project?.name} (Copy)`,
        description: project?.description,
        source_type: project?.source_type,
        source_url: project?.source_url,
        source_branch: project?.source_branch,
        target_stack: project?.target_stack,
        target_cloud: project?.target_cloud,
        prompt_template_id: project?.prompt_template_id,
      });
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      router.push(`/projects/${data.id}`);
    },
  });

  // ── Loading / Error ─────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="h-8 w-48 sm:w-64 bg-slate-200 dark:bg-slate-700 rounded-lg" />
            <div className="h-4 w-64 sm:w-96 bg-slate-200 dark:bg-slate-700 rounded mt-2" />
          </div>
          <div className="flex gap-2">
            <div className="h-9 w-24 bg-slate-200 dark:bg-slate-700 rounded-lg" />
            <div className="h-9 w-32 bg-slate-200 dark:bg-slate-700 rounded-lg" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 bg-slate-200 dark:bg-slate-700 rounded-xl" />
          ))}
        </div>
        <div className="h-40 bg-slate-200 dark:bg-slate-700 rounded-xl" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-slate-600 dark:text-slate-400">Project not found</p>
        <Link href="/projects">
          <Button className="mt-4">Back to Projects</Button>
        </Link>
      </div>
    );
  }

  const stageIndex = project.current_stage_index ?? 0;
  const stageName = project.current_stage || 'SCAN';
  const settings = (project.settings ?? {}) as Record<string, unknown>;
  const hasMembers = project.members && project.members.length > 0;
  const hasPipelineRuns = project.pipelineRuns && project.pipelineRuns.length > 0;
  const hasDocs = project.supportingDocuments && project.supportingDocuments.length > 0;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-start sm:items-center gap-3 sm:gap-4 min-w-0">
          <Link href="/projects" className="shrink-0">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1" />
              Projects
            </Button>
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-50 truncate">
                {project.name}
              </h1>
              <Badge className={getStatusColor(project.status)}>
                {project.status}
              </Badge>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5 truncate">
              {project.description || 'No description'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap sm:flex-nowrap">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setShowExport(true)}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
          <Link href={`/projects/${projectId}/settings`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </Button>
          </Link>
          <Link href={`/projects/${projectId}/pipeline`}>
            <Button size="sm" className="gap-1.5">
              <Play className="w-4 h-4" />
              Open Pipeline
            </Button>
          </Link>
          <ActionsMenu
            project={project}
            onArchive={() => archiveMutation.mutate()}
            onDuplicate={() => duplicateMutation.mutate()}
            onDelete={() => setShowDeleteConfirm(true)}
          />
        </div>
      </div>

      {/* Config Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card className="bg-white dark:bg-slate-800">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
              <Code2 className="w-4 h-4" />
              <span className="text-xs font-medium">Target Stack</span>
            </div>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-50">
              {project.target_stack || 'Not selected'}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-slate-800">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
              <Cloud className="w-4 h-4" />
              <span className="text-xs font-medium">Cloud</span>
            </div>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-50">
              {project.target_cloud ? project.target_cloud.toUpperCase() : 'Not selected'}
            </p>
          </CardContent>
        </Card>

        {/* Token Usage summary card */}
        <TokenUsageSummaryCard projectId={projectId} />

        {/* Cost summary card */}
        <CostSummaryCard projectId={projectId} />
      </div>

      {/* Pipeline Overview */}
      <Card className="bg-white dark:bg-slate-800 mb-6">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Modernization Pipeline</CardTitle>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              Stage {stageIndex + 1}/8: {STAGE_LABELS[stageName] || stageName}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <StageStepper
            stages={pipelineStages}
            activeIndex={stageIndex}
            onStageClick={(index) => {
              setActiveStage(index);
              router.push(`/projects/${projectId}/pipeline`);
            }}
          />
        </CardContent>
      </Card>

      {/* Bottom Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Pipeline Runs */}
        <Card className="bg-white dark:bg-slate-800">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="w-4 h-4 text-slate-400" />
                Pipeline Runs — {project.name}
              </CardTitle>
              {hasPipelineRuns && (
                <Badge variant="outline" className="text-xs">
                  {project.pipelineRuns.length} total
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {hasPipelineRuns ? (
              <div className="space-y-2">
                {project.pipelineRuns.slice(0, 5).map((run: any) => (
                  <Link
                    key={run.id}
                    href={`/projects/${projectId}/runs/${run.id}`}
                    target="_blank"
                    className="flex items-center justify-between text-sm p-2 -mx-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors group cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className={`w-2 h-2 rounded-full ${getRunStatusColor(run.status)}`} />
                      <span className="text-slate-900 dark:text-slate-50 group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors">
                        {run.current_stage ? STAGE_LABELS[run.current_stage] || run.current_stage : 'Starting'}
                      </span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {run.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {run.started_at ? new Date(run.started_at).toLocaleString() : timeAgo(run.created_at)}
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 group-hover:text-primary-500 transition-colors" />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="text-center py-6">
                <Layers className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                <p className="text-sm text-slate-500 dark:text-slate-400">No pipeline runs yet</p>
                <Link href={`/projects/${projectId}/pipeline`}>
                  <Button size="sm" className="mt-3">
                    <Play className="w-3.5 h-3.5 mr-1.5" />
                    Start Pipeline
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Project Details */}
        <Card className="bg-white dark:bg-slate-800">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-400" />
              Project Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <DetailRow label="Created" icon={<Calendar className="w-3.5 h-3.5" />}>
                {new Date(project.created_at).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                })}
              </DetailRow>

              {project.source_type && (
                <DetailRow label="Source" icon={<GitBranch className="w-3.5 h-3.5" />}>
                  <span className="capitalize">{project.source_type}</span>
                </DetailRow>
              )}

              {project.source_url && (
                <DetailRow label="Repository" icon={<ExternalLink className="w-3.5 h-3.5" />}>
                  <a
                    href={project.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 dark:text-primary-400 hover:underline truncate max-w-[160px] inline-block align-bottom"
                    title={project.source_url}
                  >
                    {project.source_url.split('/').slice(-2).join('/')}
                  </a>
                </DetailRow>
              )}

              {project.source_branch && (
                <DetailRow label="Branch" icon={<GitBranch className="w-3.5 h-3.5" />}>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {project.source_branch}
                  </Badge>
                </DetailRow>
              )}

              {project.prompt_template_id && (
                <DetailRow label="Template" icon={<Zap className="w-3.5 h-3.5" />}>
                  {project.prompt_template_id}
                </DetailRow>
              )}

              <DetailRow label="Team" icon={<Users className="w-3.5 h-3.5" />}>
                {project.members?.length || 0} member{(project.members?.length || 0) !== 1 ? 's' : ''}
              </DetailRow>

              {settings.confidenceThreshold && (
                <DetailRow label="Confidence" icon={<Shield className="w-3.5 h-3.5" />}>
                  {settings.confidenceThreshold}%
                </DetailRow>
              )}

              {settings.bddFramework && (
                <DetailRow label="BDD Framework" icon={<Code2 className="w-3.5 h-3.5" />}>
                  <span className="capitalize">{settings.bddFramework}</span>
                </DetailRow>
              )}

              {hasDocs && (
                <DetailRow label="Documents" icon={<FileText className="w-3.5 h-3.5" />}>
                  {project.supportingDocuments.length} file{project.supportingDocuments.length !== 1 ? 's' : ''}
                </DetailRow>
              )}

              {hasMembers && (
                <div className="pt-3 border-t border-slate-200 dark:border-slate-700">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                    Team Members
                  </span>
                  <div className="mt-2 space-y-2">
                    {project.members.slice(0, 4).map((m: any) => (
                      <div key={m.id} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                            <span className="text-[10px] font-bold text-primary-700 dark:text-primary-400">
                              {(m.user?.first_name?.[0] || m.user?.email?.[0] || '?').toUpperCase()}
                            </span>
                          </div>
                          <span className="text-slate-900 dark:text-slate-50 text-sm">
                            {m.user?.first_name
                              ? `${m.user.first_name} ${m.user.last_name || ''}`
                              : m.user?.email || 'Unknown'}
                          </span>
                        </div>
                        <Badge className="text-[10px] px-1.5 py-0">{m.role}</Badge>
                      </div>
                    ))}
                    {project.members.length > 4 && (
                      <p className="text-xs text-slate-400 dark:text-slate-500">
                        +{project.members.length - 4} more
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Audit Logs */}
      <ProjectAuditSection projectId={projectId} />

      {/* Live Token Tracker (visible during active pipeline execution) */}
      <LiveTokenTracker projectId={projectId} />

      {/* Token Usage & Cost (historical aggregate) */}
      <ProjectTokenUsage projectId={projectId} />

      {/* Export Dialog */}
      {showExport && (
        <ExportDialog
          projectId={projectId}
          projectName={project.name}
          token={token}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* Type-to-confirm delete dialog */}
      <ConfirmDeleteDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        confirmText={project.name}
        onConfirm={() => deleteMutation.mutate()}
        isDeleting={deleteMutation.isPending}
      />
    </div>
  );
}

// ─── TOKEN / COST SUMMARY CARDS ─────────────────────────────────────

function cardFormatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function TokenUsageSummaryCard({ projectId }: { projectId: string }) {
  const currentProjectId = usePipelineStore((s) => s.currentProjectId);
  const isGenerating = usePipelineStore((s) => s.isGenerating);
  const runUsage = usePipelineActivityStore((s) => s.runUsage);

  // Historical aggregate from API
  const { data: usage } = useQuery<ProjectUsageData>({
    queryKey: ['usage', 'project', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/usage/project/${projectId}`);
      return res.data;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });

  // Prefer live data if pipeline is active for this project
  const isLive = currentProjectId === projectId && isGenerating;
  const liveTotal = runUsage.inputTokens + runUsage.outputTokens;
  const totalTokens = isLive && liveTotal > 0 ? liveTotal : (usage?.total_tokens ?? 0);

  return (
    <Card className="bg-white dark:bg-slate-800">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
          <Zap className="w-4 h-4" />
          <span className="text-xs font-medium">Total Tokens</span>
          {isLive && (
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse ml-auto" />
          )}
        </div>
        <p className={`text-sm font-bold font-mono ${isLive ? 'text-green-600 dark:text-green-400' : 'text-slate-900 dark:text-slate-50'}`}>
          {totalTokens > 0 ? cardFormatTokens(totalTokens) : '—'}
        </p>
        {totalTokens > 0 && (
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-blue-500 flex items-center gap-0.5">
              <ArrowUpRight className="w-2.5 h-2.5" />
              {cardFormatTokens(isLive && liveTotal > 0 ? runUsage.inputTokens : (usage?.total_input_tokens ?? 0))}
            </span>
            <span className="text-[10px] text-emerald-500 flex items-center gap-0.5">
              <ArrowDownRight className="w-2.5 h-2.5" />
              {cardFormatTokens(isLive && liveTotal > 0 ? runUsage.outputTokens : (usage?.total_output_tokens ?? 0))}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CostSummaryCard({ projectId }: { projectId: string }) {
  const currentProjectId = usePipelineStore((s) => s.currentProjectId);
  const isGenerating = usePipelineStore((s) => s.isGenerating);
  const runUsage = usePipelineActivityStore((s) => s.runUsage);

  const { data: usage } = useQuery<ProjectUsageData>({
    queryKey: ['usage', 'project', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/usage/project/${projectId}`);
      return res.data;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });

  const isLive = currentProjectId === projectId && isGenerating;
  const costUsd = isLive && runUsage.cost > 0 ? runUsage.cost : (usage?.total_cost_usd ?? 0);
  const apiCalls = usage?.total_requests ?? 0;

  return (
    <Card className="bg-white dark:bg-slate-800">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-1">
          <Coins className="w-4 h-4" />
          <span className="text-xs font-medium">Est. Cost</span>
          {isLive && (
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse ml-auto" />
          )}
        </div>
        <p className={`text-sm font-bold font-mono ${isLive ? 'text-green-600 dark:text-green-400' : 'text-primary-600 dark:text-primary-400'}`}>
          {costUsd > 0
            ? costUsd < 0.01
              ? `$${costUsd.toFixed(4)}`
              : `$${costUsd.toFixed(2)}`
            : '—'}
        </p>
        {apiCalls > 0 && !isLive && (
          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
            {apiCalls} API call{apiCalls !== 1 ? 's' : ''}
          </p>
        )}
        {isLive && runUsage.cost > 0 && (
          <p className="text-[10px] text-green-500 dark:text-green-400 mt-1 flex items-center gap-1">
            <span className="w-1 h-1 bg-green-500 rounded-full animate-pulse" />
            Tracking live
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── LIVE TOKEN TRACKER ─────────────────────────────────────────────

const LIVE_STAGE_LABELS: Record<string, string> = {
  SCAN: 'Setup & Configuration',
  DECODE: 'Intent Extraction',
  BLUEPRINT: 'Business Capability Mining',
  SPEC_LOCK: 'Behavior Lock-in',
  ARCHITECT: 'Modernization Approach',
  FORGE: 'Co-Create',
  SHADOW_RUN: 'Parallel Run & Cutover',
  EVOLVE: 'Continuous Modernization',
};

function liveFormatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function liveFormatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(4)}`;
}

function liveProviderMeta(model: string): { name: string; color: string } {
  if (model.startsWith('claude')) return { name: 'Anthropic', color: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' };
  if (model.startsWith('gpt') || model.startsWith('o3')) return { name: 'OpenAI', color: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' };
  if (model.startsWith('gemini')) return { name: 'Google', color: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' };
  return { name: 'Other', color: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' };
}

function LiveTokenTracker({ projectId }: { projectId: string }) {
  const currentProjectId = usePipelineStore((s) => s.currentProjectId);
  const isGenerating = usePipelineStore((s) => s.isGenerating);
  const runUsage = usePipelineActivityStore((s) => s.runUsage);
  const runUsageByModel = usePipelineActivityStore((s) => s.runUsageByModel);
  const runUsageByStage = usePipelineActivityStore((s) => s.runUsageByStage);
  const lastUsageEventAt = usePipelineActivityStore((s) => s.lastUsageEventAt);
  const stages = usePipelineStore((s) => s.stages);
  const activeStageIndex = usePipelineStore((s) => s.activeStageIndex);

  // Pulse animation — track recent usage events
  const [isPulsing, setIsPulsing] = useState(false);
  useEffect(() => {
    if (!lastUsageEventAt) return;
    setIsPulsing(true);
    const timer = setTimeout(() => setIsPulsing(false), 1200);
    return () => clearTimeout(timer);
  }, [lastUsageEventAt]);

  // Only show when this project has an active pipeline
  const isActive = currentProjectId === projectId && isGenerating;
  const hasUsage = runUsage.inputTokens > 0 || runUsage.outputTokens > 0;

  // Show the card if pipeline is active OR if there's accumulated run usage for this project
  if (!isActive && !hasUsage) return null;
  if (currentProjectId !== projectId) return null;

  const totalTokens = runUsage.inputTokens + runUsage.outputTokens;
  const inputPct = totalTokens > 0 ? (runUsage.inputTokens / totalTokens) * 100 : 50;
  const activeStage = stages[activeStageIndex];
  const modelEntries = Object.entries(runUsageByModel);
  const stageEntries = Object.entries(runUsageByStage);

  return (
    <Card className={`mb-6 border-2 transition-colors duration-300 ${isActive ? 'border-green-400 dark:border-green-600 bg-green-50/50 dark:bg-green-950/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <div className="relative">
              <Radio className={`w-5 h-5 ${isActive ? 'text-green-500' : 'text-slate-400'}`} />
              {isActive && (
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full animate-ping" />
              )}
            </div>
            {isActive ? 'Live Token Usage' : 'Run Token Usage'}
          </CardTitle>
          <div className="flex items-center gap-2">
            {isActive && activeStage && (
              <Badge className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs animate-pulse">
                {LIVE_STAGE_LABELS[activeStage.name] || activeStage.name}
              </Badge>
            )}
            {!isActive && hasUsage && (
              <Badge variant="outline" className="text-xs">
                Completed
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Live counters */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className={`rounded-lg p-3 transition-all duration-300 ${isPulsing ? 'bg-green-100 dark:bg-green-900/30 scale-[1.02]' : 'bg-[#f9faf9] dark:bg-slate-700/50'}`}>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase tracking-wide">Est. Cost</p>
            <p className={`text-xl font-bold font-mono mt-0.5 transition-colors ${isPulsing ? 'text-green-600 dark:text-green-400' : 'text-primary-600 dark:text-primary-400'}`}>
              {liveFormatCost(runUsage.cost)}
            </p>
          </div>
          <div className={`rounded-lg p-3 transition-all duration-300 ${isPulsing ? 'bg-green-100 dark:bg-green-900/30 scale-[1.02]' : 'bg-[#f9faf9] dark:bg-slate-700/50'}`}>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase tracking-wide">Total Tokens</p>
            <p className={`text-xl font-bold font-mono mt-0.5 transition-colors ${isPulsing ? 'text-green-600 dark:text-green-400' : 'text-slate-900 dark:text-slate-50'}`}>
              {liveFormatTokens(totalTokens)}
            </p>
          </div>
          <div className="bg-[#f9faf9] dark:bg-slate-700/50 rounded-lg p-3">
            <div className="flex items-center gap-1 mb-0.5">
              <ArrowUpRight className="w-3 h-3 text-blue-500" />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase">Input</p>
            </div>
            <p className="text-xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-0.5">
              {liveFormatTokens(runUsage.inputTokens)}
            </p>
          </div>
          <div className="bg-[#f9faf9] dark:bg-slate-700/50 rounded-lg p-3">
            <div className="flex items-center gap-1 mb-0.5">
              <ArrowDownRight className="w-3 h-3 text-emerald-500" />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase">Output</p>
            </div>
            <p className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">
              {liveFormatTokens(runUsage.outputTokens)}
            </p>
          </div>
        </div>

        {/* Input/Output ratio bar */}
        {totalTokens > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 mb-1">
              <span>Input ({inputPct.toFixed(0)}%)</span>
              <span>Output ({(100 - inputPct).toFixed(0)}%)</span>
            </div>
            <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden flex">
              <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${inputPct}%` }} />
              <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${100 - inputPct}%` }} />
            </div>
          </div>
        )}

        {/* Model + Stage breakdown side by side */}
        {(modelEntries.length > 0 || stageEntries.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Per-model live usage */}
            {modelEntries.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-2.5 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-slate-400" />
                  Cost by Model
                </h4>
                <div className="space-y-2">
                  {modelEntries
                    .sort(([, a], [, b]) => b.cost - a.cost)
                    .map(([model, usage]) => {
                      const provider = liveProviderMeta(model);
                      const pct = totalTokens > 0
                        ? ((usage.inputTokens + usage.outputTokens) / totalTokens) * 100
                        : 0;

                      return (
                        <div key={model}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <Badge className={`${provider.color} text-[10px] py-0`}>
                              {provider.name}
                            </Badge>
                            <span className="text-xs text-slate-700 dark:text-slate-300 font-mono truncate">
                              {model}
                            </span>
                            <span className="text-[11px] text-slate-400 dark:text-slate-500 ml-auto shrink-0">
                              {liveFormatTokens(usage.inputTokens + usage.outputTokens)} · {liveFormatCost(usage.cost)}
                            </span>
                          </div>
                          <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                            <div
                              className="bg-primary-500 h-1.5 rounded-full transition-all duration-500"
                              style={{ width: `${Math.max(pct, 2)}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                            {usage.count} call{usage.count !== 1 ? 's' : ''}
                          </p>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Per-stage live usage */}
            {stageEntries.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-2.5 flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-slate-400" />
                  Usage by Stage
                </h4>
                <div className="space-y-2">
                  {stageEntries.map(([stageName, usage]) => {
                    const maxTokens = Math.max(...stageEntries.map(([, u]) => u.inputTokens + u.outputTokens), 1);
                    const stgTokens = usage.inputTokens + usage.outputTokens;
                    const pct = (stgTokens / maxTokens) * 100;
                    const stageLabel = LIVE_STAGE_LABELS[stageName] || stageName;
                    const isCurrentStage = isActive && activeStage?.name === stageName;

                    return (
                      <div key={stageName} className="flex items-center gap-3">
                        <span className={`text-xs min-w-[100px] truncate ${isCurrentStage ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-slate-600 dark:text-slate-400'}`}>
                          {isCurrentStage && <span className="inline-block w-1.5 h-1.5 bg-green-500 rounded-full mr-1 animate-pulse" />}
                          {stageLabel}
                        </span>
                        <div className="flex-1">
                          <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full transition-all duration-500 ${isCurrentStage ? 'bg-green-500' : 'bg-primary-500'}`}
                              style={{ width: `${Math.max(pct, 2)}%` }}
                            />
                          </div>
                        </div>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 min-w-[40px] text-right font-mono">
                          {liveFormatTokens(stgTokens)}
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 min-w-[50px] text-right font-mono">
                          {liveFormatCost(usage.cost)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-4 text-xs text-slate-400 dark:text-slate-500 border-t border-slate-200 dark:border-slate-700 pt-3 mt-4">
          {isActive && (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              Tracking live
            </span>
          )}
          {modelEntries.length > 0 && (
            <span>
              {modelEntries.length} model{modelEntries.length !== 1 ? 's' : ''}
            </span>
          )}
          {stageEntries.length > 0 && (
            <span>
              {stageEntries.length} stage{stageEntries.length !== 1 ? 's' : ''} processed
            </span>
          )}
          <Link href={`/projects/${projectId}/pipeline`} className="ml-auto">
            <Button variant="ghost" size="sm" className="text-xs h-6 px-2 gap-1">
              <Play className="w-3 h-3" />
              Open Pipeline
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── PROJECT TOKEN USAGE ────────────────────────────────────────────

const PROJECT_MODEL_PRICING: Record<string, { input: number; output: number; label: string }> = {
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

function getProjectProviderMeta(model: string): { name: string; color: string } {
  if (model.startsWith('claude')) return { name: 'Anthropic', color: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' };
  if (model.startsWith('gpt') || model.startsWith('o3')) return { name: 'OpenAI', color: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' };
  if (model.startsWith('gemini')) return { name: 'Google', color: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' };
  return { name: 'Other', color: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' };
}

function fmtTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

interface ProjectUsageData {
  project_id: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: Array<{
    model: string;
    count: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  }>;
}

interface StageUsageData {
  project_id: string;
  stages: Array<{
    stage_name: string;
    stage_index: number;
    total_tokens: number;
    total_cost_usd: number;
    request_count: number;
  }>;
}

function ProjectTokenUsage({ projectId }: { projectId: string }) {
  const { data: usage } = useQuery<ProjectUsageData>({
    queryKey: ['usage', 'project', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/usage/project/${projectId}`);
      return res.data;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });

  const { data: stageUsage } = useQuery<StageUsageData>({
    queryKey: ['usage', 'project', projectId, 'stages'],
    queryFn: async () => {
      const res = await apiClient.get(`/usage/project/${projectId}/stages`);
      return res.data;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });

  if (!usage || usage.total_requests === 0) return null;

  const inputPct = usage.total_tokens > 0
    ? (usage.total_input_tokens / usage.total_tokens) * 100
    : 50;

  const maxStageTokens = stageUsage
    ? Math.max(...stageUsage.stages.map((s) => s.total_tokens), 1)
    : 1;

  return (
    <Card className="bg-white dark:bg-slate-800 mb-6">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Coins className="w-5 h-5 text-slate-400" />
          Token Usage & Estimated Cost
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Summary row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          <div className="bg-[#f9faf9] dark:bg-slate-700/50 rounded-lg p-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase">Total Cost</p>
            <p className="text-xl font-bold text-primary-600 dark:text-primary-400 mt-0.5">
              ${usage.total_cost_usd < 0.01 ? '< 0.01' : usage.total_cost_usd.toFixed(2)}
            </p>
          </div>
          <div className="bg-[#f9faf9] dark:bg-slate-700/50 rounded-lg p-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase">Total Tokens</p>
            <p className="text-xl font-bold text-slate-900 dark:text-slate-50 mt-0.5">
              {fmtTokenCount(usage.total_tokens)}
            </p>
          </div>
          <div className="bg-[#f9faf9] dark:bg-slate-700/50 rounded-lg p-3">
            <div className="flex items-center gap-1 mb-0.5">
              <ArrowUpRight className="w-3 h-3 text-blue-500" />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase">Input</p>
            </div>
            <p className="text-xl font-bold text-blue-600 dark:text-blue-400 mt-0.5">
              {fmtTokenCount(usage.total_input_tokens)}
            </p>
          </div>
          <div className="bg-[#f9faf9] dark:bg-slate-700/50 rounded-lg p-3">
            <div className="flex items-center gap-1 mb-0.5">
              <ArrowDownRight className="w-3 h-3 text-emerald-500" />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase">Output</p>
            </div>
            <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
              {fmtTokenCount(usage.total_output_tokens)}
            </p>
          </div>
        </div>

        {/* Input/Output ratio bar */}
        <div className="mb-5">
          <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 mb-1">
            <span>Input ({inputPct.toFixed(0)}%)</span>
            <span>Output ({(100 - inputPct).toFixed(0)}%)</span>
          </div>
          <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden flex">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${inputPct}%` }} />
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${100 - inputPct}%` }} />
          </div>
        </div>

        {/* Model breakdown + Stage usage side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Model breakdown */}
          {usage.by_model.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-slate-400" />
                Cost by Model
              </h4>
              <div className="space-y-2.5">
                {usage.by_model.map((m) => {
                  const provider = getProjectProviderMeta(m.model);
                  const pricing = PROJECT_MODEL_PRICING[m.model];
                  const pct = usage.total_tokens > 0
                    ? ((m.input_tokens + m.output_tokens) / usage.total_tokens) * 100
                    : 0;

                  return (
                    <div key={m.model}>
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge className={`${provider.color} text-[10px] py-0`}>
                          {provider.name}
                        </Badge>
                        <span className="text-xs text-slate-700 dark:text-slate-300 font-mono truncate">
                          {pricing?.label || m.model}
                        </span>
                        <span className="text-[11px] text-slate-400 dark:text-slate-500 ml-auto shrink-0">
                          {fmtTokenCount(m.input_tokens + m.output_tokens)} · ${m.cost.toFixed(4)}
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
                  );
                })}
              </div>
            </div>
          )}

          {/* Stage usage breakdown */}
          {stageUsage && stageUsage.stages.some((s) => s.total_tokens > 0) && (
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-slate-400" />
                Usage by Stage
              </h4>
              <div className="space-y-2">
                {stageUsage.stages.map((stage) => {
                  if (stage.total_tokens === 0) return null;
                  const pct = (stage.total_tokens / maxStageTokens) * 100;
                  const stageLabel = STAGE_LABELS[stage.stage_name] || stage.stage_name;

                  return (
                    <div key={stage.stage_name} className="flex items-center gap-3">
                      <span className="text-xs text-slate-600 dark:text-slate-400 min-w-[100px] truncate">
                        {stageLabel}
                      </span>
                      <div className="flex-1">
                        <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                          <div
                            className="bg-primary-500 h-1.5 rounded-full transition-all"
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 min-w-[40px] text-right">
                        {fmtTokenCount(stage.total_tokens)}
                      </span>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 min-w-[45px] text-right">
                        ${stage.total_cost_usd < 0.01 ? '<.01' : stage.total_cost_usd.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* API calls footer */}
        <div className="flex items-center gap-4 text-xs text-slate-400 dark:text-slate-500 border-t border-slate-200 dark:border-slate-700 pt-3 mt-4">
          <span className="flex items-center gap-1">
            <Cpu className="w-3 h-3" />
            {usage.total_requests} API call{usage.total_requests !== 1 ? 's' : ''}
          </span>
          {usage.by_model.length > 0 && (
            <span>
              {usage.by_model.length} model{usage.by_model.length !== 1 ? 's' : ''} used
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Helper Component ──────────────────────────────────────────────

const DetailRow = memo(function DetailRow({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
        {icon} {label}
      </span>
      <span className="text-slate-900 dark:text-slate-50">{children}</span>
    </div>
  );
});

// ─── PROJECT AUDIT SECTION ─────────────────────────────────────

const AUDIT_STAGE_LABELS: Record<string, string> = {
  SCAN: 'Setup & Configuration', DECODE: 'Intent Extraction',
  BLUEPRINT: 'Business Capability Mining', SPEC_LOCK: 'Behavior Lock-in',
  ARCHITECT: 'Modernization Approach', FORGE: 'Co-Create',
  SHADOW_RUN: 'Parallel Run & Cutover', EVOLVE: 'Continuous Modernization',
};

const AUDIT_ICONS: Record<string, { icon: string; color: string }> = {
  PIPELINE_STARTED: { icon: '🚀', color: 'text-blue-500' },
  STAGE_STARTED: { icon: '⚡', color: 'text-amber-500' },
  STAGE_COMPLETED: { icon: '✅', color: 'text-green-500' },
  STAGE_APPROVED: { icon: '👍', color: 'text-emerald-500' },
  STAGE_REJECTED: { icon: '❌', color: 'text-red-500' },
};

function formatAuditEntry(log: any): { title: string; description: string; icon: string; color: string } {
  const changes = log.changes || {};
  const stageName = changes.stageName as string | undefined;
  const stageLabel = stageName ? (AUDIT_STAGE_LABELS[stageName] || stageName) : '';
  const user = log.user_display || 'System';
  const model = changes.model as string | undefined;
  const comment = changes.comment as string | undefined;
  const evalModel = changes.evaluatorModel as string | undefined;
  const cfg = AUDIT_ICONS[log.action] || { icon: '📋', color: 'text-slate-400' };

  switch (log.action) {
    case 'PIPELINE_STARTED':
      return {
        title: `${user} started a new pipeline run`,
        description: 'Initiated the 8-stage modernization pipeline for this project',
        ...cfg,
      };
    case 'STAGE_STARTED':
      return {
        title: `${user} executed Stage: ${stageLabel}`,
        description: model
          ? `Model: ${model}${evalModel ? ` · Evaluator: ${evalModel}` : ''}`
          : `Started ${stageLabel} analysis`,
        ...cfg,
      };
    case 'STAGE_COMPLETED':
      return {
        title: `Stage ${stageLabel} completed`,
        description: `Output generated and validation run · Ready for review`,
        ...cfg,
      };
    case 'STAGE_APPROVED':
      return {
        title: `${user} approved Stage: ${stageLabel}`,
        description: comment ? `"${comment}"` : 'Approved and advanced to next stage',
        ...cfg,
      };
    case 'STAGE_REJECTED':
      return {
        title: `${user} rejected Stage: ${stageLabel}`,
        description: comment ? `Reason: "${comment}"` : 'Requires revision before proceeding',
        ...cfg,
      };
    default:
      return {
        title: `${log.action.replace(/_/g, ' ')} by ${user}`,
        description: Object.entries(changes).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 40) : v}`).join(' · '),
        ...cfg,
      };
  }
}

function ProjectAuditSection({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery<{ logs: any[] }>({
    queryKey: ['project-audit', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/admin/audit-logs?limit=50`);
      const logs = (res.data?.logs ?? []).filter((l: any) => {
        const changes = l.changes as Record<string, unknown> | null;
        return changes?.projectId === projectId || l.project_name;
      });
      return { logs };
    },
    staleTime: 15_000,
  });

  const logs = data?.logs ?? [];
  if (isLoading) return null;
  if (logs.length === 0) return null;

  return (
    <Card className="bg-white dark:bg-slate-800 mb-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-slate-400" />
            Activity Timeline
          </CardTitle>
          <Badge variant="outline" className="text-xs">{logs.length} events</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[11px] top-2 bottom-2 w-px bg-slate-200 dark:bg-slate-700" />

          <div className="space-y-3">
            {logs.slice(0, 15).map((log: any) => {
              const entry = formatAuditEntry(log);
              return (
                <div key={log.id} className="flex items-start gap-3 relative">
                  {/* Timeline dot */}
                  <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center bg-white dark:bg-slate-800 z-10 ring-2 ring-slate-100 dark:ring-slate-700 text-[10px] shrink-0">
                    {entry.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 pt-0.5">
                    <p className="text-sm text-slate-800 dark:text-slate-200 leading-snug">
                      {entry.title}
                    </p>
                    {entry.description && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                        {entry.description}
                      </p>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="text-[10px] text-slate-400 shrink-0 tabular-nums pt-1">
                    {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
