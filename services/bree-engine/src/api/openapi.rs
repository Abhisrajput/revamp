//! OpenAPI spec served at /api/docs as raw JSON string.

use axum::response::Json;

pub async fn openapi_spec() -> Json<serde_json::Value> {
    let spec: serde_json::Value = serde_json::from_str(OPENAPI_JSON).unwrap_or_default();
    Json(spec)
}

const OPENAPI_JSON: &str = r#"{
  "openapi": "3.1.0",
  "info": {
    "title": "BREE Engine API",
    "version": "0.1.0",
    "description": "Plugin-based legacy language detection, parsing, and analysis engine supporting 31 languages with deep analysis."
  },
  "servers": [{"url": "http://localhost:8081"}],
  "tags": [
    {"name": "System", "description": "Health and readiness"},
    {"name": "Languages", "description": "Matrix, tiers, families, readiness"},
    {"name": "Detection", "description": "Language detection and scanning"},
    {"name": "Parsing", "description": "Source file parsing"},
    {"name": "Analysis", "description": "Full pipeline, deep analysis, streaming"},
    {"name": "LLM", "description": "Prompt strategy per language family"}
  ],
  "paths": {
    "/health": {"get": {"summary": "Health check", "tags": ["System"]}},
    "/ready": {"get": {"summary": "Readiness + parser count", "tags": ["System"]}},
    "/api/docs": {"get": {"summary": "This OpenAPI spec", "tags": ["System"]}},
    "/api/v1/languages": {"get": {"summary": "List all 31 supported languages", "tags": ["Languages"]}},
    "/api/v1/languages/{id}": {"get": {"summary": "Get language by ID", "tags": ["Languages"]}},
    "/api/v1/tiers": {"get": {"summary": "Tier definitions (1-4) with timeline", "tags": ["Languages"]}},
    "/api/v1/tiers/prioritize": {"post": {"summary": "Score languages by weighted priority", "tags": ["Analysis"]}},
    "/api/v1/families": {"get": {"summary": "9 language family definitions", "tags": ["Languages"]}},
    "/api/v1/readiness": {"get": {"summary": "Parser readiness matrix with NIR coverage", "tags": ["Languages"]}},
    "/api/v1/matrix": {"get": {"summary": "Complete Language Support Matrix", "tags": ["Languages"]}},
    "/api/v1/detect": {"post": {"summary": "Detect languages in source files", "tags": ["Detection"]}},
    "/api/v1/scan": {"post": {"summary": "Scan directory on server filesystem", "tags": ["Detection"]}},
    "/api/v1/parse": {"post": {"summary": "Parse files with registered parsers", "tags": ["Parsing"]}},
    "/api/v1/analyze": {"post": {"summary": "Full pipeline: detect → parse → analyze → score → report (JSON)", "tags": ["Analysis"]}},
    "/api/v1/analyze/report": {"post": {"summary": "Full pipeline → Markdown report", "tags": ["Analysis"]}},
    "/api/v1/analyze/graph": {"post": {"summary": "Deep analysis: dead code, complexity, call graph, lineage, rules", "tags": ["Analysis"]}},
    "/api/v1/analyze/stream": {"post": {"summary": "SSE streaming analysis with real-time progress", "tags": ["Analysis"]}},
    "/api/v1/polyglot/patterns": {"get": {"summary": "Known polyglot patterns", "tags": ["Analysis"]}},
    "/api/v1/llm/prompt-strategy": {"post": {"summary": "LLM prompt strategy for detected families", "tags": ["LLM"]}}
  }
}"#;
