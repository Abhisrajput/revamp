package agents

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// Event types for agent lifecycle.
const (
	EventTaskAssigned    = "agent.task_assigned"
	EventTaskStarted     = "agent.task_started"
	EventTaskCompleted   = "agent.task_completed"
	EventTaskFailed      = "agent.task_failed"
	EventTaskEscalated   = "agent.task_escalated"
	EventBudgetWarning   = "agent.budget_warning"
	EventBudgetExceeded  = "agent.budget_exceeded"
)

// AgentEventChannel is the Redis Pub/Sub channel for agent events.
const AgentEventChannel = "revamp:agent:events"

// Event represents an agent lifecycle event.
type Event struct {
	Type    string                 `json:"type"`
	AgentID string                 `json:"agent_id"`
	Data    map[string]interface{} `json:"data,omitempty"`
}

// EventPublisher publishes agent events to Redis Pub/Sub.
type EventPublisher struct {
	redis  *redis.Client
	logger *zap.Logger
}

// NewEventPublisher creates a new event publisher.
func NewEventPublisher(rdb *redis.Client, logger *zap.Logger) *EventPublisher {
	return &EventPublisher{
		redis:  rdb,
		logger: logger,
	}
}

// Publish sends an event to the Redis Pub/Sub channel.
func (p *EventPublisher) Publish(ctx context.Context, event Event) {
	payload, err := json.Marshal(event)
	if err != nil {
		p.logger.Error("Failed to marshal event",
			zap.String("type", event.Type),
			zap.Error(err),
		)
		return
	}

	if err := p.redis.Publish(ctx, AgentEventChannel, payload).Err(); err != nil {
		p.logger.Warn("Failed to publish event",
			zap.String("type", event.Type),
			zap.String("agent_id", event.AgentID),
			zap.Error(err),
		)
	}
}

// EventSubscriber subscribes to agent events from Redis Pub/Sub.
type EventSubscriber struct {
	redis  *redis.Client
	logger *zap.Logger
}

// NewEventSubscriber creates a new event subscriber.
func NewEventSubscriber(rdb *redis.Client, logger *zap.Logger) *EventSubscriber {
	return &EventSubscriber{
		redis:  rdb,
		logger: logger,
	}
}

// EventHandler is a function that handles agent events.
type EventHandler func(ctx context.Context, event Event)

// Subscribe listens for agent events matching the given pattern.
// It blocks until ctx is cancelled.
func (s *EventSubscriber) Subscribe(ctx context.Context, handler EventHandler) error {
	sub := s.redis.Subscribe(ctx, AgentEventChannel)
	defer sub.Close()

	ch := sub.Channel()

	s.logger.Info("Subscribed to agent events", zap.String("channel", AgentEventChannel))

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-ch:
			if !ok {
				return fmt.Errorf("subscription channel closed")
			}

			var event Event
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				s.logger.Error("Failed to unmarshal event", zap.Error(err))
				continue
			}

			handler(ctx, event)
		}
	}
}
