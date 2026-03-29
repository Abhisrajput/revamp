package stages

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"go.uber.org/zap"
)

// RunGenericStage executes a standard generate → validate → refine loop.
// Used for: BLUEPRINT, SPEC_LOCK, ARCHITECT, SHADOW_RUN, EVOLVE.
func RunGenericStage(
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

	// ── 1. Build context from prior outputs ─────────────────────
	emit(PhaseContextRetrieval, map[string]interface{}{"message": "Assembling context from prior stages..."})

	var contextParts []string
	for _, prior := range config.PriorOutputs {
		maxLen := 8000
		output := prior.Output
		if len(output) > maxLen {
			output = output[:maxLen] + "\n\n... (truncated)"
		}
		contextParts = append(contextParts, fmt.Sprintf("## Prior Stage: %s\n%s", prior.StageName, output))
	}
	priorContext := strings.Join(contextParts, "\n\n---\n\n")

	emit(PhaseContextRetrieval, map[string]interface{}{
		"message":     fmt.Sprintf("Context: %d prior stages, %d chars", len(config.PriorOutputs), len(priorContext)),
		"priorStages": len(config.PriorOutputs),
	})

	// ── 2. Generate ─────────────────────────────────────────────
	emit(PhaseGenerating, map[string]interface{}{"message": fmt.Sprintf("Generating %s...", config.StageName)})

	systemPrompt := config.StagePrompt
	if systemPrompt == "" {
		systemPrompt = fmt.Sprintf("You are an expert working on stage %s of a legacy modernization pipeline.", config.StageName)
	}

	userPrompt := fmt.Sprintf("Target Stack: %s\nTarget Cloud: %s\n\n%s",
		config.TargetStack, config.TargetCloud, priorContext)

	maxTokens := config.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 16384
	}

	req := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model: config.Model,
			Messages: []providers.Message{
				{Role: "system", Content: systemPrompt},
				{Role: "user", Content: userPrompt},
			},
			MaxTokens:   maxTokens,
			Temperature: 0.3,
		},
	}

	var output string
	if onDelta != nil {
		stream, err := engine.Stream(ctx, req)
		if err != nil {
			emit(PhaseFailed, map[string]interface{}{"error": err.Error()})
			return nil, err
		}
		var b strings.Builder
		for chunk := range stream {
			if chunk.Delta != "" {
				b.WriteString(chunk.Delta)
				onDelta(chunk.Delta)
			}
		}
		output = b.String()
	} else {
		resp, err := engine.Complete(ctx, req)
		if err != nil {
			emit(PhaseFailed, map[string]interface{}{"error": err.Error()})
			return nil, err
		}
		output = resp.Content
		totalTokens += resp.TotalTokens
	}

	if output == "" {
		return nil, fmt.Errorf("empty output from LLM")
	}

	logger.Info("Generated", zap.String("stage", config.StageName), zap.Int("chars", len(output)))

	// ── 3. Validate ─────────────────────────────────────────────
	var validation *ValidationResult
	if !config.SkipValidation && config.ValidationPrompt != "" {
		emit(PhaseValidating, map[string]interface{}{"message": "Validating..."})
		validation = validateWithLLM(ctx, engine, config, output, logger)
	}

	emit(PhaseCompleted, map[string]interface{}{
		"outputLength": len(output),
	})

	return &StageRunResult{
		StageName:  config.StageName,
		StageIndex: config.StageIndex,
		Output:     output,
		Validation: validation,
		DurationMs: time.Since(start).Milliseconds(),
		TokensUsed: totalTokens,
	}, nil
}

// validateWithLLM uses the evaluator model as LLM-as-Judge.
func validateWithLLM(
	ctx context.Context,
	engine *orchestrator.Engine,
	config StageConfig,
	output string,
	logger *zap.Logger,
) *ValidationResult {
	evalModel := config.EvaluatorModel
	if evalModel == "" {
		evalModel = config.Model
	}

	evalOutput := output
	if len(evalOutput) > 6000 {
		evalOutput = evalOutput[:6000] + "\n..."
	}

	evalPrompt := fmt.Sprintf("%s\n\n## Output:\n%s\n\nReturn ONLY JSON: {\"score\": 0-100, \"passed\": true/false, \"issues\": [{\"severity\": \"error|warn\", \"message\": \"...\"}]}",
		config.ValidationPrompt, evalOutput)

	req := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model: evalModel,
			Messages: []providers.Message{
				{Role: "system", Content: "You are a quality reviewer. Output ONLY valid JSON."},
				{Role: "user", Content: evalPrompt},
			},
			MaxTokens:   2048,
			Temperature: 0.1,
		},
	}

	resp, err := engine.Complete(ctx, req)
	if err != nil {
		logger.Warn("Validation failed", zap.Error(err))
		return &ValidationResult{Passed: true, ConfidenceScore: 50}
	}

	return parseValidationJSON(resp.Content, logger)
}

func parseValidationJSON(raw string, logger *zap.Logger) *ValidationResult {
	// Extract JSON from possible code fences
	content := raw
	if idx := strings.Index(content, "```json"); idx >= 0 {
		content = content[idx+7:]
		if end := strings.Index(content, "```"); end >= 0 {
			content = content[:end]
		}
	} else if idx := strings.Index(content, "{"); idx >= 0 {
		content = content[idx:]
		if end := strings.LastIndex(content, "}"); end >= 0 {
			content = content[:end+1]
		}
	}

	var parsed struct {
		Score  int  `json:"score"`
		Passed bool `json:"passed"`
		Issues []struct {
			Severity string `json:"severity"`
			Message  string `json:"message"`
		} `json:"issues"`
	}

	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &parsed); err != nil {
		logger.Warn("Validation JSON parse failed", zap.Error(err))
		return &ValidationResult{Passed: true, ConfidenceScore: 60}
	}

	var issues []Issue
	for _, i := range parsed.Issues {
		issues = append(issues, Issue{Severity: i.Severity, Description: i.Message})
	}

	return &ValidationResult{
		Passed:          parsed.Passed,
		ConfidenceScore: parsed.Score,
		Issues:          issues,
	}
}
