/**
 * Tool Format Adapters — convert a canonical tool definition to each LLM
 * provider's function-calling JSON schema format.
 *
 * Ported from legacy-bridge backend/src/agent/toolFormats.ts with additions:
 *   - xAI (Grok) format (OpenAI-compatible)
 *   - OpenAI Responses API format (for gpt-5-codex models)
 *   - Type-safe canonical AgentTool interface
 *   - ReAct text-based tool description for generic/local LLMs
 *
 * Each LLM provider has a different JSON schema for function/tool calling:
 *   - OpenAI Chat Completions: { type: "function", function: { name, description, parameters } }
 *   - OpenAI Responses API: { type: "function", name, description, parameters }
 *   - Anthropic Claude: { name, description, input_schema }
 *   - Google Gemini: { functionDeclarations: [{ name, description, parameters }] }
 *   - AWS Bedrock Converse: { tools: [{ toolSpec: { name, description, inputSchema: { json } } }] }
 *   - ReAct (generic): plain text description for prompt-based tool use
 */

// ─── TYPES ──────────────────────────────────────────────────────

/**
 * Canonical tool definition. All provider-specific formats are derived from this.
 * The inputSchema follows JSON Schema Draft 7 (what most LLM APIs accept).
 */
export interface AgentTool {
  /** Tool name — must be alphanumeric + underscores, no spaces */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
}

// ─── OPENAI CHAT COMPLETIONS FORMAT ─────────────────────────────

export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Convert tools to OpenAI Chat Completions function calling format.
 * Used for gpt-4o, gpt-4-turbo, gpt-3.5-turbo models.
 */
export function toOpenAITools(tools: AgentTool[]): OpenAIToolDef[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ─── OPENAI RESPONSES API FORMAT ────────────────────────────────

export interface OpenAIResponsesToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Convert tools to OpenAI Responses API format.
 * Used for gpt-5-codex and future Responses API models.
 * The Responses API uses a flatter structure than Chat Completions.
 */
export function toOpenAIResponsesTools(tools: AgentTool[]): OpenAIResponsesToolDef[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

// ─── ANTHROPIC CLAUDE FORMAT ────────────────────────────────────

export interface ClaudeToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Convert tools to Anthropic Claude Messages API format.
 * Used for Claude 3.x, Claude 4.x models.
 */
export function toClaudeTools(tools: AgentTool[]): ClaudeToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// ─── GOOGLE GEMINI FORMAT ───────────────────────────────────────

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiToolDef {
  functionDeclarations: GeminiFunctionDeclaration[];
}

/**
 * Convert tools to Google Gemini function declaration format.
 * Gemini wraps all declarations in a single functionDeclarations array.
 */
export function toGeminiTools(tools: AgentTool[]): GeminiToolDef[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

// ─── AWS BEDROCK CONVERSE FORMAT ────────────────────────────────

export interface BedrockToolSpec {
  name: string;
  description: string;
  inputSchema: { json: Record<string, unknown> };
}

export interface BedrockToolConfig {
  tools: Array<{ toolSpec: BedrockToolSpec }>;
}

/**
 * Convert tools to AWS Bedrock Converse API toolConfig format.
 * Bedrock wraps the schema in an extra { json: ... } envelope.
 */
export function toBedrockToolConfig(tools: AgentTool[]): BedrockToolConfig {
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.inputSchema },
      },
    })),
  };
}

// ─── REACT TEXT FORMAT (for generic/local LLMs) ─────────────────

/**
 * Build a text description of tools for ReAct-style prompting.
 * Used when the LLM doesn't support native function calling (e.g., Ollama
 * models, local LLMs, or as a fallback).
 *
 * Format:
 *   Tool: tool_name
 *   Description: what it does
 *   Parameters:
 *     - param1 (type): description
 */
export function toReActToolDescription(tools: AgentTool[]): string {
  const lines = tools.map((t) => {
    const properties = (
      t.inputSchema as { properties?: Record<string, { type?: string; description?: string }> }
    ).properties || {};

    const paramList = Object.entries(properties)
      .map(([k, v]) => `  - ${k} (${v.type || 'string'}): ${v.description || ''}`)
      .join('\n');

    return `Tool: ${t.name}\nDescription: ${t.description}\nParameters:\n${paramList}`;
  });
  return lines.join('\n\n');
}

// ─── PROVIDER DETECTION ─────────────────────────────────────────

export type ToolFormatProvider =
  | 'openai'
  | 'openai_responses'
  | 'anthropic'
  | 'gemini'
  | 'bedrock'
  | 'react';

/**
 * Auto-format tools for a detected provider.
 * Returns the provider-specific tool definition object.
 */
export function formatToolsForProvider(
  tools: AgentTool[],
  provider: ToolFormatProvider,
): unknown {
  switch (provider) {
    case 'openai':
      return toOpenAITools(tools);
    case 'openai_responses':
      return toOpenAIResponsesTools(tools);
    case 'anthropic':
      return toClaudeTools(tools);
    case 'gemini':
      return toGeminiTools(tools);
    case 'bedrock':
      return toBedrockToolConfig(tools);
    case 'react':
      return toReActToolDescription(tools);
    default:
      return toOpenAITools(tools); // safe default
  }
}

/**
 * Detect the provider type from a model name.
 * Useful for auto-selecting the correct tool format.
 */
function detectProviderFromModel(model: string): ToolFormatProvider {
  const lower = model.toLowerCase();

  // OpenAI Responses API models
  if (/^gpt-5(?:\.\d+)?-codex/.test(lower)) return 'openai_responses';

  // Standard OpenAI models
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3')) return 'openai';

  // Anthropic Claude
  if (lower.includes('claude')) return 'anthropic';

  // Google Gemini
  if (lower.includes('gemini')) return 'gemini';

  // AWS Bedrock model IDs
  if (lower.includes('anthropic.') || lower.includes('amazon.') || lower.includes('cohere.') || lower.includes('meta.')) {
    return 'bedrock';
  }

  // Default to OpenAI format (most widely compatible)
  return 'openai';
}
