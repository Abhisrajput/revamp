package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// RateLimiter implements a Redis-backed sliding window rate limiter.
type RateLimiter struct {
	redis          *redis.Client
	requestsPerMin int
	logger         *zap.Logger
}

// NewRateLimiter creates a rate limiter. Pass nil redis for no-op mode.
func NewRateLimiter(redis *redis.Client, requestsPerMin int, logger *zap.Logger) *RateLimiter {
	return &RateLimiter{
		redis:          redis,
		requestsPerMin: requestsPerMin,
		logger:         logger,
	}
}

// Check tests whether a request from the given key is within the rate limit.
// Returns (allowed, retryAfter). Fails open on Redis errors.
func (rl *RateLimiter) Check(ctx context.Context, key string) (bool, time.Duration) {
	if rl.redis == nil || rl.requestsPerMin <= 0 {
		return true, 0
	}

	now := time.Now()
	windowStart := now.Add(-1 * time.Minute)
	redisKey := fmt.Sprintf("ratelimit:req:%s", key)

	pipe := rl.redis.Pipeline()
	pipe.ZRemRangeByScore(ctx, redisKey, "-inf", fmt.Sprintf("%d", windowStart.UnixMilli()))
	countCmd := pipe.ZCard(ctx, redisKey)
	pipe.ZAdd(ctx, redisKey, redis.Z{
		Score:  float64(now.UnixMilli()),
		Member: fmt.Sprintf("%d", now.UnixNano()),
	})
	pipe.Expire(ctx, redisKey, 2*time.Minute)

	if _, err := pipe.Exec(ctx); err != nil {
		rl.logger.Warn("Rate limiter Redis error, failing open", zap.Error(err))
		return true, 0 // fail open
	}

	count := countCmd.Val()
	if count >= int64(rl.requestsPerMin) {
		retryAfter := time.Minute - now.Sub(windowStart)
		if retryAfter < time.Second {
			retryAfter = time.Second
		}
		return false, retryAfter
	}

	return true, 0
}

// Middleware returns an http.Handler that enforces the rate limit.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract identity: API key or IP
		key := r.RemoteAddr
		if auth := r.Header.Get("Authorization"); len(auth) > 7 {
			key = auth[7:] // strip "Bearer "
		}

		allowed, retryAfter := rl.Check(r.Context(), key)
		if !allowed {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retryAfter.Seconds())))
			w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%d", rl.requestsPerMin))
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}
