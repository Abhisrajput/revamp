//! Fortran parser — Tier 3 implementing LanguageParser trait.
//!
//! Handles Fortran 77 (fixed-format) through Fortran 95+ (free-format).
//! Key challenges: COMMON blocks, EQUIVALENCE aliasing, DO loops,
//! numerical precision, OpenMP/MPI parallel constructs.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct FortranParser;

impl FortranParser {
    pub fn new() -> Self { Self }

    fn detect_format(content: &str) -> &'static str {
        // F90+ uses free format; F77 uses fixed (columns 1-6 labels, col 7 continuation)
        for line in content.lines().take(30) {
            let lower = line.to_lowercase();
            if lower.contains("module ") || lower.contains("contains") || lower.contains("implicit none") {
                // Could be either, check indentation
                if !line.starts_with("      ") && line.len() > 1 && !line.starts_with('!') {
                    return "free";
                }
            }
        }
        // Check if column 1-6 look like fixed format
        let fixed_count = content.lines().take(30)
            .filter(|l| l.len() >= 6 && (l.starts_with("      ") || l.starts_with("C") || l.starts_with("c") || l.starts_with("*")))
            .count();
        if fixed_count > 5 { "fixed" } else { "free" }
    }
}

impl LanguageParser for FortranParser {
    fn language_id(&self) -> &'static str { "fortran" }
    fn display_name(&self) -> &'static str { "Fortran 77/90/95+" }
    fn supported_dialects(&self) -> &[&'static str] { &["Fortran-77", "Fortran-90", "Fortran-95", "Fortran-2003"] }
    fn file_extensions(&self) -> &[&'static str] { &["f", "for", "ftn", "f77", "f90", "f95", "f03", "f08"] }

    fn nir_coverage_pct(&self) -> f64 { 0.68 }
    fn recommended_backend(&self) -> &'static str { "tree-sitter (fortran grammar)" }
    fn estimated_dev_effort(&self) -> &'static str { "1-2 weeks to production" }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let content_match = upper.contains("PROGRAM ") || upper.contains("SUBROUTINE ")
            || upper.contains("FUNCTION ") || upper.contains("IMPLICIT NONE")
            || upper.contains("COMMON /");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let format = Self::detect_format(&source.content);
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut common_blocks: Vec<String> = Vec::new();
        let mut has_openmp = false;
        let mut has_mpi = false;

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = if format == "fixed" && line.len() > 6 {
                line[6..].trim()
            } else {
                line.trim()
            };
            if trimmed.is_empty() { continue; }
            // Comments: C/c/* in col 1 (fixed) or ! anywhere (free)
            if format == "fixed" && (line.starts_with('C') || line.starts_with('c') || line.starts_with('*')) { continue; }
            if trimmed.starts_with('!') { continue; }

            let upper = trimmed.to_uppercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // PROGRAM
            if upper.starts_with("PROGRAM ") {
                let name = upper[8..].split_whitespace().next().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Program,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }
            // SUBROUTINE
            if upper.starts_with("SUBROUTINE ") {
                let name = upper[11..].split(|c: char| c == '(' || c.is_whitespace())
                    .next().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Subroutine,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }
            // FUNCTION
            if upper.contains("FUNCTION ") && !upper.starts_with("END") {
                let func_part = upper.split("FUNCTION ").nth(1).unwrap_or("");
                let name = func_part.split(|c: char| c == '(' || c.is_whitespace())
                    .next().unwrap_or("");
                if !name.is_empty() {
                    symbols.push(Symbol {
                        name: name.to_string(), kind: SymbolKind::Function,
                        span: span.clone(), visibility: Visibility::Public,
                        data_type: None, properties: HashMap::new(),
                    });
                }
            }
            // MODULE (F90+)
            if upper.starts_with("MODULE ") && !upper.starts_with("MODULE PROCEDURE") {
                let name = upper[7..].split_whitespace().next().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Module".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // COMMON block
            if upper.starts_with("COMMON") {
                let block_name = if upper.contains('/') {
                    upper.split('/').nth(1).unwrap_or("blank").trim().to_string()
                } else { "blank".to_string() };
                if !common_blocks.contains(&block_name) {
                    common_blocks.push(block_name.clone());
                }
                ast_nodes.push(AstNode {
                    id: format!("common-{}", i), kind: AstNodeKind::Custom("CommonBlock".to_string()),
                    name: Some(block_name), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // EQUIVALENCE
            if upper.starts_with("EQUIVALENCE") {
                ast_nodes.push(AstNode {
                    id: format!("equiv-{}", i), kind: AstNodeKind::Custom("Equivalence".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // CALL
            if upper.starts_with("CALL ") {
                let target = upper[5..].split(|c: char| c == '(' || c.is_whitespace())
                    .next().unwrap_or("");
                ast_nodes.push(AstNode {
                    id: format!("call-{}", i), kind: AstNodeKind::CallStatement,
                    name: Some(target.to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // INCLUDE
            if upper.starts_with("INCLUDE ") {
                let file_ref = upper[8..].trim_matches(|c: char| c == '\'' || c == '"').to_string();
                ast_nodes.push(AstNode {
                    id: format!("include-{}", i), kind: AstNodeKind::CopyStatement,
                    name: Some(file_ref), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // OpenMP directives
            if upper.starts_with("!$OMP") || upper.starts_with("C$OMP") || upper.starts_with("*$OMP") {
                has_openmp = true;
                ast_nodes.push(AstNode {
                    id: format!("omp-{}", i), kind: AstNodeKind::Custom("OpenMP".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // MPI calls
            if upper.contains("MPI_") || upper.contains("CALL MPI") {
                has_mpi = true;
            }
        }

        let dialect = if format == "fixed" { "Fortran-77" }
            else if source.content.to_uppercase().contains("MODULE ") { "Fortran-90" }
            else { "Fortran-95" };

        let mut metadata = HashMap::new();
        metadata.insert("format".to_string(), serde_json::json!(format));
        metadata.insert("common_blocks".to_string(), serde_json::json!(common_blocks));
        metadata.insert("has_openmp".to_string(), serde_json::json!(has_openmp));
        metadata.insert("has_mpi".to_string(), serde_json::json!(has_mpi));
        metadata.insert("subroutine_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Subroutine)).count()
        ));
        metadata.insert("function_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));
        metadata.insert("equivalence_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("Equivalence".to_string())).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: dialect.to_string(),
            source_path: source.path.to_string_lossy().to_string(),
            total_lines: source.content.lines().count(),
            ast_nodes, symbols, embedded_blocks: vec![],
            diagnostics: vec![], metadata,
        })
    }

    fn parse_partial(&self, source: &SourceFile) -> anyhow::Result<PartialParseOutput> {
        let output = self.parse(source)?;
        let total = output.total_lines;
        Ok(PartialParseOutput { output, parsed_up_to_line: total, error: String::new(), coverage: 1.0 })
    }

    fn resolve_dependencies(&self, module: &ParseOutput, _vault: &SourceVault) -> Vec<DependencyRef> {
        module.ast_nodes.iter()
            .filter(|n| matches!(n.kind, AstNodeKind::CallStatement | AstNodeKind::CopyStatement))
            .filter_map(|n| n.name.as_ref().map(|name| DependencyRef {
                from_module: module.source_path.clone(),
                to_module: name.clone(),
                dependency_type: if matches!(n.kind, AstNodeKind::CopyStatement) {
                    DependencyType::CopyInclude
                } else { DependencyType::ProgramCall },
                source_span: n.span.clone(),
                reference_text: if matches!(n.kind, AstNodeKind::CopyStatement) {
                    format!("INCLUDE '{}'", name)
                } else { format!("CALL {}", name) },
            }))
            .collect()
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes: vec![], edges: vec![], business_rules: vec![], data_flows: vec![],
        })
    }
}
