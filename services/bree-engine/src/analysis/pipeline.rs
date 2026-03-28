//! Full analysis pipeline — detect → parse → analyze → report.
//!
//! Single entry point that runs the complete BREE analysis on a SourceVault
//! and produces a comprehensive report.

use crate::analysis::{priority, readiness, resolver, dead_code, complexity, call_graph, data_lineage, business_rules, coverage};
use crate::detection::detector::PolyglotDetector;
use crate::languages::tiers::{find_language, LanguageEntry};
use crate::llm::strategy;
use crate::parser::nir::DependencyRef;
use crate::parser::registry::ParserRegistry;
use crate::parser::traits::SourceVault;
use serde::Serialize;
use std::collections::HashMap;
use tracing::info;

/// Complete analysis report produced by the pipeline.
#[derive(Debug, Clone, Serialize)]
pub struct AnalysisReport {
    pub summary: ReportSummary,
    pub detection: DetectionResult,
    pub parse_results: Vec<ParseSummary>,
    pub dependencies: Vec<DependencyRef>,
    pub polyglot_boundaries: Vec<BoundaryFinding>,
    pub priority_scores: Vec<priority::PriorityScore>,
    pub resolved_deps: resolver::ResolvedDependencies,
    pub dead_code: dead_code::DeadCodeReport,
    pub complexity: complexity::ComplexityReport,
    pub call_graph: call_graph::CallGraph,
    pub data_lineage: data_lineage::DataLineageReport,
    pub business_rules: business_rules::BusinessRuleReport,
    pub readiness: readiness::ReadinessMatrix,
    pub llm_strategy: strategy::LlmStrategy,
    pub actual_coverage: coverage::CoverageReport,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportSummary {
    pub total_files: usize,
    pub total_lines: usize,
    pub languages_detected: usize,
    pub parsers_used: usize,
    pub files_parsed: usize,
    pub embedded_blocks_found: usize,
    pub cross_language_calls: usize,
    pub copybooks_referenced: usize,
    pub program_calls: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectionResult {
    pub profile: crate::detection::detector::LanguageProfile,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParseSummary {
    pub source_path: String,
    pub language_id: String,
    pub dialect: String,
    pub total_lines: usize,
    pub symbols_count: usize,
    pub ast_nodes_count: usize,
    pub embedded_blocks_count: usize,
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoundaryFinding {
    pub from_file: String,
    pub from_language: String,
    pub to_target: String,
    pub to_language: String,
    pub mechanism: String,
    pub line: usize,
}

/// Run the full analysis pipeline on a source vault.
pub fn run_pipeline(vault: &SourceVault, registry: &ParserRegistry) -> AnalysisReport {
    let mut warnings = Vec::new();

    // Step 1: Detect languages
    info!("Pipeline step 1: Language detection");
    let detector = PolyglotDetector::new();
    let profile = detector.detect(vault);

    let all_detected_ids: Vec<String> = profile.primary.iter()
        .chain(profile.secondary.iter())
        .chain(profile.db_languages.iter())
        .chain(profile.job_control.iter())
        .map(|l| l.language_id.clone())
        .collect();

    // Step 2: Parse files with registered parsers (parallel with rayon)
    // TODO(H6): Wrap this rayon par_iter() section in tokio::task::spawn_blocking (or block_in_place)
    // to avoid blocking the async runtime when called from async handlers. Acceptable for now
    // since Axum uses a multi-threaded runtime, but should be fixed for production.
    info!("Pipeline step 2: Parsing {} files (parallel)", vault.files.len());

    use rayon::prelude::*;

    // Parallel parse: each file gets parsed independently
    let parse_outputs: Vec<Result<(crate::parser::nir::ParseOutput, Vec<DependencyRef>), String>> =
        vault.files.par_iter().map(|file| {
            if let Some(parser) = registry.find_parser(file) {
                match parser.parse(file) {
                    Ok(output) => {
                        let deps = parser.resolve_dependencies(&output, vault);
                        Ok((output, deps))
                    }
                    Err(e) => Err(format!("Failed to parse {}: {}", file.path.display(), e)),
                }
            } else {
                Err(format!("No parser for {}", file.path.display()))
            }
        }).collect();

    // Collect results sequentially
    let mut parse_results = Vec::new();
    let mut full_outputs: Vec<crate::parser::nir::ParseOutput> = Vec::new();
    let mut all_dependencies: Vec<DependencyRef> = Vec::new();
    let mut files_parsed = 0;
    let mut total_embedded = 0;

    for result in parse_outputs {
        match result {
            Ok((output, deps)) => {
                all_dependencies.extend(deps);
                total_embedded += output.embedded_blocks.len();

                parse_results.push(ParseSummary {
                    source_path: output.source_path.clone(),
                    language_id: output.language_id.clone(),
                    dialect: output.dialect.clone(),
                    total_lines: output.total_lines,
                    symbols_count: output.symbols.len(),
                    ast_nodes_count: output.ast_nodes.len(),
                    embedded_blocks_count: output.embedded_blocks.len(),
                    metadata: output.metadata.clone(),
                });
                full_outputs.push(output);
                files_parsed += 1;
            }
            Err(e) => {
                warnings.push(e);
            }
        }
    }

    // Step 3: Detect cross-language boundaries
    info!("Pipeline step 3: Cross-language boundary analysis");
    let mut boundary_findings = Vec::new();

    for dep in &all_dependencies {
        let mechanism = match &dep.dependency_type {
            crate::parser::nir::DependencyType::CopyInclude => "COPY/INCLUDE",
            crate::parser::nir::DependencyType::ProgramCall => "CALL",
            crate::parser::nir::DependencyType::DatabaseAccess => "EXEC SQL/CICS/DLI",
            crate::parser::nir::DependencyType::FileAccess => "File I/O",
            crate::parser::nir::DependencyType::ExternalSystem => "External",
            crate::parser::nir::DependencyType::CrossLanguage { target_language } => {
                // This is a real cross-language boundary
                boundary_findings.push(BoundaryFinding {
                    from_file: dep.from_module.clone(),
                    from_language: "source".to_string(),
                    to_target: dep.to_module.clone(),
                    to_language: target_language.clone(),
                    mechanism: "Cross-language call".to_string(),
                    line: dep.source_span.start_line,
                });
                continue;
            }
        };

        // Check if dependency crosses language boundaries
        let from_lang = parse_results.iter()
            .find(|p| p.source_path == dep.from_module)
            .map(|p| p.language_id.as_str())
            .unwrap_or("unknown");

        if matches!(dep.dependency_type, crate::parser::nir::DependencyType::DatabaseAccess) {
            boundary_findings.push(BoundaryFinding {
                from_file: dep.from_module.clone(),
                from_language: from_lang.to_string(),
                to_target: dep.to_module.clone(),
                to_language: dep.to_module.clone(), // DB2-SQL, CICS, DL/I
                mechanism: mechanism.to_string(),
                line: dep.source_span.start_line,
            });
        }
    }

    // Step 4: Priority scoring
    info!("Pipeline step 4: Priority scoring");
    let detected_entries: Vec<&LanguageEntry> = all_detected_ids.iter()
        .filter_map(|id| find_language(id))
        .collect();
    let priority_scores = priority::compute_priority_scores(&detected_entries);

    // Step 5: Parser readiness
    let readiness_matrix = readiness::assess_readiness(&all_detected_ids, registry);

    // Step 6: Resolve copybook/include references
    info!("Pipeline step 6: Resolving COPY/INCLUDE references");
    let resolved_deps = resolver::resolve_dependencies(&all_dependencies, vault);

    // Step 7: Deep analysis (dead code, complexity, call graph, data lineage, business rules)
    info!("Pipeline step 7: Deep analysis");
    let output_refs: Vec<&crate::parser::nir::ParseOutput> = full_outputs.iter().collect();
    let dead_code_report = dead_code::detect_dead_code(&output_refs);
    let complexity_report = complexity::analyze_complexity(&output_refs);
    let graph = call_graph::build_call_graph(&output_refs, &all_dependencies);
    let lineage = data_lineage::trace_lineage(&output_refs);
    let rules = business_rules::extract_rules(&output_refs);

    info!(
        dead_paragraphs = dead_code_report.unreachable_paragraphs.len(),
        avg_complexity = format!("{:.1}", complexity_report.average_complexity),
        graph_nodes = graph.stats.total_nodes,
        graph_edges = graph.stats.total_edges,
        fields_tracked = lineage.total_fields_tracked,
        business_rules = rules.total_rules,
        "Deep analysis complete"
    );

    // Step 8: LLM strategy
    let llm_strat = strategy::select_strategy(&profile);

    // Build summary
    let cross_lang_count = boundary_findings.len();
    let copy_count = all_dependencies.iter()
        .filter(|d| matches!(d.dependency_type, crate::parser::nir::DependencyType::CopyInclude))
        .count();
    let call_count = all_dependencies.iter()
        .filter(|d| matches!(d.dependency_type, crate::parser::nir::DependencyType::ProgramCall))
        .count();

    let summary = ReportSummary {
        total_files: vault.files.len(),
        total_lines: vault.total_lines(),
        languages_detected: all_detected_ids.len(),
        parsers_used: parse_results.iter().map(|p| p.language_id.as_str()).collect::<std::collections::HashSet<_>>().len(),
        files_parsed,
        embedded_blocks_found: total_embedded,
        cross_language_calls: cross_lang_count,
        copybooks_referenced: copy_count,
        program_calls: call_count,
    };

    // Step 9: Compute actual NIR coverage (measured, not estimated)
    let file_coverages: Vec<coverage::FileCoverage> = full_outputs.iter()
        .filter_map(|output| {
            vault.files.iter()
                .find(|f| f.path.to_string_lossy() == output.source_path)
                .map(|f| coverage::compute_file_coverage(output, &f.content))
        })
        .collect();
    let overall_coverage = coverage::compute_overall_coverage(&file_coverages);

    info!(
        files = summary.total_files,
        lines = summary.total_lines,
        languages = summary.languages_detected,
        parsed = summary.files_parsed,
        embedded = summary.embedded_blocks_found,
        boundaries = summary.cross_language_calls,
        rules = rules.total_rules,
        actual_coverage = format!("{:.1}%", overall_coverage.actual_coverage_pct * 100.0),
        "Pipeline complete"
    );

    AnalysisReport {
        summary,
        detection: DetectionResult { profile },
        parse_results,
        dependencies: all_dependencies,
        polyglot_boundaries: boundary_findings,
        priority_scores,
        resolved_deps,
        dead_code: dead_code_report,
        complexity: complexity_report,
        call_graph: graph,
        data_lineage: lineage,
        business_rules: rules,
        readiness: readiness_matrix,
        llm_strategy: llm_strat,
        actual_coverage: coverage::CoverageReport {
            file_coverages,
            overall: overall_coverage,
        },
        warnings,
    }
}
