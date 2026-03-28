# BREE Engine — Legacy Language Support Engine

Plugin-based language detection, parsing, and analysis engine for the REVAMP modernization platform. Supports 35+ legacy enterprise languages across 4 tiers and 9 language families.

## Architecture

```
services/bree-engine/
├── src/
│   ├── main.rs              Entry point: config → registry → server
│   ├── api/                  Axum HTTP server + handlers
│   ├── config/               Environment configuration
│   ├── parser/               Core abstractions
│   │   ├── traits.rs         LanguageParser trait (plugin interface)
│   │   ├── registry.rs       ParserRegistry (HashMap<String, Box<dyn LanguageParser>>)
│   │   └── nir.rs            Two-layer IR (Language AST + Analysis Graph)
│   ├── detection/            Language detection
│   │   ├── detector.rs       5-stage cascade (modeline→shebang→ext→content→bayesian)
│   │   ├── signatures.rs     Extension + header signatures for 30+ languages
│   │   └── families.rs       9 language family definitions
│   ├── languages/            Parser implementations
│   │   ├── tiers.rs          Complete BREE tier definitions (Tier 1-4)
│   │   ├── cobol.rs          COBOL parser (Tier 1 stub)
│   │   ├── rpg.rs            RPG parser (Tier 1 stub)
│   │   ├── cl.rs             CL parser (Tier 1 stub)
│   │   ├── jcl.rs            JCL parser (Tier 1 stub)
│   │   └── pli.rs            PL/I parser (Tier 1 stub)
│   ├── analysis/             Analysis modules
│   │   ├── priority.rs       Weighted additive scoring (5 factors)
│   │   ├── readiness.rs      Parser readiness assessment
│   │   └── polyglot.rs       Cross-language boundary mapping
│   ├── llm/                  LLM prompt strategy
│   │   ├── prompts.rs        Per-family system prompts
│   │   └── strategy.rs       Family → strategy selector
│   └── metrics/              Prometheus metrics
```

## Quick Start

```bash
# Build
cargo build

# Run (port 8081)
cargo run

# Health check
curl http://localhost:8081/health

# List all supported languages
curl http://localhost:8081/api/v1/languages

# Get tier definitions
curl http://localhost:8081/api/v1/tiers

# Get language family classifications
curl http://localhost:8081/api/v1/families

# Detect languages in source files
curl -X POST http://localhost:8081/api/v1/detect \
  -H "Content-Type: application/json" \
  -d '{"files": [{"path": "CUSTMAST.cbl", "content": "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. CUSTMAST."}]}'

# Get parser readiness matrix
curl http://localhost:8081/api/v1/readiness

# Get complete Language Support Matrix
curl http://localhost:8081/api/v1/matrix
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/ready` | Readiness (includes parser count) |
| GET | `/api/v1/languages` | List all 35+ supported languages |
| GET | `/api/v1/languages/{id}` | Get language details |
| GET | `/api/v1/tiers` | Tier definitions (1-4) with build timeline |
| POST | `/api/v1/tiers/prioritize` | Score languages by weighted formula |
| GET | `/api/v1/families` | 9 language family definitions |
| GET | `/api/v1/readiness` | Parser readiness matrix |
| POST | `/api/v1/detect` | Detect languages in uploaded source files |
| GET | `/api/v1/polyglot/patterns` | Known polyglot patterns |
| POST | `/api/v1/llm/prompt-strategy` | LLM prompt strategy for detected families |
| GET | `/api/v1/matrix` | Complete Language Support Matrix |

## Key Design Decisions

- **Two-layer IR**: Language-specific AST (preserves full semantics) + Normalized Analysis Graph (cross-language analysis). Single flat IR loses critical semantics (COBOL REDEFINES, RPG indicators, MUMPS globals).
- **5-stage detection cascade**: Modelines → Shebangs → Extensions → Content heuristics → Bayesian classifier. Extension-only detection is insufficient for legacy languages.
- **Weighted additive priority scoring**: `(0.30 × density) + (0.25 × urgency) + (0.20 × tooling) + (0.15 × talent_risk) + (0.10 × complexity)`. Multiplicative formulas collapse when any factor is near-zero.
- **9 language families** (not 7): NATURAL separated from Mainframe (4GL vs 3GL), SAP/ABAP separate (unique ecosystem).
- **PL/SQL and T-SQL are NOT legacy**: Classified as "Database Logic" extraction targets, not modernization targets.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8081` | HTTP server port |
| `LOG_LEVEL` | `info` | Tracing filter level |
| `ENVIRONMENT` | `development` | Runtime environment |
| `METRICS_PORT` | `9091` | Prometheus metrics port |

## Docker

```bash
docker build -t bree-engine .
docker run -p 8081:8081 bree-engine
```
