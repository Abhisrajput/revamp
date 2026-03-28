package orchestrator

import (
	"context"
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
		metrics:        metricsRegistry,
		logger:         logger,
		router:         NewRouter(registry, logger),
		balancer:       NewLoadBalancer(registry),
		circuitBreaker: NewCircuitBreaker(registry, logger),
	}
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

	// Route request to best provider
	provider, routingStart := e.router.RouteRequest(ctx, req.CompletionRequest)
	routingLatency := time.Since(routingStart)

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

	// Check circuit breaker
	if !e.circuitBreaker.CanExecute(provider.Name()) {
		err := fmt.Errorf("circuit breaker open for provider %s", provider.Name())
		e.logger.Warn("Circuit breaker open", zap.Error(err), zap.String("request_id", req.RequestID))
		e.metrics.RecordError(req.Model, "circuit_breaker_open")
		return nil, err
	}

	// Execute completion with circuit breaker protection
	providerResp, err := e.circuitBreaker.Execute(ctx, provider, req.CompletionRequest)
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

	// Route request to best provider
	provider, _ := e.router.RouteRequest(ctx, req.CompletionRequest)
	if provider == nil {
		err := fmt.Errorf("no suitable provider found for model %s", req.Model)
		e.logger.Error("Routing failed", zap.Error(err), zap.String("request_id", req.RequestID))
		outChan := make(chan *StreamingChunk)
		close(outChan)
		return outChan, err
	}

	// Check circuit breaker
	if !e.circuitBreaker.CanExecute(provider.Name()) {
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
				RequestID: requestID,
				Provider:  providerName,
				Delta:     chunk.Delta,
				Index:     chunk.Index,
			}

		case <-ctx.Done():
			e.logger.Warn("Stream context cancelled", zap.String("request_id", requestID))
			return
		}
	}
}

// StreamingChunk represents a chunk of streaming data
type StreamingChunk struct {
	RequestID    string
	Provider     string
	Delta        string
	Index        int
	FinishReason string
	TotalTokens  int
	Latency      time.Duration
	Error        string
}

// getCacheKey generates a cache key for a request
func (cr *CompletionRequest) getCacheKey() string {
	if cr.Stream {
		return "" // Don't cache streaming requests
	}

	// Simple cache key based on model and messages hash
	// In production, implement proper hashing
	if len(cr.Messages) == 0 {
		return ""
	}

	return fmt.Sprintf("llm:cache:%s:%s", cr.Model, cr.ProjectID)
}

// getFromCache retrieves a cached completion response
func (e *Engine) getFromCache(ctx context.Context, key string) (*providers.CompletionResponse, error) {
	// Implement cache retrieval
	return nil, nil // For now, always miss
}

// saveToCache saves a completion response to cache
func (e *Engine) saveToCache(ctx context.Context, key string, resp *providers.CompletionResponse) {
	// Implement cache saving with TTL
}

// GetHealth returns the health status of all providers
func (e *Engine) GetHealth() map[string]providers.ProviderHealth {
	return e.registry.GetHealth()
}

// ListModels returns all available models
func (e *Engine) ListModels() map[string]providers.ModelInfo {
	return e.registry.ListModels()
}
