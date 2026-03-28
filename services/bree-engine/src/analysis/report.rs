//! Report generator — produces structured markdown from an AnalysisReport.

use crate::analysis::pipeline::AnalysisReport;

/// Generate a markdown report from a completed analysis.
pub fn generate_markdown(report: &AnalysisReport) -> String {
    let mut md = String::with_capacity(8192);
    let s = &report.summary;

    // Header
    md.push_str("# BREE Analysis Report\n\n");

    // Executive Summary
    md.push_str("## Executive Summary\n\n");
    md.push_str(&format!("| Metric | Value |\n|--------|-------|\n"));
    md.push_str(&format!("| Total Files | {} |\n", s.total_files));
    md.push_str(&format!("| Total Lines | {} |\n", s.total_lines));
    md.push_str(&format!("| Languages Detected | {} |\n", s.languages_detected));
    md.push_str(&format!("| Files Successfully Parsed | {} |\n", s.files_parsed));
    md.push_str(&format!("| Embedded SQL/CICS Blocks | {} |\n", s.embedded_blocks_found));
    md.push_str(&format!("| Cross-Language Boundaries | {} |\n", s.cross_language_calls));
    md.push_str(&format!("| Copybooks Referenced | {} |\n", s.copybooks_referenced));
    md.push_str(&format!("| Program CALLs | {} |\n\n", s.program_calls));

    // Languages Detected
    md.push_str("## Languages Detected\n\n");
    let profile = &report.detection.profile;
    if !profile.primary.is_empty() {
        md.push_str("### Primary Languages\n\n");
        md.push_str("| Language | Files | Lines | Confidence |\n|----------|-------|-------|------------|\n");
        for lang in &profile.primary {
            md.push_str(&format!("| {} | {} | {} | {:.0}% |\n",
                lang.language_id, lang.file_count, lang.total_lines, lang.confidence * 100.0));
        }
        md.push('\n');
    }
    if !profile.secondary.is_empty() {
        md.push_str("### Secondary Languages\n\n");
        for lang in &profile.secondary {
            md.push_str(&format!("- **{}**: {} files, {} lines\n", lang.language_id, lang.file_count, lang.total_lines));
        }
        md.push('\n');
    }
    if !profile.db_languages.is_empty() {
        md.push_str("### Database Languages\n\n");
        for lang in &profile.db_languages {
            md.push_str(&format!("- **{}**: {} files\n", lang.language_id, lang.file_count));
        }
        md.push('\n');
    }
    if !profile.job_control.is_empty() {
        md.push_str("### Job Control Languages\n\n");
        for lang in &profile.job_control {
            md.push_str(&format!("- **{}**: {} files\n", lang.language_id, lang.file_count));
        }
        md.push('\n');
    }

    // Parse Results
    md.push_str("## Parse Results\n\n");
    md.push_str("| File | Language | Dialect | Lines | Symbols | AST Nodes | Embedded |\n");
    md.push_str("|------|---------|---------|-------|---------|-----------|----------|\n");
    for pr in &report.parse_results {
        let short_path = pr.source_path.rsplit('/').next().unwrap_or(&pr.source_path);
        md.push_str(&format!("| `{}` | {} | {} | {} | {} | {} | {} |\n",
            short_path, pr.language_id, pr.dialect, pr.total_lines,
            pr.symbols_count, pr.ast_nodes_count, pr.embedded_blocks_count));
    }
    md.push('\n');

    // Per-file metadata highlights
    for pr in &report.parse_results {
        let short_path = pr.source_path.rsplit('/').next().unwrap_or(&pr.source_path);
        if pr.metadata.is_empty() { continue; }
        md.push_str(&format!("### `{}`\n\n", short_path));
        for (key, value) in &pr.metadata {
            if key == "format" || key == "dialect" { continue; } // Already shown
            let display = match value {
                serde_json::Value::Number(n) => format!("{}", n),
                serde_json::Value::Bool(b) => format!("{}", b),
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Array(arr) if arr.is_empty() => continue,
                serde_json::Value::Array(arr) => arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()).or_else(|| Some(v.to_string())))
                    .collect::<Vec<_>>().join(", "),
                _ => value.to_string(),
            };
            md.push_str(&format!("- **{}**: {}\n", key.replace('_', " "), display));
        }
        md.push('\n');
    }

    // Dependencies
    if !report.dependencies.is_empty() {
        md.push_str("## Dependencies\n\n");
        md.push_str("| From | To | Type | Reference |\n|------|-----|------|----------|\n");
        for dep in &report.dependencies {
            let from_short = dep.from_module.rsplit('/').next().unwrap_or(&dep.from_module);
            let dep_type = format!("{:?}", dep.dependency_type).split('{').next().unwrap_or("").trim().to_string();
            md.push_str(&format!("| `{}` | `{}` | {} | `{}` |\n",
                from_short, dep.to_module, dep_type, dep.reference_text));
        }
        md.push('\n');
    }

    // Cross-Language Boundaries
    if !report.polyglot_boundaries.is_empty() {
        md.push_str("## Cross-Language Boundaries\n\n");
        md.push_str("| Source | From Lang | Target | To Lang | Mechanism | Line |\n");
        md.push_str("|--------|-----------|--------|---------|-----------|------|\n");
        for b in &report.polyglot_boundaries {
            let from_short = b.from_file.rsplit('/').next().unwrap_or(&b.from_file);
            md.push_str(&format!("| `{}` | {} | `{}` | {} | {} | {} |\n",
                from_short, b.from_language, b.to_target, b.to_language, b.mechanism, b.line));
        }
        md.push('\n');
    }

    // Priority Scores
    if !report.priority_scores.is_empty() {
        md.push_str("## Priority Scores\n\n");
        md.push_str("| Rank | Language | Tier | Score | Density | Urgency | Tooling | Talent | Complexity |\n");
        md.push_str("|------|---------|------|-------|---------|---------|---------|--------|------------|\n");
        for p in &report.priority_scores {
            md.push_str(&format!("| #{} | {} | {:?} | **{:.1}** | {:.0} | {:.0} | {:.0} | {:.0} | {:.0} |\n",
                p.rank, p.display_name, p.tier, p.weighted_score,
                p.enterprise_density, p.modernization_urgency, p.available_tooling,
                p.talent_risk, p.complexity_factor));
        }
        md.push('\n');
    }

    // LLM Strategy
    md.push_str("## LLM Prompt Strategy\n\n");
    md.push_str(&format!("{}\n\n", report.llm_strategy.recommendation));
    for fam in &report.llm_strategy.families_detected {
        md.push_str(&format!("### {:?}\n\n", fam.family));
        md.push_str(&format!("**Languages**: {}\n\n", fam.languages_in_project.join(", ")));
        md.push_str(&format!("**Focus**: {}\n\n", fam.prompt_focus));
    }

    // Warnings
    if !report.warnings.is_empty() {
        md.push_str("## Warnings\n\n");
        for w in &report.warnings {
            md.push_str(&format!("- {}\n", w));
        }
        md.push('\n');
    }

    md.push_str("---\n*Generated by BREE Engine v0.1.0*\n");
    md
}
