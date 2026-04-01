package metrics

import (
	"fmt"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
)

// Registry holds all Prometheus metrics
type Registry struct {
	requestCount        prometheus.CounterVec
	requestDuration     prometheus.HistogramVec
	tokenUsage          prometheus.CounterVec
	costTracking        prometheus.CounterVec
	cacheHits           prometheus.CounterVec
	cacheMisses         prometheus.CounterVec
	cacheSize           prometheus.GaugeVec
	circuitBreakerState prometheus.GaugeVec
	providerLatency     prometheus.HistogramVec
	providerErrors      prometheus.CounterVec
	smartRouteCount     prometheus.CounterVec
	rateLimitHits       prometheus.CounterVec
	mu                  sync.RWMutex
}

// NewRegistry creates a new metrics registry
func NewRegistry() *Registry {
	return &Registry{
		requestCount: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_requests_total",
				Help: "Total number of LLM requests",
			},
			[]string{"model", "provider", "status"},
		),
		requestDuration: *promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "llm_request_duration_seconds",
				Help:    "LLM request duration in seconds",
				Buckets: prometheus.ExponentialBuckets(0.1, 2, 10),
			},
			[]string{"model", "provider"},
		),
		tokenUsage: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_tokens_total",
				Help: "Total number of tokens used",
			},
			[]string{"model", "type"}, // type: input, output
		),
		costTracking: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_cost_total",
				Help: "Total cost of LLM requests in USD",
			},
			[]string{"model", "provider"},
		),
		cacheHits: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_cache_hits_total",
				Help: "Total number of cache hits",
			},
			[]string{"model"},
		),
		cacheSize: *promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "llm_cache_size_bytes",
				Help: "Current cache size in bytes",
			},
			[]string{"cache_type"},
		),
		circuitBreakerState: *promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "llm_circuit_breaker_state",
				Help: "Circuit breaker state (0=closed, 1=open, 2=half-open)",
			},
			[]string{"provider"},
		),
		providerLatency: *promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "llm_provider_latency_seconds",
				Help:    "Provider response latency in seconds",
				Buckets: prometheus.ExponentialBuckets(0.05, 2, 10),
			},
			[]string{"provider"},
		),
		providerErrors: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_provider_errors_total",
				Help: "Total number of provider errors",
			},
			[]string{"provider", "error_type"},
		),
		cacheMisses: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_cache_misses_total",
				Help: "Total number of cache misses",
			},
			[]string{"model"},
		),
		smartRouteCount: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_smart_route_total",
				Help: "Requests routed by smart model selection",
			},
			[]string{"tier", "selected_model"},
		),
		rateLimitHits: *promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "llm_rate_limit_hits_total",
				Help: "Requests rejected by rate limiter",
			},
			[]string{"key"},
		),
	}
}

// RecordCompletion records a successful completion request
func (r *Registry) RecordCompletion(provider, model string, resp *providers.CompletionResponse) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	r.requestCount.WithLabelValues(model, provider, "success").Inc()
	r.requestDuration.WithLabelValues(model, provider).Observe(resp.Latency.Seconds())
	r.costTracking.WithLabelValues(model, provider).Add(resp.Cost)
}

// RecordError records a failed request
func (r *Registry) RecordError(model string, errorType string) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	r.requestCount.WithLabelValues(model, "unknown", "error").Inc()
	r.providerErrors.WithLabelValues("unknown", errorType).Inc()
}

// RecordTokenUsage records token usage
func (r *Registry) RecordTokenUsage(projectID, userID, model string, resp *providers.CompletionResponse) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	r.tokenUsage.WithLabelValues(model, "input").Add(float64(resp.InputTokens))
	r.tokenUsage.WithLabelValues(model, "output").Add(float64(resp.OutputTokens))
}

// RecordLatency records provider latency
func (r *Registry) RecordLatency(provider, model string, duration time.Duration) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	r.providerLatency.WithLabelValues(provider).Observe(duration.Seconds())
}

// RecordCacheHit records a cache hit
func (r *Registry) RecordCacheHit(model string) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	r.cacheHits.WithLabelValues(model).Inc()
}

// RecordCacheMiss records a cache miss
func (r *Registry) RecordCacheMiss(model string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	r.cacheMisses.WithLabelValues(model).Inc()
}

// RecordSmartRoute records a smart routing decision
func (r *Registry) RecordSmartRoute(tier, selectedModel string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	r.smartRouteCount.WithLabelValues(tier, selectedModel).Inc()
}

// SetCircuitBreakerState sets the circuit breaker state
func (r *Registry) SetCircuitBreakerState(provider string, state int) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	r.circuitBreakerState.WithLabelValues(provider).Set(float64(state))
}

// GetMetrics returns all metrics as strings
func (r *Registry) GetMetrics() (string, error) {
	gather, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		return "", fmt.Errorf("failed to gather metrics: %w", err)
	}

	output := ""
	for _, mf := range gather {
		output += fmt.Sprintf("# HELP %s %s\n", mf.GetName(), mf.GetHelp())
		output += fmt.Sprintf("# TYPE %s %s\n", mf.GetName(), mf.GetType())

		for _, m := range mf.GetMetric() {
			output += fmt.Sprintf("%s ", mf.GetName())
			// Format labels (simplified)
			for _, label := range m.GetLabel() {
				output += fmt.Sprintf("%s=\"%s\",", label.GetName(), label.GetValue())
			}
			// Format value
			if m.GetGauge() != nil {
				output += fmt.Sprintf(" %v\n", m.GetGauge().GetValue())
			} else if m.GetCounter() != nil {
				output += fmt.Sprintf(" %v\n", m.GetCounter().GetValue())
			}
		}
	}

	return output, nil
}

// TokenMetrics tracks token usage
type TokenMetrics struct {
	ProjectID     string
	UserID        string
	Model         string
	InputTokens   int
	OutputTokens  int
	Cost          float64
	Timestamp     time.Time
}

// CostMetrics tracks cost information
type CostMetrics struct {
	Provider      string
	Model         string
	InputTokens   int
	OutputTokens  int
	CostPerInput  float64
	CostPerOutput float64
	TotalCost     float64
	Timestamp     time.Time
}

// CalculateCost calculates the cost of a completion
func CalculateCost(model string, inputTokens, outputTokens int) float64 {
	costs := map[string][2]float64{
		"gpt-4-turbo": {0.01 / 1000, 0.03 / 1000},
		"gpt-4": {0.03 / 1000, 0.06 / 1000},
		"gpt-3.5-turbo": {0.0005 / 1000, 0.0015 / 1000},
		"claude-3-opus-20240229": {0.015 / 1000, 0.075 / 1000},
		"claude-3-sonnet-20240229": {0.003 / 1000, 0.015 / 1000},
		"gemini-2.0-flash": {0.075 / 1000000, 0.30 / 1000000},
	}

	if costs, ok := costs[model]; ok {
		return float64(inputTokens)*costs[0] + float64(outputTokens)*costs[1]
	}

	return 0.0
}
