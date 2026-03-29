package stages

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"github.com/revamp-io/llm-orchestrator/internal/tools"
	"go.uber.org/zap"
)

// decodeSubtask represents a specialist extraction task for DECODE.
type decodeSubtask struct {
	Type        string `json:"type"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    int    `json:"priority"`
}

// decodeSubtaskResult holds the output of one specialist extraction.
type decodeSubtaskResult struct {
	Type   string
	Title  string
	Output string
	Err    error
}

// RunDecodeStage executes the DECODE (Intent Extraction) stage using a multi-agent pattern:
//
//	Director → Specialists (parallel with tool access) → Composer → Validation
//
// Specialists extract business rules, data flows, workflows, entities, integrations,
// and constraints from the legacy codebase using read-only tools.
func RunDecodeStage(
	ctx context.Context,
	engine *orchestrator.Engine,
	config StageConfig,
	onEvent OnStageEvent,
	onDelta OnDelta,
	logger *zap.Logger,
) (*StageRunResult, error) {
	start := time.Now()
	totalTokens := 0

	emit := func(phase StagePhase, data map[string]interface{}) {
		if onEvent != nil {
			onEvent(NewEvent(phase, config.StageName, config.StageIndex, data))
		}
	}

	readTools := tools.ToolsForStage(1) // Read-only tools for DECODE
	providerTools := toProviderTools(readTools)

	model := config.Model
	maxTokens := config.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 16384
	}

	// Get SCAN output from prior stages
	var scanOutput string
	for _, prior := range config.PriorOutputs {
		if prior.StageName == "SCAN" {
			scanOutput = prior.Output
			if len(scanOutput) > 8000 {
				scanOutput = scanOutput[:8000] + "\n\n... (truncated)"
			}
			break
		}
	}

	// ── Phase 1: Director Planning ──────────────────────────────
	emit(PhaseDirectorPlanning, map[string]interface{}{"message": "Director: planning extraction subtasks from SCAN output..."})

	directorPrompt := fmt.Sprintf(`You are the DECODE Director. Stage 1 SCAN has completed. Plan specialist subtasks to extract all business intent from the legacy codebase.

## SCAN Output
%s

## Available Subtask Types
1. business-rules-extraction (ALWAYS include, priority 1) — Every conditional, calculation, validation, domain rule with source file:line citations
2. data-flow-analysis (ALWAYS include, priority 2) — How data enters, transforms, persists, exits. DB schemas, API payloads, file I/O
3. workflow-extraction (ALWAYS include, priority 3) — End-to-end user and system workflows with entry points, decision branches, exit conditions
4. domain-entity-modeling (Include when entities detected) — Core entities, relationships, lifecycle states, invariants
5. integration-mapping (Include when integrations detected) — External APIs, message queues, shared databases, file exchanges
6. constraints-debt-analysis (ALWAYS include, lower priority) — Technology lock-ins, compliance, technical debt, open questions

Rules:
- Select 4-6 subtasks (minimum 3: business-rules, data-flow, workflow)
- Priority 1 = highest
- Use SCAN output to determine which optional subtasks are needed

Output ONLY valid JSON: {"subtasks": [{"type": "...", "title": "...", "description": "...", "priority": 1}], "reasoning": "..."}`, scanOutput)

	directorReq := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model:       model,
			Messages:    []providers.Message{{Role: "user", Content: directorPrompt}},
			MaxTokens:   2048,
			Temperature: 0.1,
		},
	}
	directorResp, err := engine.Complete(ctx, directorReq)
	if err != nil {
		logger.Warn("Director failed, using default subtasks", zap.Error(err))
		return RunGenericStage(ctx, engine, config, onEvent, onDelta, logger)
	}
	totalTokens += directorResp.TotalTokens

	subtasks := parseDecodePlan(directorResp.Content, logger)
	if len(subtasks) == 0 {
		subtasks = defaultDecodeSubtasks()
	}

	emit(PhaseDirectorPlanning, map[string]interface{}{
		"message":  fmt.Sprintf("Director planned %d extraction subtasks", len(subtasks)),
		"subtasks": subtasks,
	})

	// ── Phase 2: Specialist Execution (parallel) ────────────────
	results := make([]decodeSubtaskResult, len(subtasks))
	var wg sync.WaitGroup

	for i, st := range subtasks {
		wg.Add(1)
		go func(idx int, task decodeSubtask) {
			defer wg.Done()

			emit(PhaseSubtaskExecuting, map[string]interface{}{
				"message":    fmt.Sprintf("Extracting: %s", task.Title),
				"subtask":    task.Type,
				"subtaskIdx": idx,
			})

			specialistPrompt := buildDecodeSpecialistPrompt(task, scanOutput)

			loopCfg := tools.LoopConfig{
				Messages: []providers.Message{
					{Role: "system", Content: fmt.Sprintf("You are a specialist reverse engineer extracting %s from a legacy codebase. Use tools to read source files. Cite every finding with file:line references. Use markdown with ## headings and tables.", task.Type)},
					{Role: "user", Content: specialistPrompt},
				},
				Tools:         providerTools,
				WorkspacePath: config.WorkspacePath,
				Model:         model,
				MaxTokens:     maxTokens / 2,
				Temperature:   0.2,
				MaxToolRounds: 10,
				BudgetCents:   config.BudgetCents / (len(subtasks) + 2),
			}

			loopResult, err := tools.RunToolLoop(ctx, engine, loopCfg, func(event tools.LoopEvent) {
				if event.Type == "tool_call" {
					data, _ := event.Data.(map[string]interface{})
					emit(PhaseSubtaskExecuting, map[string]interface{}{
						"message":    fmt.Sprintf("[%s] Tool: %v", task.Type, data["tool_name"]),
						"subtask":    task.Type,
						"tool_name":  data["tool_name"],
						"subtaskIdx": idx,
					})
				}
			}, logger)

			if err != nil {
				results[idx] = decodeSubtaskResult{Type: task.Type, Title: task.Title, Err: err}
				return
			}
			results[idx] = decodeSubtaskResult{Type: task.Type, Title: task.Title, Output: loopResult.Content}
		}(i, st)
	}

	wg.Wait()

	// Collect successful outputs
	var specialistOutputs strings.Builder
	successCount := 0
	for _, r := range results {
		if r.Err != nil {
			logger.Warn("DECODE subtask failed", zap.String("type", r.Type), zap.Error(r.Err))
			continue
		}
		successCount++
		specialistOutputs.WriteString(fmt.Sprintf("\n## Extraction: %s\n\n%s\n\n---\n", r.Title, r.Output))
	}

	if successCount == 0 {
		logger.Warn("All DECODE specialists failed, falling back to generic")
		return RunGenericStage(ctx, engine, config, onEvent, onDelta, logger)
	}

	emit(PhaseSubtaskExecuting, map[string]interface{}{
		"message": fmt.Sprintf("%d/%d extraction specialists completed", successCount, len(subtasks)),
	})

	// ── Phase 3: Composition ────────────────────────────────────
	emit(PhaseComposing, map[string]interface{}{"message": "Composing DECODE migration-ready document..."})

	compositionPrompt := fmt.Sprintf(`You are consolidating specialist extraction reports into a single DECODE document — the migration-ready requirements specification for this legacy codebase.

CRITICAL: Preserve ALL detail — every business rule, every data flow, every workflow step. Do not summarize away specifics. Consolidate duplicates but keep all unique findings.

## Specialist Extraction Reports
%s

Produce a comprehensive document with these sections:

## Business Rules
For each rule: Rule ID (BR-1, BR-2...), type, source file:line, code snippet, confidence (Verified/Inferred/Uncertain).
Use a numbered table. Target: 10+ business rules.

## Workflows
User workflows and system workflows with entry points, steps, decisions, error paths.
Include Mermaid sequence diagrams for 3-5 critical workflows.

## Data Flows & Persistence
Entry points, transformations, storage, exit points.
Include Mermaid ER diagram.
Schema analysis with tables.

## Domain Entities
Entity inventory with attributes, lifecycle states, relationships, invariants.

## Integration Points
External APIs, queues, shared DBs, file exchanges — with protocol, endpoints, data exchanged.

## Technical Debt & Constraints
Lock-ins, compliance requirements, dead code, deprecated APIs.

## Open Questions
Questions for SMEs that couldn't be answered from code alone.

## Readiness for Stage 3
What BLUEPRINT should focus on.

Cite file paths for every finding. Use tables. Every Business Rule MUST have a BR-{id} so SPEC_LOCK can reference it.`, specialistOutputs.String())

	var composedOutput string
	compReq := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model: model,
			Messages: []providers.Message{
				{Role: "system", Content: "You are a senior business analyst producing a migration-ready requirements document from legacy code analysis. Preserve ALL detail — business rules must have IDs (BR-1, BR-2...) and source citations. Never omit findings."},
				{Role: "user", Content: compositionPrompt},
			},
			MaxTokens:   maxTokens,
			Temperature: 0.2,
		},
	}

	if onDelta != nil {
		stream, err := engine.Stream(ctx, compReq)
		if err != nil {
			return nil, fmt.Errorf("DECODE composition failed: %w", err)
		}
		var b strings.Builder
		for chunk := range stream {
			if chunk.Delta != "" {
				b.WriteString(chunk.Delta)
				onDelta(chunk.Delta)
			}
		}
		composedOutput = b.String()
	} else {
		resp, err := engine.Complete(ctx, compReq)
		if err != nil {
			return nil, fmt.Errorf("DECODE composition failed: %w", err)
		}
		composedOutput = resp.Content
		totalTokens += resp.TotalTokens
	}

	// ── Phase 4: Validation ─────────────────────────────────────
	var validation *ValidationResult
	if !config.SkipValidation && config.ValidationPrompt != "" {
		emit(PhaseValidating, map[string]interface{}{"message": "Validating DECODE output..."})
		validation = validateWithLLM(ctx, engine, config, composedOutput, logger)
	}

	emit(PhaseCompleted, map[string]interface{}{
		"outputLength":  len(composedOutput),
		"subtasksTotal": len(subtasks),
		"subtasksDone":  successCount,
	})

	return &StageRunResult{
		StageName:  config.StageName,
		StageIndex: config.StageIndex,
		Output:     composedOutput,
		Validation: validation,
		DurationMs: time.Since(start).Milliseconds(),
		TokensUsed: totalTokens,
	}, nil
}

// ─── Helpers ──────────────────────────────────────────────────────

func parseDecodePlan(content string, logger *zap.Logger) []decodeSubtask {
	raw := content
	if idx := strings.Index(raw, "```json"); idx >= 0 {
		raw = raw[idx+7:]
		if end := strings.Index(raw, "```"); end >= 0 {
			raw = raw[:end]
		}
	} else if idx := strings.Index(raw, "{"); idx >= 0 {
		raw = raw[idx:]
		if end := strings.LastIndex(raw, "}"); end >= 0 {
			raw = raw[:end+1]
		}
	}

	var parsed struct {
		Subtasks []decodeSubtask `json:"subtasks"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &parsed); err != nil {
		logger.Warn("DECODE plan JSON parse failed", zap.Error(err))
		return nil
	}
	return parsed.Subtasks
}

func defaultDecodeSubtasks() []decodeSubtask {
	return []decodeSubtask{
		{Type: "business-rules-extraction", Title: "Business Rules Extraction", Description: "Extract all business rules, conditionals, calculations with source citations", Priority: 1},
		{Type: "data-flow-analysis", Title: "Data Flow Analysis", Description: "Trace data entry, transformation, persistence, and exit paths", Priority: 2},
		{Type: "workflow-extraction", Title: "Workflow Extraction", Description: "Map end-to-end user and system workflows", Priority: 3},
		{Type: "constraints-debt-analysis", Title: "Constraints & Technical Debt", Description: "Lock-ins, compliance, dead code, open questions", Priority: 4},
	}
}

func buildDecodeSpecialistPrompt(task decodeSubtask, scanOutput string) string {
	prompts := map[string]string{
		"business-rules-extraction": `Extract EVERY business rule from the codebase. For each rule produce:
- Rule ID (BR-1, BR-2, ...) — sequential numbering
- Rule type (Validation, Calculation, Authorization, Workflow, Data Integrity, Business Logic)
- Source location (file:line)
- Code snippet showing the rule
- Plain English description
- Confidence (Verified = directly in code, Inferred = implied by patterns, Uncertain = needs SME confirmation)

Look for: conditionals (if/switch/case), calculations, validations, authorization checks, domain constants, error conditions.
Be thorough — every conditional is a potential business rule.`,

		"data-flow-analysis": `Trace how data flows through the system. Produce:
1. Entry points table (type, location, data format, volume)
2. Transformation pipeline (what happens to data between input and output)
3. Persistence layer (databases, files, caches — with schema details)
4. Exit points (APIs, reports, exports, events)
5. Mermaid data flow diagram
6. ER diagram if database schema is detectable

Read schema files, migration scripts, ORMs, and data access layers.`,

		"workflow-extraction": `Map all workflows in the system. For each workflow produce:
1. Workflow name and type (User workflow / System workflow / Batch process)
2. Entry point (HTTP endpoint, CLI command, cron trigger, event handler)
3. Actor (user role, system, external service)
4. Steps with decision branches and error handling
5. Exit conditions (success, failure, timeout)

Include Mermaid sequence diagrams for the 3-5 most critical workflows.
Read route handlers, controllers, event handlers, and batch scripts.`,

		"domain-entity-modeling": `Document the domain model. For each entity produce:
1. Entity name and description
2. Attributes table (name, type, constraints, description)
3. Lifecycle states (state machine if applicable)
4. Invariants (rules that must always hold)
5. Relationships to other entities (cardinality, cascade rules)

Produce a Mermaid ER diagram showing all entities and their relationships.
Read model/entity definitions, database schemas, and validation code.`,

		"integration-mapping": `Map all external integration points. For each produce:
1. System name and purpose
2. Protocol (REST, SOAP, gRPC, MQ, file transfer, shared DB)
3. Endpoints/channels/topics
4. Authentication method
5. Data exchanged (request/response schemas)
6. Error handling and retry behavior

Produce a Mermaid integration architecture diagram.
Read API clients, config files, queue consumers/producers, and import/export modules.`,

		"constraints-debt-analysis": `Analyze constraints and technical debt. Produce:
1. Technology lock-ins table (technology, type, impact, alternatives)
2. Compliance requirements (PCI-DSS, HIPAA, GDPR indicators found in code)
3. Technical debt inventory (dead code, duplication, hardcoded values, deprecated APIs)
4. Migration blockers table (blocker, severity, description, estimated effort)
5. Open questions for SMEs (things that cannot be determined from code alone)

Read config files, dependency manifests, and scan for compliance-related patterns.`,
	}

	prompt, ok := prompts[task.Type]
	if !ok {
		prompt = fmt.Sprintf("Extract: %s\n%s", task.Title, task.Description)
	}

	return fmt.Sprintf(`## Task: %s
%s

## SCAN Output (for context)
%s

Read relevant source files using tools. Produce thorough analysis with ## headings and tables.
Cite every finding with file:line references.`, task.Title, prompt, scanOutput)
}
