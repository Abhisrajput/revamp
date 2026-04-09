import {
  pgTable,
  text,
  varchar,
  integer,
  timestamp,
  boolean,
  jsonb,
  uuid,
  serial,
  index,
  primaryKey,
  unique,
  numeric,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Users table
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    password_hash: text("password_hash"),
    first_name: varchar("first_name", { length: 255 }),
    last_name: varchar("last_name", { length: 255 }),
    role: varchar("role", { length: 50 }).notNull().default("developer"), // admin, architect, developer, sme
    organization_id: uuid("organization_id"),
    avatar_url: text("avatar_url"),
    is_active: boolean("is_active").notNull().default(true),
    last_login: timestamp("last_login"),
    otp_secret: text("otp_secret"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    emailIdx: index("users_email_idx").on(table.email),
    orgIdx: index("users_organization_id_idx").on(table.organization_id),
  })
);

// Organizations table
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull().unique(),
    description: text("description"),
    owner_id: uuid("owner_id").notNull(),
    logo_url: text("logo_url"),
    settings: jsonb("settings").default({}),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index("organizations_slug_idx").on(table.slug),
  })
);

// Projects table
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    repository_url: text("repository_url"),
    repository_branch: varchar("repository_branch", { length: 255 }).default("main"),
    status: varchar("status", { length: 50 }).notNull().default("draft"),
    current_stage: varchar("current_stage", { length: 50 }).default("SCAN"),
    current_stage_index: integer("current_stage_index").default(0),
    visibility: varchar("visibility", { length: 50 }).default("private"),
    config: jsonb("config").default({}),
    // 10X: Codebase source configuration
    source_type: varchar("source_type", { length: 50 }), // git, upload, local
    source_url: text("source_url"),
    source_branch: varchar("source_branch", { length: 255 }),
    source_languages: jsonb("source_languages").default([]),
    // 10X: Target configuration
    target_stack: varchar("target_stack", { length: 255 }),
    target_cloud: varchar("target_cloud", { length: 50 }),
    // 10X: Pipeline configuration
    deep_analysis: jsonb("deep_analysis").default({}),
    prompt_template_id: varchar("prompt_template_id", { length: 255 }),
    stage_prompts: jsonb("stage_prompts").default({}),
    validation_prompts: jsonb("validation_prompts").default({}),
    settings: jsonb("settings").default({}),
    folder_structure: jsonb("folder_structure").default([]),
    metrics: jsonb("metrics").default({}),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("projects_organization_id_idx").on(table.organization_id),
    statusIdx: index("projects_status_idx").on(table.status),
  })
);

// Project members table
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    project_id: uuid("project_id").notNull(),
    user_id: uuid("user_id").notNull(),
    role: varchar("role", { length: 50 }).notNull().default("viewer"), // owner, editor, reviewer, viewer
    joined_at: timestamp("joined_at").defaultNow().notNull(),
  },
  (table) => ({
    projectUserUniq: unique("project_members_project_user_uniq").on(table.project_id, table.user_id),
    projectIdx: index("project_members_project_id_idx").on(table.project_id),
    userIdx: index("project_members_user_id_idx").on(table.user_id),
  })
);

// Pipeline runs table
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    project_id: uuid("project_id").notNull(),
    initiated_by: uuid("initiated_by").notNull(),
    status: varchar("status", { length: 50 }).notNull().default("pending"), // pending, running, completed, failed, cancelled
    current_stage: varchar("current_stage", { length: 100 }),
    stage_progress: jsonb("stage_progress").default({}),
    error_message: text("error_message"),
    budget_cents: integer("budget_cents"), // max budget in cents (null = unlimited)
    budget_used_cents: integer("budget_used_cents").notNull().default(0), // accumulated spend
    started_at: timestamp("started_at"),
    completed_at: timestamp("completed_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("pipeline_runs_project_id_idx").on(table.project_id),
    statusIdx: index("pipeline_runs_status_idx").on(table.status),
  })
);

// Stage artifacts table
export const stageArtifacts = pgTable(
  "stage_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipeline_run_id: uuid("pipeline_run_id").notNull(),
    stage_name: varchar("stage_name", { length: 100 }).notNull(),
    artifact_type: varchar("artifact_type", { length: 100 }).notNull(), // analysis, modernized_code, report, etc
    storage_path: text("storage_path").notNull(),
    file_size: integer("file_size"),
    metadata: jsonb("metadata").default({}),
    // Tiered context summaries (OpenViking pattern)
    l0_summary: text("l0_summary"), // ~100 tokens, one-sentence summary
    l1_summary: text("l1_summary"), // ~2K tokens, structured key findings
    // Memory hotness tracking (OpenViking memory lifecycle pattern)
    active_count: integer("active_count").notNull().default(0), // retrieval/access count
    last_accessed_at: timestamp("last_accessed_at"), // for recency decay scoring
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    pipelineRunIdx: index("stage_artifacts_pipeline_run_id_idx").on(table.pipeline_run_id),
    stageNameIdx: index("stage_artifacts_stage_name_idx").on(table.stage_name),
    runStageTypeIdx: index("stage_artifacts_run_stage_type_idx").on(
      table.pipeline_run_id, table.stage_name, table.artifact_type,
    ),
  })
);

// Approval gates table
export const approvalGates = pgTable(
  "approval_gates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipeline_run_id: uuid("pipeline_run_id").notNull(),
    stage_name: varchar("stage_name", { length: 100 }).notNull(),
    required_role: varchar("required_role", { length: 50 }).notNull(), // architect, admin, etc
    status: varchar("status", { length: 50 }).notNull().default("pending"), // pending, approved, rejected
    approved_by: uuid("approved_by"),
    approval_comment: text("approval_comment"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    approved_at: timestamp("approved_at"),
  },
  (table) => ({
    pipelineRunIdx: index("approval_gates_pipeline_run_id_idx").on(table.pipeline_run_id),
    statusIdx: index("approval_gates_status_idx").on(table.status),
    pipelineStageUniq: unique("approval_gates_pipeline_stage_uniq").on(table.pipeline_run_id, table.stage_name),
  })
);

// LLM usage table for billing/analytics
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    project_id: uuid("project_id").notNull(),
    pipeline_run_id: uuid("pipeline_run_id"),
    model: varchar("model", { length: 100 }).notNull(),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    cost: integer("cost").notNull().default(0), // in cents
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("llm_usage_project_id_idx").on(table.project_id),
    modelIdx: index("llm_usage_model_idx").on(table.model),
  })
);

// Audit logs table
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id"),
    action: varchar("action", { length: 255 }).notNull(),
    resource_type: varchar("resource_type", { length: 100 }).notNull(),
    resource_id: uuid("resource_id"),
    changes: jsonb("changes"),
    ip_address: varchar("ip_address", { length: 45 }),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("audit_logs_user_id_idx").on(table.user_id),
    actionIdx: index("audit_logs_action_idx").on(table.action),
  })
);

// Prompt templates table
export const promptTemplates = pgTable(
  "prompt_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id"),
    name: varchar("name", { length: 255 }).notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    template_content: text("template_content").notNull(),
    variables: jsonb("variables").default([]),
    version: integer("version").notNull().default(1),
    is_active: boolean("is_active").notNull().default(true),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("prompt_templates_organization_id_idx").on(table.organization_id),
    categoryIdx: index("prompt_templates_category_idx").on(table.category),
  })
);

// Supporting documents table
export const supportingDocuments = pgTable(
  "supporting_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    project_id: uuid("project_id").notNull(),
    name: varchar("name", { length: 512 }).notNull(),
    file_type: varchar("file_type", { length: 100 }).notNull(),
    storage_key: text("storage_key").notNull(), // S3/MinIO key
    file_size: integer("file_size").notNull().default(0),
    uploaded_by: uuid("uploaded_by").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("supporting_documents_project_id_idx").on(table.project_id),
  })
);

// Modernized files (generated code from FORGE stage)
export const modernizedFiles = pgTable(
  "modernized_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    project_id: uuid("project_id").notNull(),
    pipeline_run_id: uuid("pipeline_run_id"),
    file_path: text("file_path").notNull(),
    file_name: varchar("file_name", { length: 512 }).notNull(),
    language: varchar("language", { length: 50 }),
    content: text("content").notNull(),
    file_size: integer("file_size").notNull().default(0),
    is_new: boolean("is_new").default(true),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("modernized_files_project_id_idx").on(table.project_id),
    pathIdx: index("modernized_files_file_path_idx").on(table.file_path),
  })
);

// Traceability entries — maps DECODE business rules to generated files
export const traceabilityEntries = pgTable(
  "traceability_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    project_id: uuid("project_id").notNull(),
    pipeline_run_id: uuid("pipeline_run_id"),
    rule_id: varchar("rule_id", { length: 50 }).notNull(),
    rule_text: text("rule_text").notNull(),
    source_file: text("source_file"), // legacy file the rule came from
    target_file_path: text("target_file_path").notNull(), // modernized file
    target_file_id: uuid("target_file_id"),
    status: varchar("status", { length: 30 }).notNull().default("pending"), // pending, implemented, partial, skipped
    confidence: numeric("confidence", { precision: 3, scale: 2 }).default("0.00"),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("traceability_project_idx").on(table.project_id),
    pipelineIdx: index("traceability_pipeline_idx").on(table.pipeline_run_id),
    ruleIdx: index("traceability_rule_idx").on(table.rule_id),
  })
);

// Stage run history — one row per stage execution attempt
export const stageRuns = pgTable(
  "stage_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipeline_run_id: uuid("pipeline_run_id").notNull(),
    stage_name: varchar("stage_name", { length: 100 }).notNull(),
    /** Attempt number (1, 2, 3...) for retries of the same stage */
    attempt: integer("attempt").notNull().default(1),
    status: varchar("status", { length: 30 }).notNull().default("running"), // running, completed, failed, aborted
    /** Model used for LLM generation */
    model: varchar("model", { length: 200 }),
    /** Assigned agent (if any) */
    agent_id: uuid("agent_id"),
    agent_name: varchar("agent_name", { length: 200 }),
    /** Token usage */
    input_tokens: integer("input_tokens").default(0),
    output_tokens: integer("output_tokens").default(0),
    cost_cents: integer("cost_cents").default(0),
    /** Timing */
    duration_ms: integer("duration_ms"),
    /** Validation result summary */
    validation_passed: boolean("validation_passed"),
    validation_score: integer("validation_score"),
    /** Error details if failed */
    error_message: text("error_message"),
    error_category: varchar("error_category", { length: 50 }),
    /** Output length (chars) */
    output_length: integer("output_length").default(0),
    started_at: timestamp("started_at").defaultNow().notNull(),
    completed_at: timestamp("completed_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    pipelineRunIdx: index("stage_runs_pipeline_run_id_idx").on(table.pipeline_run_id),
    runStageIdx: index("stage_runs_run_stage_idx").on(table.pipeline_run_id, table.stage_name),
    statusIdx: index("stage_runs_status_idx").on(table.status),
  })
);

// Stage execution logs — persistent log entries from each stage execution
export const stageExecutionLogs = pgTable(
  "stage_execution_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stage_run_id: uuid("stage_run_id").notNull(),
    pipeline_run_id: uuid("pipeline_run_id").notNull(),
    stage_name: varchar("stage_name", { length: 100 }).notNull(),
    /** Log level: info, warn, error, debug, tool */
    level: varchar("level", { length: 10 }).notNull().default("info"),
    /** Phase when the log was emitted (e.g. scanning_codebase, generating, validating) */
    phase: varchar("phase", { length: 100 }),
    /** Human-readable log message */
    message: text("message").notNull(),
    /** Additional detail or context */
    detail: text("detail"),
    /** Structured metadata (tool inputs, timing, etc.) */
    metadata: jsonb("metadata"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    stageRunIdx: index("stage_execution_logs_stage_run_id_idx").on(table.stage_run_id),
    pipelineRunIdx: index("stage_execution_logs_pipeline_run_id_idx").on(table.pipeline_run_id),
    runStageIdx: index("stage_execution_logs_run_stage_idx").on(table.pipeline_run_id, table.stage_name),
  })
);

// Relations
export const usersRelations = relations(users, ({ many, one }) => ({
  organizations: many(organizations),
  projects: many(projects),
  projectMembers: many(projectMembers),
  pipelineRuns: many(pipelineRuns),
  auditLogs: many(auditLogs),
}));

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  projects: many(projects),
  owner: one(users, {
    fields: [organizations.owner_id],
    references: [users.id],
  }),
  promptTemplates: many(promptTemplates),
}));

export const projectsRelations = relations(projects, ({ many, one }) => ({
  organization: one(organizations, {
    fields: [projects.organization_id],
    references: [organizations.id],
  }),
  members: many(projectMembers),
  pipelineRuns: many(pipelineRuns),
  llmUsage: many(llmUsage),
  supportingDocuments: many(supportingDocuments),
  modernizedFiles: many(modernizedFiles),
  creator: one(users, {
    fields: [projects.created_by],
    references: [users.id],
  }),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, {
    fields: [projectMembers.project_id],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectMembers.user_id],
    references: [users.id],
  }),
}));

export const pipelineRunsRelations = relations(pipelineRuns, ({ many, one }) => ({
  project: one(projects, {
    fields: [pipelineRuns.project_id],
    references: [projects.id],
  }),
  artifacts: many(stageArtifacts),
  approvalGates: many(approvalGates),
  llmUsage: many(llmUsage),
  stageRuns: many(stageRuns),
  initiatedBy: one(users, {
    fields: [pipelineRuns.initiated_by],
    references: [users.id],
  }),
}));

export const stageRunsRelations = relations(stageRuns, ({ many, one }) => ({
  pipelineRun: one(pipelineRuns, {
    fields: [stageRuns.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  logs: many(stageExecutionLogs),
}));

export const stageExecutionLogsRelations = relations(stageExecutionLogs, ({ one }) => ({
  stageRun: one(stageRuns, {
    fields: [stageExecutionLogs.stage_run_id],
    references: [stageRuns.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [stageExecutionLogs.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
}));

export const stageArtifactsRelations = relations(stageArtifacts, ({ one }) => ({
  pipelineRun: one(pipelineRuns, {
    fields: [stageArtifacts.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
}));

export const approvalGatesRelations = relations(approvalGates, ({ one }) => ({
  pipelineRun: one(pipelineRuns, {
    fields: [approvalGates.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  approver: one(users, {
    fields: [approvalGates.approved_by],
    references: [users.id],
  }),
}));

export const llmUsageRelations = relations(llmUsage, ({ one }) => ({
  project: one(projects, {
    fields: [llmUsage.project_id],
    references: [projects.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [llmUsage.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
}));

export const promptTemplatesRelations = relations(promptTemplates, ({ one }) => ({
  organization: one(organizations, {
    fields: [promptTemplates.organization_id],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [promptTemplates.created_by],
    references: [users.id],
  }),
}));

export const supportingDocumentsRelations = relations(supportingDocuments, ({ one }) => ({
  project: one(projects, {
    fields: [supportingDocuments.project_id],
    references: [projects.id],
  }),
  uploader: one(users, {
    fields: [supportingDocuments.uploaded_by],
    references: [users.id],
  }),
}));

export const modernizedFilesRelations = relations(modernizedFiles, ({ one }) => ({
  project: one(projects, {
    fields: [modernizedFiles.project_id],
    references: [projects.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [modernizedFiles.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
}));

// ─── AGENT DEPARTMENT TABLES ─────────────────────────────────────

// 1. Agent Personas — persistent agent identities with hierarchy, skills, budget, LLM config
export const agentPersonas = pgTable(
  "agent_personas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 50 }).notNull().unique(),
    role: varchar("role", { length: 20 }).notNull(), // director, lead, specialist
    department: varchar("department", { length: 30 }).notNull(), // discovery, execution, qa, pm
    status: varchar("status", { length: 20 }).notNull().default("idle"), // idle, working, paused, disabled
    pause_reason: varchar("pause_reason", { length: 100 }),

    // Identity
    system_prompt: text("system_prompt").notNull(),
    skills: jsonb("skills").notNull().default([]),
    tech_stack: jsonb("tech_stack").notNull().default([]),
    legacy_expertise: jsonb("legacy_expertise").default([]),
    modern_expertise: jsonb("modern_expertise").default([]),
    tool_permissions: jsonb("tool_permissions").notNull().default([]),
    stage_permissions: jsonb("stage_permissions").notNull().default([]),

    // LLM config
    preferred_provider: varchar("preferred_provider", { length: 50 }),
    preferred_model: varchar("preferred_model", { length: 100 }),
    evaluator_model: varchar("evaluator_model", { length: 100 }),
    max_concurrent_tasks: integer("max_concurrent_tasks").notNull().default(3),

    // Hierarchy (Paperclip reports_to pattern)
    reports_to: uuid("reports_to"),
    can_delegate: boolean("can_delegate").notNull().default(false),
    escalation_target: uuid("escalation_target"),

    // Budget
    monthly_budget_cents: integer("monthly_budget_cents").notNull().default(10000),
    lifetime_budget_cents: integer("lifetime_budget_cents"),
    hard_stop_enabled: boolean("hard_stop_enabled").notNull().default(true),
    warning_threshold: numeric("warning_threshold", { precision: 3, scale: 2 }).notNull().default("0.80"),
    spent_monthly_cents: integer("spent_monthly_cents").notNull().default(0),

    // Session config
    session_compaction_threshold: integer("session_compaction_threshold").notNull().default(100000),
    memory_strategy: varchar("memory_strategy", { length: 20 }).notNull().default("summary"),

    // Metadata
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    hidden_at: timestamp("hidden_at"), // soft delete (Paperclip pattern)
  },
  (table) => ({
    deptStatusIdx: index("agent_personas_dept_status_idx").on(table.department, table.status),
    reportsToIdx: index("agent_personas_reports_to_idx").on(table.reports_to),
  })
);

// 2. Agent Sessions — session continuity with chain pattern (Paperclip agent_task_sessions)
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id").notNull(),
    task_id: uuid("task_id").notNull(),
    pipeline_run_id: uuid("pipeline_run_id"),

    // Session chain (Paperclip pattern)
    session_id_before: varchar("session_id_before", { length: 200 }),
    session_id_after: varchar("session_id_after", { length: 200 }),
    session_data: jsonb("session_data"),
    token_count: integer("token_count").notNull().default(0),
    compacted: boolean("compacted").notNull().default(false),
    compaction_summary: text("compaction_summary"),

    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentTaskIdx: index("agent_sessions_agent_task_idx").on(table.agent_id, table.task_id),
    pipelineIdx: index("agent_sessions_pipeline_idx").on(table.pipeline_run_id),
  })
);

// 3. Agent Assignments — task checkout with atomic locking (Paperclip issues.checkout pattern)
export const agentAssignments = pgTable(
  "agent_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id").notNull(),
    pipeline_run_id: uuid("pipeline_run_id"),
    stage_name: varchar("stage_name", { length: 50 }),
    subtask_id: uuid("subtask_id"),

    // Skill matching
    match_score: numeric("match_score", { precision: 5, scale: 2 }),
    assigned_by: uuid("assigned_by"),

    // Atomic checkout (Paperclip pattern)
    status: varchar("status", { length: 20 }).notNull().default("assigned"), // assigned, in_progress, completed, failed, escalated
    checkout_run_id: uuid("checkout_run_id"),
    execution_run_id: uuid("execution_run_id"),
    checked_out_at: timestamp("checked_out_at"),
    started_at: timestamp("started_at"),
    completed_at: timestamp("completed_at"),

    // Results
    result: jsonb("result"),
    error_message: text("error_message"),
    cost_cents: integer("cost_cents").notNull().default(0),
    tokens_used: integer("tokens_used").notNull().default(0),
    refinement_count: integer("refinement_count").notNull().default(0),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    agentStatusIdx: index("agent_assignments_agent_status_idx").on(table.agent_id, table.status),
    pipelineStageIdx: index("agent_assignments_pipeline_stage_idx").on(table.pipeline_run_id, table.stage_name),
  })
);

// 4. Agent Subtasks — dynamic work items from manager agents
export const agentSubtasks = pgTable(
  "agent_subtasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parent_subtask_id: uuid("parent_subtask_id"),
    pipeline_run_id: uuid("pipeline_run_id").notNull(),
    stage_name: varchar("stage_name", { length: 50 }).notNull(),

    // Task definition
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    required_skills: jsonb("required_skills").notNull().default([]),
    required_tech_stack: jsonb("required_tech_stack").default([]),
    priority: integer("priority").notNull().default(5), // 1=critical, 10=low

    // Status
    status: varchar("status", { length: 20 }).notNull().default("backlog"), // backlog, assigned, in_progress, completed, failed
    assigned_agent_id: uuid("assigned_agent_id"),
    created_by_agent_id: uuid("created_by_agent_id").notNull(),

    // Execution
    result: jsonb("result"),
    cost_cents: integer("cost_cents").notNull().default(0),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    pipelineStageIdx: index("agent_subtasks_pipeline_stage_idx").on(table.pipeline_run_id, table.stage_name),
    assignedStatusIdx: index("agent_subtasks_assigned_status_idx").on(table.assigned_agent_id, table.status),
  })
);

// 5. Budget Policies — per-org, per-project, or per-agent budget policies
export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope_type: varchar("scope_type", { length: 20 }).notNull(), // agent, project, organization
    scope_id: uuid("scope_id").notNull(),
    metric: varchar("metric", { length: 30 }).notNull().default("billed_cents"),
    window: varchar("window", { length: 20 }).notNull().default("monthly"), // monthly, lifetime, daily
    limit_cents: integer("limit_cents").notNull(),
    warn_percent: numeric("warn_percent", { precision: 3, scale: 2 }).notNull().default("0.80"),
    hard_stop: boolean("hard_stop").notNull().default(true),
    notify_enabled: boolean("notify_enabled").notNull().default(true),
    active: boolean("active").notNull().default(true),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    scopeIdx: index("budget_policies_scope_idx").on(table.scope_type, table.scope_id, table.active),
  })
);

// 6. Cost Events — immutable append-only cost tracking (Paperclip pattern: NEVER UPDATE/DELETE)
export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id"),
    pipeline_run_id: uuid("pipeline_run_id"),
    assignment_id: uuid("assignment_id"),
    project_id: uuid("project_id"),

    // Cost details
    provider: varchar("provider", { length: 50 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    cached_tokens: integer("cached_tokens").notNull().default(0),
    cost_cents: integer("cost_cents").notNull().default(0),

    // Context
    stage_name: varchar("stage_name", { length: 50 }),
    operation: varchar("operation", { length: 50 }),

    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentMonthIdx: index("cost_events_agent_month_idx").on(table.agent_id, table.created_at),
    projectIdx: index("cost_events_project_idx").on(table.project_id, table.created_at),
    pipelineIdx: index("cost_events_pipeline_idx").on(table.pipeline_run_id),
  })
);

// 7. Budget Incidents — budget threshold events
export const budgetIncidents = pgTable(
  "budget_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    policy_id: uuid("policy_id").notNull(),
    agent_id: uuid("agent_id"),
    incident_type: varchar("incident_type", { length: 30 }).notNull(), // warning, hard_stop, overage
    current_spend_cents: integer("current_spend_cents").notNull(),
    limit_cents: integer("limit_cents").notNull(),
    percent_used: numeric("percent_used", { precision: 5, scale: 2 }).notNull(),
    action_taken: varchar("action_taken", { length: 50 }),
    resolved: boolean("resolved").notNull().default(false),

    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    unresolvedIdx: index("budget_incidents_unresolved_idx").on(table.resolved, table.created_at),
  })
);

// 8. Agent Activity Log — audit trail for all agent mutations
export const agentActivityLog = pgTable(
  "agent_activity_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id").notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    pipeline_run_id: uuid("pipeline_run_id"),
    assignment_id: uuid("assignment_id"),
    details: jsonb("details").notNull().default({}),

    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("agent_activity_log_agent_idx").on(table.agent_id, table.created_at),
    pipelineIdx: index("agent_activity_log_pipeline_idx").on(table.pipeline_run_id),
  })
);

// 9. Agent Evolution Memory — persistent cross-pipeline-run learnings (OpenViking pattern)
export const agentEvolutionMemory = pgTable(
  "agent_evolution_memory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id").notNull(),
    category: varchar("category", { length: 50 }).notNull(), // legacy_pattern, error_recovery, user_preference, domain_knowledge
    summary: text("summary").notNull(),
    source_pipeline_run_id: uuid("source_pipeline_run_id"),
    source_stage: varchar("source_stage", { length: 100 }),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.80"),
    usage_count: integer("usage_count").notNull().default(0),
    last_used_at: timestamp("last_used_at"),
    superseded_by: uuid("superseded_by"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentCategoryIdx: index("agent_evolution_memory_agent_category_idx").on(table.agent_id, table.category),
    agentConfidenceIdx: index("agent_evolution_memory_agent_confidence_idx").on(table.agent_id, table.confidence),
  })
);

// 10. Retrieval Trajectories — observable retrieval log (OpenViking pattern)
export const retrievalTrajectories = pgTable(
  "retrieval_trajectories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pipeline_run_id: uuid("pipeline_run_id").notNull(),
    stage_name: varchar("stage_name", { length: 100 }).notNull(),
    agent_id: uuid("agent_id"),
    total_token_budget: integer("total_token_budget").notNull(),
    tokens_used: integer("tokens_used").notNull(),
    trajectory: jsonb("trajectory").notNull().default([]),
    evolution_memories_loaded: integer("evolution_memories_loaded").notNull().default(0),
    evolution_memory_ids: jsonb("evolution_memory_ids").notNull().default([]),
    build_duration_ms: integer("build_duration_ms"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    pipelineStageIdx: index("retrieval_trajectories_pipeline_stage_idx").on(table.pipeline_run_id, table.stage_name),
    agentIdx: index("retrieval_trajectories_agent_idx").on(table.agent_id),
  })
);

// ─── AGENT DEPARTMENT RELATIONS ──────────────────────────────────

export const agentPersonasRelations = relations(agentPersonas, ({ one, many }) => ({
  reportsToAgent: one(agentPersonas, {
    fields: [agentPersonas.reports_to],
    references: [agentPersonas.id],
    relationName: "reportsTo",
  }),
  subordinates: many(agentPersonas, { relationName: "reportsTo" }),
  sessions: many(agentSessions),
  assignments: many(agentAssignments),
  costEvents: many(costEvents),
  activityLog: many(agentActivityLog),
}));

export const agentSessionsRelations = relations(agentSessions, ({ one }) => ({
  agent: one(agentPersonas, {
    fields: [agentSessions.agent_id],
    references: [agentPersonas.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [agentSessions.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
}));

export const agentAssignmentsRelations = relations(agentAssignments, ({ one }) => ({
  agent: one(agentPersonas, {
    fields: [agentAssignments.agent_id],
    references: [agentPersonas.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [agentAssignments.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  assignedByAgent: one(agentPersonas, {
    fields: [agentAssignments.assigned_by],
    references: [agentPersonas.id],
    relationName: "assignedBy",
  }),
}));

export const agentSubtasksRelations = relations(agentSubtasks, ({ one, many }) => ({
  parentSubtask: one(agentSubtasks, {
    fields: [agentSubtasks.parent_subtask_id],
    references: [agentSubtasks.id],
    relationName: "parentChild",
  }),
  childSubtasks: many(agentSubtasks, { relationName: "parentChild" }),
  pipelineRun: one(pipelineRuns, {
    fields: [agentSubtasks.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  assignedAgent: one(agentPersonas, {
    fields: [agentSubtasks.assigned_agent_id],
    references: [agentPersonas.id],
  }),
  createdByAgent: one(agentPersonas, {
    fields: [agentSubtasks.created_by_agent_id],
    references: [agentPersonas.id],
    relationName: "createdBy",
  }),
}));

export const budgetPoliciesRelations = relations(budgetPolicies, ({ many }) => ({
  incidents: many(budgetIncidents),
}));

export const costEventsRelations = relations(costEvents, ({ one }) => ({
  agent: one(agentPersonas, {
    fields: [costEvents.agent_id],
    references: [agentPersonas.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [costEvents.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  assignment: one(agentAssignments, {
    fields: [costEvents.assignment_id],
    references: [agentAssignments.id],
  }),
  project: one(projects, {
    fields: [costEvents.project_id],
    references: [projects.id],
  }),
}));

export const budgetIncidentsRelations = relations(budgetIncidents, ({ one }) => ({
  policy: one(budgetPolicies, {
    fields: [budgetIncidents.policy_id],
    references: [budgetPolicies.id],
  }),
  agent: one(agentPersonas, {
    fields: [budgetIncidents.agent_id],
    references: [agentPersonas.id],
  }),
}));

export const agentActivityLogRelations = relations(agentActivityLog, ({ one }) => ({
  agent: one(agentPersonas, {
    fields: [agentActivityLog.agent_id],
    references: [agentPersonas.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [agentActivityLog.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  assignment: one(agentAssignments, {
    fields: [agentActivityLog.assignment_id],
    references: [agentAssignments.id],
  }),
}));

// ─── MODERNIZATION MEMORIES TABLE ────────────────────────────────
// 6-category memory extraction (OpenViking pattern):
//   profile, preferences, entities, events, cases, patterns

export const modernizationMemories = pgTable(
  "modernization_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    project_id: uuid("project_id").notNull(),
    pipeline_run_id: uuid("pipeline_run_id"),
    stage_name: varchar("stage_name", { length: 100 }),
    // 6 categories from OpenViking's memory extraction
    category: varchar("category", { length: 50 }).notNull(), // profile, preferences, entities, events, cases, patterns
    content: text("content").notNull(),
    /** Structured metadata for retrieval (keywords, source refs, etc.) */
    metadata: jsonb("metadata").default({}),
    /** Confidence score 0.0 - 1.0 from extraction */
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0.5"),
    /** Access count + recency for hotness scoring */
    access_count: integer("access_count").notNull().default(0),
    last_accessed_at: timestamp("last_accessed_at"),
    /** Supersession chain — newer memories can replace older ones */
    superseded_by: uuid("superseded_by"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("mod_memories_project_id_idx").on(table.project_id),
    categoryIdx: index("mod_memories_category_idx").on(table.category),
    pipelineRunIdx: index("mod_memories_pipeline_run_id_idx").on(table.pipeline_run_id),
  })
);

export const modernizationMemoriesRelations = relations(modernizationMemories, ({ one }) => ({
  project: one(projects, {
    fields: [modernizationMemories.project_id],
    references: [projects.id],
  }),
  pipelineRun: one(pipelineRuns, {
    fields: [modernizationMemories.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  supersededByMemory: one(modernizationMemories, {
    fields: [modernizationMemories.superseded_by],
    references: [modernizationMemories.id],
    relationName: "supersedes",
  }),
}));

// ─── OPENVIKING PATTERN RELATIONS ────────────────────────────────

export const agentEvolutionMemoryRelations = relations(agentEvolutionMemory, ({ one }) => ({
  agent: one(agentPersonas, {
    fields: [agentEvolutionMemory.agent_id],
    references: [agentPersonas.id],
  }),
  sourcePipelineRun: one(pipelineRuns, {
    fields: [agentEvolutionMemory.source_pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  supersededByMemory: one(agentEvolutionMemory, {
    fields: [agentEvolutionMemory.superseded_by],
    references: [agentEvolutionMemory.id],
    relationName: "supersedes",
  }),
}));

export const retrievalTrajectoriesRelations = relations(retrievalTrajectories, ({ one }) => ({
  pipelineRun: one(pipelineRuns, {
    fields: [retrievalTrajectories.pipeline_run_id],
    references: [pipelineRuns.id],
  }),
  agent: one(agentPersonas, {
    fields: [retrievalTrajectories.agent_id],
    references: [agentPersonas.id],
  }),
}));

// ═══ AGENT ROUTINES — Scheduled recurring agent tasks ═════════════

export const agentRoutines = pgTable(
  "agent_routines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    project_id: uuid("project_id"),
    agent_id: uuid("agent_id"), // assigned agent (null = auto-assign)
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),

    // Schedule
    cron_expression: varchar("cron_expression", { length: 100 }), // null = manual/webhook only
    trigger_type: varchar("trigger_type", { length: 20 }).notNull().default("schedule"), // schedule, webhook, manual
    webhook_secret: text("webhook_secret"),

    // Execution config
    task_template: jsonb("task_template").notNull().default({}), // { title, description, priority, stage }
    concurrency_policy: varchar("concurrency_policy", { length: 30 }).notNull().default("skip_if_active"),
    // skip_if_active, coalesce_if_active, always_enqueue
    max_retries: integer("max_retries").notNull().default(1),

    // State
    enabled: boolean("enabled").notNull().default(true),
    last_run_at: timestamp("last_run_at"),
    next_run_at: timestamp("next_run_at"),
    last_run_status: varchar("last_run_status", { length: 20 }), // completed, failed, skipped
    run_count: integer("run_count").notNull().default(0),

    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("agent_routines_org_idx").on(table.organization_id),
    agentIdx: index("agent_routines_agent_idx").on(table.agent_id),
    nextRunIdx: index("agent_routines_next_run_idx").on(table.enabled, table.next_run_at),
  })
);

// ═══ AGENT TASKS — Kanban-style task board for greenfield projects ═══

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    project_id: uuid("project_id"),
    routine_id: uuid("routine_id"), // null if manually created

    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),

    // Kanban status
    status: varchar("status", { length: 20 }).notNull().default("backlog"),
    // backlog, todo, in_progress, in_review, blocked, done, cancelled

    priority: varchar("priority", { length: 20 }).notNull().default("medium"),
    // critical, high, medium, low

    // Assignment
    assigned_agent_id: uuid("assigned_agent_id"),
    assigned_user_id: uuid("assigned_user_id"),

    // Execution
    stage: varchar("stage", { length: 50 }), // pipeline stage if applicable
    pipeline_run_id: uuid("pipeline_run_id"),
    progress: integer("progress").notNull().default(0), // 0-100

    // Cost tracking
    tokens_used: integer("tokens_used").notNull().default(0),
    cost_cents: integer("cost_cents").notNull().default(0),

    // Metadata
    labels: jsonb("labels").notNull().default([]),
    result: jsonb("result"),
    error_message: text("error_message"),

    // Ordering within status column
    sort_order: integer("sort_order").notNull().default(0),

    started_at: timestamp("started_at"),
    completed_at: timestamp("completed_at"),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgStatusIdx: index("agent_tasks_org_status_idx").on(table.organization_id, table.status),
    projectIdx: index("agent_tasks_project_idx").on(table.project_id),
    assignedIdx: index("agent_tasks_assigned_idx").on(table.assigned_agent_id, table.status),
  })
);

// ═══ APPROVAL COMMENTS — collaborative review threads ═════════

export const approvalComments = pgTable(
  "approval_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approval_gate_id: uuid("approval_gate_id").notNull(),
    user_id: uuid("user_id"),
    agent_id: uuid("agent_id"),
    content: text("content").notNull(),
    action: varchar("action", { length: 30 }), // comment, revision_requested, revised, approved, rejected
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    gateIdx: index("approval_comments_gate_idx").on(table.approval_gate_id, table.created_at),
  })
);

// ═══ AGENT SKILLS — reusable knowledge modules ═══════════════

export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 50 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 50 }).notNull(), // language, framework, pattern, domain, tool
    // Content
    knowledge: text("knowledge").notNull(), // system prompt fragment / knowledge base content
    examples: jsonb("examples").default([]), // code examples, patterns
    // Metadata
    tags: jsonb("tags").notNull().default([]),
    version: integer("version").notNull().default(1),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgCategoryIdx: index("agent_skills_org_category_idx").on(table.organization_id, table.category),
    slugIdx: index("agent_skills_slug_idx").on(table.slug),
  })
);

// ═══ AGENT SKILL ASSIGNMENTS — many-to-many ══════════════════

export const agentSkillAssignments = pgTable(
  "agent_skill_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id").notNull(),
    skill_id: uuid("skill_id").notNull(),
    proficiency: varchar("proficiency", { length: 20 }).notNull().default("intermediate"), // beginner, intermediate, expert
    assigned_at: timestamp("assigned_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("agent_skill_assignments_agent_idx").on(table.agent_id),
    skillIdx: index("agent_skill_assignments_skill_idx").on(table.skill_id),
    uniqueAssignment: unique("agent_skill_unique").on(table.agent_id, table.skill_id),
  })
);
