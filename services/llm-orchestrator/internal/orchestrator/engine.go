package orchestrator

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/revamp-io/llm-orchestrator/internal/metrics"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"go.uber.org/zap"
)

// Engine orchestrates LLM requests across multiple providers
type Engine struct {
	registry       *providers.Registry
	cache          *redis.Client
	cacheTTL       time.Duration
	metrics        *metrics.Registry
	logger         *zap.Logger
	router         *Router
	balancer       *LoadBalancer
	circuitBreaker *CircuitBreaker
	mu             sync.RWMutex
}

// NewEngine creates a new orchestration engine
func NewEngine(
	registry *providers.Registry,
	cache *redis.Client,
	metricsRegistry *metrics.Registry,
	logger *zap.Logger,
) *Engine {
	return &Engine{
		registry:       registry,
		cache:          cache,
		cacheTTL:       5 * time.Minute,
		metrics:        metricsRegistry,
		logger:         logger,
		router:         NewRouter(registry, logger),
		balancer:       NewLoadBalancer(registry),
		circuitBreaker: NewCircuitBreaker(registry, logger),
	}
}

// SetCacheTTL configures the response cache TTL.
func (e *Engine) SetCacheTTL(ttl time.Duration) {
	e.cacheTTL = ttl
}

// CompletionRequest wraps the provider request with additional metadata
type CompletionRequest struct {
	*providers.CompletionRequest
	RequestID string
	ProjectID string
	UserID    string
	Priority  int
}

// CompletionResponse wraps the provider response with additional metadata
type CompletionResponse struct {
	*providers.CompletionResponse
	RequestID     string
	UsedProvider  string
	CacheHit      bool
	TotalLatency   time.Duration
	RoutingLatency time.Duration
}

// Complete processes a completion request with intelligent routing
func (e *Engine) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	start := time.Now()
	req.RequestID = fmt.Sprintf("req-%d", time.Now().UnixNano())

	e.logger.Info("Processing completion request",
		zap.String("request_id", req.RequestID),
		zap.String("model", req.Model),
		zap.String("project_id", req.ProjectID),
	)

	// Try cache first
	if cacheKey := req.getCacheKey(); cacheKey != "" {
		if cached, err := e.getFromCache(ctx, cacheKey); err == nil && cached != nil {
			e.logger.Debug("Cache hit", zap.String("request_id", req.RequestID))
			e.metrics.RecordCacheHit(req.Model)
			return &CompletionResponse{
				CompletionResponse: cached,
				RequestID:          req.RequestID,
				CacheHit:           true,
				TotalLatency:       time.Since(start),
			}, nil
		}
	}

	// BYOK: if per-request credentials are provided, create an ephemeral provider
	var provider providers.LLMProvider
	var routingLatency time.Duration
	if req.Credentials != nil {
		routingStart := time.Now()
		ephemeral, err := providers.CreateEphemeralProvider(req.Credentials, e.logger)
		routingLatency = time.Since(routingStart)
		if err != nil {
			e.logger.Error("Ephemeral provider creation failed",
				zap.Error(err),
				zap.String("request_id", req.RequestID),
				zap.String("provider", req.Credentials.Provider),
			)
			e.metrics.RecordError(req.Model, "ephemeral_provider_failed")
			return nil, fmt.Errorf("failed to create provider from credentials: %w", err)
		}
		provider = ephemeral
		e.logger.Info("Using ephemeral provider (BYOK)",
			zap.String("request_id", req.RequestID),
			zap.String("provider", req.Credentials.Provider),
		)
	} else {
		// Standard routing via registered providers
		var routingStart time.Time
		provider, routingStart = e.router.RouteRequest(ctx, req.CompletionRequest)
		routingLatency = time.Since(routingStart)
	}

	if provider == nil {
		err := fmt.Errorf("no suitable provider found for model %s", req.Model)
		e.logger.Error("Routing failed", zap.Error(err), zap.String("request_id", req.RequestID))
		e.metrics.RecordError(req.Model, "routing_failed")
		return nil, err
	}

	e.logger.Debug("Routed to provider",
		zap.String("request_id", req.RequestID),
		zap.String("provider", provider.Name()),
		zap.Duration("routing_latency", routingLatency),
	)

	// Skip circuit breaker for ephemeral BYOK providers — their failures
	// should not affect the global provider or other users' requests.
	isEphemeral := req.Credentials != nil

	if !isEphemeral && !e.circuitBreaker.CanExecute(provider.Name()) {
		err := fmt.Errorf("circuit breaker open for provider %s", provider.Name())
		e.logger.Warn("Circuit breaker open", zap.Error(err), zap.String("request_id", req.RequestID))
		e.metrics.RecordError(req.Model, "circuit_breaker_open")
		return nil, err
	}

	// Execute completion — ephemeral providers bypass circuit breaker protection
	var providerResp *providers.CompletionResponse
	var err error
	if isEphemeral {
		providerResp, err = provider.Complete(ctx, req.CompletionRequest)
	} else {
		providerResp, err = e.circuitBreaker.Execute(ctx, provider, req.CompletionRequest)
	}
	if err != nil {
		e.logger.Error("Completion failed",
			zap.Error(err),
			zap.String("request_id", req.RequestID),
			zap.String("provider", provider.Name()),
		)
		e.metrics.RecordError(req.Model, "completion_failed")
		return nil, err
	}

	// Cache successful response
	if cacheKey := req.getCacheKey(); cacheKey != "" {
		e.saveToCache(ctx, cacheKey, providerResp)
	}

	// Record metrics
	e.metrics.RecordCompletion(provider.Name(), req.Model, providerResp)
	e.metrics.RecordTokenUsage(req.ProjectID, req.UserID, req.Model, providerResp)
	e.metrics.RecordLatency(provider.Name(), req.Model, providerResp.Latency)

	totalLatency := time.Since(start)
	e.logger.Info("Completion succeeded",
		zap.String("request_id", req.RequestID),
		zap.String("provider", provider.Name()),
		zap.Int("output_tokens", providerResp.OutputTokens),
		zap.Duration("total_latency", totalLatency),
		zap.Duration("routing_latency", routingLatency),
	)

	return &CompletionResponse{
		CompletionResponse: providerResp,
		RequestID:          req.RequestID,
		UsedProvider:       provider.Name(),
		CacheHit:           false,
		TotalLatency:       totalLatency,
		RoutingLatency:     routingLatency,
	}, nil
}

// Stream processes a streaming completion request
func (e *Engine) Stream(ctx context.Context, req *CompletionRequest) (<-chan *StreamingChunk, error) {
	req.RequestID = fmt.Sprintf("stream-%d", time.Now().UnixNano())

	e.logger.Info("Processing stream request",
		zap.String("request_id", req.RequestID),
		zap.String("model", req.Model),
	)

	// BYOK: ephemeral provider from per-request credentials
	var provider providers.LLMProvider
	if req.Credentials != nil {
		ephemeral, err := providers.CreateEphemeralProvider(req.Credentials, e.logger)
		if err != nil {
			outChan := make(chan *StreamingChunk)
			close(outChan)
			return outChan, fmt.Errorf("failed to create provider from credentials: %w", err)
		}
		provider = ephemeral
	} else {
		provider, _ = e.router.RouteRequest(ctx, req.CompletionRequest)
	}
	if provider == nil {
		err := fmt.Errorf("no suitable provider found for model %s", req.Model)
		e.logger.Error("Routing failed", zap.Error(err), zap.String("request_id", req.RequestID))
		outChan := make(chan *StreamingChunk)
		close(outChan)
		return outChan, err
	}

	// Skip circuit breaker for ephemeral BYOK providers — their failures
	// should not affect the global provider or other users' requests.
	isEphemeral := req.Credentials != nil
	if !isEphemeral && !e.circuitBreaker.CanExecute(provider.Name()) {
		err := fmt.Errorf("circuit breaker open for provider %s", provider.Name())
		e.logger.Warn("Circuit breaker open", zap.Error(err), zap.String("request_id", req.RequestID))
		outChan := make(chan *StreamingChunk)
		close(outChan)
		return outChan, err
	}

	// Get stream from provider
	providerStream, err := provider.Stream(ctx, req.CompletionRequest)
	if err != nil {
		e.logger.Error("Stream setup failed",
			zap.Error(err),
			zap.String("request_id", req.RequestID),
			zap.String("provider", provider.Name()),
		)
		outChan := make(chan *StreamingChunk)
		close(outChan)
		return outChan, err
	}

	// Multiplex and wrap stream
	out := make(chan *StreamingChunk)
	go e.multiplexStream(ctx, providerStream, out, req.RequestID, provider.Name())

	return out, nil
}

// multiplexStream multiplexes provider stream chunks into orchestrator stream chunks
func (e *Engine) multiplexStream(ctx context.Context, in <-chan *providers.StreamChunk, out chan *StreamingChunk, requestID, providerName string) {
	defer close(out)

	totalTokens := 0
	start := time.Now()

	for {
		select {
		case chunk, ok := <-in:
			if !ok {
				out <- &StreamingChunk{
					RequestID:    requestID,
					Provider:     providerName,
					FinishReason: "stop",
					TotalTokens:  totalTokens,
					Latency:      time.Since(start),
				}
				return
			}

			if chunk.Error != "" {
				e.logger.Error("Stream error",
					zap.String("request_id", requestID),
					zap.String("error", chunk.Error),
				)
				out <- &StreamingChunk{
					RequestID: requestID,
					Error:     chunk.Error,
				}
				return
			}

			totalTokens += len(chunk.Delta)
			out <- &StreamingChunk{
				RequestID:       requestID,
				Provider:        providerName,
				Delta:           chunk.Delta,
				Index:           chunk.Index,
				AdvisorThinking: chunk.AdvisorThinking,
			}

		case <-ctx.Done():
			e.logger.Warn("Stream context cancelled", zap.String("request_id", requestID))
			return
		}
	}
}

// StreamingChunk represents a chunk of streaming data
type StreamingChunk struct {
	RequestID       string
	Provider        string
	Delta           string
	Index           int
	FinishReason    string
	TotalTokens     int
	Latency         time.Duration
	Error           string
	AdvisorThinking bool // keepalive signal during advisor (Opus) sub-inference
}

// getCacheKey generates a SHA256-based cache key for a request.
// Returns empty string for requests that should not be cached:
// streaming, tool-calling, or empty messages.
func (cr *CompletionRequest) getCacheKey() string {
	if cr.Stream {
		return ""
	}
	if len(cr.Messages) == 0 {
		return ""
	}
	// Don't cache tool-calling requests — responses are non-deterministic
	if len(cr.Tools) > 0 {
		return ""
	}
	// Don't cache BYOK/ephemeral requests — different credentials mean
	// different accounts, and we must not leak responses across users.
	if cr.Credentials != nil {
		return ""
	}

	h := sha256.New()
	h.Write([]byte(cr.Model))
	h.Write([]byte(fmt.Sprintf("t=%.2f,p=%.2f,think=%v", cr.Temperature, cr.TopP, cr.ExtendedThinking)))
	for _, s := range cr.Stop {
		h.Write([]byte("stop:" + s))
	}
	if cr.ResponseFormat != nil {
		h.Write([]byte(fmt.Sprintf("rf=%s", cr.ResponseFormat.Type)))
	}
	for _, msg := range cr.Messages {
		h.Write([]byte(msg.Role))
		h.Write([]byte(msg.Content))
	}
	return fmt.Sprintf("llm:cache:%x", h.Sum(nil))
}

// getFromCache retrieves a cached completion response from Redis.
func (e *Engine) getFromCache(ctx context.Context, key string) (*providers.CompletionResponse, error) {
	if e.cache == nil {
		return nil, nil
	}
	data, err := e.cache.Get(ctx, key).Bytes()
	if err != nil {
		return nil, nil // includes redis.Nil — treat as miss
	}
	var resp providers.CompletionResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		e.logger.Warn("Cache unmarshal failed", zap.Error(err))
		return nil, nil
	}
	return &resp, nil
}

// saveToCache stores a completion response in Redis with TTL.
// Skips tool-calling responses since they're non-deterministic.
func (e *Engine) saveToCache(ctx context.Context, key string, resp *providers.CompletionResponse) {
	if e.cache == nil {
		return
	}
	if len(resp.ToolCalls) > 0 {
		return
	}
	data, err := json.Marshal(resp)
	if err != nil {
		e.logger.Warn("Cache marshal failed", zap.Error(err))
		return
	}
	if err := e.cache.Set(ctx, key, data, e.cacheTTL).Err(); err != nil {
		e.logger.Warn("Cache save failed", zap.Error(err), zap.String("key", key))
	}
}

// GetHealth returns the health status of all providers
func (e *Engine) GetHealth() map[string]providers.ProviderHealth {
	return e.registry.GetHealth()
}

// ListModels returns all available models
func (e *Engine) ListModels() map[string]providers.ModelInfo {
	return e.registry.ListModels()
}
