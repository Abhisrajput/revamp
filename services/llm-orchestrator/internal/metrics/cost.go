package metrics

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// CostTracker tracks costs per project and user
type CostTracker struct {
	redis *redis.Client
	mu    sync.RWMutex
}

// NewCostTracker creates a new cost tracker
func NewCostTracker(redis *redis.Client) *CostTracker {
	return &CostTracker{
		redis: redis,
	}
}

// CostBreakdown represents cost statistics
type CostBreakdown struct {
	ProjectID       string
	UserID          string
	Model           string
	TotalCost       float64
	InputCost       float64
	OutputCost      float64
	RequestCount    int64
	AverageCost     float64
	CostTrend       []DailyCost
	LastUpdated     time.Time
}

// DailyCost represents daily cost breakdown
type DailyCost struct {
	Date      string
	Cost      float64
	Requests  int64
}

// RecordCost records the cost of a request
func (ct *CostTracker) RecordCost(ctx context.Context, projectID, userID, model, provider string, inputTokens, outputTokens int, cost float64) error {
	ct.mu.Lock()
	defer ct.mu.Unlock()

	// Calculate costs (guard against division by zero)
	var inputCost, outputCost float64
	if totalTokens := inputTokens + outputTokens; totalTokens > 0 {
		inputCost = cost * (float64(inputTokens) / float64(totalTokens))
		outputCost = cost - inputCost
	}

	// Update project-level cost
	projectKey := fmt.Sprintf("cost:project:%s", projectID)
	ct.redis.IncrByFloat(ctx, projectKey+":total", cost)
	ct.redis.IncrByFloat(ctx, projectKey+":input", inputCost)
	ct.redis.IncrByFloat(ctx, projectKey+":output", outputCost)
	ct.redis.Incr(ctx, projectKey+":requests")

	// Update user-level cost
	userKey := fmt.Sprintf("cost:user:%s", userID)
	ct.redis.IncrByFloat(ctx, userKey+":total", cost)
	ct.redis.IncrByFloat(ctx, userKey+":input", inputCost)
	ct.redis.IncrByFloat(ctx, userKey+":output", outputCost)
	ct.redis.Incr(ctx, userKey+":requests")

	// Update model-level cost
	modelKey := fmt.Sprintf("cost:model:%s", model)
	ct.redis.IncrByFloat(ctx, modelKey+":total", cost)

	// Update provider-level cost
	providerKey := fmt.Sprintf("cost:provider:%s", provider)
	ct.redis.IncrByFloat(ctx, providerKey+":total", cost)

	// Update daily breakdown
	today := time.Now().Format("2006-01-02")
	dailyKey := fmt.Sprintf("cost:daily:%s:%s", projectID, today)
	ct.redis.IncrByFloat(ctx, dailyKey+":total", cost)
	ct.redis.Incr(ctx, dailyKey+":requests")

	// Set expiry
	ct.redis.Expire(ctx, projectKey+":total", 90*24*time.Hour)
	ct.redis.Expire(ctx, projectKey+":input", 90*24*time.Hour)
	ct.redis.Expire(ctx, projectKey+":output", 90*24*time.Hour)
	ct.redis.Expire(ctx, projectKey+":requests", 90*24*time.Hour)

	return nil
}

// GetProjectCost retrieves cost breakdown for a project
func (ct *CostTracker) GetProjectCost(ctx context.Context, projectID string) (*CostBreakdown, error) {
	ct.mu.RLock()
	defer ct.mu.RUnlock()

	projectKey := fmt.Sprintf("cost:project:%s", projectID)

	total, _ := ct.redis.Get(ctx, projectKey+":total").Float64()
	input, _ := ct.redis.Get(ctx, projectKey+":input").Float64()
	output, _ := ct.redis.Get(ctx, projectKey+":output").Float64()
	requests, _ := ct.redis.Get(ctx, projectKey+":requests").Int64()

	avgCost := 0.0
	if requests > 0 {
		avgCost = total / float64(requests)
	}

	return &CostBreakdown{
		ProjectID:   projectID,
		TotalCost:   total,
		InputCost:   input,
		OutputCost:  output,
		RequestCount: requests,
		AverageCost: avgCost,
		LastUpdated: time.Now(),
	}, nil
}

// GetUserCost retrieves cost breakdown for a user
func (ct *CostTracker) GetUserCost(ctx context.Context, userID string) (*CostBreakdown, error) {
	ct.mu.RLock()
	defer ct.mu.RUnlock()

	userKey := fmt.Sprintf("cost:user:%s", userID)

	total, _ := ct.redis.Get(ctx, userKey+":total").Float64()
	input, _ := ct.redis.Get(ctx, userKey+":input").Float64()
	output, _ := ct.redis.Get(ctx, userKey+":output").Float64()
	requests, _ := ct.redis.Get(ctx, userKey+":requests").Int64()

	avgCost := 0.0
	if requests > 0 {
		avgCost = total / float64(requests)
	}

	return &CostBreakdown{
		UserID:       userID,
		TotalCost:    total,
		InputCost:    input,
		OutputCost:   output,
		RequestCount: requests,
		AverageCost:  avgCost,
		LastUpdated:  time.Now(),
	}, nil
}

// GetModelCost retrieves cost for a model
func (ct *CostTracker) GetModelCost(ctx context.Context, model string) (float64, error) {
	ct.mu.RLock()
	defer ct.mu.RUnlock()

	modelKey := fmt.Sprintf("cost:model:%s", model)
	total, err := ct.redis.Get(ctx, modelKey+":total").Float64()
	if err != nil {
		return 0, err
	}

	return total, nil
}

// GetProviderCost retrieves cost for a provider
func (ct *CostTracker) GetProviderCost(ctx context.Context, provider string) (float64, error) {
	ct.mu.RLock()
	defer ct.mu.RUnlock()

	providerKey := fmt.Sprintf("cost:provider:%s", provider)
	total, err := ct.redis.Get(ctx, providerKey+":total").Float64()
	if err != nil {
		return 0, err
	}

	return total, nil
}

// GetDailyCosts retrieves daily cost breakdown for a project
func (ct *CostTracker) GetDailyCosts(ctx context.Context, projectID string, days int) ([]DailyCost, error) {
	ct.mu.RLock()
	defer ct.mu.RUnlock()

	costs := make([]DailyCost, 0, days)

	for i := 0; i < days; i++ {
		date := time.Now().AddDate(0, 0, -i).Format("2006-01-02")
		dailyKey := fmt.Sprintf("cost:daily:%s:%s", projectID, date)

		total, _ := ct.redis.Get(ctx, dailyKey+":total").Float64()
		requests, _ := ct.redis.Get(ctx, dailyKey+":requests").Int64()

		if total > 0 || requests > 0 {
			costs = append(costs, DailyCost{
				Date:     date,
				Cost:     total,
				Requests: requests,
			})
		}
	}

	return costs, nil
}

// GetBudgetStatus returns budget usage status
func (ct *CostTracker) GetBudgetStatus(ctx context.Context, projectID string, budgetLimit float64) (BudgetStatus, error) {
	breakdown, err := ct.GetProjectCost(ctx, projectID)
	if err != nil {
		return BudgetStatus{}, err
	}

	percentage := (breakdown.TotalCost / budgetLimit) * 100
	remaining := budgetLimit - breakdown.TotalCost

	return BudgetStatus{
		ProjectID:       projectID,
		TotalSpent:      breakdown.TotalCost,
		BudgetLimit:     budgetLimit,
		Remaining:       remaining,
		UsagePercentage: percentage,
		IsExceeded:      breakdown.TotalCost > budgetLimit,
		LastUpdated:     time.Now(),
	}, nil
}

// BudgetStatus represents budget usage information
type BudgetStatus struct {
	ProjectID       string
	TotalSpent      float64
	BudgetLimit     float64
	Remaining       float64
	UsagePercentage float64
	IsExceeded      bool
	LastUpdated     time.Time
}

// GetCostEstimate estimates cost for a request
func GetCostEstimate(model string, estimatedTokens int) float64 {
	// Estimated costs per 1k tokens
	costs := map[string][2]float64{
		"gpt-4-turbo": {10, 30},
		"gpt-4": {30, 60},
		"gpt-3.5-turbo": {0.5, 1.5},
		"claude-3-opus-20240229": {15, 75},
		"claude-3-sonnet-20240229": {3, 15},
		"gemini-2.0-flash": {0.075, 0.30},
	}

	if cost, ok := costs[model]; ok {
		// Assume 70% input, 30% output
		avgCost := (cost[0] * 0.7) + (cost[1] * 0.3)
		return (avgCost / 1000) * float64(estimatedTokens)
	}

	return 0.0
}
