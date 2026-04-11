/**
 * Pipeline Event Bus — typed internal event system for pipeline orchestration.
 *
 * Inspired by Paperclip's plugin event bus pattern. Decouples pipeline stage
 * transitions from direct function calls using a typed publish/subscribe model.
 *
 * Key features:
 *   - Typed events with discriminated union payloads
 *   - Namespace isolation (pipeline.*, stage.*, subtask.*, validation.*, memory.*)
 *   - Sync + async handlers (async handlers don't block emission)
 *   - Priority ordering (higher priority handlers run first)
 *   - Error isolation (one handler failure doesn't break others)
 *   - WebSocket bridge (auto-forwards selected events to agent-events WS)
 *
 * This complements (not replaces) agent-events.ts — that module handles
 * WS broadcasting to the frontend. This module handles internal orchestration
 * decoupling.
 */

// ─── EVENT TYPE DEFINITIONS ──────────────────────────────────────

export type PipelineEventType =
  // Pipeline lifecycle
  | "pipeline.created"
  | "pipeline.started"
  | "pipeline.completed"
  | "pipeline.failed"
  | "pipeline.cancelled"
  | "pipeline.budget_warning"
  | "pipeline.budget_exceeded"
  // Stage lifecycle
  | "stage.started"
  | "stage.completed"
  | "stage.failed"
  | "stage.skipped"
  | "stage.needs_review"
  // Subtask lifecycle
  | "subtask.created"
  | "subtask.started"
  | "subtask.completed"
  | "subtask.failed"
  | "subtask.reviewed"
  // Validation events
  | "validation.passed"
  | "validation.failed"
  | "validation.hard_gate_blocked"
  | "validation.refinement_started"
  // Memory/learning events
  | "memory.extracted"
  | "memory.context_loaded"
  | "memory.compaction_triggered";

export interface PipelineEvent {
  type: PipelineEventType;
  timestamp: string;
  pipelineRunId: string;
  projectId?: string;
  stageName?: string;
  data: Record<string, unknown>;
}

// ─── HANDLER TYPES ───────────────────────────────────────────────

export type EventHandler = (event: PipelineEvent) => void | Promise<void>;

interface HandlerEntry {
  handler: EventHandler;
  /** Higher priority = earlier execution. Default: 0 */
  priority: number;
  /** Namespace filter — handler only receives events matching this prefix */
  namespace?: string;
  /** One-shot handler — automatically removed after first invocation */
  once?: boolean;
  /** Handler ID for removal */
  id: string;
}

// ─── EVENT BUS ───────────────────────────────────────────────────

class PipelineEventBus {
  private handlers: HandlerEntry[] = [];
  private handlerIdCounter = 0;
  private eventLog: PipelineEvent[] = [];
  private maxLogSize = 500;

  /**
   * Subscribe to pipeline events.
   *
   * @param namespace - Event type prefix filter (e.g., "stage." receives all stage events)
   * @param handler - Callback function
   * @param options - Priority and one-shot configuration
   * @returns Handler ID for later removal
   */
  on(
    namespace: string,
    handler: EventHandler,
    options?: { priority?: number; once?: boolean },
  ): string {
    const id = `handler_${++this.handlerIdCounter}`;
    this.handlers.push({
      handler,
      priority: options?.priority ?? 0,
      namespace,
      once: options?.once ?? false,
      id,
    });

    // Keep sorted by priority (descending — highest priority first)
    this.handlers.sort((a, b) => b.priority - a.priority);
    return id;
  }

  /**
   * Subscribe to a single event occurrence, then auto-unsubscribe.
   */
  once(namespace: string, handler: EventHandler, priority?: number): string {
    return this.on(namespace, handler, { priority, once: true });
  }

  /**
   * Remove a handler by ID.
   */
  off(handlerId: string): void {
    this.handlers = this.handlers.filter((h) => h.id !== handlerId);
  }

  /**
   * Remove all handlers for a namespace.
   */
  offAll(namespace: string): void {
    this.handlers = this.handlers.filter((h) => h.namespace !== namespace);
  }

  /**
   * Emit an event to all matching handlers.
   *
   * Handlers are called in priority order. Async handlers are awaited
   * but errors in one handler don't prevent others from executing.
   */
  async emit(event: PipelineEvent): Promise<void> {
    // Log the event
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }

    const toRemove: string[] = [];

    for (const entry of this.handlers) {
      // Namespace matching: "stage." matches "stage.completed", "stage.failed", etc.
      // "*" or empty string matches everything.
      if (entry.namespace && entry.namespace !== "*" && !event.type.startsWith(entry.namespace)) {
        continue;
      }

      try {
        const result = entry.handler(event);
        // Await promises but don't let them block other handlers
        if (result && typeof (result as any).then === "function") {
          await (result as Promise<void>).catch((err) => {
            console.warn(`[EventBus] Async handler ${entry.id} failed:`, err);
          });
        }
      } catch (err) {
        console.warn(`[EventBus] Handler ${entry.id} threw:`, err);
      }

      if (entry.once) {
        toRemove.push(entry.id);
      }
    }

    // Clean up one-shot handlers
    if (toRemove.length > 0) {
      this.handlers = this.handlers.filter((h) => !toRemove.includes(h.id));
    }
  }

  /**
   * Fire-and-forget emission — doesn't await async handlers.
   * Use for non-critical events where you don't want to block the caller.
   */
  fire(event: PipelineEvent): void {
    this.emit(event).catch((err) => {
      console.error(`[EventBus] fire(${event.type}) failed:`, err instanceof Error ? err.message : err);
    });
  }

  /**
   * Get recent events from the log, optionally filtered by type prefix.
   */
  getRecentEvents(namespace?: string, limit: number = 50): PipelineEvent[] {
    const filtered = namespace
      ? this.eventLog.filter((e) => e.type.startsWith(namespace))
      : this.eventLog;

    return filtered.slice(-limit);
  }

  /**
   * Get the count of registered handlers.
   */
  handlerCount(): number {
    return this.handlers.length;
  }

  /**
   * Clear all handlers and event log. Used in testing.
   */
  reset(): void {
    this.handlers = [];
    this.eventLog = [];
    this.handlerIdCounter = 0;
  }
}

// ─── SINGLETON INSTANCE ──────────────────────────────────────────

export const pipelineEventBus = new PipelineEventBus();

// ─── CONVENIENCE EMITTERS ────────────────────────────────────────

export function emitStageCompleted(params: {
  pipelineRunId: string;
  projectId: string;
  stageName: string;
  duration: number;
  confidenceScore?: number;
}): void {
  pipelineEventBus.fire({
    type: "stage.completed",
    timestamp: new Date().toISOString(),
    pipelineRunId: params.pipelineRunId,
    projectId: params.projectId,
    stageName: params.stageName,
    data: {
      duration: params.duration,
      confidenceScore: params.confidenceScore,
    },
  });
}

export function emitStageFailed(params: {
  pipelineRunId: string;
  projectId: string;
  stageName: string;
  error: string;
}): void {
  pipelineEventBus.fire({
    type: "stage.failed",
    timestamp: new Date().toISOString(),
    pipelineRunId: params.pipelineRunId,
    projectId: params.projectId,
    stageName: params.stageName,
    data: { error: params.error },
  });
}

export function emitValidationFailed(params: {
  pipelineRunId: string;
  projectId: string;
  stageName: string;
  violations: number;
  hardGated: boolean;
}): void {
  pipelineEventBus.fire({
    type: params.hardGated ? "validation.hard_gate_blocked" : "validation.failed",
    timestamp: new Date().toISOString(),
    pipelineRunId: params.pipelineRunId,
    projectId: params.projectId,
    stageName: params.stageName,
    data: { violations: params.violations, hardGated: params.hardGated },
  });
}

export function emitMemoryExtracted(params: {
  pipelineRunId: string;
  projectId: string;
  stageName: string;
  memoriesStored: number;
  method: string;
}): void {
  pipelineEventBus.fire({
    type: "memory.extracted",
    timestamp: new Date().toISOString(),
    pipelineRunId: params.pipelineRunId,
    projectId: params.projectId,
    stageName: params.stageName,
    data: { memoriesStored: params.memoriesStored, method: params.method },
  });
}

export function emitSubtaskReviewed(params: {
  pipelineRunId: string;
  stageName: string;
  subtaskId: string;
  verdict: string;
  score: number;
}): void {
  pipelineEventBus.fire({
    type: "subtask.reviewed",
    timestamp: new Date().toISOString(),
    pipelineRunId: params.pipelineRunId,
    stageName: params.stageName,
    data: {
      subtaskId: params.subtaskId,
      verdict: params.verdict,
      score: params.score,
    },
  });
}

export function emitPipelineBudgetWarning(params: {
  pipelineRunId: string;
  projectId: string;
  usedCents: number;
  budgetCents: number;
  percentUsed: number;
}): void {
  pipelineEventBus.fire({
    type: "pipeline.budget_warning",
    timestamp: new Date().toISOString(),
    pipelineRunId: params.pipelineRunId,
    projectId: params.projectId,
    data: {
      usedCents: params.usedCents,
      budgetCents: params.budgetCents,
      percentUsed: params.percentUsed,
    },
  });
}
