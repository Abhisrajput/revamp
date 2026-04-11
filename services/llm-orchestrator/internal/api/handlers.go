package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"github.com/revamp-io/llm-orchestrator/internal/queue"
	"go.uber.org/zap"
)

// CompletionRequestBody represents the request body for completions
type CompletionRequestBody struct {
	Model       string                `json:"model"`
	Messages    []CompletionMessage   `json:"messages"`
	MaxTokens   int                   `json:"max_tokens"`
	Temperature float32               `json:"temperature"`
	TopP        float32               `json:"top_p"`
	Stop        []string              `json:"stop"`
	Stream      bool                  `json:"stream"`

	// Structured output mode
	ResponseFormat *struct {
		Type       string      `json:"type"`                  // "text", "json", "json_schema"
		JSONSchema interface{} `json:"json_schema,omitempty"`
	} `json:"response_format,omitempty"`

	// Extended thinking (Anthropic, OpenAI o-series)
	ExtendedThinking  bool `json:"extended_thinking,omitempty"`
	ThinkingBudget    int  `json:"thinking_budget,omitempty"`
	MaxThinkingTokens int  `json:"max_thinking_tokens,omitempty"` // default 10,000 when thinking enabled

	// Per-request credentials (BYOK — Bring Your Own Key per project)
	Credentials *providers.RequestCredentials `json:"credentials,omitempty"`

	// Advisor tool (Anthropic-only; other providers silently ignore)
	Advisor *providers.AdvisorConfig `json:"advisor,omitempty"`

	// Metadata for tracking
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// CompletionMessage represents a message in the request
type CompletionMessage struct {
	Role         string `json:"role"`
	Content      string `json:"content"`
	CacheControl *struct {
		Type string `json:"type"` // "ephemeral" for Anthropic prompt caching
	} `json:"cache_control,omitempty"`
}

// CompletionResponseBody represents the response body
type CompletionResponseBody struct {
	ID           string `json:"id"`
	Model        string `json:"model"`
	Provider     string `json:"provider"`
	Content      string `json:"content"`
	FinishReason string `json:"finish_reason"`
	Tokens       struct {
		Input         int `json:"input"`
		Output        int `json:"output"`
		Total         int `json:"total"`
		CacheCreation int `json:"cache_creation,omitempty"`
		CacheRead     int `json:"cache_read,omitempty"`
		Thinking      int `json:"thinking,omitempty"`
	} `json:"tokens"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		CachedTokens     int `json:"cached_tokens,omitempty"`
	} `json:"usage"`
	ThinkingContent string                `json:"thinking_content,omitempty"`
	AdvisorUsage    *providers.AdvisorUsage `json:"advisor_usage,omitempty"`
	Cost            float64                `json:"cost"`
	Latency         float64                `json:"latency_ms"`
	Error           string                 `json:"error,omitempty"`
}

const (
	maxRequestBodyBytes = 50 * 1024 * 1024 // 50 MB
	maxAllowedTokens    = 200_000
)

// requireJSON rejects requests that are not application/json.
func requireJSON(w http.ResponseWriter, r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		http.Error(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
		return false
	}
	return true
}

// handleCompletion handles completion requests
func (s *Server) handleCompletion(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)

	var reqBody CompletionRequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if reqBody.MaxTokens > maxAllowedTokens {
		http.Error(w, fmt.Sprintf("max_tokens exceeds limit of %d", maxAllowedTokens), http.StatusBadRequest)
		return
	}

	// Resolve thinking token cap: explicit > legacy > default (10k)
	thinkingBudget := reqBody.MaxThinkingTokens
	if thinkingBudget == 0 && reqBody.ThinkingBudget > 0 {
		thinkingBudget = reqBody.ThinkingBudget
	}
	if reqBody.ExtendedThinking && thinkingBudget == 0 {
		thinkingBudget = 10_000 // default cap prevents runaway costs
	}

	// Compute a dynamic timeout scaled to max_tokens and model tier.
	// Opus/large models get 2x timeout — they're slower but produce higher quality.
	// Formula: base + 1s per 100 output tokens, capped at 20 min.
	isSlowModel := strings.Contains(strings.ToLower(reqBody.Model), "opus") ||
		strings.Contains(strings.ToLower(reqBody.Model), "o1") ||
		strings.Contains(strings.ToLower(reqBody.Model), "o3")
	baseTimeout := 2 * time.Minute
	if isSlowModel {
		baseTimeout = 5 * time.Minute
	}
	dynamicTimeout := baseTimeout + time.Duration(reqBody.MaxTokens/100)*time.Second
	if dynamicTimeout > 20*time.Minute {
		dynamicTimeout = 20 * time.Minute
	}
	if dynamicTimeout < 2*time.Minute {
		dynamicTimeout = 2 * time.Minute
	}

	// Convert to orchestrator format
	req := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model:            reqBody.Model,
			Messages:         convertMessages(reqBody.Messages),
			MaxTokens:        reqBody.MaxTokens,
			Temperature:      reqBody.Temperature,
			TopP:             reqBody.TopP,
			Stop:             reqBody.Stop,
			Stream:           false,
			Timeout:          dynamicTimeout,
			ResponseFormat:   convertResponseFormat(reqBody.ResponseFormat),
			ExtendedThinking: reqBody.ExtendedThinking,
			ThinkingBudget:   thinkingBudget,
			Credentials:      reqBody.Credentials,
			Advisor:          reqBody.Advisor,
			Metadata:         reqBody.Metadata,
		},
		ProjectID: r.Header.Get("X-Project-ID"),
		UserID:    r.Header.Get("X-User-ID"),
	}

	// Process request
	resp, err := s.engine.Complete(r.Context(), req)
	if err != nil {
		s.logger.Error("Completion failed", zap.Error(err))
		// Pass through client errors (400, 401, 403, 404, 422) so the Node proxy
		// can classify them as non-retryable. Default to 500 for unknown errors.
		errMsg := err.Error()
		statusCode := http.StatusInternalServerError
		if strings.Contains(errMsg, "StatusCode: 400") || strings.Contains(errMsg, "ValidationException") || strings.Contains(errMsg, "model identifier is invalid") {
			statusCode = http.StatusBadRequest
		} else if strings.Contains(errMsg, "StatusCode: 401") || strings.Contains(errMsg, "StatusCode: 403") || strings.Contains(errMsg, "ExpiredTokenException") {
			statusCode = http.StatusForbidden
		} else if strings.Contains(errMsg, "StatusCode: 429") || strings.Contains(errMsg, "ThrottlingException") {
			statusCode = http.StatusTooManyRequests
		}
		http.Error(w, fmt.Sprintf("Completion failed: %v", err), statusCode)
		return
	}

	respBody := CompletionResponseBody{
		ID:              resp.ID,
		Model:           resp.Model,
		Provider:        resp.UsedProvider,
		Content:         resp.Content,
		FinishReason:    resp.FinishReason,
		ThinkingContent: resp.ThinkingContent,
		Cost:            resp.Cost,
		Latency:         float64(resp.TotalLatency.Milliseconds()),
	}
	respBody.Tokens.Input = resp.InputTokens
	respBody.Tokens.Output = resp.OutputTokens
	respBody.Tokens.Total = resp.TotalTokens
	respBody.Tokens.CacheCreation = resp.CacheCreationTokens
	respBody.Tokens.CacheRead = resp.CacheReadTokens
	respBody.Tokens.Thinking = resp.ThinkingTokens
	respBody.Usage.PromptTokens = resp.InputTokens
	respBody.Usage.CompletionTokens = resp.OutputTokens
	respBody.Usage.CachedTokens = resp.CacheReadTokens
	respBody.AdvisorUsage = resp.AdvisorUsage

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(respBody)
}

// handleStreamCompletion handles streaming completion requests
func (s *Server) handleStreamCompletion(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)

	var reqBody CompletionRequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if reqBody.MaxTokens > maxAllowedTokens {
		http.Error(w, fmt.Sprintf("max_tokens exceeds limit of %d", maxAllowedTokens), http.StatusBadRequest)
		return
	}

	// Resolve thinking token cap for streaming
	streamThinkingBudget := reqBody.MaxThinkingTokens
	if streamThinkingBudget == 0 && reqBody.ThinkingBudget > 0 {
		streamThinkingBudget = reqBody.ThinkingBudget
	}
	if reqBody.ExtendedThinking && streamThinkingBudget == 0 {
		streamThinkingBudget = 10_000
	}

	// Dynamic timeout for streaming — same formula as non-streaming
	isSlowStreamModel := strings.Contains(strings.ToLower(reqBody.Model), "opus") ||
		strings.Contains(strings.ToLower(reqBody.Model), "o1") ||
		strings.Contains(strings.ToLower(reqBody.Model), "o3")
	streamBaseTimeout := 2 * time.Minute
	if isSlowStreamModel {
		streamBaseTimeout = 5 * time.Minute
	}
	streamDynamicTimeout := streamBaseTimeout + time.Duration(reqBody.MaxTokens/100)*time.Second
	if streamDynamicTimeout > 20*time.Minute {
		streamDynamicTimeout = 20 * time.Minute
	}
	if streamDynamicTimeout < 2*time.Minute {
		streamDynamicTimeout = 2 * time.Minute
	}

	req := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model:            reqBody.Model,
			Messages:         convertMessages(reqBody.Messages),
			MaxTokens:        reqBody.MaxTokens,
			Temperature:      reqBody.Temperature,
			TopP:             reqBody.TopP,
			Stop:             reqBody.Stop,
			Stream:           true,
			Timeout:          streamDynamicTimeout,
			ResponseFormat:   convertResponseFormat(reqBody.ResponseFormat),
			ExtendedThinking: reqBody.ExtendedThinking,
			ThinkingBudget:   streamThinkingBudget,
			Credentials:      reqBody.Credentials,
			Advisor:          reqBody.Advisor,
			Metadata:         reqBody.Metadata,
		},
		ProjectID: r.Header.Get("X-Project-ID"),
		UserID:    r.Header.Get("X-User-ID"),
	}

	// Get stream
	stream, err := s.engine.Stream(r.Context(), req)
	if err != nil {
		s.logger.Error("Stream setup failed", zap.Error(err))
		http.Error(w, fmt.Sprintf("Stream setup failed: %v", err), http.StatusInternalServerError)
		return
	}

	// Set up SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	// Stream chunks
	for chunk := range stream {
		if chunk.Error != "" {
			errJSON, _ := json.Marshal(chunk.Error)
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", string(errJSON))
			flusher.Flush()
			continue
		}

		// Advisor thinking keepalive — tells clients the stream is alive during Opus call
		if chunk.AdvisorThinking {
			fmt.Fprintf(w, "event: advisor_thinking\ndata: {}\n\n")
			flusher.Flush()
			continue
		}

		if chunk.Delta != "" {
			// SSE data fields cannot contain raw newlines — they break the
			// line-based protocol.  Send each line of the delta as a separate
			// "data:" line within the same event; per the SSE spec the client
			// reassembles them joined by "\n".
			lines := strings.Split(chunk.Delta, "\n")
			fmt.Fprintf(w, "event: message\n")
			for _, line := range lines {
				fmt.Fprintf(w, "data: %s\n", line)
			}
			fmt.Fprintf(w, "\n") // blank line = end of event
			flusher.Flush()
		}

		if chunk.FinishReason != "" {
			fmt.Fprintf(w, "event: done\ndata: {\"finish_reason\": \"%s\"}\n\n", chunk.FinishReason)
			flusher.Flush()
		}
	}
}

// handleChatCompletion handles chat completion requests (alias for completion)
func (s *Server) handleChatCompletion(w http.ResponseWriter, r *http.Request) {
	s.handleCompletion(w, r)
}

// handleChatStreamCompletion handles chat stream completion requests
func (s *Server) handleChatStreamCompletion(w http.ResponseWriter, r *http.Request) {
	s.handleStreamCompletion(w, r)
}

// handleBatch handles batch job submission
func (s *Server) handleBatch(w http.ResponseWriter, r *http.Request) {
	if !requireJSON(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)

	var reqBody struct {
		Jobs []struct {
			Model    string              `json:"model"`
			Messages []CompletionMessage `json:"messages"`
			Priority int                 `json:"priority"`
		} `json:"jobs"`
	}

	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	jobIDs := make([]string, len(reqBody.Jobs))
	projectID := r.Header.Get("X-Project-ID")
	userID := r.Header.Get("X-User-ID")

	for i, jobReq := range reqBody.Jobs {
		job := &queue.Job{
			ID:        fmt.Sprintf("job-%d", time.Now().UnixNano()),
			ProjectID: projectID,
			UserID:    userID,
			Model:     jobReq.Model,
			Status:    "pending",
			Priority:  jobReq.Priority,
			MaxRetries: 3,
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}

		// Convert messages
		for _, msg := range jobReq.Messages {
			job.Messages = append(job.Messages, queue.Message{
				Role:    msg.Role,
				Content: msg.Content,
			})
		}

		if err := s.workerPool.EnqueueJob(r.Context(), job); err != nil {
			s.logger.Error("Failed to enqueue job", zap.Error(err))
			http.Error(w, fmt.Sprintf("Failed to enqueue job: %v", err), http.StatusInternalServerError)
			return
		}

		jobIDs[i] = job.ID
	}

	respBody := map[string]interface{}{
		"job_ids": jobIDs,
		"count":   len(jobIDs),
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(respBody)
}

// handleGetBatchStatus retrieves batch job status
func (s *Server) handleGetBatchStatus(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "jobID")

	job, err := s.workerPool.GetJobStatus(r.Context(), jobID)
	if err != nil {
		http.Error(w, fmt.Sprintf("Job not found: %v", err), http.StatusNotFound)
		return
	}

	respBody := map[string]interface{}{
		"id":     job.ID,
		"status": job.Status,
		"result": job.Result,
		"error":  job.Error,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(respBody)
}

// handleListModels lists available models
func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	models := s.engine.ListModels()

	respBody := map[string]interface{}{
		"models": models,
		"count":  len(models),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(respBody)
}

// handleGetModelInfo gets information about a specific model
func (s *Server) handleGetModelInfo(w http.ResponseWriter, r *http.Request) {
	model := chi.URLParam(r, "model")
	models := s.engine.ListModels()

	if info, ok := models[model]; ok {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(info)
		return
	}

	http.Error(w, "Model not found", http.StatusNotFound)
}

// handleGetTokenUsage gets token usage
func (s *Server) handleGetTokenUsage(w http.ResponseWriter, r *http.Request) {
	projectID := r.Header.Get("X-Project-ID")

	respBody := map[string]interface{}{
		"project_id": projectID,
		"input_tokens": 0,
		"output_tokens": 0,
		"total_tokens": 0,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(respBody)
}

// handleGetCostUsage gets cost usage
func (s *Server) handleGetCostUsage(w http.ResponseWriter, r *http.Request) {
	projectID := r.Header.Get("X-Project-ID")

	respBody := map[string]interface{}{
		"project_id": projectID,
		"total_cost": 0.0,
		"currency":   "USD",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(respBody)
}

// handleGetQuotaStatus gets quota status
func (s *Server) handleGetQuotaStatus(w http.ResponseWriter, r *http.Request) {
	projectID := r.Header.Get("X-Project-ID")

	respBody := map[string]interface{}{
		"project_id": projectID,
		"tokens_used": 0,
		"quota_limit": 1000000,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(respBody)
}

// handleProvidersHealth gets provider health status
func (s *Server) handleProvidersHealth(w http.ResponseWriter, r *http.Request) {
	health := s.engine.GetHealth()

	respBody := map[string]interface{}{
		"providers": health,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(respBody)
}

// convertMessages converts CompletionMessage to providers.Message
func convertMessages(messages []CompletionMessage) []providers.Message {
	converted := make([]providers.Message, len(messages))
	for i, msg := range messages {
		m := providers.Message{
			Role:    msg.Role,
			Content: msg.Content,
		}
		if msg.CacheControl != nil {
			m.CacheControl = &providers.CacheControl{
				Type: msg.CacheControl.Type,
			}
		}
		converted[i] = m
	}
	return converted
}

func convertResponseFormat(rf *struct {
	Type       string      `json:"type"`
	JSONSchema interface{} `json:"json_schema,omitempty"`
}) *providers.ResponseFormat {
	if rf == nil {
		return nil
	}
	return &providers.ResponseFormat{
		Type:       rf.Type,
		JSONSchema: rf.JSONSchema,
	}
}
