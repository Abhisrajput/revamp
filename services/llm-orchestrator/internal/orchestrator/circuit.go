package orchestrator

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"go.uber.org/zap"
)

// CircuitBreakerState represents the state of the circuit breaker
type CircuitBreakerState int

const (
	StateClosed CircuitBreakerState = iota
	StateOpen
	StateHalfOpen
)

// CircuitBreakerConfig holds configuration for the circuit breaker
type CircuitBreakerConfig struct {
	FailureThreshold int
	SuccessThreshold int
	Timeout          time.Duration
}

// ProviderCircuitBreaker tracks circuit breaker state for a provider
type ProviderCircuitBreaker struct {
	state            CircuitBreakerState
	failureCount     int
	successCount     int
	lastFailureTime  time.Time
	config           CircuitBreakerConfig
	mu               sync.RWMutex
}

// CircuitBreaker manages circuit breakers for all providers
type CircuitBreaker struct {
	breakers map[string]*ProviderCircuitBreaker
	logger   *zap.Logger
	mu       sync.RWMutex
	registry *providers.Registry
}

// NewCircuitBreaker creates a new circuit breaker manager
func NewCircuitBreaker(registry *providers.Registry, logger *zap.Logger) *CircuitBreaker {
	return &CircuitBreaker{
		breakers: make(map[string]*ProviderCircuitBreaker),
		logger:   logger,
		registry: registry,
	}
}

// CanExecute checks if a request can be executed against a provider
func (cb *CircuitBreaker) CanExecute(providerName string) bool {
	breaker := cb.getOrCreateBreaker(providerName)
	breaker.mu.Lock()
	defer breaker.mu.Unlock()

	switch breaker.state {
	case StateClosed:
		return true
	case StateOpen:
		// Check if timeout has elapsed — transition to half-open
		if time.Since(breaker.lastFailureTime) > breaker.config.Timeout {
			breaker.state = StateHalfOpen
			return true
		}
		return false
	case StateHalfOpen:
		return true
	default:
		return true
	}
}

// Execute executes a request with circuit breaker protection and per-request
// exponential backoff retry. Retries up to 3 times with delays of 2s, 4s, 8s
// for transient errors (rate limits, overloaded, network). Non-retryable errors
// (auth, quota) fail immediately.
func (cb *CircuitBreaker) Execute(ctx context.Context, provider providers.LLMProvider, req *providers.CompletionRequest) (*providers.CompletionResponse, error) {
	_ = cb.getOrCreateBreaker(provider.Name())

	// Check if we can execute
	if !cb.CanExecute(provider.Name()) {
		return nil, fmt.Errorf("circuit breaker open for provider %s", provider.Name())
	}

	const maxRetries = 3
	var lastErr error

	for attempt := 0; attempt <= maxRetries; attempt++ {
		resp, err := provider.Complete(ctx, req)
		if err == nil {
			cb.recordSuccess(provider.Name())
			return resp, nil
		}

		lastErr = err

		// Check if error is retryable
		if !isRetryableError(err) || attempt >= maxRetries {
			cb.recordFailure(provider.Name())
			return nil, err
		}

		// Exponential backoff: 2s, 4s, 8s
		backoff := time.Duration(2<<uint(attempt)) * time.Second
		cb.logger.Warn("Retrying after transient error",
			zap.String("provider", provider.Name()),
			zap.Int("attempt", attempt+1),
			zap.Duration("backoff", backoff),
			zap.Error(err),
		)

		select {
		case <-time.After(backoff):
			// continue to next attempt
		case <-ctx.Done():
			cb.recordFailure(provider.Name())
			return nil, ctx.Err()
		}
	}

	cb.recordFailure(provider.Name())
	return nil, lastErr
}

// isRetryableError determines if an LLM provider error is transient and
// should be retried. Rate limits, overload, and network errors are retryable.
// Auth, quota, and context-length errors are not.
func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	// Non-retryable: auth, quota, billing, context length
	for _, pattern := range []string{"invalid api key", "authentication", "unauthorized", "401", "403", "quota", "billing", "payment", "402", "context length", "too many tokens", "prompt is too long"} {
		if strings.Contains(msg, pattern) {
			return false
		}
	}
	// Retryable: rate limits, overload, network errors, server errors
	for _, pattern := range []string{"rate limit", "429", "overloaded", "529", "503", "502", "500", "timeout", "timed out", "network", "connection", "econnreset", "socket hang up", "gateway"} {
		if strings.Contains(msg, pattern) {
			return true
		}
	}
	// Default: retry unknown errors once
	return false
}

// recordFailure records a failed request
func (cb *CircuitBreaker) recordFailure(providerName string) {
	breaker := cb.getOrCreateBreaker(providerName)
	breaker.mu.Lock()
	defer breaker.mu.Unlock()

	breaker.failureCount++
	breaker.successCount = 0
	breaker.lastFailureTime = time.Now()

	if breaker.failureCount >= breaker.config.FailureThreshold {
		cb.logger.Warn("Circuit breaker opened",
			zap.String("provider", providerName),
			zap.Int("failure_count", breaker.failureCount),
		)
		breaker.state = StateOpen
	}
}

// recordSuccess records a successful request
func (cb *CircuitBreaker) recordSuccess(providerName string) {
	breaker := cb.getOrCreateBreaker(providerName)
	breaker.mu.Lock()
	defer breaker.mu.Unlock()

	breaker.successCount++
	breaker.failureCount = 0

	if breaker.state == StateHalfOpen && breaker.successCount >= breaker.config.SuccessThreshold {
		cb.logger.Info("Circuit breaker closed",
			zap.String("provider", providerName),
		)
		breaker.state = StateClosed
	}
}

// getOrCreateBreaker gets or creates a circuit breaker for a provider
func (cb *CircuitBreaker) getOrCreateBreaker(providerName string) *ProviderCircuitBreaker {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if breaker, ok := cb.breakers[providerName]; ok {
		return breaker
	}

	breaker := &ProviderCircuitBreaker{
		state:       StateClosed,
		config:      CircuitBreakerConfig{
			FailureThreshold: 5,
			SuccessThreshold: 3,
			Timeout:          60 * time.Second,
		},
	}
	cb.breakers[providerName] = breaker
	return breaker
}

// GetState returns the current state of a provider's circuit breaker
func (cb *CircuitBreaker) GetState(providerName string) CircuitBreakerState {
	breaker := cb.getOrCreateBreaker(providerName)
	breaker.mu.RLock()
	defer breaker.mu.RUnlock()
	return breaker.state
}

// Reset resets the circuit breaker for a provider
func (cb *CircuitBreaker) Reset(providerName string) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if breaker, ok := cb.breakers[providerName]; ok {
		breaker.mu.Lock()
		breaker.state = StateClosed
		breaker.failureCount = 0
		breaker.successCount = 0
		breaker.mu.Unlock()
		cb.logger.Info("Circuit breaker reset", zap.String("provider", providerName))
	}
}
