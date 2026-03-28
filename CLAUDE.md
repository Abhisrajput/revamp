# REVAMP 10X — AI-Powered Legacy Application Modernizer

## What This Project Is

REVAMP is an enterprise platform that modernizes legacy applications (COBOL, VB6, Delphi, Fortran, PowerBuilder) into modern cloud-native services (Java/Spring Boot, Python/FastAPI, Go). It uses AI to understand business capabilities — not just translate code line-by-line — and validates every extraction with Behavior-Driven Development (BDD) specs.

This is the **10X rebuild** of the original legacy-bridge prototype. The original codebase lives at `/Users/abhisheksingh/Documents/legacy-bridge` and should be referenced for business logic, prompt templates, validation rubrics, and pipeline stage implementations.

## Architecture

Distributed microservices in a **Turborepo + pnpm** monorepo:

```
revamp-platform/
├── apps/web/                    → Next.js 15 (App Router, React 19, Tailwind v4)
├── apps/api/                    → Fastify 4 API Gateway (Drizzle ORM, PostgreSQL, BullMQ)
├── apps/vscode/                 → VS Code Extension (TypeScript, Webview UI)
├── services/llm-orchestrator/   → Go LLM Engine (Chi router, multi-provider, streaming)
├── packages/shared-types/       → Shared TypeScript type definitions
├── packages/core-engine/        → Validation rubrics, prompt templates, cloud knowledge bases
├── packages/ui/                 → Shared React components and hooks
├── packages/config/             → ESLint, TypeScript, Tailwind shared configs
└── infra/                       → Docker, Kubernetes, Terraform (AWS/GCP/Azure)
```

## Tech Stack

- **Web Frontend**: Next.js 15, React 19, Tailwind CSS v4, Zustand + React Query, Monaco Editor
- **API Gateway**: Fastify 4, Drizzle ORM, PostgreSQL, Redis, BullMQ, JWT+RBAC, WebSocket
- **LLM Orchestrator**: Go 1.23, Chi router, multi-provider (OpenAI/Claude/Gemini/Bedrock), circuit breakers, load balancing, streaming SSE, Redis job queue, Prometheus metrics
- **VS Code Extension**: TypeScript, VS Code Extension API, Webview, SSE streaming
- **Database**: PostgreSQL (13 tables via Drizzle), Redis (cache + queues)
- **Storage**: S3/MinIO for artifacts
- **Infra**: Docker Compose (dev/prod), Kubernetes with HPA, Terraform multi-cloud

## The 8-Stage Modernization Pipeline

1. **Setup & Configuration** — Project init, repo upload, architecture selection, team setup
2. **Intent Extraction** — AI discovers business intent, analyzes current state
3. **Business Capability Mining** — Maps capabilities to system components
4. **Behavior Lock-in** — Captures behavioral requirements as BDD/Gherkin specs
5. **Modernization Approach** — Defines strategy (lift & shift, refactor, rebuild)
6. **Co-Create** — AI pair programming, interactive code transformation (IDE)
7. **Parallel Run & Cutover** — Runs old+new in parallel, validates behavioral equivalence
8. **Continuous Modernization** — Sets up parallel execution framework

## Key Commands

```bash
# Install dependencies
pnpm install

# Development (all services)
pnpm dev

# Individual services
pnpm dev:web          # Next.js at localhost:3000
pnpm dev:api          # Fastify at localhost:8787
pnpm dev:vscode       # VS Code extension dev

# Go LLM orchestrator
cd services/llm-orchestrator
go build -o bin/llm-orchestrator ./cmd/server
./bin/llm-orchestrator    # runs on :8080

# Database
pnpm db:generate      # Generate Drizzle migrations
pnpm db:migrate       # Run migrations
pnpm db:studio        # Drizzle Studio GUI

# Docker
pnpm docker:dev       # Start all services (postgres, redis, minio, etc.)

# Build
pnpm build            # Build all packages
turbo build --filter=@revamp/web
```

## Database Schema (apps/api/src/db/schema.ts)

13 tables: `users`, `organizations`, `projects`, `project_members`, `pipeline_runs`, `stage_artifacts`, `llm_usage`, `audit_logs`, `approval_gates`, `prompt_templates`, `project_metrics`, `sessions`, `invitations`

Auth: JWT + bcrypt + OTP, RBAC roles: `admin`, `architect`, `developer`, `sme`

## Go LLM Orchestrator (services/llm-orchestrator/)

The core engine. Key interfaces:

```go
type LLMProvider interface {
    Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
    Stream(ctx context.Context, req *ChatRequest) (<-chan StreamChunk, error)
    Health() HealthStatus
    Models() []ModelInfo
}
```

Providers: OpenAI, Anthropic Claude, Google Gemini, AWS Bedrock
Features: Circuit breaker per provider, weighted round-robin load balancing, SSE streaming, Redis job queue with priority, semantic caching, Prometheus metrics, token/cost tracking

API: `POST /api/v1/chat/completions`, `POST /api/v1/chat/stream`, `POST /api/v1/batch`, `GET /api/v1/models`, `GET /api/v1/usage`, `GET /metrics`

## Legacy Bridge Reference

The original codebase at `/Users/abhisheksingh/Documents/legacy-bridge` contains:

- `src/lib/stageAI.ts` (59 KB) — Stage-specific AI logic (port to core-engine)
- `src/lib/aiClient.ts` (42 KB) — Multi-provider LLM interface (now replaced by Go service)
- `src/components/stages/` — 8 stage UI implementations (port to apps/web)
- `src/store/useProjectStore.ts` (44 KB) — State management (port to Zustand stores)
- `src/lib/validation/` — Validation rubrics and checks (port to core-engine)
- `src/data/promptTemplates.ts` — Prompt templates (port to core-engine)
- `src/data/{aws,gcp,azure}KnowledgeBase.ts` — Cloud knowledge (port to core-engine)
- `backend/src/server.ts` (82 KB) — Monolithic API (now decomposed into Fastify routes)
- `backend/src/agent/` — Agent runners per LLM (now in Go orchestrator)
- `backend/src/agent/sandbox.ts` (20 KB) — Tool execution sandbox

## Code Style

- TypeScript: strict mode, Zod validation on all inputs, barrel exports
- Go: standard library patterns, interfaces for testability, structured logging (zap)
- React: functional components, hooks, Server Components where possible
- CSS: Tailwind v4 utility-first, no CSS modules
- API: RESTful with Zod schema validation, consistent error responses
- State: Zustand for client state, React Query for server state

## Environment Variables

See `.env.example` at root and in each app directory. Key vars:
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY` — LLM provider keys
- `JWT_SECRET` — Auth signing key
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — Object storage
- `LLM_ORCHESTRATOR_URL` — Go service URL (default: http://localhost:8080)
