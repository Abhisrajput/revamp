# REVAMP Platform

> Enterprise-grade monolith-to-microservices modernization orchestration platform powered by LLM

## Overview

REVAMP is a comprehensive platform designed to automate and streamline the complex process of modernizing legacy monolithic applications into scalable microservices architectures. Using advanced LLM-powered analysis and pattern recognition, REVAMP guides organizations through each stage of architectural transformation with precision and confidence.

## Features

- **8-Stage Pipeline**: Comprehensive modernization journey from discovery to parallel run
- **LLM-Powered Analysis**: Multi-provider LLM orchestration for intelligent code analysis
- **Real-time Streaming**: Server-sent events for live pipeline progress
- **Approval Gates**: Built-in governance and team collaboration checkpoints
- **Cloud-Agnostic**: AWS, GCP, and Azure support with knowledge bases
- **Production-Ready**: Kubernetes-native, horizontally scalable architecture
- **Enterprise Security**: Zero-trust networking, encryption, RBAC, audit trails

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Web Application (Next.js)              │
│                    React + Tailwind + TypeScript           │
└──────────────────────────┬──────────────────────────────────┘
                          │
┌──────────────────────────▼──────────────────────────────────┐
│                  API Gateway (Fastify/Node)                │
│            ◄─ Request Routing, Auth, Validation ►          │
└──────┬──────────────────────────────────┬──────────────────┘
       │                                  │
┌──────▼──────────────┐    ┌──────────────▼──────────────┐
│  Core Engine        │    │  LLM Orchestrator (Go)      │
│  - Validation       │    │  - Multi-provider routing   │
│  - Analysis         │    │  - Prompt templates         │
│  - Transformations  │    │  - Response streaming       │
└──────┬──────────────┘    └──────────────┬──────────────┘
       │                                  │
┌──────▼──────────────────────────────────▼──────────────┐
│              Data Layer                               │
│  ┌────────────┐  ┌────────┐  ┌────────┐  ┌────────┐ │
│  │ PostgreSQL │  │ Redis  │  │ MinIO  │  │ Secrets│ │
│  └────────────┘  └────────┘  └────────┘  └────────┘ │
└───────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 16+
- Redis 7+
- pnpm (recommended) or npm

### Local Development

1. **Clone and setup**:
```bash
git clone https://github.com/your-org/revamp-platform.git
cd revamp-platform
pnpm install
```

2. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your API keys and local configuration
```

3. **Start services**:
```bash
docker-compose up -d
```

4. **Run migrations**:
```bash
pnpm run db:migrate
pnpm run db:seed
```

5. **Start development servers**:
```bash
# In separate terminals
pnpm --filter=@revamp/api run dev    # API on :3000
pnpm --filter=@revamp/web run dev    # Web on :3001
pnpm --filter=llm-orchestrator run dev  # Orchestrator on :8080
```

Visit http://localhost:3001

### Docker Compose (Production)

```bash
# Build images
docker-compose build

# Start services
docker-compose -f docker-compose.prod.yml up -d

# View logs
docker-compose logs -f
```

### Kubernetes Deployment

```bash
# Create namespace
kubectl apply -f infra/k8s/base/namespace.yaml

# Deploy with Kustomize
kubectl apply -k infra/k8s/base/

# Check rollout status
kubectl rollout status deployment/revamp-api -n revamp
kubectl rollout status deployment/revamp-web -n revamp
kubectl rollout status deployment/revamp-llm-orchestrator -n revamp
```

## Project Structure

```
revamp-platform/
├── apps/
│   ├── api/                    # Fastify API gateway
│   ├── web/                    # Next.js frontend
│   └── vscode/                 # VS Code extension
├── packages/
│   ├── shared-types/           # TypeScript type definitions
│   ├── core-engine/            # Validation, analysis, transformations
│   ├── ui/                     # React components & hooks
│   └── config/                 # Shared configs (ESLint, TypeScript, Tailwind)
├── services/
│   └── llm-orchestrator/       # Go service for LLM coordination
├── infra/
│   ├── docker/                 # Docker configurations
│   ├── k8s/                    # Kubernetes manifests
│   └── terraform/              # Infrastructure as Code
└── docs/                       # Documentation
```

## Pipeline Stages

### 1. Discovery
- Analyze existing application architecture
- Identify components, dependencies, and interactions
- Document technology stack and deployment model
- Assess technical debt and pain points

### 2. Capability Mining
- Identify business capabilities suitable for extraction
- Define service ownership and boundaries
- Analyze data ownership and dependencies
- Evaluate complexity and scaling requirements

### 3. Service Boundary
- Design optimal microservice boundaries
- Define service responsibilities and ownership
- Plan communication patterns (sync/async)
- Address team structure and Conway's Law

### 4. Behavior Lock-In
- Define precise service contracts and APIs
- Specify request/response schemas
- Define error handling and SLAs
- Lock in non-functional requirements

### 5. Extraction
- Plan code extraction and refactoring
- Identify interfaces to extract
- Plan data migrations
- Create implementation roadmap

### 6. Modernization Approach
- Design overall modernization strategy
- Select technologies and platforms
- Define phasing and milestones
- Plan team structure and responsibilities

### 7. Co-Create
- Collaborate with stakeholders
- Refine and finalize implementation plans
- Address concerns and feedback
- Build team consensus

### 8. Parallel Run
- Plan parallel system operation
- Define data synchronization strategy
- Validate system equivalence
- Execute safe migration cutover

## Configuration

### Environment Variables

See `.env.example` for all available configuration options.

**Critical variables**:
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` - LLM provider keys
- `JWT_SECRET` - Session encryption key

### LLM Provider Setup

1. **OpenAI**:
```bash
export OPENAI_API_KEY=sk-...
```

2. **Anthropic**:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

3. **Google**:
```bash
export GOOGLE_API_KEY=...
export GOOGLE_PROJECT_ID=...
```

4. **AWS Bedrock**:
```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
```

## API Documentation

### Health Checks

```bash
# Overall health
curl http://localhost:3000/health

# LLM provider status
curl http://localhost:3000/health/llm

# Ready check
curl http://localhost:3000/ready
```

### Streaming Events

Server-Sent Events (SSE) for real-time pipeline updates:

```javascript
const eventSource = new EventSource('/api/pipeline/123/stream');

eventSource.addEventListener('stage_progress', (e) => {
  const update = JSON.parse(e.data);
  console.log('Stage progress:', update);
});

eventSource.addEventListener('error', (e) => {
  console.error('Stream error:', e);
  eventSource.close();
});
```

### REST API Examples

```bash
# Create project
curl -X POST http://localhost:3000/api/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "My Monolith",
    "description": "Legacy e-commerce platform"
  }'

# Run pipeline
curl -X POST http://localhost:3000/api/pipelines/123/run \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"parameters": {}}'

# Get pipeline status
curl http://localhost:3000/api/pipelines/123 \
  -H "Authorization: Bearer $TOKEN"
```

## Development Guide

### Running Tests

```bash
# All tests
pnpm test

# Unit tests
pnpm test:unit

# Integration tests
pnpm test:integration

# With coverage
pnpm test:coverage
```

### Code Quality

```bash
# Linting
pnpm lint

# Type checking
pnpm typecheck

# Format code
pnpm format
```

### Building for Production

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter=@revamp/core-engine build

# Output to dist/
pnpm build --filter='./packages/**'
```

## Monitoring & Observability

### Prometheus Metrics

Available at `/metrics` on API and Orchestrator services.

Key metrics:
- `revamp_pipeline_duration_seconds` - Pipeline execution time
- `revamp_llm_request_duration_seconds` - LLM API latency
- `revamp_api_request_duration_seconds` - API request latency
- `revamp_llm_tokens_used_total` - Total tokens consumed

### Logging

Structured JSON logging to stdout by default. Configure with:
- `LOG_LEVEL` - info, debug, warn, error
- `SENTRY_DSN` - Error tracking (optional)

### Health Checks

Kubernetes liveness and readiness probes configured for all services.

## Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL
docker-compose logs postgres

# Verify connection
psql postgresql://revamp:password@localhost:5432/revamp

# Reset database
docker-compose exec postgres psql -U revamp -d revamp -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

### LLM Provider Failures

```bash
# Check provider health
curl http://localhost:3000/health/llm | jq

# View orchestrator logs
docker-compose logs llm-orchestrator

# Test API key
export OPENAI_API_KEY=sk-...
curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
```

### Redis Connection Issues

```bash
# Test Redis
redis-cli -h localhost ping

# Check password
redis-cli -h localhost -a your_password ping

# Reset Redis
docker-compose exec redis redis-cli FLUSHALL
```

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

See [CONTRIBUTING.md](./docs/CONTRIBUTING.md) for detailed guidelines.

## Security

- All services run with minimal privileges (non-root)
- Network policies enforce zero-trust communication
- Encryption in transit (TLS) and at rest
- Secret management via Kubernetes secrets or external vaults
- Regular security audits and vulnerability scanning

**Reporting security vulnerabilities**: security@revamp.example.com

## License

This project is licensed under the MIT License - see [LICENSE](./LICENSE) file for details.

## Support

- **Documentation**: https://docs.revamp.example.com
- **Issues**: GitHub Issues
- **Discussions**: GitHub Discussions
- **Community**: Slack workspace

## Roadmap

- [ ] Multi-cloud cost estimation
- [ ] Advanced pattern library
- [ ] Custom validation rules
- [ ] Team collaboration features
- [ ] Integration marketplace
- [ ] Mobile app
- [ ] Self-hosted editions

## Acknowledgments

Built with modern cloud-native technologies:
- Next.js + React for frontend
- Fastify for API gateway
- Go for high-performance orchestration
- PostgreSQL for data persistence
- Redis for caching and queuing
- Kubernetes for orchestration

---

Made with ❤️ for modernization teams everywhere
