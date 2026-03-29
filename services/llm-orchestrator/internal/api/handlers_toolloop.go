package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"github.com/revamp-io/llm-orchestrator/internal/tools"
	"go.uber.org/zap"
)

// ToolLoopRequest is the request body for POST /api/v2/tools/loop
type ToolLoopRequest struct {
	Messages      []providers.Message        `json:"messages"`
	Tools         []providers.ToolDefinition `json:"tools"`
	WorkspacePath string                     `json:"workspace_path"`
	Model         string                     `json:"model"`
	MaxTokens     int                        `json:"max_tokens"`
	Temperature   float32                    `json:"temperature"`
	MaxToolRounds int                        `json:"max_tool_rounds"`
	BudgetCents   int                        `json:"budget_cents"`
	Stream        bool                       `json:"stream"`
}

// handleToolLoop handles POST /api/v2/tools/loop
// Runs the full agentic tool_use loop with SSE streaming.
func (s *Server) handleToolLoop(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}

	var req ToolLoopRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if len(req.Messages) == 0 {
		http.Error(w, "messages is required", http.StatusBadRequest)
		return
	}
	if req.WorkspacePath == "" {
		http.Error(w, "workspace_path is required", http.StatusBadRequest)
		return
	}

	s.logger.Info("Starting tool loop",
		zap.String("model", req.Model),
		zap.Int("tools", len(req.Tools)),
		zap.Int("max_rounds", req.MaxToolRounds),
		zap.String("workspace", req.WorkspacePath),
	)

	config := tools.LoopConfig{
		Messages:      req.Messages,
		Tools:         req.Tools,
		WorkspacePath: req.WorkspacePath,
		Model:         req.Model,
		MaxTokens:     req.MaxTokens,
		Temperature:   req.Temperature,
		MaxToolRounds: req.MaxToolRounds,
		BudgetCents:   req.BudgetCents,
		Stream:        req.Stream,
	}

	if req.Stream {
		// SSE streaming response
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming not supported", http.StatusInternalServerError)
			return
		}

		result, err := tools.RunToolLoop(r.Context(), s.engine, config, func(event tools.LoopEvent) {
			data, _ := json.Marshal(event.Data)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, string(data))
			flusher.Flush()
		}, s.logger)

		if err != nil {
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
			flusher.Flush()
			return
		}

		data, _ := json.Marshal(result)
		fmt.Fprintf(w, "event: completed\ndata: %s\n\n", string(data))
		flusher.Flush()
	} else {
		// Non-streaming response
		result, err := tools.RunToolLoop(r.Context(), s.engine, config, nil, s.logger)
		if err != nil {
			s.logger.Error("Tool loop failed", zap.Error(err))
			http.Error(w, fmt.Sprintf("Tool loop failed: %v", err), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}
