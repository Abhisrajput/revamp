# LLM Orchestrator - Quick Start Guide

## Prerequisites

- Go 1.23+
- Redis 6.0+ (for caching and job queue)
- Docker & Docker Compose (optional)

## Local Development Setup

### 1. Install Dependencies

```bash
cd /sessions/serene-gifted-galileo/mnt/Revamp/revamp-platform/services/llm-orchestrator
go mod download
go mod tidy
```

### 2. Setup Redis

```bash
# Using Docker
docker run -d -p 6379:6379 redis:7-alpine

# Or using brew (macOS)
brew install redis
redis-server
```

### 3. Set Environment Variables

```bash
export PORT=8080
export ENVIRONMENT=development
export LOG_LEVEL=info
export REDIS_URL=redis://localhost:6379

# At least one provider API key is required
export OPENAI_API_KEY=sk-your-key-here
# OR
export ANTHROPIC_API_KEY=sk-ant-your-key-here
# OR
export GEMINI_API_KEY=your-gemini-key
# OR setup AWS credentials for Bedrock
```

### 4. Build and Run

```bash
# Build
go build -o server ./cmd/server

# Run
./server
```

You should see output like:
```
{"level":"info","msg":"Starting LLM Orchestrator","version":"1.0.0","port":"8080"}
{"level":"info","msg":"HTTP server listening","addr":":8080"}
```

### 5. Test Health

```bash
curl http://localhost:8080/health
# Response: {"status":"healthy"}

curl http://localhost:8080/ready
# Response: {"status":"ready"}
```

## Docker Compose Setup (Recommended)

Create `.env` file:
```
OPENAI_API_KEY=sk-your-key-here
ANTHROPIC_API_KEY=sk-ant-your-key-here
GEMINI_API_KEY=your-gemini-key
```

Create `docker-compose.yml`:
```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  orchestrator:
    build: .
    ports:
      - "8080:8080"
      - "9090:9090"
    environment:
      PORT: 8080
      ENVIRONMENT: production
      LOG_LEVEL: info
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      WORKER_COUNT: 10
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

Run:
```bash
docker-compose up
```

## First API Request

### Simple Completion

```bash
curl -X POST http://localhost:8080/api/v1/completions \
  -H "Content-Type: application/json" \
  -H "X-Project-ID: proj-123" \
  -H "X-User-ID: user-456" \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ],
    "max_tokens": 100,
    "temperature": 0.7,
    "top_p": 0.9
  }'
```

Response:
```json
{
  "id": "chatcmpl-...",
  "model": "gpt-4-turbo",
  "provider": "openai",
  "content": "Hello! How can I help you today?",
  "finish_reason": "stop",
  "tokens": {
    "input": 12,
    "output": 9,
    "total": 21
  },
  "cost": 0.00045,
  "latency_ms": 234.5
}
```

### Streaming Completion

```bash
curl -X POST http://localhost:8080/api/v1/completions/stream \
  -H "Content-Type: application/json" \
  -H "X-Project-ID: proj-123" \
  -d '{
    "model": "claude-3-sonnet-20240229",
    "messages": [
      {"role": "user", "content": "Write a haiku about code"}
    ],
    "stream": true
  }'
```

Response (SSE stream):
```
event: message
data: Bytes

event: message
data: dance

event: message
data:  through

...

event: done
data: {"finish_reason": "stop"}
```

### Batch Job

```bash
curl -X POST http://localhost:8080/api/v1/batch \
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

Response:
```json
{
  "job_ids": ["job-1710604800000000000", "job-1710604800000000001"],
  "count": 2
}
```

Check status:
```bash
curl http://localhost:8080/api/v1/batch/job-1710604800000000000
```

## View Metrics

```bash
curl http://localhost:8080/metrics | grep llm_
```

Sample metrics:
```
llm_requests_total{model="gpt-4-turbo",provider="openai",status="success"} 42
llm_tokens_total{model="gpt-4-turbo",type="input"} 1024
llm_tokens_total{model="gpt-4-turbo",type="output"} 512
llm_cost_total{model="gpt-4-turbo",provider="openai"} 0.042
llm_request_duration_seconds_bucket{model="gpt-4-turbo",provider="openai",le="0.1"} 15
```

## Provider Health

```bash
curl http://localhost:8080/api/v1/providers/health
```

Response:
```json
{
  "providers": {
    "openai": {
      "name": "openai",
      "healthy": true,
      "last_error": "",
      "error_count": 0,
      "success_count": 42,
      "last_check_time": "2024-03-16T18:05:30Z",
      "latency": 234000000
    },
    "anthropic": {
      "name": "anthropic",
      "healthy": true,
      "last_error": "",
      "error_count": 0,
      "success_count": 15,
      "last_check_time": "2024-03-16T18:05:29Z",
      "latency": 156000000
    }
  }
}
```

## Available Models

```bash
curl http://localhost:8080/api/v1/models | jq '.models | keys'
```

Output:
```
[
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gpt-3.5-turbo",
  "gpt-4",
  "gpt-4-turbo"
]
```

## Monitoring with Prometheus

Create `prometheus.yml`:
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'llm-orchestrator'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: '/metrics'
```

Run Prometheus:
```bash
docker run -d -p 9090:9090 \
  -v $(pwd)/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus
```

Access at http://localhost:9090

## Common Issues

### Redis Connection Failed
```
Make sure Redis is running on localhost:6379
docker ps | grep redis
redis-cli ping  # Should respond PONG
```

### Provider Not Available
```
Error: no provider found for model 'gpt-4'

Solution: Check that OPENAI_API_KEY is set and valid
export OPENAI_API_KEY=sk-...
```

### Circuit Breaker Open
```
Error: circuit breaker open for provider openai

Solution: Wait 60 seconds (default timeout) or check provider API status
```

### Port Already in Use
```
error: bind: address already in use

Solution: Change PORT or kill the process
PORT=8081 ./server
```

## Development Tips

### Enable Debug Logging

```bash
LOG_LEVEL=debug ./server
```

### Custom Configuration

```bash
# Reduce circuit breaker threshold for testing
CIRCUIT_BREAKER_THRESHOLD=2 ./server

# Increase worker count
WORKER_COUNT=20 ./server

# Longer stream timeout
STREAM_TIMEOUT=600 ./server
```

### Test with Different Providers

```bash
# Test OpenAI
curl ... -d '{"model": "gpt-4-turbo", ...}'

# Test Anthropic
curl ... -d '{"model": "claude-3-sonnet-20240229", ...}'

# Test Gemini (requires GCP_PROJECT_ID)
curl ... -d '{"model": "gemini-2.0-flash", ...}'
```

### Monitor Worker Queue

Check Redis:
```bash
redis-cli

# List queues
KEYS "queue:*"

# Check queue length
LLEN queue:high-priority
LLEN queue:medium-priority
LLEN queue:low-priority

# Check job status
GET job:job-1710604800000000000
```

## Next Steps

1. Read full [SERVICE_OVERVIEW.md](SERVICE_OVERVIEW.md)
2. Review provider implementations in `internal/providers/`
3. Explore router logic in `internal/orchestrator/router.go`
4. Check handler implementations in `internal/api/handlers.go`
5. Setup monitoring with Prometheus + Grafana
6. Add authentication and rate limiting
7. Deploy to production environment

## Support

For issues or questions:
1. Check logs: `LOG_LEVEL=debug ./server 2>&1 | tee app.log`
2. Review provider health: `curl http://localhost:8080/api/v1/providers/health`
3. Verify Redis connection: `redis-cli ping`
4. Check metrics: `curl http://localhost:8080/metrics`
