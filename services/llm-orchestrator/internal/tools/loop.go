// Package tools provides the agentic tool_use loop.
//
// Flow: send messages + tools to LLM → parse tool_call blocks →
// execute tools via sandbox → feed results back → repeat until
// model produces a final text response or limits are hit.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"go.uber.org/zap"
)

// LoopConfig configures the agentic tool_use loop.
type LoopConfig struct {
	Messages      []providers.Message
	Tools         []providers.ToolDefinition
	WorkspacePath string
	Model         string
	MaxTokens     int
	Temperature   float32
	MaxToolRounds int // max iterations before forced stop (default: 20)
	BudgetCents   int // max cost in cents (0 = unlimited)
	Stream        bool
}

// LoopResult contains the final result of the tool_use loop.
type LoopResult struct {
	Content        string            `json:"content"`
	TokensUsed     int               `json:"tokens_used"`
	CostCents      float64           `json:"cost_cents"`
	ToolRounds     int               `json:"tool_rounds"`
	ToolsExecuted  []ToolExecution   `json:"tools_executed"`
	FinishReason   string            `json:"finish_reason"`
	Model          string            `json:"model"`
	DurationMs     int64             `json:"duration_ms"`
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

// LoopEvent is emitted during the tool_use loop for SSE streaming.
type LoopEvent struct {
	Type string      `json:"type"` // "thinking", "tool_call", "tool_result", "delta", "completed", "error"
	Data interface{} `json:"data"`
}

// OnLoopEvent is a callback for loop events.
type OnLoopEvent func(event LoopEvent)

// RunToolLoop executes the agentic tool_use loop.
//
// It sends messages + tool definitions to the LLM via the orchestrator engine.
// When the LLM responds with tool_call blocks, tools are executed via the sandbox
// and results fed back. The loop continues until:
//   - The LLM produces a final text response (no tool calls)
//   - MaxToolRounds is reached
//   - Budget is exhausted
//   - Context is cancelled
func RunToolLoop(
	ctx context.Context,
	engine *orchestrator.Engine,
	config LoopConfig,
	onEvent OnLoopEvent,
	logger *zap.Logger,
) (*LoopResult, error) {
	if config.MaxToolRounds <= 0 {
		config.MaxToolRounds = 20
	}
	if config.MaxTokens <= 0 {
		config.MaxTokens = 8192
	}
	if config.Temperature <= 0 {
		config.Temperature = 0.3
	}

	start := time.Now()
	result := &LoopResult{
		Model: config.Model,
	}

	// Build conversation from initial messages
	conversation := make([]providers.Message, len(config.Messages))
	copy(conversation, config.Messages)

	totalInputTokens := 0
	totalOutputTokens := 0

	for round := 0; round < config.MaxToolRounds; round++ {
		select {
		case <-ctx.Done():
			result.Content = "Loop cancelled"
			result.FinishReason = "cancelled"
			result.DurationMs = time.Since(start).Milliseconds()
			return result, ctx.Err()
		default:
		}

		result.ToolRounds = round + 1

		logger.Debug("Tool loop round",
			zap.Int("round", round+1),
			zap.Int("max_rounds", config.MaxToolRounds),
			zap.Int("message_count", len(conversation)),
		)

		// Build completion request
		req := &orchestrator.CompletionRequest{
			CompletionRequest: &providers.CompletionRequest{
				Model:       config.Model,
				Messages:    conversation,
				MaxTokens:   config.MaxTokens,
				Temperature: config.Temperature,
				Tools:       config.Tools,
			},
		}

		// Call LLM via engine
		resp, err := engine.Complete(ctx, req)
		if err != nil {
			if onEvent != nil {
				onEvent(LoopEvent{Type: "error", Data: map[string]string{"message": err.Error()}})
			}
			result.FinishReason = "error"
			result.DurationMs = time.Since(start).Milliseconds()
			return result, fmt.Errorf("LLM call failed (round %d): %w", round+1, err)
		}

		totalInputTokens += resp.InputTokens
		totalOutputTokens += resp.OutputTokens

		// Check if response has tool calls
		if len(resp.ToolCalls) > 0 && resp.FinishReason == "tool_use" {
			// Add assistant response with tool calls to conversation
			assistantContent := resp.Content
			if assistantContent != "" && onEvent != nil {
				onEvent(LoopEvent{Type: "thinking", Data: map[string]string{"content": assistantContent}})
			}

			// Execute each tool call
			var toolResultMessages []string
			for _, tc := range resp.ToolCalls {
				if onEvent != nil {
					onEvent(LoopEvent{Type: "tool_call", Data: map[string]interface{}{
						"id": tc.ID, "tool_name": tc.Name, "input": tc.Input,
					}})
				}

				// Marshal input for executor
				inputJSON, _ := json.Marshal(tc.Input)

				// Execute tool
				toolResult := ExecuteTool(ctx, config.WorkspacePath, tc.Name, inputJSON)

				exec := ToolExecution{
					Round:      round + 1,
					ToolName:   tc.Name,
					Success:    toolResult.Success,
					DurationMs: toolResult.DurationMs,
					InputSize:  len(inputJSON),
					OutputSize: len(toolResult.Output),
				}
				result.ToolsExecuted = append(result.ToolsExecuted, exec)

				if onEvent != nil {
					onEvent(LoopEvent{Type: "tool_result", Data: map[string]interface{}{
						"id": tc.ID, "tool_name": tc.Name,
						"success": toolResult.Success, "output_size": len(toolResult.Output),
						"duration_ms": toolResult.DurationMs,
					}})
				}

				// Build tool result text
				output := toolResult.Output
				if !toolResult.Success {
					output = fmt.Sprintf("ERROR: %s", toolResult.Error)
				}
				// Truncate very large outputs
				if len(output) > 50000 {
					output = output[:50000] + "\n... (truncated)"
				}
				toolResultMessages = append(toolResultMessages,
					fmt.Sprintf("[Tool %s result for %s]: %s", tc.Name, tc.ID, output))

				logger.Debug("Tool executed",
					zap.String("tool", tc.Name),
					zap.Bool("success", toolResult.Success),
					zap.Int64("duration_ms", toolResult.DurationMs),
				)
			}

			// Add assistant message (with tool calls context)
			if assistantContent != "" {
				conversation = append(conversation, providers.Message{
					Role:    "assistant",
					Content: assistantContent,
				})
			}

			// Add tool results as user message
			conversation = append(conversation, providers.Message{
				Role:    "user",
				Content: fmt.Sprintf("Tool execution results:\n\n%s", joinToolResults(toolResultMessages)),
			})

			continue
		}

		// No tool calls — this is the final response
		result.Content = resp.Content
		result.FinishReason = resp.FinishReason
		if result.FinishReason == "" {
			result.FinishReason = "end_turn"
		}

		if onEvent != nil && result.Content != "" {
			onEvent(LoopEvent{Type: "delta", Data: map[string]string{"text": result.Content}})
		}

		break
	}

	// If we exhausted rounds without a final response
	if result.FinishReason == "" {
		result.FinishReason = "max_rounds"
		result.Content = "Tool loop reached maximum rounds without producing a final response."
	}

	result.TokensUsed = totalInputTokens + totalOutputTokens
	result.CostCents = float64(totalInputTokens)*0.001/1000 + float64(totalOutputTokens)*0.005/1000 // rough estimate
	result.DurationMs = time.Since(start).Milliseconds()

	if onEvent != nil {
		onEvent(LoopEvent{Type: "completed", Data: result})
	}

	return result, nil
}

func joinToolResults(results []string) string {
	out := ""
	for _, r := range results {
		out += r + "\n\n"
	}
	return out
}
