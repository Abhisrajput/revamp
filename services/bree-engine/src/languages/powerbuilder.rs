//! PowerBuilder parser — Tier 2 stub.
//!
//! Handles PowerBuilder source exports (.srw, .srd, .srf, .srm).
//! Key challenges: DataWindow objects (SQL + display + validation in one),
//! PowerScript event model, PFC framework layers.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct PowerBuilderParser;

impl PowerBuilderParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for PowerBuilderParser {
    fn language_id(&self) -> &'static str { "powerbuilder" }
    fn display_name(&self) -> &'static str { "PowerBuilder" }
    fn supported_dialects(&self) -> &[&'static str] { &["PB-12", "PB-2019", "PB-2025"] }
    fn file_extensions(&self) -> &[&'static str] { &["srw", "srd", "srf", "srm"] }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let lower = file.header.to_lowercase();
        let content_match = lower.contains("forward") && lower.contains("global type")
            || lower.contains("event type")
            || lower.contains("datawindow");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let _in_sql = false;
        let _sql_content = String::new();
        let _sql_start = 0;
        let mut datawindow_count = 0;

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("//") { continue; }
            let lower = trimmed.to_lowercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // Global type (class/window definition)
            if lower.starts_with("global type ") {
                let parts: Vec<&str> = lower[12..].split(" from ").collect();
                let name = parts[0].trim();
                let parent = parts.get(1).map(|s| s.trim().to_string());
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Window".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: parent, properties: HashMap::new(),
                });
            }

            // Event handler
            if lower.starts_with("event ") && !lower.starts_with("event type") {
                let name = lower[6..].split(|c: char| c == ';' || c == '(')
                    .next().unwrap_or("").trim();
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Event".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // Function/subroutine
            if lower.starts_with("public function ") || lower.starts_with("private function ")
                || lower.starts_with("protected function ") {
                let vis_end = lower.find("function ").unwrap_or(0) + 9;
                let rest = &lower[vis_end..];
                let name = rest.split('(').next().unwrap_or("").split_whitespace().last().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Function,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }
            if lower.starts_with("public subroutine ") || lower.starts_with("subroutine ") {
                let name = lower.split('(').next().unwrap_or("")
                    .split_whitespace().last().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Procedure,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // Embedded SQL
            if lower.contains("declare ") && lower.contains("cursor") {
                ast_nodes.push(AstNode {
                    id: format!("cursor-{}", i), kind: AstNodeKind::ExecSqlBlock,
                    name: Some("SQL Cursor".to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // DataWindow reference
            if lower.contains("datawindow") || lower.contains("dw_") {
                datawindow_count += 1;
            }

            // Instance variables
            if (lower.starts_with("string ") || lower.starts_with("integer ") || lower.starts_with("long ")
                || lower.starts_with("decimal ") || lower.starts_with("boolean "))
                && !lower.contains("function") && !lower.contains("subroutine") {
                let parts: Vec<&str> = lower.split_whitespace().collect();
                if parts.len() >= 2 {
                    symbols.push(Symbol {
                        name: parts[1].trim_end_matches(|c: char| !c.is_alphanumeric()).to_string(),
                        kind: SymbolKind::Variable,
                        span: span.clone(), visibility: Visibility::Internal,
                        data_type: Some(parts[0].to_string()),
                        properties: HashMap::new(),
                    });
                }
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("datawindow_references".to_string(), serde_json::json!(datawindow_count));
        metadata.insert("event_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Event".to_string())).count()
        ));
        metadata.insert("function_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: "PB-2019".to_string(),
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

    fn resolve_dependencies(&self, _module: &ParseOutput, _vault: &SourceVault) -> Vec<DependencyRef> {
        vec![]
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes: vec![], edges: vec![], business_rules: vec![], data_flows: vec![],
        })
    }
}
