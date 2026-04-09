//! Axum HTTP server setup — mirrors the Chi router pattern from llm-orchestrator.

use crate::api::{handlers, streaming, openapi};
use crate::parser::registry::ParserRegistry;
use axum::{
    extract::DefaultBodyLimit,
    http::HeaderValue,
    routing::{get, patch, post},
    Router,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

/// Shared application state.
pub struct AppState {
    pub registry: ParserRegistry,
    /// Runtime overrides for family `llm_prompt_focus` fields.
    pub prompt_overrides: RwLock<HashMap<String, String>>,
}

pub type SharedState = Arc<AppState>;

/// Build the Axum router with all routes.
pub fn build_router(state: SharedState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:3000".parse::<HeaderValue>().unwrap(),
            "http://localhost:3001".parse::<HeaderValue>().unwrap(),
            "http://localhost:8787".parse::<HeaderValue>().unwrap(),
        ])
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Health
        .route("/health", get(handlers::health))
        .route("/ready", get(handlers::ready))
        .route("/api/docs", get(openapi::openapi_spec))
        // Languages
        .route("/api/v1/languages", get(handlers::list_languages))
        .route("/api/v1/languages/:id", get(handlers::get_language))
        // Tiers
        .route("/api/v1/tiers", get(handlers::list_tiers))
        .route("/api/v1/tiers/prioritize", post(handlers::prioritize_tiers))
        // Families
        .route("/api/v1/families", get(handlers::list_families))
        .route("/api/v1/families/:family_id", patch(handlers::update_family_prompt))
        // Readiness
        .route("/api/v1/readiness", get(handlers::parser_readiness))
        // Detection
        .route("/api/v1/detect", post(handlers::detect_languages))
        // Polyglot
        .route("/api/v1/polyglot/patterns", get(handlers::polyglot_patterns))
        // LLM Strategy
        .route("/api/v1/llm/prompt-strategy", post(handlers::llm_prompt_strategy))
        // Matrix
        .route("/api/v1/matrix", get(handlers::full_matrix))
        // Directory scan + full analysis pipeline
        .route("/api/v1/scan", post(handlers::scan_directory))
        .route("/api/v1/analyze", post(handlers::analyze))
        .route("/api/v1/analyze/report", post(handlers::analyze_report))
        .route("/api/v1/analyze/graph", post(handlers::analyze_call_graph))
        .route("/api/v1/parse", post(handlers::parse_files))
        .route("/api/v1/analyze/requirements", post(handlers::analyze_requirements))
        // SSE streaming analysis
        .route("/api/v1/analyze/stream", post(streaming::analyze_stream))
        // State
        .with_state(state)
        .layer(cors)
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024)) // Override axum's default 2MB limit
        .layer(TimeoutLayer::new(Duration::from_secs(300))) // 5-minute request timeout
        .layer(TraceLayer::new_for_http())
}
