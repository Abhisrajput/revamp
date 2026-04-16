# WebSocket Migration Phase 2 — LLM Provider Routing (Go → Node)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Go LLM orchestrator HTTP bridge with direct Node SDK calls. The `llmProxyService` API stays the same — only the internal transport changes. All 18 consumer files continue working without modification.

**Architecture:** Provider wrappers in `packages/core-engine/src/llm/` implement a `LLMProvider` interface. A router selects providers by model name. Circuit breakers via `cockatiel` wrap each provider. The existing `LLMProxyService` in `apps/api/` is rewritten to use the Node providers instead of calling Go.

**Tech Stack:** `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk` (already in deps), `openai`, `@google/generative-ai`, `cockatiel`, `ioredis` (already in deps)

---

## Strategy: Minimal Blast Radius

The key insight: **18 files import from `llm-proxy.ts`**. Rewriting all of them is risky and unnecessary. Instead:

1. Build the new provider layer in `core-engine/src/llm/`
2. Rewrite `LLMProxyService` internals to use Node providers
3. Keep the exact same class API: `createCallFn()`, `createEvalFn()`, `complete()`, `streamCompletion()`, `hasValidationModel()`
4. Zero changes to any consumer file

This turns a 18-file migration into a 2-file change (new provider layer + rewritten proxy service).

---

## File Map

### New Files

| File | Responsibility |
|---|---|
| `packages/core-engine/src/llm/types.ts` | LLMProvider interface, ChatMessage, ChatResponse, StreamChunk |
| `packages/core-engine/src/llm/anthropic.ts` | @anthropic-ai/sdk wrapper (Claude direct API) |
| `packages/core-engine/src/llm/bedrock.ts` | @anthropic-ai/bedrock-sdk wrapper (Claude via AWS) |
| `packages/core-engine/src/llm/openai.ts` | openai SDK wrapper (GPT, o-series) |
| `packages/core-engine/src/llm/google.ts` | @google/generative-ai wrapper (Gemini) |
| `packages/core-engine/src/llm/router.ts` | Model → provider mapping, weighted selection |
| `packages/core-engine/src/llm/circuit-breaker.ts` | cockatiel circuit breakers per provider |
| `packages/core-engine/src/llm/index.ts` | Barrel export |

### Modified Files

| File | Change |
|---|---|
| `apps/api/src/services/llm-proxy.ts` | Rewrite internals: HTTP→Go replaced with Node SDK calls |
| `packages/core-engine/package.json` | Add SDK dependencies |

---

### Task 1: LLM Provider Types

**Files:**
- Create: `packages/core-engine/src/llm/types.ts`

- [ ] **Step 1: Create provider interface**

```typescript
/**
 * LLM Provider interface — platform-agnostic wrapper for LLM SDKs.
 * Each provider (Anthropic, OpenAI, Google, Bedrock) implements this interface.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  max_tokens: number;
  temperature?: number;
  response_format?: 'text' | 'json';
  signal?: AbortSignal;
}

export interface ChatResponse {
  id: string;
  content: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
  cached_tokens?: number;
}

export interface StreamChunk {
  text: string;
  /** Set on the final chunk */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens?: number;
  };
}

export interface HealthStatus {
  provider: string;
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface LLMProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse>;
  health(): Promise<HealthStatus>;
  models(): string[];
}

/** Credentials for per-project BYOK */
export interface ProviderCredentials {
  provider: string;
  // AWS / Bedrock
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  aws_bearer_token?: string;
  aws_sso_profile?: string;
  // Anthropic direct
  anthropic_api_key?: string;
  // OpenAI
  openai_api_key?: string;
  openai_endpoint?: string;
  // Google
  gemini_api_key?: string;
  // Azure
  azure_endpoint?: string;
  azure_api_key?: string;
  azure_api_version?: string;
}
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm --filter @revamp/core-engine build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core-engine/src/llm/types.ts
git commit -m "feat(core-engine): add LLMProvider interface and types

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Anthropic Provider (Claude Direct API)

**Files:**
- Create: `packages/core-engine/src/llm/anthropic.ts`
- Modify: `packages/core-engine/package.json`

- [ ] **Step 1: Install SDK**

The `@anthropic-ai/sdk` is already in `apps/api/package.json`. Add it to core-engine too:

```bash
cd /Users/abhishek.singh/LocalBin_abhishek2.singh/Revamp
pnpm --filter @revamp/core-engine add @anthropic-ai/sdk
```

- [ ] **Step 2: Create Anthropic provider**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, HealthStatus, ChatMessage } from './types.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private availableModels: string[];

  constructor(options: { apiKey?: string }) {
    this.client = new Anthropic({
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY,
    });
    this.availableModels = [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = this.formatMessages(request.messages);

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature ?? 0.3,
      system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages,
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      id: response.id,
      content,
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      stop_reason: response.stop_reason || 'end_turn',
      cached_tokens: (response.usage as any).cache_read_input_tokens || 0,
    };
  }

  async stream(request: ChatRequest, onDelta: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const { system, messages } = this.formatMessages(request.messages);

    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature ?? 0.3,
      system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
      messages,
    });

    let accumulated = '';

    stream.on('text', (text) => {
      accumulated += text;
      onDelta({ text });
    });

    const finalMessage = await stream.finalMessage();

    const usage = {
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      cached_tokens: (finalMessage.usage as any).cache_read_input_tokens || 0,
    };

    // Emit final chunk with usage
    onDelta({ text: '', usage });

    return {
      id: finalMessage.id,
      content: accumulated,
      model: finalMessage.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      stop_reason: finalMessage.stop_reason || 'end_turn',
      cached_tokens: usage.cached_tokens,
    };
  }

  async health(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { provider: this.name, healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { provider: this.name, healthy: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  models(): string[] {
    return this.availableModels;
  }

  private formatMessages(messages: ChatMessage[]): {
    system: string | undefined;
    messages: Anthropic.MessageParam[];
  } {
    let system: string | undefined;
    const formatted: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = (system ? system + '\n\n' : '') + msg.content;
      } else {
        formatted.push({ role: msg.role, content: msg.content });
      }
    }

    return { system, messages: formatted };
  }
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @revamp/core-engine build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core-engine/src/llm/anthropic.ts packages/core-engine/package.json
git commit -m "feat(core-engine): add Anthropic provider (Claude direct API)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Bedrock Provider (Claude via AWS)

**Files:**
- Create: `packages/core-engine/src/llm/bedrock.ts`

- [ ] **Step 1: Install SDK**

`@anthropic-ai/bedrock-sdk` is already in `apps/api/package.json`. Add to core-engine:

```bash
pnpm --filter @revamp/core-engine add @anthropic-ai/bedrock-sdk
```

- [ ] **Step 2: Create Bedrock provider**

Same structure as Anthropic but uses `AnthropicBedrock` client with AWS region and credentials. The Bedrock SDK wraps the same Anthropic message format but routes through AWS.

Key differences:
- Constructor takes `region`, optional `accessKeyId`, `secretAccessKey`, `sessionToken`
- Model IDs use Bedrock format: `us.anthropic.claude-sonnet-4-6-20251001-v1:0`
- Bearer token auth supported via `awsBearerToken` option
- SSO profile support: if `aws_sso_profile` is set, let the SDK pick up credentials from `~/.aws/config`

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @revamp/core-engine build`

- [ ] **Step 4: Commit**

```bash
git add packages/core-engine/src/llm/bedrock.ts packages/core-engine/package.json
git commit -m "feat(core-engine): add Bedrock provider (Claude via AWS)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: OpenAI Provider

**Files:**
- Create: `packages/core-engine/src/llm/openai.ts`

- [ ] **Step 1: Install SDK**

```bash
pnpm --filter @revamp/core-engine add openai
```

- [ ] **Step 2: Create OpenAI provider**

Uses `openai` SDK. Key details:
- Chat completions via `client.chat.completions.create()`
- Streaming via `client.chat.completions.create({ stream: true })` which returns an async iterable
- JSON mode via `response_format: { type: "json_object" }`
- Models: `gpt-4o`, `gpt-4o-mini`, `o1`, `o1-mini`
- Token usage from `response.usage`

- [ ] **Step 3: Verify build and commit**

---

### Task 5: Google Gemini Provider

**Files:**
- Create: `packages/core-engine/src/llm/google.ts`

- [ ] **Step 1: Install SDK**

```bash
pnpm --filter @revamp/core-engine add @google/generative-ai
```

- [ ] **Step 2: Create Google provider**

Uses `@google/generative-ai` SDK. Key details:
- `GoogleGenerativeAI` client with API key
- `model.generateContent()` for non-streaming
- `model.generateContentStream()` for streaming
- Models: `gemini-2.0-flash`, `gemini-1.5-pro`
- System instruction via `systemInstruction` parameter

- [ ] **Step 3: Verify build and commit**

---

### Task 6: Router + Circuit Breaker

**Files:**
- Create: `packages/core-engine/src/llm/router.ts`
- Create: `packages/core-engine/src/llm/circuit-breaker.ts`

- [ ] **Step 1: Install cockatiel**

```bash
pnpm --filter @revamp/core-engine add cockatiel
```

- [ ] **Step 2: Create circuit breaker wrapper**

```typescript
import { CircuitBreakerPolicy, ConsecutiveBreaker, handleAll } from 'cockatiel';

const breakers = new Map<string, CircuitBreakerPolicy>();

export function getCircuitBreaker(providerName: string): CircuitBreakerPolicy {
  let breaker = breakers.get(providerName);
  if (!breaker) {
    breaker = new CircuitBreakerPolicy(handleAll, {
      halfOpenAfter: 30_000,
      breaker: new ConsecutiveBreaker(3),
    });
    breakers.set(providerName, breaker);
  }
  return breaker;
}
```

- [ ] **Step 3: Create router**

Model-to-provider mapping. The router:
1. Parses model name to determine provider (claude-* → anthropic/bedrock, gpt-* → openai, gemini-* → google)
2. Checks if BYOK credentials override the default provider
3. Wraps the provider call in a circuit breaker
4. Returns a `getProvider(model, credentials?)` function

```typescript
import type { LLMProvider, ProviderCredentials } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { BedrockProvider } from './bedrock.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { getCircuitBreaker } from './circuit-breaker.js';

export function getProvider(model: string, credentials?: ProviderCredentials): LLMProvider {
  // BYOK: explicit provider from credentials
  if (credentials?.provider === 'bedrock' || credentials?.aws_region) {
    return new BedrockProvider({
      region: credentials.aws_region || 'us-east-2',
      accessKeyId: credentials.aws_access_key_id,
      secretAccessKey: credentials.aws_secret_access_key,
      sessionToken: credentials.aws_session_token,
      bearerToken: credentials.aws_bearer_token,
    });
  }
  if (credentials?.anthropic_api_key) {
    return new AnthropicProvider({ apiKey: credentials.anthropic_api_key });
  }
  if (credentials?.openai_api_key) {
    return new OpenAIProvider({ apiKey: credentials.openai_api_key });
  }
  if (credentials?.gemini_api_key) {
    return new GoogleProvider({ apiKey: credentials.gemini_api_key });
  }

  // Route by model name prefix
  if (/^(claude|anthropic)/i.test(model)) {
    // Bedrock model IDs contain region prefix
    if (model.includes('.anthropic.') || model.includes('us.')) {
      return new BedrockProvider({ region: process.env.AWS_REGION || 'us-east-2' });
    }
    return new AnthropicProvider({});
  }
  if (/^(gpt|o1|o3|davinci|text-)/i.test(model)) {
    return new OpenAIProvider({});
  }
  if (/^gemini/i.test(model)) {
    return new GoogleProvider({});
  }

  // Default: Bedrock (most common in enterprise deployments)
  return new BedrockProvider({ region: process.env.AWS_REGION || 'us-east-2' });
}
```

- [ ] **Step 4: Verify build and commit**

---

### Task 7: Barrel Export + Index

**Files:**
- Create: `packages/core-engine/src/llm/index.ts`

- [ ] **Step 1: Create barrel**

```typescript
export type { LLMProvider, ChatRequest, ChatResponse, ChatMessage, StreamChunk, HealthStatus, ProviderCredentials } from './types.js';
export { AnthropicProvider } from './anthropic.js';
export { BedrockProvider } from './bedrock.js';
export { OpenAIProvider } from './openai.js';
export { GoogleProvider } from './google.js';
export { getProvider } from './router.js';
export { getCircuitBreaker } from './circuit-breaker.js';
```

- [ ] **Step 2: Verify build and commit**

---

### Task 8: Rewrite LLMProxyService to Use Node Providers

**Files:**
- Modify: `apps/api/src/services/llm-proxy.ts`

This is the critical task. The `LLMProxyService` class API stays EXACTLY the same. Only the internal implementation changes.

- [ ] **Step 1: Rewrite llm-proxy.ts**

Replace the axios HTTP calls to Go with direct provider calls:

- Remove: `axios` import, `AxiosInstance`, all Go orchestrator HTTP calls
- Remove: SSE stream parsing (the entire `streamCompletion` stream event handler)
- Add: `import { getProvider, getCircuitBreaker } from '@revamp/core-engine/llm'`
- `complete()`: `getProvider(model, creds).chat(request)` wrapped in circuit breaker
- `streamCompletion()`: `getProvider(model, creds).stream(request, onDelta)` wrapped in circuit breaker
- `createCallFn()`: Same API, calls new `complete()`/`streamCompletion()`
- `createEvalFn()`: Same API, calls new `complete()` with evaluator model
- `listModels()`: Returns hardcoded model list (no Go orchestrator to query)
- `hasValidationModel()`: Checks if evaluator model is configured
- Keep: `ProjectCredentials` type export (used by 18 files)
- Keep: The Proxy-based lazy singleton pattern at the bottom

- [ ] **Step 2: Verify all consumers still compile**

Run: `pnpm --filter @revamp/api type-check`
Expected: PASS with zero errors (all 18 consumer files unchanged)

- [ ] **Step 3: Verify web still compiles**

Run: `pnpm --filter @revamp/web type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/llm-proxy.ts
git commit -m "feat(api): rewrite LLMProxyService to use Node SDKs instead of Go orchestrator

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: End-to-End Smoke Test

- [ ] **Step 1: Restart API server (Go orchestrator NOT needed)**

```bash
# Kill existing servers
pkill -f "tsx watch" 2>/dev/null
# Restart API only — Go orchestrator should NOT be running
cd apps/api && pnpm dev
```

- [ ] **Step 2: Verify API starts without Go orchestrator**

The API should start and log provider initialization instead of Go orchestrator connection.

- [ ] **Step 3: Test LLM call**

Navigate to a project, run a pipeline stage. Verify:
- LLM streaming works (deltas appear via WebSocket)
- Token usage is tracked
- No errors about Go orchestrator connection

- [ ] **Step 4: Commit any fixes**
