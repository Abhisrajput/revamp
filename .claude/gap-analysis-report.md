# REVAMP 10X — Comprehensive Gap Analysis Report
## What We Have vs What's Missing vs What Can Be Better

Generated: 2026-03-17

---

## EXECUTIVE SUMMARY

The REVAMP 10X platform has a **solid foundation**:
- 16 mission-control components (2,683 lines)
- 8 fully-implemented stage panels with stage-specific UIs
- Complete Zustand state management with persistence
- SSE streaming for stage execution with 8 event types
- Working export, GitHub sync, and approval workflows

**But there are critical gaps** that prevent production readiness and fall short of the legacy-bridge capabilities:

| Category | Score | Details |
|----------|:-----:|---------|
| UI/Layout | 9/10 | Excellent - Mission Control layout is superior to legacy |
| Stage Panels | 8/10 | All 8 built, but validation/approval still inline (not in inspector) |
| API Completeness | 6/10 | Core execution works, but refine + chat endpoints missing |
| Agent/LSP | 2/10 | **Critical gap** - No LSP support, agent tools limited |
| Settings Page | 5/10 | Tabs exist but mismatch legacy's 4-tab structure |
| Validation | 7/10 | 3-phase designed but deterministic checks not ported |
| Performance | 6/10 | Good code splitting, but missing memoization & virtualization |
| UX Polish | 5/10 | Missing keyboard shortcuts wiring, context menus, onboarding |

---

## SECTION 1: CRITICAL GAPS (Must Fix)

### GAP-1: No LSP Server Support (Legacy has 63 languages)
**Legacy:** 1,519-line `lspManager.ts` with per-workspace LSP lifecycle, JSON-RPC protocol, 63 language configs with fallback chains, 5 LSP tools (hover, definitions, references, symbols, diagnostics)

**REVAMP:** Zero LSP implementation. No language intelligence in the agent sandbox.

**Impact:** The CoCreate/FORGE stage loses its most powerful feature - the AI agent can't understand types, find definitions, or detect errors in the legacy codebase.

**Fix Required:**
- Port `lspManager.ts` to Go LLM orchestrator OR create a separate Node.js LSP service
- Add 5 LSP tools to the agent tool registry
- Wire LSP results into agent activity UI
- Priority: **P0 - Critical for CoCreate stage**

### GAP-2: Refine API Endpoint Missing
**Legacy:** Section-level refinement lets users click any markdown section and provide feedback to refine it with the LLM.

**REVAMP:** `use-refine-section.ts` hook exists, `RefinableMarkdown` component works, BUT `POST /pipeline/:id/refine` endpoint doesn't exist. Hook has a 404 fallback that silently returns original content.

**Impact:** Refine buttons appear in the UI but do nothing - **broken feature visible to users**.

**Fix Required:**
- Add `POST /pipeline/:id/refine` route in `apps/api/src/routes/pipeline.ts`
- Add `refineSection()` method in `apps/api/src/services/pipeline.ts`
- Call LLM with section context + user feedback
- Return refined content via SSE or direct response
- Priority: **P0 - Visible broken UI**

### GAP-3: Evolve Chat API Missing
**Legacy:** Interactive chat for iterative refinement in the Evolve stage, connected to real LLM.

**REVAMP:** `use-evolve-chat.ts` hook is fully implemented with SSE streaming, but `POST /pipeline/:id/chat` endpoint doesn't exist. Chat sends but gets no response.

**Impact:** Evolve stage chat is completely broken.

**Fix Required:**
- Add `POST /pipeline/:id/chat` route
- Add `chat()` service method
- Stream LLM response back via SSE (same pattern as stage execution)
- Include pipeline context (prior stage outputs) in chat context
- Priority: **P0 - Broken feature**

### GAP-4: Keyboard Shortcuts Not Wired
**Legacy:** Not present (REVAMP improvement)

**REVAMP:** `use-keyboard-shortcuts.ts` and `usePipelineShortcuts` hooks are fully implemented but **never imported or called** anywhere. The pipeline page has its own inline `useEffect` for shortcuts but `usePipelineShortcuts` is dead code.

**Impact:** Documented shortcuts don't work, command palette references shortcuts that don't exist.

**Fix Required:**
- Call `usePipelineShortcuts()` in pipeline page.tsx OR consolidate with existing inline shortcuts
- Ensure all shortcuts in command palette actually work
- Priority: **P1 - UX polish**

### GAP-5: Settings Page Structure Mismatch
**Legacy (from screenshots):** 4 tabs: LLM | Prompts | Team & Approval | Configuration
- LLM: Provider registration, per-stage model assignment, execution+validation models
- Prompts: 9 templates, per-stage execution+validation prompt editing
- Team & Approval: Approval matrix, member management, role assignment
- Configuration: Cloud provider, BDD framework, validation threshold, auto-approval, max tokens, cost rate, task toggles

**REVAMP:** 5 tabs: General | Codebase | Pipeline | Team | Documents
- Missing: LLM provider registration (the legacy has full provider CRUD with API keys)
- Missing: 9 prompt template cards with category tags
- Missing: Task configuration toggles (per-stage sub-task on/off)
- Missing: BDD framework selection
- Missing: Approval matrix visualization
- Pipeline tab has model selection but not provider management

**Fix Required:**
- Restructure to match legacy 4-tab layout: LLM | Prompts | Team & Approval | Configuration
- Add LLM provider CRUD (name, URL, API key, models, default badge)
- Add prompt template card grid with category tags
- Add task configuration toggles per stage
- Add approval matrix grid
- Priority: **P1 - Feature parity**

---

## SECTION 2: FUNCTIONAL GAPS (Important)

### GAP-6: Agent Sandbox Limited
**Legacy:** 19 tools (14 file/search/shell + 5 LSP) with security features:
- Path traversal protection (`resolveSafePath`)
- Binary file detection (500+ extensions)
- Excluded directories (.git, node_modules, etc.)
- Output truncation (200KB max)
- Shell command allowlist
- Large file warnings (500KB threshold)

**REVAMP:** Agent tools exist in Go orchestrator but unclear if all 19 are implemented. No LSP tools. Security model not audited.

**Fix Required:**
- Audit Go orchestrator tool registry - ensure all 14 file/search tools are implemented
- Port security measures from legacy sandbox.ts
- Add LSP tool integration (depends on GAP-1)
- Priority: **P1**

### GAP-7: Validation/Approval Still Inline in Stage Panels
**Plan:** ConfidenceGauge, ValidationResults, and ApprovalGate should live in the Inspector Panel (right rail)

**Reality:** All 8 stage panels still render these inline. The Inspector Panel also renders them from `stage.validation` data, causing **duplicate display**.

**Fix Required:**
- Remove ConfidenceGauge, ValidationResults, ApprovalGate from all 8 stage panels
- Ensure Inspector Panel is the single source for validation/approval UI
- Stage panels should focus purely on content (streaming, diagrams, code, chat)
- Priority: **P1 - UX cleanup**

### GAP-8: Prompt Persistence Only Local
**Current:** Inline prompt editor saves to Zustand store only (localStorage). If store is cleared, all prompt customizations are lost.

**Legacy:** Prompts are persisted to the backend database per project.

**Fix Required:**
- Add `PUT /projects/:id/prompts/:stageIndex` endpoint
- Save prompt overrides to database (project settings JSONB or separate table)
- Load persisted prompts on pipeline page mount
- Priority: **P2**

### GAP-9: Evolve KPI Values Stubbed
**Current:** Evolve panel shows 4 KPI cards (Code Coverage, Modernization %, Technical Debt, Deployment Ready) all with "—" placeholder values.

**Fix Required:**
- Calculate KPIs from pipeline run data:
  - Code Coverage: from SHADOW_RUN validation results
  - Modernization %: from stage completion progress
  - Technical Debt: from validation scores
  - Deployment Ready: from all stages passed + approved
- Priority: **P2**

### GAP-10: No Pipeline Run History
**Current:** `RunHistory` component exists in bottom dock but the API endpoint for fetching run history is not confirmed.

**Legacy:** Run history with start time, duration, stages completed, status per run.

**Fix Required:**
- Ensure `GET /pipeline/runs?project_id=:id` endpoint exists and returns run list
- Wire RunHistory component to fetch and display data
- Add "load previous run" functionality to restore stage outputs
- Priority: **P2**

---

## SECTION 3: UX IMPROVEMENTS (User-Friendliness)

### UX-1: Heuristic Output Parsing is Fragile
**Problem:** SCAN, SHADOW_RUN, and SPEC_LOCK panels use regex to extract structured data from markdown output (file counts, comparison percentages, Gherkin scenarios). This breaks if LLM output format changes.

**Better Approach:**
- Have the LLM output structured JSON in a fenced code block (```json)
- Stage panels parse the JSON block for structured data
- Fall back to heuristic parsing if JSON block not found
- Example: SCAN output includes `{"files_indexed": 59, "lines_of_code": 3800, "quality_score": 87}`

### UX-2: No Loading States for Inspector Tabs
**Problem:** Inspector tabs (Validation, Artifacts, Diagrams) show empty states without clear messaging about when data will appear.

**Fix:** Add contextual empty states:
- Validation tab: "Run the stage to see validation results"
- Artifacts tab: "No artifacts generated yet. Execute the stage first."
- Diagrams tab: "Diagrams will appear after stage generates mermaid blocks"

### UX-3: No Context Menus
**Problem:** Right-clicking files in FORGE file tree, or stage names, provides no context menu.

**Fix:** Add context menus:
- File tree: Open, Rename, Delete, Copy Path, Regenerate
- Stage nav: Execute, Re-run, Reset, View Output, Copy Output
- Output sections: Copy, Refine, Export Section

### UX-4: No Onboarding / Empty States
**Problem:** New project pipeline page shows 8 locked stages with no guidance on what to do.

**Fix:**
- Add "Getting Started" card when no stages have run
- Add tooltips on first visit explaining left rail, center, inspector, dock
- Show "Run your first stage" CTA on the SCAN panel

### UX-5: No Breadcrumb Navigation in Pipeline
**Legacy:** Breadcrumb: Projects > Demo > Intent Extraction

**REVAMP:** Pipeline page doesn't show breadcrumb with current stage name.

**Fix:** Add breadcrumb to pipeline layout/header showing: Project > Pipeline > [Active Stage Name]

### UX-6: No Token Cost Display in Header
**Legacy:** Global token counter always visible in top-right header (e.g., "16,756,637")

**REVAMP:** Token cost is only in left rail's CostSummaryCard.

**Fix:** Add compact token/cost indicator to the pipeline header bar.

### UX-7: Missing "Edit Stage Prompt" from Stage Header
**Legacy:** Every stage has an "Edit stage prompt" link at the top of the stage output.

**REVAMP:** Prompt editor is accessible via Cmd+Shift+P or left rail but not directly from the stage content.

**Fix:** Add "Edit Prompt" button/link in CenterPanel header next to stage name.

### UX-8: No Dual Prompt Display (Execution + Validation)
**Legacy:** Shows both "CUSTOM PROMPT ACTIVE" (execution) and "DEFAULT VALIDATION GUIDANCE" (validation) prompts above stage output, each editable.

**REVAMP:** Only one prompt editor (execution). No validation prompt display/editing.

**Fix:**
- Add "Validation Prompt" section to InlinePromptEditor
- Show both prompts above stage output when custom prompts are active
- Allow editing both execution and validation prompts inline

### UX-9: No "Discard Changes" for Stage Actions
**Legacy:** Setup stage has "Clone Repository" and "Discard Changes" buttons.

**REVAMP:** Only Execute/Stop/Advance/Rerun in PipelineActionBar.

**Fix:** Add "Reset Stage" button that calls `resetStage(index)` in PipelineActionBar.

### UX-10: No Auto-Expand Dock on Events
**Current:** Bottom dock auto-expand preference exists in store but may not be triggered.

**Fix:** Wire auto-expand triggers:
- On `tool_call` event → switch to Agent tab, expand dock
- On `error` event → switch to Terminal tab, expand dock
- On validation complete → switch to Validation tab in inspector

---

## SECTION 4: PERFORMANCE OPTIMIZATIONS

### PERF-1: Stage Panels Lack React.memo Boundary
**Problem:** Stage panels re-render on every streaming text update (can be 100+ times per second during generation).

**Fix:**
- Wrap expensive sub-components (file trees, mermaid diagrams, validation results) in `React.memo`
- Use `useMemo` for parsed output (Gherkin, comparison metrics, mermaid extraction)
- Debounce streaming text rendering (every 100ms instead of every chunk)

### PERF-2: No Virtualization for Large Outputs
**Problem:** FORGE file tree and terminal logs render all items. A project with 500+ files or 1000+ log entries will cause scroll lag.

**Fix:**
- Use `react-window` or `@tanstack/react-virtual` for:
  - Terminal log entries (bottom dock)
  - Agent activity list
  - File tree nodes (FORGE panel)
  - Audit log entries
- Only render visible items + buffer

### PERF-3: Mermaid Diagrams Re-render on Every Output Change
**Problem:** Mermaid extraction runs regex on every render of stage output, even when output hasn't changed.

**Fix:**
- Memoize mermaid block extraction with `useMemo` keyed on `stage.output`
- Cache rendered SVG to avoid re-parsing unchanged diagrams
- Add loading placeholder during diagram rendering

### PERF-4: Monaco Editor Bundle Size
**Problem:** Monaco Editor is ~2.5MB. It's loaded via dynamic import but the bundle is still large.

**Fix:**
- Configure Monaco to only load needed languages (TypeScript, Python, Java, Go, COBOL, SQL, YAML, Dockerfile)
- Use `monaco-editor/esm/vs/editor/editor.api` for tree-shakeable imports
- Lazy-load language workers only when needed

### PERF-5: All 8 Stage Panels Pre-registered
**Current:** All 8 panels are registered in `STAGE_PANEL_MAP` with `dynamic()` imports and `ssr: false`. This is good for code splitting.

**Additional optimization:**
- Add `React.Suspense` boundaries per panel
- Preload the next stage's panel when current stage reaches 80% progress
- Prefetch adjacent stage panels on stage navigation

### PERF-6: Pipeline Store Persists Too Much
**Current:** Pipeline store persists `stages`, `modernizedFiles`, `stageModelOverrides`, etc. to localStorage. `modernizedFiles` can be large (megabytes for FORGE output).

**Fix:**
- Exclude `modernizedFiles` from persistence (fetch from API on load)
- Exclude `toolCalls` and `logs` from persistence (transient data)
- Add `maxAge` expiry to persisted data
- Compress persisted data with `lz-string`

### PERF-7: No Request Deduplication
**Problem:** Multiple components might fetch the same project data simultaneously.

**Fix:**
- Ensure all API calls go through React Query with consistent query keys
- Set `staleTime: 30000` for project data
- Use `queryClient.prefetchQuery` for predictable navigation

---

## SECTION 5: LEGACY-BRIDGE FEATURES NOT YET PORTED

### Feature Parity Checklist

| Legacy Feature | REVAMP Status | Priority |
|---|---|---|
| LSP Server (63 languages) | **MISSING** | P0 |
| Refine API | **BROKEN** (hook exists, endpoint missing) | P0 |
| Evolve Chat API | **BROKEN** (hook exists, endpoint missing) | P0 |
| 19 Agent Tools | **PARTIAL** (file tools exist, LSP missing) | P0 |
| Section-level refinement | **UI ONLY** (backend missing) | P0 |
| LLM Provider Registration | **MISSING** from settings | P1 |
| 9 Prompt Templates (card UI) | **MISSING** from settings | P1 |
| Task Configuration Toggles | **MISSING** from settings | P1 |
| Approval Matrix Grid | **MISSING** from settings | P1 |
| Per-stage dual prompts (exec+val) | **PARTIAL** (only execution in pipeline) | P1 |
| Auto-approval timeout | **MISSING** from settings UI | P1 |
| BDD Framework config | **MISSING** from settings | P1 |
| Validation threshold slider | **MISSING** from settings | P1 |
| Deterministic validation checks | **DESIGNED** but not ported from legacy | P1 |
| Supporting document upload | **PARTIAL** (scan panel only) | P2 |
| Destination repository config | **MISSING** | P2 |
| Global token counter in header | **MISSING** (only in left rail) | P2 |
| Audit log with system events | **UI EXISTS** but API unverified | P2 |
| Project overview stats cards | **EXISTS** in project page | Done |
| Export Blueprint/Report | **EXISTS** (export-dialog.tsx) | Done |
| GitHub sync | **EXISTS** (github-sync-dialog.tsx) | Done |
| Stage execution SSE | **FUNCTIONAL** | Done |
| Command palette | **FUNCTIONAL** | Done |
| Resizable panels | **FUNCTIONAL** | Done |
| Dynamic stage panel loading | **FUNCTIONAL** | Done |
| Model override system | **FUNCTIONAL** | Done |

---

## SECTION 6: RECOMMENDED EXECUTION ORDER

### Sprint 1 (P0 - Critical Gaps)
1. Add `/pipeline/:id/refine` API endpoint + service method
2. Add `/pipeline/:id/chat` API endpoint + service method
3. Wire `usePipelineShortcuts` or consolidate keyboard shortcuts
4. Remove duplicate validation/approval from stage panels (move to inspector only)

### Sprint 2 (P1 - Feature Parity)
5. Restructure Settings page to 4-tab layout matching legacy
6. Add LLM Provider CRUD to Settings
7. Add prompt template card grid to Settings
8. Add task configuration toggles to Settings
9. Add approval matrix to Settings
10. Port deterministic validation checks from legacy `deterministicChecks.ts`

### Sprint 3 (P1 - Agent & LSP)
11. Design LSP service architecture (Go sidecar vs Node.js service)
12. Port 63-language LSP config from legacy `lspManager.ts`
13. Add 5 LSP tools to agent tool registry
14. Audit and complete agent sandbox security (path validation, binary detection, shell allowlist)

### Sprint 4 (P2 - UX Polish)
15. Add breadcrumb navigation
16. Add dual prompt display (execution + validation) in pipeline
17. Add context menus to file tree and stage nav
18. Add onboarding / empty states
19. Add "Reset Stage" action to PipelineActionBar
20. Add global token counter to header

### Sprint 5 (Performance)
21. Add virtualization to terminal log, agent activity, file tree
22. Optimize Monaco Editor bundle (tree-shake languages)
23. Add React.memo boundaries to expensive sub-components
24. Compress localStorage persistence, exclude large data
25. Debounce streaming text rendering

---

## SECTION 7: ARCHITECTURE DECISIONS NEEDED

1. **LSP Service**: Port to Go orchestrator (same process) or create separate Node.js LSP microservice?
   - **Recommendation**: Separate Node.js service — Go doesn't have mature LSP client libraries, and the legacy TypeScript implementation is proven.

2. **Validation Checks**: Port deterministic checks to `@revamp/core-engine` (TypeScript) or rewrite in Go?
   - **Recommendation**: TypeScript in core-engine — same language, easier to port from legacy.

3. **Provider Management**: Browser localStorage (legacy pattern) or database-backed?
   - **Recommendation**: Database-backed with encrypted API keys — more secure, supports multi-user.

4. **Prompt Storage**: Per-project JSONB column or separate `prompt_overrides` table?
   - **Recommendation**: Separate table — allows version history and rollback.

5. **Agent Sandbox**: Run in Go orchestrator (current) or dedicated sandbox container?
   - **Recommendation**: Start with Go orchestrator, add container isolation later for shell_exec.
