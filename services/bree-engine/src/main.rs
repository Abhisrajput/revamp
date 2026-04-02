//! BREE Engine — Legacy Language Support Engine for REVAMP.
//!
//! Plugin-based language detection, parsing, polyglot analysis,
//! and the complete BREE Language Support Matrix.
//!
//! Mirrors the architecture of services/llm-orchestrator (Go):
//!   Config → Registry → Server → Serve
//!
//! API: http://localhost:8081
#![allow(dead_code)]

mod api;
mod analysis;
mod config;
mod detection;
mod languages;
mod llm;
mod metrics;
mod parser;

use crate::api::server::{build_router, AppState, SharedState};
use crate::config::Config;
use crate::parser::registry::ParserRegistry;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, error};

#[tokio::main]
async fn main() {
    // Load configuration
    let cfg = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to load config: {e}");
            std::process::exit(1);
        }
    };

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(&cfg.log_level)
        .json()
        .init();

    info!(
        service = "bree-engine",
        version = "0.1.0",
        port = cfg.port,
        env = %cfg.environment,
        "Starting BREE Language Support Engine"
    );

    // Initialize parser registry with Tier 1 stubs
    let mut registry = ParserRegistry::new();
    register_tier1_parsers(&mut registry);

    info!(
        parser_count = registry.count(),
        languages = ?registry.registered_languages(),
        "Parser registry initialized"
    );

    // Register metrics
    metrics::register_metrics();
    metrics::set_registered_parsers(registry.count());

    // Load prompt overrides from disk (if file exists)
    let prompt_overrides = load_prompt_overrides();
    info!(overrides = prompt_overrides.len(), "Loaded family prompt overrides");

    // Build shared state
    let state: SharedState = Arc::new(AppState {
        registry,
        prompt_overrides: RwLock::new(prompt_overrides),
    });

    // Build router
    let app = build_router(state);

    // Bind and serve
    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind to {addr}: {e}");
            std::process::exit(1);
        }
    };

    info!(addr = %addr, "BREE Engine listening");

    if let Err(e) = axum::serve(listener, app).await {
        error!("Server error: {e}");
        std::process::exit(1);
    }
}

/// Load prompt overrides from `data/family_overrides.json`.
fn load_prompt_overrides() -> HashMap<String, String> {
    let path = std::path::Path::new("data/family_overrides.json");
    if path.exists() {
        match std::fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    } else {
        HashMap::new()
    }
}

/// Register Tier 1 + Tier 2 parsers.
fn register_tier1_parsers(registry: &mut ParserRegistry) {
    use crate::languages::{
        cobol::CobolParser, rpg::RpgParser, cl::ClParser, dds::DdsParser, jcl::JclParser, pli::PliParser,
        vb6::Vb6Parser, abap::AbapParser, sas::SasParser,
        delphi::DelphiParser, powerbuilder::PowerBuilderParser,
        natural::NaturalParser, plsql::PlsqlParser,
        fortran::FortranParser, mumps::MumpsParser,
        csharp::CsharpParser, php::PhpParser,
        remaining::*,
    };

    // Tier 1: Critical (Months 1-6)
    registry.register(Box::new(CobolParser::new()));
    registry.register(Box::new(RpgParser::new()));
    registry.register(Box::new(ClParser::new()));
    registry.register(Box::new(DdsParser::new()));
    registry.register(Box::new(JclParser::new()));
    registry.register(Box::new(PliParser::new()));

    // Tier 2: High Value (Months 7-12)
    registry.register(Box::new(Vb6Parser::new()));
    registry.register(Box::new(AbapParser::new()));
    registry.register(Box::new(SasParser::new()));
    registry.register(Box::new(DelphiParser::new()));
    registry.register(Box::new(PowerBuilderParser::new()));
    registry.register(Box::new(NaturalParser::new()));
    registry.register(Box::new(PlsqlParser::new()));
    registry.register(Box::new(VbNetParser::new()));
    registry.register(Box::new(AspClassicParser::new()));
    registry.register(Box::new(OracleFormsParser::new()));
    registry.register(Box::new(TsqlParser::new()));
    registry.register(Box::new(Db2SqlParser::new()));
    registry.register(Box::new(CsharpParser::new()));
    registry.register(Box::new(PhpParser::new()));

    // Tier 3: Specialist (Months 13-18)
    registry.register(Box::new(FortranParser::new()));
    registry.register(Box::new(MumpsParser::new()));
    registry.register(Box::new(AdaParser::new()));
    registry.register(Box::new(Progress4glParser::new()));
    registry.register(Box::new(VisualFoxProParser::new()));
    registry.register(Box::new(SmalltalkParser::new()));
    registry.register(Box::new(CaGenParser::new()));
    registry.register(Box::new(ClipperParser::new()));
    registry.register(Box::new(SilverlightParser::new()));

    // Tier 4: Long Tail (Future / Community)
    registry.register(Box::new(AssemblerParser::new()));
    registry.register(Box::new(PerlParser::new()));
    registry.register(Box::new(RexxParser::new()));
    registry.register(Box::new(LotusScriptParser::new()));
    registry.register(Box::new(ColdFusionParser::new()));
}
