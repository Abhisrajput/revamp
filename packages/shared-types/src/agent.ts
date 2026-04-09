/**
 * Agent Department — Canonical type definitions shared across API, web, and core-engine.
 *
 * These types define the Agent Department system: persona identities, hierarchical
 * delegation, atomic task checkout, immutable cost tracking, and budget enforcement.
 */

// ─── ENUMS ─────────────────────────────────────────────────────

export type AgentRole = 'director' | 'lead' | 'specialist';

export type AgentDepartment = 'discovery' | 'execution' | 'qa' | 'pm';

export type AgentStatus = 'idle' | 'working' | 'paused' | 'disabled';

export type AssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'failed' | 'escalated';

export type SubtaskStatus = 'backlog' | 'assigned' | 'in_progress' | 'completed' | 'failed';

export type SkillCategory =
  | 'legacy-analysis'
  | 'architecture'
  | 'code-transformation'
  | 'testing'
  | 'data-migration'
  | 'devops'
  | 'documentation'
  | 'project-management'
  | 'security';

export type ToolPermission =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_code'
  | 'list_files'
  | 'lsp_hover'
  | 'lsp_definitions'
  | 'lsp_references'
  | 'lsp_symbols'
  | 'lsp_diagnostics'
  | 'shell_exec'
  | 'git_read';

export type MemoryStrategy = 'full' | 'summary' | 'none';

export type BudgetWindow = 'monthly' | 'lifetime' | 'daily';

export type BudgetScopeType = 'agent' | 'project' | 'organization';

export type IncidentType = 'warning' | 'hard_stop' | 'overage';

// ─── INTERFACES ────────────────────────────────────────────────

export interface Skill {
  name: string;
  category: SkillCategory;
  proficiency: 'expert' | 'advanced' | 'intermediate';
  keywords: string[];
  weight: number; // 1-100
}

export interface AgentPersona {
  id: string;
  name: string;
  slug: string;
  role: AgentRole;
  department: AgentDepartment;
  status: AgentStatus;
  pauseReason?: string | null;

  // Identity
  systemPrompt: string;
  skills: Skill[];
  techStack: string[];
  legacyExpertise: string[];
  modernExpertise: string[];
  toolPermissions: ToolPermission[];
  stagePermissions: string[];

  // LLM config
  preferredProvider?: string | null;
  preferredModel?: string | null;
  evaluatorModel?: string | null;
  maxConcurrentTasks: number;

  // Hierarchy
  reportsTo?: string | null;
  canDelegate: boolean;
  escalationTarget?: string | null;

  // Budget
  monthlyBudgetCents: number;
  lifetimeBudgetCents?: number | null;
  hardStopEnabled: boolean;
  warningThreshold: number;
  spentMonthlyCents: number;

  // Session config
  sessionCompactionThreshold: number;
  memoryStrategy: MemoryStrategy;

  // Runtime (set by caller, not persisted)
  /** Number of currently active assignments — set by matchAndAssignAgent() */
  activeTasks?: number;

  // Metadata
  version: number;
  createdAt: string;
  updatedAt: string;
  hiddenAt?: string | null;
}

export interface AgentAssignment {
  id: string;
  agentId: string;
  pipelineRunId?: string | null;
  stageName?: string | null;
  subtaskId?: string | null;

  // Skill matching
  matchScore?: number | null;
  assignedBy?: string | null;

  // Atomic checkout
  status: AssignmentStatus;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
  checkedOutAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;

  // Results
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  costCents: number;
  tokensUsed: number;
  refinementCount: number;

  createdAt: string;
  updatedAt: string;
}

export interface AgentSubtask {
  id: string;
  parentSubtaskId?: string | null;
  pipelineRunId: string;
  stageName: string;

  title: string;
  description?: string | null;
  requiredSkills: Skill[];
  requiredTechStack: string[];
  priority: number;

  status: SubtaskStatus;
  assignedAgentId?: string | null;
  createdByAgentId: string;

  result?: Record<string, unknown> | null;
  costCents: number;

  createdAt: string;
  updatedAt: string;
}

export interface CostEvent {
  id: string;
  agentId?: string | null;
  pipelineRunId?: string | null;
  assignmentId?: string | null;
  projectId?: string | null;

  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costCents: number;

  stageName?: string | null;
  operation?: string | null;

  createdAt: string;
}

export interface BudgetPolicy {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  metric: string;
  window: BudgetWindow;
  limitCents: number;
  warnPercent: number;
  hardStop: boolean;
  notifyEnabled: boolean;
  active: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface BudgetIncident {
  id: string;
  policyId: string;
  agentId?: string | null;
  incidentType: IncidentType;
  currentSpendCents: number;
  limitCents: number;
  percentUsed: number;
  actionTaken?: string | null;
  resolved: boolean;

  createdAt: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  taskId: string;
  pipelineRunId?: string | null;

  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  sessionData?: Record<string, unknown> | null;
  tokenCount: number;
  compacted: boolean;
  compactionSummary?: string | null;

  createdAt: string;
}

export interface AgentActivityLogEntry {
  id: string;
  agentId: string;
  action: string;
  pipelineRunId?: string | null;
  assignmentId?: string | null;
  details: Record<string, unknown>;

  createdAt: string;
}

// ─── SKILL MATCHING RESULT ─────────────────────────────────────

export interface SkillMatchResult {
  agent: AgentPersona;
  score: number;
  reasons: string[];
}

// ─── OPENVIKING CONTEXT PATTERNS ─────────────────────────────────

export type ContextTier = 'L0' | 'L1' | 'L2';

export type EvolutionCategory =
  | 'legacy_pattern' | 'error_recovery' | 'user_preference' | 'domain_knowledge';

export interface EvolutionMemoryEntry {
  id: string;
  agentId: string;
  category: EvolutionCategory;
  summary: string;
  sourcePipelineRunId?: string | null;
  sourceStage?: string | null;
  confidence: number;
  usageCount: number;
  lastUsedAt?: string | null;
  supersededBy?: string | null;
  createdAt: string;
}

export interface RetrievalStep {
  sourceStage: string;
  tierLoaded: ContextTier;
  tokensConsumed: number;
  reason: 'recent_stage' | 'high_relevance' | 'budget_overflow' | 'skipped_irrelevant' | 'compaction_threshold';
  l0Preview?: string;
  /** True when this step was downgraded by progressive compaction */
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

// ─── AGENT DASHBOARD ───────────────────────────────────────────

export interface AgentDashboardSummary {
  totalAgents: number;
  byDepartment: Record<AgentDepartment, number>;
  byStatus: Record<AgentStatus, number>;
  totalSpentCents: number;
  activeAssignments: number;
  recentCostEvents: CostEvent[];
}
