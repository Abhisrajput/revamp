package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/revamp-io/llm-orchestrator/internal/orchestrator"
	"github.com/revamp-io/llm-orchestrator/internal/providers"
	"go.uber.org/zap"
)

// Job represents an async LLM job
type Job struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	UserID    string    `json:"user_id"`
	Model     string    `json:"model"`
	Messages  []Message `json:"messages"`
	Priority  int       `json:"priority"`
	Status    string    `json:"status"` // pending, processing, completed, failed
	Result    string    `json:"result"`
	Error     string    `json:"error"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Retries   int       `json:"retries"`
	MaxRetries int      `json:"max_retries"`
}

// Message represents a chat message for a job
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// WorkerPool manages a pool of workers processing async jobs
type WorkerPool struct {
	workerCount int
	redis       *redis.Client
	engine      *orchestrator.Engine
	logger      *zap.Logger
	workers     []*Worker
	done        chan struct{}
	wg          sync.WaitGroup
}

// Worker processes jobs from the queue
type Worker struct {
	id     int
	redis  *redis.Client
	engine *orchestrator.Engine
	logger *zap.Logger
	done   <-chan struct{}
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(count int, redis *redis.Client, engine *orchestrator.Engine, logger *zap.Logger) *WorkerPool {
	return &WorkerPool{
		workerCount: count,
		redis:       redis,
		engine:      engine,
		logger:      logger,
		workers:     make([]*Worker, count),
		done:        make(chan struct{}),
	}
}

// Start starts all workers
func (wp *WorkerPool) Start(ctx context.Context) {
	wp.logger.Info("Starting worker pool", zap.Int("worker_count", wp.workerCount))

	for i := 0; i < wp.workerCount; i++ {
		worker := &Worker{
			id:     i,
			redis:  wp.redis,
			engine: wp.engine,
			logger: wp.logger,
			done:   wp.done,
		}
		wp.workers[i] = worker

		wp.wg.Add(1)
		go worker.Run(ctx, &wp.wg)
	}
}

// Shutdown gracefully shuts down the worker pool
func (wp *WorkerPool) Shutdown(ctx context.Context) {
	wp.logger.Info("Shutting down worker pool")
	close(wp.done)
	wp.wg.Wait()
	wp.logger.Info("Worker pool shutdown complete")
}

// Run runs the worker
func (w *Worker) Run(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	w.logger.Debug("Worker started", zap.Int("worker_id", w.id))

	for {
		select {
		case <-w.done:
			w.logger.Debug("Worker stopping", zap.Int("worker_id", w.id))
			return
		default:
		}

		// Get next job from queue
		job, err := w.getNextJob(ctx)
		if err != nil {
			if err != context.Canceled {
				w.logger.Error("Failed to get next job", zap.Error(err), zap.Int("worker_id", w.id))
			}
			time.Sleep(1 * time.Second)
			continue
		}

		if job == nil {
			time.Sleep(1 * time.Second)
			continue
		}

		// Process job
		w.processJob(ctx, job)
	}
}

// getNextJob retrieves the next job from the priority queue
func (w *Worker) getNextJob(ctx context.Context) (*Job, error) {
	// Try to get from high priority queue first
	result, err := w.redis.BLPop(ctx, 1*time.Second, "queue:high-priority").Result()
	if err == redis.Nil {
		// Try medium priority
		result, err = w.redis.BLPop(ctx, 1*time.Second, "queue:medium-priority").Result()
	}
	if err == redis.Nil {
		// Try low priority
		result, err = w.redis.BLPop(ctx, 1*time.Second, "queue:low-priority").Result()
	}
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get job from queue: %w", err)
	}

	if len(result) < 2 {
		return nil, nil
	}

	// Parse job
	var job Job
	if err := json.Unmarshal([]byte(result[1]), &job); err != nil {
		return nil, fmt.Errorf("failed to unmarshal job: %w", err)
	}

	// Update job status
	job.Status = "processing"
	job.UpdatedAt = time.Now()
	w.saveJob(ctx, &job)

	return &job, nil
}

// processJob processes a single job
func (w *Worker) processJob(ctx context.Context, job *Job) {
	w.logger.Info("Processing job",
		zap.String("job_id", job.ID),
		zap.String("model", job.Model),
		zap.Int("worker_id", w.id),
	)

	start := time.Now()

	// Build orchestrator request
	messages := make([]providers.Message, len(job.Messages))
	for i, msg := range job.Messages {
		messages[i] = providers.Message{
			Role:    msg.Role,
			Content: msg.Content,
		}
	}

	req := &orchestrator.CompletionRequest{
		CompletionRequest: &providers.CompletionRequest{
			Model:       job.Model,
			Messages:    messages,
			MaxTokens:   2000,
			Temperature: 0.7,
		},
		ProjectID: job.ProjectID,
		UserID:    job.UserID,
		Priority:  job.Priority,
	}

	// Execute completion
	resp, err := w.engine.Complete(ctx, req)
	if err != nil {
		w.handleJobError(ctx, job, err)
		return
	}

	// Update job with result
	job.Status = "completed"
	job.Result = resp.Content
	job.UpdatedAt = time.Now()

	// Save result to Redis
	if err := w.saveJob(ctx, job); err != nil {
		w.logger.Error("Failed to save job result",
			zap.String("job_id", job.ID),
			zap.Error(err),
		)
		return
	}

	w.logger.Info("Job completed",
		zap.String("job_id", job.ID),
		zap.Duration("duration", time.Since(start)),
	)
}

// handleJobError handles job processing errors
func (w *Worker) handleJobError(ctx context.Context, job *Job, err error) {
	w.logger.Error("Job failed",
		zap.String("job_id", job.ID),
		zap.Error(err),
		zap.Int("retries", job.Retries),
	)

	job.Retries++

	// Retry if within max retries
	if job.Retries < job.MaxRetries {
		job.Status = "pending"
		job.UpdatedAt = time.Now()
		w.saveJob(ctx, job)

		// Re-queue with exponential backoff
		delay := time.Duration(1<<uint(job.Retries)) * time.Second
		w.redis.Expire(ctx, fmt.Sprintf("job:%s", job.ID), delay)
		w.logger.Info("Job requeued",
			zap.String("job_id", job.ID),
			zap.Duration("delay", delay),
		)
	} else {
		// Mark as failed
		job.Status = "failed"
		job.Error = err.Error()
		job.UpdatedAt = time.Now()
		w.saveJob(ctx, job)
	}
}

// saveJob saves a job to Redis
func (w *Worker) saveJob(ctx context.Context, job *Job) error {
	jobJSON, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal job: %w", err)
	}

	key := fmt.Sprintf("job:%s", job.ID)
	return w.redis.Set(ctx, key, jobJSON, 24*time.Hour).Err()
}

// EnqueueJob adds a job to the appropriate priority queue
func (wp *WorkerPool) EnqueueJob(ctx context.Context, job *Job) error {
	jobJSON, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal job: %w", err)
	}

	// Determine queue based on priority
	queueKey := "queue:low-priority"
	if job.Priority >= 7 {
		queueKey = "queue:high-priority"
	} else if job.Priority >= 4 {
		queueKey = "queue:medium-priority"
	}

	// Save job metadata
	jobKey := fmt.Sprintf("job:%s", job.ID)
	if err := wp.redis.Set(ctx, jobKey, jobJSON, 24*time.Hour).Err(); err != nil {
		return fmt.Errorf("failed to save job metadata: %w", err)
	}

	// Add to queue
	if err := wp.redis.RPush(ctx, queueKey, jobJSON).Err(); err != nil {
		return fmt.Errorf("failed to enqueue job: %w", err)
	}

	wp.logger.Info("Job enqueued",
		zap.String("job_id", job.ID),
		zap.String("queue", queueKey),
		zap.Int("priority", job.Priority),
	)

	return nil
}

// GetJobStatus retrieves the status of a job
func (wp *WorkerPool) GetJobStatus(ctx context.Context, jobID string) (*Job, error) {
	key := fmt.Sprintf("job:%s", jobID)
	result, err := wp.redis.Get(ctx, key).Result()
	if err == redis.Nil {
		return nil, fmt.Errorf("job not found")
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get job: %w", err)
	}

	var job Job
	if err := json.Unmarshal([]byte(result), &job); err != nil {
		return nil, fmt.Errorf("failed to unmarshal job: %w", err)
	}

	return &job, nil
}
