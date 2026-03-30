/**
 * Prompt templates for each pipeline stage
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';

export interface PromptTemplate {
  stageId: string;
  template: string;
  variables: string[];
  description: string;
  examples?: string[];
}

export const promptTemplates: Record<PipelineStageName, PromptTemplate> = {
  [PipelineStageName.SCAN]: {
    stageId: PipelineStageName.SCAN,
    description:
      'Inventory the codebase — catalog files, technologies, architecture, and key risks',
    variables: [
      'codebaseDescription',
      'repositoryUrl',
      'deploymentInfo',
      'teamSize',
      'mainTechnologies',
    ],
    template: `You are performing Stage 1 (SCAN) of an 8-stage modernization pipeline. Your job is to INVENTORY what exists — not to plan fixes or propose modernization strategies.

**Codebase Description:**
{{codebaseDescription}}

**Repository:** {{repositoryUrl}}
**Deployment:** {{deploymentInfo}}
**Team Size:** {{teamSize}}
**Main Technologies:** {{mainTechnologies}}

Produce a clean, readable analysis document with these sections:

## Executive Summary
3-5 sentences: what this system is, its current state, and the top concerns.

## Codebase Overview
Summary table: total files, LOC, languages, active vs. inactive status.

## Architecture
- System type (monolith, client-server, etc.)
- Component inventory table (name, path, type, LOC, status, description)
- ONE Mermaid diagram showing component relationships

## Technology Stack
- Languages table (language, version, LOC, %, status)
- Frameworks & libraries table
- Build/deployment tooling table
- Version risk summary (current vs. EOL)

## Security Posture
- Auth & session management summary
- Top security findings table (severity, location, category)
- Compliance flags table

## Key Risks & Blockers
Top 8-12 risks from the analysis, in a prioritized table.

## Readiness for Stage 2
Brief assessment of what the next stage (Intent Extraction) should focus on.

IMPORTANT — DO NOT include:
- Modernization plans, timelines, or cost estimates (that's Stage 5)
- Code refactoring suggestions (that's Stage 6)
- BDD/test scenarios (that's Stage 4)
- Business capability mapping (that's Stage 3)
- Remediation steps or "how to fix" instructions

Use TABLES instead of long prose. Target 2000-4000 words. Cite file paths for every finding.`,

    examples: [
      'Java-based e-commerce monolith with Spring Boot, deployed on AWS',
      'Legacy .NET application with tight coupling and manual deployment',
    ],
  },

  [PipelineStageName.DECODE]: {
    stageId: PipelineStageName.DECODE,
    description: 'Extract business intent, rules, and workflows from legacy code',
    variables: [
      'architecture',
      'businessDomains',
      'currentServices',
      'scalingPains',
    ],
    template: `Based on the current architecture, extract business intent:

**Current Architecture:**
{{architecture}}

**Business Domains:**
{{businessDomains}}

**Existing Services/Modules:**
{{currentServices}}

**Scaling Pain Points:**
{{scalingPains}}

For each identified capability, provide:
1. Capability name and description
2. Owned data entities
3. Key operations and workflows
4. Current location in codebase
5. Dependencies on other capabilities
6. Estimated complexity (Low/Medium/High)
7. Performance requirements
8. Scalability requirements
9. Security sensitivity
10. Priority for extraction

Organize by business domain and extraction priority.`,

    examples: [
      'User management: authentication, profiles, permissions',
      'Order processing: cart, checkout, fulfillment',
      'Inventory: stock levels, reservations, suppliers',
    ],
  },

  [PipelineStageName.BLUEPRINT]: {
    stageId: PipelineStageName.BLUEPRINT,
    description:
      'Map business capabilities to bounded contexts, define service boundaries, and plan migration waves',
    variables: [
      'decodeOutput',
      'scanOutput',
      'targetStack',
      'targetCloud',
    ],
    template: `You are performing Stage 3 (BLUEPRINT) of an 8-stage modernization pipeline. Your job is to map the business capabilities extracted by DECODE into bounded contexts and service boundaries for the modernized architecture.

**DECODE Output (business rules, workflows, entities):**
{{decodeOutput}}

**SCAN Output (codebase structure):**
{{scanOutput}}

**Target Stack:** {{targetStack}}
**Target Cloud:** {{targetCloud}}

---

Produce a complete BLUEPRINT document with these EXACT sections:

## Capability Inventory

List every business capability discovered in DECODE:

| ID | Capability | Domain | Current Module(s) | Business Rules | Data Entities | Complexity | Priority |
|----|-----------|--------|-------------------|----------------|---------------|------------|----------|
| CAP-1 | User Authentication | Identity | auth.module, login.cbl | BR-1, BR-2, BR-3 | User, Session, AuditLog | Medium | High |
| CAP-2 | Order Processing | Commerce | order.module, calc.cbl | BR-5, BR-6, BR-7 | Order, OrderLine, Payment | High | High |
| CAP-3 | Report Generation | Reporting | rpt-*.cbl | BR-12 | ReportDef, ReportOutput | Low | Medium |

Requirements:
- EVERY business rule from DECODE must map to at least one capability
- Reference BR-{id} from DECODE for traceability to SPEC_LOCK
- Complexity: Low / Medium / High based on rule count and integration points
- Priority: High / Medium / Low for migration ordering

## Bounded Contexts

Group capabilities into bounded contexts (DDD). For each:

### Context: Identity & Access
**Capabilities:** CAP-1, CAP-4
**Owned Entities:** User, Role, Permission, Session, AuditLog
**API Surface:** REST — login, logout, token refresh, user CRUD, role assignment
**Events Published:** UserCreated, UserLocked, SessionExpired
**Events Consumed:** None (context root)
**Data Store:** PostgreSQL (users schema)
**Team:** Identity Team (2-3 engineers)

Produce 3-8 bounded contexts depending on codebase size.

## Service Boundary Decisions

For each context boundary, justify with a decision record:

| Decision | Boundary | Rationale | Tradeoff |
|----------|----------|-----------|----------|
| Split auth from user profile | Identity ↔ Profile | Auth has strict latency SLA; profiles are CRUD-heavy | Extra network hop for profile-enriched auth tokens |
| Keep order + payment together | Commerce (single service) | Transactional consistency required for order→payment | Larger service, harder to scale independently |

## Capability Map (Mermaid)

\`\`\`mermaid
graph TD
    subgraph Identity["Identity & Access"]
        CAP1[User Auth]
        CAP4[Role Management]
    end
    subgraph Commerce["Commerce"]
        CAP2[Order Processing]
        CAP5[Payment]
    end
    subgraph Reporting["Reporting"]
        CAP3[Report Generation]
    end
    Commerce --> Identity
    Reporting --> Commerce
\`\`\`

## Dependency Graph (Mermaid)

Show module-level dependencies from the legacy codebase:

\`\`\`mermaid
graph LR
    AUTH[auth.module] --> DB[(User DB)]
    ORDER[order.module] --> AUTH
    ORDER --> CALC[calc.module]
    ORDER --> DB2[(Order DB)]
    RPT[report.module] --> ORDER
    RPT --> DB2
\`\`\`

## Migration Waves

Plan the extraction order:

| Wave | Timeline | Services | Dependencies | Risk | Go/No-Go Criteria |
|------|----------|----------|-------------|------|-------------------|
| Wave 1 | Sprint 1-3 | Identity & Access | None (foundational) | Low | Auth API passes all BR-1 scenarios |
| Wave 2 | Sprint 4-7 | Commerce | Identity service live | Medium | Order lifecycle BR-5 through BR-10 pass |
| Wave 3 | Sprint 8-10 | Reporting | Commerce service live | Low | Report output matches legacy byte-for-byte |

Requirements:
- Foundation services (auth, config) go first
- Each wave has specific BDD scenario pass criteria (reference SPEC_LOCK)
- No circular migration dependencies

## Data Ownership Matrix

| Entity | Owner Context | Shared Read By | Sync Strategy |
|--------|-------------|----------------|---------------|
| User | Identity | Commerce, Reporting | API call |
| Order | Commerce | Reporting | Event (OrderCreated) |
| Payment | Commerce | Reporting | Event (PaymentCompleted) |

---

IMPORTANT:
- Every DECODE business rule must appear in the Capability Inventory (BR-{id} references)
- Bounded contexts must cover ALL capabilities — nothing left unmapped
- Migration waves must reference BDD scenarios from SPEC_LOCK as go/no-go criteria
- Include TWO Mermaid diagrams minimum (capability map + dependency graph)
- Justify every boundary split/merge decision in the decisions table`,

    examples: [
      'COBOL payroll: 4 contexts (Identity, Payroll, Benefits, Reporting), 3 migration waves',
      'RPG order system: 3 contexts (Auth, Commerce, Fulfillment), Wave 1 = Auth (2 sprints)',
    ],
  },

  [PipelineStageName.SPEC_LOCK]: {
    stageId: PipelineStageName.SPEC_LOCK,
    description: 'Lock behavioral specs as BDD/Gherkin .feature files with test execution and traceability',
    variables: [
      'businessRules',
      'workflows',
      'dataEntities',
      'integrations',
      'bddFramework',
      'targetStack',
    ],
    template: `You are performing Stage 4 (SPEC_LOCK) of an 8-stage modernization pipeline. Your job is to lock the behavioral contracts of the legacy system as **Cucumber-compatible Gherkin .feature files** that will govern the modernized implementation.

**Business Rules from DECODE:**
{{businessRules}}

**Workflows from DECODE:**
{{workflows}}

**Data Entities:**
{{dataEntities}}

**Integration Points:**
{{integrations}}

**BDD Framework:** {{bddFramework}}
**Target Stack:** {{targetStack}}

---

Produce a complete SPEC_LOCK document with these EXACT sections:

## Feature Files

For EACH business capability, generate a complete Gherkin .feature file inside a fenced code block tagged with the file path. Use REAL Cucumber-compatible syntax:

\`\`\`gherkin
# File: features/authentication/login.feature
@BR-1 @critical
Feature: User Authentication — Login
  As a system user
  I want to authenticate with valid credentials
  So that I can access the system securely

  Background:
    Given the authentication service is available
    And the user database is populated

  @happy-path
  Scenario: Successful login with valid credentials
    Given a registered user with email "admin@acme.com" and password "SecurePass123"
    When the user submits login credentials
    Then the system returns a valid session token
    And the session expiry is set to 30 minutes
    And an audit log entry is created for "LOGIN_SUCCESS"

  @edge-case
  Scenario Outline: Login rejected for invalid credentials
    Given a registered user with email "<email>"
    When the user submits password "<password>"
    Then the system returns error code "<error_code>"
    And the failed attempt counter increments by 1

    Examples:
      | email            | password     | error_code     |
      | admin@acme.com   | wrong        | INVALID_CREDS  |
      | unknown@acme.com | SecurePass123| USER_NOT_FOUND |
      | locked@acme.com  | SecurePass123| ACCOUNT_LOCKED |

  @known-bug @BR-1.3
  Scenario: Account lockout after 5 failed attempts
    Given a registered user with 4 failed login attempts
    When the user submits an invalid password
    Then the account status changes to "LOCKED"
    And a lockout notification email is sent
\`\`\`

Requirements for .feature files:
- EVERY business rule from DECODE MUST be covered by at least one scenario
- Use tags: @BR-{id} for business rule traceability, @happy-path, @edge-case, @error-handling, @known-bug, @data-integrity, @security, @performance, @concurrency
- Use Scenario Outlines with Examples tables for parameterized cases
- Use Background blocks for shared preconditions within a feature
- Include concrete test data values, not placeholders
- Cover: happy paths, error paths, boundary conditions, concurrency, data integrity
- Target: minimum 20 scenarios across all features, minimum 4 feature files

## Test Execution Results

Simulate running each scenario and report results in a table:

| # | Feature | Scenario | Tags | Result | Duration | Failure Reason |
|---|---------|----------|------|--------|----------|----------------|
| 1 | Login | Successful login | @BR-1 @happy-path | PASS | 23ms | — |
| 2 | Login | Invalid credentials | @BR-1 @edge-case | PASS | 15ms | — |
| 3 | Login | Account lockout | @BR-1.3 @known-bug | FAIL | 45ms | VSAM UNLOCK not present in source at login-quit path |

After the table, summarize: "X passed / Y failed out of Z scenarios (pass rate: N%)"

For FAILED scenarios, explain the SPECIFIC reason — reference actual code constructs, missing logic, or data format mismatches from the DECODE analysis. Do NOT use generic reasons.

## Validation Findings

List validation findings — issues discovered while writing BDD specs that reveal gaps, ambiguities, or risks in the legacy behavior. Categorize as Critical / Warning / Info:

| # | Severity | Finding | Evidence | Recommendation |
|---|----------|---------|----------|----------------|
| 1 | Critical | Missing error handling for concurrent session limits | No session cap logic in auth module | Add @concurrency scenario for max-sessions |
| 2 | Warning | PIC 9(10) overflow — amount field truncates at 10 digits | COBOL COMPUTE in CALC-TOTAL | Add boundary test for amounts > 9,999,999,999 |

Target: 8-16 findings minimum. Reference actual code paths from DECODE.

## Traceability Matrix

Map EVERY business rule from DECODE to its covering scenarios:

| Rule ID | Rule Description | Feature File | Scenarios | Coverage | Regression Check |
|---------|-----------------|--------------|-----------|----------|------------------|
| BR-1 | User authentication | login.feature | #1, #2, #3 | Full | Critical path |
| BR-2 | Order calculation | order-calc.feature | #7, #8, #9, #10 | Partial — missing currency edge case | Data integrity |

Coverage values: Full, Partial (with gap description), Missing
EVERY rule from DECODE must appear. No rule left unmapped.

## Regression Checklist

Organize regression test categories:

### Critical Path Tests
- [ ] Authentication and session management
- [ ] Core transaction processing
- [ ] Data persistence and retrieval

### Data Integrity Tests
- [ ] Numeric precision and overflow handling
- [ ] Date/time format conversions
- [ ] Character encoding and special characters

### Integration Contract Tests
- [ ] API request/response schema compliance
- [ ] Event payload structure
- [ ] Database schema compatibility

### Security Behavior Tests
- [ ] Authorization and role-based access
- [ ] Input validation and injection prevention
- [ ] Audit trail completeness

### Performance Baseline Tests
- [ ] Response time thresholds for critical operations
- [ ] Concurrent user load handling
- [ ] Batch processing throughput

---

IMPORTANT RULES:
- Every scenario MUST trace to a business rule from DECODE via @BR-{id} tags
- Do NOT invent generic scenarios — every scenario must reference specific legacy behavior
- Use concrete data values from the legacy system analysis, not abstract placeholders
- Failed test results must cite specific code-level evidence
- The traceability matrix must account for EVERY business rule from DECODE
- Feature files must be valid Cucumber/Gherkin syntax — parseable by standard BDD frameworks
- Target: 4+ feature files, 20+ scenarios, 8+ validation findings, complete traceability`,

    examples: [
      'COBOL payroll system: CALC-WAGES paragraph → BDD scenarios for hourly, salary, overtime',
      'RPG order processing: ORDHDR/ORDDET files → scenarios for order lifecycle + edge cases',
    ],
  },

  [PipelineStageName.ARCHITECT]: {
    stageId: PipelineStageName.ARCHITECT,
    description: 'Design target architecture, technology decisions, phased migration roadmap with risk register',
    variables: [
      'blueprintOutput',
      'decodeOutput',
      'targetStack',
      'targetCloud',
    ],
    template: `You are performing Stage 5 (ARCHITECT) of an 8-stage modernization pipeline. Your job is to design the target architecture and migration roadmap based on the BLUEPRINT bounded contexts and DECODE business rules.

**BLUEPRINT Output (bounded contexts, service boundaries, migration waves):**
{{blueprintOutput}}

**DECODE Output (business rules, workflows, entities):**
{{decodeOutput}}

**Target Stack:** {{targetStack}}
**Target Cloud:** {{targetCloud}}

---

Produce a complete ARCHITECT document with these EXACT sections:

## Target Architecture

Describe the modernized system architecture:

### Component Inventory

| Component | Type | Technology | Bounded Context | Responsibilities | Scaling Strategy |
|-----------|------|-----------|-----------------|-----------------|-----------------|
| auth-service | Microservice | {{targetStack}} | Identity | Login, JWT, RBAC | Horizontal (stateless) |
| order-service | Microservice | {{targetStack}} | Commerce | Order CRUD, lifecycle | Horizontal + CQRS |
| api-gateway | Gateway | Kong/Envoy | Cross-cutting | Routing, rate limiting, auth | Horizontal |
| event-bus | Infrastructure | Kafka/SQS | Cross-cutting | Async events between services | Partition-based |
| postgres-primary | Database | PostgreSQL 16 | Commerce | Order, Payment data | Read replicas |

### Architecture Diagram (Mermaid)

\`\`\`mermaid
graph TD
    Client[Client Apps] --> GW[API Gateway]
    GW --> AUTH[Auth Service]
    GW --> ORDER[Order Service]
    GW --> RPT[Report Service]
    AUTH --> DB1[(Auth DB)]
    ORDER --> DB2[(Order DB)]
    ORDER --> MQ[Event Bus]
    RPT --> MQ
    RPT --> DB2
\`\`\`

### Communication Patterns
- Synchronous: REST/gRPC between gateway and services
- Asynchronous: Events for cross-context data flow
- Specify which calls are sync vs async and why

## Technology Decision Matrix

For each technology choice, compare alternatives:

| Category | Chosen | Alternative 1 | Alternative 2 | Rationale |
|----------|--------|--------------|---------------|-----------|
| Language | Java 21 + Spring Boot 3 | Go + Chi | Node.js + Fastify | Team expertise, enterprise ecosystem |
| Database | PostgreSQL 16 | MySQL 8 | MongoDB 7 | ACID required, existing schema compatibility |
| Message Queue | Apache Kafka | AWS SQS | RabbitMQ | Event sourcing capability, partition ordering |
| Container | Docker + Kubernetes | ECS Fargate | Docker Swarm | Multi-cloud portability, HPA support |
| CI/CD | GitHub Actions | GitLab CI | Jenkins | Existing GitHub org, marketplace actions |
| Observability | OpenTelemetry + Grafana | Datadog | New Relic | Open standards, cost control |

Requirements:
- At least 6 technology categories
- At least 2 alternatives per category
- Concrete rationale (not "industry standard" — cite specific project needs)

## Migration Roadmap

Phased migration with milestones:

| Phase | Sprint Range | Deliverables | Go/No-Go Gate | Dependencies | Risk Level |
|-------|-------------|-------------|---------------|-------------|------------|
| Phase 0: Foundation | Sprint 1-2 | CI/CD pipeline, container infra, auth service skeleton | Pipeline deploys to staging | None | Low |
| Phase 1: Identity | Sprint 3-5 | Auth service live, JWT integration | All BR-1 scenarios pass in SHADOW_RUN | Phase 0 | Medium |
| Phase 2: Commerce | Sprint 6-10 | Order + Payment services | BR-5 through BR-10 pass, performance within 20% of legacy | Phase 1 | High |
| Phase 3: Reporting | Sprint 11-13 | Report service, legacy decommission | Full BDD suite passes, byte-for-byte report output match | Phase 2 | Medium |

Requirements:
- Reference SPEC_LOCK BDD scenarios as go/no-go criteria
- Reference BLUEPRINT migration waves
- Include Phase 0 for infrastructure setup
- Sprint ranges (not vague "Q1" timelines)

## Risk Register

| # | Risk | Probability | Impact | Severity | Mitigation | Owner | Contingency |
|---|------|------------|--------|----------|------------|-------|-------------|
| 1 | Data migration corruption | Medium | Critical | High | Checksums per table, parallel validation | Data Team | Rollback to legacy, re-run migration |
| 2 | Performance regression | Medium | High | High | Load test each phase, p95 budget | Backend Lead | Circuit breaker, fallback to legacy endpoint |
| 3 | Team skill gap (new stack) | High | Medium | Medium | Training sprint, pair programming | Tech Lead | Extended Phase 0, contractor support |
| 4 | Scope creep | Medium | Medium | Medium | Strict phase gates, change board | PM | Defer to post-cutover backlog |

Target: 6-10 risks minimum.

## Cost Model

| Resource | Monthly Cost | Annual Cost | Notes |
|----------|-------------|-------------|-------|
| Compute (3 services × 2 replicas) | $X,XXX | $XX,XXX | t3.medium or equivalent |
| Database (PostgreSQL RDS) | $XXX | $X,XXX | Multi-AZ, 100GB |
| Message Queue | $XXX | $X,XXX | Kafka managed or SQS |
| CI/CD | $XXX | $X,XXX | GitHub Actions minutes |
| Monitoring | $XXX | $X,XXX | Grafana Cloud or self-hosted |
| **Total** | **$X,XXX** | **$XX,XXX** | — |

Compare to estimated legacy hosting cost.

## Infrastructure Diagram (Mermaid)

\`\`\`mermaid
graph TD
    subgraph Cloud["{{targetCloud}}"]
        subgraph VPC["VPC"]
            LB[Load Balancer] --> K8S[Kubernetes Cluster]
            K8S --> SVC1[Auth Pod]
            K8S --> SVC2[Order Pod]
            K8S --> SVC3[Report Pod]
        end
        DB[(RDS PostgreSQL)]
        CACHE[(Redis/ElastiCache)]
        MQ[Kafka/SQS]
    end
    K8S --> DB
    K8S --> CACHE
    K8S --> MQ
\`\`\`

---

IMPORTANT:
- Reference BLUEPRINT bounded contexts by name when assigning components
- Reference SPEC_LOCK BDD scenarios (BR-{id}) as phase gate criteria
- Technology decisions must cite specific project needs, not generic best practices
- TWO Mermaid diagrams minimum (architecture + infrastructure)
- Cost estimates must be concrete dollar amounts, not "varies"
- Risk register must include probability, impact, AND mitigation`,

    examples: [
      'COBOL → Java/Spring: 4 phases, 13 sprints, $8K/mo cloud, 8 risks',
      'RPG → Node.js: 3 phases, 10 sprints, Kubernetes on AWS, $5K/mo',
    ],
  },

  [PipelineStageName.FORGE]: {
    stageId: PipelineStageName.FORGE,
    description: 'AI co-creation — generate production-ready code aligned to target architecture',
    variables: [
      'modernizationPlan',
      'stakeholderInput',
      'constraints',
      'budget',
    ],
    template: `Generate implementation code based on modernization plan:

**Current Modernization Plan:**
{{modernizationPlan}}

**Stakeholder Input and Concerns:**
{{stakeholderInput}}

**Updated Constraints:**
{{constraints}}

**Available Budget:**
{{budget}}

Create production-ready implementation including:
1. Source code files with proper error handling
2. Unit and integration tests
3. Configuration and environment setup
4. Database migration scripts
5. API endpoint implementations
6. Event handlers and message consumers

For each generated component:
1. Acceptance criteria and definition of done
2. Detailed task breakdown
3. Resource requirements
4. Risk mitigation steps
5. Success metrics
6. Rollback procedures

Ensure all code is:
- Production-grade with proper error handling
- Fully tested with unit and integration tests
- Aligned to Stage 4 target architecture
- Following best practices for the chosen tech stack`,

    examples: [
      'Address security concerns in extraction plan',
      'Adjust timeline based on team availability',
    ],
  },

  [PipelineStageName.SHADOW_RUN]: {
    stageId: PipelineStageName.SHADOW_RUN,
    description:
      'Run SPEC_LOCK BDD scenarios against both legacy and modernized systems — validate behavioral equivalence',
    variables: [
      'bddScenarios',
      'forgeOutput',
      'targetStack',
      'targetCloud',
    ],
    template: `You are performing Stage 7 (SHADOW_RUN) of an 8-stage modernization pipeline. Your job is to simulate running EVERY BDD scenario from SPEC_LOCK against both the legacy system and the FORGE-generated modernized code, then produce a behavioral equivalence report.

**BDD Scenarios from SPEC_LOCK:**
{{bddScenarios}}

**FORGE Generated Code:**
{{forgeOutput}}

**Target Stack:** {{targetStack}}
**Target Cloud:** {{targetCloud}}

---

Produce a complete SHADOW_RUN validation report with these EXACT sections:

## Test Matrix

For EVERY scenario from SPEC_LOCK, simulate execution against both systems and report results:

| # | Scenario | Tags | Legacy Result | Modern Result | Match | Duration (L/M) | Notes |
|---|----------|------|---------------|---------------|-------|-----------------|-------|
| 1 | Successful login | @BR-1 @happy-path | PASS | PASS | MATCH | 23ms / 12ms | — |
| 2 | Invalid credentials | @BR-1 @edge-case | PASS | PASS | MATCH | 15ms / 8ms | — |
| 3 | Account lockout after 5 attempts | @BR-1.3 @known-bug | PASS | FAIL | DEVIATION | 45ms / — | Modern code missing lockout counter reset on successful login |
| 4 | Concurrent session limit | @BR-2 @concurrency | PASS | PASS | MATCH | 92ms / 55ms | Modern uses Redis-backed sessions |
| 5 | Order total with tax | @BR-5 @data-integrity | PASS (1042.57) | PASS (1042.56) | DEVIATION | 18ms / 9ms | Rounding difference: legacy COBOL COMPUTE rounds half-up, modern IEEE 754 rounds half-even |

Requirements:
- EVERY scenario from SPEC_LOCK must appear — no omissions
- Match values: MATCH (identical behavior), DEVIATION (different result), REGRESSION (modern fails where legacy passes), IMPROVEMENT (modern passes where legacy had known bug)
- For DEVIATION/REGRESSION: include specific output values or error messages
- Duration column shows both legacy and modern execution times
- Notes explain WHY deviations occur, citing specific code

After the table, summarize: "X MATCH / Y DEVIATION / Z REGRESSION / W IMPROVEMENT out of N scenarios"

## Behavioral Comparison

For each DEVIATION and REGRESSION, provide detailed side-by-side analysis:

### DEVIATION #1: Account lockout after 5 attempts
**Scenario:** @BR-1.3 — Account lockout after 5 failed attempts
**Severity:** BLOCKING

| Aspect | Legacy System | Modern System |
|--------|--------------|---------------|
| Input | 5th failed login for user "admin@acme.com" | 5th failed login for user "admin@acme.com" |
| Expected Output | Account status → LOCKED, notification sent | Account status → LOCKED, notification sent |
| Actual Output | Account status → LOCKED, email queued | Account status → ACTIVE, no notification |
| Root Cause | Legacy resets counter in COBOL paragraph RESET-LOGIN-CTR | Modern \`AuthService.validateCredentials()\` missing counter logic |
| Fix Required | Add failed attempt tracking to \`src/services/auth.ts:validateCredentials()\` |

Provide one comparison block per DEVIATION/REGRESSION. Include:
- Exact input/output values
- Root cause referencing specific legacy code AND modern generated code
- Specific fix required (file path + function name)

## Performance Comparison

Compare response times and throughput:

| Operation | Legacy (p50/p95/p99) | Modern (p50/p95/p99) | Delta | Status |
|-----------|---------------------|---------------------|-------|--------|
| User login | 23ms / 45ms / 120ms | 12ms / 22ms / 55ms | -48% | FASTER |
| Order creation | 150ms / 280ms / 500ms | 85ms / 140ms / 250ms | -43% | FASTER |
| Report generation | 2.1s / 4.5s / 8.0s | 3.2s / 6.1s / 12.0s | +52% | SLOWER |
| Batch processing (1K records) | 45s | 12s | -73% | FASTER |

After the table, provide:
- Overall performance verdict: "Modern system is X% faster/slower on average"
- Any operations that are SLOWER and why (e.g., "Report generation slower due to N+1 query in modern ORM — fixable")
- Resource utilization comparison (CPU, memory, DB connections)

## Deviation Analysis

Summarize all deviations with severity and recommended actions:

| # | Deviation | Severity | Category | Root Cause | Fix Effort | Blocking? |
|---|-----------|----------|----------|------------|------------|-----------|
| 1 | Lockout counter missing | Critical | Logic gap | Auth migration incomplete | 2h | YES |
| 2 | Rounding difference (0.01) | Warning | Numeric precision | IEEE 754 vs COBOL arithmetic | 4h | NO |
| 3 | Report generation slower | Warning | Performance | N+1 query pattern | 3h | NO |

Severity levels: Critical (behavior change affecting correctness), Warning (minor difference, non-blocking), Info (cosmetic/logging difference)

## Cutover Verdict

Provide a clear GO / NO-GO recommendation:

### Verdict: **NO-GO** (with conditions)

**Summary Metrics:**
- Scenarios tested: 28
- MATCH: 24 (85.7%)
- DEVIATION: 3 (10.7%)
- REGRESSION: 1 (3.6%)
- Blocking issues: 1
- Estimated fix effort: 9 hours

**Blocking Issues (must fix before cutover):**
1. BR-1.3: Account lockout counter missing — users won't be locked after failed attempts

**Non-Blocking Issues (fix post-cutover):**
1. Rounding difference in order totals (0.01 tolerance acceptable for Phase 1)
2. Report generation performance (optimize queries in sprint 2)

**Confidence Score:** 72/100

**Recommendation:**
Fix the 1 blocking issue (estimated 2h), re-run shadow validation, then proceed to cutover with GO decision. Non-blocking deviations can be addressed in the first maintenance sprint.

---

IMPORTANT RULES:
- Every SPEC_LOCK scenario MUST appear in the test matrix — no omissions
- DEVIATION/REGRESSION entries need specific code-level root causes, not generic descriptions
- Performance data must include p50/p95/p99 percentiles, not just averages
- The cutover verdict must be definitive: GO, NO-GO, or NO-GO WITH CONDITIONS
- Reference actual file paths from FORGE output when describing fixes
- Confidence score 0-100 based on: match rate, severity of deviations, fix complexity`,

    examples: [
      'COBOL payroll system: 43 scenarios, 38 MATCH, 4 DEVIATION, 1 REGRESSION → NO-GO (1 blocking)',
      'RPG order processing: 26 scenarios, 26 MATCH → GO with 92/100 confidence',
    ],
  },

  [PipelineStageName.EVOLVE]: {
    stageId: PipelineStageName.EVOLVE,
    description:
      'Post-cutover operations plan — KPI dashboard, monitoring, decommission, modernization backlog',
    variables: [
      'shadowRunVerdict',
      'forgeOutput',
      'specLockScenarios',
      'targetStack',
    ],
    template: `You are performing Stage 8 (EVOLVE) of an 8-stage modernization pipeline. The modernized system has passed SHADOW_RUN validation and is now in production. Your job is to produce a comprehensive post-cutover operations plan.

**SHADOW_RUN Verdict:**
{{shadowRunVerdict}}

**FORGE Output (generated code summary):**
{{forgeOutput}}

**SPEC_LOCK Scenarios (BDD coverage):**
{{specLockScenarios}}

**Target Stack:** {{targetStack}}

---

Produce a complete EVOLVE document with these EXACT sections:

## KPI Dashboard

Define quantified targets for the modernized system. Use a table:

| KPI | Current Baseline | 30-Day Target | 90-Day Target | Owner |
|-----|-----------------|---------------|---------------|-------|
| System Uptime | 99.2% | 99.5% | 99.9% | SRE Team |
| Avg Response Time (p95) | 450ms | 200ms | 100ms | Backend Team |
| BDD Scenario Pass Rate | 85% | 95% | 100% | QA Team |
| Code Coverage | 0% | 60% | 80% | Dev Team |
| Deployment Frequency | Monthly | Weekly | Daily | DevOps |
| MTTR (Mean Time to Recovery) | 4h | 1h | 15min | SRE Team |
| Remaining Legacy Modules | 100% | 30% | 0% | Architect |
| Monthly Cloud Cost | — | $X,XXX | $X,XXX (optimized) | FinOps |

Include 8-12 KPIs minimum. Use realistic numbers derived from SHADOW_RUN performance data.

## Operational Runbook

### Monitoring & Alerting
- What to monitor (endpoints, queues, databases, error rates)
- Alert thresholds and escalation paths
- Dashboards to create (Grafana/Datadog/CloudWatch)

### Incident Response
- Severity levels (P1-P4) with response time SLAs
- On-call rotation setup
- Runbook for the 3 most likely failure scenarios

### Health Checks
- Endpoint health check URLs and expected responses
- Database connection pool monitoring
- Queue depth and consumer lag thresholds

## Legacy Decommission Plan

Timeline for shutting down the legacy system:

| Phase | Timeline | Action | Dependencies | Rollback |
|-------|----------|--------|-------------|----------|
| Parallel Run | Week 1-2 | Both systems active, traffic split | Monitoring in place | Full rollback to legacy |
| Traffic Migration | Week 3-4 | 100% to modern, legacy read-only | All BDD scenarios green | Redirect traffic back |
| Data Freeze | Week 5-6 | Legacy writes disabled, final sync | Data reconciliation complete | Re-enable legacy writes |
| Archive | Week 7-8 | Legacy data archived, system powered down | Compliance archive verified | Restore from archive |

Include specific decommission steps for each legacy component identified in SCAN.

## Modernization Backlog

Prioritized backlog of remaining work post-cutover:

| # | Item | Priority | Category | Effort | Sprint | Status |
|---|------|----------|----------|--------|--------|--------|
| 1 | Fix SHADOW_RUN deviations | P0 | Bug Fix | 2d | Sprint 1 | Pending |
| 2 | Add missing BDD scenario coverage | P1 | Quality | 3d | Sprint 1 | Pending |
| 3 | Performance optimization for slow queries | P1 | Performance | 5d | Sprint 2 | Pending |
| 4 | Implement CI/CD pipeline | P1 | DevOps | 3d | Sprint 1 | Pending |
| 5 | Add observability (traces, metrics, logs) | P2 | Operations | 5d | Sprint 2 | Pending |
| 6 | Security hardening (OWASP top 10) | P2 | Security | 5d | Sprint 3 | Pending |

Categories: Bug Fix, Quality, Performance, DevOps, Operations, Security, Feature, Documentation
Include 10-15 backlog items minimum. Reference specific SHADOW_RUN deviations and SPEC_LOCK gaps.

## Cost Optimization

| Resource | Current | Optimized | Savings | Action |
|----------|---------|-----------|---------|--------|
| Compute | $X/mo | $Y/mo | Z% | Right-size instances, auto-scaling |
| Database | $X/mo | $Y/mo | Z% | Reserved instances, read replicas |
| Storage | $X/mo | $Y/mo | Z% | Lifecycle policies, compression |

## Team & Knowledge Transfer

- Required skills for the modernized stack
- Training plan for the team
- Documentation deliverables (ADRs, runbooks, API docs)
- Knowledge transfer sessions schedule

---

IMPORTANT:
- All KPI targets must be quantified (numbers, percentages, time units)
- Reference SHADOW_RUN deviations when populating the backlog
- Reference SPEC_LOCK scenarios when discussing test coverage
- Decommission timeline must have specific week ranges
- Backlog items must have sprint assignments
- This is a LIVING document — it will be refined via interactive chat`,

    examples: [
      'COBOL payroll cutover: 8-week decommission, 15 backlog items, $12K/mo cloud target',
      'RPG order system: 99.9% uptime target, weekly deploys, 4 sprint backlog',
    ],
  },
};

/**
 * Get template for a specific pipeline stage
 */
export function getPromptTemplate(stageName: PipelineStageName): PromptTemplate {
  return promptTemplates[stageName];
}

/**
 * Interpolate template variables
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, value);
  });

  return result;
}

// Re-export scan subtask templates
export * from './scan-subtask-templates';

// Re-export decode subtask templates
export * from './decode-subtask-templates';

// Re-export anti-rationalization guards
export * from './rationalization-guards';

/**
 * Get all template variable placeholders in a template
 */
export function getTemplateVariables(template: string): string[] {
  const regex = /{{(\w+)}}/g;
  const matches: string[] = [];
  let match;

  while ((match = regex.exec(template)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}
