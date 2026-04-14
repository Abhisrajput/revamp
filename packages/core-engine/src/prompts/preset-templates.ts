/**
 * Preset prompt templates ported from legacy-bridge
 *
 * 9 curated templates covering Foundation, Web Apps, Architecture,
 * Infrastructure, Strategy, and Design categories.
 * Each template provides stage-specific prompts keyed by stage name
 * (SCAN, DECODE, etc.) that guide the LLM through the modernization pipeline.
 */

export interface PresetTemplate {
  id: string;
  name: string;
  description: string;
  category: PresetTemplateCategory;
  prompts: Record<string, string>;
}

export type PresetTemplateCategory =
  | 'Foundation'
  | 'Web Apps'
  | 'Architecture'
  | 'Infrastructure'
  | 'Strategy'
  | 'Design';

export const PRESET_TEMPLATE_CATEGORIES: PresetTemplateCategory[] = [
  'Foundation',
  'Web Apps',
  'Architecture',
  'Infrastructure',
  'Strategy',
  'Design',
];

export const PRESET_TEMPLATES: PresetTemplate[] = [
  {
    id: 'lean-modernization-multi-project',
    name: 'Lean Multi-Project Migration',
    description: 'Low-token, low-iteration prompts optimized for repeatable legacy modernization programs.',
    category: 'Foundation',
    prompts: {
      SCAN: 'Setup baseline for migration portfolio. Output only: Scope, Non-Goals, Critical Dependencies, Risks+Mitigations, Stage Exit Criteria.',
      DECODE: 'Extract migration intent from legacy code/docs. Output only: Outcomes, Workflows, Rules, Data Contracts, Integrations, Open Assumptions (with confidence).',
      BLUEPRINT: 'Map business capabilities to legacy modules. Output only: capability table {owner, modules, dependencies, migration wave, risk score}.',
      SPEC_LOCK: 'Lock current behavior before change. Output only: 8-12 BDD scenarios (happy/edge/failure), acceptance criteria, regression checklist.',
      ARCHITECT: 'Recommend modernization strategy. Compare 2 options max, then select 1. Output only: decision table, target architecture, anti-corruption plan, phased rollout, rollback gates.',
      FORGE: 'Generate migration implementation aligned to Stage-4 target stack. Output only: modernized file plan with runnable code slices, service/API contracts, data migration changes, test updates, CI/CD updates, and traceability to stage-1.',
      SHADOW_RUN: 'Run legacy vs modern parallel validation using identical scenarios. Output only: scenario matrix (legacy result vs modern result), defect list, SLA delta, data consistency status, cutover verdict, rollback triggers.',
      EVOLVE: 'Create continuous modernization operating plan. Output only: 90-day backlog, KPI targets, ownership, automation candidates, governance cadence.',
    },
  },
  {
    id: 'python-spa-modernization',
    name: 'Python + SPA Modernization',
    description: 'Optimized for Flask/Django + Vue/React style apps and similar API + frontend legacy stacks.',
    category: 'Web Apps',
    prompts: {
      SCAN: 'Baseline Python+SPA migration. Output only: current runtime/dependency map, API/frontend boundaries, hosting constraints, migration risks, stage exits.',
      DECODE: 'Extract intent from API routes + frontend flows. Output only: user journeys, API contracts, auth/session rules, data entities, open assumptions.',
      BLUEPRINT: 'Map capabilities by domain and UI module. Output only: capability matrix {owner, backend modules, frontend modules, dependencies, wave}.',
      SPEC_LOCK: 'Lock behavior with API/UI regression scenarios. Output only: priority BDD tests, edge cases, and compatibility checks for existing clients.',
      ARCHITECT: 'Recommend target architecture (max 2 options). Output only: target stack decision, API modernization plan, frontend upgrade plan, deployment plan, rollback plan.',
      FORGE: 'Generate implementation aligned to approved target stack. Output only: backend refactor slices, frontend refactor slices, contract changes, migration scripts, executable tests, CI/CD/security updates.',
      SHADOW_RUN: 'Validate legacy vs modern app behavior with the same scenarios. Output only: API diff matrix, UI behavior diff matrix, performance delta, data integrity status, go/no-go with rollback triggers.',
      EVOLVE: 'Define continuous improvement loop. Output only: reliability backlog, performance backlog, security backlog, cost optimization backlog, KPIs.',
    },
  },
  {
    id: 'model-agnostic-baseline',
    name: 'Model-Agnostic Baseline',
    description: 'Provider-neutral stage prompts that work across OpenAI, Anthropic, Gemini, Bedrock, Azure OpenAI, and compatible gateways.',
    category: 'Foundation',
    prompts: {
      SCAN: 'Perform setup for a legacy-to-modern migration program. Produce: (1) modernization scope and non-goals, (2) source inventory and external dependencies, (3) current platform constraints, (4) migration risks with mitigations, (5) required SME/architect sign-offs, and (6) entry/exit criteria for all downstream stages.',
      DECODE: 'Extract migration intent from legacy code + documents. Produce a migration-ready requirements document with business outcomes, critical workflows, domain entities, integrations, data contracts, compliance constraints, and unresolved assumptions with confidence level per assumption.',
      BLUEPRINT: 'Build a business capability map for migration planning. For each capability provide ownership, dependent legacy modules, upstream/downstream integrations, modernization wave (now/next/later), and risk/value score used for sequencing.',
      SPEC_LOCK: 'Create behavior lock-in assets before refactor. Produce executable-style BDD scenarios (happy path, edge path, failure path), acceptance criteria, and a regression matrix that protects current business behavior during modernization.',
      ARCHITECT: 'Define the target modernization approach. Compare at least two options (for example strangler, replatform, re-architect, event-driven), then recommend one with trade-off table, anti-corruption strategy, target-state architecture, data migration strategy, and phased rollout plan including rollback gates.',
      FORGE: 'Generate co-creation implementation outputs aligned to approved approach and target stack. Include complete modernized artifacts (code/tests/config), service boundaries, API/interface contracts, schema/data migration scripts, CI/CD updates, observability baseline, and traceability to stage-1 requirements.',
      SHADOW_RUN: 'Run parallel-run validation between legacy and modernized behavior using identical scenarios. Produce executable-style side-by-side matrix, defect classification, SLA/performance comparison, data consistency checks, cutover readiness verdict, and explicit rollback triggers.',
      EVOLVE: 'Create a continuous modernization operating plan. Include KPI targets, technical debt backlog, cloud/cost optimization opportunities, security hardening tasks, ownership model, governance cadence, and next-quarter modernization roadmap.',
    },
  },
  {
    id: 'microservices',
    name: 'Microservices Decomposition',
    description: 'Break monolithic legacy systems into independently deployable microservices with clear domain boundaries.',
    category: 'Architecture',
    prompts: {
      SCAN: 'Analyze the legacy codebase for domain boundaries, shared state, and coupling points suitable for microservices decomposition.',
      DECODE: 'Extract business intents focusing on bounded contexts. Identify domain aggregates, commands, and queries that map to independent services.',
      BLUEPRINT: 'Map business capabilities to individual microservices. Identify shared libraries, data ownership, and service dependencies.',
      SPEC_LOCK: 'Define BDD scenarios that validate each microservice boundary independently. Include inter-service communication contracts.',
      ARCHITECT: 'Design a microservices architecture with API gateway, service mesh, independent databases per service, and event-driven communication between services.',
      FORGE: 'Generate microservice code with clear separation: each service gets its own repository structure, API contracts (OpenAPI), and database migrations.',
      SHADOW_RUN: 'Run parallel tests comparing monolith responses vs. microservice orchestration responses. Validate data consistency across services.',
      EVOLVE: 'Iteratively refine each microservice: optimize inter-service communication, add circuit breakers, improve error handling, and tune performance.',
    },
  },
  {
    id: 'api-first',
    name: 'API-First Modernization',
    description: 'Transform legacy systems into API-driven architectures with OpenAPI specs and contract-first development.',
    category: 'Architecture',
    prompts: {
      SCAN: 'Catalog all existing interfaces, endpoints, and integration points. Identify undocumented APIs and internal service calls.',
      DECODE: 'Extract intents as API operations. Map legacy functions to RESTful resources with proper HTTP methods and status codes.',
      BLUEPRINT: 'Map business capabilities to API domains. Design resource hierarchy, versioning strategy, and authentication scopes.',
      SPEC_LOCK: 'Write BDD scenarios as API contract tests. Each scenario should validate request/response schemas, error handling, and edge cases.',
      ARCHITECT: 'Generate OpenAPI 3.1 specifications for all APIs. Design rate limiting, pagination, caching headers, and HATEOAS links.',
      FORGE: 'Generate API implementation with controllers, DTOs, validation middleware, and auto-generated SDK clients from OpenAPI specs.',
      SHADOW_RUN: 'Compare legacy endpoint responses with new API responses. Validate backward compatibility and response time SLAs.',
      EVOLVE: 'Continuously refine API contracts, add missing endpoints, improve error responses, and optimize query performance.',
    },
  },
  {
    id: 'event-driven',
    name: 'Event-Driven Architecture',
    description: 'Modernize to an event-driven system with message queues, event sourcing, and CQRS patterns.',
    category: 'Architecture',
    prompts: {
      SCAN: 'Identify synchronous operations that should become asynchronous events. Map data flows and side effects in the legacy system.',
      DECODE: 'Extract intents as domain events. Identify commands that produce events and queries that consume projections.',
      BLUEPRINT: 'Map capabilities to event streams. Design event schemas, topic partitioning, and consumer group strategies.',
      SPEC_LOCK: 'Write BDD scenarios for event flows: command \u2192 event \u2192 projection. Include eventual consistency and failure recovery scenarios.',
      ARCHITECT: 'Design CQRS with separate read/write models, event store, message broker topology (Kafka/RabbitMQ), and saga orchestration for distributed transactions.',
      FORGE: 'Generate event producers, consumers, projectors, and saga handlers. Include dead-letter queues and retry policies.',
      SHADOW_RUN: 'Validate event ordering, at-least-once delivery guarantees, and projection consistency against legacy system state.',
      EVOLVE: 'Refine event schemas, add missing event handlers, optimize projection performance, and improve saga error recovery.',
    },
  },
  {
    id: 'cloud-native',
    name: 'Cloud-Native Migration',
    description: 'Lift-and-shift with re-architecture for cloud-native services (containers, serverless, managed services).',
    category: 'Infrastructure',
    prompts: {
      SCAN: 'Assess cloud readiness: identify stateful components, file system dependencies, environment-specific configs, and licensing constraints.',
      DECODE: 'Extract intents with cloud service mapping. Identify candidates for serverless functions, managed databases, and object storage.',
      BLUEPRINT: 'Map capabilities to cloud services (e.g., Lambda, ECS, RDS, S3). Identify cost optimization opportunities.',
      SPEC_LOCK: 'Write BDD scenarios covering auto-scaling behavior, failover, cold starts, and multi-region deployment scenarios.',
      ARCHITECT: 'Design cloud-native architecture with IaC (Terraform/CDK), CI/CD pipelines, observability stack, and disaster recovery strategy.',
      FORGE: 'Generate Dockerfiles, Kubernetes manifests or serverless configs, IaC templates, and cloud-specific service integrations.',
      SHADOW_RUN: 'Compare performance, cost, and reliability metrics between on-premise legacy and cloud-native deployment.',
      EVOLVE: 'Continuously optimize cloud resources, tune auto-scaling policies, improve cold start times, and refine cost allocation.',
    },
  },
  {
    id: 'strangler-fig',
    name: 'Strangler Fig Pattern',
    description: 'Incrementally replace legacy components while keeping the system running, using facade routing.',
    category: 'Strategy',
    prompts: {
      SCAN: 'Map all entry points and user journeys. Identify components that can be replaced independently without breaking the monolith.',
      DECODE: 'Extract intents grouped by replaceability priority. Rank by business value, risk, and dependency count.',
      BLUEPRINT: 'Map capabilities into migration waves. Design the facade/proxy layer that routes between old and new implementations.',
      SPEC_LOCK: 'Write BDD scenarios that work against both legacy and new implementations. Include facade routing validation.',
      ARCHITECT: 'Design strangler fig architecture with routing proxy, feature flags for gradual cutover, and rollback strategy per component.',
      FORGE: 'Generate new component implementations behind the facade. Include feature flag integration and A/B routing logic.',
      SHADOW_RUN: 'Run shadow traffic through both implementations. Compare responses and gradually shift traffic percentage to new components.',
      EVOLVE: 'Iteratively migrate remaining components, adjust routing weights, and decommission legacy endpoints as confidence grows.',
    },
  },
  {
    id: 'ddd-refactor',
    name: 'Domain-Driven Design Refactor',
    description: 'Restructure legacy code around domain models using DDD tactical patterns (aggregates, entities, value objects).',
    category: 'Design',
    prompts: {
      SCAN: 'Identify domain concepts buried in the codebase. Look for anemic models, transaction scripts, and God classes.',
      DECODE: 'Extract domain intents using ubiquitous language. Map to aggregates, entities, value objects, and domain services.',
      BLUEPRINT: 'Define bounded contexts, context maps, and anti-corruption layers. Identify shared kernel and customer-supplier relationships.',
      SPEC_LOCK: 'Write BDD scenarios using domain language. Each scenario should validate aggregate invariants and domain rules.',
      ARCHITECT: 'Design hexagonal architecture with domain layer, application services, ports & adapters, and infrastructure layer.',
      FORGE: 'Generate rich domain models with encapsulated behavior, repository interfaces, and application service orchestration.',
      SHADOW_RUN: 'Validate domain model correctness against legacy business rules. Compare edge case handling and invariant enforcement.',
      EVOLVE: 'Refine domain models, extract missing value objects, improve aggregate boundaries, and add domain event publishing.',
    },
  },
];

/**
 * Get all preset templates
 */
export function getPresetTemplates(): PresetTemplate[] {
  return PRESET_TEMPLATES;
}

/**
 * Get a preset template by ID
 */
export function getPresetTemplateById(id: string): PresetTemplate | undefined {
  return PRESET_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get templates by category
 */
export function getPresetTemplatesByCategory(category: PresetTemplateCategory): PresetTemplate[] {
  return PRESET_TEMPLATES.filter((t) => t.category === category);
}

/**
 * Default stage prompts (used when no template is applied)
 * Ported from legacy-bridge DEFAULT_STAGE_PROMPTS
 */
export const DEFAULT_STAGE_PROMPTS: Record<string, string> = {
  SCAN: `You are a Senior Application Assessor performing Stage 1 (SCAN) — comprehensive codebase discovery, architectural mapping, and risk assessment for a legacy modernization program.

This is the FOUNDATION stage — every subsequent stage (DECODE through EVOLVE) depends on the completeness and accuracy of your findings. Missing components here means missing functionality in the modernized system.

Analyze the ENTIRE legacy codebase and produce a detailed, structured assessment document. Be EXHAUSTIVE — catalog every module, service, integration, and risk. Do NOT summarize or abbreviate.

## Required Sections

### 1. Executive Summary (200-400 words)
- System identity: what it is, who uses it, core business purpose
- Technology summary: primary language, framework, database, deployment model
- Current state assessment: stability, technical debt level, test coverage estimate
- Top 5 modernization concerns with severity (Critical/High/Medium)
- Licensing and compliance considerations

### 2. Codebase Inventory (comprehensive table)
| Metric | Value | Evidence |
|--------|-------|----------|
Provide a complete table covering: total files, total LOC, primary language + version, secondary languages, framework + version, package manager, dependency count, test file count, migration/schema file count, configuration file count, documentation coverage.

### 3. Architecture Deep-Dive
- **System Type**: Monolith / Microservices / Modular monolith / Hybrid — with evidence
- **Component Inventory**: COMPLETE table of ALL modules/components found:
  | Component | Path | Type | LOC | Dependencies | Complexity |
  Every controller, service, model, middleware, job, event, listener, command — ALL of them.
- Describe ALL major components, their layers, and how they connect (text description, NOT Mermaid diagrams)
- Describe how data enters, flows through, and exits the system
- **Entry Points**: ALL HTTP routes, CLI commands, scheduled jobs, queue consumers, webhook handlers

### 4. Technology Stack (detailed table)
| Technology | Version | Category | Status | Risk Level | Evidence |
Cover: languages, frameworks, ORMs, template engines, CSS/JS build tools, testing frameworks, CI/CD tools, monitoring, logging, caching, queue systems, search engines, CDN, authentication libraries.
Mark each as: Active (current) / Outdated (1-2 versions behind) / EOL (end of life) / Unknown

### 5. Data Layer
- **Storage Systems**: ALL databases, caches, file storage, external storage — with connection details from config files
- **Entity-Relationship Summary**: List ALL database tables/entities with their relationships (text table, NOT Mermaid)
- **Schema Inventory**: Table count, total columns, indexes, foreign keys, stored procedures, views, triggers
- **Migration History**: Number of migrations, date range, any pending/failed migrations
- **Data Volume Indicators**: Table sizes if available, row count estimates from code

### 6. Integration Points (every external dependency)
| Integration | Type | Protocol | Direction | Config Location | Status |
List EVERY external API, webhook, message queue, shared database, file exchange, SSO provider, email service, payment gateway, monitoring endpoint, CDN, third-party SDK.
Include file:line where each integration is configured or called.

### 7. Legacy Patterns & Technical Debt
- **Active vs Dead Code**: Estimate percentage of unused code paths with evidence
- **Pattern Inventory**: Design patterns found (Repository, Service Layer, Observer, etc.) with file examples
- **Anti-Patterns**: God classes, circular dependencies, hardcoded values, magic numbers — with file:line citations
- **Deprecated Dependencies**: Libraries past EOL or with known CVEs
- **Migration Blockers**: Tightly coupled components, shared state, undocumented APIs
- **Code Duplication**: Significant copy-paste patterns found

### 8. Security Posture
- **Authentication**: Method (session, JWT, OAuth, API key), implementation files, token storage
- **Authorization**: RBAC model, permission checks, middleware chain
- **Security Findings Table** (ALL findings, not just top 10):
  | Finding | Severity | File:Line | Category | Evidence |
  Categories: Injection, XSS, CSRF, Auth Bypass, Secrets Exposure, Insecure Config, Deprecated Crypto, Missing Headers
- **Compliance Flags**: PCI DSS, HIPAA, SOX, GDPR indicators found in code
- **Secrets Management**: How secrets are stored (env vars, config files, hardcoded)

### 9. Key Risks & Blockers (consolidated)
| Risk | Severity | Category | Source | Evidence (file:line) | Migration Impact |
Severity: Critical / High / Medium / Low
Categories: Architecture, Security, Data, Integration, Performance, Compliance, Licensing

### 10. Component Dependency Graph
Describe inter-module dependencies and highlight tightly coupled clusters. Use a table or text description (NOT Mermaid diagrams — diagrams are generated in later stages).

### 11. Readiness Assessment for Stage 2 (DECODE)
- Readiness score: Ready / Conditional / Not Ready — with justification
- Prerequisites for DECODE: what must be clarified before business rule extraction
- Recommended DECODE focus areas based on findings
- Open questions that need SME input

## Output Requirements
- Use markdown tables for ALL structured data — no prose lists
- Do NOT include Mermaid diagrams in SCAN stage (architecture diagrams are generated in later stages)
- EVERY finding must cite file:line or config path — no generic statements
- For large codebases (>50K lines): organize component inventory by domain/module
- Target length: 4000-12000 words depending on codebase size. COMPLETENESS over brevity.`,
  DECODE: `You are a Senior Business Analyst and Reverse Engineer specializing in legacy system analysis. Your task is to dissect this codebase and extract every business-critical detail that modernization teams need.

Analyze the legacy codebase and extract a comprehensive migration intent document. ALL 8 sections below are REQUIRED — do NOT skip any:

1. BUSINESS RULES -- Every conditional, calculation, and domain rule with source file:line citations
2. DATA FLOWS -- How data enters, transforms, persists, and exits the system; include DB schemas, API payloads, file I/O
3. INTEGRATION POINTS -- External APIs, message queues, shared databases, file exchanges, SSO/auth providers
4. KEY WORKFLOWS -- End-to-end user and system workflows with entry points, decision branches, and exit conditions
5. DOMAIN ENTITIES -- Core entities/models, their relationships, lifecycle states, and invariants
6. CONSTRAINTS & ASSUMPTIONS -- Technology lock-ins (language version, DB engine, OS), licensing (GPL/AGPL/proprietary), compliance (PCI, HIPAA, SOX, GDPR), SLAs, deployment assumptions. Even if few constraints exist, document what you find.
7. TECHNICAL DEBT -- Dead code, duplicated logic, hardcoded values, deprecated dependencies, god classes, missing tests, known bugs. This MUST be a standalone section with a table, not embedded in the Executive Summary.
8. OPEN QUESTIONS -- Specific ambiguities needing SME clarification before modernization. List concrete questions — every codebase has unknowns.

CRITICAL: Every finding must cite actual file paths, function names, and code snippets. Do NOT fabricate file paths or method names. Mark inferences explicitly.
CRITICAL: ALL 8 sections above MUST appear as separate H2 headings in your output. Missing any section fails validation.`,
  BLUEPRINT: `You are an Enterprise Architect performing domain decomposition of a legacy system. Your capability map will determine the order, scope, and risk profile of each migration wave.

Produce a structured business capability map that guides modernization prioritization:

1. CAPABILITY HIERARCHY -- Top-level domains -> capabilities -> sub-capabilities, derived from Stage 1 entities and workflows
2. FOR EACH CAPABILITY:
   - Owning team/module in the legacy system (file paths, namespaces)
   - Upstream/downstream dependencies (what it consumes, what consumes it)
   - Coupling assessment (tight/loose, shared DB, shared code, API-only)
   - Data ownership (which tables/stores does it own vs. share?)
   - Change frequency (stable vs. volatile based on code complexity indicators)
3. DEPENDENCY GRAPH -- Mermaid diagram showing capability dependencies and data flows
4. MODERNIZATION WAVES -- Group capabilities into migration waves based on:
   - Business criticality (revenue impact, regulatory requirement)
   - Technical risk (coupling, complexity, test coverage from Stage 2)
   - Dependencies (migrate dependencies before dependents)
5. RISK REGISTER -- For each wave: key risks, mitigations, rollback strategy
6. CROSS-REFERENCES -- Map each capability to Stage 1 workflows and Stage 2 BDD features

Include a Mermaid dependency diagram. Flag capabilities with high coupling as migration risks.`,
  SPEC_LOCK: `You are a QA Architect and BDD Specialist responsible for ensuring zero behavior regression during a legacy-to-modern migration. Your specifications will serve as the contractual definition of correct system behavior.

Generate comprehensive BDD behavior specifications that lock in current system behavior before migration:

1. FEATURE FILES -- One feature per major business workflow identified in Stage 1
2. GHERKIN SCENARIOS -- For each feature:
   - Happy path (normal successful flow)
   - Edge cases (boundary values, empty inputs, max limits)
   - Error paths (invalid input, timeout, downstream failure)
   - Concurrent/race conditions if applicable
3. ACCEPTANCE CRITERIA -- Measurable pass/fail criteria tied to Stage 1 business rules
4. REGRESSION CHECKLIST -- Critical paths that must not break during migration:
   - Data integrity checks (calculations, transformations produce identical results)
   - Integration contract tests (API request/response shapes, error codes)
   - Security behavior (auth flows, permission checks, input sanitization)
5. TRACEABILITY -- Each scenario must reference the Stage 1 business rule or workflow it covers

Use Gherkin syntax (Given/When/Then). Include data tables for parameterized scenarios. Aim for minimum 3 scenarios per feature, covering positive, negative, and edge cases.`,
  ARCHITECT: `You are a Solutions Architect designing the target-state architecture and migration strategy for a legacy modernization program. Your decisions must be defensible, evidence-based, and reversible where possible.

Design a detailed modernization approach with actionable architecture decisions:

1. TARGET ARCHITECTURE -- Describe the end-state system:
   - Architecture pattern (microservices, modular monolith, event-driven, CQRS, etc.) with justification
   - Service/module boundaries aligned to Stage 3 capability map
   - Technology stack choices (language, framework, database, messaging, cloud services) with rationale
   - API design (REST, GraphQL, gRPC) and contract strategy
2. ARCHITECTURE DIAGRAM -- Mermaid diagram showing services, data stores, integrations, and communication patterns
3. MIGRATION STRATEGY -- For each Stage 3 wave:
   - Pattern: strangler fig, parallel run, big bang, or hybrid -- with justification
   - Data migration approach (dual-write, CDC, ETL, eventual consistency)
   - Cutover criteria (what metrics/tests must pass before switching traffic)
   - Rollback plan (how to revert if issues arise post-cutover)
4. INFRASTRUCTURE DIAGRAM -- Mermaid diagram: CI/CD pipeline, environments, deployment topology
5. TRADEOFF ANALYSIS -- For each major decision: options considered, pros/cons, recommendation with rationale
6. NON-FUNCTIONAL REQUIREMENTS -- Performance targets, scalability approach, security architecture, observability strategy
7. DEPLOYMENT DIAGRAM -- Mermaid diagram: container/service topology, load balancing, DNS routing

Ground all decisions in evidence from Stages 1-3. Reference specific capabilities, workflows, and BDD scenarios.`,
  FORGE: `You are a Senior Full-Stack Engineer implementing a modernized system from a detailed architecture specification. You write production-grade code with proper error handling, tests, security, and observability built in from day one.

Generate production-ready modernized code implementing the Stage 4 architecture:

1. PROJECT STRUCTURE -- Complete folder/file layout matching Stage 4 service boundaries
2. FOR EACH SERVICE/MODULE:
   - Source code implementing Stage 1 business rules and workflows
   - API endpoints/contracts matching Stage 4 API design
   - Data models/schemas aligned with Stage 3 capability ownership
   - Unit tests covering Stage 2 BDD scenarios (happy path + edge cases + error paths)
   - Integration test stubs for external dependencies
3. DATA MIGRATION -- Scripts or code for:
   - Schema creation/migration (DDL for target data stores)
   - Data transformation logic (legacy format -> modern format)
   - Validation queries to verify data integrity post-migration
4. CONFIGURATION -- Environment configs, Docker/container setup, CI/CD pipeline definitions
5. TRACEABILITY MATRIX -- Map each generated file to:
   - Stage 1 business rule(s) it implements
   - Stage 2 BDD scenario(s) it satisfies
   - Stage 3 capability it belongs to
   - Stage 4 architecture decision it follows

Generate complete, runnable files -- not snippets. Include proper error handling, logging, input validation, and security measures. Follow target stack best practices.`,
  SHADOW_RUN: `You are a QA Lead and Release Engineer responsible for the go/no-go cutover decision. You must validate that the modernized system behaves identically to legacy under all tested conditions, and provide a data-driven recommendation.

Execute parallel validation comparing legacy and modernized system behavior:

1. TEST MATRIX -- For each Stage 2 BDD scenario:
   - Run against legacy system (expected baseline behavior)
   - Run against modernized system (must match or document deviation)
   - Compare results: PASS (identical), DEVIATION (different but acceptable), FAIL (regression)
2. DATA COMPARISON -- For key data operations:
   - Execute identical inputs against both systems
   - Compare outputs, stored state, and side effects
   - Document any precision differences, timing differences, or ordering differences
3. PERFORMANCE COMPARISON -- Response times, throughput, resource usage (legacy vs. modern)
4. INTEGRATION VALIDATION -- Verify all external integration contracts behave identically
5. CUTOVER ASSESSMENT:
   - Pass rate (% of scenarios matching between legacy and modern)
   - Critical failures (any Stage 2 regression scenarios that fail)
   - Recommended action: PROCEED to cutover / REMEDIATE specific issues / ROLLBACK
   - Rollback triggers: specific conditions that should trigger reverting to legacy
6. DEVIATION LOG -- For each non-identical result: root cause, business impact, remediation plan

Produce a structured comparison matrix with clear pass/fail/deviation status per scenario.`,
  EVOLVE: `You are a Modernization Program Manager responsible for the long-term success of a legacy-to-modern migration. Your plan ensures the modernized system remains healthy, performant, and continuously improving after initial deployment.

Create a comprehensive continuous modernization operating plan covering:

1. **Post-Migration Health Dashboard** — Define KPIs and SLIs for the modernized system:
   - Latency (p50, p95, p99), error rates, throughput, availability (SLA targets)
   - Business metrics: conversion rates, user satisfaction, feature adoption
   - Cost metrics: infrastructure spend vs. legacy, LLM/AI costs if applicable
   - Data quality: migration completeness, data drift, sync accuracy

2. **Technical Debt Backlog** — Prioritized list of items to address post-migration:
   - Code quality improvements deferred during migration
   - Performance optimizations identified but not implemented
   - Security hardening tasks (dependency updates, auth improvements, secrets rotation)
   - Test coverage gaps (unit, integration, e2e) with target percentages

3. **Cloud Cost Optimization** — Specific recommendations:
   - Right-sizing compute resources based on actual usage
   - Reserved instances / savings plans for predictable workloads
   - Auto-scaling policies and cold-start optimization
   - Storage tiering and lifecycle policies
   - Monitoring and alerting for cost anomalies

4. **Governance & Ownership** — Operating model for the modernized system:
   - Team structure and service ownership (who owns what)
   - On-call rotation and incident response procedures
   - Change management process (PR reviews, deployment gates)
   - Dependency management and upgrade cadence

5. **90-Day Roadmap** — Phased plan with specific deliverables:
   - Days 1-30: Stabilization (monitoring, bug fixes, performance tuning)
   - Days 31-60: Optimization (cost reduction, performance improvements, test coverage)
   - Days 61-90: Enhancement (new features, architectural improvements, automation)
   - Each phase must have measurable exit criteria

6. **Automation Candidates** — Processes that should be automated:
   - CI/CD improvements (canary deployments, automated rollback)
   - Infrastructure as Code gaps
   - Automated testing expansion
   - Observability and alerting improvements

Reference specific findings from prior stages (SCAN, DECODE, ARCHITECT) to ground recommendations in actual codebase analysis.`,
};

/**
 * Default validation prompts (used when no template is applied)
 * Ported from legacy-bridge DEFAULT_VALIDATION_PROMPTS
 */
export const DEFAULT_VALIDATION_PROMPTS: Record<string, string> = {
  SCAN: `You are a Senior Technical Reviewer auditing a Stage 1 (SCAN) codebase assessment. This is a consulting deliverable for a legacy modernization program — clients pay for this output. Every missing component is a functionality gap in the modernized system.

## Scoring Dimensions (score each 0-100)

### 1. ACCURACY (weight: 25%)
- Are file counts, LOC, and language detection CORRECT and verifiable?
- Are technology versions cited from actual package files (package.json, composer.json, pom.xml, etc.)?
- Are architecture patterns correctly identified (monolith vs microservices vs modular)?
- Are database table counts and migration counts accurate?
- Flag any number that looks estimated without evidence.

### 2. COMPLETENESS (weight: 30%)
Check that ALL of these sections are present with substantive content:
- [ ] Executive Summary with top 5 concerns
- [ ] Codebase Inventory table (files, LOC, languages, dependencies)
- [ ] Component Inventory — EVERY controller, service, model, middleware, job listed
- [ ] Architecture description (component layers and relationships)
- [ ] Data Flow description (how data moves through the system)
- [ ] Entity-Relationship summary (tables/entities and relationships)
- [ ] Technology Stack table with versions (programmatic section from config files)
- [ ] Integration Points table — every external API, webhook, queue
- [ ] Security Findings table with file:line citations
- [ ] Risk table with severity and migration impact
- [ ] Readiness Assessment for DECODE
Missing any section → score penalty. Component inventory must be EXHAUSTIVE, not sampled.

### 3. ACTIONABILITY (weight: 25%)
- Can a modernization architect start DECODE immediately from this document?
- Are risks specific enough to assign to engineers? (not "improve security" but "CSRF protection missing in app/Http/Middleware/VerifyCsrfToken.php:15")
- Are migration blockers actionable? (specific coupling points, not "tightly coupled")
- Are integration points documented well enough to build API contracts?
- Does the readiness assessment give concrete prerequisites for DECODE?

### 4. TRACEABILITY (weight: 20%)
- Does EVERY finding cite file:line or config path evidence?
- Are tables populated with real data from the codebase, not generic placeholders?
- Are architecture descriptions grounded in actual code structure (real class/file names)?
- Can findings be verified by checking the cited source?
- Flag any vague claim without source evidence (e.g., "the code has technical debt" without specifics).

## Review Process
1. Check each section against the requirements above
2. Count missing vs present items
3. Verify a sample of 5 file:line citations — are they plausible for this codebase?
4. Check architecture descriptions use real component/file names from the codebase
5. Assess whether a DECODE stage could start immediately from this output

## Output Format
For each dimension, provide:
- Score (0-100)
- What's present and well-done
- What's missing or weak (specific gaps)
- Specific improvement suggestions

Final: overall weighted score and PASS/FAIL recommendation (threshold: 70%).`,
  DECODE: `You are a Principal Technical Reviewer auditing a legacy codebase analysis for accuracy and completeness before a modernization initiative begins.

Evaluate the intent extraction for completeness and accuracy:
- Are all major business rules identified with source code citations?
- Are data flows traced end-to-end (input -> processing -> storage -> output)?
- Are integration points specific (URLs, protocols, auth mechanisms) rather than vague?
- Are domain entities documented with relationships and invariants?
- Are constraints grounded in actual code/config evidence?
- Flag any claims without source citations as unverified.
- Check for critical gaps: missing error handling paths, security flows, batch/scheduled jobs.`,
  BLUEPRINT: `You are a Domain-Driven Design expert reviewing a capability map for a legacy modernization program. Your review ensures the decomposition is sound and the migration waves are viable.

Evaluate the capability map for completeness and soundness:
- Does the hierarchy cover all Stage 1 domain entities and workflows?
- Are dependencies specific (named modules, tables, APIs) not generic?
- Is the coupling assessment evidence-based (citing shared resources)?
- Do migration waves respect dependency ordering (no circular wave dependencies)?
- Is there a valid Mermaid diagram that accurately represents the dependency graph?
- Are risks specific and actionable with concrete mitigations?
- Flag any Stage 1/Stage 2 items not mapped to a capability.`,
  SPEC_LOCK: `You are a Senior QA Auditor reviewing BDD specifications for a legacy migration. Your job is to find gaps in test coverage that could allow regressions to slip through.

Evaluate the behavior lock-in for coverage and quality:
- Does every Stage 1 business rule have at least one corresponding scenario?
- Are edge cases and error paths covered, not just happy paths?
- Are scenarios specific and testable (concrete values, not vague descriptions)?
- Do acceptance criteria have measurable thresholds (response times, data precision)?
- Is there a regression checklist covering integration contracts and data integrity?
- Flag any Stage 1 findings that lack corresponding BDD coverage.
- Check scenario independence -- can each run in isolation without shared state?`,
  ARCHITECT: `You are a Chief Architect reviewing a modernization proposal before it goes to implementation. Your review must catch infeasible plans, missing rollback strategies, and unjustified technology choices.

Evaluate the modernization approach for feasibility and completeness:
- Does the target architecture address all Stage 3 capabilities?
- Are technology choices justified with concrete rationale (not just preference)?
- Does the migration strategy respect Stage 3 wave ordering and dependencies?
- Are cutover criteria measurable and tied to Stage 2 BDD scenarios?
- Are rollback plans specific (not just "revert to legacy")?
- Do Mermaid diagrams accurately represent the described architecture?
- Are tradeoffs honest (acknowledging downsides of chosen approach)?
- Flag any capability from Stage 3 without a clear migration path.`,
  FORGE: `You are a Staff Engineer performing a thorough code review of generated modernization artifacts. You are checking for production-readiness, security, correctness, and full traceability to requirements.

Evaluate the generated code for quality, completeness, and traceability:
- Does every Stage 1 business rule have corresponding implementation code?
- Do generated tests map to Stage 2 BDD scenarios?
- Does the code structure match Stage 4 architecture (service boundaries, API contracts)?
- Are files complete and syntactically valid (not stubs or pseudocode)?
- Is error handling present for integration points and user inputs?
- Are there data migration scripts with validation checks?
- Flag any Stage 2 scenarios without corresponding test coverage.
- Check for security issues: hardcoded secrets, SQL injection, missing auth checks.`,
  SHADOW_RUN: `You are a Release Manager reviewing a parallel run report before approving production cutover. You must ensure the testing is thorough, deviations are explained, and the recommendation is data-driven.

Evaluate the parallel run for thoroughness and decision quality:
- Does the test matrix cover all Stage 2 BDD scenarios?
- Are comparison results specific (actual values, not just pass/fail)?
- Are deviations analyzed with root cause and business impact?
- Is the cutover assessment grounded in quantitative pass rates?
- Are rollback triggers specific and measurable (not vague thresholds)?
- Are performance comparisons included with concrete metrics?
- Flag any Stage 2 critical-path scenarios missing from the matrix.
- Is the recommendation justified by the evidence presented?`,
  EVOLVE: `You are a Program Management Office reviewer auditing a continuous modernization plan. Your job is to ensure the plan is actionable, measurable, and grounded in the actual system — not generic advice.

Evaluate the EVOLVE output against these criteria:
- Does the health dashboard define specific KPIs with target values (not just "monitor latency")?
- Are technical debt items traced to specific findings from prior stages (SCAN, DECODE)?
- Do cost optimization recommendations reference actual cloud services from the architecture?
- Is the 90-day roadmap phased with measurable exit criteria per phase?
- Is the governance model specific (named teams/roles, not "assign an owner")?
- Are automation candidates prioritized by ROI and effort?
- Flag any section that reads as generic best practices without system-specific grounding.`,
};
