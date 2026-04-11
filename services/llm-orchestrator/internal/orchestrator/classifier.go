package orchestrator

import (
	"github.com/revamp-io/llm-orchestrator/internal/providers"
)

// ComplexityTier represents the complexity level of a request
type ComplexityTier int

const (
	TierSimple   ComplexityTier = iota // cheap models: haiku, flash
	TierStandard                       // mid-tier: sonnet, gpt-4o-mini
	TierComplex                        // full power: opus, gpt-4o
)

func (t ComplexityTier) String() string {
	switch t {
	case TierSimple:
		return "simple"
	case TierStandard:
		return "standard"
	case TierComplex:
		return "complex"
	default:
		return "unknown"
	}
}

// RequestClassifier classifies requests by complexity to enable cost-optimal model routing.
// Based on the everything-claude-code pattern: match task complexity to model capability.
type RequestClassifier struct{}

// Classify inspects a CompletionRequest and returns its complexity tier.
func (rc *RequestClassifier) Classify(req *providers.CompletionRequest) ComplexityTier {
	inputTokens := rc.estimateInputTokens(req)
	toolCount := len(req.Tools)
	messageCount := len(req.Messages)
	systemLen := rc.systemPromptLength(req)

	// Complex: long context, many tools, deep conversation, or extended thinking
	if inputTokens >= 4000 || toolCount > 5 || messageCount > 10 || systemLen > 2000 || req.ExtendedThinking {
		return TierComplex
	}

	// Simple: short messages, no tools, shallow conversation
	if inputTokens < 500 && toolCount == 0 && messageCount <= 3 {
		return TierSimple
	}

	return TierStandard
}

// estimateInputTokens approximates total input token count using the ~4 chars/token heuristic.
func (rc *RequestClassifier) estimateInputTokens(req *providers.CompletionRequest) int {
	total := 0
	for _, msg := range req.Messages {
		total += (len(msg.Content) + 3) / 4
	}
	return total
}

// systemPromptLength returns the total character length of system messages.
func (rc *RequestClassifier) systemPromptLength(req *providers.CompletionRequest) int {
	total := 0
	for _, msg := range req.Messages {
		if msg.Role == "system" {
			total += len(msg.Content)
		}
	}
	return total
}

// ModelSelector maps complexity tiers to concrete model names, checking provider availability.
type ModelSelector struct {
	registry *providers.Registry
}

// tierCandidates defines the model preference order per tier.
// Use canonical short names — the registry does prefix matching, so these
// must match what providers register (e.g. "claude-sonnet-4-6", not a
// date-suffixed version that may not exist in the registry).
var tierCandidates = map[ComplexityTier][]string{
	TierSimple: {
		"claude-haiku-4-5-20251001",
		"gemini-2.0-flash",
		"gpt-4o-mini",
	},
	TierStandard: {
		"claude-sonnet-4-6",
		"gpt-4o",
		"gemini-1.5-pro",
		"claude-sonnet-4-5",
	},
	TierComplex: {
		"claude-opus-4-6",
		"gpt-4o",
		"claude-sonnet-4-6",
	},
}

// SelectModel returns the cheapest available model for the given tier.
func (ms *ModelSelector) SelectModel(tier ComplexityTier) string {
	candidates, ok := tierCandidates[tier]
	if !ok {
		candidates = tierCandidates[TierStandard]
	}

	for _, model := range candidates {
		if provider, err := ms.registry.GetByModel(model); err == nil && provider.GetHealth().Healthy {
			return model
		}
	}

	// No candidate found for this tier — try upgrading
	if tier == TierSimple {
		return ms.SelectModel(TierStandard)
	}

	return "" // let existing routing handle it
}
