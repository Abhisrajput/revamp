package api

import (
	"encoding/json"
	"net/http"

	"go.uber.org/zap"
)

// BudgetCheckRequest for POST /api/v2/budget/check
type BudgetCheckRequest struct {
	AgentID          string `json:"agent_id"`
	PipelineRunID    string `json:"pipeline_run_id"`
	ProjectID        string `json:"project_id"`
	EstimatedCostCents int  `json:"estimated_cost_cents"`
}

// BudgetRecordRequest for POST /api/v2/budget/record
type BudgetRecordRequest struct {
	AgentID       string  `json:"agent_id"`
	PipelineRunID string  `json:"pipeline_run_id"`
	ProjectID     string  `json:"project_id"`
	Provider      string  `json:"provider"`
	Model         string  `json:"model"`
	InputTokens   int     `json:"input_tokens"`
	OutputTokens  int     `json:"output_tokens"`
	CostCents     float64 `json:"cost_cents"`
	StageName     string  `json:"stage_name"`
	Operation     string  `json:"operation"`
}

// handleBudgetCheck handles POST /api/v2/budget/check
func (s *Server) handleBudgetCheck(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}

	var req BudgetCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Check budget against Redis/in-memory tracking
	// For now, use simple in-memory tracking per pipeline run
	spent := s.getBudgetSpent(req.PipelineRunID)
	limit := s.getBudgetLimit(req.PipelineRunID)

	allowed := true
	if limit > 0 && spent+req.EstimatedCostCents > limit {
		allowed = false
		s.logger.Warn("Budget exceeded",
			zap.String("pipeline", req.PipelineRunID),
			zap.Int("spent", spent),
			zap.Int("limit", limit),
		)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"allowed":         allowed,
		"spent_cents":     spent,
		"limit_cents":     limit,
		"remaining_cents": max(0, limit-spent),
		"hard_stop":       limit > 0,
	})
}

// handleBudgetRecord handles POST /api/v2/budget/record
func (s *Server) handleBudgetRecord(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}

	var req BudgetRecordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	s.recordSpend(req.PipelineRunID, int(req.CostCents))

	remaining := max(0, s.getBudgetLimit(req.PipelineRunID)-s.getBudgetSpent(req.PipelineRunID))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"recorded":        true,
		"remaining_cents": remaining,
	})
}

// In-memory budget tracking (production: use Redis)
var budgetSpent = make(map[string]int)
var budgetLimits = make(map[string]int)

func (s *Server) getBudgetSpent(pipelineRunID string) int {
	return budgetSpent[pipelineRunID]
}

func (s *Server) getBudgetLimit(pipelineRunID string) int {
	if l, ok := budgetLimits[pipelineRunID]; ok {
		return l
	}
	return 0 // 0 = unlimited
}

func (s *Server) recordSpend(pipelineRunID string, cents int) {
	budgetSpent[pipelineRunID] += cents
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
