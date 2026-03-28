package orchestrator

import (
	"sync"
	"time"

	"github.com/revamp-io/llm-orchestrator/internal/providers"
)

// LoadBalancer distributes requests across providers using weighted round-robin and latency awareness
type LoadBalancer struct {
	registry    *providers.Registry
	weights     map[string]int
	currentIdx  int
	latencies   map[string][]time.Duration
	mu          sync.RWMutex
	maxSamples  int
}

// NewLoadBalancer creates a new load balancer
func NewLoadBalancer(registry *providers.Registry) *LoadBalancer {
	return &LoadBalancer{
		registry:   registry,
		weights:    make(map[string]int),
		latencies:  make(map[string][]time.Duration),
		maxSamples: 100,
	}
}

// SelectProvider selects the best provider using weighted round-robin
func (lb *LoadBalancer) SelectProvider(providerList []providers.LLMProvider) providers.LLMProvider {
	if len(providerList) == 0 {
		return nil
	}

	if len(providerList) == 1 {
		return providerList[0]
	}

	lb.mu.Lock()
	defer lb.mu.Unlock()

	// Simple round-robin selection
	lb.currentIdx = (lb.currentIdx + 1) % len(providerList)
	return providerList[lb.currentIdx]
}

// SelectProviderByLatency selects the provider with the lowest average latency
func (lb *LoadBalancer) SelectProviderByLatency(providerList []providers.LLMProvider) providers.LLMProvider {
	if len(providerList) == 0 {
		return nil
	}

	if len(providerList) == 1 {
		return providerList[0]
	}

	lb.mu.RLock()
	defer lb.mu.RUnlock()

	var best providers.LLMProvider
	var bestLatency time.Duration = time.Hour // Start with a large value

	for _, p := range providerList {
		avgLatency := lb.getAverageLatency(p.Name())
		if avgLatency < bestLatency {
			bestLatency = avgLatency
			best = p
		}
	}

	if best == nil && len(providerList) > 0 {
		best = providerList[0]
	}

	return best
}

// RecordLatency records the latency of a provider
func (lb *LoadBalancer) RecordLatency(providerName string, latency time.Duration) {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	if _, ok := lb.latencies[providerName]; !ok {
		lb.latencies[providerName] = make([]time.Duration, 0, lb.maxSamples)
	}

	lb.latencies[providerName] = append(lb.latencies[providerName], latency)

	// Keep only recent samples
	if len(lb.latencies[providerName]) > lb.maxSamples {
		lb.latencies[providerName] = lb.latencies[providerName][1:]
	}
}

// getAverageLatency calculates the average latency for a provider
func (lb *LoadBalancer) getAverageLatency(providerName string) time.Duration {
	latencies, ok := lb.latencies[providerName]
	if !ok || len(latencies) == 0 {
		return time.Duration(0)
	}

	var total time.Duration
	for _, l := range latencies {
		total += l
	}

	return total / time.Duration(len(latencies))
}

// GetWeights returns the current weights for all providers
func (lb *LoadBalancer) GetWeights() map[string]int {
	lb.mu.RLock()
	defer lb.mu.RUnlock()

	weights := make(map[string]int)
	for k, v := range lb.weights {
		weights[k] = v
	}
	return weights
}

// SetWeight sets the weight for a provider
func (lb *LoadBalancer) SetWeight(providerName string, weight int) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	lb.weights[providerName] = weight
}
