# REVAMP Platform: Legacy-Bridge Feature Gap Analysis

**Generated**: 2026-03-19
**Scope**: Complete feature-by-feature comparison of legacy-bridge (prototype) vs revamp-platform (10X rebuild)

---

## Executive Summary

The revamp-platform has made strong progress on infrastructure (database schema, API gateway, Go LLM orchestrator, 8 stage panels) and has ported the core-engine validation rubrics, prompt templates, and cloud knowledge bases. However, significant implementation gaps remain in the **stage-specific AI logic** (the "brain" of each stage), the **multi-agent orchestration loop**, **frontend interactivity** (section refinement, inline editing, chat), the **parallel run execution engine**, and the **agent tool-use sandbox integration**. The legacy-bridge has ~300KB of stage AI logic, streaming infrastructure, and agent orchestration that has not yet been fully ported to the revamp pipeline service layer.

---

## 1. PIPELINE STAGES (8 Stages)

### Stage 0: Setup & Configuration / SCAN

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Git repo URL input with platform detection (GitHub, GitLab, Bitbucket, Azure DevOps) | `src/components/stages/SetupStage.tsx` `parseRepoUrl()` | ⚠️ Partial | `apps/web/components/pipeline/stage-panels/scan-panel.tsx` | Revamp supports Git URL input but legacy detects 5 platforms (github, gitlab, bitbucket, azure-devops, generic) with auto-branch detection | P1 |
| GitHub API file tree fetching (git-tree + contents fallback) | `src/components/stages/SetupStage.tsx` lines 76-95; `src/lib/githubSync.ts` | ✅ Implemented | `apps/api/src/routes/github.ts`, `apps/api/src/services/github.ts` | Revamp has validate-token, tree, file, branches, push endpoints | P0 |
| Local folder path input | `src/components/stages/SetupStage.tsx` | ⚠️ Partial | `apps/web/components/pipeline/stage-panels/scan-panel.tsx` | Revamp has source_type: 'upload'/'git'/'local' in DB schema but local path UI may not be fully wired | P1 |
| Supporting document upload (PDF, DOCX, TXT) | `useProjectStore.ts` `addSupportingDocument()` | ✅ Implemented | `apps/api/src/db/schema.ts` `supportingDocuments` table, `apps/api/src/routes/storage.ts` | DB schema + storage routes present | P0 |
| File tree preview (folder structure visualization) | `src/components/shared/FileTree.tsx` | ✅ Implemented | `apps/web/components/pipeline/file-tree.tsx` | Component exists | P0 |
| PAT token input with show/hide toggle | `SetupStage.tsx` (Eye/EyeOff icons) | ⚠️ Partial | `apps/web/components/pipeline/stage-panels/scan-panel.tsx` | Basic token input likely present, verify toggle UX | P2 |
| Stage prompt banner (customizable per-stage prompt) | `src/components/shared/StagePromptBanner.tsx` | ✅ Implemented | `apps/web/components/pipeline/mission-control/inline-prompt-editor.tsx` | Revamp has inline prompt editor in mission control | P0 |

### Stage 1: Intent Extraction / DECODE

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| AI generation with agent tool-use (read_file, list_files, search_code, etc.) | `src/lib/stageAI.ts` `runStageAgent()`, `STAGE_TOOL_PERMISSIONS` | ⚠️ Partial | `apps/api/src/services/agent-tools.ts`, `apps/api/src/services/sandbox.ts` | Sandbox tool execution exists in revamp API but the **stage-specific orchestration** (which tools per stage, fallback from agent to direct LLM) is not fully wired | P0 |
| LSP code intelligence (hover, definitions, references, document symbols, diagnostics) | `backend/src/agent/lspManager.ts`, `backend/src/agent/lspClient.ts` | ✅ Implemented | `apps/api/src/services/lsp-manager.ts`, `apps/api/src/services/lsp-client.ts` | LSP infrastructure ported | P0 |
| Prior stage context building with char budgets | `src/lib/stageAI.ts` `buildPriorStageContext()` lines 246-311 | ✅ Implemented | `packages/core-engine/src/orchestration/context-builders.ts` | Ported with typed interfaces and configurable budgets | P0 |
| Streaming text delta with debounced UI update | `src/lib/stageAI.ts` `runAIText()` onDelta every 300ms | ✅ Implemented | `apps/web/lib/hooks/use-stage-execution.ts` SSE streaming with phase events | SSE streaming with delta events implemented | P0 |
| Validation feedback injection into re-run | `src/lib/stageAI.ts` `buildValidationFeedback()` | ⚠️ Partial | `packages/core-engine/src/orchestration/context-builders.ts` | Context builder module exists but verify validation feedback is wired into re-generation | P1 |
| User feedback injection (rejection comments override AI) | `src/lib/stageAI.ts` `buildUserFeedback()` lines 130-142, `formatFeedbackBlock()` | ⚠️ Partial | `packages/core-engine/src/orchestration/context-builders.ts` `UserFeedback` interface | Type defined but implementation of the "HIGHEST PRIORITY" feedback override pattern needs verification | P0 |
| Section-level refinement (refineSection) | `src/lib/stageAI.ts` `refineSection()` lines 148-192 | ⚠️ Partial | `apps/api/src/routes/pipeline.ts` `/pipeline/:id/refine` endpoint, `apps/web/lib/hooks/use-refine-section.ts` | API endpoint + hook exist; verify full round-trip works | P1 |
| RefinableMarkdown (click-to-refine any section) | `src/components/shared/RefinableMarkdown.tsx` | ✅ Implemented | `apps/web/components/pipeline/refinable-markdown.tsx` | Component exists | P0 |

### Stage 2: Behavior Lock-in / SPEC_LOCK (legacy) / BLUEPRINT then SPEC_LOCK (revamp)

*Note: Legacy stage 2 is "Behavior Lock-in (BDD)" but revamp reorders to BLUEPRINT (stage 2) = Business Capability Map, SPEC_LOCK (stage 3) = BDD. This is a deliberate reordering.*

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| BDD scenario generation (Gherkin Given/When/Then) | `src/components/stages/BehaviorLockinStage.tsx` | ✅ Implemented | `apps/web/components/pipeline/stage-panels/spec-lock-panel.tsx` | Panel exists; verify full generation flow | P0 |
| BDD scenario count validation | `src/lib/validation/deterministicChecks.ts` `scoreBddScenarioCount()` | ✅ Implemented | `packages/core-engine/src/validation/deterministic-checks.ts` `scoreBddScenarioCount()` | Ported with GWT structure quality bonus | P0 |

### Stage 3: Business Capability Map / BLUEPRINT

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Capability map generation with Mermaid diagram | `src/components/stages/BusinessCapabilityStage.tsx` | ✅ Implemented | `apps/web/components/pipeline/stage-panels/blueprint-panel.tsx` | Panel exists | P0 |
| Mermaid diagram rendering | `src/components/shared/MermaidDiagram.tsx`, `ZoomableDiagram.tsx` | ✅ Implemented | `apps/web/components/pipeline/mermaid-diagram.tsx` | Component exists | P0 |
| Mermaid validity check | `src/lib/validation/deterministicChecks.ts` `scoreMermaidValidity()` | ✅ Implemented | `packages/core-engine/src/validation/deterministic-checks.ts` `scoreMermaidValidity()` | Ported with enhanced type detection | P0 |

### Stage 4: Modernization Approach / ARCHITECT

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Architecture comparison (2+ options) | `src/components/stages/ModernizationApproachStage.tsx` | ✅ Implemented | `apps/web/components/pipeline/stage-panels/architect-panel.tsx` | Panel exists | P0 |
| AWS/GCP/Azure architecture diagrams | `src/components/shared/AwsArchitectureDiagram.tsx`, `GcpArchitectureDiagram.tsx`, `AzureArchitectureDiagram.tsx` | ❌ Missing | N/A | Revamp has cloud knowledge bases ported but the **visual architecture diagram components** (SVG-based with service icons) are not yet ported | P1 |

### Stage 5: CoCreate / FORGE

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| File plan generation then code generation | `src/components/stages/CoCreateStage.tsx` `COCREATE_DEFAULTS`, planning + generation + refinement loop | ⚠️ Partial | `apps/web/components/pipeline/stage-panels/forge-panel.tsx` | Panel exists but legacy has a sophisticated 3-phase pipeline: (1) plan file tree, (2) generate code per file, (3) refine with validation. Verify completeness | P0 |
| Code editor (Monaco) with syntax highlighting | `src/components/stages/stage7/CodeEditorPanel.tsx` | ✅ Implemented | `apps/web/components/editor/code-editor.tsx` | Monaco editor component exists | P0 |
| Traceability matrix (requirement -> component -> status) | `CoCreateStage.tsx` `TraceabilityRow` interface | ❌ Missing | N/A | Legacy generates a traceability table mapping Stage 1 requirements to generated components with implementation status. Not found in revamp | P1 |
| Full-stack detection (auto-detect if project is frontend+backend+API) | `CoCreateStage.tsx` `detectFullStack()` | ❌ Missing | N/A | Legacy auto-detects project type to tailor code generation strategy | P2 |
| Modernized files management (edit, delete, add files in tree) | `useProjectStore.ts` `setModernizedFiles()` | ✅ Implemented | `apps/api/src/db/schema.ts` `modernizedFiles` table | DB storage for modernized files exists | P0 |
| Write access tools (write_file, edit_file, shell_exec) for Stage 5 | `src/lib/stageAI.ts` `STAGE_TOOL_PERMISSIONS` — Stage 5 gets ALL_TOOLS | ⚠️ Partial | `apps/api/src/services/sandbox.ts` | Sandbox has write_file, edit_file but verify Stage 5 specifically enables write tools while other stages are read-only | P0 |

### Stage 6: Parallel Run / SHADOW_RUN

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Local parallel run execution via gateway | `src/lib/parallelRunGateway.ts` `executeParallelRunViaGateway()` | ❌ Missing | N/A | **Critical gap**: Legacy has a complete parallel run engine that sends BDD scenarios to a gateway runner, executes against both legacy and modernized code, and returns a comparison matrix. Not implemented in revamp | P0 |
| Parallel run result matrix (legacy vs modern pass/fail/duration) | `src/lib/parallelRunGateway.ts` `buildResultMatrix()`, `ParallelRunMatrixRow` | ❌ Missing | N/A | Result matrix construction and comparison logic not ported | P0 |
| Result matrix summary for validation pipeline | `src/lib/parallelRunGateway.ts` `summarizeResultsForValidation()` | ❌ Missing | N/A | Converts structured results into text for deterministic checks | P0 |
| Local runner service (runner/) | `runner/` directory at legacy root | ❌ Missing | N/A | The actual runner service that executes test commands against both codebases | P0 |
| Git-based modernized target (clone from repo) | `parallelRunGateway.ts` `modernizedSourceType: 'git'`, `ParallelGitTarget` | ❌ Missing | N/A | Support for running modernized code from a git repo | P1 |
| In-memory file injection for modernized target | `parallelRunGateway.ts` `modernizedSourceType: 'in_memory'` | ❌ Missing | N/A | Pass generated files directly to runner without disk | P1 |
| Parallel run cutover checklist UI | `ParallelRunStage.tsx` `CHECKLIST` array | ❌ Missing | N/A | 5-item checklist for cutover readiness verification | P1 |
| AI-based parallel run (when no local runner) | `ParallelRunStage.tsx` `executionMode: 'ai'` | ⚠️ Partial | `apps/web/components/pipeline/stage-panels/shadow-run-panel.tsx` | Panel exists; AI-based shadow run may be the only mode currently | P0 |

### Stage 7: Continuous Modernization / EVOLVE

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Interactive chat for refinement | `src/components/stages/ContinuousModernizationStage.tsx` + stage7/ chat components | ✅ Implemented | `apps/api/src/routes/pipeline.ts` `/pipeline/:id/chat` endpoint, `apps/web/lib/hooks/use-evolve-chat.ts`, `apps/web/components/pipeline/stage-panels/evolve-panel.tsx` | Chat endpoint + hook + panel exist | P0 |
| Chat with @mentions (ChatInputWithMentions) | `src/components/stages/stage7/ChatInputWithMentions.tsx` | ❌ Missing | N/A | Legacy has @-mention support in chat to reference stages, files, components | P2 |
| Chat panel with conversation history | `src/components/stages/stage7/ChatPanel.tsx` | ⚠️ Partial | `apps/web/lib/hooks/use-evolve-chat.ts` | Hook exists with history support but full panel UX not confirmed | P1 |
| Command palette (Cmd+K) | `src/components/stages/stage7/CommandPalette.tsx` | ✅ Implemented | `apps/web/components/pipeline/mission-control/command-palette.tsx` | Implemented in mission control | P0 |
| Diff review (side-by-side code comparison) | `src/components/stages/stage7/DiffReview.tsx`, `diffUtils.ts` | ❌ Missing | N/A | Legacy has a full diff review component with side-by-side comparison | P1 |
| Inline edit popover | `src/components/stages/stage7/InlineEditPopover.tsx`, `useInlineEdit.ts` | ❌ Missing | N/A | Legacy allows clicking code to get inline edit suggestions | P2 |
| File explorer panel | `src/components/stages/stage7/FileExplorerPanel.tsx` | ✅ Implemented | `apps/web/components/pipeline/file-tree.tsx` | File tree exists (may need Stage 7 specific features) | P1 |
| GitHub sync dialog (push modernized code to GitHub) | `src/components/stages/stage7/GitHubSyncDialog.tsx` | ✅ Implemented | `apps/web/components/pipeline/github-sync-dialog.tsx` | Component exists | P0 |

---

## 2. STAGE-SPECIFIC AI PROMPTS & PROMPT ENGINEERING

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Stage system prompts (per-stage instructions) | `src/lib/aiClient.ts` `STAGE_SYSTEM_PROMPTS` (8 entries) | ✅ Implemented | `packages/core-engine/src/prompts/system-prompts.ts` `stageSystemPrompts` | Ported with role-based and stage-based prompts | P0 |
| Action system prompts (analyze/generate/review/chat) | `src/lib/aiClient.ts` `ACTION_SYSTEM_PROMPTS` | ✅ Implemented | `packages/core-engine/src/prompts/system-prompts.ts` `systemPrompts` (architect/engineer/analyst/reviewer/coordinator) | Restructured into role-based prompts | P0 |
| Default stage prompts (detailed per-stage instructions) | `src/data/promptTemplates.ts` `DEFAULT_STAGE_PROMPTS` | ✅ Implemented | `packages/core-engine/src/prompts/preset-templates.ts` `DEFAULT_STAGE_PROMPTS` | Fully ported with detailed instructions for stages 1-6 | P0 |
| Default validation prompts | Legacy: implicitly part of stageAI validation | ✅ Implemented | `packages/core-engine/src/prompts/preset-templates.ts` `DEFAULT_VALIDATION_PROMPTS` | New in revamp: explicit validation prompts per stage | P0 |
| Prompt templates (9 presets: Lean, Python+SPA, Model-Agnostic, etc.) | `src/data/promptTemplates.ts` `PROMPT_TEMPLATES` (9 templates) | ✅ Implemented | `packages/core-engine/src/prompts/preset-templates.ts` `PRESET_TEMPLATES` (9 templates) | All 9 templates ported identically | P0 |
| Per-stage prompt customization with history | `useProjectStore.ts` `updateStagePrompt()`, `getPromptHistory()` | ✅ Implemented | `apps/api/src/db/schema.ts` projects.stage_prompts, `apps/web/components/pipeline/mission-control/inline-prompt-editor.tsx` | Prompt editor with template selector in mission control | P0 |
| Prompt template selector | `Dashboard.tsx` template selection during project creation | ✅ Implemented | `apps/web/components/pipeline/mission-control/prompt-template-selector.tsx` | Component exists | P0 |
| LSP-aware system prompts (per-stage LSP tool guidance) | `src/lib/stageAI.ts` lines 710-787 | ❌ Missing | N/A | Legacy has elaborate per-stage LSP usage instructions (e.g., "Stage 2: use lsp_document_symbols to discover public methods for BDD coverage"). This is critical for tool-use efficiency | P0 |
| Agent system prompt with codebase-size adaptation | `src/lib/stageAI.ts` lines 711-737 (SMALL <30 files vs LARGE strategy) | ❌ Missing | N/A | Legacy adapts exploration strategy to codebase size | P0 |
| Stage goal defaults (per-stage objectives) | `src/lib/stageAI.ts` `DEFAULT_STAGE_GOALS` | ✅ Implemented | `packages/core-engine/src/orchestration/context-builders.ts` `STAGE_GOALS` | Ported with enhanced structure (objective + deliverables + keyQuestions) | P0 |

---

## 3. VALIDATION RUBRICS & QUALITY CHECKS

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Per-stage validation rubrics (weighted dimensions) | `src/lib/validation/rubrics.ts` `STAGE_RUBRICS` | ✅ Implemented | `packages/core-engine/src/validation/rubrics.ts` `stageValidationRules` | Ported for all 8 stages with configurable thresholds | P0 |
| Deterministic: Section completeness | `deterministicChecks.ts` `scoreMarkdownCompleteness()` | ✅ Implemented | `deterministic-checks.ts` `scoreSectionCompleteness()` | Enhanced with min-words-per-section check | P0 |
| Deterministic: BDD scenario count | `deterministicChecks.ts` `scoreBddScenarioCount()` | ✅ Implemented | `deterministic-checks.ts` `scoreBddScenarioCount()` | Enhanced with GWT quality scoring | P0 |
| Deterministic: Cross-stage references | `deterministicChecks.ts` `scoreCrossStageReferences()` | ✅ Implemented | `deterministic-checks.ts` `scoreCrossStageReferences()` | Ported with keyword matching | P0 |
| Deterministic: Code block presence | `deterministicChecks.ts` `scoreCodeBlockPresence()` | ✅ Implemented | `deterministic-checks.ts` `scoreCodeBlockPresence()` | Enhanced with language detection and substance bonus | P0 |
| Deterministic: Mermaid validity | `deterministicChecks.ts` `scoreMermaidValidity()` | ✅ Implemented | `deterministic-checks.ts` `scoreMermaidValidity()` | Enhanced with node/connection validation | P0 |
| Deterministic: Output substance | `deterministicChecks.ts` `scoreOutputSubstance()` | ✅ Implemented | `deterministic-checks.ts` `scoreOutputSubstance()` | Enhanced with filler phrase detection, TBD counting, bullet ratio | P0 |
| Deterministic: File artifacts | `deterministicChecks.ts` `scoreFileArtifacts()` | ✅ Implemented | `deterministic-checks.ts` `scoreFileArtifacts()` | Ported with 4-strategy detection | P0 |
| Deterministic: Test coverage | `deterministicChecks.ts` `scoreTestCoverage()` | ✅ Implemented | `deterministic-checks.ts` `scoreTestCoverage()` | Enhanced with 3-strategy parsing | P0 |
| Deterministic: Build readiness | `deterministicChecks.ts` `scoreBuildReadiness()` | ✅ Implemented | `deterministic-checks.ts` `scoreBuildReadiness()` | 7 signal categories + import consistency | P0 |
| Deterministic: Parallel run coverage | `deterministicChecks.ts` `scoreParallelRunCoverage()` | ✅ Implemented | `deterministic-checks.ts` `scoreParallelRunCoverage()` | Ported with verdict + performance data detection | P0 |
| LLM-based validation (accuracy, completeness, etc.) | `src/lib/stageAI.ts` `buildLlmValidationPrompt()` lines 1051-1098 | ⚠️ Partial | `packages/core-engine/src/orchestration/validation-runner.ts` | Validation runner file exists but verify full LLM eval round-trip with prompt caching | P0 |
| Composite scoring (weighted deterministic + LLM) | `src/lib/stageAI.ts` `compositeScore()` lines 1140-1148 | ⚠️ Partial | `packages/core-engine/src/validation/deterministic-checks.ts` `runAllDeterministicChecks()` | Deterministic aggregation exists; verify LLM dimension integration | P0 |
| Validation result UI (findings display) | `src/components/shared/ValidationResults.tsx` | ✅ Implemented | `apps/web/components/pipeline/validation-results.tsx` | Component exists | P0 |
| Confidence gauge visualization | `src/components/shared/ConfidenceGauge.tsx` | ✅ Implemented | `apps/web/components/pipeline/confidence-gauge.tsx` | Component exists | P0 |
| Code quality checks (dead code, complexity, dependencies, coverage, duplication) | Not in legacy | ✅ New | `packages/core-engine/src/validation/deterministic-checks.ts` lines 637-765 | **New in revamp**: 5 additional code quality check types | P0 |
| Stage contracts (input/output schemas) | Not in legacy | ✅ New | `packages/core-engine/src/validation/stage-contracts.ts` | **New in revamp**: Typed input/output contracts per stage | P0 |

---

## 4. LLM PROVIDER INTEGRATION

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Multi-provider support (OpenAI, Claude, Gemini, Bedrock) | `src/lib/aiClient.ts` provider detection + routing | ✅ Implemented | `services/llm-orchestrator/internal/providers/` (openai.go, anthropic.go, gemini.go, bedrock.go) | Fully implemented in Go with provider interface | P0 |
| Ollama support (local models) | Not in legacy | ✅ New | `services/llm-orchestrator/internal/providers/ollama.go` | **New in revamp** | P0 |
| OpenAI SSE streaming (chat/completions) | `src/lib/aiClient.ts` `parseSseStream()` | ✅ Implemented | `services/llm-orchestrator/internal/orchestrator/stream.go` | Go streaming implementation | P0 |
| Anthropic SSE streaming (messages API) | `src/lib/aiClient.ts` `parseAnthropicSseStream()` | ✅ Implemented | `services/llm-orchestrator/internal/providers/anthropic.go` | Go implementation | P0 |
| OpenAI Responses API (Codex models) | `src/lib/aiClient.ts` `parseResponsesSseStream()`, `isCodexResponsesModel()` | ❌ Missing | N/A | Legacy supports OpenAI Responses API for gpt-5-codex models. Not in Go orchestrator | P1 |
| Azure OpenAI URL detection | `src/lib/aiClient.ts` `isAzureOpenAIUrl()` | ⚠️ Partial | `services/llm-orchestrator/internal/providers/openai.go` | Verify Azure OpenAI endpoint compatibility | P1 |
| xAI (Grok) URL detection + conversation caching | `src/lib/aiClient.ts` `isXaiUrl()`, `getXaiConvId()` | ❌ Missing | N/A | Legacy supports xAI with per-session conversation IDs for cache optimization | P2 |
| Google AI URL normalization (add /openai path) | `src/lib/aiClient.ts` `normalizeGoogleAiBase()` | ⚠️ Partial | `services/llm-orchestrator/internal/providers/gemini.go` | Verify Google AI OpenAI-compatible mode | P1 |
| Reasoning model detection (o1, o3) | `src/lib/aiClient.ts` `isReasoningModel()` | ❌ Missing | N/A | Legacy detects OpenAI reasoning models for special handling (no system prompt, different token limits) | P1 |
| Legacy model key aliases (deprecated model IDs -> current) | `src/lib/aiClient.ts` `LEGACY_MODEL_KEY_ALIASES` (15+ mappings) | ❌ Missing | N/A | Maps old model IDs like "claude-3-5-sonnet-20241022" to current equivalents | P2 |
| LLM provider settings UI | `src/components/settings/LLMProviderSettings.tsx` | ✅ Implemented | `apps/web/components/settings/llm-provider-settings.tsx` | Component exists | P0 |
| Per-stage LLM model configuration | `src/lib/localPersistence.ts` `listStageLLMConfigs()` | ⚠️ Partial | `apps/web/components/pipeline/mission-control/model-selector.tsx` | Model selector exists; verify per-stage config persistence | P1 |
| Circuit breaker per provider | Not in legacy (client-side only) | ✅ New | `services/llm-orchestrator/internal/orchestrator/circuit.go` | **New in revamp** | P0 |
| Weighted round-robin load balancing | Not in legacy | ✅ New | `services/llm-orchestrator/internal/orchestrator/balancer.go` | **New in revamp** | P0 |
| Semantic caching | Not in legacy | ✅ New | `services/llm-orchestrator/internal/cache/semantic.go` | **New in revamp** | P0 |
| Prometheus metrics | Not in legacy | ✅ New | `services/llm-orchestrator/internal/metrics/prometheus.go` | **New in revamp** | P0 |
| Token/cost tracking | `src/lib/modelPricing.ts` `calculateCost()` | ✅ Implemented | `packages/core-engine/src/knowledge/model-pricing.ts`, `services/llm-orchestrator/internal/metrics/cost.go` | Both TypeScript and Go implementations | P0 |
| Priority job queue | Not in legacy | ✅ New | `services/llm-orchestrator/internal/queue/priority.go`, `worker.go` | **New in revamp** | P0 |
| Batch API endpoint | Not in legacy | ✅ New | `services/llm-orchestrator/internal/api/handlers.go` POST /batch | **New in revamp** | P0 |
| Agent fallback (agent -> direct LLM on failure) | `src/lib/stageAI.ts` lines 826-879 | ❌ Missing | N/A | Legacy has sophisticated fallback: if agent runner fails (overloaded, unreachable), falls back to direct LLM call with appropriate logging | P0 |
| Retryable error detection with exponential backoff | `src/lib/stageAI.ts` `isRetryableError()`, 3 attempts with 2x delay | ⚠️ Partial | `services/llm-orchestrator/internal/orchestrator/circuit.go` | Circuit breaker provides retry logic but verify per-request retry with exponential backoff | P1 |
| Prompt caching optimization (Anthropic cache_control) | `src/lib/stageAI.ts` `buildLlmValidationPrompt()` uses cache_control: 'ephemeral' | ⚠️ Partial | `packages/core-engine/src/orchestration/context-builders.ts` `cacheablePrefix` in `AssembledPrompt` | Type exists but verify Anthropic cache_control header is actually sent | P1 |

---

## 5. MULTI-AGENT ORCHESTRATION

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Multi-agent generation loop (generate -> review -> refine -> validate) | `src/lib/stageAI.ts` `runMultiAgentGeneration()` (referenced in CoCreateStage) | ❌ Missing | N/A | **Critical gap**: Legacy has a full multi-agent loop with phases: 'generating' -> 'reviewing' -> 'refining' -> 'validating' -> 'done'. A reviewer agent checks output, if rejected, a refiner agent improves it, then validation runs | P0 |
| Agent phase tracking (AgentPhase type) | `src/lib/stageAI.ts` `AgentPhase` type | ❌ Missing | N/A | UI displays current agent phase to user | P0 |
| Reviewer agent with approval/rejection | `src/lib/stageAI.ts` `buildAgentReviewerPrompt()`, `parseReviewerVerdict()` | ❌ Missing | N/A | Separate LLM call that reviews generated output and returns {approved, issues, suggestions} | P0 |
| Refinement agent (improve output based on reviewer feedback) | `src/lib/stageAI.ts` `buildAgentRefinementPrompt()` | ❌ Missing | N/A | Takes reviewer issues + suggestions and regenerates improved output | P0 |
| hasValidationModel() check (use separate model for validation) | `src/lib/stageAI.ts` `hasValidationModel()` lines 1318-1339 | ❌ Missing | N/A | Verifies validation model resolves to a configured provider with credentials before attempting dual-model flow | P1 |
| Agent activity panel (real-time tool call visualization) | `src/components/ai/AgentActivity.tsx`, `AgentPanel.tsx` | ✅ Implemented | `apps/web/components/pipeline/agent-activity.tsx` | Component exists | P0 |

---

## 6. PROJECT MANAGEMENT

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Create project | `useProjectStore.ts` `createProject()` | ✅ Implemented | `apps/api/src/routes/projects.ts`, `apps/web/app/(dashboard)/projects/new/page.tsx` | Full CRUD | P0 |
| Delete project (with confirmation) | `useProjectStore.ts` `deleteProject()` | ✅ Implemented | `apps/api/src/routes/projects.ts`, `apps/web/components/ui/confirm-delete-dialog.tsx` | Confirm dialog exists | P0 |
| Project settings (primary/validation model, max tokens, etc.) | `useProjectStore.ts` `updateSettings()` | ✅ Implemented | `apps/web/app/(dashboard)/projects/[id]/settings/page.tsx` | Settings page exists | P0 |
| Team members (add/remove with roles) | `useProjectStore.ts` `addMember()`, `removeMember()` | ✅ Implemented | `apps/api/src/db/schema.ts` `projectMembers`, `apps/api/src/routes/projects.ts` | DB schema + API routes | P0 |
| Project member roles (sme, developer, architect) | Legacy: 3 roles | ✅ Implemented | `apps/api/src/db/schema.ts` projectMembers.role: owner/editor/reviewer/viewer | Revamp has 4 roles (expanded) | P0 |
| Stage skip/disable (taskConfig) | `useProjectStore.ts` `setTaskConfig()`, `skipStage()` | ⚠️ Partial | N/A | `isStageDisabled()` is in legacy stageAI.ts; verify revamp supports stage skipping | P1 |
| Complete project | `useProjectStore.ts` `completeProject()` | ⚠️ Partial | `apps/api/src/db/schema.ts` projects.status field | Status field exists but verify completion workflow | P2 |
| Load projects from API | `useProjectStore.ts` `loadProjectsFromApi()` | ✅ Implemented | `apps/web/lib/hooks/use-projects.ts` | Hook exists with React Query | P0 |
| Organizations (multi-tenant) | Not in legacy | ✅ New | `apps/api/src/db/schema.ts` `organizations` table | **New in revamp**: Full multi-tenant support | P0 |

---

## 7. AUTHENTICATION & AUTHORIZATION

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| JWT authentication | `backend/src/server.ts` `generateToken()`, `authenticateToken()` | ✅ Implemented | `apps/api/src/plugins/auth.ts` | Fastify auth plugin | P0 |
| User registration (sign up) | `backend/src/server.ts` user creation endpoints | ✅ Implemented | `apps/api/src/routes/auth.ts` `SignUpSchema` | With organization creation | P0 |
| Login (email + password) | `backend/src/server.ts` login endpoint | ✅ Implemented | `apps/api/src/routes/auth.ts` `/auth/login` | Basic implementation (note: password comparison is plaintext in demo) | P0 |
| Password hashing (bcrypt) | `backend/src/server.ts` `passwordHash()`, `passwordVerify()` | ❌ Missing | `apps/api/src/routes/auth.ts` line 51: `user.password_hash !== password` | **Bug**: Revamp auth is doing plaintext comparison instead of bcrypt. Legacy uses bcrypt with 10 rounds | P0 |
| OTP (one-time password) for additional auth | `backend/src/server.ts` OTP_TTL_SECONDS, OTP_MAX_ATTEMPTS | ⚠️ Partial | `apps/api/src/db/schema.ts` users.otp_secret field | DB field exists but OTP flow may not be implemented | P1 |
| Password reset flow | `backend/src/server.ts` RESET_TOKEN_TTL_SECONDS | ⚠️ Partial | `apps/api/src/routes/auth.ts` `ResetPasswordSchema` | Schema defined but verify full flow | P1 |
| Admin role enforcement | `backend/src/server.ts` `requireAdmin()` | ✅ Implemented | `apps/api/src/plugins/auth.ts` | Role-based access control | P0 |
| Project-level admin | `backend/src/server.ts` `requireAdminOrProjectAdmin()` | ⚠️ Partial | `apps/api/src/db/schema.ts` projectMembers table | Verify project-level admin enforcement middleware | P1 |
| Rate limiting | `backend/src/server.ts` rate-limit middleware | ✅ Implemented | `apps/api/src/plugins/rate-limit.ts` | Rate limit plugin | P0 |
| RBAC roles (admin, sme, developer, architect) | `backend/src/server.ts` UserRole type | ✅ Implemented | `apps/api/src/db/schema.ts` users.role | Same 4 roles | P0 |
| License gating | `backend/src/license.ts`, `src/components/LicenseGate.tsx` | ❌ Missing | N/A | Legacy has a license validation system with activation/revocation. Not in revamp | P2 |
| Email sending (Resend integration) | `backend/src/server.ts` Resend import | ❌ Missing | N/A | Legacy uses Resend for email (OTP, invitations, password reset) | P1 |

---

## 8. REAL-TIME FEATURES (SSE, WebSocket, Streaming)

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| SSE streaming for stage execution | `src/lib/aiClient.ts` `streamAIChat()`, `parseSseStream()` | ✅ Implemented | `apps/api/src/routes/pipeline.ts` stage execution SSE, `apps/web/lib/hooks/use-stage-execution.ts` | Full SSE with phase/delta/tool/complete/error events | P0 |
| WebSocket for real-time notifications | Not in legacy (polling) | ✅ New | `apps/api/src/plugins/websocket.ts`, `apps/web/lib/hooks/use-websocket.ts` | **New in revamp** | P0 |
| Agent tool-use streaming (tool calls + results) | `src/lib/agentClient.ts` `streamAgentRun()` | ✅ Implemented | `apps/web/lib/hooks/use-stage-execution.ts` ToolCallEvent/ToolResultEvent types | SSE events for tool calls and results | P0 |
| Elapsed timer during generation | `src/components/shared/ElapsedTimer.tsx` | ✅ Implemented | `apps/web/components/pipeline/elapsed-timer.tsx` | Component exists | P0 |
| Token usage display (input/output per call) | `src/lib/stageAI.ts` `recordTokenUsage()` | ✅ Implemented | `apps/web/components/pipeline/token-usage.tsx`, `apps/web/components/pipeline/mission-control/global-token-counter.tsx` | Token counter + cost summary | P0 |

---

## 9. FILE/CODEBASE ANALYSIS & SCANNING

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Sandbox tool: read_file | `backend/src/agent/sandbox.ts` `execReadFile()` | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported with enhanced path security | P0 |
| Sandbox tool: read_file_range | `backend/src/agent/sandbox.ts` `execReadFileRange()` | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported | P0 |
| Sandbox tool: list_files | `backend/src/agent/sandbox.ts` `execListFiles()` | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported | P0 |
| Sandbox tool: search_code (grep) | `backend/src/agent/sandbox.ts` `execSearchCode()` with regex fallback | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported | P0 |
| Sandbox tool: file_stats | `backend/src/agent/sandbox.ts` `execFileStats()` with caching | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported | P0 |
| Sandbox tool: write_file | `backend/src/agent/sandbox.ts` `execWriteFile()` | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported | P0 |
| Sandbox tool: edit_file (string replacement) | `backend/src/agent/sandbox.ts` `execEditFile()` | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported with uniqueness check | P0 |
| Sandbox tool: batch_read_files | `backend/src/agent/sandbox.ts` `execBatchReadFiles()` (up to 15 files) | ✅ Implemented | `apps/api/src/services/sandbox.ts` | Ported | P0 |
| Sandbox tool: shell_exec (allowlisted commands) | `backend/src/agent/sandbox.ts` `execShell()` with ALLOWED_SHELL_COMMANDS | ✅ Implemented | `apps/api/src/services/sandbox.ts` SAFE_SHELL_COMMANDS | Ported with enhanced allowlist | P0 |
| LSP tools (hover, definitions, references, symbols, diagnostics) | `backend/src/agent/lspManager.ts` 5 LSP tools | ✅ Implemented | `apps/api/src/services/lsp-manager.ts`, `apps/api/src/services/lsp-client.ts` | LSP infrastructure ported | P0 |
| File analyzer service | Not in legacy (file analysis via agent tools) | ✅ New | `apps/api/src/services/file-analyzer.ts` | **New in revamp**: Dedicated file analysis service | P0 |
| Code analyzer (parsers) | Not in legacy | ✅ New | `packages/core-engine/src/parsers/code-analyzer.ts` | **New in revamp**: Standalone code parsing | P0 |
| Path traversal prevention (symlink validation) | `backend/src/agent/sandbox.ts` `resolveSafePath()` | ✅ Implemented | `apps/api/src/services/sandbox.ts` `resolveSafePath()` | Ported with enhanced validation | P0 |
| Binary file detection | `backend/src/agent/sandbox.ts` BINARY_EXTENSIONS | ✅ Implemented | `apps/api/src/services/sandbox.ts` BINARY_EXTENSIONS | Extended set in revamp | P0 |
| Codebase metrics tracking (files processed, lines analyzed) | `useProjectStore.ts` `updateCodebaseMetrics()` | ⚠️ Partial | `apps/api/src/db/schema.ts` projects.metrics (jsonb) | Metrics field exists; verify tracking during agent runs | P1 |

---

## 10. CLOUD KNOWLEDGE BASES

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| AWS service catalog | `src/data/awsKnowledgeBase.ts` | ✅ Implemented | `packages/core-engine/src/knowledge/aws.ts` | Ported with additional operational guidance | P0 |
| GCP service catalog | `src/data/gcpKnowledgeBase.ts` | ✅ Implemented | `packages/core-engine/src/knowledge/gcp.ts` | Ported | P0 |
| Azure service catalog | `src/data/azureKnowledgeBase.ts` | ✅ Implemented | `packages/core-engine/src/knowledge/azure.ts` | Ported | P0 |
| Model pricing data | `src/lib/modelPricing.ts` | ✅ Implemented | `packages/core-engine/src/knowledge/model-pricing.ts` | Ported with identical pricing | P0 |

---

## 11. EXPORT & REPORTING

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Project report export (JSON/Markdown) | `backend/src/server.ts` export endpoints | ✅ Implemented | `apps/api/src/routes/export.ts` `/export/project/:projectId/report` | JSON + Markdown formats | P0 |
| Modernized code archive (ZIP) | Legacy: download modernized files | ✅ Implemented | `apps/api/src/routes/export.ts` `/export/project/:projectId/code` | ZIP archive endpoint | P0 |
| Project summary export | Not explicit in legacy | ✅ New | `apps/api/src/routes/export.ts` `/export/project/:projectId/summary` | **New in revamp** | P0 |
| Export dialog UI | Legacy: various download buttons | ✅ Implemented | `apps/web/components/pipeline/export-dialog.tsx` | Dedicated export dialog | P0 |
| SVG export (architecture diagrams) | `src/components/shared/svgExport.ts` | ❌ Missing | N/A | Legacy exports Mermaid/architecture diagrams as SVG | P2 |
| DOCX generation | `backend/src/server.ts` (docx generation capabilities) | ❌ Missing | N/A | Legacy can generate Word documents for reports | P2 |

---

## 12. INTERACTIVE FEATURES

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Approval gate (approve/reject stage with comments) | `src/components/shared/ApprovalGate.tsx` | ✅ Implemented | `apps/web/components/pipeline/approval-gate.tsx`, `apps/api/src/routes/pipeline.ts` approve/reject endpoints | Full approval workflow | P0 |
| Stage rerun | `useProjectStore.ts` `rerunStage()` | ✅ Implemented | Pipeline service re-execute capability | Part of stage execution flow | P0 |
| AnimatedText (typing effect) | `src/components/shared/AnimatedText.tsx` | ❌ Missing | N/A | Smooth typing animation for AI output display | P2 |
| TerminalLog (log output display) | `src/components/shared/TerminalLog.tsx` | ✅ Implemented | `apps/web/components/pipeline/terminal-log.tsx` | Component exists | P0 |
| FileDiffIndicator | `src/components/shared/FileDiffIndicator.tsx` | ❌ Missing | N/A | Shows file change indicators (added/modified/deleted) | P2 |
| GitSyncReminder | `src/components/shared/GitSyncReminder.tsx` | ❌ Missing | N/A | Reminds users to sync changes to Git | P2 |
| SyncFilesButton | `src/components/shared/SyncFilesButton.tsx` | ❌ Missing | N/A | Quick-action button for GitHub sync | P2 |
| Keyboard shortcuts | `src/components/stages/stage7/highlighter.ts` | ✅ Implemented | `apps/web/lib/hooks/use-keyboard-shortcuts.ts` | Keyboard shortcuts hook | P0 |

---

## 13. AGENT/TOOL EXECUTION

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Agent router (multi-provider agent execution) | `backend/src/agent/agentRouter.ts` | ✅ Implemented | `apps/api/src/routes/agents.ts` | Agent routes exist | P0 |
| Per-LLM agent runners (OpenAI, Claude, Gemini, Bedrock) | `backend/src/agent/openaiRunner.ts`, `claudeRunner.ts`, `geminiRunner.ts`, `bedrockRunner.ts` | ⚠️ Partial | `apps/api/src/services/llm-proxy.ts` | LLM proxy exists but verify individual provider tool-use format handling (OpenAI tool_calls vs Claude tool_use blocks) | P0 |
| Generic agent runner (OpenAI-compatible) | `backend/src/agent/genericRunner.ts` | ⚠️ Partial | `apps/api/src/services/llm-proxy.ts` | Verify generic provider support | P1 |
| Tool format adapters (per-provider schema differences) | `backend/src/agent/toolFormats.ts` | ❌ Missing | N/A | Legacy adapts tool schemas between OpenAI, Claude, and Gemini formats. Each provider has different function calling conventions | P0 |
| Tool definitions (name, description, input schema) | `backend/src/agent/tools.ts` | ⚠️ Partial | `apps/api/src/services/agent-tools.ts` | Agent tools service exists; verify complete tool definitions | P0 |
| Retry utility (exponential backoff for tool execution) | `backend/src/agent/retryUtil.ts` | ❌ Missing | N/A | Dedicated retry utility for tool execution failures | P1 |
| URL validation (for tool outputs) | `backend/src/agent/urlValidation.ts` | ❌ Missing | N/A | Validates URLs in tool outputs to prevent injection | P2 |
| Bedrock proxy | `backend/src/bedrockProxy.ts` | ❌ Missing | N/A | Legacy has a dedicated Bedrock proxy for AWS IAM-based authentication. Revamp Go orchestrator has Bedrock provider but verify proxy functionality | P1 |
| Model listing endpoint | `backend/src/listModels.ts` | ✅ Implemented | `services/llm-orchestrator/internal/api/handlers.go` GET /models | Models endpoint in Go orchestrator | P0 |

---

## 14. STATE MANAGEMENT & PERSISTENCE

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Zustand store with IndexedDB persistence | `src/store/useProjectStore.ts` (zustand + idb-keyval) | ✅ Implemented | `apps/web/lib/stores/pipeline-store.ts`, `auth-store.ts`, `notification-store.ts`, `ui-preferences-store.ts` | Multiple focused stores (better architecture) | P0 |
| Local persistence (LLM providers, stage configs) | `src/lib/localPersistence.ts` | ⚠️ Partial | `apps/web/lib/stores/` | Server-side persistence via API replaces local storage but verify LLM provider config storage | P1 |
| Stage runner (track running stages, abort controller) | `src/lib/stageRunner.ts` | ✅ Implemented | `apps/web/lib/hooks/use-stage-execution.ts` | AbortController + running state tracking | P0 |
| Notification store | `src/store/useNotificationStore.ts` | ✅ Implemented | `apps/web/lib/stores/notification-store.ts`, `apps/web/components/layout/notification-bell.tsx` | Store + bell UI | P0 |
| System log (per-project AI activity log) | `useProjectStore.ts` `addSystemLog()` | ✅ Implemented | `apps/api/src/db/schema.ts` auditLogs table, `apps/web/components/pipeline/mission-control/audit-log.tsx` | Audit log component in mission control | P0 |
| Stage persisted activity (resume after page reload) | `src/hooks/usePersistedStageActivity.ts` | ❌ Missing | N/A | Legacy persists in-progress stage output so users can return and see partial results | P1 |

---

## 15. DASHBOARD & ANALYTICS

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Project list with metrics cards | `src/pages/Dashboard.tsx` | ✅ Implemented | `apps/web/app/(dashboard)/projects/page.tsx` | Projects listing page | P0 |
| Platform-wide metrics (total projects, files, lines, tokens, cost) | `useProjectStore.ts` `getPlatformMetrics()` | ⚠️ Partial | `apps/web/app/(dashboard)/dashboard/page.tsx` | Dashboard page exists; verify aggregated metrics | P1 |
| Project overview page | `src/pages/ProjectOverview.tsx` | ✅ Implemented | `apps/web/app/(dashboard)/projects/[id]/page.tsx` | Project detail page | P0 |
| Admin dashboard | `src/pages/AdminDashboard.tsx` | ✅ Implemented | `apps/web/app/(dashboard)/admin/page.tsx`, `apps/api/src/routes/admin.ts` | Admin page + API routes | P0 |
| Audit log page | `src/pages/AuditLog.tsx` | ✅ Implemented | `apps/web/components/pipeline/mission-control/audit-log.tsx` | Within mission control | P0 |
| Code comparison page | `src/pages/CodeComparison.tsx` | ❌ Missing | N/A | Dedicated side-by-side legacy vs modernized code comparison view | P1 |
| Cost summary card | Not in legacy | ✅ New | `apps/web/components/pipeline/mission-control/cost-summary-card.tsx` | **New in revamp** | P0 |
| Run history | Not in legacy | ✅ New | `apps/web/components/pipeline/mission-control/run-history.tsx` | **New in revamp** | P0 |
| Onboarding overlay | Not in legacy | ✅ New | `apps/web/components/pipeline/mission-control/onboarding-overlay.tsx` | **New in revamp** | P0 |
| Quick settings panel | Not in legacy | ✅ New | `apps/web/components/pipeline/mission-control/quick-settings.tsx` | **New in revamp** | P0 |
| Stage context menu | Not in legacy | ✅ New | `apps/web/components/pipeline/mission-control/stage-context-menu.tsx` | **New in revamp** | P0 |

---

## 16. USER PREFERENCES & SETTINGS

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| User settings page | `src/pages/ProjectSettings.tsx` | ✅ Implemented | `apps/web/app/(dashboard)/settings/page.tsx`, `apps/web/app/(dashboard)/projects/[id]/settings/page.tsx` | Both global and project settings | P0 |
| UI preferences (panel sizes, theme) | Implicit in various components | ✅ Implemented | `apps/web/lib/stores/ui-preferences-store.ts` | Dedicated UI preferences store | P0 |
| Login page | `src/pages/Login.tsx` | ✅ Implemented | `apps/web/app/(auth)/login/page.tsx` | Auth layout + login page | P0 |
| Reset password page | `src/pages/ResetPassword.tsx` | ⚠️ Partial | `apps/api/src/routes/auth.ts` ResetPasswordSchema | API schema exists; verify frontend page | P1 |
| 404 page | `src/pages/NotFound.tsx` | ⚠️ Partial | N/A | Next.js may handle this automatically but verify custom 404 | P2 |

---

## 17. DEPLOYMENT & INFRASTRUCTURE

| Feature | Legacy-bridge Location | Revamp Status | Revamp Location | Gap Details | Priority |
|---------|----------------------|---------------|-----------------|-------------|----------|
| Docker Compose | `infra/` directory | ✅ Implemented | `infra/` directory | Docker + K8s + Terraform | P0 |
| Render.yaml deployment | `render.yaml` | ❌ Missing | N/A | Legacy deployed on Render; revamp targets Docker/K8s | P2 |
| MinIO/S3 storage | `backend/src/server.ts` S3Client | ✅ Implemented | `apps/api/src/services/storage.ts`, `apps/api/src/routes/storage.ts` | Storage service + routes | P0 |
| Redis (cache + token store) | `backend/src/server.ts` Redis client | ✅ Implemented | `services/llm-orchestrator/internal/cache/redis.go`, API env vars | Redis in both Go and Node services | P0 |
| PostgreSQL | `backend/src/server.ts` pg Pool | ✅ Implemented | `apps/api/src/db/` Drizzle ORM | Drizzle with proper migrations | P0 |
| Swagger/OpenAPI docs | `backend/src/swagger.ts` | ✅ Implemented | `apps/api/src/server.ts` fastify-swagger | Swagger UI at /docs | P0 |
| VS Code Extension | Not in legacy | ✅ New | `apps/vscode/` | **New in revamp** | P0 |

---

## CRITICAL GAPS SUMMARY (P0 items that are Missing or Partially Implemented)

### Must-Fix Before Feature Parity

1. **Multi-agent orchestration loop** (`runMultiAgentGeneration`, reviewer/refiner agents) -- The core generate-review-refine-validate loop that ensures quality output
2. **Parallel run execution engine** (`parallelRunGateway.ts`, runner service) -- The entire Stage 6 local execution infrastructure
3. **Agent fallback chain** (agent -> direct LLM on failure) -- Resilience when backend agent runner is unreachable/overloaded
4. **Tool format adapters** per LLM provider -- Each provider has different function calling JSON schemas
5. **LSP-aware agent system prompts** -- Per-stage LSP tool usage guidance that dramatically improves agent efficiency
6. **Agent codebase-size adaptation** -- Strategy switching for small (<30 files) vs large codebases
7. **Password hashing** -- Revamp auth is doing plaintext password comparison (security bug)
8. **User feedback override pattern** -- The "HIGHEST PRIORITY" mechanism where user rejection comments override all AI decisions
9. **OpenAI Responses API** -- Support for gpt-5-codex models via the Responses API

### Architecture Advantages in Revamp (Not in Legacy)

1. **Go LLM Orchestrator** -- Circuit breaker, load balancing, semantic caching, Prometheus metrics, priority queue
2. **Multi-tenant organizations** -- Full organization support with slug-based routing
3. **VS Code Extension** -- IDE integration for modernization workflow
4. **WebSocket real-time notifications** -- Push-based updates instead of polling
5. **Code quality checks** -- Dead code, complexity, dependencies, coverage, duplication analysis
6. **Stage contracts** -- Typed input/output schemas per stage
7. **Mission Control UI** -- Comprehensive pipeline control panel with audit log, cost tracking, run history
8. **Drizzle ORM** -- Typed database access replacing raw SQL queries
9. **Turborepo monorepo** -- Proper build orchestration and dependency management
