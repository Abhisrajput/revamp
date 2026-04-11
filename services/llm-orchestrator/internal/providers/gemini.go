package providers

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"google.golang.org/genai"
	"go.uber.org/zap"
)

// GeminiProvider implements the LLMProvider interface for Google Gemini
type GeminiProvider struct {
	*BaseProvider
	client     *genai.Client
	clientOnce sync.Once
	clientErr  error
	logger     *zap.Logger
	projectID  string
	apiKey     string
}

// NewGeminiProvider creates a new Gemini provider.
// When using Google AI via OpenAI-compatible mode, the base URL needs
// "/openai" path appended if not already present. This normalizes the URL.
func NewGeminiProvider(apiKey, projectID string, logger *zap.Logger) *GeminiProvider {
	models := []string{
		"gemini-2.0-flash",
		"gemini-1.5-pro",
		"gemini-1.5-flash",
	}
	return &GeminiProvider{
		BaseProvider: NewBaseProvider("gemini", models),
		logger:       logger,
		projectID:    projectID,
		apiKey:       apiKey,
	}
}

// normalizeGoogleAIBaseURL ensures the Google AI base URL includes the
// /openai path when using OpenAI-compatible mode.
// E.g., "https://generativelanguage.googleapis.com/v1beta" becomes
// "https://generativelanguage.googleapis.com/v1beta/openai"
func normalizeGoogleAIBaseURL(baseURL string) string {
	if baseURL == "" {
		return baseURL
	}
	trimmed := strings.TrimRight(baseURL, "/")
	if !strings.HasSuffix(trimmed, "/openai") {
		return trimmed + "/openai"
	}
	return trimmed
}

// IsAvailable checks if the Gemini provider is available
func (gp *GeminiProvider) IsAvailable() bool {
	return gp.projectID != ""
}

// SupportsModel checks if Gemini supports a specific model
func (gp *GeminiProvider) SupportsModel(model string) bool {
	for _, m := range gp.GetModels() {
		if m == model {
			return true
		}
	}
	return false
}

// Complete sends a completion request to Gemini
func (gp *GeminiProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	// Set timeout if provided
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	// Thread-safe lazy initialization of Gemini client
	gp.clientOnce.Do(func() {
		gp.client, gp.clientErr = genai.NewClient(ctx, &genai.ClientConfig{
			Project: gp.projectID,
		})
	})
	if gp.clientErr != nil {
		gp.RecordError(gp.clientErr)
		return &CompletionResponse{
			Provider: "gemini",
			Model:    req.Model,
			Error:    gp.clientErr.Error(),
			Latency:  time.Since(start),
		}, gp.clientErr
	}

	// Build content for Gemini
	contents, systemContent := gp.buildContents(req)

	// Build generation config
	maxTokens := int64(req.MaxTokens)
	temp := float64(req.Temperature)
	topP := float64(req.TopP)
	config := &genai.GenerateContentConfig{
		MaxOutputTokens: &maxTokens,
		Temperature:     &temp,
		TopP:            &topP,
	}
	if systemContent != nil {
		config.SystemInstruction = systemContent
	}

	// Generate content
	response, err := gp.client.Models.GenerateContent(ctx, req.Model, contents, config)
	if err != nil {
		gp.RecordError(err)
		gp.logger.Error("Gemini completion failed",
			zap.Error(err),
			zap.String("model", req.Model),
			zap.Duration("latency", time.Since(start)),
		)
		return &CompletionResponse{
			Provider: "gemini",
			Model:    req.Model,
			Error:    err.Error(),
			Latency:  time.Since(start),
		}, err
	}

	gp.RecordSuccess()
	latency := time.Since(start)

	// Extract content
	content := ""
	if text, err := response.Text(); err == nil {
		content = text
	}

	// Get usage metadata
	var inputTokens, outputTokens int
	if response.UsageMetadata != nil {
		if response.UsageMetadata.PromptTokenCount != nil {
			inputTokens = int(*response.UsageMetadata.PromptTokenCount)
		}
		if response.UsageMetadata.CandidatesTokenCount != nil {
			outputTokens = int(*response.UsageMetadata.CandidatesTokenCount)
		}
	}
	cost := calculateGeminiCost(req.Model, inputTokens, outputTokens)

	finishReason := ""
	if len(response.Candidates) > 0 {
		finishReason = string(response.Candidates[0].FinishReason)
	}

	result := &CompletionResponse{
		ID:           fmt.Sprintf("gemini-%d", time.Now().UnixNano()),
		Model:        req.Model,
		Provider:     "gemini",
		Content:      content,
		FinishReason: finishReason,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		TotalTokens:  inputTokens + outputTokens,
		Cost:         cost,
		Latency:      latency,
	}

	gp.logger.Debug("Gemini completion succeeded",
		zap.String("model", req.Model),
		zap.Int("input_tokens", inputTokens),
		zap.Int("output_tokens", outputTokens),
		zap.Duration("latency", latency),
	)

	return result, nil
}

// Stream sends a streaming completion request to Gemini
func (gp *GeminiProvider) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	// Set timeout if provided
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	go func() {
		defer close(out)

		// Thread-safe lazy initialization of Gemini client
		gp.clientOnce.Do(func() {
			gp.client, gp.clientErr = genai.NewClient(ctx, &genai.ClientConfig{
				Project: gp.projectID,
			})
		})
		if gp.clientErr != nil {
			gp.RecordError(gp.clientErr)
			out <- &StreamChunk{
				Error: fmt.Sprintf("client init failed: %v", gp.clientErr),
			}
			return
		}

		// Build content for Gemini
		contents, systemContent := gp.buildContents(req)

		// Build generation config
		maxTokens := int64(req.MaxTokens)
		temp := float64(req.Temperature)
		topP := float64(req.TopP)
		config := &genai.GenerateContentConfig{
			MaxOutputTokens: &maxTokens,
			Temperature:     &temp,
			TopP:            &topP,
		}
		if systemContent != nil {
			config.SystemInstruction = systemContent
		}

		// Stream content using iter.Seq2
		chunkIndex := 0
		for resp, err := range gp.client.Models.GenerateContentStream(ctx, req.Model, contents, config) {
			if err != nil {
				gp.RecordError(err)
				out <- &StreamChunk{
					Error: fmt.Sprintf("stream error: %v", err),
				}
				return
			}

			if text, textErr := resp.Text(); textErr == nil && text != "" {
				out <- &StreamChunk{
					ID:    fmt.Sprintf("gemini-%d", time.Now().UnixNano()),
					Index: chunkIndex,
					Delta: text,
				}
				chunkIndex++
			}
		}

		gp.RecordSuccess()
		out <- &StreamChunk{
			FinishReason: "stop",
		}
	}()

	return out, nil
}

// buildContents converts messages to Gemini Content format, separating system instructions
func (gp *GeminiProvider) buildContents(req *CompletionRequest) ([]*genai.Content, *genai.Content) {
	contents := make([]*genai.Content, 0, len(req.Messages))
	var systemContent *genai.Content

	for _, msg := range req.Messages {
		if msg.Role == "system" {
			// Gemini uses SystemInstruction in config
			systemContent = &genai.Content{
				Parts: []*genai.Part{genai.NewPartFromText(msg.Content)},
			}
			continue
		}

		role := msg.Role
		if role == "assistant" {
			role = "model" // Gemini uses "model" instead of "assistant"
		}

		contents = append(contents, &genai.Content{
			Role:  role,
			Parts: []*genai.Part{genai.NewPartFromText(msg.Content)},
		})
	}

	return contents, systemContent
}

// calculateGeminiCost calculates the cost of a Gemini API call
func calculateGeminiCost(model string, inputTokens, outputTokens int) float64 {
	var inputCost, outputCost float64

	switch model {
	case "gemini-2.0-flash":
		inputCost = 0.075 / 1000000 // per token
		outputCost = 0.30 / 1000000 // per token
	case "gemini-1.5-pro":
		inputCost = 1.25 / 1000000
		outputCost = 5.0 / 1000000
	case "gemini-1.5-flash":
		inputCost = 0.075 / 1000000
		outputCost = 0.30 / 1000000
	default:
		return 0
	}

	return float64(inputTokens)*inputCost + float64(outputTokens)*outputCost
}
