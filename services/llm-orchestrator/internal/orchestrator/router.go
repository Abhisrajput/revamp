package orchestrator

import (
	"context"
	"time"

	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"go.uber.org/zap"
)

// Router handles intelligent request routing across providers
type Router struct {
	registry *providers.Registry
	logger   *zap.Logger
}

// NewRouter creates a new request router
func NewRouter(registry *providers.Registry, logger *zap.Logger) *Router {
	return &Router{
		registry: registry,
		logger:   logger,
	}
}

// RouteRequest selects the best provider for a given request
func (r *Router) RouteRequest(ctx context.Context, req *providers.CompletionRequest) (providers.LLMProvider, time.Time) {
	start := time.Now()

	// First, try to find a provider that supports the requested model
	provider, err := r.registry.GetByModel(req.Model)
	if err == nil && provider.GetHealth().Healthy {
		return provider, start
	}

	// Fall back to the balancer to select best available provider
	availableProviders := r.registry.GetAvailable()
	if len(availableProviders) == 0 {
		r.logger.Error("No available providers")
		return nil, start
	}

	// Use first available provider for now
	// In production, would use more sophisticated selection
	return availableProviders[0], start
}

// SelectProvider selects the best provider based on multiple factors
func (r *Router) SelectProvider(providers []providers.LLMProvider, model string) providers.LLMProvider {
	// Score providers based on:
	// 1. Model support
	// 2. Health status
	// 3. Recent latency
	// 4. Error rate

	if len(providers) == 0 {
		return nil
	}

	// Simple selection: return first healthy provider that supports the model
	for _, p := range providers {
		if p.SupportsModel(model) && p.GetHealth().Healthy {
			return p
		}
	}

	// If no provider supports the model, return first healthy one
	for _, p := range providers {
		if p.GetHealth().Healthy {
			return p
		}
	}

	// If no healthy provider, return first one (fallback)
	return providers[0]
}
