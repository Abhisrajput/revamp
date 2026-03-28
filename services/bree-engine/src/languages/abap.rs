//! ABAP parser — Tier 2 stub implementing LanguageParser trait.
//!
//! Handles SAP ABAP programs, function modules, classes.
//! Key challenges: SAP data dictionary, dynpro screens, ALV reports,
//! BAdI/enhancement points, transport system.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct AbapParser;

impl AbapParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for AbapParser {
    fn language_id(&self) -> &'static str { "abap" }
    fn display_name(&self) -> &'static str { "ABAP (SAP)" }
    fn supported_dialects(&self) -> &[&'static str] { &["ABAP-Classic", "ABAP-Objects", "ABAP-Cloud"] }
    fn file_extensions(&self) -> &[&'static str] { &["abap", "fugr", "clas", "prog"] }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let content_match = upper.contains("REPORT ")
            || upper.contains("FUNCTION-POOL ")
            || (upper.contains("DATA:") && upper.contains("TYPE "))
            || upper.contains("CLASS ") && upper.contains(" DEFINITION");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut is_oo = false;

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('*') || trimmed.starts_with('"') { continue; }
            let upper = trimmed.to_uppercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // REPORT / PROGRAM
            if upper.starts_with("REPORT ") || upper.starts_with("PROGRAM ") {
                let name = upper.split_whitespace().nth(1).unwrap_or("").trim_end_matches('.');
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Program,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // FORM ... ENDFORM
            if upper.starts_with("FORM ") {
                let name = upper[5..].split_whitespace().next().unwrap_or("").trim_end_matches('.');
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Subroutine,
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // METHOD ... ENDMETHOD
            if upper.starts_with("METHOD ") {
                let name = upper[7..].split_whitespace().next().unwrap_or("").trim_end_matches('.');
                is_oo = true;
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Function,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // CLASS ... DEFINITION / IMPLEMENTATION
            if upper.starts_with("CLASS ") && (upper.contains(" DEFINITION") || upper.contains(" IMPLEMENTATION")) {
                let name = upper[6..].split_whitespace().next().unwrap_or("");
                is_oo = true;
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Class".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // SELECT ... FROM ... (DB access)
            if upper.starts_with("SELECT ") && upper.contains(" FROM ") {
                let table = upper.split(" FROM ").nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .unwrap_or("").trim_end_matches('.');
                ast_nodes.push(AstNode {
                    id: format!("select-{}", i), kind: AstNodeKind::Custom("Select".to_string()),
                    name: Some(table.to_string()), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("table".to_string(), serde_json::json!(table))]),
                });
            }

            // CALL FUNCTION
            if upper.starts_with("CALL FUNCTION ") {
                let func = upper[14..].trim_matches(|c: char| c == '\'' || c == '"' || c == ' ')
                    .split('\'').next().unwrap_or("").to_string();
                ast_nodes.push(AstNode {
                    id: format!("callfunc-{}", i), kind: AstNodeKind::CallStatement,
                    name: Some(func), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // PERFORM (subroutine call)
            if upper.starts_with("PERFORM ") {
                let target = upper[8..].split_whitespace().next().unwrap_or("").trim_end_matches('.');
                ast_nodes.push(AstNode {
                    id: format!("perform-{}", i), kind: AstNodeKind::PerformStatement,
                    name: Some(target.to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("is_oo".to_string(), serde_json::json!(is_oo));
        metadata.insert("form_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Subroutine)).count()
        ));
        metadata.insert("method_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));
        metadata.insert("select_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("Select".to_string())).count()
        ));
        metadata.insert("db_tables".to_string(), serde_json::json!(
            ast_nodes.iter()
                .filter(|n| n.kind == AstNodeKind::Custom("Select".to_string()))
                .filter_map(|n| n.name.as_ref())
                .collect::<Vec<_>>()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: if is_oo { "ABAP-Objects" } else { "ABAP-Classic" }.to_string(),
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
            .filter(|n| matches!(n.kind, AstNodeKind::CallStatement))
            .filter_map(|n| n.name.as_ref().map(|name| DependencyRef {
                from_module: module.source_path.clone(),
                to_module: name.clone(),
                dependency_type: DependencyType::ProgramCall,
                source_span: n.span.clone(),
                reference_text: format!("CALL FUNCTION '{}'", name),
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
