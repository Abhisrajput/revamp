package providers

import (
	"context"
	"io"
	"time"
)

// CacheControl specifies prompt caching behavior (Anthropic).
// Supported types: "ephemeral" (cached for session duration, ~5 min TTL).
type CacheControl struct {
	Type string `json:"type"` // "ephemeral"
}

// Message represents a chat message
type Message struct {
	Role         string        `json:"role"`          // user, assistant, system
	Content      string        `json:"content"`
	CacheControl *CacheControl `json:"cache_control,omitempty"` // Anthropic prompt caching
}

// ResponseFormat configures structured output mode.
//
// Best practices (from provider docs):
//   - OpenAI: type="json_schema" with JSONSchema for guaranteed schema compliance
//   - Anthropic: type="json" with tool use for structured extraction
//   - Gemini: type="json" with response_schema for constrained generation
type ResponseFormat struct {
	Type       string      `json:"type"`                  // "text", "json", "json_schema"
	JSONSchema interface{} `json:"json_schema,omitempty"` // OpenAI strict structured outputs
}

// ToolDefinition describes a tool the LLM can call.
type ToolDefinition struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"input_schema"`
}

// ToolCall represents a tool call from the LLM response.
type ToolCall struct {
	ID    string      `json:"id"`
	Name  string      `json:"name"`
	Input interface{} `json:"input"`
}

// ToolResultMessage is a message containing tool execution results.
type ToolResultMessage struct {
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error,omitempty"`
}

// ContentBlock represents a content block in a multi-part message (text or tool_use).
type ContentBlock struct {
	Type  string      `json:"type"`            // "text" or "tool_use" or "tool_result"
	Text  string      `json:"text,omitempty"`
	ID    string      `json:"id,omitempty"`    // tool_use block ID
	Name  string      `json:"name,omitempty"`  // tool name
	Input interface{} `json:"input,omitempty"` // tool input
	// For tool_result
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   string `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
}

// RichMessage supports both simple text and multi-part content (tool calls/results).
type RichMessage struct {
	Role    string         `json:"role"`
	Content []ContentBlock `json:"content,omitempty"`
	// For simple text messages, use TextContent
	TextContent string `json:"text_content,omitempty"`
}

// CompletionRequest represents an LLM completion request
type CompletionRequest struct {
	Model       string     `json:"model"`
	Messages    []Message  `json:"messages"`
	MaxTokens   int        `json:"max_tokens"`
	Temperature float32    `json:"temperature"`
	TopP        float32    `json:"top_p"`
	Stop        []string   `json:"stop"`
	Stream      bool       `json:"stream"`
	Timeout     time.Duration

	// Tool calling
	Tools      []ToolDefinition `json:"tools,omitempty"`
	ToolChoice string           `json:"tool_choice,omitempty"` // "auto", "any", "none", or specific tool name

	// Rich messages (for tool_result turns)
	RichMessages []RichMessage `json:"rich_messages,omitempty"`

	// Structured output
	ResponseFormat *ResponseFormat `json:"response_format,omitempty"`

	// Extended thinking / reasoning (Anthropic extended thinking, OpenAI o-series)
	ExtendedThinking bool `json:"extended_thinking,omitempty"`
	ThinkingBudget   int  `json:"thinking_budget,omitempty"`

	// Metadata
	ProjectID string                 `json:"project_id"`
	UserID    string                 `json:"user_id"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
}

// CompletionResponse represents an LLM completion response
type CompletionResponse struct {
	ID           string `json:"id"`
	Model        string `json:"model"`
	Provider     string `json:"provider"`
	Content      string `json:"content"`
	FinishReason string `json:"finish_reason"` // "end_turn", "tool_use", "stop", "max_tokens"

	// Tool calls (when finish_reason = "tool_use")
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`

	// Token usage
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`

	// Prompt caching metrics (Anthropic)
	CacheCreationTokens int `json:"cache_creation_tokens,omitempty"` // tokens written to cache
	CacheReadTokens     int `json:"cache_read_tokens,omitempty"`     // tokens served from cache

	// Extended thinking
	ThinkingContent string `json:"thinking_content,omitempty"` // reasoning trace
	ThinkingTokens  int    `json:"thinking_tokens,omitempty"`

	Cost    float64 `json:"cost"`
	Latency time.Duration
	Error   string `json:"error,omitempty"`
}

// StreamChunk represents a chunk of streaming data
type StreamChunk struct {
	ID           string `json:"id"`
	Index        int    `json:"index"`
	Delta        string `json:"delta"`
	FinishReason string `json:"finish_reason"`
	Error        string `json:"error,omitempty"`
}

// LLMProvider defines the interface for LLM providers
type LLMProvider interface {
	// Name returns the provider name (openai, anthropic, gemini, bedrock)
	Name() string

	// IsAvailable checks if the provider is configured and available
	IsAvailable() bool

	// SupportsModel checks if the provider supports a specific model
	SupportsModel(model string) bool

	// Complete sends a completion request to the provider
	Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error)

	// Stream sends a streaming completion request
	Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error)

	// GetModels returns the list of supported models
	GetModels() []string

	// GetHealth returns health status of the provider
	GetHealth() ProviderHealth
}

// ProviderHealth represents the health status of a provider
type ProviderHealth struct {
	Name         string        `json:"name"`
	Healthy      bool          `json:"healthy"`
	LastError    string        `json:"last_error"`
	ErrorCount   int           `json:"error_count"`
	SuccessCount int           `json:"success_count"`
	LastCheckTime time.Time    `json:"last_check_time"`
	Latency      time.Duration `json:"latency"`
}

// BaseProvider provides common functionality for all providers
type BaseProvider struct {
	name         string
	health       ProviderHealth
	models       []string
	lastError    string
	errorCount   int
	successCount int
	startTime    time.Time
}

// NewBaseProvider creates a new base provider
func NewBaseProvider(name string, models []string) *BaseProvider {
	return &BaseProvider{
		name:      name,
		models:    models,
		startTime: time.Now(),
		health: ProviderHealth{
			Name:          name,
			LastCheckTime: time.Now(),
		},
	}
}

// Name returns the provider name
func (bp *BaseProvider) Name() string {
	return bp.name
}

// GetModels returns the list of supported models
func (bp *BaseProvider) GetModels() []string {
	return bp.models
}

// GetHealth returns the provider health status
func (bp *BaseProvider) GetHealth() ProviderHealth {
	bp.health.LastCheckTime = time.Now()
	bp.health.Healthy = bp.errorCount < 5 && bp.lastError == ""
	return bp.health
}

// RecordSuccess records a successful request
func (bp *BaseProvider) RecordSuccess() {
	bp.successCount++
	bp.errorCount = 0
	bp.lastError = ""
}

// RecordError records a failed request
func (bp *BaseProvider) RecordError(err error) {
	bp.errorCount++
	if err != nil {
		bp.lastError = err.Error()
	}
	bp.health.LastError = bp.lastError
	bp.health.ErrorCount = bp.errorCount
	bp.health.SuccessCount = bp.successCount
}

// ReadStream reads from a streaming reader and sends chunks to a channel
func ReadStream(rc io.ReadCloser, onChunk func(string) error) error {
	defer rc.Close()
	return onChunk("")
}

// ModelInfo contains information about a model
type ModelInfo struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Provider     string  `json:"provider"`
	ContextSize  int     `json:"context_size"`
	CostPerInput float64 `json:"cost_per_input"`     // per 1M tokens
	CostPerOutput float64 `json:"cost_per_output"`   // per 1M tokens
	Owner        string  `json:"owner"`
	CreatedAt    string  `json:"created_at"`
}
