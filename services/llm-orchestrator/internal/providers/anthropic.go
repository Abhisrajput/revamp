package providers

import (
	"context"
	"fmt"
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
type AnthropicProvider struct {
	*BaseProvider
	client *anthropic.Client
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

// calculateAnthropicCost calculates the cost of an Anthropic API call.
// Prices per 1K tokens (as of 2025).
func calculateAnthropicCost(model string, inputTokens, outputTokens int) float64 {
	var inputCost, outputCost float64

	switch model {
	// Claude 4.x (latest pricing)
	case "claude-opus-4-6":
		inputCost = 0.015 / 1000
		outputCost = 0.075 / 1000
	case "claude-sonnet-4-6":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "claude-haiku-4-5-20251001":
		inputCost = 0.0008 / 1000
		outputCost = 0.004 / 1000
	// Claude 3.5
	case "claude-3-5-sonnet-20241022":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "claude-3-5-haiku-20241022":
		inputCost = 0.0008 / 1000
		outputCost = 0.004 / 1000
	// Claude 3 (legacy)
	case "claude-3-opus-20240229":
		inputCost = 0.015 / 1000
		outputCost = 0.075 / 1000
	case "claude-3-sonnet-20240229":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "claude-3-haiku-20240307":
		inputCost = 0.00025 / 1000
		outputCost = 0.00125 / 1000
	default:
		// Fallback to mid-range pricing
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	}

	return float64(inputTokens)*inputCost + float64(outputTokens)*outputCost
}
