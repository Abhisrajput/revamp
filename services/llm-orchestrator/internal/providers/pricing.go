package providers

import "strings"

// ModelPricing holds per-token costs for a model.
// Costs are in USD per token (not per 1K tokens).
type ModelPricing struct {
	InputCostPerToken  float64
	OutputCostPerToken float64
}

// pricingTable is the central source of truth for LLM pricing.
// Update this table when providers change pricing — no code changes in
// individual provider files needed.
//
// Prices are per-token (divide $/1K by 1000).
var pricingTable = map[string]ModelPricing{
	// ── Anthropic Claude 4.x ──────────────────────────────────
	"claude-opus-4-6":          {0.015 / 1000, 0.075 / 1000},
	"claude-sonnet-4-6":        {0.003 / 1000, 0.015 / 1000},
	"claude-haiku-4-5-20251001": {0.0008 / 1000, 0.004 / 1000},
	// ── Anthropic Claude 3.5 ──────────────────────────────────
	"claude-3-5-sonnet-20241022": {0.003 / 1000, 0.015 / 1000},
	"claude-3-5-haiku-20241022":  {0.0008 / 1000, 0.004 / 1000},
	// ── Anthropic Claude 3 (legacy) ───────────────────────────
	"claude-3-opus-20240229":   {0.015 / 1000, 0.075 / 1000},
	"claude-3-sonnet-20240229": {0.003 / 1000, 0.015 / 1000},
	"claude-3-haiku-20240307":  {0.00025 / 1000, 0.00125 / 1000},

	// ── OpenAI ────────────────────────────────────────────────
	"gpt-4o":      {0.005 / 1000, 0.015 / 1000},
	"gpt-4o-mini": {0.00015 / 1000, 0.0006 / 1000},
	"gpt-4-turbo": {0.01 / 1000, 0.03 / 1000},
	"gpt-4":       {0.03 / 1000, 0.06 / 1000},
	"gpt-3.5-turbo": {0.0005 / 1000, 0.0015 / 1000},
	"o1":          {0.015 / 1000, 0.06 / 1000},
	"o1-mini":     {0.003 / 1000, 0.012 / 1000},
	"o3-mini":     {0.0011 / 1000, 0.0044 / 1000},

	// ── Google Gemini ─────────────────────────────────────────
	"gemini-2.0-flash": {0.0001 / 1000, 0.0004 / 1000},
	"gemini-1.5-pro":   {0.00125 / 1000, 0.005 / 1000},
	"gemini-1.5-flash": {0.000075 / 1000, 0.0003 / 1000},

	// ── AWS Bedrock (same models, Bedrock markup) ─────────────
	"us.anthropic.claude-opus-4-6-v1":          {0.015 / 1000, 0.075 / 1000},
	"us.anthropic.claude-sonnet-4-6-v1":        {0.003 / 1000, 0.015 / 1000},
	"us.anthropic.claude-haiku-4-5-20251001-v1:0": {0.0008 / 1000, 0.004 / 1000},
}

// fallbackPricing is used when a model isn't in the table.
var fallbackPricing = ModelPricing{0.003 / 1000, 0.015 / 1000}

// CalculateCost returns the estimated cost in USD for a given model and token counts.
// Checks exact match first, then prefix match, then falls back to mid-range estimate.
func CalculateCost(model string, inputTokens, outputTokens int) float64 {
	p := lookupPricing(model)
	return float64(inputTokens)*p.InputCostPerToken + float64(outputTokens)*p.OutputCostPerToken
}

// lookupPricing finds the best matching pricing entry.
func lookupPricing(model string) ModelPricing {
	lower := strings.ToLower(model)

	// Exact match
	if p, ok := pricingTable[lower]; ok {
		return p
	}

	// Prefix match (handles versioned model IDs like "claude-sonnet-4-6-20250514")
	for key, p := range pricingTable {
		if strings.HasPrefix(lower, key) {
			return p
		}
	}

	return fallbackPricing
}
