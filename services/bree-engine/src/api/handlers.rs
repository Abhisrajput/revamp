//! API endpoint handlers.

use crate::analysis::{pipeline, polyglot, priority, readiness, report};
use crate::api::server::SharedState;
use crate::detection::{detector::PolyglotDetector, families::get_family_definitions, scanner};
use crate::languages::tiers::{
    all_languages, find_language, languages_by_tier, LanguageEntry, Tier, LANGUAGE_MATRIX,
    DATABASE_LOGIC_LANGUAGES,
};
use crate::llm::strategy;
use crate::parser::traits::{SourceFile, SourceVault};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Validate that a user-supplied path is safe (no traversal) and exists on disk.
fn validate_path(path_str: &str) -> Result<std::path::PathBuf, StatusCode> {
    let path = std::path::Path::new(path_str);
    // Reject path traversal attempts
    if path_str.contains("..") {
        return Err(StatusCode::FORBIDDEN);
    }
    // Resolve against the configured scan root (defaults to cwd)
    let scan_root = std::env::var("BREE_SCAN_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let canonical = path.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    let root_canonical = scan_root.canonicalize().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !canonical.starts_with(&root_canonical) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(canonical)
}

// ─── Health ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "bree-engine",
        version: "0.1.0",
    })
}

pub async fn ready(State(state): State<SharedState>) -> Json<ReadyResponse> {
    Json(ReadyResponse {
        ready: true,
        registered_parsers: state.registry.count(),
    })
}

#[derive(Serialize)]
pub struct ReadyResponse {
    ready: bool,
    registered_parsers: usize,
}

// ─── Languages ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LanguageListResponse {
    languages: Vec<LanguageSummary>,
    total: usize,
}

#[derive(Serialize)]
pub struct LanguageSummary {
    id: &'static str,
    display_name: &'static str,
    tier: String,
    family: String,
    parser_status: String,
    where_it_lives: &'static str,
}

pub async fn list_languages() -> Json<LanguageListResponse> {
    let langs: Vec<LanguageSummary> = all_languages()
        .iter()
        .map(|l| LanguageSummary {
            id: l.id,
            display_name: l.display_name,
            tier: l.tier.to_string(),
            family: l.family.to_string(),
            parser_status: l.parser_status.to_string(),
            where_it_lives: l.where_it_lives,
        })
        .collect();
    let total = langs.len();
    Json(LanguageListResponse { languages: langs, total })
}

pub async fn get_language(Path(id): Path<String>) -> Result<Json<serde_json::Value>, StatusCode> {
    find_language(&id)
        .map(|l| Json(serde_json::to_value(l).unwrap_or_default()))
        .ok_or(StatusCode::NOT_FOUND)
}

// ─── Tiers ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct TierListResponse {
    tiers: Vec<TierDetail>,
}

#[derive(Serialize)]
pub struct TierDetail {
    tier: String,
    build_months: &'static str,
    language_count: usize,
    languages: Vec<&'static str>,
}

pub async fn list_tiers() -> Json<TierListResponse> {
    let tiers = vec![
        (Tier::Tier1, "Months 1-6"),
        (Tier::Tier2, "Months 7-12"),
        (Tier::Tier3, "Months 13-18"),
        (Tier::Tier4, "Month 19+"),
    ];

    let details: Vec<TierDetail> = tiers
        .iter()
        .map(|(tier, months)| {
            let langs = languages_by_tier(*tier);
            TierDetail {
                tier: tier.to_string(),
                build_months: months,
                language_count: langs.len(),
                languages: langs.iter().map(|l| l.display_name).collect(),
            }
        })
        .collect();

    Json(TierListResponse { tiers: details })
}

#[derive(Deserialize)]
pub struct PrioritizeRequest {
    language_ids: Vec<String>,
}

pub async fn prioritize_tiers(
    Json(req): Json<PrioritizeRequest>,
) -> Json<Vec<priority::PriorityScore>> {
    let entries: Vec<&LanguageEntry> = req
        .language_ids
        .iter()
        .filter_map(|id| find_language(id))
        .collect();
    Json(priority::compute_priority_scores(&entries))
}

// ─── Families ────────────────────────────────────────────────────

pub async fn list_families(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let families = get_family_definitions();
    let overrides = state.prompt_overrides.read().await;
    let merged: Vec<serde_json::Value> = families.iter().map(|f| {
        let family_key = serde_json::to_value(&f.family)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let prompt = overrides.get(&family_key)
            .map(|s| s.as_str())
            .unwrap_or(f.llm_prompt_focus);
        serde_json::json!({
            "family": f.family,
            "members": f.members,
            "shared_characteristics": f.shared_characteristics,
            "llm_prompt_focus": prompt,
            "key_concepts": f.key_concepts,
        })
    }).collect();
    Json(serde_json::to_value(merged).unwrap_or_default())
}

#[derive(Deserialize)]
pub struct UpdateFamilyPromptRequest {
    pub llm_prompt_focus: String,
}

pub async fn update_family_prompt(
    State(state): State<SharedState>,
    Path(family_id): Path<String>,
    Json(req): Json<UpdateFamilyPromptRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // Validate the family exists (compare against serde-serialized name, e.g. "IbmI")
    let families = get_family_definitions();
    let found = families.iter().any(|f| {
        serde_json::to_value(&f.family)
            .ok()
            .and_then(|v| v.as_str().map(|s| s == family_id))
            .unwrap_or(false)
    });
    if !found {
        return Err(StatusCode::NOT_FOUND);
    }

    // Update in-memory overrides
    {
        let mut overrides = state.prompt_overrides.write().await;
        overrides.insert(family_id.clone(), req.llm_prompt_focus.clone());

        // Persist to disk
        let _ = std::fs::create_dir_all("data");
        if let Ok(json) = serde_json::to_string_pretty(&*overrides) {
            let _ = std::fs::write("data/family_overrides.json", json);
        }
    }

    Ok(Json(serde_json::json!({
        "family": family_id,
        "llm_prompt_focus": req.llm_prompt_focus,
        "persisted": true,
    })))
}

// ─── Readiness ───────────────────────────────────────────────────

pub async fn parser_readiness(
    State(state): State<SharedState>,
) -> Json<readiness::ReadinessMatrix> {
    let all_ids: Vec<String> = all_languages().iter().map(|l| l.id.to_string()).collect();
    Json(readiness::assess_readiness(&all_ids, &state.registry))
}

// ─── Detection ───────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct DetectRequest {
    files: Vec<FileInput>,
}

#[derive(Deserialize)]
pub struct FileInput {
    path: String,
    content: String,
}

pub async fn detect_languages(
    Json(req): Json<DetectRequest>,
) -> Json<crate::detection::detector::LanguageProfile> {
    let mut vault = SourceVault::new(PathBuf::from("."));
    for f in req.files {
        vault.add_file(SourceFile::new(PathBuf::from(&f.path), f.content));
    }
    let detector = PolyglotDetector::new();
    let profile = detector.detect(&vault);
    crate::metrics::record_detection_run(profile.stats.languages_found);
    Json(profile)
}

// ─── Polyglot Patterns ──────────────────────────────────────────

pub async fn polyglot_patterns() -> Json<serde_json::Value> {
    let patterns = polyglot::known_polyglot_patterns();
    let serializable: Vec<serde_json::Value> = patterns
        .iter()
        .map(|p| {
            serde_json::json!({
                "name": p.name,
                "languages": p.languages,
                "description": p.description,
                "boundary_count": p.boundaries.len(),
            })
        })
        .collect();
    Json(serde_json::json!({ "patterns": serializable }))
}

// ─── LLM Strategy ───────────────────────────────────────────────

pub async fn llm_prompt_strategy(
    Json(req): Json<DetectRequest>,
) -> Json<strategy::LlmStrategy> {
    let mut vault = SourceVault::new(PathBuf::from("."));
    for f in req.files {
        vault.add_file(SourceFile::new(PathBuf::from(&f.path), f.content));
    }
    let detector = PolyglotDetector::new();
    let profile = detector.detect(&vault);
    Json(strategy::select_strategy(&profile))
}

// ─── Full Matrix ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct MatrixResponse {
    total_languages: usize,
    tier1_count: usize,
    tier2_count: usize,
    tier3_count: usize,
    tier4_count: usize,
    database_logic_count: usize,
    families_count: usize,
    languages: Vec<serde_json::Value>,
    database_logic: Vec<serde_json::Value>,
}

pub async fn full_matrix() -> Json<MatrixResponse> {
    let all = all_languages();
    Json(MatrixResponse {
        total_languages: all.len(),
        tier1_count: languages_by_tier(Tier::Tier1).len(),
        tier2_count: languages_by_tier(Tier::Tier2).len(),
        tier3_count: languages_by_tier(Tier::Tier3).len(),
        tier4_count: languages_by_tier(Tier::Tier4).len(),
        database_logic_count: DATABASE_LOGIC_LANGUAGES.len(),
        families_count: get_family_definitions().len(),
        languages: LANGUAGE_MATRIX
            .iter()
            .map(|l| serde_json::to_value(l).unwrap_or_default())
            .collect(),
        database_logic: DATABASE_LOGIC_LANGUAGES
            .iter()
            .map(|l| serde_json::to_value(l).unwrap_or_default())
            .collect(),
    })
}

// ─── Directory Scan ──────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ScanRequest {
    path: String,
}

pub async fn scan_directory(
    Json(req): Json<ScanRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let path = validate_path(&req.path)?;
    match scanner::scan_directory(&path) {
        Ok((vault, summary)) => {
            let detector = PolyglotDetector::new();
            let profile = detector.detect(&vault);
            crate::metrics::record_detection_run(profile.stats.languages_found);
            Ok(Json(serde_json::json!({
                "scan_summary": summary,
                "language_profile": profile,
            })))
        }
        Err(_e) => {
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

// ─── Full Analysis Pipeline ──────────────────────────────────────

#[derive(Deserialize)]
pub struct AnalyzeRequest {
    /// Either a directory path on disk or inline files.
    path: Option<String>,
    files: Option<Vec<FileInput>>,
}

pub async fn analyze(
    State(state): State<SharedState>,
    Json(req): Json<AnalyzeRequest>,
) -> Result<Json<pipeline::AnalysisReport>, StatusCode> {
    let vault = if let Some(path) = req.path {
        let p = validate_path(&path)?;
        match scanner::scan_directory(&p) {
            Ok((vault, _)) => vault,
            Err(_) => return Err(StatusCode::BAD_REQUEST),
        }
    } else if let Some(files) = req.files {
        let mut vault = SourceVault::new(PathBuf::from("."));
        for f in files {
            vault.add_file(SourceFile::new(PathBuf::from(&f.path), f.content));
        }
        vault
    } else {
        return Err(StatusCode::BAD_REQUEST);
    };

    let report = pipeline::run_pipeline(&vault, &state.registry);
    Ok(Json(report))
}

// ─── Call Graph (Mermaid) ─────────────────────────────────────────

pub async fn analyze_call_graph(
    State(state): State<SharedState>,
    Json(req): Json<AnalyzeRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let vault = if let Some(path) = req.path {
        let p = validate_path(&path)?;
        match scanner::scan_directory(&p) {
            Ok((vault, _)) => vault,
            Err(_) => return Err(StatusCode::BAD_REQUEST),
        }
    } else if let Some(files) = req.files {
        let mut vault = SourceVault::new(PathBuf::from("."));
        for f in files { vault.add_file(SourceFile::new(PathBuf::from(&f.path), f.content)); }
        vault
    } else { return Err(StatusCode::BAD_REQUEST); };

    let analysis = pipeline::run_pipeline(&vault, &state.registry);
    Ok(Json(serde_json::json!({
        "call_graph": analysis.call_graph,
        "dead_code": analysis.dead_code,
        "complexity": analysis.complexity,
        "data_lineage": {
            "total_fields": analysis.data_lineage.total_fields_tracked,
            "read_write": analysis.data_lineage.fields_read_write,
            "write_only": analysis.data_lineage.fields_write_only,
            "read_only": analysis.data_lineage.fields_read_only,
        },
        "business_rules": analysis.business_rules,
        "actual_coverage": analysis.actual_coverage,
    })))
}

// ─── Parse Files ─────────────────────────────────────────────────

pub async fn parse_files(
    State(state): State<SharedState>,
    Json(req): Json<DetectRequest>,
) -> Json<Vec<serde_json::Value>> {
    let mut results = Vec::new();

    for f in req.files {
        let source = SourceFile::new(PathBuf::from(&f.path), f.content);
        if let Some(parser) = state.registry.find_parser(&source) {
            match parser.parse(&source) {
                Ok(output) => {
                    results.push(serde_json::json!({
                        "source_path": output.source_path,
                        "language_id": output.language_id,
                        "dialect": output.dialect,
                        "total_lines": output.total_lines,
                        "symbols": output.symbols.len(),
                        "ast_nodes": output.ast_nodes.len(),
                        "embedded_blocks": output.embedded_blocks.len(),
                        "metadata": output.metadata,
                    }));
                    crate::metrics::record_files_parsed(parser.language_id(), 1);
                }
                Err(e) => {
                    results.push(serde_json::json!({
                        "source_path": f.path,
                        "error": e.to_string(),
                    }));
                }
            }
        } else {
            results.push(serde_json::json!({
                "source_path": f.path,
                "error": "No parser registered for this file type",
            }));
        }
    }

    Json(results)
}

// ─── Requirements Document ──────────────────────────────────────

pub async fn analyze_requirements(
    State(state): State<SharedState>,
    Json(req): Json<AnalyzeRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let vault = if let Some(files) = req.files {
        let mut vault = SourceVault::new(PathBuf::from("."));
        for f in files { vault.add_file(SourceFile::new(PathBuf::from(&f.path), f.content)); }
        vault
    } else if let Some(path) = req.path {
        let p = validate_path(&path)?;
        match scanner::scan_directory(&p) {
            Ok((vault, _)) => vault,
            Err(_) => return Err(StatusCode::BAD_REQUEST),
        }
    } else { return Err(StatusCode::BAD_REQUEST); };

    // Parse each file and generate requirements
    let mut all_docs = Vec::new();
    for file in &vault.files {
        if let Some(parser) = state.registry.find_parser(file) {
            if let Ok(output) = parser.parse(file) {
                let doc = crate::analysis::requirements::generate_requirements(&output);
                all_docs.push(serde_json::json!(doc));
            }
        }
    }

    Ok(Json(serde_json::json!({
        "documents": all_docs,
        "total_files": all_docs.len(),
    })))
}

// ─── Analysis Report (Markdown) ──────────────────────────────────

pub async fn analyze_report(
    State(state): State<SharedState>,
    Json(req): Json<AnalyzeRequest>,
) -> Result<String, StatusCode> {
    let vault = if let Some(path) = req.path {
        let p = validate_path(&path)?;
        match scanner::scan_directory(&p) {
            Ok((vault, _)) => vault,
            Err(_) => return Err(StatusCode::BAD_REQUEST),
        }
    } else if let Some(files) = req.files {
        let mut vault = SourceVault::new(PathBuf::from("."));
        for f in files {
            vault.add_file(SourceFile::new(PathBuf::from(&f.path), f.content));
        }
        vault
    } else {
        return Err(StatusCode::BAD_REQUEST);
    };

    let analysis = pipeline::run_pipeline(&vault, &state.registry);
    Ok(report::generate_markdown(&analysis))
}
