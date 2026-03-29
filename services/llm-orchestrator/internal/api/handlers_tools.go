package api

import (
	"encoding/json"
	"net/http"

	"github.com/revamp-io/llm-orchestrator/internal/tools"
	"go.uber.org/zap"
)

// ToolExecuteRequest is the request body for POST /api/v2/tools/execute
type ToolExecuteRequest struct {
	WorkspacePath string          `json:"workspace_path"`
	ToolName      string          `json:"tool_name"`
	Arguments     json.RawMessage `json:"arguments"`
	TimeoutMs     int             `json:"timeout_ms,omitempty"`
}

// handleToolExecute handles POST /api/v2/tools/execute
func (s *Server) handleToolExecute(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}

	var req ToolExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.WorkspacePath == "" {
		http.Error(w, "workspace_path is required", http.StatusBadRequest)
		return
	}
	if req.ToolName == "" {
		http.Error(w, "tool_name is required", http.StatusBadRequest)
		return
	}

	s.logger.Debug("Executing tool",
		zap.String("tool", req.ToolName),
		zap.String("workspace", req.WorkspacePath),
	)

	result := tools.ExecuteTool(r.Context(), req.WorkspacePath, req.ToolName, req.Arguments)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handleListTools handles GET /api/v2/tools
func (s *Server) handleListTools(w http.ResponseWriter, r *http.Request) {
	stageIndex := 0 // default: read-only tools
	if q := r.URL.Query().Get("stage_index"); q != "" {
		var idx int
		if _, err := json.Number(q).Int64(); err == nil {
			idx = int(json.Number(q).String()[0] - '0')
		}
		stageIndex = idx
	}

	defs := tools.ToolsForStage(stageIndex)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tools": defs,
		"count": len(defs),
	})
}
