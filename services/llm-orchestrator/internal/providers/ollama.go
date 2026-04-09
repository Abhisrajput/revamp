package providers

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sashabaranov/go-openai"
	"go.uber.org/zap"
)

// OllamaProvider implements the LLMProvider interface for Ollama.
// Ollama exposes an OpenAI-compatible API at /v1/, so we reuse the
// go-openai SDK with a custom base URL and dummy auth token.
type OllamaProvider struct {
	*BaseProvider
	client   *openai.Client
	logger   *zap.Logger
	endpoint string
}

// NewOllamaProvider creates a new Ollama provider.
// endpoint is the Ollama server URL, e.g. "http://localhost:11434"
func NewOllamaProvider(endpoint string, models []string, logger *zap.Logger) *OllamaProvider {
	// Ollama's OpenAI-compatible endpoint is at /v1
	baseURL := strings.TrimRight(endpoint, "/") + "/v1"

	cfg := openai.DefaultConfig("ollama") // dummy key — Ollama needs no auth
	cfg.BaseURL = baseURL
	cfg.HTTPClient = &http.Client{Timeout: 10 * time.Minute} // Qwen3 MoE needs long timeouts for thinking

	client := openai.NewClientWithConfig(cfg)

	return &OllamaProvider{
		BaseProvider: NewBaseProvider("ollama", models),
		client:       client,
		logger:       logger,
		endpoint:     endpoint,
	}
}

// IsAvailable checks if the Ollama provider is available
func (op *OllamaProvider) IsAvailable() bool {
	return op.client != nil
}

// SupportsModel checks if Ollama has the requested model.
// Ollama is flexible — it accepts any model name it has pulled.
// We also accept any model string that isn't clearly from another provider.
func (op *OllamaProvider) SupportsModel(model string) bool {
	// Check explicit model list first
	for _, m := range op.GetModels() {
		if m == model {
			return true
		}
	}
	return false
}

// Complete sends a completion request to Ollama via its OpenAI-compatible API
func (op *OllamaProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	messages := make([]openai.ChatCompletionMessage, len(req.Messages))
	for i, msg := range req.Messages {
		messages[i] = openai.ChatCompletionMessage{
			Role:    msg.Role,
			Content: msg.Content,
		}
	}

	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 4096
	}

	request := openai.ChatCompletionRequest{
		Model:       req.Model,
		Messages:    messages,
		MaxTokens:   maxTokens,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stream:      false,
	}

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	response, err := op.client.CreateChatCompletion(ctx, request)
	if err != nil {
		op.RecordError(err)
		op.logger.Error("Ollama completion failed",
			zap.Error(err),
			zap.String("model", req.Model),
			zap.String("endpoint", op.endpoint),
			zap.Duration("latency", time.Since(start)),
		)
		return &CompletionResponse{
			Provider: "ollama",
			Model:    req.Model,
			Error:    err.Error(),
			Latency:  time.Since(start),
		}, err
	}

	op.RecordSuccess()
	latency := time.Since(start)

	content := ""
	if len(response.Choices) > 0 {
		content = response.Choices[0].Message.Content
	}

	result := &CompletionResponse{
		ID:           response.ID,
		Model:        response.Model,
		Provider:     "ollama",
		Content:      content,
		FinishReason: "stop",
		InputTokens:  response.Usage.PromptTokens,
		OutputTokens: response.Usage.CompletionTokens,
		TotalTokens:  response.Usage.TotalTokens,
		Cost:         0, // Ollama is free / self-hosted
		Latency:      latency,
	}

	if len(response.Choices) > 0 && response.Choices[0].FinishReason != "" {
		result.FinishReason = string(response.Choices[0].FinishReason)
	}

	op.logger.Debug("Ollama completion succeeded",
		zap.String("model", req.Model),
		zap.Int("input_tokens", result.InputTokens),
		zap.Int("output_tokens", result.OutputTokens),
		zap.Duration("latency", latency),
	)

	return result, nil
}

// Stream sends a streaming completion request to Ollama
func (op *OllamaProvider) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	messages := make([]openai.ChatCompletionMessage, len(req.Messages))
	for i, msg := range req.Messages {
		messages[i] = openai.ChatCompletionMessage{
			Role:    msg.Role,
			Content: msg.Content,
		}
	}

	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 4096
	}

	request := openai.ChatCompletionRequest{
		Model:       req.Model,
		Messages:    messages,
		MaxTokens:   maxTokens,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stream:      true,
	}

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	go func() {
		defer close(out)
		stream, err := op.client.CreateChatCompletionStream(ctx, request)
		if err != nil {
			op.RecordError(err)
			out <- &StreamChunk{
				Error: fmt.Sprintf("ollama stream setup failed: %v", err),
			}
			return
		}
		defer stream.Close()

		for {
			response, err := stream.Recv()
			if err == io.EOF {
				op.RecordSuccess()
				out <- &StreamChunk{
					FinishReason: "stop",
				}
				return
			}
			if err != nil {
				op.RecordError(err)
				out <- &StreamChunk{
					Error: fmt.Sprintf("ollama stream error: %v", err),
				}
				return
			}

			if len(response.Choices) > 0 {
				chunk := &StreamChunk{
					ID:    response.ID,
					Index: response.Choices[0].Index,
					Delta: response.Choices[0].Delta.Content,
				}
				if response.Choices[0].FinishReason != "" {
					chunk.FinishReason = string(response.Choices[0].FinishReason)
				}
				out <- chunk
			}
		}
	}()

	return out, nil
}
