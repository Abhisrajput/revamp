package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awscreds "github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/bedrock"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	brdocument "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	"go.uber.org/zap"
)

// BedrockProvider implements the LLMProvider interface for AWS Bedrock
type BedrockProvider struct {
	*BaseProvider
	client        *bedrockruntime.Client
	bedrockClient *bedrock.Client
	logger        *zap.Logger
}

// NewBedrockProvider creates a new Bedrock provider
func NewBedrockProvider(client *bedrockruntime.Client, bedrockClient *bedrock.Client, logger *zap.Logger) *BedrockProvider {
	models := []string{
		// Claude 4.6 (cross-region inference)
		"us.anthropic.claude-sonnet-4-6-20251001-v1:0",
		"us.anthropic.claude-opus-4-6-20251001-v1:0",
		"us.anthropic.claude-haiku-4-6-20251001-v1:0",
		// Claude 4.5 (cross-region inference)
		"us.anthropic.claude-sonnet-4-5-20251001-v1:0",
		"us.anthropic.claude-opus-4-5-20251001-v1:0",
		"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		// Claude 3.7 / 3.5 (cross-region inference)
		"us.anthropic.claude-3-7-sonnet-20250219-v1:0",
		"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
		"us.anthropic.claude-3-5-haiku-20241022-v1:0",
		// Claude 3 (classic)
		"anthropic.claude-3-opus-20240229-v1:0",
		"anthropic.claude-3-sonnet-20240229-v1:0",
		"anthropic.claude-3-haiku-20240307-v1:0",
		// Meta Llama
		"meta.llama3-70b-instruct-v1:0",
		"meta.llama3-8b-instruct-v1:0",
	}
	return &BedrockProvider{
		BaseProvider:  NewBaseProvider("bedrock", models),
		client:        client,
		bedrockClient: bedrockClient,
		logger:        logger,
	}
}

// NewBedrockProviderWithCreds creates an ephemeral Bedrock provider with explicit credentials (BYOK).
func NewBedrockProviderWithCreds(accessKeyID, secretKey, sessionToken, region string, logger *zap.Logger) (*BedrockProvider, error) {
	ctx := context.Background()
	creds := awscreds.NewStaticCredentialsProvider(accessKeyID, secretKey, sessionToken)

	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(creds),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create AWS config: %w", err)
	}

	p := NewBedrockProvider(
		bedrockruntime.NewFromConfig(cfg),
		bedrock.NewFromConfig(cfg),
		logger,
	)
	return p, nil
}

// IsAvailable checks if the Bedrock provider is available
func (bp *BedrockProvider) IsAvailable() bool {
	return bp.client != nil
}

// SupportsModel checks if Bedrock supports a specific model
func (bp *BedrockProvider) SupportsModel(model string) bool {
	for _, m := range bp.GetModels() {
		if m == model {
			return true
		}
	}
	return false
}

// Complete sends a completion request to Bedrock.
// Uses the Converse API when tools are provided, InvokeModel otherwise.
func (bp *BedrockProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	// If tools are provided, use the Converse API for native tool calling
	if len(req.Tools) > 0 {
		return bp.completeWithConverse(ctx, req)
	}
	return bp.completeWithInvokeModel(ctx, req)
}

// completeWithInvokeModel uses the legacy InvokeModel API (no tool support)
func (bp *BedrockProvider) completeWithInvokeModel(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	payload := buildBedrockPayload(req)
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		bp.RecordError(err)
		return &CompletionResponse{Provider: "bedrock", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	response, err := bp.client.InvokeModel(ctx, &bedrockruntime.InvokeModelInput{
		ModelId: &req.Model, Body: payloadBytes,
		ContentType: stringPtr("application/json"), Accept: stringPtr("application/json"),
	})
	if err != nil {
		bp.RecordError(err)
		bp.logger.Error("Bedrock InvokeModel failed", zap.Error(err), zap.String("model", req.Model))
		return &CompletionResponse{Provider: "bedrock", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	bp.RecordSuccess()
	latency := time.Since(start)
	content, inputTokens, outputTokens := parseBedrockResponse(response.Body, req.Model)
	cost := calculateBedrockCost(req.Model, inputTokens, outputTokens)

	return &CompletionResponse{
		ID: fmt.Sprintf("bedrock-%d", time.Now().UnixNano()), Model: req.Model, Provider: "bedrock",
		Content: content, FinishReason: "stop",
		InputTokens: inputTokens, OutputTokens: outputTokens, TotalTokens: inputTokens + outputTokens,
		Cost: cost, Latency: latency,
	}, nil
}

// completeWithConverse uses the Bedrock Converse API with native tool calling.
func (bp *BedrockProvider) completeWithConverse(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	// Build Converse messages
	var converseMessages []types.Message
	var systemPrompts []types.SystemContentBlock

	for _, msg := range req.Messages {
		if msg.Role == "system" {
			systemPrompts = append(systemPrompts, &types.SystemContentBlockMemberText{Value: msg.Content})
			continue
		}

		role := types.ConversationRoleUser
		if msg.Role == "assistant" {
			role = types.ConversationRoleAssistant
		}

		converseMessages = append(converseMessages, types.Message{
			Role:    role,
			Content: []types.ContentBlock{&types.ContentBlockMemberText{Value: msg.Content}},
		})
	}

	// Build tool config
	var toolConfig *types.ToolConfiguration
	if len(req.Tools) > 0 {
		var toolDefs []types.Tool
		for _, t := range req.Tools {
			// Convert InputSchema to a Go map for the Smithy document
			var schemaMap map[string]interface{}
			schemaBytes, _ := json.Marshal(t.InputSchema)
			json.Unmarshal(schemaBytes, &schemaMap)

			toolDefs = append(toolDefs, &types.ToolMemberToolSpec{
				Value: types.ToolSpecification{
					Name:        stringPtr(t.Name),
					Description: stringPtr(t.Description),
					InputSchema: &types.ToolInputSchemaMemberJson{Value: brdocument.NewLazyDocument(schemaMap)},
				},
			})
		}
		toolConfig = &types.ToolConfiguration{Tools: toolDefs}
	}

	// Build Converse input
	input := &bedrockruntime.ConverseInput{
		ModelId:  &req.Model,
		Messages: converseMessages,
		InferenceConfig: &types.InferenceConfiguration{
			MaxTokens:   int32Ptr(int32(req.MaxTokens)),
		},
	}

	if len(systemPrompts) > 0 {
		input.System = systemPrompts
	}
	if toolConfig != nil {
		input.ToolConfig = toolConfig
	}

	// Only set temperature if > 0 (Bedrock rejects temp+top_p together)
	if req.Temperature > 0 {
		input.InferenceConfig.Temperature = float32Ptr(req.Temperature)
	}

	// Call Converse API
	response, err := bp.client.Converse(ctx, input)
	if err != nil {
		bp.RecordError(err)
		bp.logger.Error("Bedrock Converse failed", zap.Error(err), zap.String("model", req.Model))
		return &CompletionResponse{Provider: "bedrock", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	bp.RecordSuccess()
	latency := time.Since(start)

	// Parse Converse response
	result := &CompletionResponse{
		ID:       fmt.Sprintf("bedrock-%d", time.Now().UnixNano()),
		Model:    req.Model,
		Provider: "bedrock",
		Latency:  latency,
	}

	// Extract stop reason
	switch response.StopReason {
	case types.StopReasonToolUse:
		result.FinishReason = "tool_use"
	case types.StopReasonEndTurn:
		result.FinishReason = "end_turn"
	case types.StopReasonMaxTokens:
		result.FinishReason = "max_tokens"
	default:
		result.FinishReason = string(response.StopReason)
	}

	// Parse output content blocks
	if response.Output != nil {
		if msgOutput, ok := response.Output.(*types.ConverseOutputMemberMessage); ok {
			for _, block := range msgOutput.Value.Content {
				switch b := block.(type) {
				case *types.ContentBlockMemberText:
					result.Content += b.Value
				case *types.ContentBlockMemberToolUse:
					// Parse tool input from Smithy document
					var toolInput interface{}
					if b.Value.Input != nil {
						b.Value.Input.UnmarshalSmithyDocument(&toolInput)
					}
					result.ToolCalls = append(result.ToolCalls, ToolCall{
						ID:    *b.Value.ToolUseId,
						Name:  *b.Value.Name,
						Input: toolInput,
					})
				}
			}
		}
	}

	// Parse token usage
	if response.Usage != nil {
		if response.Usage.InputTokens != nil {
			result.InputTokens = int(*response.Usage.InputTokens)
		}
		if response.Usage.OutputTokens != nil {
			result.OutputTokens = int(*response.Usage.OutputTokens)
		}
		if response.Usage.TotalTokens != nil {
			result.TotalTokens = int(*response.Usage.TotalTokens)
		}
	}

	result.Cost = calculateBedrockCost(req.Model, result.InputTokens, result.OutputTokens)

	bp.logger.Debug("Bedrock Converse succeeded",
		zap.String("model", req.Model),
		zap.String("stop_reason", result.FinishReason),
		zap.Int("tool_calls", len(result.ToolCalls)),
		zap.Int("input_tokens", result.InputTokens),
		zap.Int("output_tokens", result.OutputTokens),
		zap.Duration("latency", latency),
	)

	return result, nil
}

func int32Ptr(v int32) *int32       { return &v }
func float32Ptr(v float32) *float32 { return &v }

// Stream sends a streaming completion request to Bedrock
func (bp *BedrockProvider) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	// Set timeout if provided
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		_ = cancel // Prevent leak detection
	}

	go func() {
		defer close(out)

		// Build Bedrock request payload
		payload := buildBedrockPayload(req)
		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			bp.RecordError(err)
			out <- &StreamChunk{
				Error: fmt.Sprintf("payload encoding failed: %v", err),
			}
			return
		}

		// Call Bedrock InvokeModelWithResponseStream API
		response, err := bp.client.InvokeModelWithResponseStream(ctx, &bedrockruntime.InvokeModelWithResponseStreamInput{
			ModelId:     &req.Model,
			Body:        payloadBytes,
			ContentType: stringPtr("application/json"),
		})
		if err != nil {
			bp.RecordError(err)
			out <- &StreamChunk{
				Error: fmt.Sprintf("stream setup failed: %v", err),
			}
			return
		}

		chunkIndex := 0
		stream := response.GetStream()
		defer stream.Close()

		for event := range stream.Events() {
			if chunk, ok := event.(*types.ResponseStreamMemberChunk); ok {
				var payload map[string]interface{}
				if err := json.Unmarshal(chunk.Value.Bytes, &payload); err != nil {
					continue
				}

				// Extract delta/text based on model
				if delta, ok := payload["delta"].(map[string]interface{}); ok {
					if text, ok := delta["text"].(string); ok {
						out <- &StreamChunk{
							ID:    fmt.Sprintf("bedrock-%d", time.Now().UnixNano()),
							Index: chunkIndex,
							Delta: text,
						}
						chunkIndex++
					}
				}
			}
		}

		if err := stream.Err(); err != nil {
			bp.RecordError(err)
			out <- &StreamChunk{
				Error: fmt.Sprintf("stream error: %v", err),
			}
			return
		}

		bp.RecordSuccess()
		out <- &StreamChunk{
			FinishReason: "stop",
		}
	}()

	return out, nil
}

// buildBedrockPayload builds the request payload for Bedrock
func buildBedrockPayload(req *CompletionRequest) map[string]interface{} {
	// Convert messages to Bedrock format
	messages := make([]map[string]interface{}, 0)
	var systemPrompt string
	for _, msg := range req.Messages {
		if msg.Role == "system" {
			systemPrompt = msg.Content
		} else {
			messages = append(messages, map[string]interface{}{
				"role": msg.Role,
				"content": []map[string]interface{}{
					{"type": "text", "text": msg.Content},
				},
			})
		}
	}

	payload := map[string]interface{}{
		"anthropic_version": "bedrock-2023-05-31",
		"messages":          messages,
		"max_tokens":        req.MaxTokens,
	}

	// Bedrock Claude does not allow both temperature and top_p simultaneously
	if req.Temperature > 0 {
		payload["temperature"] = req.Temperature
	} else if req.TopP > 0 {
		payload["top_p"] = req.TopP
	}

	if systemPrompt != "" {
		payload["system"] = systemPrompt
	}

	return payload
}

// parseBedrockResponse parses the response from Bedrock
func parseBedrockResponse(body []byte, model string) (string, int, int) {
	var response map[string]interface{}
	if err := json.Unmarshal(body, &response); err != nil {
		return "", 0, 0
	}

	content := ""
	inputTokens := 0
	outputTokens := 0

	// Extract content
	if content_arr, ok := response["content"].([]interface{}); ok && len(content_arr) > 0 {
		if contentBlock, ok := content_arr[0].(map[string]interface{}); ok {
			if text, ok := contentBlock["text"].(string); ok {
				content = text
			}
		}
	}

	// Extract token counts
	if usage, ok := response["usage"].(map[string]interface{}); ok {
		if input, ok := usage["input_tokens"].(float64); ok {
			inputTokens = int(input)
		}
		if output, ok := usage["output_tokens"].(float64); ok {
			outputTokens = int(output)
		}
	}

	return content, inputTokens, outputTokens
}

// calculateBedrockCost calculates the cost of a Bedrock API call
func calculateBedrockCost(model string, inputTokens, outputTokens int) float64 {
	var inputCost, outputCost float64

	switch model {
	// Claude 4.6
	case "us.anthropic.claude-sonnet-4-6-20251001-v1:0":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "us.anthropic.claude-opus-4-6-20251001-v1:0":
		inputCost = 0.015 / 1000
		outputCost = 0.075 / 1000
	case "us.anthropic.claude-haiku-4-6-20251001-v1:0":
		inputCost = 0.0008 / 1000
		outputCost = 0.004 / 1000
	// Claude 4.5
	case "us.anthropic.claude-sonnet-4-5-20251001-v1:0":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "us.anthropic.claude-opus-4-5-20251001-v1:0":
		inputCost = 0.015 / 1000
		outputCost = 0.075 / 1000
	case "us.anthropic.claude-haiku-4-5-20251001-v1:0":
		inputCost = 0.0008 / 1000
		outputCost = 0.004 / 1000
	// Claude 3.7 / 3.5
	case "us.anthropic.claude-3-7-sonnet-20250219-v1:0":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "us.anthropic.claude-3-5-sonnet-20241022-v2:0":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "us.anthropic.claude-3-5-haiku-20241022-v1:0":
		inputCost = 0.0008 / 1000
		outputCost = 0.004 / 1000
	// Claude 3 classic
	case "anthropic.claude-3-opus-20240229-v1:0":
		inputCost = 0.015 / 1000
		outputCost = 0.075 / 1000
	case "anthropic.claude-3-sonnet-20240229-v1:0":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "anthropic.claude-3-haiku-20240307-v1:0":
		inputCost = 0.00025 / 1000
		outputCost = 0.00125 / 1000
	// Meta Llama
	case "meta.llama3-70b-instruct-v1:0":
		inputCost = 0.00495 / 1000
		outputCost = 0.0066 / 1000
	case "meta.llama3-8b-instruct-v1:0":
		inputCost = 0.0006 / 1000
		outputCost = 0.0008 / 1000
	default:
		return 0
	}

	return float64(inputTokens)*inputCost + float64(outputTokens)*outputCost
}

// stringPtr returns a pointer to a string
func stringPtr(s string) *string {
	return &s
}
