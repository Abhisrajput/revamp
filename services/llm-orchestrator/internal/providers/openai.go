package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/sashabaranov/go-openai"
	"go.uber.org/zap"
)

// codexModelPattern matches gpt-5-codex and its variants (e.g., gpt-5.1-codex-mini).
// These models MUST use the Responses API (/v1/responses) instead of Chat Completions.
var codexModelPattern = regexp.MustCompile(`(?i)^gpt-5(?:\.\d+)?-codex`)

// reasoningModelPattern matches o1/o3 reasoning models that don't support temperature.
var reasoningModelPattern = regexp.MustCompile(`(?i)^o[13](-|$)`)

// isCodexResponsesModel returns true if the model uses the OpenAI Responses API.
func isCodexResponsesModel(model string) bool {
	return codexModelPattern.MatchString(strings.TrimSpace(model))
}

// isReasoningModel returns true if the model is an o-series reasoning model.
func isReasoningModel(model string) bool {
	return reasoningModelPattern.MatchString(strings.TrimSpace(model))
}

// isAzureEndpoint returns true if the endpoint is an Azure OpenAI endpoint.
// Azure OpenAI uses a different URL format:
//
//	{endpoint}/openai/deployments/{model}/chat/completions?api-version=2024-02-01
//
// Detection: URL contains ".openai.azure.com" or ".cognitiveservices.azure.com".
func isAzureEndpoint(endpoint string) bool {
	lower := strings.ToLower(endpoint)
	return strings.Contains(lower, ".openai.azure.com") ||
		strings.Contains(lower, ".cognitiveservices.azure.com")
}

// buildAzureURL constructs the Azure OpenAI API URL for a given model.
// Azure uses deployment-based URLs rather than a model parameter in the body.
func buildAzureURL(endpoint, model string) string {
	base := strings.TrimRight(endpoint, "/")
	// Strip any trailing /openai or /v1 path from the base
	base = strings.TrimSuffix(base, "/openai")
	base = strings.TrimSuffix(base, "/v1")
	return fmt.Sprintf("%s/openai/deployments/%s/chat/completions?api-version=2024-02-01", base, model)
}

// OpenAIProvider implements the LLMProvider interface for OpenAI
type OpenAIProvider struct {
	*BaseProvider
	client   *openai.Client
	apiKey   string
	endpoint string
	logger   *zap.Logger
}

// NewOpenAIProvider creates a new OpenAI provider
func NewOpenAIProvider(apiKey string, logger *zap.Logger) *OpenAIProvider {
	return NewOpenAIProviderWithEndpoint(apiKey, "https://api.openai.com/v1", logger)
}

// NewOpenAIProviderWithEndpoint creates a new OpenAI provider with a custom endpoint.
// Supports standard OpenAI, Azure OpenAI, and custom OpenAI-compatible endpoints.
func NewOpenAIProviderWithEndpoint(apiKey, endpoint string, logger *zap.Logger) *OpenAIProvider {
	cfg := openai.DefaultConfig(apiKey)

	azure := isAzureEndpoint(endpoint)
	if azure {
		// Azure OpenAI: configure the go-openai client for Azure mode.
		// The library has built-in Azure support via config.APIType.
		cfg.APIType = openai.APITypeAzure
		cfg.AzureModelMapperFunc = func(model string) string { return model }
		// Strip trailing path segments — Azure base URL should be the resource endpoint
		base := strings.TrimRight(endpoint, "/")
		base = strings.TrimSuffix(base, "/openai")
		base = strings.TrimSuffix(base, "/v1")
		cfg.BaseURL = base
		cfg.APIVersion = "2024-02-01"
		logger.Info("Azure OpenAI endpoint detected",
			zap.String("base_url", base),
			zap.String("api_version", cfg.APIVersion),
		)
	} else if endpoint != "" && endpoint != "https://api.openai.com/v1" {
		cfg.BaseURL = endpoint
	}
	client := openai.NewClientWithConfig(cfg)

	models := []string{
		"gpt-4o",
		"gpt-4-turbo",
		"gpt-4",
		"gpt-4-32k",
		"gpt-3.5-turbo",
		"gpt-3.5-turbo-16k",
		// Responses API models (gpt-5-codex family)
		"gpt-5-codex",
	}
	return &OpenAIProvider{
		BaseProvider: NewBaseProvider("openai", models),
		client:       client,
		apiKey:       apiKey,
		endpoint:     strings.TrimRight(endpoint, "/"),
		logger:       logger,
	}
}

// IsAvailable checks if the OpenAI provider is available
func (op *OpenAIProvider) IsAvailable() bool {
	return op.client != nil
}

// SupportsModel checks if OpenAI supports a specific model.
// Accepts any gpt-* or o1/o3 model, plus known models in the list.
func (op *OpenAIProvider) SupportsModel(model string) bool {
	lower := strings.ToLower(model)
	// Accept any gpt-* model, o-series, and codex models
	if strings.HasPrefix(lower, "gpt-") || isReasoningModel(model) || isCodexResponsesModel(model) {
		return true
	}
	for _, m := range op.GetModels() {
		if m == model {
			return true
		}
	}
	return false
}

// Complete sends a completion request to OpenAI.
// Routes to Responses API for gpt-5-codex models, Chat Completions for all others.
func (op *OpenAIProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	if isCodexResponsesModel(req.Model) {
		return op.completeViaResponsesAPI(ctx, req)
	}
	return op.completeViaChatCompletions(ctx, req)
}

// completeViaChatCompletions handles standard Chat Completions API calls.
func (op *OpenAIProvider) completeViaChatCompletions(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	// Build OpenAI request — reasoning models (o1, o3) need special handling:
	//   1. No system prompt allowed — move to first user message
	//   2. Use max_completion_tokens instead of max_tokens
	//   3. Temperature must be 0
	reasoning := isReasoningModel(req.Model)

	messages := make([]openai.ChatCompletionMessage, 0, len(req.Messages))
	var systemContent string

	if reasoning {
		// Collect system messages and prepend to first user message
		for _, msg := range req.Messages {
			if msg.Role == "system" {
				if systemContent != "" {
					systemContent += "\n\n"
				}
				systemContent += msg.Content
			} else {
				messages = append(messages, openai.ChatCompletionMessage{
					Role:    msg.Role,
					Content: msg.Content,
				})
			}
		}
		// Prepend system content to first user message
		if systemContent != "" && len(messages) > 0 {
			for i := range messages {
				if messages[i].Role == "user" {
					messages[i].Content = systemContent + "\n\n---\n\n" + messages[i].Content
					break
				}
			}
		}
	} else {
		for _, msg := range req.Messages {
			messages = append(messages, openai.ChatCompletionMessage{
				Role:    msg.Role,
				Content: msg.Content,
			})
		}
	}

	request := openai.ChatCompletionRequest{
		Model:    req.Model,
		Messages: messages,
		Stop:     req.Stop,
		Stream:   false,
	}

	if reasoning {
		// Reasoning models (o1, o3): no temperature, no top_p.
		// Ideally use MaxCompletionTokens for these models, but fall back to
		// MaxTokens if the go-openai library version doesn't support it yet.
		request.Temperature = 0
		request.MaxTokens = req.MaxTokens
	} else {
		request.MaxTokens = req.MaxTokens
		request.Temperature = req.Temperature
		request.TopP = req.TopP
	}

	// Set timeout if provided
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	// Call OpenAI API
	response, err := op.client.CreateChatCompletion(ctx, request)
	if err != nil {
		op.RecordError(err)
		op.logger.Error("OpenAI completion failed",
			zap.Error(err),
			zap.String("model", req.Model),
			zap.Duration("latency", time.Since(start)),
		)
		return &CompletionResponse{
			Provider: "openai",
			Model:    req.Model,
			Error:    err.Error(),
			Latency:  time.Since(start),
		}, err
	}

	op.RecordSuccess()
	latency := time.Since(start)

	// Calculate cost
	inputTokens := response.Usage.PromptTokens
	outputTokens := response.Usage.CompletionTokens
	cost := calculateOpenAICost(req.Model, inputTokens, outputTokens)

	content := ""
	if len(response.Choices) > 0 {
		content = response.Choices[0].Message.Content
	}

	result := &CompletionResponse{
		ID:           response.ID,
		Model:        response.Model,
		Provider:     "openai",
		Content:      content,
		FinishReason: finishReasonFromChoices(response.Choices),
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		TotalTokens:  response.Usage.TotalTokens,
		Cost:         cost,
		Latency:      latency,
	}

	op.logger.Debug("OpenAI completion succeeded",
		zap.String("model", req.Model),
		zap.Int("input_tokens", inputTokens),
		zap.Int("output_tokens", outputTokens),
		zap.Duration("latency", latency),
	)

	return result, nil
}

// ─── RESPONSES API (gpt-5-codex) ────────────────────────────────

// responsesAPIRequest is the request body for the OpenAI Responses API.
type responsesAPIRequest struct {
	Model       string                   `json:"model"`
	Input       []responsesAPIInputItem  `json:"input"`
	MaxTokens   int                      `json:"max_output_tokens,omitempty"`
	Temperature float32                  `json:"temperature,omitempty"`
	Stream      bool                     `json:"stream,omitempty"`
}

type responsesAPIInputItem struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// responsesAPIResponse is the non-streaming response from the Responses API.
type responsesAPIResponse struct {
	ID         string `json:"id"`
	OutputText string `json:"output_text"`
	Model      string `json:"model"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	Status string `json:"status"`
	Output []struct {
		Type    string `json:"type"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"output"`
}

// completeViaResponsesAPI handles gpt-5-codex model requests via the Responses API.
func (op *OpenAIProvider) completeViaResponsesAPI(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	// Build Responses API request
	input := make([]responsesAPIInputItem, 0, len(req.Messages))
	for _, msg := range req.Messages {
		// Responses API uses "developer" instead of "system"
		role := msg.Role
		if role == "system" {
			role = "developer"
		}
		input = append(input, responsesAPIInputItem{
			Role:    role,
			Content: msg.Content,
		})
	}

	apiReq := responsesAPIRequest{
		Model:       req.Model,
		Input:       input,
		MaxTokens:   req.MaxTokens,
		Temperature: req.Temperature,
		Stream:      false,
	}

	body, err := json.Marshal(apiReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal Responses API request: %w", err)
	}

	// Build endpoint URL
	endpoint := op.endpoint + "/responses"

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create Responses API request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+op.apiKey)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		op.RecordError(err)
		return &CompletionResponse{
			Provider: "openai",
			Model:    req.Model,
			Error:    err.Error(),
			Latency:  time.Since(start),
		}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		op.RecordError(err)
		return nil, fmt.Errorf("failed to read Responses API response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		op.RecordError(fmt.Errorf("status %d", resp.StatusCode))
		return &CompletionResponse{
			Provider: "openai",
			Model:    req.Model,
			Error:    fmt.Sprintf("Responses API returned %d: %s", resp.StatusCode, string(respBody)),
			Latency:  time.Since(start),
		}, fmt.Errorf("Responses API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var apiResp responsesAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("failed to parse Responses API response: %w", err)
	}

	// Extract text content
	content := apiResp.OutputText
	if content == "" {
		// Fallback: extract from output[].content[].text
		for _, output := range apiResp.Output {
			for _, c := range output.Content {
				if c.Type == "output_text" {
					content += c.Text
				}
			}
		}
	}

	op.RecordSuccess()
	latency := time.Since(start)
	cost := calculateOpenAICost(req.Model, apiResp.Usage.InputTokens, apiResp.Usage.OutputTokens)

	op.logger.Debug("OpenAI Responses API completion succeeded",
		zap.String("model", req.Model),
		zap.Int("input_tokens", apiResp.Usage.InputTokens),
		zap.Int("output_tokens", apiResp.Usage.OutputTokens),
		zap.Duration("latency", latency),
	)

	return &CompletionResponse{
		ID:           apiResp.ID,
		Model:        apiResp.Model,
		Provider:     "openai",
		Content:      content,
		FinishReason: "stop",
		InputTokens:  apiResp.Usage.InputTokens,
		OutputTokens: apiResp.Usage.OutputTokens,
		TotalTokens:  apiResp.Usage.InputTokens + apiResp.Usage.OutputTokens,
		Cost:         cost,
		Latency:      latency,
	}, nil
}

// ─── STREAMING ──────────────────────────────────────────────────

// Stream sends a streaming completion request to OpenAI.
// Routes to Responses API streaming for gpt-5-codex models.
func (op *OpenAIProvider) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	if isCodexResponsesModel(req.Model) {
		return op.streamViaResponsesAPI(ctx, req)
	}
	return op.streamViaChatCompletions(ctx, req)
}

// streamViaChatCompletions handles standard Chat Completions streaming.
func (op *OpenAIProvider) streamViaChatCompletions(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	// Build OpenAI request — apply reasoning model handling
	reasoning := isReasoningModel(req.Model)
	messages := make([]openai.ChatCompletionMessage, 0, len(req.Messages))
	var systemContent string

	if reasoning {
		for _, msg := range req.Messages {
			if msg.Role == "system" {
				if systemContent != "" {
					systemContent += "\n\n"
				}
				systemContent += msg.Content
			} else {
				messages = append(messages, openai.ChatCompletionMessage{
					Role:    msg.Role,
					Content: msg.Content,
				})
			}
		}
		if systemContent != "" && len(messages) > 0 {
			for i := range messages {
				if messages[i].Role == "user" {
					messages[i].Content = systemContent + "\n\n---\n\n" + messages[i].Content
					break
				}
			}
		}
	} else {
		for _, msg := range req.Messages {
			messages = append(messages, openai.ChatCompletionMessage{
				Role:    msg.Role,
				Content: msg.Content,
			})
		}
	}

	request := openai.ChatCompletionRequest{
		Model:    req.Model,
		Messages: messages,
		Stop:     req.Stop,
		Stream:   true,
	}

	if reasoning {
		request.Temperature = 0
		request.MaxTokens = req.MaxTokens
	} else {
		request.MaxTokens = req.MaxTokens
		request.Temperature = req.Temperature
		request.TopP = req.TopP
	}

	// Set timeout if provided
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
				Error: fmt.Sprintf("stream setup failed: %v", err),
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
					Error: fmt.Sprintf("stream error: %v", err),
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

// streamViaResponsesAPI handles streaming for gpt-5-codex models via the Responses API.
// The Responses API SSE format uses different event types:
//   - response.output_text.delta  -> { delta: "text chunk" }
//   - response.completed          -> { response: { output_text, usage } }
//   - error                       -> { error: { message } }
func (op *OpenAIProvider) streamViaResponsesAPI(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	// Build Responses API request
	input := make([]responsesAPIInputItem, 0, len(req.Messages))
	for _, msg := range req.Messages {
		role := msg.Role
		if role == "system" {
			role = "developer"
		}
		input = append(input, responsesAPIInputItem{
			Role:    role,
			Content: msg.Content,
		})
	}

	apiReq := responsesAPIRequest{
		Model:       req.Model,
		Input:       input,
		MaxTokens:   req.MaxTokens,
		Temperature: req.Temperature,
		Stream:      true,
	}

	body, err := json.Marshal(apiReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal Responses API stream request: %w", err)
	}

	endpoint := op.endpoint + "/responses"

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create Responses API stream request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+op.apiKey)
	httpReq.Header.Set("Accept", "text/event-stream")

	go func() {
		defer close(out)

		resp, err := http.DefaultClient.Do(httpReq)
		if err != nil {
			op.RecordError(err)
			out <- &StreamChunk{Error: fmt.Sprintf("Responses stream request failed: %v", err)}
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			op.RecordError(fmt.Errorf("status %d", resp.StatusCode))
			out <- &StreamChunk{Error: fmt.Sprintf("Responses API returned %d: %s", resp.StatusCode, string(body))}
			return
		}

		scanner := bufio.NewScanner(resp.Body)
		// Increase scanner buffer for large SSE events
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		for scanner.Scan() {
			line := scanner.Text()

			// Skip empty lines and comments
			if line == "" || strings.HasPrefix(line, ":") {
				continue
			}

			if !strings.HasPrefix(line, "data: ") {
				// Could be an "event:" line — skip
				continue
			}

			jsonStr := strings.TrimPrefix(line, "data: ")
			if jsonStr == "[DONE]" {
				op.RecordSuccess()
				out <- &StreamChunk{FinishReason: "stop"}
				return
			}

			var event map[string]interface{}
			if err := json.Unmarshal([]byte(jsonStr), &event); err != nil {
				continue // skip malformed events
			}

			eventType, _ := event["type"].(string)

			switch eventType {
			case "response.output_text.delta":
				delta, _ := event["delta"].(string)
				if delta != "" {
					out <- &StreamChunk{Delta: delta}
				}

			case "response.completed":
				// Extract final text and usage from the completed event
				if respObj, ok := event["response"].(map[string]interface{}); ok {
					if usage, ok := respObj["usage"].(map[string]interface{}); ok {
						inputTokens := int(getFloat64(usage, "input_tokens"))
						outputTokens := int(getFloat64(usage, "output_tokens"))
						op.logger.Debug("Responses API stream completed",
							zap.String("model", req.Model),
							zap.Int("input_tokens", inputTokens),
							zap.Int("output_tokens", outputTokens),
						)
					}
				}
				op.RecordSuccess()
				out <- &StreamChunk{FinishReason: "stop"}
				return

			case "error":
				errObj, _ := event["error"].(map[string]interface{})
				errMsg, _ := errObj["message"].(string)
				if errMsg == "" {
					errMsg = "Responses API stream error"
				}
				op.RecordError(fmt.Errorf("%s", errMsg))
				out <- &StreamChunk{Error: errMsg}
				return
			}
		}

		if err := scanner.Err(); err != nil {
			op.RecordError(err)
			out <- &StreamChunk{Error: fmt.Sprintf("stream scanner error: %v", err)}
		}
	}()

	return out, nil
}

// ─── COST CALCULATION ───────────────────────────────────────────

// calculateOpenAICost calculates the cost of an OpenAI API call.
// Pricing per 1K tokens (as of 2026-03).
func calculateOpenAICost(model string, inputTokens, outputTokens int) float64 {
	return CalculateCost(model, inputTokens, outputTokens)
}

// ─── HELPERS ────────────────────────────────────────────────────

func finishReasonFromChoices(choices []openai.ChatCompletionChoice) string {
	if len(choices) > 0 {
		return string(choices[0].FinishReason)
	}
	return "unknown"
}

func getFloat64(m map[string]interface{}, key string) float64 {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case float64:
			return n
		case int:
			return float64(n)
		}
	}
	return 0
}
