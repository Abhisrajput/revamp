import { useState, useEffect, useCallback, useRef } from 'react';
import { getApiClient } from '../api/types';

// ─── Types ─────────────────────────────────────────────────────────

export interface AgentPersona {
  id: string;
  name: string;
  persona_name?: string;
  slug?: string;
  version?: string;
  role: string;
  department: string;
  status: 'idle' | 'working' | 'paused' | 'disabled';
  model?: string;
  preferred_model?: string;
  preferred_provider?: string;
  system_prompt?: string;
  // Budget
  budget_monthly_cents: number;
  monthly_budget_cents?: number;
  spent_monthly_cents: number;
  budget_warning_threshold?: number;
  warning_threshold?: number;
  hard_stop_enabled?: boolean;
  // Capabilities
  skills?: Array<{ name: string; proficiency?: string; description?: string }>;
  tool_permissions?: string[];
  stage_permissions?: string[];
  tech_stack?: string[];
  max_concurrent_tasks?: number;
  can_delegate?: boolean;
  memory_strategy?: string;
  // Relations
  reporting_to?: string | null;
  reports_to?: string | null;
  subordinates?: Array<{ id: string; name: string; role: string }>;
  pause_reason?: string | null;
  // Meta
  is_active: boolean;
  created_at: string;
  updated_at?: string;
  organization_id?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSubtask {
  id: string;
  agent_id: string;
  parent_task_id?: string;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'completed' | 'cancelled' | 'failed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  pipeline_run_id?: string;
  stage_name?: string;
  cost_cents?: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  // snake_case fields from API
  created_by_agent_id?: string;
  assigned_agent_id?: string | null;
  // camelCase aliases for component usage
  createdByAgentId?: string;
  assignedAgentId?: string | null;
  stageName?: string;
  costCents?: number;
}

export interface CostEvent {
  id: string;
  agent_id: string;
  amount_cents: number;
  cost_cents?: number;
  description: string;
  created_at: string;
  task_id?: string;
  stage_name?: string;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export interface DelegationTarget {
  id: string;
  name: string;
  slug?: string;
  role: string;
  department: string;
  status: string;
  reporting_to?: string | null;
  subordinates?: DelegationTarget[];
}

export interface AgentDashboard {
  // snake_case (from API)
  total_agents: number;
  active_agents: number;
  total_budget_cents?: number;
  total_spent_cents: number;
  by_department: Record<
    string,
    { count: number; active: number; budget_cents: number; spent_cents: number }
  >;
  // camelCase aliases (normalized by useAgentDashboard)
  totalAgents: number;
  activeAssignments: number;
  totalSpentCents: number;
  byStatus: Record<string, number>;
  byDepartment: Record<
    string,
    { count: number; active: number; budget_cents: number; spent_cents: number }
  >;
  recent_activity?: Array<{
    agent_id: string;
    agent_name: string;
    action: string;
    timestamp: string;
  }>;
}

export interface SessionChainEntry {
  id: string;
  agent_id: string;
  session_index: number;
  summary?: string;
  started_at: string;
  ended_at?: string;
  tasks_count: number;
  cost_cents: number;
  sessionData?: Record<string, unknown> | null;
  compactionSummary?: string | null;
  compacted?: boolean;
  tokenCount?: number;
  createdAt?: string;
}

export type ContextTier = 'L0' | 'L1' | 'L2';

export interface RetrievalStep {
  sourceStage: string;
  tierLoaded: ContextTier;
  tokensConsumed: number;
  reason: 'recent_stage' | 'high_relevance' | 'budget_overflow' | 'skipped_irrelevant' | 'compaction_threshold';
  l0Preview?: string;
  compacted?: boolean;
}

export interface RetrievalTrajectory {
  id: string;
  pipelineRunId: string;
  stageName: string;
  agentId?: string | null;
  totalTokenBudget: number;
  tokensUsed: number;
  trajectory: RetrievalStep[];
  evolutionMemoriesLoaded: number;
  evolutionMemoryIds: string[];
  buildDurationMs: number;
  createdAt: string;
}

export interface EvolutionMemory {
  id: string;
  agent_id: string;
  memory_type: 'skill' | 'preference' | 'context' | 'mistake' | 'success';
  /** Memory category (alias / elaboration of memory_type) */
  category?: string;
  content: string;
  /** Short summary of the content */
  summary?: string;
  /** Which pipeline stage produced this memory */
  sourceStage?: string;
  /** How many times this memory has been retrieved */
  usageCount?: number;
  confidence: number;
  created_at: string;
  /** Alias for created_at (camelCase) */
  createdAt?: string;
  last_accessed?: string;
}

export interface AgentBudgetStatus {
  agentId: string;
  spentCents: number;
  budgetCents: number;
  /** Alias for budgetCents */
  limitCents?: number;
  warningThreshold: number;
  /** Warning threshold as a cents value */
  warningAt?: number;
  isWarning: boolean;
  isExceeded: boolean;
  /** Whether a hard stop is enforced when budget is exceeded */
  hardStop?: boolean;
  percentUsed?: number;
}

export interface EscalatedAssignment {
  id: string;
  agent_id: string;
  task_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  updated_at?: string;
  stage_name?: string;
  error_message?: string;
  agent?: {
    id: string;
    name: string;
    department: string;
    role: string;
  };
}

// ─── Hook factory ──────────────────────────────────────────────────

function useApiData<T>(
  path: string | null,
  defaultValue: T,
): { data: T; isLoading: boolean; error: Error | null; refetch: () => void } {
  const [data, setData] = useState<T>(defaultValue);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(() => {
    if (!path) return;
    setIsLoading(true);
    setError(null);

    getApiClient()
      .get(path)
      .then((res) => {
        if (mountedRef.current) setData(res.data);
      })
      .catch((err: Error) => {
        if (mountedRef.current) setError(err);
      })
      .finally(() => {
        if (mountedRef.current) setIsLoading(false);
      });
  }, [path]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => { mountedRef.current = false; };
  }, [fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}

// ─── Hooks ─────────────────────────────────────────────────────────

interface UseAgentsOptions {
  department?: string;
  role?: string;
  status?: string;
}

export function useAgents(options: UseAgentsOptions = {}) {
  const params = new URLSearchParams();
  if (options.department) params.set('department', options.department);
  if (options.role) params.set('role', options.role);
  if (options.status) params.set('status', options.status);
  const qs = params.toString();
  const path = `/agents${qs ? `?${qs}` : ''}`;
  return useApiData<AgentPersona[]>(path, []);
}

export function useAgent(agentId: string | null, _limit?: number) {
  return useApiData<AgentPersona | null>(agentId ? `/agents/${agentId}` : null, null);
}

export function useAgentCosts(agentId: string | null, limit?: number) {
  const path = agentId
    ? `/agents/${agentId}/costs${limit ? `?limit=${limit}` : ''}`
    : null;
  return useApiData<CostEvent[]>(path, []);
}

export function useAgentDashboard(projectId?: string) {
  const path = projectId ? `/agents/dashboard?project_id=${projectId}` : '/agents/dashboard';
  const result = useApiData<any>(path, null);

  // Normalize API response to camelCase expected by dashboard components
  const raw = result.data;
  const normalized: AgentDashboard | null = raw
    ? {
        ...raw,
        totalAgents: raw.totalAgents ?? raw.total_agents ?? 0,
        activeAssignments: raw.activeAssignments ?? raw.active_agents ?? 0,
        totalSpentCents: raw.totalSpentCents ?? raw.total_spent_cents ?? 0,
        byStatus: raw.byStatus ?? raw.by_status ?? {},
        byDepartment: raw.byDepartment ?? raw.by_department ?? {},
        by_department: raw.by_department ?? raw.byDepartment ?? {},
        total_agents: raw.total_agents ?? raw.totalAgents ?? 0,
        active_agents: raw.active_agents ?? raw.activeAssignments ?? 0,
        total_spent_cents: raw.total_spent_cents ?? raw.totalSpentCents ?? 0,
      }
    : null;

  return { ...result, data: normalized };
}

export function useAgentSessions(agentId: string | null, limit?: number) {
  const path = agentId
    ? `/agents/${agentId}/sessions${limit ? `?limit=${limit}` : ''}`
    : null;
  return useApiData<SessionChainEntry[]>(path, []);
}

export function useAgentReportingChain(agentId: string | null) {
  return useApiData<DelegationTarget[]>(
    agentId ? `/agents/${agentId}/reporting-chain` : null,
    [],
  );
}

export function useAgentSubordinates(agentId: string | null) {
  return useApiData<DelegationTarget[]>(
    agentId ? `/agents/${agentId}/subordinates` : null,
    [],
  );
}

export function useDepartmentTree(projectId?: string) {
  const path = projectId ? `/agents/tree?project_id=${projectId}` : '/agents/tree';
  return useApiData<DelegationTarget[]>(path, []);
}

export function useEvolutionMemories(agentId: string | null, category?: string, limit?: number) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const path = agentId
    ? `/agents/${agentId}/memories${qs ? `?${qs}` : ''}`
    : null;
  return useApiData<EvolutionMemory[]>(path, []);
}

export function useRetrievalTrajectories(pipelineRunId: string | null | undefined) {
  return useApiData<RetrievalTrajectory[]>(
    pipelineRunId ? `/agent-department/trajectories/${pipelineRunId}` : null,
    [],
  );
}

export function useStageTrajectory(pipelineRunId: string | null | undefined, stageName?: string) {
  const path =
    pipelineRunId && stageName
      ? `/agent-department/trajectories/${pipelineRunId}/${stageName}`
      : null;
  return useApiData<RetrievalTrajectory | null>(path, null);
}

export function useAgentBudgetStatus(agentId: string | null) {
  return useApiData<AgentBudgetStatus | null>(
    agentId ? `/agents/${agentId}/budget` : null,
    null,
  );
}

export function useAgentSubtasks(agentIdOrRunId: string | null | undefined) {
  // May be called with an agentId OR a pipeline run ID — both go to the same
  // API endpoint pattern; the server routes based on UUID format.
  return useApiData<AgentSubtask[]>(
    agentIdOrRunId ? `/agents/subtasks?ref=${agentIdOrRunId}` : null,
    [],
  );
}

interface EscalationFilters {
  department?: string;
  status?: string;
}

export function useEscalatedAssignments(
  agentIdOrFilters?: string | null | EscalationFilters,
) {
  let path = '/agents/escalations';

  if (typeof agentIdOrFilters === 'string' && agentIdOrFilters) {
    path = `/agents/${agentIdOrFilters}/escalations`;
  } else if (agentIdOrFilters && typeof agentIdOrFilters === 'object') {
    const params = new URLSearchParams();
    if (agentIdOrFilters.department) params.set('department', agentIdOrFilters.department);
    if (agentIdOrFilters.status) params.set('status', agentIdOrFilters.status);
    const qs = params.toString();
    path = `/agents/escalations${qs ? `?${qs}` : ''}`;
  }

  return useApiData<EscalatedAssignment[]>(path, []);
}

// ─── Mutation hooks ────────────────────────────────────────────────

export function useUpdateAgent() {
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(async (agentId: string, updates: Partial<AgentPersona>) => {
    setIsLoading(true);
    setIsPending(true);
    setError(null);
    try {
      const res = await getApiClient().patch(`/agents/${agentId}`, updates);
      return res.data as AgentPersona;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
      setIsPending(false);
    }
  }, []);

  return { mutate, isLoading, isPending, error };
}

export function useDeleteAgent() {
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(async (agentId: string) => {
    setIsLoading(true);
    setIsPending(true);
    setError(null);
    try {
      await getApiClient().delete(`/agents/${agentId}`);
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
      setIsPending(false);
    }
  }, []);

  return { mutate, isLoading, isPending, error };
}

export function useResumeAgent() {
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const mutate = useCallback(async (agentId: string) => {
    setIsLoading(true);
    setIsPending(true);
    try {
      const res = await getApiClient().post(`/agents/${agentId}/resume`);
      return res.data;
    } finally {
      setIsLoading(false);
      setIsPending(false);
    }
  }, []);

  return { mutate, isLoading, isPending };
}

export function useApproveEscalation() {
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const mutate = useCallback(async (escalationId: string, comment?: string) => {
    setIsLoading(true);
    setIsPending(true);
    try {
      const res = await getApiClient().post(`/agents/escalations/${escalationId}/approve`, {
        comment,
      });
      return res.data;
    } finally {
      setIsLoading(false);
      setIsPending(false);
    }
  }, []);

  return { mutate, isLoading, isPending };
}

interface RejectArgs {
  assignmentId: string;
  reason?: string;
  result?: { rejected: boolean; reason?: string };
}

export function useRejectEscalation() {
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const mutate = useCallback(
    async (argsOrId: string | RejectArgs, reason?: string) => {
      setIsLoading(true);
      setIsPending(true);
      try {
        let escalationId: string;
        let body: Record<string, unknown>;

        if (typeof argsOrId === 'string') {
          escalationId = argsOrId;
          body = { reason };
        } else {
          escalationId = argsOrId.assignmentId;
          body = { reason: argsOrId.reason, result: argsOrId.result };
        }

        const res = await getApiClient().post(`/agents/escalations/${escalationId}/reject`, body);
        return res.data;
      } finally {
        setIsLoading(false);
        setIsPending(false);
      }
    },
    [],
  );

  return { mutate, isLoading, isPending };
}

interface CreateSubtaskPayload {
  title: string;
  description?: string;
  stage_name?: string;
  pipeline_run_id?: string;
  created_by_agent_id?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export function useCreateSubtask() {
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isError, setIsError] = useState(false);

  const mutate = useCallback(async (
    agentIdOrPayload: string | CreateSubtaskPayload,
    task?: { title: string; description?: string },
  ) => {
    setIsLoading(true);
    setIsPending(true);
    setIsSuccess(false);
    setIsError(false);
    try {
      let endpoint: string;
      let body: Record<string, unknown>;

      if (typeof agentIdOrPayload === 'string') {
        endpoint = `/agents/${agentIdOrPayload}/subtasks`;
        body = task ?? {};
      } else {
        // Called with a single payload object — use created_by_agent_id or generic endpoint
        const { created_by_agent_id, ...rest } = agentIdOrPayload;
        endpoint = created_by_agent_id
          ? `/agents/${created_by_agent_id}/subtasks`
          : '/agents/subtasks';
        body = rest;
      }

      const res = await getApiClient().post(endpoint, body);
      setIsSuccess(true);
      return res.data as AgentSubtask;
    } catch (err) {
      setIsError(true);
      throw err;
    } finally {
      setIsLoading(false);
      setIsPending(false);
    }
  }, []);

  return { mutate, isLoading, isPending, isSuccess, isError };
}
