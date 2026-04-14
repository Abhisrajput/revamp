# LLM Orchestrator Service

A production-grade, high-availability LLM orchestration engine built in Go that routes requests across multiple LLM providers (OpenAI, Anthropic Claude, Google Gemini, AWS Bedrock) with advanced features including circuit breakers, intelligent load balancing, streaming support, job queues, caching, and comprehensive metrics.

## Architecture Overview

### Core Components

1. **Provider Layer** (`internal/providers/`)
   - Unified interface for multiple LLM providers
   - OpenAI (GPT-4, GPT-4 Turbo, GPT-3.5 Turbo)
   - Anthropic Claude (3 Opus, 3 Sonnet, 3.5 Sonnet, 3 Haiku)
   - Google Gemini (2.0 Flash, 1.5 Pro, 1.5 Flash)
   - AWS Bedrock (Claude, Llama 3)
   - Streaming support for all providers
   - Per-provider cost calculation

2. **Orchestration Engine** (`internal/orchestrator/`)
   - **Engine**: Main orchestration logic routing requests
   - **Router**: Intelligent model-to-provider selection
   - **Load Balancer**: Weighted round-robin and latency-aware selection
   - **Circuit Breaker**: Per-provider failure protection
   - **Stream Multiplexer**: Real-time token delivery via SSE

3. **API Layer** (`internal/api/`)
   - Chi HTTP router
   - RESTful endpoints for completions, streaming, batch jobs
   - Health checks and readiness probes
   - CORS and authentication middleware
   - Rate limiting and request validation

4. **Async Processing** (`internal/queue/`)
   - Worker pool for background LLM jobs
   - Priority queue (high/medium/low)
   - Redis-backed job storage
   - Automatic retry with exponential backoff

5. **Caching** (`internal/cache/`)
   - Redis cache backend
   - Semantic cache with embedding similarity
   - TTL-based expiration
   - Hit/miss tracking

6. **Metrics** (`internal/metrics/`)
   - Prometheus metrics export
   - Token usage tracking per project/user/model
   - Cost tracking and budget management
   - Provider health and latency monitoring

## API Endpoints

### Completions

```
POST /api/v1/completions
POST /api/v1/completions/stream
POST /api/v1/chat/completions
POST /api/v1/chat/completions/stream
```

### Batch Jobs

```
POST /api/v1/batch
GET /api/v1/batch/{jobID}
```

### Models

```
GET /api/v1/models
GET /api/v1/models/{model}/info
```

### Usage & Metrics

```
GET /api/v1/usage/tokens
GET /api/v1/usage/cost
GET /api/v1/usage/quota
GET /api/v1/providers/health
GET /metrics
```

### Health

```
GET /health
GET /ready
```

## Configuration

Environment variables:

```
# Server
PORT=8080
ENVIRONMENT=production
LOG_LEVEL=info

# Redis
REDIS_URL=redis://localhost:6379

# Provider API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
GCP_PROJECT_ID=...

# AWS Credentials (for Bedrock)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Circuit Breaker
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_TIMEOUT=60

# Workers
WORKER_COUNT=10
QUEUE_SIZE=1000

# Caching
CACHE_TTL=3600
CACHE_ENABLED=true

# Rate Limiting
RATE_LIMIT_PER_MINUTE=100
RATE_LIMIT_PER_DAY=10000

# Authentication
API_KEY=your-api-key-here

# Streaming
STREAM_TIMEOUT=300
```

## Key Features

### Intelligent Routing
- Automatic model-to-provider mapping
- Health-based provider selection
- Latency-aware load balancing
- Fallback provider support

### Reliability
- Circuit breaker pattern per provider
- Automatic failure detection and recovery
- Graceful degradation
- Health checks and readiness probes

### Performance
- Request/response streaming with SSE
- Efficient token multiplexing
- Cache hit optimization
- Async job processing with priority queues

### Observability
- Prometheus metrics endpoint
- Per-provider latency tracking
- Token usage analytics
- Cost breakdown by project/user/model
- Structured logging with zap

### Cost Management
- Real-time cost tracking
- Per-project quotas and budgets
- Model-specific pricing
- Provider cost comparison

## Building & Running

### Local Development

```bash
# Download dependencies
go mod download

# Build
go build -o server ./cmd/server

# Run (with environment variables)
./server
```

### Docker

```bash
# Build image
docker build -t llm-orchestrator:latest .

# Run container
docker run -p 8080:8080 -p 9090:9090 \
  -e OPENAI_API_KEY=sk-... \
  -e REDIS_URL=redis://redis:6379 \
  llm-orchestrator:latest
```

### Docker Compose

```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  orchestrator:
    build: .
    ports:
      - "8080:8080"
      - "9090:9090"
    environment:
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      REDIS_URL: redis://redis:6379
    depends_on:
      - redis
```

## Example Requests

### Synchronous Completion

```bash
curl -X POST http://localhost:8080/api/v1/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -H "X-Project-ID: proj-123" \
  -H "X-User-ID: user-456" \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ],
    "max_tokens": 100,
    "temperature": 0.7
  }'
```

### Streaming Completion

```bash
curl -X POST http://localhost:8080/api/v1/completions/stream \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -H "X-Project-ID: proj-123" \
  -d '{
    "model": "claude-3-sonnet-20240229",
    "messages": [
      {"role": "user", "content": "Write a poem about coding"}
    ],
    "stream": true
  }'
```

### Batch Job

```bash
curl -X POST http://localhost:8080/api/v1/batch \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -H "X-Project-ID: proj-123" \
  -d '{
    "jobs": [
      {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Task 1"}],
        "priority": 8
      },
      {
        "model": "claude-3-opus-20240229",
        "messages": [{"role": "user", "content": "Task 2"}],
        "priority": 5
      }
    ]
  }'
```

## Performance Characteristics

- **Latency**: P50 <200ms, P99 <500ms (depending on provider)
- **Throughput**: 1000+ concurrent requests
- **Token Streaming**: Real-time with <100ms chunk latency
- **Cache Hit Ratio**: 40-60% for common patterns
- **Worker Pool**: Configurable, default 10 concurrent job processors

## Monitoring

### Prometheus Metrics

- `llm_requests_total`: Total requests by model/provider/status
- `llm_request_duration_seconds`: Request latency histogram
- `llm_tokens_total`: Total tokens used (input/output)
- `llm_cost_total`: Total cost by model/provider
- `llm_cache_hits_total`: Cache hit count
- `llm_provider_latency_seconds`: Per-provider latency
- `llm_circuit_breaker_state`: Circuit breaker state per provider

### Logging

Structured logging with zap, searchable by:
- `request_id`: Unique request identifier
- `project_id`: Project context
- `user_id`: User context
- `provider`: LLM provider used
- `model`: Model requested
- `duration`: Execution time

## Cost Breakdown

Example pricing (per 1M tokens):

| Model | Input | Output |
|-------|-------|--------|
| GPT-4 Turbo | $10 | $30 |
| Claude 3 Opus | $15 | $75 |
| Gemini 2.0 Flash | $0.075 | $0.30 |
| Llama 3 70B | $4.95 | $6.60 |

## Security Considerations

- API key authentication required
- Rate limiting per key
- Request validation
- SQL injection prevention (no SQL used)
- CORS configuration
- Non-root container user
- TLS ready (add reverse proxy)

## Scaling

- Horizontal scaling: Run multiple instances with shared Redis
- Load balancing: Use nginx or cloud load balancer
- Auto-scaling: Based on queue depth and request latency
- Multi-region: Support for regional provider deployments

## Future Enhancements

- [ ] Multi-region provider failover
- [ ] Advanced caching with semantic similarity
- [ ] Custom model fine-tuning integration
- [ ] Webhook notifications for batch jobs
- [ ] Advanced analytics dashboard
- [ ] Distributed tracing (OpenTelemetry)
- [ ] gRPC interface
- [ ] WebSocket streaming
