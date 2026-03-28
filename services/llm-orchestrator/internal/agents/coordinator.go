// Package agents implements the Agent Department coordinator for the LLM orchestrator.
//
// The Coordinator manages agent lifecycle: heartbeat ticks, task checkout,
// budget enforcement, and event publishing. It replaces Paperclip's 120KB
// heartbeat.ts with a concurrent Go implementation.
package agents

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// Coordinator manages agent lifecycle, heartbeat, and task dispatch.
type Coordinator struct {
	db       *sql.DB
	redis    *redis.Client
	logger   *zap.Logger
	budget   *BudgetEnforcer
	events   *EventPublisher
	executor *Executor

	mu         sync.RWMutex
	activeRuns map[string]context.CancelFunc // agentID → cancel

	heartbeatInterval time.Duration
	stopCh            chan struct{}
	stopOnce          sync.Once
}

// CoordinatorConfig holds configuration for the agent coordinator.
type CoordinatorConfig struct {
	HeartbeatInterval time.Duration
	ExecutorConfig    ExecutorConfig
}

// NewCoordinator creates a new agent coordinator.
func NewCoordinator(db *sql.DB, rdb *redis.Client, logger *zap.Logger, cfg CoordinatorConfig) *Coordinator {
	interval := cfg.HeartbeatInterval
	if interval == 0 {
		interval = 10 * time.Second
	}

	budget := NewBudgetEnforcer(rdb, db, logger)
	events := NewEventPublisher(rdb, logger)
	executor := NewExecutor(db, budget, events, logger, cfg.ExecutorConfig)

	return &Coordinator{
		db:                db,
		redis:             rdb,
		logger:            logger,
		budget:            budget,
		events:            events,
		executor:          executor,
		activeRuns:        make(map[string]context.CancelFunc),
		heartbeatInterval: interval,
		stopCh:            make(chan struct{}),
	}
}

// Start begins the heartbeat loop. It blocks until ctx is cancelled or Stop is called.
func (c *Coordinator) Start(ctx context.Context) {
	c.logger.Info("Agent coordinator started",
		zap.Duration("heartbeat_interval", c.heartbeatInterval),
	)

	ticker := time.NewTicker(c.heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.logger.Info("Agent coordinator stopping (context cancelled)")
			return
		case <-c.stopCh:
			c.logger.Info("Agent coordinator stopping (stop signal)")
			return
		case <-ticker.C:
			c.HeartbeatTick(ctx)
		}
	}
}

// Stop signals the coordinator to shut down. Safe to call multiple times.
func (c *Coordinator) Stop() {
	c.stopOnce.Do(func() {
		close(c.stopCh)

		// Cancel all active runs
		c.mu.Lock()
		for agentID, cancel := range c.activeRuns {
			c.logger.Info("Cancelling active run", zap.String("agent_id", agentID))
			cancel()
		}
		c.activeRuns = make(map[string]context.CancelFunc)
		c.mu.Unlock()
	})
}

// HeartbeatTick checks for idle agents with assigned tasks and triggers execution.
// This is the core scheduling loop — runs every heartbeat interval.
func (c *Coordinator) HeartbeatTick(ctx context.Context) {
	// Query for assignments that are in 'assigned' state and not yet checked out
	rows, err := c.db.QueryContext(ctx, `
		SELECT a.id, a.agent_id, a.pipeline_run_id, a.stage_name
		FROM agent_assignments a
		JOIN agent_personas p ON p.id = a.agent_id
		WHERE a.status = 'assigned'
		  AND a.checkout_run_id IS NULL
		  AND p.status = 'idle'
		  AND p.hidden_at IS NULL
		ORDER BY a.created_at ASC
		LIMIT 10
	`)
	if err != nil {
		c.logger.Error("Heartbeat: failed to query pending assignments", zap.Error(err))
		return
	}
	defer rows.Close()

	type pendingAssignment struct {
		ID            string
		AgentID       string
		PipelineRunID sql.NullString
		StageName     sql.NullString
	}

	var pending []pendingAssignment
	for rows.Next() {
		var pa pendingAssignment
		if err := rows.Scan(&pa.ID, &pa.AgentID, &pa.PipelineRunID, &pa.StageName); err != nil {
			c.logger.Error("Heartbeat: failed to scan row", zap.Error(err))
			continue
		}
		pending = append(pending, pa)
	}
	if err := rows.Err(); err != nil {
		c.logger.Error("Heartbeat: row iteration error", zap.Error(err))
		return
	}

	if len(pending) == 0 {
		return
	}

	c.logger.Info("Heartbeat: found pending assignments", zap.Int("count", len(pending)))

	for _, pa := range pending {
		// Budget gate
		allowed, remaining, err := c.budget.CheckBudget(ctx, pa.AgentID)
		if err != nil {
			c.logger.Error("Heartbeat: budget check failed",
				zap.String("agent_id", pa.AgentID),
				zap.Error(err),
			)
			continue
		}
		if !allowed {
			c.logger.Warn("Heartbeat: agent over budget, skipping",
				zap.String("agent_id", pa.AgentID),
				zap.Int64("remaining_cents", remaining),
			)
			c.events.Publish(ctx, Event{
				Type:    EventBudgetExceeded,
				AgentID: pa.AgentID,
				Data:    map[string]interface{}{"remaining_cents": remaining},
			})
			continue
		}

		// Attempt atomic checkout
		runID := fmt.Sprintf("run-%d", time.Now().UnixNano())
		checkedOut, err := c.CheckoutTask(ctx, pa.AgentID, pa.ID, runID)
		if err != nil {
			c.logger.Error("Heartbeat: checkout failed",
				zap.String("assignment_id", pa.ID),
				zap.Error(err),
			)
			continue
		}
		if !checkedOut {
			// Already taken by another coordinator instance
			continue
		}

		c.events.Publish(ctx, Event{
			Type:    EventTaskStarted,
			AgentID: pa.AgentID,
			Data: map[string]interface{}{
				"assignment_id":   pa.ID,
				"pipeline_run_id": pa.PipelineRunID.String,
				"stage_name":      pa.StageName.String,
			},
		})

		c.logger.Info("Heartbeat: task checked out, dispatching to executor",
			zap.String("agent_id", pa.AgentID),
			zap.String("assignment_id", pa.ID),
			zap.String("run_id", runID),
		)

		// Dispatch execution in a tracked goroutine
		execCtx, execCancel := context.WithCancel(ctx)
		c.mu.Lock()
		c.activeRuns[pa.AgentID] = execCancel
		c.mu.Unlock()

		go func(assignmentID, agentID, pipelineRunID, stageName string) {
			defer func() {
				c.mu.Lock()
				delete(c.activeRuns, agentID)
				c.mu.Unlock()
				execCancel()
			}()

			c.executor.ExecuteAssignment(execCtx, assignmentID, agentID, pipelineRunID, stageName)
		}(pa.ID, pa.AgentID, pa.PipelineRunID.String, pa.StageName.String)
	}
}

// CheckoutTask performs an atomic SQL checkout — Paperclip pattern.
// Returns true if checkout succeeded, false if already taken.
func (c *Coordinator) CheckoutTask(ctx context.Context, agentID, assignmentID, runID string) (bool, error) {
	result, err := c.db.ExecContext(ctx, `
		UPDATE agent_assignments
		SET checkout_run_id = $1,
		    status = 'in_progress',
		    checked_out_at = NOW(),
		    started_at = NOW(),
		    updated_at = NOW()
		WHERE id = $2
		  AND agent_id = $3
		  AND status = 'assigned'
		  AND checkout_run_id IS NULL
	`, runID, assignmentID, agentID)
	if err != nil {
		return false, fmt.Errorf("checkout query failed: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("rows affected check failed: %w", err)
	}

	return affected > 0, nil
}

// ReleaseLock clears the checkout_run_id on an assignment.
func (c *Coordinator) ReleaseLock(ctx context.Context, assignmentID string) error {
	_, err := c.db.ExecContext(ctx, `
		UPDATE agent_assignments
		SET checkout_run_id = NULL,
		    updated_at = NOW()
		WHERE id = $1
	`, assignmentID)
	return err
}
