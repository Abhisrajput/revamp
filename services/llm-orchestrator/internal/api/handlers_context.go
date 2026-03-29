package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"go.uber.org/zap"
)

// ContextBuildRequest for POST /api/v2/context/build
type ContextBuildRequest struct {
	PipelineRunID  string `json:"pipeline_run_id"`
	TargetStage    string `json:"target_stage"`
	TargetIndex    int    `json:"target_index"`
	MaxTokens      int    `json:"max_context_tokens"`
	PriorArtifacts []struct {
		StageName string `json:"stage_name"`
		L0Summary string `json:"l0_summary"`
		L1Summary string `json:"l1_summary"`
		L2Content string `json:"l2_content"`
	} `json:"prior_artifacts"`
}

// ContextSummarizeRequest for POST /api/v2/context/summarize
type ContextSummarizeRequest struct {
	StageName string `json:"stage_name"`
	Content   string `json:"content"`
	Model     string `json:"model"`
}

// handleContextBuild handles POST /api/v2/context/build
// Assembles tiered context (L0/L1/L2) within a token budget.
func (s *Server) handleContextBuild(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}

	var req ContextBuildRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 100000
	}

	// Assemble context using tiered approach:
	// - Start with L0 (compact ~100 tokens per stage)
	// - Upgrade to L1 (medium ~2K tokens) if budget allows
	// - Upgrade to L2 (full content) for most recent/relevant stages
	var parts []string
	var totalChars int
	maxChars := maxTokens * 4 // rough token→char conversion

	trajectory := []map[string]interface{}{}

	for _, artifact := range req.PriorArtifacts {
		var content string
		var tier string

		// Try L2 first (most recent stages get full content)
		if artifact.L2Content != "" && totalChars+len(artifact.L2Content) < maxChars {
			content = artifact.L2Content
			tier = "L2"
		} else if artifact.L1Summary != "" && totalChars+len(artifact.L1Summary) < maxChars {
			content = artifact.L1Summary
			tier = "L1"
		} else if artifact.L0Summary != "" {
			content = artifact.L0Summary
			tier = "L0"
		} else {
			tier = "skipped"
			continue
		}

		parts = append(parts, fmt.Sprintf("## %s (Tier: %s)\n%s", artifact.StageName, tier, content))
		totalChars += len(content)

		trajectory = append(trajectory, map[string]interface{}{
			"stage":  artifact.StageName,
			"tier":   tier,
			"tokens": len(content) / 4,
			"reason": "within_budget",
		})
	}

	assembled := strings.Join(parts, "\n\n---\n\n")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"assembled_context": assembled,
		"tokens_used":       len(assembled) / 4,
		"trajectory":        trajectory,
	})
}

// handleContextSummarize handles POST /api/v2/context/summarize
// Generates L0 (1-sentence) and L1 (~2K token) summaries.
func (s *Server) handleContextSummarize(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}

	var req ContextSummarizeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Content == "" {
		http.Error(w, "content is required", http.StatusBadRequest)
		return
	}

	model := req.Model
	if model == "" {
		// Use cheapest available model for summarization
		models := s.engine.ListModels()
		for id := range models {
			if strings.Contains(id, "haiku") {
				model = id
				break
			}
		}
		if model == "" {
			for id := range models {
				model = id
				break
			}
		}
	}

	// Truncate content for summarization
	content := req.Content
	if len(content) > 20000 {
		content = content[:20000] + "\n... (truncated)"
	}

	// Generate L0 summary (1 sentence)
	l0Req := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model: model,
			Messages: []providers.Message{
				{Role: "system", Content: "Summarize in exactly ONE sentence (max 100 tokens). Be specific about findings, not generic."},
				{Role: "user", Content: fmt.Sprintf("Summarize this %s stage output:\n\n%s", req.StageName, content[:min(4000, len(content))])},
			},
			MaxTokens:   150,
			Temperature: 0.1,
		},
	}

	l0Resp, l0Err := s.engine.Complete(r.Context(), l0Req)
	l0 := ""
	if l0Err == nil {
		l0 = l0Resp.Content
	}

	// Generate L1 summary (~2K tokens)
	l1Req := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model: model,
			Messages: []providers.Message{
				{Role: "system", Content: "Create a structured summary (~500 words) with key findings, decisions, and data points. Use ## headings."},
				{Role: "user", Content: fmt.Sprintf("Summarize this %s stage output:\n\n%s", req.StageName, content)},
			},
			MaxTokens:   2048,
			Temperature: 0.1,
		},
	}

	l1Resp, l1Err := s.engine.Complete(r.Context(), l1Req)
	l1 := ""
	if l1Err == nil {
		l1 = l1Resp.Content
	}

	s.logger.Info("Context summarized",
		zap.String("stage", req.StageName),
		zap.Int("l0_len", len(l0)),
		zap.Int("l1_len", len(l1)),
	)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"l0": l0,
		"l1": l1,
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
