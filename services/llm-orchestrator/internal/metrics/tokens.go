package metrics

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// TokenTracker tracks token usage per project and user
type TokenTracker struct {
	redis *redis.Client
	mu    sync.RWMutex
}

// NewTokenTracker creates a new token tracker
func NewTokenTracker(redis *redis.Client) *TokenTracker {
	return &TokenTracker{
		redis: redis,
	}
}

// TokenUsage represents token usage statistics
type TokenUsage struct {
	ProjectID       string
	UserID          string
	Model           string
	InputTokens     int64
	OutputTokens    int64
	TotalTokens     int64
	RequestCount    int64
	AverageTokens   float64
	Cost            float64
	LastUpdated     time.Time
}

// RecordUsage records token usage for a project/user
func (tt *TokenTracker) RecordUsage(ctx context.Context, projectID, userID, model string, inputTokens, outputTokens int) error {
	tt.mu.Lock()
	defer tt.mu.Unlock()

	totalTokens := inputTokens + outputTokens

	// Update project-level counters
	projectKey := fmt.Sprintf("tokens:project:%s", projectID)
	tt.redis.IncrBy(ctx, projectKey+":input", int64(inputTokens))
	tt.redis.IncrBy(ctx, projectKey+":output", int64(outputTokens))
	tt.redis.IncrBy(ctx, projectKey+":total", int64(totalTokens))
	tt.redis.Incr(ctx, projectKey+":requests")

	// Update user-level counters
	userKey := fmt.Sprintf("tokens:user:%s", userID)
	tt.redis.IncrBy(ctx, userKey+":input", int64(inputTokens))
	tt.redis.IncrBy(ctx, userKey+":output", int64(outputTokens))
	tt.redis.IncrBy(ctx, userKey+":total", int64(totalTokens))
	tt.redis.Incr(ctx, userKey+":requests")

	// Update model-level counters
	modelKey := fmt.Sprintf("tokens:model:%s", model)
	tt.redis.IncrBy(ctx, modelKey+":input", int64(inputTokens))
	tt.redis.IncrBy(ctx, modelKey+":output", int64(outputTokens))
	tt.redis.IncrBy(ctx, modelKey+":total", int64(totalTokens))

	// Set expiry (30 days)
	tt.redis.Expire(ctx, projectKey+":input", 30*24*time.Hour)
	tt.redis.Expire(ctx, projectKey+":output", 30*24*time.Hour)
	tt.redis.Expire(ctx, projectKey+":total", 30*24*time.Hour)
	tt.redis.Expire(ctx, projectKey+":requests", 30*24*time.Hour)

	return nil
}

// GetProjectUsage retrieves token usage for a project
func (tt *TokenTracker) GetProjectUsage(ctx context.Context, projectID string) (*TokenUsage, error) {
	tt.mu.RLock()
	defer tt.mu.RUnlock()

	projectKey := fmt.Sprintf("tokens:project:%s", projectID)

	input, _ := tt.redis.Get(ctx, projectKey+":input").Int64()
	output, _ := tt.redis.Get(ctx, projectKey+":output").Int64()
	total, _ := tt.redis.Get(ctx, projectKey+":total").Int64()
	requests, _ := tt.redis.Get(ctx, projectKey+":requests").Int64()

	avgTokens := 0.0
	if requests > 0 {
		avgTokens = float64(total) / float64(requests)
	}

	return &TokenUsage{
		ProjectID:     projectID,
		InputTokens:   input,
		OutputTokens:  output,
		TotalTokens:   total,
		RequestCount:  requests,
		AverageTokens: avgTokens,
		LastUpdated:   time.Now(),
	}, nil
}

// GetUserUsage retrieves token usage for a user
func (tt *TokenTracker) GetUserUsage(ctx context.Context, userID string) (*TokenUsage, error) {
	tt.mu.RLock()
	defer tt.mu.RUnlock()

	userKey := fmt.Sprintf("tokens:user:%s", userID)

	input, _ := tt.redis.Get(ctx, userKey+":input").Int64()
	output, _ := tt.redis.Get(ctx, userKey+":output").Int64()
	total, _ := tt.redis.Get(ctx, userKey+":total").Int64()
	requests, _ := tt.redis.Get(ctx, userKey+":requests").Int64()

	avgTokens := 0.0
	if requests > 0 {
		avgTokens = float64(total) / float64(requests)
	}

	return &TokenUsage{
		UserID:        userID,
		InputTokens:   input,
		OutputTokens:  output,
		TotalTokens:   total,
		RequestCount:  requests,
		AverageTokens: avgTokens,
		LastUpdated:   time.Now(),
	}, nil
}

// GetModelUsage retrieves token usage for a model
func (tt *TokenTracker) GetModelUsage(ctx context.Context, model string) (*TokenUsage, error) {
	tt.mu.RLock()
	defer tt.mu.RUnlock()

	modelKey := fmt.Sprintf("tokens:model:%s", model)

	input, _ := tt.redis.Get(ctx, modelKey+":input").Int64()
	output, _ := tt.redis.Get(ctx, modelKey+":output").Int64()
	total, _ := tt.redis.Get(ctx, modelKey+":total").Int64()

	return &TokenUsage{
		Model:        model,
		InputTokens:  input,
		OutputTokens: output,
		TotalTokens:  total,
		LastUpdated:  time.Now(),
	}, nil
}

// GetPeriodUsage retrieves usage for a specific time period
func (tt *TokenTracker) GetPeriodUsage(ctx context.Context, projectID string, startTime, endTime time.Time) (*TokenUsage, error) {
	// For production, implement time-series bucketing in Redis
	// This is a simplified version

	usage, err := tt.GetProjectUsage(ctx, projectID)
	if err != nil {
		return nil, err
	}

	return usage, nil
}

// ResetUsage resets usage counters
func (tt *TokenTracker) ResetUsage(ctx context.Context, projectID string) error {
	tt.mu.Lock()
	defer tt.mu.Unlock()

	projectKey := fmt.Sprintf("tokens:project:%s", projectID)

	tt.redis.Del(ctx, projectKey+":input")
	tt.redis.Del(ctx, projectKey+":output")
	tt.redis.Del(ctx, projectKey+":total")
	tt.redis.Del(ctx, projectKey+":requests")

	return nil
}

// GetQuotaStatus returns quota usage status
func (tt *TokenTracker) GetQuotaStatus(ctx context.Context, projectID string, quotaLimit int64) (QuotaStatus, error) {
	usage, err := tt.GetProjectUsage(ctx, projectID)
	if err != nil {
		return QuotaStatus{}, err
	}

	percentage := float64(usage.TotalTokens) / float64(quotaLimit) * 100
	remaining := quotaLimit - usage.TotalTokens

	return QuotaStatus{
		ProjectID:        projectID,
		TokensUsed:       usage.TotalTokens,
		TokensRemaining:  remaining,
		QuotaLimit:       quotaLimit,
		UsagePercentage:  percentage,
		LastUpdated:      time.Now(),
	}, nil
}

// QuotaStatus represents quota usage information
type QuotaStatus struct {
	ProjectID       string
	TokensUsed      int64
	TokensRemaining int64
	QuotaLimit      int64
	UsagePercentage float64
	LastUpdated     time.Time
}

// IsQuotaExceeded checks if quota is exceeded
func (qs QuotaStatus) IsQuotaExceeded() bool {
	return qs.TokensUsed > qs.QuotaLimit
}

// GetAvailableTokens returns the number of available tokens
func (qs QuotaStatus) GetAvailableTokens() int64 {
	if qs.TokensRemaining < 0 {
		return 0
	}
	return qs.TokensRemaining
}
