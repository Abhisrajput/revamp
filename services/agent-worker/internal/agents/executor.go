// Package agents — executor.go implements the agent task executor.
//
// When the Coordinator's HeartbeatTick checks out an assignment, the Executor
// dispatches the actual work: it calls the TypeScript API to trigger agent-mediated
// stage execution, tracks progress via Redis, and publishes lifecycle events.
//
// The Executor runs each task in its own goroutine with a cancellable context,
// allowing the Coordinator to stop all active runs during shutdown.
package agents

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// ExecutorConfig holds configuration for the agent executor.
type ExecutorConfig struct {
	// APIURL is the base URL of the TypeScript API server (e.g. http://localhost:3002).
	APIURL string
	// APIToken is the internal service token for authenticating API calls.
	APIToken string
	// MaxExecutionTime is the maximum time an agent can work on a single assignment.
	MaxExecutionTime time.Duration
	// HTTPClient is an optional custom HTTP client. If nil, a default is used.
	HTTPClient *http.Client
}

// Executor dispatches agent tasks to the TypeScript API and tracks their lifecycle.
type Executor struct {
	db     *sql.DB
	budget *BudgetEnforcer
	events *EventPublisher
	logger *zap.Logger
	config ExecutorConfig
	client *http.Client
}

// NewExecutor creates a new agent executor.
func NewExecutor(db *sql.DB, budget *BudgetEnforcer, events *EventPublisher, logger *zap.Logger, cfg ExecutorConfig) *Executor {
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: 5 * time.Minute, // long timeout for LLM calls
		}
	}

	if cfg.MaxExecutionTime == 0 {
		cfg.MaxExecutionTime = 10 * time.Minute
	}

	if cfg.APIURL == "" {
		cfg.APIURL = "http://localhost:3002"
	}

	return &Executor{
		db:     db,
		budget: budget,
		events: events,
		logger: logger,
		config: cfg,
		client: client,
	}
}

// ExecuteAssignment runs an agent assignment by calling the TypeScript API.
// It is designed to be called in a goroutine from the Coordinator.
//
// Flow:
//  1. Set agent status to 'working'
//  2. POST to /api/agents/assignments/:id/execute
//  3. On success: mark assignment completed, record costs, set agent idle
//  4. On failure: mark assignment failed, release lock, set agent idle
func (e *Executor) ExecuteAssignment(ctx context.Context, assignmentID, agentID, pipelineRunID, stageName string) {
	execCtx, cancel := context.WithTimeout(ctx, e.config.MaxExecutionTime)
	defer cancel()

	logger := e.logger.With(
		zap.String("assignment_id", assignmentID),
		zap.String("agent_id", agentID),
		zap.String("stage_name", stageName),
	)

	logger.Info("Executor: starting agent assignment")

	// Set agent to working
	if err := e.setAgentStatus(execCtx, agentID, "working"); err != nil {
		logger.Error("Executor: failed to set agent working", zap.Error(err))
		e.failAssignment(execCtx, assignmentID, agentID, "failed to set working status")
		return
	}

	// Call the TypeScript API to execute the assignment
	result, err := e.callExecuteAPI(execCtx, assignmentID)
	if err != nil {
		logger.Error("Executor: API call failed", zap.Error(err))
		e.failAssignment(execCtx, assignmentID, agentID, err.Error())

		e.events.Publish(ctx, Event{
			Type:    EventTaskFailed,
			AgentID: agentID,
			Data: map[string]interface{}{
				"assignment_id":   assignmentID,
				"pipeline_run_id": pipelineRunID,
				"stage_name":      stageName,
				"error":           err.Error(),
			},
		})
		return
	}

	// Check if execution succeeded
	if !result.Success {
		logger.Warn("Executor: assignment execution returned failure", zap.String("error", result.Error))
		e.failAssignment(execCtx, assignmentID, agentID, result.Error)

		e.events.Publish(ctx, Event{
			Type:    EventTaskFailed,
			AgentID: agentID,
			Data: map[string]interface{}{
				"assignment_id": assignmentID,
				"error":         result.Error,
			},
		})
		return
	}

	// Record cost if available
	if result.CostCents > 0 {
		costRecord := CostEventRecord{
			AgentID:       &agentID,
			PipelineRunID: strPtr(pipelineRunID),
			AssignmentID:  &assignmentID,
			Provider:      result.Provider,
			Model:         result.Model,
			InputTokens:   result.InputTokens,
			OutputTokens:  result.OutputTokens,
			CostCents:     result.CostCents,
			StageName:     strPtr(stageName),
			Operation:     strPtr("stage_execution"),
		}

		if err := e.budget.RecordCost(execCtx, agentID, int64(result.CostCents), costRecord); err != nil {
			logger.Warn("Executor: failed to record cost", zap.Error(err))
			// Non-fatal — continue with completion
		}
	}

	// Complete the assignment
	if err := e.completeAssignment(execCtx, assignmentID, agentID, result); err != nil {
		logger.Error("Executor: failed to complete assignment", zap.Error(err))
		// Agent is still working — try to set idle at least
		e.setAgentStatus(execCtx, agentID, "idle")
		return
	}

	e.events.Publish(ctx, Event{
		Type:    EventTaskCompleted,
		AgentID: agentID,
		Data: map[string]interface{}{
			"assignment_id":   assignmentID,
			"pipeline_run_id": pipelineRunID,
			"stage_name":      stageName,
			"tokens_used":     result.InputTokens + result.OutputTokens,
			"cost_cents":      result.CostCents,
		},
	})

	logger.Info("Executor: assignment completed successfully",
		zap.Int("tokens_used", result.InputTokens+result.OutputTokens),
		zap.Int("cost_cents", result.CostCents),
	)
}

// ─── API CALL ──────────────────────────────────────────────────

// executeAPIResponse is the expected response from the TypeScript API.
type executeAPIResponse struct {
	Success      bool                   `json:"success"`
	Error        string                 `json:"error,omitempty"`
	Result       map[string]interface{} `json:"result,omitempty"`
	TokensUsed   int                    `json:"tokensUsed,omitempty"`
	CostCents    int                    `json:"costCents,omitempty"`
	InputTokens  int                    `json:"inputTokens,omitempty"`
	OutputTokens int                    `json:"outputTokens,omitempty"`
	Provider     string                 `json:"provider,omitempty"`
	Model        string                 `json:"model,omitempty"`
}

func (e *Executor) callExecuteAPI(ctx context.Context, assignmentID string) (*executeAPIResponse, error) {
	url := fmt.Sprintf("%s/api/agents/assignments/%s/execute", e.config.APIURL, assignmentID)

	body, _ := json.Marshal(map[string]string{
		"source": "go_coordinator",
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if e.config.APIToken != "" {
		req.Header.Set("Authorization", "Bearer "+e.config.APIToken)
	}
	// Internal service header — bypasses user auth
	req.Header.Set("X-Internal-Service", "agent-worker")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("API returned %d: %s", resp.StatusCode, string(respBody[:min(len(respBody), 500)]))
	}

	var result executeAPIResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &result, nil
}

// ─── DB OPERATIONS ─────────────────────────────────────────────

func (e *Executor) setAgentStatus(ctx context.Context, agentID, status string) error {
	_, err := e.db.ExecContext(ctx, `
		UPDATE agent_personas
		SET status = $1, updated_at = NOW()
		WHERE id = $2 AND hidden_at IS NULL
	`, status, agentID)
	return err
}

func (e *Executor) failAssignment(ctx context.Context, assignmentID, agentID, errMsg string) {
	_, err := e.db.ExecContext(ctx, `
		UPDATE agent_assignments
		SET status = 'failed',
		    result = $1::jsonb,
		    completed_at = NOW(),
		    updated_at = NOW()
		WHERE id = $2
	`, fmt.Sprintf(`{"error": %q}`, truncate(errMsg, 1000)), assignmentID)

	if err != nil {
		e.logger.Error("Executor: failed to mark assignment as failed",
			zap.String("assignment_id", assignmentID),
			zap.Error(err),
		)
	}

	// Reset agent to idle
	e.setAgentStatus(ctx, agentID, "idle")

	// Activity log
	e.db.ExecContext(ctx, `
		INSERT INTO agent_activity_log (agent_id, action, entity_type, entity_id, details)
		VALUES ($1, 'execution_failed', 'assignment', $2, $3::jsonb)
	`, agentID, assignmentID, fmt.Sprintf(`{"error": %q}`, truncate(errMsg, 500)))
}

func (e *Executor) completeAssignment(ctx context.Context, assignmentID, agentID string, result *executeAPIResponse) error {
	resultJSON, _ := json.Marshal(result.Result)

	_, err := e.db.ExecContext(ctx, `
		UPDATE agent_assignments
		SET status = 'completed',
		    result = $1::jsonb,
		    cost_cents = $2,
		    tokens_used = $3,
		    completed_at = NOW(),
		    updated_at = NOW()
		WHERE id = $4
	`, string(resultJSON), result.CostCents, result.InputTokens+result.OutputTokens, assignmentID)

	if err != nil {
		return fmt.Errorf("complete assignment update failed: %w", err)
	}

	// Set agent back to idle
	return e.setAgentStatus(ctx, agentID, "idle")
}

// ─── HELPERS ───────────────────────────────────────────────────

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
