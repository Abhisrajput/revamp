

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../stores/auth-store';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

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
  /** Max events to keep in memory (default: 50) */
  maxEvents?: number;
  /** Filter events to this agent ID */
  agentId?: string;
}

export interface UseAgentEventsReturn {
  events: AgentEvent[];
  lastEvent: AgentEvent | null;
  isConnected: boolean;
  /** Alias for isConnected */
  connected: boolean;
}

// ─── Hook ──────────────────────────────────────────────────────────

export function useAgentEvents(
  agentIdOrOptions?: string | UseAgentEventsOptions,
  options?: UseAgentEventsOptions,
): UseAgentEventsReturn {
  // Overloaded: can be called as:
  //   useAgentEvents(agentId)
  //   useAgentEvents({ maxEvents, agentId })
  //   useAgentEvents(agentId, { maxEvents })
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

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const token = useAuthStore.getState().token;
    const path = agentId
      ? `/agents/${agentId}/events`
      : '/agents/events';
    const url = `${BASE_URL}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (mountedRef.current) setIsConnected(true);
    };

    es.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const raw = JSON.parse(event.data);
        const agentEvent: AgentEvent = {
          id: raw.id ?? crypto.randomUUID(),
          agentId: raw.agentId ?? raw.agent_id ?? '',
          agentName: raw.agentName ?? raw.agent_name ?? 'Agent',
          eventType: raw.eventType ?? raw.event_type ?? 'agent.message',
          data: raw.data ?? {},
          timestamp: raw.timestamp ?? new Date().toISOString(),
        };
        setEvents((prev: AgentEvent[]) => [agentEvent, ...prev].slice(0, maxEvents));
        setLastEvent(agentEvent);
      } catch {
        // non-JSON message — ignore
      }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      es.close();
      // Reconnect after 5 seconds
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, 5000);
    };
  }, [agentId, maxEvents]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (esRef.current) {
        esRef.current.onmessage = null;
        esRef.current.onerror = null;
        esRef.current.close();
      }
    };
  }, [connect]);

  return { events, lastEvent, isConnected, connected: isConnected };
}
