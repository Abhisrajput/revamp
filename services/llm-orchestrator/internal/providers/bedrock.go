package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/bedrock"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
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
		"anthropic.claude-3-opus-20240229-v1:0",
		"anthropic.claude-3-sonnet-20240229-v1:0",
		"anthropic.claude-3-haiku-20240307-v1:0",
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

// Complete sends a completion request to Bedrock
func (bp *BedrockProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	// Set timeout if provided
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	// Build Bedrock request payload
	payload := buildBedrockPayload(req)
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		bp.RecordError(err)
		return &CompletionResponse{
			Provider: "bedrock",
			Model:    req.Model,
			Error:    err.Error(),
			Latency:  time.Since(start),
		}, err
	}

	// Call Bedrock InvokeModel API
	response, err := bp.client.InvokeModel(ctx, &bedrockruntime.InvokeModelInput{
		ModelId:     &req.Model,
		Body:        payloadBytes,
		ContentType: stringPtr("application/json"),
		Accept:      stringPtr("application/json"),
	})
	if err != nil {
		bp.RecordError(err)
		bp.logger.Error("Bedrock completion failed",
			zap.Error(err),
			zap.String("model", req.Model),
			zap.Duration("latency", time.Since(start)),
		)
		return &CompletionResponse{
			Provider: "bedrock",
			Model:    req.Model,
			Error:    err.Error(),
			Latency:  time.Since(start),
		}, err
	}

	bp.RecordSuccess()
	latency := time.Since(start)

	// Parse response
	content, inputTokens, outputTokens := parseBedrockResponse(response.Body, req.Model)
	cost := calculateBedrockCost(req.Model, inputTokens, outputTokens)

	result := &CompletionResponse{
		ID:           fmt.Sprintf("bedrock-%d", time.Now().UnixNano()),
		Model:        req.Model,
		Provider:     "bedrock",
		Content:      content,
		FinishReason: "stop",
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		TotalTokens:  inputTokens + outputTokens,
		Cost:         cost,
		Latency:      latency,
	}

	bp.logger.Debug("Bedrock completion succeeded",
		zap.String("model", req.Model),
		zap.Int("input_tokens", inputTokens),
		zap.Int("output_tokens", outputTokens),
		zap.Duration("latency", latency),
	)

	return result, nil
}

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
	for _, msg := range req.Messages {
		if msg.Role != "system" {
			messages = append(messages, map[string]interface{}{
				"role":    msg.Role,
				"content": msg.Content,
			})
		}
	}

	payload := map[string]interface{}{
		"messages":     messages,
		"max_tokens":   req.MaxTokens,
		"temperature":  req.Temperature,
		"top_p":        req.TopP,
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
	case "anthropic.claude-3-opus-20240229-v1:0":
		inputCost = 0.015 / 1000
		outputCost = 0.075 / 1000
	case "anthropic.claude-3-sonnet-20240229-v1:0":
		inputCost = 0.003 / 1000
		outputCost = 0.015 / 1000
	case "anthropic.claude-3-haiku-20240307-v1:0":
		inputCost = 0.00025 / 1000
		outputCost = 0.00125 / 1000
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
