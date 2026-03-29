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

// scanSubtask represents a specialist analysis task planned by the Director.
type scanSubtask struct {
	Type        string `json:"type"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    int    `json:"priority"`
}

// scanSubtaskResult holds the output of one specialist subtask.
type scanSubtaskResult struct {
	Type   string
	Title  string
	Output string
	Err    error
}

// RunScanStage executes the SCAN stage using a multi-agent delegation pattern:
//
//	Scout → Director → Specialists (parallel) → Composer → Validation
func RunScanStage(
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

	readTools := tools.ToolsForStage(0) // Read-only tools for SCAN
	providerTools := toProviderTools(readTools)

	model := config.Model
	maxTokens := config.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 16384
	}

	// ── Phase 1: Scout Assessment ───────────────────────────────
	// Use a fast tool loop to gather file stats and list files.
	emit(PhaseScoutAssessment, map[string]interface{}{"message": "Scout: exploring codebase structure..."})

	scoutLoop := tools.LoopConfig{
		Messages: []providers.Message{
			{Role: "system", Content: "You are a codebase scout. Use tools to understand the codebase structure, then output a JSON assessment with: languages, frameworks, codebaseCategory, complexity, and suggestedSubtasks."},
			{Role: "user", Content: fmt.Sprintf("Explore the codebase at workspace root. Use file_stats first, then list_files to understand the structure. Finally output a JSON assessment.\n\nWorkspace: %s", config.WorkspacePath)},
		},
		Tools:         providerTools,
		WorkspacePath: config.WorkspacePath,
		Model:         model,
		MaxTokens:     4096,
		Temperature:   0.1,
		MaxToolRounds: 5,
		BudgetCents:   config.BudgetCents / 4,
	}

	scoutResult, err := tools.RunToolLoop(ctx, engine, scoutLoop, func(event tools.LoopEvent) {
		if event.Type == "tool_call" {
			data, _ := event.Data.(map[string]interface{})
			emit(PhaseScoutAssessment, map[string]interface{}{
				"message":   fmt.Sprintf("Scout tool: %v", data["tool_name"]),
				"tool_name": data["tool_name"],
			})
		}
	}, logger)
	if err != nil {
		logger.Warn("Scout failed, falling back to generic", zap.Error(err))
		return RunGenericStage(ctx, engine, config, onEvent, onDelta, logger)
	}
	totalTokens += scoutResult.TokensUsed

	emit(PhaseScoutAssessment, map[string]interface{}{
		"message": fmt.Sprintf("Scout complete: %d tool calls, %d tokens", len(scoutResult.ToolsExecuted), scoutResult.TokensUsed),
	})

	// ── Phase 2: Director Planning ──────────────────────────────
	// Use the scout assessment to plan specialist subtasks.
	emit(PhaseDirectorPlanning, map[string]interface{}{"message": "Director: planning specialist subtasks..."})

	directorPrompt := fmt.Sprintf(`Based on the scout's codebase assessment, plan 3-6 specialist analysis subtasks.

Scout Assessment:
%s

Available subtask types:
1. architecture-analysis — Component inventory, data flows, system diagrams
2. tech-stack-deepdive — Languages, frameworks, versions, EOL risk
3. legacy-patterns — Active/inactive code, migration blockers
4. data-layer — Storage systems, schemas, ERDs
5. security-scan — Auth, findings, compliance flags
6. business-capabilities — Domain overview, workflows

Rules:
- Small codebases (<30 files): 2-3 subtasks
- Medium codebases (30-100 files): 3-4 subtasks
- Large codebases (100+ files): 4-6 subtasks
- Always include architecture-analysis and tech-stack-deepdive

Output ONLY valid JSON: {"subtasks": [{"type": "...", "title": "...", "description": "...", "priority": 1}]}`, scoutResult.Content)

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

	subtasks := parseDirectorPlan(directorResp.Content, logger)
	if len(subtasks) == 0 {
		subtasks = defaultScanSubtasks()
	}

	emit(PhaseDirectorPlanning, map[string]interface{}{
		"message":  fmt.Sprintf("Director planned %d subtasks", len(subtasks)),
		"subtasks": subtasks,
	})

	// ── Phase 3: Specialist Execution (parallel) ────────────────
	// Each specialist gets read-only tool access to analyze code.
	results := make([]scanSubtaskResult, len(subtasks))
	var wg sync.WaitGroup

	for i, st := range subtasks {
		wg.Add(1)
		go func(idx int, task scanSubtask) {
			defer wg.Done()

			emit(PhaseSubtaskExecuting, map[string]interface{}{
				"message":    fmt.Sprintf("Specialist: %s", task.Title),
				"subtask":    task.Type,
				"subtaskIdx": idx,
			})

			specialistPrompt := buildSpecialistPrompt(task, scoutResult.Content)

			loopCfg := tools.LoopConfig{
				Messages: []providers.Message{
					{Role: "system", Content: fmt.Sprintf("You are a specialist analyst for %s. Use tools to read source files and produce a thorough analysis. Use markdown with ## headings. Cite file paths for every finding.", task.Type)},
					{Role: "user", Content: specialistPrompt},
				},
				Tools:         providerTools,
				WorkspacePath: config.WorkspacePath,
				Model:         model,
				MaxTokens:     maxTokens / 2,
				Temperature:   0.2,
				MaxToolRounds: 8,
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
				results[idx] = scanSubtaskResult{Type: task.Type, Title: task.Title, Err: err}
				return
			}
			results[idx] = scanSubtaskResult{Type: task.Type, Title: task.Title, Output: loopResult.Content}
		}(i, st)
	}

	wg.Wait()

	// Collect successful outputs
	var specialistOutputs strings.Builder
	successCount := 0
	for _, r := range results {
		if r.Err != nil {
			logger.Warn("Subtask failed", zap.String("type", r.Type), zap.Error(r.Err))
			continue
		}
		successCount++
		specialistOutputs.WriteString(fmt.Sprintf("\n## Specialist Report: %s\n\n%s\n\n---\n", r.Title, r.Output))
	}

	if successCount == 0 {
		logger.Warn("All specialists failed, falling back to generic")
		return RunGenericStage(ctx, engine, config, onEvent, onDelta, logger)
	}

	emit(PhaseSubtaskExecuting, map[string]interface{}{
		"message": fmt.Sprintf("%d/%d specialists completed", successCount, len(subtasks)),
	})

	// ── Phase 4: Composition ────────────────────────────────────
	// Merge specialist reports into a single comprehensive document.
	emit(PhaseComposing, map[string]interface{}{"message": "Composing final SCAN document..."})

	compositionPrompt := fmt.Sprintf(`You are consolidating specialist analysis reports into a single comprehensive SCAN document for a legacy modernization project.

IMPORTANT: CONSOLIDATE, never concatenate. Remove duplicate findings. Use tables.
Target length: 1500-3000 words.

## Specialist Reports
%s

Produce a clean document with these sections:
## Executive Summary (3-5 sentences)
## Codebase Overview (file counts, LOC, languages table)
## Architecture (component inventory table, Mermaid diagram)
## Technology Stack (languages table, frameworks table, build tools)
## Security Posture (auth summary, findings table)
## Key Risks & Blockers (top 8-12 risks, prioritized table)
## Readiness for Stage 2 (what DECODE should focus on)

DO NOT include modernization plans, refactoring suggestions, or timelines.
Use TABLES instead of long prose. Cite file paths.`, specialistOutputs.String())

	var composedOutput string
	compReq := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model: model,
			Messages: []providers.Message{
				{Role: "system", Content: "You are a technical writer producing a comprehensive codebase analysis. Output clean markdown with tables. Never propose fixes or modernization strategies — just document what exists."},
				{Role: "user", Content: compositionPrompt},
			},
			MaxTokens:   maxTokens,
			Temperature: 0.2,
		},
	}

	if onDelta != nil {
		stream, err := engine.Stream(ctx, compReq)
		if err != nil {
			return nil, fmt.Errorf("composition failed: %w", err)
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
			return nil, fmt.Errorf("composition failed: %w", err)
		}
		composedOutput = resp.Content
		totalTokens += resp.TotalTokens
	}

	// ── Phase 5: Validation ─────────────────────────────────────
	var validation *ValidationResult
	if !config.SkipValidation && config.ValidationPrompt != "" {
		emit(PhaseValidating, map[string]interface{}{"message": "Validating SCAN output..."})
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

func toProviderTools(defs []tools.ToolDefinition) []providers.ToolDefinition {
	out := make([]providers.ToolDefinition, len(defs))
	for i, t := range defs {
		out[i] = providers.ToolDefinition{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		}
	}
	return out
}

func parseDirectorPlan(content string, logger *zap.Logger) []scanSubtask {
	// Extract JSON from possible code fences
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
		Subtasks []scanSubtask `json:"subtasks"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &parsed); err != nil {
		logger.Warn("Director plan JSON parse failed", zap.Error(err))
		return nil
	}
	return parsed.Subtasks
}

func defaultScanSubtasks() []scanSubtask {
	return []scanSubtask{
		{Type: "architecture-analysis", Title: "Architecture Analysis", Description: "Component inventory, data flows, system diagrams", Priority: 1},
		{Type: "tech-stack-deepdive", Title: "Technology Stack Deep Dive", Description: "Languages, frameworks, versions, EOL risk", Priority: 2},
		{Type: "security-scan", Title: "Security Scan", Description: "Auth, findings, compliance flags", Priority: 3},
	}
}

func buildSpecialistPrompt(task scanSubtask, scoutAssessment string) string {
	prompts := map[string]string{
		"architecture-analysis": `Analyze the system architecture. Produce:
1. Component inventory table (name, path, type, LOC, description)
2. Data flow between components
3. ONE Mermaid diagram showing component relationships
Read key files to understand module boundaries and entry points.`,

		"tech-stack-deepdive": `Analyze the technology stack in depth. Produce:
1. Languages table (language, version, LOC, %, status)
2. Frameworks & libraries table (name, version, purpose, status)
3. Build/deployment tooling table
4. Version risk summary (current vs. EOL dates)
Read package manifests, config files, and imports to gather evidence.`,

		"legacy-patterns": `Identify legacy patterns and code quality issues. Produce:
1. Active vs. inactive code analysis
2. Dead code paths and unused modules
3. Legacy patterns (e.g., deprecated APIs, manual memory management)
4. Migration blockers table (blocker, severity, location, impact)
Read source files to identify patterns.`,

		"data-layer": `Analyze the data layer. Produce:
1. Storage systems inventory (type, location, purpose)
2. Schema analysis (tables/collections, relationships)
3. Data access patterns (ORMs, raw SQL, file I/O)
4. ONE Mermaid ER diagram
Read schema files, migration scripts, and data access code.`,

		"security-scan": `Analyze security posture. Produce:
1. Authentication & session management summary
2. Security findings table (severity, location, category, description)
3. Compliance flags (PCI-DSS, HIPAA, GDPR indicators)
4. Dependency vulnerability indicators
Read auth code, config files, and dependency manifests.`,

		"business-capabilities": `Identify business capabilities and domains. Produce:
1. Business domain overview
2. Key capabilities table (capability, module, description)
3. User-facing workflows list
4. System-to-system interactions
Read entry points, route handlers, and domain modules.`,
	}

	prompt, ok := prompts[task.Type]
	if !ok {
		prompt = fmt.Sprintf("Analyze the codebase for: %s\n%s", task.Title, task.Description)
	}

	return fmt.Sprintf(`## Task: %s
%s

## Scout Assessment (for context)
%s

Read relevant source files using tools, then produce your analysis.
Use markdown with ## headings. Include tables. Cite file paths for every finding.
DO NOT include modernization plans or refactoring suggestions — just document what exists.`, task.Title, prompt, scoutAssessment)
}
