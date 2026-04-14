import { useState, useEffect, useCallback, useRef } from 'react';
import { getApiClient } from '../api/types';

// ─── Types ─────────────────────────────────────────────────────────

export type OrchestratorState = 'idle' | 'running' | 'paused' | 'stopped' | 'error';
export type ActivityPeriod = '1h' | '24h' | '7d';

export interface AgentOrchestratorState {
  id: string;
  name: string;
  slug?: string;
  role: string;
  department: string;
  status: 'idle' | 'working' | 'paused' | 'disabled';
  currentTask?: string;
  tasksCompleted: number;
  tasksFailed?: number;
  costCentsToday: number;
  tokensUsed?: number;
  /** Current task progress 0-100 */
  progress?: number;
  totalCostCents?: number;
  lastActiveAt?: string | null;
}

export interface OrchestratorStats {
  totalAgents: number;
  activeAgents: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksQueued?: number;
  totalCostCents: number;
  avgTaskDurationMs: number;
  escalations: number;
  totalLLMCalls?: number;
  totalTokens?: number;
  runtimeSeconds?: number;
  periodLabel?: string;
}

export interface ExecutionLogEntry {
  id: string;
  agentId: string;
  agentName: string;
  department?: string;
  action: string;
  details: string;
  /** Alias for details */
  detail?: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
}

export interface TaskQueueItem {
  id: string;
  title: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'queued' | 'running' | 'in_progress' | 'dispatching' | 'completed' | 'failed';
  assignedAgentId?: string;
  assignedAgentName?: string;
  /** Assigned agent object (if expanded by API) */
  assignedAgent?: { id: string; name: string; department?: string } | null;
  stage?: string;
  progress?: number;
  tokensUsed?: number;
  costCents?: number;
  createdAt: string;
}

export interface UseOrchestratorReturn {
  /** Current orchestrator operational state */
  state: OrchestratorState;
  /** Alias for state (backward compat) */
  orchestratorState: OrchestratorState;
  /** Agent states visible to the orchestrator */
  agentStates: AgentOrchestratorState[];
  /** Alias for agentStates */
  agents: AgentOrchestratorState[];
  stats: OrchestratorStats;
  executionLog: ExecutionLogEntry[];
  taskQueue: TaskQueueItem[];
  period: ActivityPeriod;
  isLoading: boolean;
  /** Whether SSE/WS is connected */
  connected: boolean;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
  setPeriod: (period: ActivityPeriod) => void;
  streamCompletion: (prompt: string) => Promise<string>;
  isStreaming: boolean;
}

const DEFAULT_STATS: OrchestratorStats = {
  totalAgents: 0,
  activeAgents: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  totalCostCents: 0,
  avgTaskDurationMs: 0,
  escalations: 0,
};

export function useOrchestrator(): UseOrchestratorReturn {
  const [orchestratorState, setOrchestratorState] = useState<OrchestratorState>('idle');
  const [agentStates, setAgentStates] = useState<AgentOrchestratorState[]>([]);
  const [stats, setStats] = useState<OrchestratorStats>(DEFAULT_STATS);
  const [executionLog, setExecutionLog] = useState<ExecutionLogEntry[]>([]);
  const [taskQueue, setTaskQueue] = useState<TaskQueueItem[]>([]);
  const [period, setPeriod] = useState<ActivityPeriod>('24h');
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    Promise.all([
      getApiClient().get('/agents/orchestrator/status').catch(() => null),
      getApiClient().get(`/agents/orchestrator/stats?period=${period}`).catch(() => null),
      getApiClient().get('/agents/orchestrator/queue').catch(() => null),
      getApiClient().get('/agents/orchestrator/log').catch(() => null),
      getApiClient().get('/agents?orchestrator=true').catch(() => null),
    ]).then(([statusRes, statsRes, queueRes, logRes, agentsRes]) => {
      if (cancelled || !mountedRef.current) return;

      if (statusRes?.data) {
        setOrchestratorState(statusRes.data.state ?? 'idle');
        setConnected(statusRes.data.connected ?? false);
      }
      if (statsRes?.data) setStats({ ...DEFAULT_STATS, ...statsRes.data });
      if (queueRes?.data) setTaskQueue(Array.isArray(queueRes.data) ? queueRes.data : []);
      if (logRes?.data) setExecutionLog(Array.isArray(logRes.data) ? logRes.data : []);
      if (agentsRes?.data) {
        const list = Array.isArray(agentsRes.data) ? agentsRes.data : [];
        setAgentStates(
          list.map((a: any) => ({
            id: a.id,
            name: a.name ?? a.persona_name ?? 'Agent',
            role: a.role ?? 'specialist',
            department: a.department ?? 'execution',
            status: a.status ?? 'idle',
            currentTask: a.current_task,
            tasksCompleted: a.tasks_completed ?? 0,
            costCentsToday: a.cost_cents_today ?? 0,
          })),
        );
      }

      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [period]);

  const start = useCallback(async () => {
    await getApiClient().post('/agents/orchestrator/start').catch(() => null);
    setOrchestratorState('running');
  }, []);

  const pause = useCallback(async () => {
    await getApiClient().post('/agents/orchestrator/pause').catch(() => null);
    setOrchestratorState('paused');
  }, []);

  const stop = useCallback(async () => {
    await getApiClient().post('/agents/orchestrator/stop').catch(() => null);
    setOrchestratorState('stopped');
  }, []);

  const reset = useCallback(async () => {
    await getApiClient().post('/agents/orchestrator/reset').catch(() => null);
    setOrchestratorState('idle');
    setExecutionLog([]);
    setTaskQueue([]);
  }, []);

  const streamCompletion = useCallback(async (prompt: string): Promise<string> => {
    setIsStreaming(true);
    try {
      const res = await getApiClient().post('/agents/orchestrator/complete', { prompt });
      return res.data?.text ?? res.data?.content ?? '';
    } finally {
      if (mountedRef.current) setIsStreaming(false);
    }
  }, []);

  return {
    state: orchestratorState,
    orchestratorState,
    agentStates,
    agents: agentStates,
    stats,
    executionLog,
    taskQueue,
    period,
    isLoading,
    connected,
    start,
    pause,
    stop,
    reset,
    setPeriod,
    streamCompletion,
    isStreaming,
  };
}
