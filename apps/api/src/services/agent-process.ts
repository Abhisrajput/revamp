/**
 * Agent Process Definitions — structured execution methodology for each pipeline stage.
 *
 * When a Jira issue is assigned to an agent, this module:
 *   1. Detects which pipeline stage the task maps to (from labels/summary)
 *   2. Returns the stage-specific methodology, tools, output format, and system prompt
 *   3. The agent executes following this process, producing structured deliverables
 *
 * Pipeline:  SCAN → DECODE → BLUEPRINT → SPEC_LOCK → ARCHITECT → FORGE → SHADOW_RUN → EVOLVE
 */

// ─── STAGE DETECTION ────────────────────────────────────────────

export interface StageProcess {
  stage: string;
  stageIndex: number;
  methodology: string;
  outputFormat: string;
  tools: string[];
  maxIterations: number;
  systemPromptAddition: string;
}

const STAGE_KEYWORDS: Record<string, string[]> = {
  SCAN:        ["scan", "analyze", "codebase", "legacy patterns", "tech stack", "discovery"],
  DECODE:      ["decode", "extract", "business rules", "business logic", "domain", "requirements"],
  BLUEPRINT:   ["blueprint", "architecture", "microservice", "design", "service boundary", "target"],
  SPEC_LOCK:   ["spec_lock", "spec-lock", "bdd", "gherkin", "behavior", "test", "acceptance"],
  ARCHITECT:   ["architect", "adr", "decision record", "api contract", "infrastructure"],
  FORGE:       ["forge", "generate", "code generation", "implement", "transform", "modernize"],
  SHADOW_RUN:  ["shadow_run", "shadow-run", "parallel run", "validate", "equivalence", "compare"],
  EVOLVE:      ["evolve", "continuous", "optimize", "enhance", "iterate", "improve"],
};

/** Detect pipeline stage from Jira issue labels + summary. */
export function detectStage(labels: string[], summary: string): string {
  const searchText = [...labels, summary].join(" ").toLowerCase();

  // Check labels first (most explicit signal)
  for (const label of labels) {
    const upper = label.toUpperCase();
    if (upper in STAGE_KEYWORDS) return upper;
  }

  // Check keywords in summary + labels
  for (const [stage, keywords] of Object.entries(STAGE_KEYWORDS)) {
    if (keywords.some(kw => searchText.includes(kw))) return stage;
  }

  // Default to SCAN for unknown tasks
  return "SCAN";
}

// ─── STAGE PROCESSES ────────────────────────────────────────────

const STAGE_PROCESSES: Record<string, StageProcess> = {
  SCAN: {
    stage: "SCAN",
    stageIndex: 0,
    tools: ["read_file", "search_code", "list_files", "file_stats"],
    maxIterations: 10,
    methodology: `
## SCAN Stage Methodology

You are executing the SCAN stage of the REVAMP modernization pipeline.

### Objective
Perform deep analysis of the legacy codebase to understand its structure, technology stack, patterns, and technical debt.

### Process
1. **Explore Structure**: Use list_files to map the project layout (directories, file counts, key areas)
2. **Identify Tech Stack**: Read config files (package.json, composer.json, pom.xml, etc.) to determine frameworks, dependencies, versions
3. **Analyze Patterns**: Use search_code to find common patterns — MVC structure, ORM usage, API endpoints, database queries
4. **Detect Legacy Debt**: Search for deprecated APIs, security anti-patterns (raw SQL, eval, globals), hardcoded values
5. **Map Dependencies**: Identify external integrations, third-party services, database connections
6. **Assess Complexity**: Count files by type, LOC by language, largest/most complex modules

### Required Output Sections
- **Executive Summary** (2-3 sentences)
- **Tech Stack** (languages, frameworks, versions, databases)
- **Architecture Overview** (patterns, layers, entry points)
- **File Structure** (key directories with purpose)
- **Legacy Patterns Found** (with file:line citations)
- **Technical Debt** (prioritized list with severity)
- **Dependencies & Integrations** (external services, APIs, databases)
- **Modernization Readiness Score** (1-10 with justification)
`,
    outputFormat: "Markdown report with tables and file:line citations",
    systemPromptAddition: "You have read-only access to the codebase via tools. Use them extensively — explore at least 10-15 files before drawing conclusions. Never guess; always verify with search_code and read_file.",
  },

  DECODE: {
    stage: "DECODE",
    stageIndex: 1,
    tools: ["read_file", "search_code", "list_files", "file_stats"],
    maxIterations: 12,
    methodology: `
## DECODE Stage Methodology

You are executing the DECODE stage — extracting business rules and domain logic from legacy code.

### Objective
Extract every business rule, validation, calculation, and workflow from the codebase with full traceability.

### Process
1. **Find Business Logic**: Search for conditional logic (if/switch), validation functions, calculation methods
2. **Extract Rules**: For each rule found, assign a unique ID (BR-001, BR-002, etc.)
3. **Document Each Rule**:
   - **ID**: BR-xxx
   - **Name**: Short descriptive name
   - **Type**: Validation | Calculation | Workflow | Authorization | Constraint
   - **Source**: file:line reference
   - **Condition**: The exact conditional logic
   - **Description**: Plain English explanation
   - **Confidence**: High (explicit code) | Medium (inferred) | Low (assumed)
4. **Map Data Flows**: Trace how data moves through the system (input → processing → output)
5. **Identify Domain Entities**: List all entities, their relationships, and key fields
6. **Find Hardcoded Values**: Magic numbers, business constants, configuration buried in code

### Required Output Sections
- **Business Rules Catalog** (table with ID, name, type, source, description, confidence)
- **Domain Entity Map** (entities with fields and relationships)
- **Data Flow Diagram** (text-based, showing input → processing → output)
- **Hardcoded Values** (value, location, meaning, risk, recommendation)
- **Calculation Formulas** (extracted formulas with sources)
- **Integration Points** (external systems, APIs, databases touched)
`,
    outputFormat: "Structured markdown with BR-xxx IDs and file:line citations for every rule",
    systemPromptAddition: "Every business rule MUST have a file:line citation. No generic advice — only specific findings from the actual code. Use search_code to find validation patterns, calculation functions, and conditional branching.",
  },

  BLUEPRINT: {
    stage: "BLUEPRINT",
    stageIndex: 2,
    tools: ["read_file", "search_code", "list_files"],
    maxIterations: 8,
    methodology: `
## BLUEPRINT Stage Methodology

You are designing the target modernized architecture.

### Objective
Design the target cloud-native architecture that preserves all extracted business rules while modernizing the technology stack.

### Process
1. **Define Service Boundaries**: Group business capabilities into bounded contexts / microservices
2. **Design API Contracts**: Define REST/gRPC endpoints for each service
3. **Plan Data Migration**: Map legacy schema to modern schema, define ETL strategy
4. **Choose Tech Stack**: Recommend languages, frameworks, databases for each service
5. **Define Integration Patterns**: Event-driven, sync/async, saga patterns
6. **Plan Infrastructure**: Containerization, orchestration, CI/CD, monitoring

### Required Output Sections
- **Target Architecture Diagram** (Mermaid or text-based)
- **Service Catalog** (name, responsibility, tech stack, APIs)
- **Data Migration Strategy** (legacy → modern schema mapping)
- **API Contract Definitions** (endpoints, methods, request/response)
- **Infrastructure Plan** (Docker, K8s, cloud services)
- **Risk Assessment** (migration risks with mitigation strategies)
`,
    outputFormat: "Architecture document with Mermaid diagrams and ADR format",
    systemPromptAddition: "Reference the SCAN and DECODE outputs when available. Every architectural decision must trace back to a business capability or rule from the DECODE stage.",
  },

  SPEC_LOCK: {
    stage: "SPEC_LOCK",
    stageIndex: 3,
    tools: ["read_file", "search_code", "list_files", "write_file"],
    maxIterations: 10,
    methodology: `
## SPEC_LOCK Stage Methodology

You are writing BDD specifications that lock in the exact behavior of the legacy system.

### Objective
Create Gherkin feature files that capture every business rule as a testable specification. These specs validate that the modernized system behaves identically to the legacy system.

### Process
1. **Map Rules to Scenarios**: For each BR-xxx from DECODE, write one or more Gherkin scenarios
2. **Write Feature Files**: Use standard Gherkin syntax (Feature, Scenario, Given/When/Then)
3. **Include Edge Cases**: Boundary conditions, error paths, null/empty inputs
4. **Add Data Tables**: For parameterized scenarios with multiple test cases
5. **Define Step Definitions**: Outline the step definition structure

### Required Output Format
Each feature file must follow:
\`\`\`gherkin
Feature: [Business Capability Name]
  As a [role]
  I want [action]
  So that [benefit]

  # BR-001: [Rule Name]
  Scenario: [Descriptive scenario name]
    Given [precondition]
    When [action]
    Then [expected result]
\`\`\`

### Required Deliverables
- **Feature files** (one per business capability)
- **Scenario count** and coverage matrix (rules → scenarios)
- **Step definition outlines**
`,
    outputFormat: "Gherkin .feature file content with BR-xxx traceability",
    systemPromptAddition: "Every scenario MUST reference a BR-xxx business rule from the DECODE stage. Include both happy path and error scenarios. Use concrete test data, not placeholders.",
  },

  ARCHITECT: {
    stage: "ARCHITECT",
    stageIndex: 4,
    tools: ["read_file", "search_code", "list_files", "write_file"],
    maxIterations: 8,
    methodology: `
## ARCHITECT Stage Methodology

You are producing Architecture Decision Records (ADRs) and detailed technical specifications.

### Process
1. **Write ADRs**: For each key architectural decision, document context, decision, consequences
2. **Define API Specs**: OpenAPI/Swagger definitions for each service
3. **Design Database Schema**: DDL for the target database
4. **Plan Security**: Authentication, authorization, data protection
5. **Define Monitoring**: Metrics, alerts, logging strategy

### ADR Format
\`\`\`
# ADR-xxx: [Decision Title]
## Status: Accepted
## Context: [Why this decision is needed]
## Decision: [What we decided]
## Consequences: [Positive and negative impacts]
\`\`\`
`,
    outputFormat: "ADRs + OpenAPI specs + DDL schemas",
    systemPromptAddition: "Every ADR must reference specific business requirements from earlier stages.",
  },

  FORGE: {
    stage: "FORGE",
    stageIndex: 5,
    tools: ["read_file", "search_code", "list_files", "write_file", "edit_file", "shell_exec"],
    maxIterations: 15,
    methodology: `
## FORGE Stage Methodology

You are generating the modernized code. You have full read/write access to the workspace.

### Process
1. **Set Up Project Structure**: Create directories, config files, package manifests
2. **Generate Models/Entities**: Database models, DTOs, validation schemas
3. **Implement Business Logic**: Port each BR-xxx rule into clean, tested code
4. **Build API Layer**: Controllers/handlers, middleware, routing
5. **Write Tests**: Unit tests for each business rule, integration tests for API endpoints
6. **Add Configuration**: Environment config, database connections, logging

### Requirements
- Every generated file must have a header comment referencing which BR-xxx rules it implements
- Follow the target stack's idioms and best practices
- Include proper error handling and input validation
- Generate both source code and corresponding test files
`,
    outputFormat: "Generated source code files with tests",
    systemPromptAddition: "You have write access to the workspace. Generate actual files using write_file. Every file must be complete and runnable — no TODOs or placeholder code.",
  },

  SHADOW_RUN: {
    stage: "SHADOW_RUN",
    stageIndex: 6,
    tools: ["read_file", "search_code", "list_files", "shell_exec"],
    maxIterations: 10,
    methodology: `
## SHADOW_RUN Stage Methodology

You are validating behavioral equivalence between legacy and modernized systems.

### Process
1. **Run BDD Tests**: Execute the Gherkin specs from SPEC_LOCK against the new code
2. **Compare Outputs**: Verify that identical inputs produce identical outputs
3. **Check Edge Cases**: Test boundary conditions, error handling, null inputs
4. **Performance Comparison**: Benchmark key operations
5. **Generate Report**: Pass/fail matrix with detailed diff for failures
`,
    outputFormat: "Test execution report with pass/fail matrix",
    systemPromptAddition: "Run actual tests if possible using shell_exec. Report concrete pass/fail results, not hypothetical analysis.",
  },

  EVOLVE: {
    stage: "EVOLVE",
    stageIndex: 7,
    tools: ["read_file", "search_code", "list_files", "write_file", "edit_file"],
    maxIterations: 10,
    methodology: `
## EVOLVE Stage Methodology

You are optimizing and enhancing the modernized codebase for production readiness.

### Process
1. **Code Review**: Review generated code for quality, security, performance
2. **Optimize Performance**: Identify and fix N+1 queries, missing indexes, inefficient algorithms
3. **Harden Security**: Apply OWASP best practices, input validation, authentication
4. **Improve Observability**: Add logging, metrics, health checks, tracing
5. **Documentation**: Generate API docs, deployment guide, runbook
`,
    outputFormat: "Code improvements + documentation",
    systemPromptAddition: "Focus on production readiness. Every recommendation must be actionable with specific code changes.",
  },
};

/** Get the full process definition for a stage. */
export function getStageProcess(stage: string): StageProcess {
  return STAGE_PROCESSES[stage] || STAGE_PROCESSES.SCAN;
}

/** Build the complete system prompt for an agent executing a Jira task. */
export function buildAgentPrompt(
  agentSystemPrompt: string,
  process: StageProcess,
  jiraKey: string,
  summary: string,
  description: string,
  labels: string[],
  existingComments: string,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    agentSystemPrompt,
    "",
    "---",
    "",
    process.systemPromptAddition,
    "",
    `You are executing the **${process.stage}** stage of the REVAMP modernization pipeline.`,
    `You have access to these tools: ${process.tools.join(", ")}`,
    `Maximum iterations: ${process.maxIterations}`,
    "",
    process.methodology,
  ].join("\n");

  const userPrompt = [
    `## Jira Task: ${jiraKey} — ${summary}`,
    `**Stage:** ${process.stage} (index ${process.stageIndex})`,
    `**Labels:** ${labels.join(", ") || "none"}`,
    description ? `\n## Description\n${description}` : "",
    existingComments ? `\n## Prior Context (from Jira comments)\n${existingComments}` : "",
    `\n## Expected Output Format`,
    process.outputFormat,
    `\n## Instructions`,
    `Follow the ${process.stage} methodology above. Use your tools to explore the codebase.`,
    `Produce a complete, structured deliverable — not a summary or plan.`,
  ].filter(Boolean).join("\n");

  return { systemPrompt, userPrompt };
}
