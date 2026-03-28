/**
 * LLM model pricing data — ported from legacy-bridge
 *
 * Prices per 1M tokens in USD.
 * Used for cost estimation and usage tracking across the platform.
 */

export interface ModelPricing {
  input: number;   // cost per 1M input tokens
  output: number;  // cost per 1M output tokens
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic — current ──────────────────────────────────────────────
  'claude-opus-4-6':              { input: 5.0,   output: 25.0  },
  'claude-sonnet-4-6':            { input: 3.0,   output: 15.0  },
  'claude-haiku-4-5-20251001':    { input: 1.0,   output: 5.0   },

  // ── Anthropic — legacy (still available) ─────────────────────────────
  'claude-sonnet-4-5-20250929':   { input: 3.0,   output: 15.0  },
  'claude-opus-4-5-20251101':     { input: 5.0,   output: 25.0  },
  'claude-opus-4-1-20250805':     { input: 15.0,  output: 75.0  },
  'claude-sonnet-4-20250514':     { input: 3.0,   output: 15.0  },
  'claude-opus-4-20250514':       { input: 15.0,  output: 75.0  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  'gpt-4o':        { input: 2.50,  output: 10.0  },
  'gpt-4o-mini':   { input: 0.15,  output: 0.60  },
  'gpt-4.1':       { input: 2.0,   output: 8.0   },
  'gpt-4.1-mini':  { input: 0.40,  output: 1.60  },
  'gpt-4.1-nano':  { input: 0.10,  output: 0.40  },
  'o3-mini':       { input: 1.10,  output: 4.40  },

  // ── Google ───────────────────────────────────────────────────────────
  'gemini-2.0-flash': { input: 0.10,  output: 0.40  },
  'gemini-2.5-pro':   { input: 1.25,  output: 10.0  },
  'gemini-2.5-flash': { input: 0.15,  output: 0.60  },
};

/**
 * Get pricing for a model, handling provider-prefixed IDs
 * (e.g. "abc123::claude-sonnet-4-6" -> "claude-sonnet-4-6")
 *
 * Falls back to Claude Sonnet pricing if model is unknown.
 */
export function getModelPricing(modelId: string): ModelPricing {
  // Strip "providerId::" prefix if present
  const bare = modelId.includes('::')
    ? modelId.split('::').slice(1).join('::')
    : modelId;

  if (MODEL_PRICING[bare]) return MODEL_PRICING[bare];

  // Fuzzy match: find a key that the bare ID starts with, or vice versa
  const match = Object.keys(MODEL_PRICING).find(
    (k) => bare.startsWith(k) || k.startsWith(bare),
  );

  return match ? MODEL_PRICING[match] : { input: 3.0, output: 15.0 };
}

/**
 * Calculate the cost in USD for a given number of tokens
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  modelId: string,
): number {
  const pricing = getModelPricing(modelId);
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

/**
 * Format cost as a human-readable string
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) return `$${(costUsd * 100).toFixed(2)}c`;
  return `$${costUsd.toFixed(4)}`;
}

/**
 * Get all available model IDs
 */
export function getAvailableModels(): string[] {
  return Object.keys(MODEL_PRICING);
}
