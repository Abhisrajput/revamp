/**
 * Prompt Generator — auto-populates stage 2-8 prompts based on SCAN output,
 * BREE analysis, target tech stack, and cloud selection.
 *
 * Instead of using generic templates, this service analyzes what SCAN and BREE
 * discovered about the legacy codebase and generates tailored prompts that
 * reference specific components, patterns, complexity, and architectural decisions.
 *
 * Called after Stage 1 (SCAN) completes or when project config changes.
 */

import { db } from "@/db/index.js";
import { projects, stageArtifacts } from "@/db/schema.js";
import { eq, and } from "drizzle-orm";
import { llmProxyService } from "./llm-proxy.js";

// ─── TYPES ──────────────────────────────────────────────────────

interface ScanContext {
  /** Full SCAN stage output markdown */
  scanOutput: string;
  /** BREE analysis artifact (if available) */
  breeAnalysis?: {
    summary?: Record<string, unknown>;
    dependencies?: Array<{ from_module: string; to_module: string; dependency_type: unknown }>;
    polyglot_boundaries?: Array<{ from_language: string; to_language: string; mechanism: string }>;
    priority_scores?: Array<{ language_id: string; tier: string; weighted_score: number }>;
    llm_strategy?: { recommendation: string; families_detected: Array<{ family: string; prompt_focus: string }> };
  };
  /** Target tech stack (e.g., "Java/Spring Boot", "Python/FastAPI", "Go") */
  targetStack: string;
  /** Target cloud (e.g., "AWS", "GCP", "Azure") */
  targetCloud: string;
  /** Source languages detected */
  sourceLanguages: string[];
  /** Project description */
  projectDescription?: string;
}

interface GeneratedPrompts {
  stagePrompts: Record<string, string>;
  validationPrompts: Record<string, string>;
}

// Template literal helper — avoids backtick escaping issues in prompts
const FENCE = '```';
const fence = (lang: string) => FENCE + lang;
const fenceEnd = FENCE;

// ─── STAGE INDICES ──────────────────────────────────────────────

const STAGE_INDEX = {
  SCAN: '0',
  DECODE: '1',
  BLUEPRINT: '2',
  SPEC_LOCK: '3',
  ARCHITECT: '4',
  FORGE: '5',
  SHADOW_RUN: '6',
  EVOLVE: '7',
} as const;

// ─── CLOUD-SPECIFIC SERVICE MAPPINGS ────────────────────────────

const CLOUD_SERVICES: Record<string, Record<string, string>> = {
  AWS: {
    compute: 'ECS Fargate / EKS',
    database: 'RDS PostgreSQL / Aurora',
    cache: 'ElastiCache Redis',
    queue: 'SQS / SNS',
    storage: 'S3',
    auth: 'Cognito',
    api: 'API Gateway',
    cicd: 'CodePipeline / CodeBuild',
    monitoring: 'CloudWatch + X-Ray',
    secrets: 'Secrets Manager',
    cdn: 'CloudFront',
  },
  GCP: {
    compute: 'Cloud Run / GKE',
    database: 'Cloud SQL PostgreSQL / AlloyDB',
    cache: 'Memorystore Redis',
    queue: 'Pub/Sub',
    storage: 'Cloud Storage',
    auth: 'Identity Platform',
    api: 'API Gateway / Apigee',
    cicd: 'Cloud Build',
    monitoring: 'Cloud Monitoring + Cloud Trace',
    secrets: 'Secret Manager',
    cdn: 'Cloud CDN',
  },
  Azure: {
    compute: 'Container Apps / AKS',
    database: 'Azure Database for PostgreSQL',
    cache: 'Azure Cache for Redis',
    queue: 'Service Bus',
    storage: 'Blob Storage',
    auth: 'Entra ID (AAD)',
    api: 'API Management',
    cicd: 'Azure DevOps Pipelines',
    monitoring: 'Application Insights + Monitor',
    secrets: 'Key Vault',
    cdn: 'Azure CDN',
  },
};

// ─── TECH STACK PATTERNS ────────────────────────────────────────

const STACK_PATTERNS: Record<string, { framework: string; testFramework: string; apiStyle: string; orm: string; buildTool: string }> = {
  'Java/Spring Boot': { framework: 'Spring Boot 3.x', testFramework: 'JUnit 5 + Cucumber', apiStyle: 'REST (Spring MVC) + OpenAPI', orm: 'Spring Data JPA / Hibernate', buildTool: 'Gradle/Maven' },
  'Python/FastAPI': { framework: 'FastAPI + Pydantic v2', testFramework: 'pytest + behave', apiStyle: 'REST (FastAPI) + OpenAPI', orm: 'SQLAlchemy 2.0 / Alembic', buildTool: 'Poetry' },
  'Go': { framework: 'Chi/Gin router', testFramework: 'go test + godog', apiStyle: 'REST (net/http)', orm: 'sqlc / GORM', buildTool: 'Go modules' },
  '.NET/C#': { framework: 'ASP.NET Core 8', testFramework: 'xUnit + SpecFlow', apiStyle: 'REST (minimal APIs) + Swagger', orm: 'Entity Framework Core', buildTool: 'dotnet CLI' },
  'Node.js/TypeScript': { framework: 'Fastify / NestJS', testFramework: 'Vitest + Cucumber.js', apiStyle: 'REST (Fastify) + OpenAPI', orm: 'Drizzle / Prisma', buildTool: 'pnpm + TSC' },
};

// ─── PROMPT BEST PRACTICES ──────────────────────────────────────
//
// Each stage prompt follows this structure (Anthropic/OpenAI best practices):
//
//   1. ROLE — who you are, what stage this is
//   2. CONTEXT — SCAN output, BREE data, prior stage references
//   3. REASONING — "First analyze X, then determine Y, then produce Z"
//   4. OUTPUT SPEC — exact sections, table headers, Mermaid syntax templates
//   5. EXAMPLES — 1 concrete example per key output section
//   6. CONSTRAINTS — word budgets per section, format rules
//   7. ANTI-HALLUCINATION — "ONLY reference items from provided context"
//   8. DO NOT — explicit failure modes to avoid
//   9. SELF-VERIFICATION — checklist the LLM runs before completing
//
// Validation prompts use weighted dimensional scoring (not "score 0-100").

// ─── MAIN GENERATOR ────────────────────────────────────────────

/**
 * Generate tailored prompts for stages 2-8 based on SCAN output + BREE + project config.
 */
export function generateStagePrompts(ctx: ScanContext): GeneratedPrompts {
  const cloud = CLOUD_SERVICES[ctx.targetCloud] || CLOUD_SERVICES.AWS;
  const stack = STACK_PATTERNS[ctx.targetStack] || STACK_PATTERNS['Java/Spring Boot'];
  const bree = ctx.breeAnalysis;

  // Extract key facts from SCAN output for prompt injection
  const scanExcerpt = ctx.scanOutput.length > 12000
    ? ctx.scanOutput.slice(0, 12000) + '\n\n[... SCAN output truncated for prompt context ...]'
    : ctx.scanOutput;

  const sourceList = ctx.sourceLanguages.join(', ') || 'Unknown legacy languages';
  const breeRecommendation = bree?.llm_strategy?.recommendation || '';
  const breeDeps = bree?.dependencies?.slice(0, 20)
    .map(d => `${d.from_module} → ${d.to_module}`)
    .join('\n') || 'No dependency data from BREE';
  const breePriorities = bree?.priority_scores
    ?.map(p => `${p.language_id} (${p.tier}, score: ${p.weighted_score})`)
    .join(', ') || '';

  const stagePrompts: Record<string, string> = {};
  const validationPrompts: Record<string, string> = {};

  // ── DECODE (Stage 2) ──────────────────────────────────────────
  stagePrompts[STAGE_INDEX.DECODE] = `## ROLE
You are a senior business analyst performing Stage 2 (DECODE) of an 8-stage modernization pipeline. You extract business intent from ${sourceList} code being modernized to ${ctx.targetStack} on ${ctx.targetCloud}.

## CONTEXT

### SCAN Output (Stage 1 — the source of truth for what exists)
${scanExcerpt}

### BREE Static Analysis (machine-verified dependency data)
**Module dependencies:**
${breeDeps}

**Language priorities:** ${breePriorities}
${breeRecommendation ? `**BREE recommendation:** ${breeRecommendation}` : ''}

## REASONING STEPS
Follow this analysis sequence — do NOT skip to output:
1. **Inventory** — list every module/component from SCAN's component table
2. **Trace data flow** — use BREE dependencies to map how data moves between modules
3. **Extract rules** — for each module, identify the business logic (not infrastructure code)
4. **Classify** — assign complexity (Low/Medium/High) using BREE dependency count
5. **Map integrations** — identify every external touchpoint
6. **Produce output** — only then write the structured document below

## OUTPUT SPECIFICATION

### 1. Business Rules Catalog (target: 800-1500 words)

Use EXACTLY this table format:

| BR-ID | Rule Name | Domain | Source File(s) | Complexity | Depends On | Priority |
|-------|-----------|--------|---------------|------------|------------|----------|
| BR-1 | User authentication | Identity | auth.cbl, login-proc.cbl | Medium | BR-3 (session) | High |
| BR-2 | Order total calculation | Commerce | calc-order.cbl | High | BR-5, BR-7 | High |

Requirements:
- Sequential BR-{number} IDs starting from BR-1
- EVERY module from SCAN must map to at least one BR
- Source files must match EXACT paths from SCAN output above
- Complexity based on BREE dependency count: 0-2 deps = Low, 3-5 = Medium, 6+ = High

### 2. Workflow Diagrams (target: 2-5 diagrams)

For each major workflow, include a Mermaid diagram. Use EXACTLY this syntax:

${fence('mermaid')}
sequenceDiagram
    participant User
    participant AuthService
    participant Database
    User->>AuthService: Login(email, password)
    AuthService->>Database: SELECT user WHERE email = ?
    Database-->>AuthService: User record
    alt Valid credentials
        AuthService-->>User: Session token
    else Invalid
        AuthService-->>User: Error 401
    end
${fenceEnd}

### 3. Data Entity Map (target: 400-800 words)

For EACH data entity, provide:

| Entity | Source Structure | Business Purpose | Relationships | Target ${stack.orm} Model |
|--------|----------------|-----------------|---------------|--------------------------|
| User | USER-RECORD (COBOL copybook) | System identity | Has many Orders, has one Profile | @Entity User { id, email, ... } |

### 4. Integration Inventory (target: 300-600 words)

| Integration | Type | Source File | Current Protocol | Target ${ctx.targetCloud} Service |
|------------|------|------------|-----------------|-----------------------------------|
| Payment gateway | External API | pay-proc.cbl | SOAP/HTTP | ${cloud.api} → ${cloud.queue} |
| Batch reports | File I/O | rpt-gen.cbl | Flat file | ${cloud.storage} + ${cloud.compute} |

### 5. Workflows (target: 300-600 words)

For each major business workflow discovered, document:
- **Workflow name** and business purpose
- **Trigger** — what initiates the workflow
- **Steps** — sequential steps with the modules/files involved
- **Data touched** — entities read/written at each step
- **Error handling** — what happens when a step fails

Include at least one Mermaid sequence diagram per major workflow:

${fence('mermaid')}
sequenceDiagram
    participant User
    participant Controller
    participant Service
    participant Database
    User->>Controller: Submit request
    Controller->>Service: Process business logic
    Service->>Database: Persist changes
    Database-->>Service: Confirmation
    Service-->>Controller: Result
    Controller-->>User: Response
${fenceEnd}

### 6. Technical Debt (target: 200-400 words)

Inventory technical debt discovered from SCAN and BREE analysis:

| ID | Debt Item | Location | Severity | Impact | Modernization Risk |
|----|-----------|----------|----------|--------|-------------------|
| TD-1 | Hardcoded config values | config.php | Medium | Deployment flexibility | Must externalize before migration |

Categories: dead code, deprecated APIs, security vulnerabilities, missing tests, tight coupling, hardcoded values.

### 7. Open Questions for SME (target: 100-300 words)

List questions that require Subject Matter Expert clarification before proceeding to BLUEPRINT:

| ID | Question | Context | Impacts Stage |
|----|----------|---------|---------------|
| Q-1 | What is the expected SLA for transaction processing? | No SLA documented in code | ARCHITECT, SPEC_LOCK |
| Q-2 | Are there undocumented batch jobs? | BREE found scheduled task references | BLUEPRINT |

Flag any business rules marked [NEEDS_VERIFICATION] from above.

### 8. Complexity Heatmap (target: 200-400 words)

Rank modules from SCAN by modernization difficulty. Use BREE dependency counts as the primary signal.

## ANTI-HALLUCINATION RULES
- ONLY reference files, modules, and components that appear in the SCAN output above
- ONLY use BREE dependency data for complexity — do not invent dependency counts
- If SCAN doesn't mention a module, do NOT create business rules for it
- If you're unsure about a business rule, mark it with [NEEDS_VERIFICATION] tag

## DO NOT
- Do NOT propose modernization strategies (that's Stage 5 ARCHITECT)
- Do NOT write code or pseudo-code (that's Stage 6 FORGE)
- Do NOT write test scenarios (that's Stage 4 SPEC_LOCK)
- Do NOT invent business rules not evidenced in SCAN output
- Do NOT use generic placeholder names like "ModuleA" — use real names from SCAN

## SELF-VERIFICATION CHECKLIST
Before completing your response, verify ALL of these:
- [ ] Every module from SCAN's component table has at least one BR-{id}
- [ ] BR-IDs are sequential with no gaps
- [ ] Source file paths match SCAN output exactly
- [ ] At least 2 Mermaid diagrams included with valid syntax
- [ ] Data entity map covers all tables/records from SCAN
- [ ] Integration inventory maps to specific ${ctx.targetCloud} services
- [ ] **"Workflows" section exists** with at least one Mermaid sequence diagram
- [ ] **"Technical Debt" section exists** with TD-{id} inventory table
- [ ] **"Open Questions" section exists** with Q-{id} table for SME clarification
- [ ] Total output is 3000-6000 words (not too short, not bloated)`;

  validationPrompts[STAGE_INDEX.DECODE] = `## VALIDATION RUBRIC — DECODE Output

Score each dimension independently. The overall score is the weighted average.

### Dimension 1: Coverage Completeness (weight: 35%)
- Does EVERY module/component from SCAN appear in at least one BR-{id}?
- Count: {modules in SCAN} vs {modules referenced in BRs}
- Score 90-100: all modules covered | 70-89: >80% covered | 50-69: >60% | 0-49: <60%

### Dimension 2: Traceability (weight: 25%)
- Are BR-IDs sequential and unique?
- Do source file paths match SCAN output exactly (not invented)?
- Does every BR reference a real file from SCAN?
- Score 90-100: all traceable | 70-89: minor gaps | 50-69: major gaps | 0-49: fabricated

### Dimension 3: Business Rule Quality (weight: 20%)
- Are rules described in business terms (not code terms)?
- Do rules include trigger conditions and edge cases?
- Are complexity ratings justified by BREE data?
- Score 90-100: rich, specific rules | 70-89: adequate | 50-69: thin | 0-49: just code descriptions

### Dimension 4: Diagrams & Structure (weight: 10%)
- At least 2 Mermaid diagrams with valid syntax?
- Data entity map with source AND target structures?
- Integration inventory with ${ctx.targetCloud} service mappings?
- Score 90-100: comprehensive diagrams | 70-89: present but incomplete | 0-69: missing or invalid

### Dimension 5: Anti-Hallucination (weight: 10%)
- Are there any invented modules, files, or components NOT in SCAN?
- Are there placeholder names ("ModuleA", "example.cbl")?
- Score 100: all grounded in SCAN | 70-99: minor inventions | 0-69: significant fabrication

### Output Format
Respond with JSON:
${fence('json')}
{
  "dimensions": [
    { "name": "Coverage Completeness", "score": 85, "weight": 0.35, "reasoning": "..." },
    { "name": "Traceability", "score": 90, "weight": 0.25, "reasoning": "..." },
    { "name": "Business Rule Quality", "score": 80, "weight": 0.20, "reasoning": "..." },
    { "name": "Diagrams & Structure", "score": 75, "weight": 0.10, "reasoning": "..." },
    { "name": "Anti-Hallucination", "score": 95, "weight": 0.10, "reasoning": "..." }
  ],
  "overallScore": 85,
  "passed": true,
  "issues": ["Missing BR for report-gen module", "Mermaid diagram has syntax error on line 3"],
  "recommendations": ["Add BR for report generation module from SCAN"]
}
${fenceEnd}`;

  // ── BLUEPRINT (Stage 3) ───────────────────────────────────────
  stagePrompts[STAGE_INDEX.BLUEPRINT] = `## ROLE
You are a solution architect performing Stage 3 (BLUEPRINT). You map DECODE's business rules into bounded contexts and service boundaries for ${ctx.targetStack} on ${ctx.targetCloud}.

## REASONING STEPS
1. **List all BR-{ids}** from DECODE output — every one must appear in the capability inventory
2. **Group by domain** — cluster related BRs into business capabilities
3. **Apply DDD** — draw bounded context boundaries based on data ownership and coupling
4. **Design services** — one ${stack.framework} service per bounded context
5. **Plan waves** — order extraction by dependency (foundations first)

## OUTPUT SPECIFICATION

### 1. Capability Inventory (target: 600-1000 words)

| CAP-ID | Capability | Domain | BR-{ids} | Current Module(s) | Data Entities | Complexity | Priority |
|--------|-----------|--------|----------|-------------------|---------------|------------|----------|
| CAP-1 | User Authentication | Identity | BR-1, BR-2 | auth.cbl, login.cbl | User, Session | Medium | High |

### 2. Bounded Contexts (target: 800-1200 words, 3-8 contexts)

For EACH context use this template:
${fenceEnd}
### Context: {Name}
**Capabilities:** CAP-1, CAP-4
**Owned Entities:** {list} → ${stack.orm} models
**API Surface:** ${stack.apiStyle}
**Events Published:** {list}
**Events Consumed:** {list}
**Data Store:** ${cloud.database}
**Cache:** ${cloud.cache}
**Deploy:** ${cloud.compute}
${fenceEnd}

### 3. Service Boundary Decisions (target: 300-500 words)

| Decision | Boundary | Rationale (reference BR-{ids}) | Tradeoff |
|----------|----------|-------------------------------|----------|

### 4. Migration Waves (target: 300-500 words)

| Wave | Services | Depends On | Go/No-Go (BR-{ids} from SPEC_LOCK) |
|------|----------|-----------|--------------------------------------|
| Wave 1 | Identity | None | All BR-1, BR-2 scenarios pass |

### 5. Diagrams (exactly 2)
- Capability map (Mermaid \`graph TD\` with subgraphs per context)
- Data ownership matrix table

### 6. Data Ownership (target: 200-400 words)

| Entity | Owner Context | Shared Read By | Sync Strategy |
|--------|-------------|----------------|---------------|
| User | Identity | Commerce, Reporting | API call |
| Order | Commerce | Reporting | Event (OrderCreated) |

Requirements:
- Every data entity from DECODE's data entity map must appear here
- Owner Context must match a bounded context from section 2
- Sync Strategy must use ${ctx.targetCloud} primitives (${cloud.queue}, ${cloud.api}, ${cloud.database} replication)
- Shared-write entities are NOT allowed — if detected, split the entity or assign single ownership

## ANTI-HALLUCINATION RULES
- ONLY use BR-{ids} that exist in DECODE output
- ONLY reference modules that appear in SCAN output
- Do NOT invent capabilities beyond what DECODE discovered

## DO NOT
- Do NOT write code (that's FORGE)
- Do NOT write test scenarios (that's SPEC_LOCK)
- Do NOT propose technologies outside ${ctx.targetStack} and ${ctx.targetCloud}

## SELF-VERIFICATION
- [ ] Every BR-{id} from DECODE appears in exactly one CAP-{id}
- [ ] Every CAP-{id} belongs to exactly one bounded context
- [ ] At least 2 Mermaid diagrams with valid syntax
- [ ] Migration waves have no circular dependencies
- [ ] ${ctx.targetCloud} services referenced by correct name
- [ ] **"Data Ownership" section exists** with every entity assigned to exactly one owner context
- [ ] No shared-write entities — all sync strategies are read-only (API call, Event, Replication)`;

  validationPrompts[STAGE_INDEX.BLUEPRINT] = `## VALIDATION RUBRIC — BLUEPRINT Output

### Dimension 1: BR Coverage (weight: 30%)
Count BR-{ids} in DECODE vs BR-{ids} in capability inventory. Score = (matched / total) * 100.

### Dimension 2: Context Quality (weight: 25%)
- Are bounded contexts cohesive (high internal, low external coupling)?
- Is data ownership clear (no shared-write entities)?
- Score 90+: clean DDD boundaries | 70-89: minor coupling | <70: tangled

### Dimension 3: ${ctx.targetCloud} Accuracy (weight: 20%)
- Are cloud service names correct (${cloud.compute}, ${cloud.database}, ${cloud.queue})?
- Is the architecture feasible on ${ctx.targetCloud}?

### Dimension 4: Migration Waves (weight: 15%)
- Are waves ordered by dependency (foundations first)?
- Do go/no-go criteria reference specific BR-{ids}?
- No circular dependencies between waves?

### Dimension 5: Diagrams (weight: 10%)
- At least 2 valid Mermaid diagrams?
- Capability map shows all contexts?

Respond with JSON: { "dimensions": [...], "overallScore": N, "passed": bool, "issues": [...] }`;

  // ── SPEC_LOCK (Stage 4) ───────────────────────────────────────
  stagePrompts[STAGE_INDEX.SPEC_LOCK] = `## ROLE
You are a QA architect performing Stage 4 (SPEC_LOCK). You lock behavioral contracts as Cucumber-compatible Gherkin .feature files for ${ctx.targetStack} (${stack.testFramework}).

## REASONING STEPS
1. **List all BR-{ids}** from DECODE — every one needs at least one scenario
2. **Classify priority** — High-complexity BRs (from BREE) get @edge-case + @error-handling scenarios
3. **Identify integrations** — external touchpoints need @integration scenarios
4. **Write features** — one .feature file per domain/capability
5. **Build traceability matrix** — prove every BR is covered

## OUTPUT SPECIFICATION

### Feature Files (target: 60-80% of output)

For EACH business capability, produce a complete .feature file:

${fence('gherkin')}
# File: features/identity/user-authentication.feature
@BR-1 @BR-2 @critical
Feature: User Authentication
  As a system user
  I want to authenticate with valid credentials
  So that I can access protected resources

  Background:
    Given the auth service is deployed on ${cloud.compute}
    And the user database is available on ${cloud.database}
    And test user "admin@acme.com" exists with password hash

  @happy-path
  Scenario: Successful login returns session token
    Given the user "admin@acme.com" has status "ACTIVE"
    When the user submits password "SecurePass123!"
    Then the response status is 200
    And the response contains a JWT token with expiry 1800 seconds
    And an audit log entry "LOGIN_SUCCESS" is created

  @edge-case
  Scenario Outline: Login rejected for invalid input
    When user "<email>" submits password "<password>"
    Then the response status is <status>
    And the response error code is "<error>"

    Examples:
      | email             | password      | status | error          |
      | admin@acme.com    | wrong         | 401    | INVALID_CREDS  |
      | noone@acme.com    | SecurePass123!| 404    | USER_NOT_FOUND |
      | locked@acme.com   | SecurePass123!| 403    | ACCOUNT_LOCKED |

  @error-handling @BR-1.3
  Scenario: Account locks after 5 consecutive failures
    Given user "admin@acme.com" has 4 failed login attempts
    When the user submits an invalid password
    Then the account status changes to "LOCKED"
    And a notification is sent via ${cloud.queue}
${fenceEnd}

### Scenario Requirements
- @happy-path: EVERY BR-{id} must have at least one
- @edge-case: required for Medium/High complexity BRs
- @error-handling: required for High complexity BRs
- @integration: for BRs involving external systems (tag ${ctx.targetCloud} services)
- @data-integrity: for BRs involving writes/updates (verify rollback)
- Use **concrete test data** (real emails, amounts, dates) — never placeholders

### Traceability Matrix (target: 200-400 words)

| BR-ID | Feature File | Scenario Count | Tags | Coverage Status |
|-------|-------------|---------------|------|-----------------|
| BR-1 | identity/user-auth.feature | 4 | @happy-path, @edge-case, @error-handling | Full |
| BR-2 | identity/session-mgmt.feature | 3 | @happy-path, @edge-case | Full |

### Test Execution Results (target: 200-400 words)

Simulate execution of all scenarios and report results:

| Feature File | Scenario | Status | Duration | Notes |
|-------------|----------|--------|----------|-------|
| identity/login.feature | Successful login | PASS | 120ms | All assertions passed |
| identity/login.feature | Account lockout | FAIL | 85ms | Lockout counter not implemented |

Requirements:
- Run EVERY scenario from all .feature files above and report PASS/FAIL
- Duration must be realistic for the scenario type (unit: <200ms, integration: <2s)
- FAIL scenarios must include root cause in Notes column
- Group results by Feature File
- Summary row at the bottom: Total PASS / Total FAIL / Pass Rate %

### Validation Findings (target: 150-300 words)

| ID | Finding | Severity | Category | Affected BR-{ids} |
|----|---------|----------|----------|-------------------|
| VF-1 | Missing edge case for null input | Critical | Coverage Gap | BR-3 |
| VF-2 | No timeout scenario for API calls | Warning | Non-Functional | BR-7, BR-12 |

Requirements:
- Severity: Critical / Warning / Info
- Categories: Coverage Gap, Non-Functional, Data Integrity, Security, Edge Case
- Every Critical finding must block progression to ARCHITECT stage
- VF-{id} numbering is sequential

### Regression Checklist (target: 100-200 words)

Scenarios that MUST pass on every code change:

| Priority | Scenario | Feature File | BR-{ids} | Rationale |
|----------|----------|-------------|----------|-----------|
| P0 | Login with valid credentials | identity/login.feature | BR-1 | Core auth path |
| P0 | Order total calculation | commerce/order.feature | BR-5 | Revenue-critical |

Requirements:
- P0 scenarios: must pass on EVERY build (blocks merge)
- P1 scenarios: must pass on release builds (blocks deploy)
- Include at least one scenario per bounded context from BLUEPRINT
- Rationale must explain WHY this scenario is regression-critical

## ANTI-HALLUCINATION RULES
- ONLY create scenarios for BR-{ids} that exist in DECODE output
- ONLY reference modules/files that appear in SCAN
- Use CONCRETE test data — if you don't know real values, use realistic ones with [TEST_DATA] tag

## DO NOT
- Do NOT write step definition code (that's FORGE)
- Do NOT propose architecture changes (that's ARCHITECT)
- Do NOT use @wip or @pending tags — every scenario must be complete
- Do NOT use abstract placeholders like "valid data" — be specific

## SELF-VERIFICATION
- [ ] Every BR-{id} from DECODE has at least one @happy-path scenario
- [ ] High-complexity BRs have @edge-case AND @error-handling scenarios
- [ ] All Gherkin files use valid Cucumber syntax (parseable)
- [ ] Scenario Outlines have Examples tables with 3+ rows
- [ ] Traceability matrix accounts for every BR-{id}
- [ ] Background blocks reference ${ctx.targetCloud} services correctly
- [ ] **"Test Execution Results" section exists** with PASS/FAIL for every scenario and summary row
- [ ] **"Validation Findings" section exists** with VF-{id} entries and severity classifications
- [ ] **"Regression Checklist" section exists** with P0/P1 scenarios per bounded context`;

  validationPrompts[STAGE_INDEX.SPEC_LOCK] = `## VALIDATION RUBRIC — SPEC_LOCK Output

### Dimension 1: BR Coverage (weight: 35%)
Count BR-{ids} from DECODE vs BR-{ids} tagged in scenarios. Score = (covered / total) * 100.

### Dimension 2: Scenario Quality (weight: 25%)
- Do scenarios use concrete test data (not "valid input")?
- Do Scenario Outlines have 3+ Examples rows?
- Are Given/When/Then steps specific and testable?
- Score 90+: all concrete | 70-89: mostly concrete | <70: too abstract

### Dimension 3: Depth (weight: 20%)
- Do High-complexity BRs have @edge-case + @error-handling scenarios?
- Are integration points covered with @integration scenarios?
- Score = (high-complexity BRs with full coverage / total high-complexity BRs) * 100

### Dimension 4: Gherkin Validity (weight: 10%)
- Valid Feature/Scenario/Given/When/Then syntax?
- Proper tag format (@BR-{id})?
- Scenario Outlines have matching Examples tables?

### Dimension 5: Traceability (weight: 10%)
- Is the matrix complete?
- Does it match the actual scenarios in the .feature files?

Respond with JSON: { "dimensions": [...], "overallScore": N, "passed": bool, "issues": [...] }`;

  // ── ARCHITECT (Stage 5) ───────────────────────────────────────
  stagePrompts[STAGE_INDEX.ARCHITECT] = `## ROLE
You are a principal architect performing Stage 5 (ARCHITECT). You define the technical architecture for modernizing from ${sourceList} to ${ctx.targetStack} on ${ctx.targetCloud}.

## REASONING STEPS
1. **Review BLUEPRINT** — list all bounded contexts and their capabilities
2. **Review SPEC_LOCK** — understand behavioral contracts that constrain the architecture
3. **Make decisions** — for each architectural concern, produce an ADR
4. **Design APIs** — OpenAPI contracts per bounded context
5. **Plan data migration** — source→target mappings with validation strategy
6. **Define infrastructure** — ${ctx.targetCloud} service topology

## OUTPUT SPECIFICATION

### 1. Target Architecture (target: 800-1200 words)

Define the target state for each bounded context from BLUEPRINT. Include Component and Service mappings.

#### 1a. Service Topology

| Component | Service | ${ctx.targetCloud} Resource | Bounded Context | Pattern | Rationale (BREE data) |
|-----------|---------|---------------------------|-----------------|---------|----------------------|
| Auth Controller | Identity Service | ${cloud.compute} | Identity | Replatform | Low coupling (2 deps), clean boundaries |
| Order Engine | Commerce Service | ${cloud.compute} | Commerce | Strangler Fig | High coupling (8 deps), gradual extraction |
| Report Generator | Reporting Service | ${cloud.compute} | Reporting | Rebuild | 40% dead code (BREE), simpler to rewrite |

#### 1b. Infrastructure Diagram (Mermaid)
${fence('mermaid')}
graph TB
    Client -->|HTTPS| AG[${cloud.api}]
    AG --> Auth[${cloud.auth}]
    AG --> SVC1[Service 1 on ${cloud.compute}]
    AG --> SVC2[Service 2 on ${cloud.compute}]
    SVC1 --> DB1[(${cloud.database})]
    SVC1 --> CACHE[(${cloud.cache})]
    SVC1 --> Q[${cloud.queue}]
    Q --> SVC2
    SVC2 --> DB2[(${cloud.database})]
${fenceEnd}

### 2. Technology Decisions (target: 600-1000 words, 5-10 decisions)

Use EXACTLY this template for each:

**TD-{N}: {Title}**
- **Context:** {Problem being solved — reference BR-{ids} and CAP-{ids}}
- **Chosen:** {The technology/approach selected}
- **Alternative:** {What else was considered and why it was rejected}
- **Rationale:** {Why — reference BREE complexity data, BLUEPRINT boundaries}
- **${ctx.targetCloud} services:** {Specific services used}
- **Consequences:** {Tradeoffs accepted}

### 3. API Contracts (target: 600-1000 words)

For each bounded context, provide OpenAPI 3.1 snippets:
${fence('yaml')}
paths:
  /api/v1/users:
    post:
      summary: Create user (BR-1)
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateUserRequest'
      responses:
        '201': { description: User created }
        '409': { description: Duplicate email }
${fenceEnd}

### 4. Migration Roadmap (target: 400-600 words)

Map BLUEPRINT migration waves to a phased Sprint-based schedule:

| Phase | Sprint | Services | BLUEPRINT Wave | Depends On | Go/No-Go (BR-{ids} from SPEC_LOCK) | Data Migration |
|-------|--------|----------|---------------|-----------|--------------------------------------|---------------|
| Phase 1 | Sprint 1-2 | Identity Service | Wave 1 | None | All BR-1, BR-2 scenarios pass | User table ETL |
| Phase 2 | Sprint 3-5 | Commerce Service | Wave 2 | Phase 1 | BR-5, BR-7 scenarios pass | Order/Product ETL |
| Phase 3 | Sprint 6-8 | Reporting Service | Wave 3 | Phase 1, 2 | BR-10, BR-12 scenarios pass | Read replicas |

Include:
- Source structure → ${stack.orm} model mapping table
- ETL design on ${ctx.targetCloud} (${cloud.compute} + ${cloud.storage})
- Validation: run SPEC_LOCK @data-integrity scenarios post-migration
- Rollback: snapshot strategy per phase

### 5. Risk Register (target: 300-500 words)

| Risk-ID | Risk | Probability | Impact | Severity | Mitigation | Owner | Status |
|---------|------|-------------|--------|----------|-----------|-------|--------|
| R-1 | Data loss during migration | Medium | Critical | High | Dual-write + reconciliation via ${cloud.queue} | Data Team | Open |
| R-2 | Performance regression in Commerce | High | High | Critical | Shadow run benchmarks, ${cloud.monitoring} alerts | Platform Team | Open |
| R-3 | Third-party API incompatibility | Low | Medium | Medium | Adapter pattern + contract tests | Integration Team | Open |

Requirements:
- Probability: Low / Medium / High
- Impact: Low / Medium / High / Critical
- At least one risk per BLUEPRINT migration wave
- Mitigation must reference specific ${ctx.targetCloud} services or patterns

### 6. Cost Model (target: 300-500 words)

| Category | Service/Resource | Phase 1 Cost ($/mo) | Phase 2 Cost ($/mo) | Steady-State ($/mo) | Notes |
|----------|-----------------|--------------------|--------------------|--------------------:|-------|
| Compute | ${cloud.compute} | $200 | $450 | $600 | Auto-scaling 2-8 instances |
| Database | ${cloud.database} | $150 | $300 | $400 | Primary + read replica |
| Cache | ${cloud.cache} | $50 | $100 | $100 | Single node → cluster |
| Queue | ${cloud.queue} | $20 | $50 | $50 | Per-message pricing |
| Monitoring | ${cloud.monitoring} | $30 | $60 | $80 | Logs + traces + metrics |
| CI/CD | ${cloud.cicd} | $50 | $50 | $50 | Build minutes |
| **Total** | | **$500** | **$1,010** | **$1,280** | |

Requirements:
- Costs must be based on ${ctx.targetCloud} published pricing
- Include migration-specific costs (dual-run, ETL, parallel environment)
- Compare against estimated legacy infrastructure cost if available from SCAN

## ANTI-HALLUCINATION RULES
- ONLY reference BR-{ids} from DECODE and CAP-{ids} from BLUEPRINT
- ONLY use ${ctx.targetCloud} services (no mixing cloud providers)
- Do NOT invent bounded contexts — use what BLUEPRINT defined

## SELF-VERIFICATION
- [ ] **"Target Architecture" section exists** with Component and Service mappings for every bounded context
- [ ] **"Technology Decisions" section exists** with Chosen, Alternative, and Rationale for each decision
- [ ] Every bounded context from BLUEPRINT has API contracts
- [ ] **"Migration Roadmap" section exists** with Phase and Sprint schedule aligned to BLUEPRINT waves
- [ ] **"Risk Register" section exists** with Probability, Impact, and Mitigation for each risk
- [ ] **"Cost Model" section exists** with $ cost estimates per phase and service
- [ ] Infrastructure Mermaid diagram is valid and covers all services
- [ ] Technology decisions reference specific BR-{ids}`;

  validationPrompts[STAGE_INDEX.ARCHITECT] = `## VALIDATION RUBRIC — ARCHITECT Output

### Dimension 1: ADR Quality (weight: 30%)
- 5+ ADRs present? Each references BR-{ids}? Rationale grounded in BREE data?

### Dimension 2: API Contracts (weight: 25%)
- Valid OpenAPI format? Covers all bounded contexts? Error responses defined?

### Dimension 3: ${ctx.targetCloud} Accuracy (weight: 20%)
- Service names correct? Architecture feasible? No mixed-cloud references?

### Dimension 4: Data Migration (weight: 15%)
- Source→target mapping complete? SPEC_LOCK scenarios referenced for validation?

### Dimension 5: Diagrams (weight: 10%)
- Valid Mermaid infrastructure diagram? All services visible?

Respond with JSON: { "dimensions": [...], "overallScore": N, "passed": bool, "issues": [...] }`;

  // ── FORGE (Stage 6) ──────────────────────────────────────────
  stagePrompts[STAGE_INDEX.FORGE] = `## ROLE
You are a senior ${ctx.targetStack} developer performing Stage 6 (FORGE). You generate production-ready code implementing EVERY BR-{id} from DECODE, following ARCHITECT's design, validated by SPEC_LOCK's scenarios.

## REASONING STEPS
1. **Review ARCHITECT** — list all bounded contexts, API contracts, ADRs
2. **Review SPEC_LOCK** — list all .feature files and scenario counts per BR-{id}
3. **Plan file structure** — map each bounded context to a service directory
4. **Generate layer by layer** — models → services → API → tests → infra
5. **Cross-check** — verify every BR-{id} has a @BR-{id} comment in code

## OUTPUT FORMAT

Every file MUST use this exact format:
${fence('{language}')}
### FILE: {relative/path/to/file.ext}
{complete file content — no placeholders, no "// TODO", no "..."}
${fenceEnd}

## FILE GENERATION PLAN

### Layer 1: Domain Models (${stack.orm})
- One model per data entity from BLUEPRINT's ownership matrix
- Validation annotations from BR-{id} rules
- Add \`// @BR-{id}: {rule description}\` comment above each validation

### Layer 2: Service Layer (${stack.framework})
- One service class per bounded context
- Implement EVERY BR-{id} as a method — annotate with \`// @BR-{id}\`
- Error handling matching SPEC_LOCK @error-handling scenarios
- Async operations via ${cloud.queue}

### Layer 3: API Layer (${stack.apiStyle})
- Endpoints matching ARCHITECT's OpenAPI contracts exactly
- Request validation using ${stack.framework} native validation
- Auth: ${cloud.auth} middleware
- Response format: consistent JSON envelope

### Layer 4: Test Scaffolding (${stack.testFramework})
- Step definition stub for EVERY .feature file from SPEC_LOCK
- Test config for ${cloud.database} test instances
- Mock setup for external integrations

### Layer 5: Infrastructure
- ${stack.buildTool} configuration
- ${cloud.cicd} pipeline file
- Dockerfile / container config for ${cloud.compute}
- README.md with setup instructions

## QUALITY STANDARDS
- **Compilable** — code must be syntactically valid ${ctx.targetStack}
- **No placeholders** — no "// TODO", "pass", "throw new NotImplementedError()"
- **No stubs** — every method body must have real implementation logic
- **60-120 files** total for comprehensive coverage
- **@BR-{id} comments** on every business rule implementation

## ANTI-HALLUCINATION RULES
- ONLY implement BR-{ids} that exist in DECODE
- ONLY create API endpoints defined in ARCHITECT
- ONLY use ${ctx.targetCloud} services — no references to other cloud providers
- File paths must follow ${ctx.targetStack} conventions

## DO NOT
- Do NOT generate generic CRUD without BR-{id} justification
- Do NOT leave empty method bodies or placeholder comments
- Do NOT mix languages — all code must be ${ctx.targetStack}
- Do NOT skip error handling — every @error-handling scenario from SPEC_LOCK needs corresponding try/catch

## SELF-VERIFICATION
- [ ] Every BR-{id} has a \`// @BR-{id}\` comment in at least one file
- [ ] Every .feature file from SPEC_LOCK has a step definition stub
- [ ] Build file (${stack.buildTool}) includes all dependencies
- [ ] API endpoints match ARCHITECT's OpenAPI contracts
- [ ] ${cloud.database} connection config is present
- [ ] README.md includes ${ctx.targetCloud} deployment instructions`;

  validationPrompts[STAGE_INDEX.FORGE] = `## VALIDATION RUBRIC — FORGE Output

### Dimension 1: BR Implementation (weight: 30%)
- Search for @BR-{id} comments in generated code
- Score = (BR-{ids} found in code / total BR-{ids} from DECODE) * 100

### Dimension 2: Code Quality (weight: 25%)
- Valid ${ctx.targetStack} syntax (compilable)?
- No empty methods, TODOs, or placeholders?
- Proper error handling?
- Score 90+: production-ready | 70-89: minor issues | <70: stubs/placeholders

### Dimension 3: Test Coverage (weight: 20%)
- Step definition stubs for every SPEC_LOCK .feature file?
- Test config for ${cloud.database}?
- Score = (feature files with step defs / total feature files) * 100

### Dimension 4: Architecture Compliance (weight: 15%)
- API endpoints match ARCHITECT's contracts?
- Service boundaries match BLUEPRINT's contexts?
- ${ctx.targetCloud} services used correctly?

### Dimension 5: File Structure (weight: 10%)
- Follows ${ctx.targetStack} project conventions?
- Build tool config present and valid?
- README with deployment instructions?

Respond with JSON: { "dimensions": [...], "overallScore": N, "passed": bool, "issues": [...] }`;

  // ── SHADOW_RUN (Stage 7) ──────────────────────────────────────
  stagePrompts[STAGE_INDEX.SHADOW_RUN] = `## ROLE
You are a release engineer performing Stage 7 (SHADOW_RUN). You design the parallel run, validation, and cutover strategy for migrating from ${sourceList} to ${ctx.targetStack} on ${ctx.targetCloud}.

## REASONING STEPS
1. **Review BLUEPRINT migration waves** — understand the extraction order
2. **Review SPEC_LOCK scenarios** — these are the pass/fail criteria
3. **Review FORGE output** — understand what's been built and where it deploys
4. **Design parallel run** — how to run old and new simultaneously
5. **Build cutover checklist** — gate criteria per wave

## OUTPUT SPECIFICATION

### Parallel Run Architecture (overview)

Include Mermaid architecture diagram showing traffic mirroring and comparison:
${fence('mermaid')}
graph LR
    LB[${cloud.api}] -->|mirror| Legacy[Legacy System]
    LB -->|mirror| Modern[${ctx.targetStack} on ${cloud.compute}]
    Modern --> Compare{Response Comparator}
    Legacy --> Compare
    Compare -->|divergence| Alert[${cloud.monitoring}]
${fenceEnd}

- Traffic mirroring strategy (${cloud.api} → dual-route)
- Data sync: ${cloud.database} replication during transition
- Feature flags for gradual traffic shift (1% → 10% → 50% → 100%)
- Circuit breakers in ${cloud.compute} for legacy fallback

### 1. Test Matrix (target: 400-600 words)

For EVERY SPEC_LOCK scenario, compare legacy vs modern execution:

| Test ID | Feature File | Scenario | Legacy Result | Modern Result | MATCH/DEVIATION | Duration (Legacy/Modern) |
|---------|-------------|----------|---------------|---------------|-----------------|--------------------------|
| T-1 | identity/login.feature | Successful login | 200 + JWT | 200 + JWT | MATCH | 120ms / 95ms |
| T-2 | identity/login.feature | Account lockout | 403 + LOCKED | 403 + LOCKED | MATCH | 85ms / 60ms |
| T-3 | commerce/order.feature | Order total calc | $125.50 | $125.49 | DEVIATION | 200ms / 150ms |

Requirements:
- One row per SPEC_LOCK scenario — no scenarios may be skipped
- Legacy Result and Modern Result must show actual response values
- MATCH = identical behavioral output; DEVIATION = any difference in status, body, or side effects
- Duration format: \`{legacy}ms / {modern}ms\`
- Summary row: Total MATCH / Total DEVIATION / Match Rate %

### 2. Behavioral Comparison (target: 300-500 words)

For EVERY DEVIATION in the Test Matrix, provide root cause analysis:

| Deviation ID | Test ID | Expected (Legacy) | Actual (Modern) | Root Cause | Fix | Fix Effort | Blocking |
|-------------|---------|-------------------|-----------------|-----------|-----|-----------|----------|
| D-1 | T-3 | $125.50 | $125.49 | Floating-point rounding in ${ctx.targetStack} | Use BigDecimal/Decimal for currency | 2h | Yes |
| D-2 | T-7 | 500 + retry | 500 + no retry | Missing retry middleware | Add ${cloud.queue} retry policy | 4h | No |

Requirements:
- Root Cause must be specific (not "logic error")
- Fix must reference specific code/config changes
- Blocking: Yes = must fix before cutover, No = can fix post-cutover

### 3. Performance Comparison (target: 300-400 words)

| Endpoint / Workflow | p50 (Legacy/Modern) | p95 (Legacy/Modern) | Throughput (Legacy/Modern) | Verdict |
|--------------------|--------------------|--------------------|---------------------------|---------|
| POST /api/v1/login | 120ms / 95ms | 350ms / 180ms | 500 rps / 800 rps | FASTER |
| GET /api/v1/orders | 200ms / 180ms | 800ms / 750ms | 300 rps / 320 rps | COMPARABLE |
| POST /api/v1/orders | 500ms / 480ms | 2000ms / 2200ms | 100 rps / 90 rps | REGRESSION |

Requirements:
- Format: \`{legacy} / {modern}\` for direct comparison
- Verdict: FASTER / COMPARABLE / REGRESSION
- REGRESSION endpoints must have mitigation plan
- Include ${cloud.monitoring} dashboard link/config for ongoing tracking

### 4. Deviation Analysis (target: 200-400 words)

Aggregate all deviations and assess cutover readiness:

| Severity | Count | Blocking | Non-Blocking | Examples |
|----------|-------|----------|-------------|----------|
| Critical | 1 | 1 | 0 | D-1: Currency rounding |
| Warning | 2 | 0 | 2 | D-2: Missing retry |
| Info | 3 | 0 | 3 | D-4: Log format difference |

Requirements:
- Severity: Critical (data/money impact), Warning (functional), Info (cosmetic/logging)
- Blocking assessment: Critical deviations are always blocking
- Include risk assessment for non-blocking deviations

### 5. Cutover Verdict (target: 200-300 words)

Provide a clear **GO** or **NO-GO** verdict:

**Verdict: GO** (or **NO-GO**)
**Confidence: {85-100}%**

| Criterion | Status | Details |
|-----------|--------|---------|
| SPEC_LOCK @happy-path pass rate | 100% ✓ | All {N} scenarios pass |
| SPEC_LOCK @edge-case pass rate | 97% ✓ | {M-1}/{M} pass (1 non-blocking) |
| Blocking deviations resolved | ✓ | D-1 fixed in commit abc123 |
| Performance regressions | 1 warning | POST /orders p95 +10% — accepted |
| ${cloud.monitoring} dashboards | ✓ | Zero critical alerts for 24h |
| Rollback tested | ✓ | DNS failback via ${cloud.cdn} verified |
| ${cloud.secrets} rotated | ✓ | All secrets rotated |

GO criteria:
- 100% @happy-path PASS
- 95%+ @edge-case PASS
- 0 blocking deviations
- No critical performance regressions
- 24h clean monitoring window

If **NO-GO**: list specific items that must be resolved with owner + ETA.

## ANTI-HALLUCINATION RULES
- ONLY reference migration waves from BLUEPRINT
- ONLY reference .feature files from SPEC_LOCK
- ONLY use ${ctx.targetCloud} services

## SELF-VERIFICATION
- [ ] **"Test Matrix" section exists** with MATCH/DEVIATION, Legacy Result, and Modern Result for every SPEC_LOCK scenario
- [ ] **"Behavioral Comparison" section exists** with Root Cause and Fix for every DEVIATION
- [ ] **"Performance Comparison" section exists** with p50, p95 latency in \`legacy / modern\` format
- [ ] **"Deviation Analysis" section exists** with Severity and Blocking assessment
- [ ] **"Cutover Verdict" section exists** with bold **GO** or **NO-GO** and Confidence score
- [ ] Parallel run Mermaid diagram is valid
- [ ] Every BLUEPRINT migration wave is covered in verdict criteria
- [ ] ${ctx.targetCloud} services used correctly`;

  validationPrompts[STAGE_INDEX.SHADOW_RUN] = `## VALIDATION RUBRIC — SHADOW_RUN Output

### Dimension 1: Parallel Run Design (weight: 30%)
- Architecture covers traffic mirroring, comparison, data sync? Valid diagram?

### Dimension 2: BDD Validation Plan (weight: 25%)
- References specific SPEC_LOCK .feature files? Pass thresholds defined per wave?

### Dimension 3: Cutover Checklist (weight: 20%)
- Per-wave checklist present? References SPEC_LOCK scenarios and ${ctx.targetCloud} services?

### Dimension 4: Risk Mitigation (weight: 15%)
- Gradual rollout strategy? Circuit breakers? Incident response plan?

### Dimension 5: ${ctx.targetCloud} Specificity (weight: 10%)
- Uses correct ${ctx.targetCloud} service names? Deployment strategy feasible?

Respond with JSON: { "dimensions": [...], "overallScore": N, "passed": bool, "issues": [...] }`;

  // ── EVOLVE (Stage 8) ──────────────────────────────────────────
  stagePrompts[STAGE_INDEX.EVOLVE] = `## ROLE
You are a platform lead performing Stage 8 (EVOLVE). You design the continuous modernization framework for the ${ctx.targetStack} system running on ${ctx.targetCloud}.

## REASONING STEPS
1. **Review SCAN/BREE** — identify remaining technical debt from initial analysis
2. **Review FORGE** — assess code quality of generated output
3. **Review SHADOW_RUN** — incorporate lessons from parallel run
4. **Design evolution framework** — patterns for ongoing improvement

## OUTPUT SPECIFICATION

### 1. KPI Dashboard (target: 400-600 words)

| KPI | Baseline (Legacy) | Target (Modern) | Current | Trend | Source |
|-----|-------------------|-----------------|---------|-------|--------|
| BR scenario pass rate | N/A (no tests) | 100% | 98% | ↑ +5% | ${stack.testFramework} CI |
| Deployment frequency | Monthly | Daily | Weekly | ↑ +300% | ${cloud.cicd} metrics |
| MTTR | 4 hours | < 30 min | 45 min | ↑ -81% | ${cloud.monitoring} incidents |
| Error rate | 2.5% | < 0.1% | 0.3% | ↑ -88% | ${cloud.monitoring} APM |
| p95 latency | 800ms | < 200ms | 180ms | ↑ -78% | ${cloud.monitoring} dashboard |
| Infrastructure cost | $X/mo (legacy) | -30% | -22% | ↑ improving | ${ctx.targetCloud} billing |
| Code coverage | 0% | > 80% | 75% | ↑ +75% | ${stack.testFramework} |

Requirements:
- Baseline must reflect legacy state from SCAN findings
- Target must be a measurable percentage or absolute value
- Trend: ↑ (improving) / → (stable) / ↓ (degrading) with percentage change
- Every KPI must have a ${ctx.targetCloud} data source for automated tracking
- Include Monitor and Alert threshold for each KPI

### 2. Operational Runbook (target: 400-600 words)

#### Monitor Setup
- **${cloud.monitoring}:** dashboard checklist (latency, errors, saturation, traffic)
- **Health checks:** ${cloud.compute} readiness + liveness probes
- **Log aggregation:** centralized logging via ${cloud.monitoring}
- **Distributed tracing:** end-to-end request tracing across services

#### Alert Configuration
- **Critical (page on-call):**
  - Error rate > 1% for 5 min → ${cloud.monitoring} alert → PagerDuty
  - p95 latency > 500ms for 10 min → ${cloud.monitoring} alert
  - ${cloud.database} connection pool exhaustion → immediate page
- **Warning (create ticket):**
  - Error rate > 0.5% for 15 min → Jira ticket
  - Disk usage > 80% → capacity planning alert
  - Certificate expiry < 30 days → renewal ticket

#### On-Call & Incident Response
- **Rotation:** weekly, 2-person buddy system
- **Escalation path:** L1 (on-call) → L2 (team lead, 15 min) → L3 (architect, 30 min)
- **Incident workflow:** detect → triage → mitigate → postmortem
- **Runbook per service:** restart procedures, ${cloud.compute} scaling, ${cloud.database} failover

### 3. Decommission Plan (target: 300-500 words)

Schedule for decommissioning legacy systems after successful cutover:

| Week | Phase | Legacy System/Component | Action | Validation | Rollback Window |
|------|-------|------------------------|--------|-----------|-----------------|
| Week 1-2 | Observation | All legacy services | Monitor dual-run metrics | Zero divergence for 14 days | Full rollback available |
| Week 3-4 | Drain | Legacy read endpoints | Redirect reads to modern | ${cloud.monitoring}: 0 legacy read traffic | Re-enable legacy reads |
| Week 5-6 | Disconnect | Legacy write endpoints | Stop writes to legacy DB | Data reconciliation: 100% match | Restore write path |
| Week 7-8 | Archive | Legacy databases | Snapshot + archive to ${cloud.storage} | Restore test passes | Restore from snapshot |
| Week 9-10 | Teardown | Legacy infrastructure | Decommission servers/VMs | N/A — point of no return | N/A |
| Week 11-12 | Cleanup | DNS, certificates, configs | Remove legacy references | Full regression suite passes | N/A |

Requirements:
- Each phase must have explicit validation criteria
- Rollback window must be defined (or marked N/A for irreversible steps)
- Data archival must comply with retention policies
- Include cost savings realized per phase

### 4. Modernization Backlog (target: 400-600 words)

| Priority | Sprint | Category | Item | Source (SCAN/BREE) | Effort | Impact | Owner |
|----------|--------|----------|------|-------------------|--------|--------|-------|
| P0 | Sprint 1 | Security | Harden auth token rotation | SCAN: security findings | 2 sprints | High | Security Team |
| P0 | Sprint 1 | Performance | Add ${cloud.cache} for report queries | BREE: high-read modules | 1 sprint | High | Platform Team |
| P1 | Sprint 2 | Observability | Add distributed tracing | SHADOW_RUN: p95 gaps | 1 sprint | Medium | Platform Team |
| P1 | Sprint 3 | API | API versioning strategy for ${stack.apiStyle} | ARCHITECT: TD-2 | 1 sprint | Medium | API Team |
| P2 | Sprint 4 | Database | ${stack.orm} migration workflow automation | FORGE: manual migrations | 0.5 sprint | Low | Data Team |
| P2 | Sprint 5 | DevOps | Feature flag lifecycle management | EVOLVE: best practice | 1 sprint | Medium | DevOps Team |
| P3 | Sprint 6 | Maintenance | ${stack.buildTool} dependency update automation | BREE: outdated deps | 0.5 sprint | Low | DevOps Team |

Requirements:
- Priority: P0 (do now) / P1 (next sprint) / P2 (backlog) / P3 (nice-to-have)
- Sprint assignment for P0 and P1 items
- Every item must reference a source from SCAN, BREE, FORGE, or SHADOW_RUN
- At least 5 items with effort estimates

### 5. Cost Optimization (target: 300-500 words)

| ID | Opportunity | Current Cost ($/mo) | Optimized Cost ($/mo) | Savings ($/mo) | Implementation | Timeline |
|----|------------|--------------------:|---------------------:|---------------:|---------------|----------|
| CO-1 | Right-size ${cloud.compute} instances | $600 | $400 | $200 | Auto-scaling policy + spot instances | Sprint 2 |
| CO-2 | Reserved ${cloud.database} instances | $400 | $280 | $120 | 1-year reserved instance commitment | Sprint 3 |
| CO-3 | ${cloud.cache} tiered storage | $100 | $60 | $40 | TTL-based eviction + hot/cold separation | Sprint 4 |
| CO-4 | ${cloud.storage} lifecycle policies | $80 | $30 | $50 | Move old artifacts to infrequent access | Sprint 2 |
| CO-5 | Legacy infrastructure teardown | $X | $0 | $X | Execute Decommission Plan above | Week 10 |
| **Total** | | | | **$410+** | | |

Requirements:
- All costs must be in $ with monthly granularity
- Savings must be realistic based on ${ctx.targetCloud} pricing
- Include both quick wins (Sprint 1-2) and long-term optimizations
- Reference Decommission Plan for legacy cost elimination

## ANTI-HALLUCINATION RULES
- Technical debt / backlog items must reference specific SCAN findings or BREE data
- ${ctx.targetCloud} services by correct name only
- KPI targets must be measurable (no "improve quality")
- Cost figures must be realistic for ${ctx.targetCloud} pricing

## SELF-VERIFICATION
- [ ] **"KPI Dashboard" section exists** with Baseline, Target, and percentage metrics for each KPI
- [ ] **"Operational Runbook" section exists** with Monitor setup and Alert thresholds
- [ ] **"Decommission Plan" section exists** with Week-based Phase schedule
- [ ] **"Modernization Backlog" section exists** with Sprint and Priority assignments
- [ ] **"Cost Optimization" section exists** with $ savings per optimization opportunity
- [ ] Modernization backlog has at least 5 items with SCAN/BREE source
- [ ] Runbook covers ${cloud.monitoring} setup specifically
- [ ] KPI targets are quantified with measurable values`;

  validationPrompts[STAGE_INDEX.EVOLVE] = `## VALIDATION RUBRIC — EVOLVE Output

### Dimension 1: Tech Debt Quality (weight: 30%)
- Items reference specific SCAN/BREE findings? Prioritized with effort estimates?

### Dimension 2: Evolution Patterns (weight: 25%)
- Practical for ${ctx.targetStack}? Covers API versioning, DB migrations, feature flags?

### Dimension 3: Operational Readiness (weight: 25%)
- ${ctx.targetCloud} monitoring setup specific? Alert thresholds defined? Incident response actionable?

### Dimension 4: Metrics (weight: 20%)
- Measurable targets? Tied to BR-{ids} and ${ctx.targetCloud} tooling?

Respond with JSON: { "dimensions": [...], "overallScore": N, "passed": bool, "issues": [...] }`;

  return { stagePrompts, validationPrompts };
}

// ─── PERSIST TO PROJECT ─────────────────────────────────────────

/**
 * Generate and save tailored prompts for a project.
 * Called after SCAN completes or when project config changes.
 */
export async function generateAndSaveProjectPrompts(
  projectId: string,
  pipelineRunId: string,
): Promise<{ stagesPopulated: number }> {
  // Load project config
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: {
      target_stack: true,
      target_cloud: true,
      description: true,
      config: true,
      stage_prompts: true,
      validation_prompts: true,
    },
  });

  if (!project) throw new Error("Project not found");

  // Load SCAN output
  const scanArtifact = await db.query.stageArtifacts.findFirst({
    where: and(
      eq(stageArtifacts.pipeline_run_id, pipelineRunId),
      eq(stageArtifacts.stage_name, "SCAN"),
      eq(stageArtifacts.artifact_type, "stage_output"),
    ),
  });

  const scanOutput = (scanArtifact?.metadata as any)?.content || "";
  if (!scanOutput) {
    throw new Error("SCAN output not found — run Stage 1 first");
  }

  // Load BREE analysis artifact
  const breeArtifact = await db.query.stageArtifacts.findFirst({
    where: and(
      eq(stageArtifacts.pipeline_run_id, pipelineRunId),
      eq(stageArtifacts.stage_name, "SCAN"),
      eq(stageArtifacts.artifact_type, "bree_analysis"),
    ),
  });

  const breeAnalysis = breeArtifact?.metadata as any;

  // Extract source languages from BREE or SCAN
  const config = project.config as Record<string, unknown> || {};
  const sourceLanguages = (config.sourceLanguages as string[])
    || breeAnalysis?.detection?.profile?.primary?.map((l: any) => l.language_id)
    || ["Unknown"];

  // Generate tailored prompts
  const ctx: ScanContext = {
    scanOutput,
    breeAnalysis,
    targetStack: project.target_stack || "Java/Spring Boot",
    targetCloud: project.target_cloud || "AWS",
    sourceLanguages,
    projectDescription: project.description || undefined,
  };

  const { stagePrompts, validationPrompts } = generateStagePrompts(ctx);

  // Merge with existing prompts (don't overwrite manual edits for SCAN)
  const existingStagePrompts = (project.stage_prompts as Record<string, string>) || {};
  const existingValidationPrompts = (project.validation_prompts as Record<string, string>) || {};

  const mergedStagePrompts = {
    ...existingStagePrompts,
    ...stagePrompts, // stages 1-7 (DECODE through EVOLVE)
  };

  // Preserve SCAN prompt if manually set
  if (existingStagePrompts[STAGE_INDEX.SCAN]) {
    mergedStagePrompts[STAGE_INDEX.SCAN] = existingStagePrompts[STAGE_INDEX.SCAN];
  }

  const mergedValidationPrompts = {
    ...existingValidationPrompts,
    ...validationPrompts,
  };

  // Save to project
  await db.update(projects).set({
    stage_prompts: mergedStagePrompts,
    validation_prompts: mergedValidationPrompts,
    updated_at: new Date(),
  }).where(eq(projects.id, projectId));

  return { stagesPopulated: Object.keys(stagePrompts).length };
}
