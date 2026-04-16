# WebSocket Migration + Service Consolidation Design

**Date:** 2026-04-14
**Status:** Approved
**Scope:** Replace all client-facing SSE with WebSocket, move LLM routing from Go to Node, rebrand Go service as Agent Worker Pool with gRPC interface.

---

## Context

REVAMP currently uses a hybrid transport: WebSocket for some notifications, Server-Sent Events for pipeline streaming, agent execution, and chat. The Go LLM Orchestrator acts as a proxy between the Fastify API and LLM providers, adding a network hop to every LLM call.

This design eliminates the hybrid by consolidating on WebSocket for all client-facing real-time communication and restructuring the Go service boundary to focus on what Go does best: concurrent process management for agent sandboxes and LSP servers.

### Motivation

1. **Playground readiness.** The future collaborative Playground stage requires bidirectional multi-user communication, room management, and an AI agent making rapid sequential LLM calls interleaved with business logic. WebSocket + Node-owned LLM calls enables a tight agent loop without inter-service round-trips.

2. **Eliminate transport fragmentation.** Three SSE implementations (pipeline streaming, agent tool execution, evolve chat) each with manual `reply.raw.writeHead("text/event-stream")` plumbing, keepalive timers, CORS headers, and closed-state tracking. One WebSocket with topic subscriptions replaces all of them.

3. **Right-size the Go service.** The Go orchestrator wraps 6 LLM providers with custom HTTP clients that duplicate what first-class Node SDKs provide. Moving LLM routing to Node eliminates ~4000 lines of Go wrapper code and gives us auto-updating provider SDKs. Go keeps the sandbox, LSP, and process management where goroutines genuinely help.

### Current SSE Endpoints (to be replaced)

| Location | Purpose | Lines of SSE plumbing |
|---|---|---|
| `routes/pipeline.ts:686-1054` | Stage execution streaming | ~370 |
| `routes/pipeline.ts:1572-1618` | Evolve chat streaming | ~50 |
| `routes/agents.ts:218-547` | Agent tool execution + chat | ~180 |
| `routes/agents.ts:960-1055` | Agent event streams (2 endpoints) | ~95 |
| **Total** | | **~695 lines** |

### Current Frontend SSE Consumers (to be replaced)

| Hook | Transport | Location |
|---|---|---|
| `use-stage-execution.ts` | Raw fetch + ReadableStream | `packages/core/src/hooks/` |
| `use-agent-events.ts` | EventSource | `packages/core/src/hooks/` |
| `use-evolve-chat.ts` | Raw fetch + ReadableStream | `packages/core/src/hooks/` |

### Existing WebSocket Infrastructure (to extend)

| File | What it does |
|---|---|
| `plugins/websocket.ts` | `@fastify/websocket` registered, `/ws` + `/ws/pipeline/:id` routes, JWT auth, pipeline-scoped rooms |
| `services/agent-events.ts` | Dual WS + SSE broadcast (SSE path will be removed) |
| `routes/agent-events.ts` | WebSocket upgrade for agent department events |

---

## Architecture

```
Browser (Next.js 16 / React 19)
  │
  │  Single WebSocket connection per session
  │  Topic subscriptions: pipeline:*, agent:*, chat:*
  │
  ▼
Fastify API (Node.js)
  ├── WebSocket Server — channel subscriptions, room management, Redis pub/sub bridge, presence
  ├── LLM Provider Router — Anthropic/OpenAI/Google/Bedrock SDKs, circuit breakers, BYOK, caching
  ├── Pipeline Engine — 8-stage orchestration, validation, contracts, approval gates
  └── Business Logic — auth, RBAC, projects, Jira, agents, DB
  │
  │  gRPC (internal, bidirectional streaming)
  │  Task dispatch + streaming results
  │
  ▼
Go Agent Worker Pool
  ├── Sandbox — file R/W/edit, shell execution, path security, resource limits
  ├── LSP Manager — tsserver, jdtls, gopls, pylsp lifecycle management
  └── Build/Test — compile checks, test runners, FORGE codegen, timeout enforcement

Infrastructure:
  PostgreSQL — projects, runs, artifacts
  Redis — WS pub/sub, semantic cache, job queue
  MinIO/S3 — artifacts, codebase storage
```

### Service Boundary Rules

| Service | Owns | Does NOT own |
|---|---|---|
| **Fastify (Node)** | WebSocket, API routes, auth, LLM calls, pipeline orchestration, business logic, DB | Sandbox file ops, LSP servers, shell execution, process isolation |
| **Go Agent Worker** | Sandbox execution, LSP lifecycle, workspace management, resource limits, build/test | LLM calls, auth, DB access, WebSocket, business logic |

---

## Section 1: WebSocket Transport Layer

### Connection Model

Single WebSocket connection per browser session. Client connects to `wss://host/ws?token=<jwt>`. JWT verified on upgrade using the existing `verifyWsToken` in `plugins/websocket.ts`.

### Topic Subscriptions

Client subscribes by sending JSON messages:

```json
{ "action": "subscribe", "topic": "pipeline:abc-123" }
{ "action": "subscribe", "topic": "agent:events" }
{ "action": "subscribe", "topic": "chat:abc-123:EVOLVE" }
{ "action": "unsubscribe", "topic": "pipeline:abc-123" }
```

Server pushes events only to subscribed topics:

```json
{ "topic": "pipeline:abc-123", "event": "delta", "data": { "text": "## Business Rules\n" } }
{ "topic": "pipeline:abc-123", "event": "phase", "data": { "phase": "validating", "progress": 85 } }
{ "topic": "agent:events", "event": "agent.task_completed", "data": { "agentId": "...", "agentName": "..." } }
```

### Topic Naming Convention

```
pipeline:<runId>          — stage execution events (delta, phase, validation, complete, error)
pipeline:<runId>:status   — stage progress updates (from approval, advance, reset)
agent:events              — all agent department events (broadcast)
agent:<agentId>           — events for a specific agent
chat:<runId>:<stageName>  — evolve chat streaming
playground:<roomId>       — future: collaborative room events
```

### Authorization

Topic subscriptions are validated server-side:
- `pipeline:*` — user must have access to the pipeline's project (existing ownership check in `plugins/websocket.ts`)
- `agent:*` — user must be authenticated (any role)
- `chat:*` — user must have access to the pipeline's project
- `playground:*` — future: room-level RBAC

### Redis Pub/Sub Bridge

Every `publish(topic, event, data)` call does two things:
1. Delivers to local WebSocket clients subscribed to the topic
2. Publishes to Redis channel `ws:<topic>` via `ioredis` (already in deps)

Every Fastify instance subscribes to `ws:*` on startup using a dedicated `ioredis` subscriber connection (Redis requires separate connections for pub/sub). When a Redis message arrives, it delivers to local WebSocket clients. This enables horizontal scaling with zero application code changes.

### Reconnection Protocol

Client-side:
- Exponential backoff: 1s, 2s, 4s, 8s, max 30s
- On reconnect: re-subscribes to all previously active topics
- Queues outbound messages during disconnect, flushes on reconnect

Server-side:
- On new subscription to `pipeline:<runId>`, sends a `snapshot` event with current stage statuses so the client doesn't show stale state after a reconnect

### Heartbeat

Server sends `{ "event": "ping" }` every 30s. Client responds with `{ "action": "pong" }`. If no pong received within 10s, server closes the connection (triggers client reconnect).

---

## Section 2: LLM Provider Migration (Go to Node)

### File Structure

```
packages/core-engine/src/llm/
  ├── types.ts               — LLMProvider interface, ChatRequest, ChatResponse, StreamChunk
  ├── anthropic.ts           — @anthropic-ai/sdk wrapper
  ├── openai.ts              — openai SDK wrapper
  ├── google.ts              — @google/generative-ai wrapper
  ├── bedrock.ts             — @anthropic-ai/bedrock-sdk wrapper
  ├── azure.ts               — Azure OpenAI wrapper
  ├── router.ts              — Provider selection, weighted routing, model-to-provider mapping
  ├── circuit-breaker.ts     — cockatiel circuit breakers, one per provider
  ├── cache.ts               — Redis semantic cache (hash prompt → cached response)
  ├── cost.ts                — Token counting + cost estimation per model
  ├── factory.ts             — createLLMCallFn() and createLLMEvalFn() factories
  └── index.ts               — Public API barrel export
```

### Provider Interface

```typescript
interface LLMProvider {
  name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<StreamChunk>;
  health(): Promise<HealthStatus>;
  models(): string[];
}
```

Each provider wraps its SDK's native streaming. No custom HTTP clients — the SDK handles retries, connection management, and protocol details.

### Circuit Breakers

One `cockatiel` circuit breaker per provider instance:

```typescript
const breaker = new CircuitBreakerPolicy({
  halfOpenAfter: 30_000,
  breaker: new ConsecutiveBreaker(3),
});
// Wraps every provider call
const response = await breaker.execute(() => provider.chat(request));
```

Cockatiel handles Open → HalfOpen → Closed transitions correctly. No custom state machine (fixes C8 from audit — stuck HalfOpen bug in the Go implementation).

### Router Logic

Model-to-provider mapping:

```typescript
const MODEL_PROVIDERS: Record<string, string> = {
  'claude-*': 'anthropic',      // or 'bedrock' if AWS credentials present
  'gpt-*': 'openai',
  'o1-*': 'openai',
  'gemini-*': 'google',
};
```

Provider selection priority:
1. BYOK credentials for the project (if configured)
2. Model prefix mapping
3. Fallback chain: primary provider → secondary → tertiary

### BYOK Credential Injection

Existing `resolveProjectCredentials()` returns per-project keys. Each LLM call instantiates the SDK with the project's credentials:

```typescript
function getProvider(model: string, credentials?: ProjectCredentials): LLMProvider {
  if (model.startsWith('claude') && credentials?.bedrockRegion) {
    return new BedrockProvider({ region: credentials.bedrockRegion, ... });
  }
  if (model.startsWith('claude')) {
    return new AnthropicProvider({ apiKey: credentials?.anthropicKey || process.env.ANTHROPIC_API_KEY });
  }
  // ...
}
```

### Semantic Cache

Same strategy as Go implementation: hash the prompt (system + user + model) → check Redis → return cached response or call provider.

Cache key: `llm:cache:<sha256(system + user + model + temperature)>`
TTL: 1 hour (configurable per project)
Bypass: `cache: false` in the call options

### Streaming Integration with WebSocket

```typescript
async function streamToTopic(
  provider: LLMProvider,
  request: ChatRequest,
  topic: string,
  publisher: WSPublisher,
): Promise<ChatResponse> {
  const stream = provider.stream(request);
  let fullText = '';
  
  for await (const chunk of stream) {
    fullText += chunk.text;
    publisher.publish(topic, 'delta', { text: chunk.text });
  }
  
  return { text: fullText, model: request.model, usage: stream.usage };
}
```

One hop: SDK → Node → WebSocket → Browser. No Go intermediary.

### What's Deleted from Go

| Directory | Lines | Purpose |
|---|---|---|
| `internal/orchestrator/` | ~2500 | Engine, router, balancer, circuit breaker, stream, classifier |
| `internal/providers/` | ~1500 | Anthropic, OpenAI, Gemini, Bedrock, Azure, VertexAI, Ephemeral wrappers |
| `internal/metrics/cost.go` | ~200 | Cost tracking (moves to Node) |
| `cmd/server/main.go` | ~150 | HTTP server setup (replaced by gRPC) |
| **Total removed** | **~4350** | |

---

## Section 3: Go Agent Worker (gRPC Interface)

### Service Definition

```protobuf
syntax = "proto3";
package revamp.worker;

service AgentWorker {
  // Execute a single tool call in a sandboxed workspace
  rpc ExecuteTool(ToolRequest) returns (ToolResponse);
  
  // Bidirectional stream for agent tool loops
  // Node sends tool call requests, Go executes and streams results
  rpc RunToolLoop(stream ToolLoopMessage) returns (stream ToolLoopMessage);
  
  // LSP server lifecycle
  rpc StartLSP(LSPRequest) returns (LSPResponse);
  rpc StopLSP(LSPStopRequest) returns (LSPStopResponse);
  
  // Workspace management
  rpc CreateWorkspace(WorkspaceRequest) returns (WorkspaceResponse);
  rpc CleanupWorkspace(WorkspaceCleanupRequest) returns (WorkspaceCleanupResponse);
  
  // Health check
  rpc Health(HealthRequest) returns (HealthResponse);
}

message ToolRequest {
  string workspace_id = 1;
  string tool_name = 2;       // read_file, write_file, lsp_hover, shell_exec, etc.
  string args_json = 3;       // Tool-specific arguments as JSON
  int32 timeout_ms = 4;
}

message ToolResponse {
  bool success = 1;
  string output = 2;
  string error = 3;
}

message ToolLoopMessage {
  oneof payload {
    ToolRequest tool_request = 1;
    ToolResponse tool_response = 2;
    LoopControl control = 3;   // cancel, timeout, done
  }
}

message LoopControl {
  string action = 1;           // "cancel", "timeout", "done"
  string reason = 2;
}

message LSPRequest {
  string workspace_id = 1;
  string language = 2;         // "typescript", "java", "python", "go"
}

message LSPResponse {
  bool started = 1;
  string server_id = 2;
  string error = 3;
}

message LSPStopRequest {
  string server_id = 1;
}

message LSPStopResponse {
  bool stopped = 1;
}

message WorkspaceRequest {
  string project_id = 1;
  string source_path = 2;     // Path to codebase on shared storage
}

message WorkspaceResponse {
  string workspace_id = 1;
  string workspace_path = 2;
}

message WorkspaceCleanupRequest {
  string workspace_id = 1;
}

message WorkspaceCleanupResponse {
  bool cleaned = 1;
}

message HealthRequest {}

message HealthResponse {
  bool healthy = 1;
  int32 active_workspaces = 2;
  int32 active_lsp_servers = 3;
  int32 goroutines = 4;
}
```

### Go File Structure

```
services/agent-worker/                (renamed from llm-orchestrator)
  ├── cmd/server/main.go              — gRPC server setup, graceful shutdown
  ├── internal/
  │   ├── tools/
  │   │   ├── sandbox.go              — File ops, shell exec (existing, kept)
  │   │   ├── loop.go                 — Tool dispatch (simplified — no LLM calls)
  │   │   └── lsp.go                  — LSP server management (moved from Node)
  │   ├── workspace/
  │   │   ├── manager.go              — Create/cleanup sandboxed directories
  │   │   └── limits.go               — Resource limits, timeout enforcement
  │   └── server/
  │       └── grpc.go                 — gRPC service implementation
  ├── proto/
  │   └── worker.proto                — Service contract
  ├── go.mod
  └── Dockerfile
```

### What Moves from Node to Go

`apps/api/src/services/lsp-manager.ts` (470 lines) → `internal/tools/lsp.go`. LSP servers are child processes that need lifecycle management, resource limits, and cleanup on timeout. This belongs with the sandbox.

### What's Deleted from Go

The entire `internal/orchestrator/` and `internal/providers/` directories. The HTTP server in `cmd/server/main.go` is replaced with a gRPC server.

### Node-Side gRPC Client

```
apps/api/src/services/agent-worker-client.ts
```

Wraps the gRPC client with the same `executeTool()` interface currently used by `sandbox.ts`. Existing agent execution code calls the same function signature — the transport changes from local function call to gRPC, but the API stays the same.

---

## Section 4: Frontend WebSocket Client

### WSManager Interface

```
packages/core/src/api/ws.ts
```

```typescript
interface WSEvent {
  topic: string;
  event: string;
  data: unknown;
}

interface WSManager {
  connect(url: string, token: string): void;
  disconnect(): void;
  subscribe(topic: string, handler: (event: WSEvent) => void): () => void;  // Returns unsubscribe fn
  send(message: Record<string, unknown>): void;
  isConnected(): boolean;
  onConnectionChange(handler: (connected: boolean) => void): () => void;
}
```

Follows the Multica platform bridge pattern. `packages/core` defines the interface. `apps/web` provides the browser implementation. VS Code extension provides its own implementation (future).

### Registration

```typescript
// apps/web/app/providers.tsx
import { setWSManager } from '@revamp/core/api/ws';
import { createBrowserWSManager } from '@/lib/ws-client';

setWSManager(createBrowserWSManager());
```

### Browser Implementation

```
apps/web/lib/ws-client.ts
```

Features:
- Reconnection with exponential backoff (1s → 2s → 4s → 8s → max 30s)
- Automatic topic re-subscription on reconnect
- Outbound message queue during disconnect (flushes on reconnect)
- Heartbeat pong response
- Connection state events

### React Hooks

```
packages/core/src/hooks/use-ws.ts
```

```typescript
// Subscribe to a topic — returns events
function useWSSubscribe(topic: string, handler: (event: WSEvent) => void): void;

// Connection status
function useWSConnected(): boolean;
```

### Migrated Hooks

| Hook | Before | After |
|---|---|---|
| `use-stage-execution.ts` | raw fetch + ReadableStream SSE parsing (~220 lines) | HTTP POST to start + `useWSSubscribe('pipeline:' + runId)` (~80 lines) |
| `use-agent-events.ts` | EventSource (~140 lines) | `useWSSubscribe('agent:events')` (~30 lines) |
| `use-evolve-chat.ts` | raw fetch + ReadableStream (~120 lines) | HTTP POST to send + `useWSSubscribe('chat:' + runId + ':' + stage)` (~50 lines) |

### Connection Indicator

`useWSConnected()` drives a status dot in the TopBar:
- Green: connected
- Amber: reconnecting
- Red: disconnected > 10s

---

## Section 5: Backend WebSocket Event Publishing

### Publisher Service

```
apps/api/src/services/ws-publisher.ts
```

```typescript
interface WSPublisher {
  publish(topic: string, event: string, data: unknown): void;
  publishPattern(pattern: string, event: string, data: unknown): void;
}
```

Internally:
1. Delivers to local WebSocket clients subscribed to the topic
2. Publishes to Redis channel `ws:<topic>` for other Fastify instances

### Route Handler Changes

Before (inline SSE):
```typescript
reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
const sendSSE = (type, data) => { reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
// keepalive, CORS, closed flag, try/catch...
```

After (topic publishing):
```typescript
const result = await pipelineService.executeStage(runId, stageName, vars, {
  onEvent: (event) => publisher.publish(`pipeline:${runId}`, event.phase, event.data),
  onDelta: (text) => publisher.publish(`pipeline:${runId}`, 'delta', { text }),
});
reply.send({ success: true, result });
```

Routes become normal REST endpoints. All real-time events flow through WebSocket topics.

### What's Deleted

| Code | Lines removed |
|---|---|
| `reply.raw.writeHead("text/event-stream")` — 6 occurrences | ~30 |
| Inline `sendSSE()` helpers — 3 route handlers | ~60 |
| Keepalive interval timers — 3 occurrences | ~30 |
| `reply.raw.end()` calls — 6 occurrences | ~12 |
| SSE client tracking (`SSEClient`, `sseClients`, `addSSEClient`, `removeSSEClient`) | ~30 |
| SSE event stream routes in `routes/agents.ts` (3 endpoints) | ~200 |
| Manual CORS headers for SSE responses | ~30 |
| **Total** | **~390 lines** |

---

## Section 6: Migration Strategy

### Phase 1 — WebSocket Transport

**Goal:** Replace all client-facing SSE with WebSocket. No backend architecture changes.

**Deliverables:**
- `packages/core/src/api/ws.ts` — WSManager interface + injection
- `packages/core/src/hooks/use-ws.ts` — `useWSSubscribe`, `useWSConnected`
- `apps/web/lib/ws-client.ts` — Browser WebSocket implementation
- `apps/api/src/services/ws-publisher.ts` — Topic publisher with Redis pub/sub
- `apps/api/src/plugins/websocket.ts` — Extended with topic subscriptions
- Migrated hooks: `use-stage-execution`, `use-agent-events`, `use-evolve-chat`
- Delete: all SSE code in routes + agent-events SSE tracking

**Validates:** WebSocket works end-to-end, reconnection is solid, Redis pub/sub delivers across instances.

**Go orchestrator status:** Still handles LLM calls during this phase. Only the browser transport changes.

### Phase 2 — LLM Provider Routing (Go to Node)

**Goal:** Move LLM provider routing from Go to Node using first-class SDKs.

**Deliverables:**
- `packages/core-engine/src/llm/` — All provider wrappers, router, circuit breakers, cache, factory
- `apps/api/src/services/llm-proxy.ts` — Rewritten to use Node providers (no Go calls)
- New dependencies: `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, `@anthropic-ai/bedrock-sdk`, `cockatiel`
- Delete: Go `internal/orchestrator/`, `internal/providers/`, `internal/metrics/cost.go`

**Parallel validation:** Run both paths for one sprint — Node SDK for new pipeline runs, Go fallback for in-flight runs. Compare outputs and performance.

**Validates:** All 6 providers work, streaming correct, BYOK works, circuit breakers trip and recover, cost tracking accurate.

### Phase 3 — Go Agent Worker (gRPC)

**Goal:** Rebrand Go service from "LLM Orchestrator" to "Agent Worker Pool" with gRPC interface.

**Deliverables:**
- `services/agent-worker/proto/worker.proto` — gRPC contract
- `services/agent-worker/cmd/server/main.go` — gRPC server (replaces HTTP)
- `services/agent-worker/internal/tools/lsp.go` — LSP management (moved from Node)
- `apps/api/src/services/agent-worker-client.ts` — gRPC client
- Delete: Go HTTP server, `internal/orchestrator/`, `internal/providers/`
- Delete: `apps/api/src/services/lsp-manager.ts`, `apps/api/src/services/lsp-client.ts`

**Validates:** Agent tool calls (read, write, LSP, shell) work via gRPC, timeouts propagate through context cancellation, workspace cleanup works.

### Phase 4 — Cleanup

**Goal:** Remove dead code, update infrastructure configs.

**Deliverables:**
- Delete `apps/api/src/services/sandbox.ts` Node-side tool executors that overlap with Go worker
- Update Docker Compose: rename service, change ports (8080 → 9090)
- Update Kubernetes manifests
- Update environment variables in `.env.example`
- Update CLAUDE.md architecture section
- Remove Go-specific env vars (`LLM_ORCHESTRATOR_URL`)

### Risk Mitigation

- Phase 1 is lowest risk (transport change only, no business logic change)
- Phase 2 is highest risk (LLM routing is the core revenue path). Mitigated by running both paths in parallel before cutover.
- Phase 3 is medium risk (agent tools already work in Go, just changing transport from HTTP to gRPC)
- Each phase is independently shippable. If Phase 2 slips, Phase 1 is still valuable on its own.

### Not In Scope

- Playground collaborative stage (future — builds on this foundation)
- BREE Engine changes (stays as-is, separate Rust service)
- VS Code extension WebSocket client (future — uses same WSManager interface)
- Database schema changes (none needed)
- Mobile/desktop clients (future — WSManager interface supports them)

---

## New Dependencies

### Node (packages/core-engine)
- `@anthropic-ai/sdk` — Claude API
- `openai` — OpenAI/GPT API
- `@google/generative-ai` — Gemini API
- `@anthropic-ai/bedrock-sdk` — AWS Bedrock
- `cockatiel` — Circuit breakers, retries, timeouts

### Node (apps/api)
- `@grpc/grpc-js` — gRPC client for Go worker
- `@grpc/proto-loader` — Proto file loading

### Go (services/agent-worker)
- `google.golang.org/grpc` — gRPC server
- `google.golang.org/protobuf` — Protocol buffers

---

## File Inventory

### New Files

| File | Package | Purpose | Est. Lines |
|---|---|---|---|
| `packages/core/src/api/ws.ts` | core | WSManager interface + injection | ~80 |
| `packages/core/src/hooks/use-ws.ts` | core | useWSSubscribe, useWSConnected | ~60 |
| `apps/web/lib/ws-client.ts` | web | Browser WebSocket implementation | ~120 |
| `apps/api/src/services/ws-publisher.ts` | api | Topic publisher + Redis bridge | ~100 |
| `apps/api/src/services/agent-worker-client.ts` | api | gRPC client for Go worker | ~80 |
| `packages/core-engine/src/llm/types.ts` | core-engine | Provider interface, request/response types | ~60 |
| `packages/core-engine/src/llm/anthropic.ts` | core-engine | Anthropic SDK wrapper | ~80 |
| `packages/core-engine/src/llm/openai.ts` | core-engine | OpenAI SDK wrapper | ~80 |
| `packages/core-engine/src/llm/google.ts` | core-engine | Google Gemini wrapper | ~80 |
| `packages/core-engine/src/llm/bedrock.ts` | core-engine | AWS Bedrock wrapper | ~80 |
| `packages/core-engine/src/llm/azure.ts` | core-engine | Azure OpenAI wrapper | ~60 |
| `packages/core-engine/src/llm/router.ts` | core-engine | Provider selection + routing | ~120 |
| `packages/core-engine/src/llm/circuit-breaker.ts` | core-engine | cockatiel circuit breakers | ~60 |
| `packages/core-engine/src/llm/cache.ts` | core-engine | Redis semantic cache | ~80 |
| `packages/core-engine/src/llm/cost.ts` | core-engine | Token counting + cost estimation | ~100 |
| `packages/core-engine/src/llm/factory.ts` | core-engine | createLLMCallFn factory | ~60 |
| `services/agent-worker/proto/worker.proto` | go | gRPC service contract | ~80 |
| `services/agent-worker/cmd/server/main.go` | go | gRPC server entry point | ~80 |
| `services/agent-worker/internal/server/grpc.go` | go | gRPC service implementation | ~200 |
| `services/agent-worker/internal/tools/lsp.go` | go | LSP management (from Node) | ~400 |
| `services/agent-worker/internal/workspace/manager.go` | go | Workspace lifecycle | ~100 |

### Deleted Files

| File | Lines removed |
|---|---|
| `services/llm-orchestrator/internal/orchestrator/*.go` (8 files) | ~2500 |
| `services/llm-orchestrator/internal/providers/*.go` (7 files) | ~1500 |
| `services/llm-orchestrator/internal/metrics/cost.go` | ~200 |
| `services/llm-orchestrator/cmd/server/main.go` (HTTP server) | ~150 |
| `apps/api/src/services/lsp-manager.ts` | ~470 |
| `apps/api/src/services/lsp-client.ts` | ~200 |
| **Total deleted** | **~5020** |

### Modified Files

| File | Change |
|---|---|
| `apps/api/src/plugins/websocket.ts` | Add topic subscription management, Redis bridge |
| `apps/api/src/routes/pipeline.ts` | Remove SSE streaming, use publisher |
| `apps/api/src/routes/agents.ts` | Remove SSE endpoints, use publisher |
| `apps/api/src/services/agent-events.ts` | Remove SSE client tracking |
| `apps/api/src/services/llm-proxy.ts` | Rewrite to use Node LLM providers |
| `apps/api/src/services/agent-execution.ts` | Use gRPC worker client for tool execution |
| `packages/core/src/hooks/use-stage-execution.ts` | Replace fetch+ReadableStream with WS subscribe |
| `packages/core/src/hooks/use-agent-events.ts` | Replace EventSource with WS subscribe |
| `packages/core/src/hooks/use-evolve-chat.ts` | Replace fetch+ReadableStream with WS subscribe |
| `apps/web/app/providers.tsx` | Register WSManager |
| `CLAUDE.md` | Update architecture section |
