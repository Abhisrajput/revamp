'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  Plus, Folder, ArrowRight, GitBranch, Cloud, Code2,
  Search, SlidersHorizontal, MoreVertical,
  Trash2, Archive, Copy, CheckCircle2, XCircle,
  LayoutGrid, List,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { apiClient } from '@/lib/api-client';
import { STAGE_DISPLAY_LABELS } from '@revamp/shared-types';

// ─── CONSTANTS ─────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = STAGE_DISPLAY_LABELS;

const STATUS_OPTIONS = ['all', 'active', 'draft', 'in_progress', 'completed', 'paused', 'archived'] as const;
const SORT_OPTIONS = [
  { value: 'created_desc', label: 'Newest First' },
  { value: 'created_asc', label: 'Oldest First' },
  { value: 'name_asc', label: 'Name A-Z' },
  { value: 'name_desc', label: 'Name Z-A' },
  { value: 'stage_desc', label: 'Most Progress' },
] as const;

type SortValue = typeof SORT_OPTIONS[number]['value'];
type StatusFilter = typeof STATUS_OPTIONS[number];

// ─── HELPERS ───────────────────────────────────────────────────────

function getStatusColor(status: string) {
  switch (status) {
    case 'active': case 'in_progress':
      return 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800';
    case 'completed':
      return 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800';
    case 'draft':
      return 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800';
    case 'paused':
      return 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800';
    case 'archived':
      return 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700';
    default:
      return 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'active': case 'in_progress': return <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />;
    case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />;
    case 'draft': return <div className="w-2 h-2 rounded-full bg-yellow-500" />;
    case 'paused': return <div className="w-2 h-2 rounded-full bg-orange-500" />;
    case 'archived': return <XCircle className="w-3.5 h-3.5 text-slate-400" />;
    default: return <div className="w-2 h-2 rounded-full bg-slate-400" />;
  }
}

// ─── PROJECT ACTION MENU ───────────────────────────────────────────

function ProjectActions({
  project,
  onArchive,
  onDuplicate,
  onDelete,
}: {
  project: any;
  onArchive: (id: string) => void;
  onDuplicate: (project: any) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}
        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-50 w-44 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 py-1">
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDuplicate(project); setOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Copy className="w-3.5 h-3.5" />
              Duplicate
            </button>
            <button
              onClick={(e) => {
                e.preventDefault(); e.stopPropagation();
                onArchive(project.id); setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Archive className="w-3.5 h-3.5" />
              {project.status === 'archived' ? 'Unarchive' : 'Archive'}
            </button>
            <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
            <button
              onClick={(e) => {
                e.preventDefault(); e.stopPropagation();
                onDelete(project.id);
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ────────────────────────────────────────────────

export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortValue>('created_desc');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showFilters, setShowFilters] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { data: projects = [], isLoading } = useQuery<any[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const response = await apiClient.get('/projects');
      return response.data;
    },
  });

  // ── Mutations ───────────────────────────────────────────────────

  const archiveMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await apiClient.patch(`/projects/${id}`, {
        status: status === 'archived' ? 'draft' : 'archived',
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/projects/${id}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const duplicateMutation = useMutation({
    mutationFn: async (project: any) => {
      await apiClient.post('/projects', {
        name: `${project.name} (Copy)`,
        description: project.description,
        source_type: project.source_type,
        source_url: project.source_url,
        source_branch: project.source_branch,
        target_stack: project.target_stack,
        target_cloud: project.target_cloud,
        prompt_template_id: project.prompt_template_id,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  // ── Filter & Sort ──────────────────────────────────────────────

  const handleArchive = useCallback((id: string) => {
    const p = projects.find((pr: any) => pr.id === id);
    if (p) archiveMutation.mutate({ id, status: p.status });
  }, [projects, archiveMutation]);

  const handleDelete = useCallback((id: string) => {
    const p = projects.find((pr: any) => pr.id === id);
    setDeleteTarget({ id, name: p?.name || 'this project' });
  }, [projects]);

  const confirmDelete = useCallback(() => {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget.id, {
        onSuccess: () => setDeleteTarget(null),
      });
    }
  }, [deleteTarget, deleteMutation]);

  const handleDuplicate = useCallback((project: any) => {
    duplicateMutation.mutate(project);
  }, [duplicateMutation]);

  const filteredProjects = useMemo(() => {
    let result = [...projects];

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (p: any) =>
          p.name?.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          p.target_stack?.toLowerCase().includes(q) ||
          p.source_url?.toLowerCase().includes(q)
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter((p: any) => p.status === statusFilter);
    }

    // Sort
    result.sort((a: any, b: any) => {
      switch (sortBy) {
        case 'created_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'name_asc':
          return (a.name || '').localeCompare(b.name || '');
        case 'name_desc':
          return (b.name || '').localeCompare(a.name || '');
        case 'stage_desc':
          return (b.current_stage_index ?? 0) - (a.current_stage_index ?? 0);
        case 'created_desc':
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });

    return result;
  }, [projects, search, statusFilter, sortBy]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: projects.length };
    for (const p of projects) {
      counts[p.status] = (counts[p.status] || 0) + 1;
    }
    return counts;
  }, [projects]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-50">Projects</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            {projects.length} project{projects.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <Link href="/projects/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            New Project
          </Button>
        </Link>
      </div>

      {/* Search & Filters */}
      <div className="mb-6 space-y-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search projects by name, description, stack..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <XCircle className="w-4 h-4" />
              </button>
            )}
          </div>

          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2.5 text-sm rounded-lg border transition-colors ${
              showFilters || statusFilter !== 'all'
                ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-300 dark:border-primary-700 text-primary-700 dark:text-primary-400'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters
            {statusFilter !== 'all' && (
              <span className="w-5 h-5 flex items-center justify-center bg-primary-600 text-white text-[10px] font-bold rounded-full">
                1
              </span>
            )}
          </button>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortValue)}
            className="px-3 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-2.5 transition-colors ${viewMode === 'grid' ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-2.5 transition-colors ${viewMode === 'list' ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Filter pills */}
        {showFilters && (
          <div className="flex items-center gap-2 flex-wrap">
            {STATUS_OPTIONS.map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                  statusFilter === status
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-primary-300'
                }`}
              >
                {status === 'all' ? 'All' : status.replace('_', ' ')}
                {statusCounts[status] !== undefined && (
                  <span className="ml-1.5 opacity-70">({statusCounts[status] || 0})</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className={viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6' : 'space-y-3'}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6 animate-pulse">
              <div className="h-5 bg-slate-200 dark:bg-slate-700 rounded w-3/4 mb-4" />
              <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-full mb-6" />
              <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full" />
            </div>
          ))}
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-center py-16">
          <Folder className="w-16 h-16 text-slate-300 dark:text-slate-700 mx-auto mb-4" />
          {search || statusFilter !== 'all' ? (
            <>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-2">
                No matching projects
              </h3>
              <p className="text-slate-600 dark:text-slate-400 mb-6">
                Try adjusting your search or filters
              </p>
              <Button variant="outline" onClick={() => { setSearch(''); setStatusFilter('all'); }}>
                Clear Filters
              </Button>
            </>
          ) : (
            <>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-2">
                No projects yet
              </h3>
              <p className="text-slate-600 dark:text-slate-400 mb-6">
                Create your first project to start modernizing legacy applications
              </p>
              <Link href="/projects/new">
                <Button><Plus className="w-4 h-4 mr-2" />Create Project</Button>
              </Link>
            </>
          )}
        </div>
      ) : viewMode === 'grid' ? (
        /* ── Grid View ─────────────────────────────────────────── */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProjects.map((project: any) => {
            const stageIndex = project.current_stage_index ?? 0;
            const stageName = project.current_stage || 'SCAN';
            const progress = ((stageIndex) / 8) * 100;

            return (
              <Card key={project.id} className="bg-white dark:bg-slate-800 hover:shadow-lg transition-all h-full group relative">
                <div className="absolute top-3 right-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <ProjectActions
                    project={project}
                    onArchive={handleArchive}
                    onDuplicate={handleDuplicate}
                    onDelete={handleDelete}
                  />
                </div>
                <Link href={`/projects/${project.id}`}>
                  <div className="p-6">
                    <div className="flex items-start justify-between mb-3 pr-8">
                      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 line-clamp-1">
                        {project.name}
                      </h3>
                      <Badge className={getStatusColor(project.status)}>
                        {project.status}
                      </Badge>
                    </div>

                    <p className="text-sm text-slate-600 dark:text-slate-400 mb-4 line-clamp-2">
                      {project.description || 'No description'}
                    </p>

                    <div className="flex items-center gap-3 mb-4 text-xs text-slate-500 dark:text-slate-400">
                      {project.source_type && (
                        <span className="flex items-center gap-1">
                          <GitBranch className="w-3 h-3" />
                          {project.source_type}
                        </span>
                      )}
                      {project.target_cloud && (
                        <span className="flex items-center gap-1">
                          <Cloud className="w-3 h-3" />
                          {project.target_cloud.toUpperCase()}
                        </span>
                      )}
                      {project.target_stack && (
                        <span className="flex items-center gap-1">
                          <Code2 className="w-3 h-3" />
                          {project.target_stack}
                        </span>
                      )}
                    </div>

                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                          {STAGE_LABELS[stageName] || stageName}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          {stageIndex + 1}/8
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                        <div
                          className="bg-primary-600 dark:bg-primary-500 h-1.5 rounded-full transition-all"
                          style={{ width: `${Math.max(progress, 5)}%` }}
                        />
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span>Created {new Date(project.created_at).toLocaleDateString()}</span>
                      <ArrowRight className="w-4 h-4" />
                    </div>
                  </div>
                </Link>
              </Card>
            );
          })}
        </div>
      ) : (
        /* ── List View ─────────────────────────────────────────── */
        <div className="space-y-2">
          {filteredProjects.map((project: any) => {
            const stageIndex = project.current_stage_index ?? 0;
            const progress = ((stageIndex) / 8) * 100;

            return (
              <Card key={project.id} className="bg-white dark:bg-slate-800 hover:shadow-md transition-all group">
                <Link href={`/projects/${project.id}`}>
                  <div className="flex items-center gap-4 p-4">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(project.status)}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 truncate">
                          {project.name}
                        </h3>
                        <Badge className={`${getStatusColor(project.status)} text-[10px] px-1.5 py-0`}>
                          {project.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                        {project.description || 'No description'}
                      </p>
                    </div>

                    <div className="hidden md:flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                      {project.source_type && (
                        <span className="flex items-center gap-1">
                          <GitBranch className="w-3 h-3" />
                          {project.source_type}
                        </span>
                      )}
                      {project.target_stack && (
                        <span className="flex items-center gap-1">
                          <Code2 className="w-3 h-3" />
                          {project.target_stack}
                        </span>
                      )}
                    </div>

                    <div className="hidden lg:flex items-center gap-2 w-32">
                      <div className="flex-1 bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                        <div
                          className="bg-primary-600 dark:bg-primary-500 h-1.5 rounded-full"
                          style={{ width: `${Math.max(progress, 5)}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums w-8">
                        {stageIndex + 1}/8
                      </span>
                    </div>

                    <span className="text-xs text-slate-400 dark:text-slate-500 hidden sm:block w-24 text-right">
                      {new Date(project.created_at).toLocaleDateString()}
                    </span>

                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <ProjectActions
                        project={project}
                        onArchive={handleArchive}
                        onDuplicate={handleDuplicate}
                        onDelete={handleDelete}
                      />
                    </div>
                  </div>
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      {/* Results count */}
      {!isLoading && filteredProjects.length > 0 && (search || statusFilter !== 'all') && (
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4 text-center">
          Showing {filteredProjects.length} of {projects.length} projects
        </p>
      )}

      {/* Type-to-confirm delete dialog */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        confirmText={deleteTarget?.name || ''}
        onConfirm={confirmDelete}
        isDeleting={deleteMutation.isPending}
      />
    </div>
  );
}
