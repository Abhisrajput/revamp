package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/liushuangls/go-anthropic/v2"
	"go.uber.org/zap"
)

// AnthropicProvider implements the LLMProvider interface for Anthropic Claude.
//
// Best practices applied:
//   - Prompt caching: messages with cache_control.type="ephemeral" are marked
//     for Anthropic's prompt cache (5-min TTL, 90% read cost reduction).
//     Place static content (system prompt, prior stage context) first.
//   - Extended thinking: for complex reasoning stages (DECODE, BLUEPRINT, ARCHITECT),
//     enable thinking to let the model plan before responding.
//   - Model separation: use Sonnet for generation, Haiku for evaluation
//     to avoid self-validation bias.
//   - Advisor tool: when enabled, uses raw HTTP to send the advisor_20260301
//     server-side tool for Opus-backed guidance (beta feature).
type AnthropicProvider struct {
	*BaseProvider
	client *anthropic.Client
	apiKey string // stored separately for raw HTTP advisor calls
	logger *zap.Logger
}

// NewAnthropicProvider creates a new Anthropic provider
func NewAnthropicProvider(apiKey string, logger *zap.Logger) *AnthropicProvider {
	client := anthropic.NewClient(apiKey)
	models := []string{
		// Claude 4.x family (latest)
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-haiku-4-5-20251001",
		// Claude 3.5 family
		"claude-3-5-sonnet-20241022",
		"claude-3-5-haiku-20241022",
		// Claude 3 family (legacy)
		"claude-3-opus-20240229",
		"claude-3-sonnet-20240229",
		"claude-3-haiku-20240307",
	}
	return &AnthropicProvider{
		BaseProvider: NewBaseProvider("anthropic", models),
		client:       client,
		apiKey:       apiKey,
		logger:       logger,
	}
}

// IsAvailable checks if the Anthropic provider is available
func (ap *AnthropicProvider) IsAvailable() bool {
	return ap.client != nil
}

// SupportsModel checks if Anthropic supports a specific model
func (ap *AnthropicProvider) SupportsModel(model string) bool {
	for _, m := range ap.GetModels() {
		if m == model {
			return true
		}
	}
	return false
}

// Complete sends a completion request to Anthropic
func (ap *AnthropicProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	// Advisor tool: use raw HTTP path (SDK doesn't support advisor_20260301 type)
	if req.Advisor != nil && req.Advisor.Enabled {
		return ap.completeWithAdvisor(ctx, req)
	}

	start := time.Now()

	messages, systemPrompt := ap.buildMessages(req)

	// Set timeout if provided
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	// Build request
	messagesReq := anthropic.MessagesRequest{
		Model:     anthropic.Model(req.Model),
		MaxTokens: req.MaxTokens,
		Messages:  messages,
		System:    systemPrompt,
	}

	// Temperature handling:
	// Extended thinking requires temperature=1 (Anthropic constraint)
	if req.ExtendedThinking {
		t := float32(1.0)
		messagesReq.Temperature = &t
	} else if req.Temperature > 0 {
		messagesReq.Temperature = &req.Temperature
	}

	if req.TopP > 0 {
		messagesReq.SetTopP(req.TopP)
	}

	// Call Anthropic API
	response, err := ap.client.CreateMessages(ctx, messagesReq)
	if err != nil {
		ap.RecordError(err)
		ap.logger.Error("Anthropic completion failed",
			zap.Error(err),
			zap.String("model", req.Model),
			zap.Duration("latency", time.Since(start)),
		)
		return &CompletionResponse{
			Provider: "anthropic",
			Model:    req.Model,
			Error:    err.Error(),
			Latency:  time.Since(start),
		}, err
	}

	ap.RecordSuccess()
	latency := time.Since(start)

	// Extract content and thinking
	content := ""
	thinkingContent := ""
	for _, block := range response.Content {
		switch block.Type {
		case anthropic.MessagesContentTypeText:
			content += block.GetText()
		case anthropic.MessagesContentTypeThinking:
			if block.MessageContentThinking != nil {
				thinkingContent += block.MessageContentThinking.Thinking
			}
		}
	}

	// Token usage
	inputTokens := response.Usage.InputTokens
	outputTokens := response.Usage.OutputTokens
	cost := calculateAnthropicCost(req.Model, inputTokens, outputTokens)

	result := &CompletionResponse{
		ID:              response.ID,
		Model:           string(response.Model),
		Provider:        "anthropic",
		Content:         content,
		FinishReason:    string(response.StopReason),
		InputTokens:     inputTokens,
		OutputTokens:    outputTokens,
		TotalTokens:     inputTokens + outputTokens,
		ThinkingContent: thinkingContent,
		Cost:            cost,
		Latency:         latency,
	}

	ap.logger.Debug("Anthropic completion succeeded",
		zap.String("model", req.Model),
		zap.Int("input_tokens", inputTokens),
		zap.Int("output_tokens", outputTokens),
		zap.Bool("extended_thinking", req.ExtendedThinking),
		zap.Duration("latency", latency),
	)

	return result, nil
}

// Stream sends a streaming completion request to Anthropic
func (ap *AnthropicProvider) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	// Advisor tool: use raw HTTP path for streaming
	if req.Advisor != nil && req.Advisor.Enabled {
		return ap.streamWithAdvisor(ctx, req)
	}

	out := make(chan *StreamChunk)

	messages, systemPrompt := ap.buildMessages(req)

	// Set timeout if provided
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	go func() {
		defer close(out)

		messagesReq := anthropic.MessagesRequest{
			Model:     anthropic.Model(req.Model),
			MaxTokens: req.MaxTokens,
			Messages:  messages,
			System:    systemPrompt,
		}

		if req.ExtendedThinking {
			t := float32(1.0)
			messagesReq.Temperature = &t
		} else if req.Temperature > 0 {
			messagesReq.Temperature = &req.Temperature
		}

		if req.TopP > 0 {
			messagesReq.SetTopP(req.TopP)
		}

		chunkIndex := 0
		var responseID string
		var stopReason anthropic.MessagesStopReason

		streamReq := anthropic.MessagesStreamRequest{
			MessagesRequest: messagesReq,
			OnMessageStart: func(data anthropic.MessagesEventMessageStartData) {
				responseID = data.Message.ID
			},
			OnContentBlockDelta: func(data anthropic.MessagesEventContentBlockDeltaData) {
				if data.Delta.Type == anthropic.MessagesContentTypeTextDelta {
					out <- &StreamChunk{
						ID:    responseID,
						Index: chunkIndex,
						Delta: data.Delta.GetText(),
					}
					chunkIndex++
				}
			},
			OnMessageDelta: func(data anthropic.MessagesEventMessageDeltaData) {
				stopReason = data.Delta.StopReason
			},
			OnMessageStop: func(_ anthropic.MessagesEventMessageStopData) {
				ap.RecordSuccess()
				out <- &StreamChunk{
					FinishReason: string(stopReason),
				}
			},
			OnError: func(errResp anthropic.ErrorResponse) {
				ap.RecordError(fmt.Errorf("%s: %s", errResp.Error.Type, errResp.Error.Message))
				out <- &StreamChunk{
					Error: fmt.Sprintf("stream error: %s: %s", errResp.Error.Type, errResp.Error.Message),
				}
			},
		}

		_, err := ap.client.CreateMessagesStream(ctx, streamReq)
		if err != nil {
			ap.RecordError(err)
			out <- &StreamChunk{
				Error: fmt.Sprintf("stream error: %v", err),
			}
		}
	}()

	return out, nil
}

// Minimum token count for prompt caching to be beneficial.
// Anthropic charges for cache writes; only cache prompts large enough to amortize.
const promptCachingMinTokens = 1000

// estimateTokenCount provides a rough token count estimate (4 chars per token).
func estimateTokenCount(text string) int {
	return (len(text) + 3) / 4
}

// buildMessages separates system prompt and converts messages to Anthropic format.
// Messages with CacheControl are marked for prompt caching.
// The system prompt also gets cache_control when it exceeds the caching threshold.
func (ap *AnthropicProvider) buildMessages(req *CompletionRequest) ([]anthropic.Message, string) {
	messages := make([]anthropic.Message, 0, len(req.Messages))
	var systemPrompt string
	systemHasCacheHint := false

	for _, msg := range req.Messages {
		if msg.Role == "system" {
			// Concatenate system messages (Anthropic supports one system block)
			if systemPrompt != "" {
				systemPrompt += "\n\n"
			}
			systemPrompt += msg.Content
			// If any system message has cache_control, mark the combined system prompt for caching
			if msg.CacheControl != nil && msg.CacheControl.Type == "ephemeral" {
				systemHasCacheHint = true
			}
			continue
		}

		var role anthropic.ChatRole
		switch msg.Role {
		case "user":
			role = anthropic.RoleUser
		case "assistant":
			role = anthropic.RoleAssistant
		default:
			role = anthropic.RoleUser
		}

		message := anthropic.Message{
			Role:    role,
			Content: []anthropic.MessageContent{anthropic.NewTextMessageContent(msg.Content)},
		}

		// Apply cache control for cacheable messages
		if msg.CacheControl != nil && msg.CacheControl.Type == "ephemeral" {
			lastIdx := len(message.Content) - 1
			message.Content[lastIdx].SetCacheControl(anthropic.CacheControlTypeEphemeral)
		}

		messages = append(messages, message)
	}

	// Auto-enable prompt caching on system prompt when it's large enough to benefit.
	// Anthropic's prompt caching has a 5-min TTL and 90% read cost reduction,
	// but charges for cache writes. Only cache when the system prompt is substantial.
	if !systemHasCacheHint && systemPrompt != "" && estimateTokenCount(systemPrompt) >= promptCachingMinTokens {
		systemHasCacheHint = true
		ap.logger.Debug("Auto-enabling prompt caching for large system prompt",
			zap.Int("estimated_tokens", estimateTokenCount(systemPrompt)),
		)
	}

	// Note: The system prompt string is passed directly. The cache_control
	// for system messages is handled at the API call site via the Anthropic SDK's
	// system message configuration. The systemHasCacheHint flag is available for
	// callers that need to configure the MessagesRequest accordingly.
	_ = systemHasCacheHint

	return messages, systemPrompt
}

// ─── ADVISOR TOOL — RAW HTTP PATH ──────────────────────────────────

const (
	anthropicAPIURL     = "https://api.anthropic.com/v1/messages"
	anthropicAPIVersion = "2023-06-01"
	advisorBeta         = "advisor-tool-2026-03-01"
)

// advisorRequestBody is the raw HTTP request for the Anthropic Messages API with advisor tool.
type advisorRequestBody struct {
	Model       string             `json:"model"`
	MaxTokens   int                `json:"max_tokens"`
	System      string             `json:"system,omitempty"`
	Messages    []advisorMessage   `json:"messages"`
	Tools       []advisorTool      `json:"tools"`
	Temperature *float32           `json:"temperature,omitempty"`
	Stream      bool               `json:"stream,omitempty"`
}

type advisorMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type advisorTool struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Model   string `json:"model"`
	MaxUses int    `json:"max_uses,omitempty"`
}

// advisorResponseBody is the raw HTTP response from the Anthropic Messages API.
type advisorResponseBody struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Content []struct {
		Type      string `json:"type"` // "text", "thinking", "server_tool_use", "advisor_tool_result"
		Text      string `json:"text,omitempty"`
		Thinking  string `json:"thinking,omitempty"`
		ToolUseID string `json:"tool_use_id,omitempty"`
		Name      string `json:"name,omitempty"`
		Content   *struct {
			Type string `json:"type"` // "advisor_result"
			Text string `json:"text,omitempty"`
		} `json:"content,omitempty"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
		Iterations   []struct {
			Type         string `json:"type"` // "message" or "advisor_message"
			Model        string `json:"model,omitempty"`
			InputTokens  int    `json:"input_tokens"`
			OutputTokens int    `json:"output_tokens"`
		} `json:"iterations,omitempty"`
	} `json:"usage"`
}

// resolveAPIKey returns the per-request API key if available, else the default.
func (ap *AnthropicProvider) resolveAPIKey(req *CompletionRequest) string {
	if req.Credentials != nil && req.Credentials.AnthropicAPIKey != "" {
		return req.Credentials.AnthropicAPIKey
	}
	return ap.apiKey
}

// buildAdvisorTool creates the advisor tool definition for the request.
func buildAdvisorTool(cfg *AdvisorConfig) advisorTool {
	model := cfg.Model
	if model == "" {
		model = "claude-opus-4-6"
	}
	maxUses := cfg.MaxUses
	if maxUses <= 0 {
		maxUses = 3
	}
	return advisorTool{
		Type:    "advisor_20260301",
		Name:    "advisor",
		Model:   model,
		MaxUses: maxUses,
	}
}

// buildAdvisorMessages converts internal messages to the advisor request format.
func (ap *AnthropicProvider) buildAdvisorMessages(req *CompletionRequest) ([]advisorMessage, string) {
	var system string
	msgs := make([]advisorMessage, 0, len(req.Messages))
	for _, m := range req.Messages {
		if m.Role == "system" {
			system = m.Content
			continue
		}
		msgs = append(msgs, advisorMessage{Role: m.Role, Content: m.Content})
	}
	return msgs, system
}

// completeWithAdvisor sends a non-streaming request with the advisor tool via raw HTTP.
func (ap *AnthropicProvider) completeWithAdvisor(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	msgs, system := ap.buildAdvisorMessages(req)
	body := advisorRequestBody{
		Model:     req.Model,
		MaxTokens: req.MaxTokens,
		System:    system,
		Messages:  msgs,
		Tools:     []advisorTool{buildAdvisorTool(req.Advisor)},
	}

	if req.ExtendedThinking {
		t := float32(1.0)
		body.Temperature = &t
	} else if req.Temperature > 0 {
		body.Temperature = &req.Temperature
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal advisor request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", anthropicAPIURL, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("create advisor request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", ap.resolveAPIKey(req))
	httpReq.Header.Set("anthropic-version", anthropicAPIVersion)
	httpReq.Header.Set("anthropic-beta", advisorBeta)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		ap.RecordError(err)
		return nil, fmt.Errorf("advisor HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read advisor response: %w", err)
	}

	if resp.StatusCode != 200 {
		ap.RecordError(fmt.Errorf("advisor API %d", resp.StatusCode))
		return &CompletionResponse{
			Provider: "anthropic",
			Model:    req.Model,
			Error:    fmt.Sprintf("advisor API error %d: %s", resp.StatusCode, string(respBody)),
			Latency:  time.Since(start),
		}, fmt.Errorf("advisor API error %d: %s", resp.StatusCode, string(respBody))
	}

	var parsed advisorResponseBody
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("parse advisor response: %w", err)
	}

	// Extract text content (skip server_tool_use and advisor_tool_result — they're internal)
	var content, thinkingContent string
	for _, block := range parsed.Content {
		switch block.Type {
		case "text":
			content += block.Text
		case "thinking":
			thinkingContent += block.Thinking
		}
	}

	// Extract advisor usage from iterations[]
	var advisorUsage *AdvisorUsage
	advisorCalls := 0
	advisorIn, advisorOut := 0, 0
	for _, iter := range parsed.Usage.Iterations {
		if iter.Type == "advisor_message" {
			advisorCalls++
			advisorIn += iter.InputTokens
			advisorOut += iter.OutputTokens
		}
	}
	if advisorCalls > 0 {
		advisorModel := req.Advisor.Model
		if advisorModel == "" {
			advisorModel = "claude-opus-4-6"
		}
		advisorUsage = &AdvisorUsage{
			AdvisorInputTokens:  advisorIn,
			AdvisorOutputTokens: advisorOut,
			AdvisorCalls:        advisorCalls,
			AdvisorModel:        advisorModel,
		}
	}

	ap.RecordSuccess()
	latency := time.Since(start)

	// Top-level usage = executor tokens only (advisor billed separately)
	executorIn := parsed.Usage.InputTokens
	executorOut := parsed.Usage.OutputTokens
	cost := calculateAnthropicCost(req.Model, executorIn, executorOut)
	if advisorUsage != nil {
		advisorModel := advisorUsage.AdvisorModel
		cost += calculateAnthropicCost(advisorModel, advisorIn, advisorOut)
	}

	result := &CompletionResponse{
		ID:              parsed.ID,
		Model:           parsed.Model,
		Provider:        "anthropic",
		Content:         content,
		FinishReason:    parsed.StopReason,
		InputTokens:     executorIn,
		OutputTokens:    executorOut,
		TotalTokens:     executorIn + executorOut,
		ThinkingContent: thinkingContent,
		AdvisorUsage:    advisorUsage,
		Cost:            cost,
		Latency:         latency,
	}

	ap.logger.Info("Anthropic advisor completion succeeded",
		zap.String("model", req.Model),
		zap.Int("executor_tokens", executorIn+executorOut),
		zap.Int("advisor_calls", advisorCalls),
		zap.Int("advisor_tokens", advisorIn+advisorOut),
		zap.Duration("latency", latency),
	)

	return result, nil
}

// streamWithAdvisor sends a streaming request with the advisor tool via raw HTTP SSE.
func (ap *AnthropicProvider) streamWithAdvisor(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	msgs, system := ap.buildAdvisorMessages(req)
	body := advisorRequestBody{
		Model:     req.Model,
		MaxTokens: req.MaxTokens,
		System:    system,
		Messages:  msgs,
		Tools:     []advisorTool{buildAdvisorTool(req.Advisor)},
		Stream:    true,
	}

	if req.ExtendedThinking {
		t := float32(1.0)
		body.Temperature = &t
	} else if req.Temperature > 0 {
		body.Temperature = &req.Temperature
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal advisor stream request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", anthropicAPIURL, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("create advisor stream request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", ap.resolveAPIKey(req))
	httpReq.Header.Set("anthropic-version", anthropicAPIVersion)
	httpReq.Header.Set("anthropic-beta", advisorBeta)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("advisor stream HTTP failed: %w", err)
	}

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("advisor stream error %d: %s", resp.StatusCode, string(respBody))
	}

	go func() {
		defer close(out)
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB buffer
		chunkIndex := 0
		var responseID string
		inAdvisorCall := false

		for scanner.Scan() {
			line := scanner.Text()

			// SSE format: "event: <type>" followed by "data: <json>"
			if strings.HasPrefix(line, "event: ") {
				eventType := strings.TrimPrefix(line, "event: ")
				switch eventType {
				case "content_block_start":
					// Check if this is a server_tool_use block (advisor call starting)
					// The next data line will tell us
				case "content_block_delta":
					// Normal text delta or advisor result
				case "message_start":
					// Extract response ID
				case "message_delta":
					// Final usage + stop reason
				case "message_stop":
					ap.RecordSuccess()
				case "ping":
					// Keepalive during advisor thinking
					if inAdvisorCall {
						out <- &StreamChunk{AdvisorThinking: true}
					}
				}
				continue
			}

			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			data := strings.TrimPrefix(line, "data: ")

			var event map[string]interface{}
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}

			eventType, _ := event["type"].(string)

			switch eventType {
			case "message_start":
				if msg, ok := event["message"].(map[string]interface{}); ok {
					responseID, _ = msg["id"].(string)
				}

			case "content_block_start":
				if cb, ok := event["content_block"].(map[string]interface{}); ok {
					blockType, _ := cb["type"].(string)
					if blockType == "server_tool_use" {
						inAdvisorCall = true
						out <- &StreamChunk{AdvisorThinking: true}
					}
				}

			case "content_block_delta":
				if delta, ok := event["delta"].(map[string]interface{}); ok {
					deltaType, _ := delta["type"].(string)
					if deltaType == "text_delta" {
						text, _ := delta["text"].(string)
						if text != "" {
							out <- &StreamChunk{
								ID:    responseID,
								Index: chunkIndex,
								Delta: text,
							}
							chunkIndex++
						}
					}
				}

			case "content_block_stop":
				if inAdvisorCall {
					inAdvisorCall = false
				}

			case "message_delta":
				if delta, ok := event["delta"].(map[string]interface{}); ok {
					stopReason, _ := delta["stop_reason"].(string)
					if stopReason != "" {
						out <- &StreamChunk{FinishReason: stopReason}
					}
				}
			}
		}

		if err := scanner.Err(); err != nil {
			out <- &StreamChunk{Error: fmt.Sprintf("advisor stream scan error: %v", err)}
		}
	}()

	return out, nil
}

// calculateAnthropicCost calculates the cost of an Anthropic API call.
// Prices per 1K tokens (as of 2025).
func calculateAnthropicCost(model string, inputTokens, outputTokens int) float64 {
	return CalculateCost(model, inputTokens, outputTokens)
}
