# Three-Repo Feature Observation Report for REVAMP 10X

**Repositories Analyzed:**
- [obra/superpowers](https://github.com/obra/superpowers) — 107K stars, MIT, Shell/Markdown
- [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — 32K stars, MIT, TypeScript
- [volcengine/OpenViking](https://github.com/volcengine/OpenViking) — Apache-2.0, Python/Rust/Go

**Date:** 2026-03-23

---

## Executive Summary

Each repo solves a different slice of the AI agent problem. Together they form a complete picture of what a mature agent-powered modernization platform needs:

| Repo | What It Is | Primary Value for REVAMP |
|------|-----------|------------------------|
| **Superpowers** | Agentic skills framework — enforces engineering discipline on AI coding agents via structured Markdown skills | Anti-rationalization engineering, mandatory hard-gated pipelines, two-stage review, subagent-driven development |
| **Paperclip** | Orchestration control plane for "zero-human companies" — the org chart, budgets, governance, and heartbeat execution layer above agents | Adapter registry for heterogeneous runtimes, heartbeat budget control, atomic task checkout, session compaction, approval gates, company portability/templates |
| **OpenViking** | Context Database for AI Agents — filesystem-paradigm context management with tiered loading, hierarchical retrieval, and automatic session memory extraction | AST-based code skeletonization, hierarchical retrieval with rerank, 6-category memory extraction, memory hotness lifecycle, session compressor with dedup |

---

## 1. SUPERPOWERS — Agentic Skills Framework

### What It Does
Superpowers is NOT a code library — it's a collection of **skill documents** (Markdown + YAML frontmatter) injected into AI agent context to enforce disciplined engineering workflows. It intercepts the agent's workflow and forces a structured pipeline: brainstorm → plan → execute via subagents → two-stage review → verify.

### Features to Adopt

#### 1.1 Anti-Rationalization Engineering (HIGH PRIORITY)
**The Problem:** AI agents rationalize their way out of following processes. They'll claim "this is simple enough to skip validation" or "the test is obvious so I'll skip it."

**Superpowers' Solution:** Skills contain explicit rationalization tables mapping common excuses to rebuttals, red-flags lists of evasion-indicator thoughts, and loophole-closing language. Skills are themselves TDD-tested — baseline tests prove agents fail without the skill, then refined until agents comply under pressure scenarios.

**For REVAMP:** Create anti-rationalization protections for legacy-modernization-specific evasions:
- "This COBOL dead code can be safely dropped" → Require evidence (call-graph proof)
- "The business rule is obvious, no BDD spec needed" → Never skip behavior lock-in
- "This batch job is simple enough for direct translation" → Always analyze data dependencies first
- "The PERFORM VARYING loop translates directly to a for-loop" → Check for side effects and COPY expansions

**Implementation:** Add a `rationalization_guards` field to prompt templates in `core-engine/src/prompts/`. Each REVAMP pipeline stage gets its own guard table.

#### 1.2 Mandatory Pipeline with Hard Gates (HIGH PRIORITY)
**Pattern:** Each pipeline stage has a `<HARD-GATE>` that prevents skipping ahead. The brainstorming skill literally says "Do NOT write any code until the user has approved the design."

**For REVAMP:** Enforce that no agent can proceed from Intent Extraction to Capability Mining without passing the contract validation gate. Currently our contract validation can be bypassed if the validation comes back with warnings. Hard gates should block on `critical` violations regardless of agent preference.

**Implementation:** Add `hardGate: boolean` to `StageContract` in `stage-contracts.ts`. When true, the pipeline refuses to advance if `passed === false`, even if the agent says "output is usable."

#### 1.3 Subagent-Driven Development (SDD) (HIGH PRIORITY)
**Pattern:** A controller agent coordinates by:
1. Reading a plan and extracting all tasks
2. Dispatching a fresh subagent per task with precisely crafted context (never session history)
3. Running two-stage review: spec-compliance then code-quality
4. Handling status codes: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED

Each subagent gets **isolated context** — the controller constructs exactly what it needs. This prevents context pollution.

**For REVAMP:** We already have subtask delegation in scan/decode orchestrators. Enhance with:
- **Fresh context per subtask** — don't pass full session chain, construct minimal needed context
- **Status codes** — add `NEEDS_CONTEXT` and `BLOCKED` states to `agent_subtasks` table
- **Model selection by complexity** — cheap models (Haiku/Flash) for mechanical extraction, Sonnet for architectural decisions

**Implementation:** Add `status` enum values `needs_context`, `blocked` to agent_subtasks schema. Add `model_override` field to `SubtaskPlan` type.

#### 1.4 Two-Stage Review (MEDIUM-HIGH PRIORITY)
**Pattern:** After code is written, two independent reviewers run:
1. **Spec Compliance Reviewer** — "Did you build what was asked?"
2. **Code Quality Reviewer** — "Is it well-built?"

The spec reviewer's prompt includes "CRITICAL: Do Not Trust the Report" — forcing independent verification.

**For REVAMP:** Apply to modernization output:
1. **Behavioral Equivalence Reviewer** — "Does the modernized service preserve the same business behavior as the original COBOL?"
2. **Architecture Quality Reviewer** — "Is the modernized code well-architected for the target platform?"

**Implementation:** Add a `reviewSubtask` step after each specialist subtask in the orchestrators. The review agent gets the original legacy code + the transformation output + the BDD specs, and must independently verify.

#### 1.5 Git Worktree Isolation (MEDIUM PRIORITY)
**Pattern:** Each task runs in an isolated git worktree. Multiple parallel modernization strategies can be compared.

**For REVAMP:** Already partially supported via the codebase clone during SCAN. Extend to create per-subtask worktrees during Co-Create (Stage 6) so multiple transformation approaches can be tested in parallel.

#### 1.6 Bite-Sized Task Decomposition (MEDIUM PRIORITY)
**Pattern:** Each plan step is 2-5 minutes, with exact file paths, complete code, and verification commands.

**For REVAMP:** Enforce subtask granularity limits. A subtask like "Analyze all 200 COBOL programs" should be rejected by the Director in favor of "Analyze CUST-001.cob through CUST-010.cob" chunks.

---

## 2. PAPERCLIP — Agent Orchestration Control Plane

### What It Does
Paperclip is the "company" that sits above individual AI agents. It provides org charts, goals, budgets, task assignment, governance/approvals, cost tracking, and a heartbeat-based execution model. Agents run externally and "phone home" to the control plane.

### Features to Adopt

#### 2.1 Adapter Pattern for Heterogeneous Runtimes (HIGH PRIORITY)
**Pattern:** The `ServerAdapterModule` interface:
```typescript
interface ServerAdapterModule {
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx): Promise<AdapterEnvironmentTestResult>;
  sessionCodec: AdapterSessionCodec;
  onHireApproved(payload, config): Promise<HireApprovedResult>;
}
```
10+ adapters: Claude Code, Codex, Cursor, Gemini, OpenCode, HTTP webhook, etc.

**For REVAMP:** Currently all agents use the same Go LLM orchestrator. Different modernization tasks need different capabilities:
- COBOL parsing → specialized static analysis tool adapter
- Code transformation → LLM adapter (Claude/GPT)
- Test generation → test framework adapter
- Deployment verification → CI/CD adapter

**Implementation:** Create `apps/api/src/adapters/` directory with `AdapterInterface`, then adapters like `llm-adapter.ts`, `static-analysis-adapter.ts`, `test-runner-adapter.ts`. The agent execution service picks the right adapter based on the subtask type.

#### 2.2 Heartbeat-Based Execution with Budget Control (HIGH PRIORITY)
**Pattern:** Agents execute in short "heartbeats" — not continuously. Each heartbeat:
1. Budget pre-flight check (enough budget for this run?)
2. Wake agent with context
3. Agent does work
4. Record costs, session state
5. Auto-pause if budget exhausted

Budget enforcement is cascading: company > project > agent. Hard-stop auto-pause prevents runaway costs.

**For REVAMP:** Legacy modernization is expensive in tokens. A 50,000-line COBOL program can consume massive context windows. Add budget controls:
- **Per-pipeline-run budget** — set at project creation
- **Per-stage budget** — SCAN gets 20%, DECODE gets 15%, Co-Create gets 40%, etc.
- **Per-subtask budget check** — before each specialist runs, verify remaining budget

**Implementation:** Add `budget_cents` column to `pipeline_runs` table. Add `budget_used_cents` to `stage_artifacts` metadata. Check remaining budget before each `runStage()` call in orchestrators.

#### 2.3 Atomic Task Checkout (HIGH PRIORITY)
**Pattern:** `POST /issues/{id}/checkout` — atomic, single-assignee. Returns `409 Conflict` if another agent has it.

**For REVAMP:** Prevent two agents from transforming the same COBOL module simultaneously. The `agent_subtasks` table already has `assigned_agent_id` but lacks atomic checkout semantics.

**Implementation:** Add a `checked_out_at` timestamp and `checked_out_by` field to `agent_subtasks`. The `assignSubtask()` function should use a `WHERE checked_out_by IS NULL` atomic update, returning conflict if already claimed.

#### 2.4 Session Compaction (HIGH PRIORITY)
**Pattern:** Configurable thresholds trigger session rotation:
```typescript
interface SessionCompactionPolicy {
  maxSessionRuns: number;        // e.g., 200 runs
  maxRawInputTokens: number;     // e.g., 2,000,000 tokens
  maxSessionAgeHours: number;    // e.g., 72 hours
}
```
When thresholds are hit, a handoff summary is generated and a new session starts with the summary as context.

**For REVAMP:** Long-running modernization conversations accumulate massive context. The existing `agent_sessions` table stores session data but has no compaction. Add:
- Token count tracking per session
- Configurable thresholds per stage (SCAN sessions shorter, Co-Create sessions longer)
- LLM-generated handoff summaries when sessions rotate

**Implementation:** Add `token_count`, `max_tokens` columns to `agent_sessions`. Add a `compactSession()` function to `agent-sessions.ts` that generates a summary and creates a new session linked to the old one.

#### 2.5 Goal-Aware Task Hierarchy (MEDIUM-HIGH PRIORITY)
**Pattern:** Every task traces back to a company goal. Context flows from mission → goal → project → task. Agents always know WHY they are doing something.

**For REVAMP:** Map to modernization hierarchy:
```
Project Goal: "Modernize Accounts Receivable system to cloud-native"
  ├── Pipeline Run: "AR Module Modernization"
  │   ├── SCAN: Analyze AR codebase
  │   ├── DECODE: Extract AR business rules
  │   │   ├── Subtask: "Analyze PAYMENT-CALC COBOL paragraph"
  │   │   └── Subtask: "Map AR-AGING data flow"
  │   └── ...
```

Each subtask prompt should include the goal chain so the agent understands context.

**Implementation:** Add `goal_description` field to project context. Include in subtask prompts: "You are working toward: [goal chain]."

#### 2.6 Approval Gates for Governance (MEDIUM PRIORITY)
**Pattern:** `hire_agent` and `approve_ceo_strategy` approval types with pending/approved/rejected/revision-requested states.

**For REVAMP:** Gate critical modernization transitions:
- `approve_modernization_approach` — human reviews before code generation
- `approve_cutover` — human approves production deployment

**Implementation:** Already have `approval_gates` table. Wire it into pipeline stage transitions: stages like MODERNIZE_APPROACH and PARALLEL_RUN require approval before proceeding.

#### 2.7 Company Portability / Templates (MEDIUM PRIORITY)
**Pattern:** Export/import entire companies as portable packages with secret scrubbing and collision handling.

**For REVAMP:** Ship modernization blueprints:
- "COBOL-to-Java Standard Template" — pre-configured agent teams, prompt templates, validation contracts
- "VB6-to-React Template" — different agent configs, UI-focused validation
- "Delphi-to-.NET Template" — Delphi-specific parsers and patterns

**Implementation:** Add `project-templates/` to `packages/core-engine/` with exportable JSON packages containing prompt templates, validation contracts, agent configurations, and stage-specific settings.

#### 2.8 Config Revision and Rollback (MEDIUM PRIORITY)
**Pattern:** Every agent config change is versioned with before/after snapshots and `changedKeys` tracking.

**For REVAMP:** When agents adjust transformation strategies mid-flight, track what changed. If a modernization approach produces poor results, roll back to the previous config.

**Implementation:** Add a `config_revisions` table tracking changes to `prompt_templates` and pipeline stage configurations.

#### 2.9 Plugin Event Bus (MEDIUM PRIORITY)
**Pattern:** Typed in-process event bus with server-side filtering and plugin namespace isolation.

**For REVAMP:** Drive pipeline stage transitions via events:
- `stage.completed` → trigger next stage
- `validation.failed` → trigger self-correction
- `subtask.failed` → notify director agent

Currently using SSE for client events, BullMQ for job queues. Adding a typed internal event bus would decouple pipeline orchestration from direct function calls.

---

## 3. OPENVIKING — Context Database for AI Agents

### What It Does
OpenViking is a "Context Database" that unifies memories, resources, and skills using a filesystem paradigm. It provides L0/L1/L2 tiered context loading, hierarchical retrieval with rerank, automatic session memory extraction, and AST-based code understanding.

### Already Integrated in REVAMP
- Tiered context management (L0/L1/L2 concept)
- Agent evolution tracking
- Observable retrieval trajectories

### Features to Adopt (Beyond What's Already Integrated)

#### 3.1 AST-Based Code Skeletonization (HIGH PRIORITY)
**What It Does:** OpenViking's `ASTExtractor` uses tree-sitter to extract structural skeletons from code files — class names, method signatures, imports, docstrings — without sending full source to the LLM. Per-language extractors exist for Python, Java, JS/TS, Go, Rust, C#, C++.

**The `CodeSkeleton` dataclass:**
```python
@dataclass
class CodeSkeleton:
    file_name: str
    language: str
    module_doc: str
    imports: List[str]
    classes: List[ClassSkeleton]
    functions: List[FunctionSig]
```

Each class has method signatures with params and return types. The `to_text()` method generates a compact representation for embedding or LLM consumption.

**For REVAMP:** This is extremely valuable for the SCAN stage. Instead of sending entire COBOL/VB6/Delphi files to the LLM (burning tokens), extract structural skeletons first:
- COBOL: DIVISION/SECTION/PARAGRAPH structure, COPY statements, data definitions
- VB6: Module/Class/Form structure, Sub/Function signatures, API declarations
- Delphi: Unit structure, Interface/Implementation sections, Type declarations

**Implementation:** Add `packages/core-engine/src/parsers/ast/` with tree-sitter-based extractors per legacy language. The SCAN stage file analyzer generates skeletons that feed into agent prompts, dramatically reducing token usage.

#### 3.2 Hierarchical Retrieval with Rerank (HIGH PRIORITY)
**What It Does:** The `HierarchicalRetriever` performs directory-based recursive search:
1. Determine starting directories (target dirs or root URIs by context type)
2. Global vector search to supplement starting points
3. Merge starting points
4. **Recursive search** — drill into directories, score children, propagate scores up/down
5. Rerank final results using a dedicated rerank model
6. Apply hotness scoring (access frequency × recency)

**Key parameters:**
- `MAX_CONVERGENCE_ROUNDS = 3` — stop after unchanged topk
- `SCORE_PROPAGATION_ALPHA = 0.5` — parent↔child score blending
- `DIRECTORY_DOMINANCE_RATIO = 1.2` — directory score must exceed max child
- `HOTNESS_ALPHA = 0.2` — weight for access frequency in final ranking

**For REVAMP:** Apply to codebase navigation during SCAN and DECODE stages. Instead of flat file listing, build a directory tree and recursively search for relevant code. Score propagation means if a COBOL COPYBOOK is highly relevant, its parent directory (and sibling files) get boosted too.

**Implementation:** Add hierarchical search to `apps/api/src/services/file-analyzer.ts`. When analyzing a large codebase, build a `BuildingTree` of the file structure, embed directory abstracts, and use recursive search to find the most relevant modules for each subtask.

#### 3.3 6-Category Memory Extraction (HIGH PRIORITY)
**What It Does:** The `SessionCompressor` extracts memories from sessions into 6 categories:
1. **Profile** — user/project profile (always merged)
2. **Preferences** — user preferences by topic
3. **Entities** — projects, people, concepts
4. **Events** — decisions, milestones
5. **Cases** — specific problems + solutions (agent memory)
6. **Patterns** — reusable processes/methods (agent memory)

Each memory has L0 (abstract), L1 (overview), and L2 (detail) content. A `MemoryDeduplicator` uses LLM to decide: CREATE new, MERGE with existing, or SKIP.

**For REVAMP:** Apply to modernization knowledge accumulation:
- **Cases:** "When we modernized the AR batch program, the SORT USING clause required X approach" → stored and retrievable for similar future COBOL programs
- **Patterns:** "COBOL EVALUATE statements with nested PERFORMs reliably map to strategy pattern in Java" → reusable transformation pattern
- **Entities:** "CUST-MASTER is the canonical customer record referenced by 47 programs" → cross-module knowledge

**Implementation:** Add `modernization_memories` table with `category`, `abstract`, `overview`, `content`, `source_pipeline_run_id`. After each pipeline run completes, extract memories and store for future runs on the same project.

#### 3.4 Memory Hotness Lifecycle (MEDIUM-HIGH PRIORITY)
**What It Does:** The `hotness_score()` function computes a 0.0–1.0 score:
```
score = sigmoid(log1p(active_count)) × time_decay(updated_at)
```
- **Frequency component:** sigmoid of log of access count
- **Recency component:** exponential decay with configurable half-life (default 7 days)

Hotness is blended with semantic similarity (α=0.2) to boost frequently-accessed, recently-updated contexts.

**For REVAMP:** Apply to agent context selection. When building context for a specialist agent, boost:
- Recently accessed code modules (likely relevant to current work)
- Frequently referenced business rules (probably important)
- Decay old analysis results that may be stale

**Implementation:** Add `active_count` and `last_accessed_at` fields to `stage_artifacts`. Update on each read. Use hotness scoring when selecting prior stage outputs as context for current stages.

#### 3.5 Session Auto-Compression (MEDIUM PRIORITY)
**What It Does:** When session token count exceeds threshold (default 8000), the compressor:
1. Extracts memories from conversation
2. Generates a summary of what was discussed
3. Creates new session with summary as starting context
4. Links old and new sessions

**For REVAMP:** Our `agent_sessions` already have session chains. Add automatic compression when token budget is tight — particularly important on the 8GB Intel Mac where we can't run huge context windows.

**Implementation:** Add `auto_compress` flag to session creation. When token count exceeds threshold, trigger compression via the Go LLM orchestrator (Haiku for summarization), store memories, and start fresh session.

#### 3.6 VLM-Powered Document Parsing (MEDIUM PRIORITY)
**What It Does:** OpenViking uses Vision Language Models to parse complex documents — PDFs, images, PowerPoints, legacy docs. The `legacy_doc.py` parser handles old-format documents.

**For REVAMP:** Legacy systems often have documentation in old formats — Word docs, scanned PDFs, Visio diagrams. Adding VLM-powered parsing would let the SCAN stage ingest not just code but also:
- System design documents (scanned PDFs)
- Database diagrams (Visio/ERD images)
- Business process documentation (Word docs)

**Implementation:** Add document parsers to `packages/core-engine/src/parsers/documents/` that use VLM to extract structured text from legacy documentation formats.

#### 3.7 Context Type System (MEDIUM PRIORITY)
**What It Does:** OpenViking classifies all context as one of three types:
- **Skill** — instructions/capabilities
- **Memory** — accumulated knowledge
- **Resource** — files/data

Each has separate storage, retrieval, and lifecycle rules.

**For REVAMP:** Apply to pipeline context management:
- **Skills:** Prompt templates, validation contracts, transformation rules
- **Memories:** Previous analysis results, extracted business rules, transformation patterns
- **Resources:** Source code files, documentation, test suites

This would replace the flat `stage_artifacts` approach with a more structured context system.

---

## Priority Matrix

| Feature | Source | Priority | Effort | Impact |
|---------|--------|----------|--------|--------|
| Anti-Rationalization Guards | Superpowers | HIGH | Low | Prevents agents from skipping critical validation |
| Hard Pipeline Gates | Superpowers | HIGH | Low | Ensures pipeline integrity |
| AST Code Skeletonization | OpenViking | HIGH | Medium | Massive token savings for large codebases |
| Budget-Controlled Execution | Paperclip | HIGH | Medium | Prevents runaway LLM costs |
| 6-Category Memory Extraction | OpenViking | HIGH | Medium | Agents learn from past modernizations |
| Atomic Task Checkout | Paperclip | HIGH | Low | Prevents duplicate work in multi-agent |
| Session Compaction | Paperclip | HIGH | Medium | Handles long-running modernization sessions |
| Two-Stage Review | Superpowers | MEDIUM-HIGH | Medium | Catches behavioral drift + quality issues |
| Hierarchical Retrieval | OpenViking | MEDIUM-HIGH | High | Better context selection for large codebases |
| Memory Hotness Lifecycle | OpenViking | MEDIUM-HIGH | Low | Smarter context ranking |
| Subagent Status Codes | Superpowers | MEDIUM | Low | Better failure handling (BLOCKED, NEEDS_CONTEXT) |
| Goal-Aware Hierarchy | Paperclip | MEDIUM | Low | Agents understand WHY they're modernizing |
| Adapter Registry | Paperclip | MEDIUM | High | Pluggable modernization tools |
| Approval Gates | Paperclip | MEDIUM | Low | Governance for critical transitions |
| Project Templates | Paperclip | MEDIUM | Medium | Reusable modernization blueprints |
| Config Revision/Rollback | Paperclip | MEDIUM | Medium | Audit trail for strategy changes |
| VLM Document Parsing | OpenViking | MEDIUM | Medium | Ingest legacy docs, diagrams, PDFs |
| Plugin Event Bus | Paperclip | MEDIUM | Medium | Decouple pipeline orchestration |
| Session Auto-Compression | OpenViking | MEDIUM | Medium | Handle 8GB RAM constraint |
| Context Type System | OpenViking | MEDIUM | High | Replace flat artifacts with structured context |

---

## Recommended Implementation Phases

### Phase 1: Quick Wins (1-2 days each)
1. Anti-rationalization guards in prompt templates
2. Hard pipeline gates in stage contracts
3. Atomic task checkout in `agent_subtasks`
4. Subagent status codes (BLOCKED, NEEDS_CONTEXT)
5. Memory hotness scoring on `stage_artifacts`

### Phase 2: Core Infrastructure (3-5 days each)
6. AST code skeletonization for legacy languages
7. Budget control per pipeline run / stage / subtask
8. Session compaction with token thresholds
9. 6-category memory extraction post-pipeline
10. Two-stage review (behavioral + quality) in orchestrators

### Phase 3: Advanced Features (1-2 weeks each)
11. Hierarchical retrieval for codebase navigation
12. Adapter registry for heterogeneous tools
13. Project templates / blueprints system
14. VLM document parsing for legacy docs
15. Plugin event bus for pipeline orchestration
