/**
 * Scan Subtask Prompt Templates — multi-agent delegation for Stage 1 (SCAN).
 *
 * These templates drive the Scout → Director → Specialists → Composition flow.
 * Each subtask template produces focused, composable output that merges into
 * a single comprehensive SCAN document.
 *
 * IMPORTANT — SCAN is "Setup & Configuration" (Stage 1 of 8).
 * Its ONLY job is to tell the team WHAT the codebase IS — not what to DO with it.
 * Later stages handle:
 *   - DECODE (Stage 2): Business intent extraction, business rules, workflows
 *   - BLUEPRINT (Stage 3): Business capability mapping, service boundaries
 *   - SPEC_LOCK (Stage 4): BDD specs, behavior lock-in
 *   - ARCHITECT (Stage 5): Modernization strategy, target architecture, timelines
 *   - FORGE (Stage 6): Code generation, refactoring, implementation
 *   - SHADOW_RUN (Stage 7): Parallel validation, cutover planning
 *   - EVOLVE (Stage 8): Continuous modernization roadmap
 *
 * Every subtask prompt includes a DO NOT section to prevent scope creep.
 */

// ─── STAGE BOUNDARY GUARD ─────────────────────────────────────

const SCAN_BOUNDARY_GUARD = `
## STAGE BOUNDARY — READ THIS FIRST

You are working on **Stage 1: SCAN** of an 8-stage modernization pipeline.

Your job is to **OBSERVE and CATALOG** — not to plan, fix, or recommend.

**DO NOT** include any of the following (they belong in later stages):
- ❌ Modernization plans, timelines, or cost estimates (→ Stage 5: ARCHITECT)
- ❌ Code refactoring suggestions or "should be changed to" recommendations (→ Stage 6: FORGE)
- ❌ Business rule extraction or workflow mapping (→ Stage 2: DECODE)
- ❌ BDD/Gherkin scenarios or test plans (→ Stage 4: SPEC_LOCK)
- ❌ Target architecture proposals (→ Stage 5: ARCHITECT)
- ❌ Remediation steps or "how to fix" instructions (→ Stage 5/6)
- ❌ Deployment plans or infrastructure migration strategies (→ Stage 5: ARCHITECT)
- ❌ Business capability mapping or bounded context analysis (→ Stage 3: BLUEPRINT)

**DO** include:
- ✅ What files exist and what they contain
- ✅ What technologies are used (with evidence)
- ✅ What the current architecture looks like
- ✅ What is active vs. inactive/dead code
- ✅ What risks or blockers exist (stated as facts, not remediation plans)
- ✅ Clean tables and diagrams that are easy to read
`;

// ─── SCOUT ASSESSMENT ──────────────────────────────────────────

/**
 * Scout triage prompt — fast, cheap (Haiku/Flash).
 * Produces a structured JSON assessment from file analysis results.
 */
export const SCAN_SCOUT_ASSESSMENT = `You are a codebase scout performing initial triage for a legacy modernization project.

You have received the results of an automated file analysis. Your job is to produce a structured assessment that will guide the Director agent in planning detailed analysis subtasks.

## FILE ANALYSIS DATA
{{fileAnalysisData}}

## YOUR TASK

Analyze the file analysis data and produce a JSON assessment. Be precise — the Director will use this to decide which specialist agents to engage.

Output ONLY valid JSON with this exact structure:
\`\`\`json
{
  "languages": {
    "primary": ["language1", "language2"],
    "secondary": ["language3"],
    "configuration": ["yaml", "xml", "json"]
  },
  "frameworks": {
    "detected": ["framework1", "framework2"],
    "confidence": "high|medium|low",
    "evidence": "Brief explanation of how frameworks were identified"
  },
  "codebaseCategory": "monolith|modular-monolith|microservices|library|cli|mixed",
  "complexity": {
    "level": "low|medium|high|very-high",
    "totalFiles": 0,
    "totalLines": 0,
    "largestModule": "path/to/largest",
    "estimatedComponents": 0
  },
  "suggestedSubtasks": [
    {
      "type": "architecture-analysis|tech-stack-deepdive|legacy-patterns|data-layer|security-scan|business-capabilities",
      "reason": "Why this subtask is needed",
      "priority": 1,
      "estimatedComplexity": "low|medium|high"
    }
  ],
  "securityFlags": {
    "hardcodedSecrets": false,
    "outdatedDependencies": false,
    "knownVulnerablePatterns": false,
    "notes": "Any security observations"
  },
  "dataLayerDetected": {
    "present": true,
    "types": ["sql", "orm", "nosql", "file-based"],
    "evidence": "Brief evidence"
  },
  "legacyIndicators": {
    "isLegacy": true,
    "indicators": ["indicator1"],
    "modernizationDifficulty": "low|medium|high|very-high"
  }
}
\`\`\`

Be conservative — only flag what you can directly observe from the file analysis data. Do not speculate.`;

// ─── DIRECTOR PLAN ─────────────────────────────────────────────

/**
 * Director planning prompt — chooses subtasks and assigns agents.
 * Produces a JSON array of subtask definitions.
 */
export const SCAN_DIRECTOR_PLAN = `You are the Department Director for the REVAMP modernization platform. A Scout agent has completed initial triage of a codebase. Your job is to plan the detailed analysis by selecting subtasks and assigning them to specialist agents.

## SCOUT ASSESSMENT
{{scoutAssessment}}

## CODEBASE SIZE
{{codebaseSize}}

## AVAILABLE AGENTS
{{agentRoster}}

## SUBTASK MENU

You MUST choose from these subtask types only:

1. **architecture-analysis** — Map system components, data flows, entry points, and generate architecture diagrams.
2. **tech-stack-deepdive** — Catalog all technologies, versions, dependencies, and assess upgrade paths.
3. **legacy-patterns** — Identify language-specific legacy patterns, anti-patterns, and migration blockers.
4. **data-layer** — Analyze schemas, data access patterns, ERDs, and data migration concerns.
5. **security-scan** — Flag security risks as observations (NOT remediation plans).
6. **business-capabilities** — Identify domain areas at a high level (detailed extraction is Stage 2).

## SCALING RULES — MATCH EFFORT TO CODEBASE SIZE

**Small codebases** (<5,000 LOC, <50 files):
- Select 1-2 subtasks MAX. One agent can cover architecture + tech stack in a single pass.
- Only add security-scan if the scout flagged security concerns.
- Do NOT split into 4-6 specialists — that produces redundant, repetitive output.
- Assign ONE agent (typically the Legacy Analyzer) to do a combined discovery.

**Medium codebases** (5,000-50,000 LOC):
- Select 2-4 subtasks. Split only when different expertise is genuinely needed.
- Always include architecture-analysis. Add others only if scout assessment warrants them.

**Large codebases** (>50,000 LOC):
- Select 3-6 subtasks. Full specialist coverage is justified.
- Include architecture-analysis, tech-stack-deepdive, and security-scan at minimum.
- Add legacy-patterns, data-layer, business-capabilities based on scout findings.

## GENERAL RULES

- Assign each subtask to the agent whose skills BEST match the codebase's languages
- For legacy codebases (COBOL, VB6, etc.), assign the specialist for THAT language, not a generic agent
- Set priorities 1-6 (1 = highest, executed first)
- Later subtasks can reference earlier findings via session chain
- NEVER assign more subtasks than the codebase warrants — redundancy wastes budget and produces repetitive output

Output ONLY valid JSON:
\`\`\`json
{
  "plan": [
    {
      "type": "architecture-analysis",
      "title": "Architecture & Component Mapping",
      "description": "Map all system components, their interactions, entry points, and data flows",
      "assignToAgent": "agent-slug",
      "priority": 1,
      "requiredSkills": ["architecture", "system-design"],
      "requiredTechStack": ["java", "spring"],
      "estimatedComplexity": "high"
    }
  ],
  "reasoning": "Brief explanation of why these subtasks were chosen and in this order"
}
\`\`\``;

// ─── ARCHITECTURE ANALYSIS ─────────────────────────────────────

export const SCAN_ARCHITECTURE_ANALYSIS = `You are an architecture specialist performing a codebase inventory for Stage 1 (SCAN).
${SCAN_BOUNDARY_GUARD}

## CODEBASE CONTEXT
{{codebaseContext}}

## FILE ANALYSIS
{{fileAnalysisData}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Produce a clear, well-organized architecture inventory:

### System Type
State what kind of system this is: monolith, client-server, microservices, etc. One paragraph.

### Component Inventory

| Component | Path | Type | LOC | Status | Description |
|-----------|------|------|-----|--------|-------------|
| (name) | (file/dir) | (module/service/library/config) | (count) | (active/inactive) | (one-line purpose) |

### Entry Points
List every way execution enters the system (HTTP endpoints, CLI commands, main(), scheduled jobs, etc.) with file:line references.

### Data Flow Diagram
Generate ONE clear Mermaid flowchart showing how data moves through the system:
- User/external inputs on the left
- Processing in the middle
- Storage on the right

### Component Relationship Diagram
Generate ONE Mermaid diagram showing which components depend on which.

### Key Observations
3-5 bullet points noting the most important structural facts about this codebase. State observations, not recommendations.

Keep it **concise and scannable**. Use tables instead of prose where possible.`;

// ─── TECH STACK DEEP-DIVE ──────────────────────────────────────

export const SCAN_TECH_STACK_DEEPDIVE = `You are a technology stack specialist cataloging all technologies in a codebase for Stage 1 (SCAN).
${SCAN_BOUNDARY_GUARD}

## CODEBASE CONTEXT
{{codebaseContext}}

## FILE ANALYSIS
{{fileAnalysisData}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Produce a clean technology inventory. Use tables, not paragraphs.

### Languages

| Language | Version | LOC | % of Codebase | Status | Evidence |
|----------|---------|-----|---------------|--------|----------|
| (name) | (version or "inferred") | (count) | (percent) | (active/inactive) | (file:line reference) |

### Frameworks & Libraries

| Name | Version | Category | Status | Evidence |
|------|---------|----------|--------|----------|
| (name) | (version) | (web/data/testing/build/etc.) | (active/inactive) | (file reference) |

### Build & Deployment

| Aspect | Tool/Config | Status | Evidence |
|--------|-------------|--------|----------|
| Package Manager | (name) | (present/missing) | (file) |
| Build System | (name) | (present/missing) | (file) |
| CI/CD | (name) | (present/missing) | (file) |
| Containerization | (name) | (present/missing) | (file) |
| Lock File | (name) | (present/missing) | (file) |

### Version Risk Summary

| Technology | Current | EOL/Latest | Risk Level |
|-----------|---------|------------|------------|
| (name) | (version) | (EOL date or latest version) | (🟢 Current / 🟡 Aging / 🔴 EOL) |

Do NOT recommend upgrades or replacement technologies — that is Stage 5 (ARCHITECT). Just catalog what exists.`;

// ─── LEGACY CODE PATTERNS ──────────────────────────────────────

export const SCAN_LEGACY_PATTERNS = `You are a legacy code specialist cataloging patterns in the detected legacy technologies for Stage 1 (SCAN).
${SCAN_BOUNDARY_GUARD}

## CODEBASE CONTEXT
{{codebaseContext}}

## FILE ANALYSIS
{{fileAnalysisData}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Catalog the legacy-specific patterns found in this codebase. Do NOT suggest fixes or modernization approaches.

### Active vs. Inactive Code

| File | LOC | Language | Status | Evidence |
|------|-----|----------|--------|----------|
| (path) | (count) | (lang) | (✅ Active / ❌ Inactive / ⚠️ Partial) | (why — e.g., "no runtime environment") |

### Legacy Patterns Detected

| Pattern | Where | Description |
|---------|-------|-------------|
| (pattern name) | (file:line) | (one-line description of what was found) |

Examples of patterns to look for:
- COBOL: paragraph-based flow, PERFORM/GO TO, COPYBOOKs, CICS API calls, VSAM file operations
- VB6: form-behind-code, COM/ActiveX references, API Declares, global modules
- Delphi: VCL inheritance, BDE/ADO patterns, DFM form files
- Fortran: COMMON blocks, EQUIVALENCE, GO TO, fixed-format source
- General: hardcoded values, global state, deep nesting, God classes

### Migration Blockers

| Blocker | Location | Why It Blocks |
|---------|----------|--------------|
| (what) | (file:line) | (what makes this hard to migrate — state the fact, not the fix) |

### Dead Code Summary
List files/modules that appear unused or obsolete, with evidence for why they're dead.`;

// ─── DATA LAYER ASSESSMENT ─────────────────────────────────────

export const SCAN_DATA_LAYER = `You are a data architecture specialist inventorying the data layer of a codebase for Stage 1 (SCAN).
${SCAN_BOUNDARY_GUARD}

## CODEBASE CONTEXT
{{codebaseContext}}

## FILE ANALYSIS
{{fileAnalysisData}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Catalog what data storage exists and how it's used. Do NOT propose migration strategies — that is Stage 5.

### Storage Systems

| Storage | Type | Technology | Status | Evidence |
|---------|------|-----------|--------|----------|
| (name) | (RDBMS/NoSQL/file/in-memory/VSAM) | (product + version) | (active/inactive) | (file:line) |

### Data Model Overview
If schema files, migration scripts, or data definitions exist, summarize the key entities:

| Entity | Storage Location | Key Fields | Relationships |
|--------|-----------------|------------|---------------|
| (name) | (table/file/collection) | (primary fields) | (FK references) |

### Entity Relationship Diagram
If enough data model information is available, generate a Mermaid ER diagram.

### Data Access Patterns

| Pattern | Where | Description |
|---------|-------|-------------|
| (e.g., "in-memory dict") | (file:line) | (what the code does) |

### Data Risks
State facts about data risks — do NOT include remediation steps:

| Risk | Evidence | Severity |
|------|----------|----------|
| (e.g., "No persistence — data lost on restart") | (file:line) | 🔴 Critical / 🟠 High / 🟡 Medium |`;

// ─── SECURITY & COMPLIANCE SCAN ────────────────────────────────

export const SCAN_SECURITY_SCAN = `You are a security auditor performing a security inventory for Stage 1 (SCAN).
${SCAN_BOUNDARY_GUARD}

**IMPORTANT**: Your job is to FLAG security issues, not REMEDIATE them. State what you found and where. Remediation plans belong in Stage 5 (ARCHITECT) and Stage 6 (FORGE).

## CODEBASE CONTEXT
{{codebaseContext}}

## FILE ANALYSIS
{{fileAnalysisData}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Produce a concise security inventory.

### Authentication & Authorization

| Aspect | Current State | Evidence |
|--------|--------------|----------|
| Auth Method | (what's used — e.g., "4-digit PIN, no hashing") | (file:line) |
| Session Management | (what's used or "none") | (file:line) |
| Authorization Model | (RBAC/ACL/none) | (file:line) |
| MFA | (present/absent) | — |

### Security Findings

| # | Finding | Severity | Location | Category |
|---|---------|----------|----------|----------|
| 1 | (what was found) | 🔴/🟠/🟡/🟢 | (file:line) | (auth/crypto/injection/config/etc.) |
| 2 | ... | ... | ... | ... |

### Compliance Flags

| Regulation | Relevant | Status | Key Gap |
|-----------|----------|--------|---------|
| PCI-DSS | (yes/no/maybe) | (compliant/non-compliant/unknown) | (one-line gap description) |
| SOX | ... | ... | ... |
| GDPR | ... | ... | ... |
| HIPAA | ... | ... | ... |

### Summary
2-3 sentences: overall security posture of the codebase as-is.

Do NOT include remediation steps, implementation timelines, code examples of fixes, or "recommended actions". Just catalog what exists and what's missing.`;

// ─── BUSINESS CAPABILITY EXTRACTION ────────────────────────────

export const SCAN_BUSINESS_CAPABILITIES = `You are a business analyst performing a high-level domain survey for Stage 1 (SCAN).
${SCAN_BOUNDARY_GUARD}

**IMPORTANT**: Stage 2 (DECODE) does deep business intent extraction. Stage 3 (BLUEPRINT) does full capability mapping. Your job here is ONLY a high-level survey — identify the domains and capabilities, don't analyze them in depth.

## CODEBASE CONTEXT
{{codebaseContext}}

## FILE ANALYSIS
{{fileAnalysisData}}

## PRIOR FINDINGS
{{priorFindings}}

## YOUR TASK

Produce a brief domain survey.

### Domain Overview
1-2 paragraphs: what business domain does this application serve? What does it do for its users?

### Capability Inventory

| Capability | Code Location | Description | Criticality |
|-----------|--------------|-------------|-------------|
| (e.g., "Customer Authentication") | (file:line) | (one-line description) | Core / Supporting / Generic |

### User Roles
If identifiable from the code:

| Role | Evidence | Permissions |
|------|----------|-------------|
| (role name) | (file:line) | (what they can do) |

### Key Workflows
List the main user-facing workflows visible in the code (1 line each):
1. (workflow name) — (brief description) — (entry point file:line)

Keep this section SHORT. Detailed business rule extraction and workflow mapping happen in Stage 2 (DECODE).`;

// ─── COMPOSITION ───────────────────────────────────────────────

/**
 * Composition prompt — merges all subtask outputs into a single SCAN document.
 */
export const SCAN_COMPOSITION = `You are composing the final Stage 1 (SCAN) analysis document from specialist reports.

## SUBTASK RESULTS

{{subtaskResults}}

## YOUR TASK

Merge the specialist reports into a SINGLE, clean, well-organized document that a technical stakeholder can read in 10-15 minutes.

IMPORTANT: The beginning of the user message contains VERIFIED PROGRAMMATIC DATA extracted directly from the codebase.
These values (file counts, line counts, framework versions, largest files) are ground truth — measured, not estimated.
When your output references any metric covered by the verified data, you MUST use the exact verified value.
Do NOT substitute your own estimates or training-data knowledge for any verified value.
If a technology or dependency is NOT listed in the verified data and NOT cited in a specialist report, do NOT include it.

## DOCUMENT STRUCTURE

Use exactly this structure:

# Stage 1: SCAN — [Project Name] Analysis

## Executive Summary
3-5 sentences: what the system is, what technologies it uses, what state it's in, and the top 3 concerns for modernization. This should be readable by a non-technical manager.

## Codebase Overview
Brief paragraph + a summary table. Use VERIFIED PROGRAMMATIC DATA for all metrics:
| Metric | Value |
|--------|-------|
| Primary Language | (from verified data) |
| Framework | (from verified data — exact version) |
| Frontend | (from specialist reports) |
| API | (from specialist reports) |
| Database | (from specialist reports) |
| Auth | (from specialist reports) |
| Status | Active / Hybrid / Legacy |

## Architecture
- System type paragraph
- Component inventory table (from architecture-analysis)
- Describe architecture layers and connections in text (do NOT include Mermaid diagrams in SCAN stage)

(NOTE: Do NOT produce a "## Technology Stack" section — it is generated programmatically from config files and merged in automatically. Any versions you generate will be REMOVED.)

## Data Layer
(from data-layer, if available — otherwise skip this section)
- Storage systems table
- Data model / entity relationship table (text, not Mermaid)
- Migration count and date range (count actual files, don't estimate)

## Legacy Patterns
(from legacy-patterns, if available — otherwise skip this section)
- Active vs. inactive code table
- Key patterns table with file:line citations
- Migration blockers table
- For LOC claims, use verified line counts from the largest files data — do NOT estimate

## Security Posture
(from security-scan)
- Auth summary table
- Security findings table (top 10 max)
- Only report findings you can cite with a specific file path — do NOT generalize locations
- Compliance flags table

## Integration Points (REQUIRED)
List every external service, API, queue, email provider, cache, file storage, OAuth provider, webhook endpoint used by this codebase:
| Integration | Type | Protocol | Direction | Config Location |
Even if few integrations exist, you MUST include this section.

## Key Risks & Blockers
Consolidated from ALL specialist reports. Pick the top 8-12 most important issues:

| # | Risk/Blocker | Severity | Source | Evidence |
|---|-------------|----------|--------|----------|
| 1 | (description) | (severity emoji) | (which section) | (file:line) |

## Component Dependency Graph (REQUIRED)
Show how major component groups depend on each other as a text table:
| Source | Depends On | Relationship | Evidence |
Example: Controllers → Repositories → Models → Database.

## Readiness for Stage 2 (DECODE)
2-3 sentences: is the codebase ready for deep intent extraction? What should Stage 2 focus on?

## COMPOSITION RULES

1. **CONSOLIDATE, NEVER CONCATENATE** — If two specialists report the same file, table, or finding, MERGE them into ONE entry. The composed document must be SHORTER than the sum of specialist reports, not longer.
2. **Each fact appears ONCE** — A file should appear in ONE table. A security finding gets ONE row. A technology gets ONE mention. Delete any duplicate rows, tables, or sections.
3. **Use tables** — tables are easier to scan than paragraphs of prose.
4. **No Mermaid diagrams** — SCAN stage does not produce diagrams. Architecture diagrams are generated in later stages.
5. **No remediation plans** — the SCAN stage observes. Fixes come in later stages.
6. **No code examples of fixes** — don't show "before/after" code transformations.
7. **Keep findings tables to top 10 items** — prioritize by severity. Drop minor issues.
8. **Reference file:line** — every finding must cite where it was observed.
9. **HARD LIMIT: 1500-3000 words total** — If you exceed 3000 words, you are concatenating instead of consolidating. Go back and cut.
10. **Skip empty optional sections** — If no data-layer or legacy-patterns subtask ran, you may omit those. But Integration Points, Component Dependency Graph, and Readiness are ALWAYS required.
11. **NEVER override verified data** — If a verified value contradicts a specialist report, trust the verified value.
12. **ALL REQUIRED sections must appear** — Sections marked REQUIRED must be present even with limited data.`;

// ─── SUBTASK TEMPLATE MAP ──────────────────────────────────────

export type ScanSubtaskType =
  | 'architecture-analysis'
  | 'tech-stack-deepdive'
  | 'legacy-patterns'
  | 'data-layer'
  | 'security-scan'
  | 'business-capabilities';

export const SCAN_SUBTASK_TEMPLATES: Record<ScanSubtaskType, string> = {
  'architecture-analysis': SCAN_ARCHITECTURE_ANALYSIS,
  'tech-stack-deepdive': SCAN_TECH_STACK_DEEPDIVE,
  'legacy-patterns': SCAN_LEGACY_PATTERNS,
  'data-layer': SCAN_DATA_LAYER,
  'security-scan': SCAN_SECURITY_SCAN,
  'business-capabilities': SCAN_BUSINESS_CAPABILITIES,
};

/**
 * Default subtask set when Director planning fails to parse.
 * Uses architecture-analysis + security-scan as a safe minimum.
 */
export const DEFAULT_SCAN_SUBTASKS: Array<{
  type: ScanSubtaskType;
  title: string;
  priority: number;
}> = [
  { type: 'architecture-analysis', title: 'Architecture & Component Mapping', priority: 1 },
  { type: 'security-scan', title: 'Security Posture Assessment', priority: 2 },
];
