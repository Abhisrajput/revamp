package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/revamp-io/llm-orchestrator/internal/stages"
	"go.uber.org/zap"
)

// TaskExecuteRequest is the request body for POST /api/v2/tasks/execute
type TaskExecuteRequest struct {
	PipelineRunID string                 `json:"pipeline_run_id"`
	ProjectID     string                 `json:"project_id"`
	StageName     string                 `json:"stage_name"`
	StageIndex    int                    `json:"stage_index"`
	Model         string                 `json:"model"`
	EvaluatorModel string               `json:"evaluator_model"`
	MaxTokens     int                    `json:"max_tokens"`
	StagePrompt   string                 `json:"stage_prompt"`
	ValidationPrompt string             `json:"validation_prompt"`
	PriorOutputs  []stages.PriorOutput   `json:"prior_outputs"`
	WorkspacePath string                 `json:"workspace_path"`
	TargetStack   string                 `json:"target_stack"`
	TargetCloud   string                 `json:"target_cloud"`
	BudgetCents   int                    `json:"budget_cents"`
	SkipValidation bool                  `json:"skip_validation"`
	Stream        bool                   `json:"stream"`
}

// handleTaskExecute handles POST /api/v2/tasks/execute
// Dispatches to the appropriate stage orchestrator and streams results via SSE.
func (s *Server) handleTaskExecute(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}

	var req TaskExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.StageName == "" {
		http.Error(w, "stage_name is required", http.StatusBadRequest)
		return
	}

	s.logger.Info("Executing stage",
		zap.String("stage", req.StageName),
		zap.Int("index", req.StageIndex),
		zap.String("model", req.Model),
		zap.String("pipeline", req.PipelineRunID),
	)

	config := stages.StageConfig{
		PipelineRunID:    req.PipelineRunID,
		ProjectID:        req.ProjectID,
		StageName:        req.StageName,
		StageIndex:       req.StageIndex,
		Model:            req.Model,
		EvaluatorModel:   req.EvaluatorModel,
		MaxTokens:        req.MaxTokens,
		StagePrompt:      req.StagePrompt,
		ValidationPrompt: req.ValidationPrompt,
		PriorOutputs:     req.PriorOutputs,
		WorkspacePath:    req.WorkspacePath,
		TargetStack:      req.TargetStack,
		TargetCloud:      req.TargetCloud,
		BudgetCents:      req.BudgetCents,
		SkipValidation:   req.SkipValidation,
	}

	if req.Stream {
		s.executeStageSSE(w, r, config)
	} else {
		s.executeStageJSON(w, r, config)
	}
}

// executeStageSSE runs the stage and streams events via SSE.
func (s *Server) executeStageSSE(w http.ResponseWriter, r *http.Request, config stages.StageConfig) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	sendSSE := func(event string, data interface{}) {
		jsonData, _ := json.Marshal(data)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(jsonData))
		flusher.Flush()
	}

	onEvent := func(event stages.StageEvent) {
		sendSSE("phase", event)
	}

	onDelta := func(text string) {
		// Split newlines for SSE compliance
		lines := strings.Split(text, "\n")
		fmt.Fprintf(w, "event: message\n")
		for _, line := range lines {
			fmt.Fprintf(w, "data: %s\n", line)
		}
		fmt.Fprintf(w, "\n")
		flusher.Flush()
	}

	result, err := s.runStage(r.Context(), config, onEvent, onDelta)

	if err != nil {
		sendSSE("error", map[string]string{"message": err.Error()})
		return
	}

	sendSSE("complete", map[string]interface{}{
		"stageName":    result.StageName,
		"stageIndex":   result.StageIndex,
		"outputLength": len(result.Output),
		"duration":     result.DurationMs,
		"tokensUsed":   result.TokensUsed,
		"validation":   result.Validation,
		"filesGenerated": result.FilesGenerated,
	})
}

// executeStageJSON runs the stage and returns the result as JSON.
func (s *Server) executeStageJSON(w http.ResponseWriter, r *http.Request, config stages.StageConfig) {
	result, err := s.runStage(r.Context(), config, nil, nil)
	if err != nil {
		s.logger.Error("Stage execution failed", zap.Error(err))
		http.Error(w, fmt.Sprintf("Stage failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// runStage dispatches to the correct stage implementation.
func (s *Server) runStage(
	ctx context.Context,
	config stages.StageConfig,
	onEvent stages.OnStageEvent,
	onDelta stages.OnDelta,
) (*stages.StageRunResult, error) {
	switch config.StageName {
	case "FORGE":
		return stages.RunForgeStage(ctx, s.engine, config, onEvent, onDelta, s.logger)
	default:
		// All other stages use the generic runner
		return stages.RunGenericStage(ctx, s.engine, config, onEvent, onDelta, s.logger)
	}
}
