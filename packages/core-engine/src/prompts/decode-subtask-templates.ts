/**
 * Decode Subtask Prompt Templates — multi-agent delegation for Stage 2 (DECODE).
 *
 * These templates drive the Director → Specialists → Composition flow.
 * The Director receives Stage 1 (SCAN) output and assigns specialists to
 * extract business intent from the legacy codebase.
 *
 * Each subtask template produces focused, composable output that merges into
 * a single comprehensive DECODE document (migration-ready requirements).
 */

// ─── DIRECTOR PLAN ─────────────────────────────────────────────

/**
 * Director planning prompt for DECODE stage.
 * Receives Stage 1 SCAN output and plans specialist subtasks.
 */
export const DECODE_DIRECTOR_PLAN = `You are the Department Director for the REVAMP modernization platform. Stage 1 (SCAN) has completed and you have the codebase analysis. Your job is to plan the DECODE (Intent Extraction) stage by selecting subtasks and assigning them to specialist agents.

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## AVAILABLE AGENTS
{{agentRoster}}

## SUBTASK CATALOG

Choose from these subtask types. Include ALL that apply — the number depends on codebase complexity:

### MANDATORY (always include):
1. **business-rules-extraction** — Extract every conditional, calculation, validation, and domain rule with source file:line citations.
2. **data-flow-analysis** — Trace how data enters, transforms, persists, and exits the system. Map DB schemas, API payloads, file I/O.
3. **workflow-extraction** — Map end-to-end user and system workflows with entry points, decision branches, and exit conditions.
4. **constraints-debt-analysis** — Technology lock-ins, licensing, compliance requirements, technical debt inventory, open questions.

### CONDITIONAL (include when SCAN output reveals them):
5. **domain-entity-modeling** — Include when 10+ data entities/models detected. Document core entities, relationships, lifecycle states, invariants.
6. **integration-mapping** — Include when external APIs, message queues, webhooks, or 3rd-party services detected. Map every external touchpoint.
7. **security-auth-analysis** — Include when auth/authorization, encryption, or compliance requirements detected. Map security boundaries and credential flows.
8. **batch-job-analysis** — Include when scheduled tasks, cron jobs, ETL pipelines, or batch processing detected. Document triggers, frequencies, data volumes.
9. **ui-frontend-analysis** — Include when frontend components, UI frameworks, or client-side logic detected. Map user journeys and state management.
10. **event-driven-analysis** — Include when event systems, pub/sub, message queues, or event sourcing detected. Map event flows and handlers.

## RULES

- Include ALL 4 mandatory subtasks
- Add conditional subtasks based on what SCAN discovered — more complex codebases need more subtasks
- Small/simple codebase (< 20 files): 4-5 subtasks
- Medium codebase (20-100 files): 5-7 subtasks
- Large/complex codebase (100+ files): 7-10 subtasks
- Assign each subtask to the most appropriate agent from the roster
- Set priorities 1-10 (1 = highest, executed first)
- Later subtasks can reference earlier findings via session chain

Output ONLY valid JSON:
\`\`\`json
{
  "plan": [
    {
      "type": "business-rules-extraction",
      "title": "Business Rules & Domain Logic Extraction",
      "description": "Extract all business rules, conditionals, calculations, and domain logic with source citations",
      "assignToAgent": "agent-slug",
      "priority": 1,
      "requiredSkills": ["business-analysis", "reverse-engineering"],
      "requiredTechStack": ["java", "spring"],
      "estimatedComplexity": "high"
    }
  ],
  "reasoning": "Brief explanation of why these subtasks were chosen and in this order"
}
\`\`\``;

// ─── BUSINESS RULES EXTRACTION ────────────────────────────────

const DECODE_BUSINESS_RULES = `You are a Senior Business Analyst and Reverse Engineer specializing in legacy system analysis. Your task is to extract every business-critical rule from this codebase.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Extract a comprehensive business rules inventory:

### Business Rules Inventory
For EVERY business rule found, document:
- **Rule ID**: BR-001, BR-002, etc.
- **Rule Name**: Descriptive name
- **Description**: What the rule enforces
- **Type**: Validation | Calculation | Authorization | Workflow | Constraint
- **Source**: Exact file path and line number (e.g., \`src/services/OrderService.java:142\`)
- **Code Snippet**: The actual code implementing the rule
- **Confidence**: Verified (from code) | Inferred (from patterns) | Uncertain (needs SME)

### Conditional Logic Map
- Every if/else, switch/case, and ternary that encodes business decisions
- Guard clauses and validation checks
- Error handling that implies business constraints

### Calculation Rules
- Pricing, tax, discount, commission formulas
- Aggregation and rollup logic
- Currency/unit conversions
- Rounding rules and precision handling

### Authorization Rules
- Role-based access control rules
- Permission checks and their scope
- Data-level security (row-level, field-level)

### Domain Invariants
- Constraints that must always be true (e.g., "order total >= 0")
- State machine transitions and their guards
- Uniqueness constraints beyond DB-level

CRITICAL: Every finding MUST cite actual file paths, function names, and include code snippets. Do NOT fabricate. Mark inferences explicitly with [INFERRED].`;

// ─── DATA FLOW ANALYSIS ──────────────────────────────────────

const DECODE_DATA_FLOW = `You are a Data Architect analyzing data flows in a legacy codebase for modernization.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Produce a comprehensive data flow analysis:

### Data Entry Points
- HTTP endpoints (method, path, payload schema)
- Message queue consumers (queue name, message format)
- File imports (format, schedule, source)
- Database triggers and stored procedure inputs
- CLI/batch job inputs

### Data Transformations
- Business logic transformations (what changes, where, why)
- Data mapping between formats (e.g., DTO → Entity → DTO)
- Enrichment steps (lookups, joins, external data fetch)
- Validation and sanitization pipelines

### Data Persistence
- Database schemas with table/collection inventory
- Column types, constraints, indexes
- Generate a Mermaid ER diagram of the primary data model
- ORM mappings and their quirks
- Migration history and schema evolution

### Data Exit Points
- API response payloads
- Reports and exports (format, schedule, destination)
- Message queue producers (topic, payload)
- File outputs (format, destination)
- Webhook/callback payloads

### Data Flow Diagram
Generate a Mermaid flowchart showing the primary data flow:
- Entry point → Processing → Storage → Exit point
- Include all integration boundaries
- Mark synchronous vs. asynchronous flows

### Data Integrity Concerns
- Transactions and their boundaries
- Eventual consistency patterns
- Orphaned data and referential integrity gaps
- Data duplication across modules

Reference specific file paths, function names, and include code snippets for every finding.`;

// ─── WORKFLOW EXTRACTION ──────────────────────────────────────

const DECODE_WORKFLOW_EXTRACTION = `You are a Process Analyst extracting business workflows from a legacy codebase.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Map all end-to-end business workflows:

### User Workflows
For each user-facing workflow:
- **Workflow Name**: Descriptive name
- **Entry Point**: URL/endpoint/screen where the workflow starts
- **Actor**: User role(s) that trigger this workflow
- **Steps**: Numbered sequence of actions
- **Decision Points**: Branches based on conditions
- **Error Paths**: What happens when things fail
- **Exit Conditions**: How the workflow completes (success/failure/cancel)
- **Source Files**: Files involved in implementing this workflow

### System Workflows
For each background/automated workflow:
- **Trigger**: What initiates it (schedule, event, condition)
- **Processing Steps**: What it does
- **Dependencies**: External systems or data it needs
- **Failure Handling**: Retry logic, dead letter queues, alerting
- **Duration**: Typical and maximum execution time

### Workflow Diagrams
Generate Mermaid sequence diagrams for the 3-5 most critical workflows showing:
- Actor interactions
- Service-to-service calls
- Database operations
- External system interactions
- Error handling branches

### Cross-Workflow Dependencies
- Workflows that share data or state
- Workflows that must execute in sequence
- Workflows that conflict or deadlock
- Event chains (workflow A triggers workflow B)

### Scheduled Jobs & Batch Processing
- Cron jobs and their schedules
- Batch processing windows
- ETL pipelines
- Report generation jobs

Reference specific file paths, controller/handler functions, and include code snippets.`;

// ─── DOMAIN ENTITY MODELING ──────────────────────────────────

const DECODE_DOMAIN_ENTITIES = `You are a Domain Modeling specialist extracting entity models from a legacy codebase.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Document all domain entities and their relationships:

### Entity Inventory
For each core entity/model:
- **Entity Name**: Domain term used in code
- **Source File**: Path to model/entity class
- **Attributes**: Name, type, constraints, default values
- **Primary Key**: How instances are identified
- **Lifecycle States**: Status/state values and transitions
- **Invariants**: Rules that must always hold (e.g., "balance >= 0")

### Entity Relationships
- One-to-one, one-to-many, many-to-many mappings
- Ownership vs. reference relationships
- Cascade rules (delete, update)
- Lazy vs. eager loading patterns

### Entity Relationship Diagram
Generate a comprehensive Mermaid ER diagram showing:
- All entities with their key attributes
- Relationships with cardinality
- Foreign key references
- Inheritance/polymorphism hierarchies

### Aggregate Boundaries (DDD Perspective)
- Which entities form natural aggregates?
- What is the aggregate root for each?
- Transaction boundaries per aggregate
- Consistency requirements within vs. across aggregates

### Value Objects & Enums
- Value objects (Money, Address, DateRange, etc.)
- Enum types and their business meaning
- Constants and magic numbers with business significance

### Domain Language / Ubiquitous Language
- Business terms used in code (glossary)
- Mismatches between code names and business terms
- Abbreviations and their meanings

Reference specific model/entity files with paths and include attribute definitions.`;

// ─── INTEGRATION MAPPING ──────────────────────────────────────

const DECODE_INTEGRATION_MAPPING = `You are an Integration Architect mapping all external integration points in a legacy codebase.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Map every external integration point:

### External API Integrations
For each external API consumed:
- **Service Name**: What external service
- **Protocol**: REST, SOAP, GraphQL, gRPC
- **Base URL / Endpoint**: Configured location
- **Authentication**: API key, OAuth, certificate, etc.
- **Operations Used**: Which endpoints/methods are called
- **Data Exchanged**: Request/response shapes
- **Error Handling**: Timeout, retry, circuit breaker patterns
- **Source Files**: Where the integration is implemented

### Message Queues & Event Buses
- Queue/topic names and their purpose
- Message formats and schemas
- Producer and consumer locations in code
- Dead letter queue handling
- Message ordering and deduplication

### Shared Databases & File Exchanges
- Databases shared with other systems
- FTP/SFTP file exchanges
- Shared filesystems
- Email integrations (SMTP, templates)

### Authentication & SSO Providers
- Authentication mechanisms (LDAP, SAML, OAuth, custom)
- Session management approach
- Token lifecycle and refresh patterns
- External identity providers

### Integration Architecture Diagram
Generate a Mermaid diagram showing:
- The application at the center
- All external systems as nodes
- Integration type on each edge (REST, Queue, DB, File)
- Direction of data flow (inbound, outbound, bidirectional)

### Integration Risk Assessment
| Integration | Coupling Level | Replacement Difficulty | Migration Impact |
|-------------|---------------|----------------------|-----------------|
| ...         | Tight/Loose    | Easy/Medium/Hard     | Description     |

Reference specific configuration files, client classes, and integration code with paths.`;

// ─── CONSTRAINTS & TECHNICAL DEBT ─────────────────────────────

const DECODE_CONSTRAINTS_DEBT = `You are a Technical Debt Auditor analyzing constraints and debt in a legacy codebase for modernization planning.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Produce a comprehensive constraints and technical debt analysis:

### Technology Lock-ins
- Proprietary frameworks or libraries with no modern equivalent
- Vendor-specific APIs and SDKs
- Platform-specific code (OS, hardware, runtime)
- Licensed components and their terms

### Compliance & Regulatory Constraints
- PCI-DSS requirements visible in code (payment handling, card data)
- HIPAA/healthcare data patterns
- GDPR/privacy handling (consent, data deletion)
- SOX/financial controls
- Industry-specific regulations

### Technical Debt Inventory
| Debt Item | Location | Severity | Type | Impact on Modernization |
|-----------|----------|----------|------|------------------------|
| ...       | file:line | Critical/High/Medium/Low | Dead Code/Duplication/Hardcoded/Deprecated/Anti-pattern | Description |

Categories to check:
- **Dead Code**: Unreachable functions, unused imports, commented-out blocks
- **Duplicated Logic**: Copy-paste patterns, near-duplicate functions
- **Hardcoded Values**: Config values in source, magic numbers, embedded credentials
- **Deprecated Dependencies**: Libraries past EOL, deprecated API usage
- **Anti-patterns**: God classes, circular dependencies, tight coupling

### Open Questions for SME Clarification
| Question | Context | Priority | Related Files |
|----------|---------|----------|---------------|
| ...      | Why this needs clarification | High/Medium/Low | file paths |

### Assumptions Log
- Assumptions made during analysis
- Confidence level for each (High/Medium/Low)
- What would change if the assumption is wrong

### Migration Blockers
- Issues that must be resolved BEFORE modernization can proceed
- Priority order for resolution
- Estimated effort for each blocker

Reference specific files, code patterns, and configuration with paths. Do NOT fabricate — mark inferences with [INFERRED].`;

// ─── COMPOSITION ───────────────────────────────────────────────

/**
 * Composition prompt — merges all subtask outputs into a single DECODE document.
 */
export const DECODE_COMPOSITION = `You are the lead architect composing a comprehensive Intent Extraction / DECODE analysis document from specialist reports.

## SUBTASK RESULTS

{{subtaskResults}}

## COMPOSITION RULES

CRITICAL: Do NOT organize by file type (.twig, .vue, .css, .xml, .yml, .conf, etc.). File-type inventory is a SCAN concern.
DECODE organizes by BUSINESS INTENT: rules, workflows, data flows, entities, integrations.
If you produce sections like "## Twig Templates" or "## CSV Data Files", you have FAILED the composition.

1. Merge ALL specialist findings into a SINGLE coherent migration-ready requirements document
2. Use EXACTLY the H2 section structure from the REQUIRED SECTIONS list — no other H2 sections allowed
3. Use H3 for subsections within the required H2 sections
4. Resolve any contradictions between specialist reports (note where they disagree)
4. Ensure EVERY Mermaid diagram from specialist reports is included verbatim
5. Cross-reference findings across sections (e.g., business rules that relate to data flows)
6. Add an executive summary at the top and a prioritized open questions section at the end

## REQUIRED SECTIONS (ALL mandatory — do NOT skip any)

The final document MUST include ALL of these as H2 sections. Missing ANY section is a validation failure:

- **Executive Summary** — High-level overview of what the legacy system does and key modernization concerns
- **Business Rules** (with Rule ID inventory table and code citations)
- **Key Workflows** (with Mermaid sequence diagrams)
- **Data Flows** (with ER diagram and data flow diagram)
- **Domain Entities** (with entity inventory and relationship diagram)
- **Integration Points** (with integration architecture diagram)
- **Constraints & Assumptions** — Technology lock-ins (language versions, database engines, OS dependencies), licensing constraints (GPL, AGPL, proprietary), compliance flags (PCI, HIPAA, SOX, GDPR), SLAs, and deployment assumptions. Even if few constraints exist, document what you find.
- **Technical Debt** — Consolidated inventory table of: dead code, duplicated logic, hardcoded values, deprecated dependencies, god classes, missing tests, known bugs. Must be a standalone section, not embedded in Executive Summary.
- **Open Questions** — Specific ambiguities that need SME (Subject Matter Expert) clarification before modernization can proceed. List concrete questions with context. Every codebase has unknowns — if you found none, you didn't look hard enough.
- **Migration Readiness Assessment** (summary of blockers, risks, and recommended next steps)

## CRITICAL: ALL SECTIONS FIRST, THEN DETAIL

- You MUST produce ALL 10 H2 sections listed above. Skipping sections = validation failure.
- Strategy: If output space is limited, make Business Rules and Workflows more concise (top-level table only) to leave room for the bottom 5 sections.
- Include tables, Mermaid diagrams, and code references from specialists — but do NOT over-expand a single section at the expense of missing others.
- Every business rule must have its Rule ID and source file. Detailed code snippets are optional if space is tight.
- Business Rules should contain ONLY genuine domain rules (transactions, accounts, budgets, auth). Do NOT include config files, build tools, CI/CD, SCSS compilation, or documentation as business rules.
- Use verified ground truth for version numbers and counts. Do NOT paraphrase (e.g. write "PHP >=8.5" not "PHP 8.2+").

Word budget guide: Executive Summary ~400w, Business Rules ~4000w, Workflows ~1500w, Data Flows ~1000w, Domain Entities ~800w, Integration Points ~600w, Constraints ~400w, Technical Debt ~600w, Open Questions ~400w, Migration Readiness ~300w.

Produce the complete migration requirements document with ALL 10 sections.`;

// ─── SUBTASK TEMPLATE MAP ──────────────────────────────────────

export type DecodeSubtaskType =
  // Mandatory
  | 'business-rules-extraction'
  | 'data-flow-analysis'
  | 'workflow-extraction'
  | 'constraints-debt-analysis'
  // Conditional — Director adds based on SCAN complexity
  | 'domain-entity-modeling'
  | 'integration-mapping'
  | 'security-auth-analysis'
  | 'batch-job-analysis'
  | 'ui-frontend-analysis'
  | 'event-driven-analysis';

// ─── Templates for conditional subtask types ──────────────────

const DECODE_SECURITY_AUTH = `You are a Security Architect analyzing authentication, authorization, and security boundaries in a legacy codebase.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Map every security-related aspect:
1. **Authentication flows** — login, logout, session management, token handling, SSO/OAuth
2. **Authorization model** — roles, permissions, ACLs, RBAC/ABAC patterns
3. **Credential storage** — password hashing, secret management, API key handling
4. **Data encryption** — at-rest, in-transit, field-level encryption
5. **Security vulnerabilities** — SQL injection, XSS, CSRF, insecure deserialization
6. **Compliance requirements** — PCI-DSS, HIPAA, GDPR, SOC2 implications

For each finding, cite the exact source file and line. Tag with BR-{id} for traceability.`;

const DECODE_BATCH_JOBS = `You are a Systems Analyst specializing in batch processing and scheduled operations.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Document every batch/scheduled operation:
1. **Job inventory** — name, schedule (cron), trigger, frequency
2. **Data volumes** — rows/records processed, input/output sizes
3. **Dependencies** — what must complete before this job runs
4. **Error handling** — retry logic, dead-letter queues, alert thresholds
5. **SLA requirements** — maximum runtime, completion deadlines
6. **Modernization impact** — which jobs can become event-driven, which must stay batch

Tag each with BR-{id}. Include Mermaid timeline diagrams for complex job chains.`;

const DECODE_UI_FRONTEND = `You are a Frontend Architect analyzing client-side logic and user experience patterns.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Map the frontend layer:
1. **User journeys** — primary workflows from the user's perspective
2. **State management** — client-side state, session storage, caching
3. **Component inventory** — key UI components, their data dependencies
4. **Form validation** — client-side rules that duplicate or complement server rules
5. **API consumption** — which backend endpoints the frontend calls, data contracts
6. **Accessibility & i18n** — compliance requirements, locale handling

Tag business rules with BR-{id}. Include Mermaid diagrams for user journey flows.`;

const DECODE_EVENT_DRIVEN = `You are an Event Systems Architect analyzing messaging and event-driven patterns.

## CODEBASE CONTEXT
{{codebaseContext}}

## STAGE 1 SCAN OUTPUT
{{scanOutput}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Map every event/messaging pattern:
1. **Event inventory** — event names, producers, consumers, payloads
2. **Message queues** — queue names, protocols (AMQP, Kafka, SQS), configurations
3. **Event sourcing** — if present, document aggregate roots and event stores
4. **Pub/Sub patterns** — topics, subscriptions, fanout strategies
5. **Saga/choreography** — distributed transaction patterns, compensation flows
6. **Dead letters** — unprocessable message handling, retry policies

Tag each with BR-{id}. Include Mermaid sequence diagrams for complex event flows.`;

export const DECODE_SUBTASK_TEMPLATES: Record<DecodeSubtaskType, string> = {
  // Mandatory
  'business-rules-extraction': DECODE_BUSINESS_RULES,
  'data-flow-analysis': DECODE_DATA_FLOW,
  'workflow-extraction': DECODE_WORKFLOW_EXTRACTION,
  'constraints-debt-analysis': DECODE_CONSTRAINTS_DEBT,
  // Conditional
  'domain-entity-modeling': DECODE_DOMAIN_ENTITIES,
  'integration-mapping': DECODE_INTEGRATION_MAPPING,
  'security-auth-analysis': DECODE_SECURITY_AUTH,
  'batch-job-analysis': DECODE_BATCH_JOBS,
  'ui-frontend-analysis': DECODE_UI_FRONTEND,
  'event-driven-analysis': DECODE_EVENT_DRIVEN,
};

/**
 * Default subtask set when Director planning fails to parse.
 * Includes all 4 mandatory types for baseline coverage.
 */
export const DEFAULT_DECODE_SUBTASKS: Array<{
  type: DecodeSubtaskType;
  title: string;
  priority: number;
}> = [
  { type: 'business-rules-extraction', title: 'Business Rules & Domain Logic', priority: 1 },
  { type: 'data-flow-analysis', title: 'Data Flow Analysis', priority: 2 },
  { type: 'workflow-extraction', title: 'Workflow Extraction', priority: 3 },
  { type: 'constraints-debt-analysis', title: 'Constraints & Technical Debt', priority: 4 },
];
