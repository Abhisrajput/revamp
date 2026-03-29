package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"github.com/revamp-io/llm-orchestrator/internal/config"
	"github.com/revamp-io/llm-orchestrator/internal/metrics"
	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/queue"
	"go.uber.org/zap"
)

// Server represents the HTTP server
type Server struct {
	Router     *chi.Mux
	config     *config.Config
	engine     *orchestrator.Engine
	workerPool *queue.WorkerPool
	redis      *redis.Client
	metrics    *metrics.Registry
	logger     *zap.Logger
}

// NewServer creates a new HTTP server
func NewServer(
	cfg *config.Config,
	engine *orchestrator.Engine,
	workerPool *queue.WorkerPool,
	redis *redis.Client,
	metricsRegistry *metrics.Registry,
	logger *zap.Logger,
) *Server {
	s := &Server{
		config:     cfg,
		engine:     engine,
		workerPool: workerPool,
		redis:      redis,
		metrics:    metricsRegistry,
		logger:     logger,
	}

	s.Router = s.setupRouter()
	return s
}

// setupRouter sets up the Chi router with all routes
func (s *Server) setupRouter() *chi.Mux {
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(900 * time.Second)) // 15 min for slow MoE models like Qwen3

	// CORS
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"X-Total-Count", "X-Request-ID"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health check
	r.Get("/health", s.handleHealth)
	r.Get("/ready", s.handleReady)

	// Metrics
	r.Handle("/metrics", promhttp.Handler())

	// API v1
	r.Route("/api/v1", func(r chi.Router) {
		// Auth middleware
		r.Use(s.authMiddleware)
		r.Use(s.rateLimitMiddleware)

		// Completions
		r.Post("/completions", s.handleCompletion)
		r.Post("/completions/stream", s.handleStreamCompletion)

		// Chat
		r.Post("/chat/completions", s.handleChatCompletion)
		r.Post("/chat/completions/stream", s.handleChatStreamCompletion)

		// Batch
		r.Post("/batch", s.handleBatch)
		r.Get("/batch/{jobID}", s.handleGetBatchStatus)

		// Models
		r.Get("/models", s.handleListModels)
		r.Get("/models/{model}/info", s.handleGetModelInfo)

		// Usage
		r.Get("/usage/tokens", s.handleGetTokenUsage)
		r.Get("/usage/cost", s.handleGetCostUsage)
		r.Get("/usage/quota", s.handleGetQuotaStatus)

		// Health
		r.Get("/providers/health", s.handleProvidersHealth)
	})

	// API v2 — Engine endpoints (tasks, tools, budget, context)
	r.Route("/api/v2", func(r chi.Router) {
		r.Use(s.authMiddleware)

		// Task execution (stage orchestration)
		r.Post("/tasks/execute", s.handleTaskExecute)

		// Tool execution
		r.Post("/tools/execute", s.handleToolExecute)
		r.Post("/tools/loop", s.handleToolLoop)
		r.Get("/tools", s.handleListTools)

		// Budget enforcement
		r.Post("/budget/check", s.handleBudgetCheck)
		r.Post("/budget/record", s.handleBudgetRecord)

		// Context management
		r.Post("/context/build", s.handleContextBuild)
		r.Post("/context/summarize", s.handleContextSummarize)
	})

	return r
}

// authMiddleware checks API key authentication
func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// In production, implement proper auth
		// For now, check for Authorization header
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" && s.config.APIKey != "" {
			http.Error(w, "Missing Authorization header", http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// rateLimitMiddleware implements rate limiting
func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// In production, implement proper rate limiting using Redis
		// For now, just pass through
		next.ServeHTTP(w, r)
	})
}

// handleHealth handles the health check endpoint
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"healthy"}`))
}

// handleReady handles the readiness check endpoint
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	// Check if dependencies are available
	health := s.engine.GetHealth()

	healthy := false
	for _, h := range health {
		if h.Healthy {
			healthy = true
			break
		}
	}

	if !healthy {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"status":"not_ready"}`))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ready"}`))
}
