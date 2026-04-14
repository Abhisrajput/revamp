

import { useState, useEffect, useRef } from 'react';
import { getWSManager } from '../api/ws';
import type { WSEvent } from '../api/ws';

// ─── Types ─────────────────────────────────────────────────────────

export type AgentEventType =
  | 'agent.task_started'
  | 'agent.task_assigned'
  | 'agent.task_completed'
  | 'agent.task_failed'
  | 'agent.task_escalated'
  | 'agent.budget_warning'
  | 'agent.budget_exceeded'
  | 'agent.status_changed'
  | 'agent.memory_updated'
  | 'agent.delegated'
  | 'agent.message'
  | 'agent.error';

export interface AgentEvent {
  id: string;
  agentId: string;
  agentName: string;
  eventType: AgentEventType;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface UseAgentEventsOptions {
  maxEvents?: number;
  agentId?: string;
}

export interface UseAgentEventsReturn {
  events: AgentEvent[];
  lastEvent: AgentEvent | null;
  isConnected: boolean;
  connected: boolean;
}

// ─── Hook ──────────────────────────────────────────────────────────

export function useAgentEvents(
  agentIdOrOptions?: string | UseAgentEventsOptions,
  options?: UseAgentEventsOptions,
): UseAgentEventsReturn {
  let agentId: string | undefined;
  let opts: UseAgentEventsOptions = {};

  if (typeof agentIdOrOptions === 'string') {
    agentId = agentIdOrOptions;
    opts = options ?? {};
  } else if (agentIdOrOptions && typeof agentIdOrOptions === 'object') {
    opts = agentIdOrOptions;
    agentId = agentIdOrOptions.agentId;
  }

  const maxEvents = opts.maxEvents ?? 50;

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<AgentEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const topic = agentId ? `agent:${agentId}` : 'agent:events';

    const unsubscribe = getWSManager().subscribe(topic, (wsEvent: WSEvent) => {
      if (!mountedRef.current) return;

      const raw = wsEvent.data as Record<string, unknown>;
      const agentEvent: AgentEvent = {
        id: (raw.id as string) ?? crypto.randomUUID(),
        agentId: (raw.agentId as string) ?? (raw.agent_id as string) ?? '',
        agentName: (raw.agentName as string) ?? (raw.agent_name as string) ?? 'Agent',
        eventType: (wsEvent.event as AgentEventType) ?? (raw.eventType as AgentEventType) ?? 'agent.message',
        data: (raw.data as Record<string, unknown>) ?? raw,
        timestamp: (raw.timestamp as string) ?? new Date().toISOString(),
      };

      setEvents((prev) => [agentEvent, ...prev].slice(0, maxEvents));
      setLastEvent(agentEvent);
    });

    const unsubConn = getWSManager().onConnectionChange((connected) => {
      if (mountedRef.current) setIsConnected(connected);
    });
    setIsConnected(getWSManager().isConnected());

    return () => {
      mountedRef.current = false;
      unsubscribe();
      unsubConn();
    };
  }, [agentId, maxEvents]);

  return { events, lastEvent, isConnected, connected: isConnected };
}
