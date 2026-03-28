/**
 * Agent Message Bus — pub/sub for subtask outputs within a pipeline run.
 *
 * Implements the Watch/Subscribe pattern from MetaGPT:
 *   - Agents subscribe ("watch") specific subtask types
 *   - When a subtask completes, its output is published to the bus
 *   - Watching agents receive relevant outputs as context for their own work
 *
 * This replaces manual context-threading (formatPriorFindings) with an
 * explicit, declarative subscription model. Each agent declares what it
 * cares about, and the bus delivers only that.
 *
 * The bus is per-pipeline-run and lives in memory (no DB persistence needed
 * since it only exists for the duration of a single pipeline execution).
 */

// ─── TYPES ──────────────────────────────────────────────────────

export interface SubtaskMessage {
  subtaskId: string;
  type: string;
  agentId: string;
  agentName: string;
  output: string;
  /** Review score from quality review (0.0-1.0), if reviewed */
  reviewScore?: number;
  /** Structured findings extracted from the output */
  findings?: string[];
  timestamp: string;
}

/**
 * Default watch rules: which subtask types an agent cares about based on
 * its own subtask type. Later subtasks watch earlier ones for context.
 *
 * The Director can override these when planning (via subtask metadata),
 * but these defaults ensure sensible context flow without configuration.
 */
const DEFAULT_WATCHES: Record<string, string[]> = {
  "architecture-analysis": [],                          // first subtask — no deps
  "tech-stack-deepdive": ["architecture-analysis"],     // needs component map
  "legacy-patterns": ["architecture-analysis", "tech-stack-deepdive"],
  "data-layer": ["architecture-analysis"],
  "security-scan": ["architecture-analysis", "tech-stack-deepdive", "data-layer"],
  "business-capabilities": ["architecture-analysis", "legacy-patterns"],
};

// ─── MESSAGE BUS ────────────────────────────────────────────────

export class PipelineMessageBus {
  private pipelineRunId: string;
  private messages: Map<string, SubtaskMessage> = new Map(); // subtaskType → latest message
  private watches: Map<string, Set<string>> = new Map();     // subtaskType → watched types
  private customWatches: Map<string, Set<string>> = new Map(); // agentId → custom watches

  constructor(pipelineRunId: string) {
    this.pipelineRunId = pipelineRunId;
  }

  /**
   * Register what a subtask type watches (uses defaults + optional overrides).
   */
  registerSubtaskWatches(subtaskType: string, additionalWatches?: string[]): void {
    const defaultWatches = DEFAULT_WATCHES[subtaskType] || [];
    const allWatches = new Set([...defaultWatches, ...(additionalWatches || [])]);
    this.watches.set(subtaskType, allWatches);
  }

  /**
   * Register custom watches for a specific agent (overrides defaults).
   */
  registerAgentWatches(agentId: string, watchedTypes: string[]): void {
    this.customWatches.set(agentId, new Set(watchedTypes));
  }

  /**
   * Publish a subtask's output to the bus.
   */
  publish(message: SubtaskMessage): void {
    this.messages.set(message.type, message);
  }

  /**
   * Get all messages that a subtask type watches.
   * Returns messages from completed subtasks that this type depends on.
   */
  getWatchedMessages(subtaskType: string): SubtaskMessage[] {
    const watched = this.watches.get(subtaskType) || DEFAULT_WATCHES[subtaskType] || [];
    const result: SubtaskMessage[] = [];

    for (const watchedType of watched) {
      const msg = this.messages.get(watchedType);
      if (msg) result.push(msg);
    }

    return result;
  }

  /**
   * Get messages for a specific agent (uses custom watches if set).
   */
  getAgentMessages(agentId: string, subtaskType: string): SubtaskMessage[] {
    const custom = this.customWatches.get(agentId);
    if (custom) {
      const result: SubtaskMessage[] = [];
      for (const watchedType of custom) {
        const msg = this.messages.get(watchedType);
        if (msg) result.push(msg);
      }
      return result;
    }
    return this.getWatchedMessages(subtaskType);
  }

  /**
   * Build a context string from watched messages for prompt injection.
   * Replaces the old `formatPriorFindings()` function.
   *
   * @param subtaskType The current subtask type (to determine what it watches)
   * @param maxChars Maximum characters to include (older messages get truncated first)
   */
  buildContextForSubtask(subtaskType: string, maxChars = 6000): string {
    const messages = this.getWatchedMessages(subtaskType);

    if (messages.length === 0) return "";

    const parts: string[] = [];
    let totalChars = 0;

    // Most recent messages get full allocation; older ones get truncated
    const perMessageBudget = Math.floor(maxChars / messages.length);

    for (const msg of messages) {
      const header = `--- ${msg.type} (by ${msg.agentName}) ---`;
      const content = msg.output.length > perMessageBudget
        ? msg.output.slice(0, perMessageBudget) + "\n[... truncated ...]"
        : msg.output;

      const block = `${header}\n${content}`;
      totalChars += block.length;

      if (totalChars > maxChars) break;
      parts.push(block);
    }

    return parts.length > 0
      ? `## Prior Specialist Findings (via watch subscriptions)\n\n${parts.join("\n\n")}`
      : "";
  }

  /**
   * Get all published messages (for composition).
   */
  getAllMessages(): SubtaskMessage[] {
    return Array.from(this.messages.values());
  }

  /**
   * Get the count of published messages.
   */
  get size(): number {
    return this.messages.size;
  }

  /**
   * Clear the bus (called after pipeline completes).
   */
  clear(): void {
    this.messages.clear();
    this.watches.clear();
    this.customWatches.clear();
  }
}
