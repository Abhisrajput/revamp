package providers

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/genai"
)

// VertexAIProvider implements the LLMProvider interface for Google Vertex AI.
// Reuses the Gemini SDK (google.golang.org/genai) with Backend: genai.BackendVertexAI.
// Supports three auth modes:
//   - Application Default Credentials (ADC) — for GKE/Cloud Run/local gcloud
//   - Service Account JSON key — for BYOK
//   - OAuth2 Access Token — for short-lived BYOK
type VertexAIProvider struct {
	*BaseProvider
	client             *genai.Client
	clientOnce         sync.Once
	clientErr          error
	logger             *zap.Logger
	projectID          string
	location           string
	serviceAccountJSON string // JSON key content (BYOK)
	accessToken        string // short-lived OAuth2 token (BYOK)
}

// NewVertexAIProvider creates a Vertex AI provider using Application Default Credentials.
// ADC auto-discovers credentials from: gcloud CLI, GKE workload identity, env vars, etc.
func NewVertexAIProvider(projectID, location string, logger *zap.Logger) *VertexAIProvider {
	if location == "" {
		location = "us-central1"
	}
	models := vertexAIModels()
	return &VertexAIProvider{
		BaseProvider: NewBaseProvider("vertexai", models),
		logger:       logger,
		projectID:    projectID,
		location:     location,
	}
}

// NewVertexAIProviderWithServiceAccount creates a Vertex AI provider with an explicit
// service account JSON key (BYOK). The key is passed as a string, not a file path.
func NewVertexAIProviderWithServiceAccount(projectID, location, saJSON string, logger *zap.Logger) *VertexAIProvider {
	if location == "" {
		location = "us-central1"
	}
	models := vertexAIModels()
	return &VertexAIProvider{
		BaseProvider:       NewBaseProvider("vertexai", models),
		logger:             logger,
		projectID:          projectID,
		location:           location,
		serviceAccountJSON: saJSON,
	}
}

// NewVertexAIProviderWithAccessToken creates a Vertex AI provider with a short-lived
// OAuth2 access token (from `gcloud auth print-access-token`). Typically valid for 1 hour.
func NewVertexAIProviderWithAccessToken(projectID, location, accessToken string, logger *zap.Logger) *VertexAIProvider {
	if location == "" {
		location = "us-central1"
	}
	models := vertexAIModels()
	return &VertexAIProvider{
		BaseProvider: NewBaseProvider("vertexai", models),
		logger:       logger,
		projectID:    projectID,
		location:     location,
		accessToken:  accessToken,
	}
}

func vertexAIModels() []string {
	return []string{
		"gemini-2.5-pro",
		"gemini-2.5-flash",
		"gemini-2.0-flash",
		"gemini-1.5-pro",
		"gemini-1.5-flash",
	}
}

// IsAvailable checks if the Vertex AI provider is available
func (vp *VertexAIProvider) IsAvailable() bool {
	return vp.projectID != ""
}

// SupportsModel checks if Vertex AI supports a specific model
func (vp *VertexAIProvider) SupportsModel(model string) bool {
	for _, m := range vp.GetModels() {
		if m == model {
			return true
		}
	}
	return false
}

// initClient lazily initializes the Vertex AI client with appropriate credentials.
// Thread-safe via sync.Once — concurrent requests share a single client instance.
func (vp *VertexAIProvider) initClient(ctx context.Context) error {
	vp.clientOnce.Do(func() {
		clientConfig := &genai.ClientConfig{
			Project:  vp.projectID,
			Location: vp.location,
			Backend:  genai.BackendVertexAI,
		}

		// Set credentials based on auth mode
		if vp.serviceAccountJSON != "" {
			creds, err := google.CredentialsFromJSON(ctx, []byte(vp.serviceAccountJSON),
				"https://www.googleapis.com/auth/cloud-platform",
			)
			if err != nil {
				vp.clientErr = fmt.Errorf("failed to parse service account JSON: %w", err)
				return
			}
			clientConfig.Credentials = creds
		} else if vp.accessToken != "" {
			// Wrap the static access token in a google.Credentials via a TokenSource
			ts := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: vp.accessToken})
			clientConfig.Credentials = &google.Credentials{TokenSource: ts}
		}
		// If neither is set, the SDK uses Application Default Credentials (ADC)

		client, err := genai.NewClient(ctx, clientConfig)
		if err != nil {
			vp.clientErr = fmt.Errorf("failed to create Vertex AI client: %w", err)
			return
		}

		vp.client = client
	})
	return vp.clientErr
}

// Complete sends a completion request to Vertex AI
func (vp *VertexAIProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	if err := vp.initClient(ctx); err != nil {
		vp.RecordError(err)
		return &CompletionResponse{Provider: "vertexai", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	contents, systemContent := buildGeminiContents(req)

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

	response, err := vp.client.Models.GenerateContent(ctx, req.Model, contents, config)
	if err != nil {
		vp.RecordError(err)
		vp.logger.Error("Vertex AI completion failed", zap.Error(err), zap.String("model", req.Model))
		return &CompletionResponse{Provider: "vertexai", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	vp.RecordSuccess()
	latency := time.Since(start)

	content := ""
	if text, err := response.Text(); err == nil {
		content = text
	}

	var inputTokens, outputTokens int
	if response.UsageMetadata != nil {
		if response.UsageMetadata.PromptTokenCount != nil {
			inputTokens = int(*response.UsageMetadata.PromptTokenCount)
		}
		if response.UsageMetadata.CandidatesTokenCount != nil {
			outputTokens = int(*response.UsageMetadata.CandidatesTokenCount)
		}
	}
	cost := calculateVertexAICost(req.Model, inputTokens, outputTokens)

	finishReason := ""
	if len(response.Candidates) > 0 {
		finishReason = string(response.Candidates[0].FinishReason)
	}

	return &CompletionResponse{
		ID:           fmt.Sprintf("vertexai-%d", time.Now().UnixNano()),
		Model:        req.Model,
		Provider:     "vertexai",
		Content:      content,
		FinishReason: finishReason,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		TotalTokens:  inputTokens + outputTokens,
		Cost:         cost,
		Latency:      latency,
	}, nil
}

// Stream sends a streaming completion request to Vertex AI
func (vp *VertexAIProvider) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	go func() {
		defer close(out)

		if err := vp.initClient(ctx); err != nil {
			vp.RecordError(err)
			out <- &StreamChunk{Error: fmt.Sprintf("client init failed: %v", err)}
			return
		}

		contents, systemContent := buildGeminiContents(req)

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

		chunkIndex := 0
		for resp, err := range vp.client.Models.GenerateContentStream(ctx, req.Model, contents, config) {
			if err != nil {
				vp.RecordError(err)
				out <- &StreamChunk{Error: fmt.Sprintf("stream error: %v", err)}
				return
			}
			if text, textErr := resp.Text(); textErr == nil && text != "" {
				out <- &StreamChunk{
					ID:    fmt.Sprintf("vertexai-%d", time.Now().UnixNano()),
					Index: chunkIndex,
					Delta: text,
				}
				chunkIndex++
			}
		}

		vp.RecordSuccess()
		out <- &StreamChunk{FinishReason: "stop"}
	}()

	return out, nil
}

// buildGeminiContents converts messages to Gemini/Vertex AI Content format.
// Shared between GeminiProvider and VertexAIProvider.
func buildGeminiContents(req *CompletionRequest) ([]*genai.Content, *genai.Content) {
	contents := make([]*genai.Content, 0, len(req.Messages))
	var systemContent *genai.Content

	for _, msg := range req.Messages {
		if msg.Role == "system" {
			systemContent = &genai.Content{
				Parts: []*genai.Part{genai.NewPartFromText(msg.Content)},
			}
			continue
		}
		role := msg.Role
		if role == "assistant" {
			role = "model"
		}
		contents = append(contents, &genai.Content{
			Role:  role,
			Parts: []*genai.Part{genai.NewPartFromText(msg.Content)},
		})
	}

	return contents, systemContent
}

// calculateVertexAICost calculates the cost of a Vertex AI API call.
// Vertex AI pricing differs slightly from AI Studio (pay-per-use, no free tier in production).
func calculateVertexAICost(model string, inputTokens, outputTokens int) float64 {
	var inputCost, outputCost float64

	switch model {
	case "gemini-2.5-pro":
		inputCost = 1.25 / 1000000
		outputCost = 10.0 / 1000000
	case "gemini-2.5-flash":
		inputCost = 0.15 / 1000000
		outputCost = 0.60 / 1000000
	case "gemini-2.0-flash":
		inputCost = 0.075 / 1000000
		outputCost = 0.30 / 1000000
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
