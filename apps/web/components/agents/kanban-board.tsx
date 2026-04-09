'use client';

import { memo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  ArrowUp, ArrowDown, Minus, ExternalLink, MessageSquare,
  Bot, Send, ChevronDown, ChevronRight, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  priority: string;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  issueType: string;
  created: string;
  updated: string;
  storyPoints?: number;
  comments: Array<{ id: string; author: string; body: string; created: string }>;
  url: string;
}

interface JiraBoard {
  columns: Array<{ name: string; statusCategory: string; issues: JiraIssue[] }>;
  total: number;
  projectKey: string;
}

interface JiraStatus {
  connected: boolean;
  projectKey?: string;
  message?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const PRIORITY_CONFIG: Record<string, { icon: typeof ArrowUp; color: string }> = {
  Highest: { icon: ArrowUp, color: 'text-red-500' },
  High: { icon: ArrowUp, color: 'text-orange-500' },
  Medium: { icon: Minus, color: 'text-slate-400' },
  Low: { icon: ArrowDown, color: 'text-blue-400' },
  Lowest: { icon: ArrowDown, color: 'text-slate-300' },
};

const CATEGORY_COLORS: Record<string, string> = {
  new: 'border-t-blue-400',
  indeterminate: 'border-t-amber-400',
  done: 'border-t-emerald-400',
};

const ISSUE_TYPE_COLORS: Record<string, string> = {
  Bug: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  Story: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  Task: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  Epic: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  'Sub-task': 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
};

// ─── Main Component ─────────────────────────────────────────────

export const KanbanBoard = memo(function KanbanBoard() {
  const queryClient = useQueryClient();

  // Check if Jira is configured
  const { data: jiraStatus, isLoading: statusLoading } = useQuery<JiraStatus>({
    queryKey: ['jira-status'],
    queryFn: async () => (await apiClient.get('/jira/status')).data,
    staleTime: 60_000,
    retry: false,
  });

  // Fetch Jira board
  const { data: board, isLoading: boardLoading, refetch } = useQuery<JiraBoard>({
    queryKey: ['jira-board'],
    queryFn: async () => (await apiClient.get('/jira/board')).data,
    staleTime: 15_000,
    enabled: !!jiraStatus?.connected,
  });

  if (statusLoading) {
    return <BoardSkeleton />;
  }

  // Jira not configured — show setup instructions
  if (!jiraStatus?.connected) {
    return <JiraSetupPrompt message={jiraStatus?.message} />;
  }

  if (boardLoading) {
    return <BoardSkeleton />;
  }

  const columns = board?.columns || [];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <JiraLogo />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {board?.projectKey || 'Jira'} Board
            </h2>
            <p className="text-[10px] text-slate-400">{board?.total || 0} issues</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { refetch(); queryClient.invalidateQueries({ queryKey: ['jira-board'] }); }}
          className="text-xs h-7 gap-1"
        >
          <RefreshCw className="w-3 h-3" /> Sync
        </Button>
      </div>

      {/* Columns */}
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {columns.map((col) => (
          <div
            key={col.name}
            className={cn(
              'flex-shrink-0 w-72 flex flex-col rounded-xl bg-slate-50 dark:bg-slate-800/50',
              'border border-slate-200 dark:border-slate-700/50 border-t-2',
              CATEGORY_COLORS[col.statusCategory] || 'border-t-slate-300',
            )}
          >
            {/* Column header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{col.name}</span>
              <span className="text-[10px] font-mono text-slate-400 bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 rounded-full">
                {col.issues.length}
              </span>
            </div>

            {/* Issue cards */}
            <div className="flex-1 p-2 space-y-2 min-h-[120px] max-h-[500px] overflow-y-auto scrollbar-thin">
              {col.issues.map((issue) => (
                <IssueCard key={issue.key} issue={issue} />
              ))}
              {col.issues.length === 0 && (
                <p className="text-[10px] text-slate-400 text-center py-6">No issues</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

// ─── Issue Card ─────────────────────────────────────────────────

function IssueCard({ issue }: { issue: JiraIssue }) {
  const [expanded, setExpanded] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [assigning, setAssigning] = useState(false);
  const queryClient = useQueryClient();

  // Fetch agents for assignment dropdown
  const { data: agents } = useQuery<Array<{ id: string; name: string; role: string; department: string; status: string }>>({
    queryKey: ['jira-agents'],
    queryFn: async () => (await apiClient.get('/jira/agents')).data,
    staleTime: 30_000,
    enabled: assigning,
  });

  const postComment = useMutation({
    mutationFn: async () => {
      return (await apiClient.post(`/jira/issue/${issue.key}/comment`, {
        body: commentText,
        agent_name: 'REVAMP Agent',
      })).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jira-board'] });
      setCommentText('');
      setCommenting(false);
    },
  });

  const assignAgent = useMutation({
    mutationFn: async (agentId: string) => {
      return (await apiClient.post(`/jira/issue/${issue.key}/assign-agent`, { agent_id: agentId })).data;
    },
    onSuccess: (_data: any) => {
      queryClient.invalidateQueries({ queryKey: ['jira-board'] });
      queryClient.invalidateQueries({ queryKey: ['agent-tasks'] });
      setAssigning(false);
      setExpanded(true); // Keep expanded to show progress
    },
  });

  const pri = PRIORITY_CONFIG[issue.priority] || PRIORITY_CONFIG.Medium;
  const PriIcon = pri.icon;

  return (
    <div className={cn(
      'rounded-lg border bg-white dark:bg-slate-800 transition-all duration-150',
      'border-slate-200 dark:border-slate-700/60',
      'hover:shadow-sm hover:border-slate-300 dark:hover:border-slate-600',
    )}>
      {/* Main card — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-3"
      >
        {/* Top row: key + type + priority */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] font-mono font-bold text-primary-600 dark:text-primary-400">
            {issue.key}
          </span>
          <Badge className={cn('text-[8px] px-1 py-0', ISSUE_TYPE_COLORS[issue.issueType] || ISSUE_TYPE_COLORS.Task)}>
            {issue.issueType}
          </Badge>
          <PriIcon className={cn('w-3 h-3 ml-auto', pri.color)} />
          {expanded ? <ChevronDown className="w-3 h-3 text-slate-400" /> : <ChevronRight className="w-3 h-3 text-slate-400" />}
        </div>

        {/* Summary */}
        <p className={cn('text-xs text-slate-800 dark:text-slate-200', !expanded && 'line-clamp-2')}>
          {issue.summary}
        </p>

        {/* Labels */}
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {issue.labels.slice(0, 3).map((l) => (
              <span key={l} className="text-[8px] px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 rounded">
                {l}
              </span>
            ))}
          </div>
        )}

        {/* Agent working indicator */}
        {assignAgent.isSuccess && (
          <div className="flex items-center gap-1.5 mt-2 px-2 py-1 bg-cyan-50 dark:bg-cyan-950/20 rounded text-[10px] text-cyan-600 dark:text-cyan-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            Agent working — check Jira for progress
          </div>
        )}

        {/* Bottom row: assignee + comments + points */}
        <div className="flex items-center gap-2 mt-2 text-[10px] text-slate-400">
          {issue.assignee && (
            <span className="flex items-center gap-1 truncate max-w-[100px]">
              <span className="w-4 h-4 rounded-full bg-sky-500 text-white text-[8px] font-bold flex items-center justify-center shrink-0">
                {issue.assignee.split(' ').map(w => w[0]).join('').slice(0, 2)}
              </span>
              {issue.assignee.split(' ')[0]}
            </span>
          )}
          {issue.comments.length > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare className="w-3 h-3" /> {issue.comments.length}
            </span>
          )}
          {issue.storyPoints != null && (
            <span className="ml-auto font-mono">{issue.storyPoints} SP</span>
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-700/50 px-3 pb-3 pt-2 space-y-3">
          {/* Description */}
          {issue.description && (
            <div>
              <p className="text-[10px] text-slate-400 uppercase mb-1">Description</p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap line-clamp-6">
                {issue.description}
              </p>
            </div>
          )}

          {/* Recent comments */}
          {issue.comments.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-400 uppercase mb-1">
                Comments ({issue.comments.length})
              </p>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {issue.comments.slice(-3).map((c) => (
                  <div key={c.id} className="text-[10px] bg-slate-50 dark:bg-slate-700/30 rounded p-1.5">
                    <span className="font-medium text-slate-700 dark:text-slate-300">{c.author}</span>
                    <span className="text-slate-400 ml-1">
                      {new Date(c.created).toLocaleDateString()}
                    </span>
                    <p className="text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{c.body}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Assign to Agent */}
          {assigning ? (
            <div>
              <p className="text-[10px] text-slate-400 uppercase mb-1.5">Assign to Agent</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {(agents || []).map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => assignAgent.mutate(agent.id)}
                    disabled={assignAgent.isPending}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors',
                      'hover:bg-primary-50 dark:hover:bg-primary-900/20',
                      agent.status === 'paused' && 'opacity-50',
                    )}
                  >
                    <span className={cn(
                      'w-5 h-5 rounded-full text-white text-[8px] font-bold flex items-center justify-center shrink-0',
                      agent.role === 'lead' ? 'bg-sky-600' : agent.role === 'director' ? 'bg-purple-600' : 'bg-slate-500',
                    )}>
                      {agent.name.split(/[\s—]/)[0]?.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-slate-800 dark:text-slate-200 truncate">{agent.name}</p>
                      <p className="text-[9px] text-slate-400">{agent.department} · {agent.role}</p>
                    </div>
                    {agent.status === 'working' && (
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setAssigning(false)}
                className="text-[10px] text-slate-400 hover:text-slate-600 mt-1.5"
              >
                Cancel
              </button>
            </div>
          ) : commenting ? (
            <div className="flex gap-1.5">
              <input
                autoFocus
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && commentText.trim()) postComment.mutate();
                  if (e.key === 'Escape') { setCommenting(false); setCommentText(''); }
                }}
                placeholder="Agent comment..."
                className="flex-1 text-[11px] px-2 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
              />
              <button
                onClick={() => commentText.trim() && postComment.mutate()}
                disabled={postComment.isPending}
                className="p-1.5 rounded bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
              >
                <Send className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={() => setAssigning(true)}
                className="text-[10px] h-6 gap-1"
              >
                <Bot className="w-3 h-3" /> Assign to Agent
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCommenting(true)}
                className="text-[10px] h-6 gap-1"
              >
                <MessageSquare className="w-3 h-3" /> Comment
              </Button>
              <a
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-primary-500 hover:text-primary-600 h-6 px-2"
              >
                <ExternalLink className="w-3 h-3" /> Open in Jira
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Jira Setup Prompt ──────────────────────────────────────────

function JiraSetupPrompt({ message }: { message?: string }) {
  return (
    <Card className="bg-white dark:bg-slate-800 p-8 text-center max-w-lg mx-auto">
      <JiraLogo className="mx-auto mb-4" size={40} />
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-2">
        Connect Jira
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        Pull your Jira board here. Agents will pick up assigned tasks and comment as they work.
      </p>
      <div className="text-left bg-slate-50 dark:bg-slate-900 rounded-lg p-4 font-mono text-xs text-slate-600 dark:text-slate-300 space-y-1">
        <p><span className="text-slate-400"># Add to your .env file:</span></p>
        <p>JIRA_BASE_URL=https://yourteam.atlassian.net</p>
        <p>JIRA_EMAIL=you@company.com</p>
        <p>JIRA_API_TOKEN=your-api-token</p>
        <p>JIRA_PROJECT_KEY=REV</p>
      </div>
      {message && (
        <p className="text-xs text-red-500 mt-3">{message}</p>
      )}
      <p className="text-[10px] text-slate-400 mt-4">
        Get your API token from{' '}
        <a href="https://id.atlassian.net/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" className="text-primary-500 hover:underline">
          Atlassian Account Settings
        </a>
      </p>
    </Card>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function JiraLogo({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M11.53 2c0 5.19 3.87 9.44 8.97 9.97v.06c-5.1.53-8.97 4.78-8.97 9.97 0-5.19-3.87-9.44-8.97-9.97v-.06C7.66 11.44 11.53 7.19 11.53 2z" fill="#2684FF" />
    </svg>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex-shrink-0 w-72 h-64 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
      ))}
    </div>
  );
}
