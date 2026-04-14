// Package tools provides the agentic tool_use loop.
//
// The tool loop executes tool calls dispatched by the Node API. LLM routing
// (provider selection, model calls) is handled by the Node SDK layer. The Go
// agent-worker is responsible for sandbox tool execution only.
//
// The gRPC interface for Go-side tool dispatch will be added when the
// Playground feature requires it.
package tools

// LoopResult contains the result of a batch of tool executions.
type LoopResult struct {
	Content       string          `json:"content"`
	TokensUsed    int             `json:"tokens_used"`
	CostCents     float64         `json:"cost_cents"`
	ToolRounds    int             `json:"tool_rounds"`
	ToolsExecuted []ToolExecution `json:"tools_executed"`
	FinishReason  string          `json:"finish_reason"`
	Model         string          `json:"model"`
	DurationMs    int64           `json:"duration_ms"`
}

// ToolExecution records one tool execution within the loop.
type ToolExecution struct {
	Round      int    `json:"round"`
	ToolName   string `json:"tool_name"`
	Success    bool   `json:"success"`
	DurationMs int64  `json:"duration_ms"`
	InputSize  int    `json:"input_size"`
	OutputSize int    `json:"output_size"`
}

// LoopEvent is emitted during tool execution for SSE streaming.
type LoopEvent struct {
	Type string      `json:"type"` // "tool_call", "tool_result", "error"
	Data interface{} `json:"data"`
}

// OnLoopEvent is a callback for loop events.
type OnLoopEvent func(event LoopEvent)
