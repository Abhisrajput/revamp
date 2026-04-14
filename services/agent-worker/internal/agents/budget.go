package agents

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// BudgetEnforcer handles real-time budget checking via Redis counters
// with periodic reconciliation against the immutable cost_events table.
type BudgetEnforcer struct {
	redis  *redis.Client
	db     *sql.DB
	logger *zap.Logger
}

// NewBudgetEnforcer creates a new budget enforcer.
func NewBudgetEnforcer(rdb *redis.Client, db *sql.DB, logger *zap.Logger) *BudgetEnforcer {
	return &BudgetEnforcer{
		redis:  rdb,
		db:     db,
		logger: logger,
	}
}

// budgetKey returns the Redis key for an agent's monthly spend counter.
func budgetKey(agentID string) string {
	return fmt.Sprintf("agent:%s:spent_cents", agentID)
}

// CheckBudget checks if an agent is within budget.
// Uses Redis for fast path (<1ms). Returns (allowed, remaining_cents, error).
func (b *BudgetEnforcer) CheckBudget(ctx context.Context, agentID string) (bool, int64, error) {
	// Get agent's budget limit from DB
	var limitCents int64
	var hardStop bool
	err := b.db.QueryRowContext(ctx, `
		SELECT monthly_budget_cents, hard_stop_enabled
		FROM agent_personas
		WHERE id = $1 AND hidden_at IS NULL
	`, agentID).Scan(&limitCents, &hardStop)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, 0, fmt.Errorf("agent not found: %s", agentID)
		}
		return false, 0, fmt.Errorf("budget query failed: %w", err)
	}

	if !hardStop {
		return true, limitCents, nil // no enforcement
	}

	// Fast path: check Redis counter
	spentStr, err := b.redis.Get(ctx, budgetKey(agentID)).Result()
	if err != nil && err != redis.Nil {
		// Redis unavailable — fall back to DB
		b.logger.Warn("Redis unavailable for budget check, falling back to DB",
			zap.String("agent_id", agentID),
			zap.Error(err),
		)
		return b.checkBudgetFromDB(ctx, agentID, limitCents)
	}

	var spentCents int64
	if err != redis.Nil {
		spentCents, _ = strconv.ParseInt(spentStr, 10, 64)
	}

	remaining := limitCents - spentCents
	return remaining > 0, remaining, nil
}

// RecordCost atomically increments the Redis budget counter and inserts
// an immutable cost event into PostgreSQL.
func (b *BudgetEnforcer) RecordCost(ctx context.Context, agentID string, costCents int64, event CostEventRecord) error {
	// Redis: atomic increment
	if err := b.redis.IncrBy(ctx, budgetKey(agentID), costCents).Err(); err != nil {
		b.logger.Warn("Failed to increment Redis budget counter",
			zap.String("agent_id", agentID),
			zap.Error(err),
		)
		// Continue — PostgreSQL is the source of truth
	}

	// PostgreSQL: immutable cost event (NEVER UPDATE/DELETE)
	_, err := b.db.ExecContext(ctx, `
		INSERT INTO cost_events (
			agent_id, pipeline_run_id, assignment_id, project_id,
			provider, model, input_tokens, output_tokens, cached_tokens, cost_cents,
			stage_name, operation
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
	`,
		event.AgentID, event.PipelineRunID, event.AssignmentID, event.ProjectID,
		event.Provider, event.Model, event.InputTokens, event.OutputTokens,
		event.CachedTokens, event.CostCents, event.StageName, event.Operation,
	)
	if err != nil {
		return fmt.Errorf("cost event insert failed: %w", err)
	}

	// Update denormalized spent_monthly_cents on persona
	_, err = b.db.ExecContext(ctx, `
		UPDATE agent_personas
		SET spent_monthly_cents = spent_monthly_cents + $1,
		    updated_at = NOW()
		WHERE id = $2
	`, costCents, agentID)
	if err != nil {
		b.logger.Warn("Failed to update persona spent counter",
			zap.String("agent_id", agentID),
			zap.Error(err),
		)
	}

	return nil
}

// ReconcileBudgets syncs Redis counters with the authoritative cost_events table.
// Should be run periodically (e.g., every 5 minutes) to correct any drift.
func (b *BudgetEnforcer) ReconcileBudgets(ctx context.Context) error {
	rows, err := b.db.QueryContext(ctx, `
		SELECT agent_id, COALESCE(SUM(cost_cents), 0) as total_cents
		FROM cost_events
		WHERE agent_id IS NOT NULL
		  AND created_at >= date_trunc('month', NOW())
		GROUP BY agent_id
	`)
	if err != nil {
		return fmt.Errorf("reconciliation query failed: %w", err)
	}
	defer rows.Close()

	reconciled := 0
	for rows.Next() {
		var agentID string
		var totalCents int64
		if err := rows.Scan(&agentID, &totalCents); err != nil {
			b.logger.Error("Reconciliation scan failed", zap.Error(err))
			continue
		}

		// Set Redis to authoritative value
		if err := b.redis.Set(ctx, budgetKey(agentID), totalCents, 0).Err(); err != nil {
			b.logger.Warn("Failed to set Redis budget counter during reconciliation",
				zap.String("agent_id", agentID),
				zap.Error(err),
			)
		}

		// Update denormalized column
		_, err := b.db.ExecContext(ctx, `
			UPDATE agent_personas SET spent_monthly_cents = $1, updated_at = NOW() WHERE id = $2
		`, totalCents, agentID)
		if err != nil {
			b.logger.Warn("Failed to update persona during reconciliation",
				zap.String("agent_id", agentID),
				zap.Error(err),
			)
		}

		reconciled++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reconciliation row iteration error: %w", err)
	}

	b.logger.Info("Budget reconciliation complete", zap.Int("agents_reconciled", reconciled))
	return nil
}

// checkBudgetFromDB is the fallback when Redis is unavailable.
func (b *BudgetEnforcer) checkBudgetFromDB(ctx context.Context, agentID string, limitCents int64) (bool, int64, error) {
	var spentCents int64
	err := b.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(cost_cents), 0)
		FROM cost_events
		WHERE agent_id = $1
		  AND created_at >= date_trunc('month', NOW())
	`, agentID).Scan(&spentCents)
	if err != nil {
		return false, 0, fmt.Errorf("DB budget fallback failed: %w", err)
	}

	remaining := limitCents - spentCents
	return remaining > 0, remaining, nil
}

// CostEventRecord holds data for an immutable cost event.
type CostEventRecord struct {
	AgentID       *string
	PipelineRunID *string
	AssignmentID  *string
	ProjectID     *string
	Provider      string
	Model         string
	InputTokens   int
	OutputTokens  int
	CachedTokens  int
	CostCents     int
	StageName     *string
	Operation     *string
}
