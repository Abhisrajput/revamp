package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.uber.org/zap"
)

// AzureProvider implements the LLMProvider interface for Azure AI Foundry (Azure OpenAI).
// Supports three auth modes:
//   - API Key — resource-level key, sent via api-key header
//   - Azure AD / Entra ID Token — OAuth2 bearer token
//   - Default credentials — for Azure-hosted workloads (managed identity)
type AzureProvider struct {
	*BaseProvider
	endpoint    string   // https://<resource>.openai.azure.com
	apiKey      string   // API key auth
	adToken     string   // Azure AD bearer token auth
	apiVersion  string   // API version (default 2024-12-01-preview)
	deployments []string // Azure deployment names (used as model names)
	logger      *zap.Logger
	httpClient  *http.Client
}

// NewAzureProvider creates an Azure AI Foundry provider with API key auth.
func NewAzureProvider(endpoint, apiKey string, deployments []string, apiVersion string, logger *zap.Logger) *AzureProvider {
	if apiVersion == "" {
		apiVersion = "2024-12-01-preview"
	}
	return &AzureProvider{
		BaseProvider: NewBaseProvider("azure", deployments),
		endpoint:     strings.TrimRight(endpoint, "/"),
		apiKey:       apiKey,
		apiVersion:   apiVersion,
		deployments:  deployments,
		logger:       logger,
		httpClient: &http.Client{
			Timeout: 10 * time.Minute,
			Transport: &http.Transport{
				MaxIdleConns:        20,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// NewAzureProviderWithADToken creates an Azure AI Foundry provider with Azure AD/Entra ID token.
func NewAzureProviderWithADToken(endpoint, adToken string, deployments []string, apiVersion string, logger *zap.Logger) *AzureProvider {
	if apiVersion == "" {
		apiVersion = "2024-12-01-preview"
	}
	return &AzureProvider{
		BaseProvider: NewBaseProvider("azure", deployments),
		endpoint:     strings.TrimRight(endpoint, "/"),
		adToken:      adToken,
		apiVersion:   apiVersion,
		deployments:  deployments,
		logger:       logger,
		httpClient:   &http.Client{Timeout: 10 * time.Minute},
	}
}

// IsAvailable checks if the Azure provider is available
func (ap *AzureProvider) IsAvailable() bool {
	return ap.endpoint != "" && (ap.apiKey != "" || ap.adToken != "")
}

// SupportsModel checks if Azure supports a specific model (deployment name)
func (ap *AzureProvider) SupportsModel(model string) bool {
	for _, d := range ap.deployments {
		if d == model {
			return true
		}
	}
	// Also support well-known model names that may map to deployments
	return false
}

// buildURL constructs the Azure OpenAI API URL for a deployment.
func (ap *AzureProvider) buildURL(deployment string) string {
	base := strings.TrimSuffix(ap.endpoint, "/openai")
	base = strings.TrimSuffix(base, "/v1")
	return fmt.Sprintf("%s/openai/deployments/%s/chat/completions?api-version=%s", base, deployment, ap.apiVersion)
}

// setAuthHeaders adds the appropriate auth header to the request.
func (ap *AzureProvider) setAuthHeaders(req *http.Request) {
	if ap.apiKey != "" {
		req.Header.Set("api-key", ap.apiKey)
	} else if ap.adToken != "" {
		req.Header.Set("Authorization", "Bearer "+ap.adToken)
	}
}

// azureChatRequest is the request body for Azure OpenAI chat completions.
type azureChatRequest struct {
	Messages    []azureChatMessage `json:"messages"`
	MaxTokens   int                `json:"max_tokens,omitempty"`
	Temperature float32            `json:"temperature,omitempty"`
	TopP        float32            `json:"top_p,omitempty"`
	Stop        []string           `json:"stop,omitempty"`
	Stream      bool               `json:"stream,omitempty"`
}

type azureChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type azureChatResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Code    string `json:"code"`
	} `json:"error,omitempty"`
}

// Complete sends a completion request to Azure OpenAI
func (ap *AzureProvider) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()

	callTimeout := req.Timeout
	if callTimeout <= 0 {
		callTimeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()

	// Use the model name as the deployment name
	deployment := req.Model
	url := ap.buildURL(deployment)

	messages := make([]azureChatMessage, 0, len(req.Messages))
	for _, msg := range req.Messages {
		messages = append(messages, azureChatMessage{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}

	body := azureChatRequest{
		Messages:    messages,
		MaxTokens:   req.MaxTokens,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stop:        req.Stop,
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		ap.RecordError(err)
		return &CompletionResponse{Provider: "azure", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		ap.RecordError(err)
		return &CompletionResponse{Provider: "azure", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	ap.setAuthHeaders(httpReq)

	resp, err := ap.httpClient.Do(httpReq)
	if err != nil {
		ap.RecordError(err)
		ap.logger.Error("Azure completion failed", zap.Error(err), zap.String("model", req.Model))
		return &CompletionResponse{Provider: "azure", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		ap.RecordError(err)
		return &CompletionResponse{Provider: "azure", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	if resp.StatusCode != 200 {
		errMsg := fmt.Sprintf("Azure API error %d: %s", resp.StatusCode, string(respBody))
		ap.RecordError(fmt.Errorf(errMsg))
		ap.logger.Error("Azure API error", zap.Int("status", resp.StatusCode), zap.String("body", string(respBody)))
		return &CompletionResponse{Provider: "azure", Model: req.Model, Error: errMsg, Latency: time.Since(start)}, fmt.Errorf(errMsg)
	}

	var chatResp azureChatResponse
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		ap.RecordError(err)
		return &CompletionResponse{Provider: "azure", Model: req.Model, Error: err.Error(), Latency: time.Since(start)}, err
	}

	if chatResp.Error != nil {
		errMsg := chatResp.Error.Message
		ap.RecordError(fmt.Errorf(errMsg))
		return &CompletionResponse{Provider: "azure", Model: req.Model, Error: errMsg, Latency: time.Since(start)}, fmt.Errorf(errMsg)
	}

	ap.RecordSuccess()
	latency := time.Since(start)

	content := ""
	finishReason := ""
	if len(chatResp.Choices) > 0 {
		content = chatResp.Choices[0].Message.Content
		finishReason = chatResp.Choices[0].FinishReason
	}

	cost := calculateAzureCost(req.Model, chatResp.Usage.PromptTokens, chatResp.Usage.CompletionTokens)

	return &CompletionResponse{
		ID:           chatResp.ID,
		Model:        req.Model,
		Provider:     "azure",
		Content:      content,
		FinishReason: finishReason,
		InputTokens:  chatResp.Usage.PromptTokens,
		OutputTokens: chatResp.Usage.CompletionTokens,
		TotalTokens:  chatResp.Usage.TotalTokens,
		Cost:         cost,
		Latency:      latency,
	}, nil
}

// Stream sends a streaming completion request to Azure OpenAI
func (ap *AzureProvider) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamChunk, error) {
	out := make(chan *StreamChunk)

	go func() {
		defer close(out)

		callTimeout := req.Timeout
		if callTimeout <= 0 {
			callTimeout = 10 * time.Minute
		}
		ctx, cancel := context.WithTimeout(ctx, callTimeout)
		defer cancel()

		deployment := req.Model
		url := ap.buildURL(deployment)

		messages := make([]azureChatMessage, 0, len(req.Messages))
		for _, msg := range req.Messages {
			messages = append(messages, azureChatMessage{Role: msg.Role, Content: msg.Content})
		}

		body := azureChatRequest{
			Messages:    messages,
			MaxTokens:   req.MaxTokens,
			Temperature: req.Temperature,
			TopP:        req.TopP,
			Stop:        req.Stop,
			Stream:      true,
		}

		bodyBytes, err := json.Marshal(body)
		if err != nil {
			out <- &StreamChunk{Error: err.Error()}
			return
		}

		httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
		if err != nil {
			out <- &StreamChunk{Error: err.Error()}
			return
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Accept", "text/event-stream")
		ap.setAuthHeaders(httpReq)

		resp, err := ap.httpClient.Do(httpReq)
		if err != nil {
			ap.RecordError(err)
			out <- &StreamChunk{Error: err.Error()}
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			body, _ := io.ReadAll(resp.Body)
			ap.RecordError(fmt.Errorf("Azure stream error %d", resp.StatusCode))
			out <- &StreamChunk{Error: fmt.Sprintf("Azure API error %d: %s", resp.StatusCode, string(body))}
			return
		}

		// Parse SSE stream
		scanner := newSSEScanner(resp.Body)
		chunkIndex := 0
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				break
			}

			var chunk struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
					FinishReason *string `json:"finish_reason"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(data), &chunk); err != nil {
				continue
			}

			for _, choice := range chunk.Choices {
				if choice.Delta.Content != "" {
					out <- &StreamChunk{
						ID:    fmt.Sprintf("azure-%d", time.Now().UnixNano()),
						Index: chunkIndex,
						Delta: choice.Delta.Content,
					}
					chunkIndex++
				}
				if choice.FinishReason != nil {
					out <- &StreamChunk{FinishReason: *choice.FinishReason}
				}
			}
		}

		ap.RecordSuccess()
		if chunkIndex > 0 {
			out <- &StreamChunk{FinishReason: "stop"}
		}
	}()

	return out, nil
}

// newSSEScanner creates a scanner for SSE streams that handles line-by-line reading.
func newSSEScanner(r io.Reader) *lineScanner {
	return &lineScanner{reader: r, buf: make([]byte, 0, 4096)}
}

type lineScanner struct {
	reader io.Reader
	buf    []byte
	line   string
	err    error
}

func (s *lineScanner) Scan() bool {
	for {
		// Check if we have a complete line in the buffer
		if idx := bytes.IndexByte(s.buf, '\n'); idx >= 0 {
			s.line = strings.TrimRight(string(s.buf[:idx]), "\r")
			s.buf = s.buf[idx+1:]
			return true
		}
		// Read more data
		tmp := make([]byte, 4096)
		n, err := s.reader.Read(tmp)
		if n > 0 {
			s.buf = append(s.buf, tmp[:n]...)
		}
		if err != nil {
			if len(s.buf) > 0 {
				s.line = string(s.buf)
				s.buf = nil
				return true
			}
			s.err = err
			return false
		}
	}
}

func (s *lineScanner) Text() string { return s.line }

// calculateAzureCost estimates cost for Azure OpenAI.
func calculateAzureCost(model string, inputTokens, outputTokens int) float64 {
	return CalculateCost(model, inputTokens, outputTokens)
}
