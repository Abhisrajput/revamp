//! NATURAL (Software AG) parser — Tier 2 implementing LanguageParser trait.
//!
//! NATURAL is a 4GL intrinsically coupled to the Adabas inverted-list database.
//! Fundamentally different from COBOL — do NOT conflate the two.
//!
//! Key constructs: DEFINE DATA blocks (LOCAL/GLOBAL/PARAMETER), Adabas file
//! descriptors, NATURAL maps (screen I/O), PREDICT data dictionary,
//! READ/FIND/HISTOGRAM Adabas access patterns.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct NaturalParser;

impl NaturalParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for NaturalParser {
    fn language_id(&self) -> &'static str { "natural" }
    fn display_name(&self) -> &'static str { "NATURAL (Software AG)" }
    fn supported_dialects(&self) -> &[&'static str] { &["NATURAL-8", "NATURAL-9"] }
    fn file_extensions(&self) -> &[&'static str] { &["nsp", "nsn", "nss", "nsm", "nsl"] }

    fn nir_coverage_pct(&self) -> f64 { 0.70 }
    fn recommended_backend(&self) -> &'static str { "custom (no OSS NATURAL parser)" }
    fn estimated_dev_effort(&self) -> &'static str { "2-3 weeks to production" }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let content_match = upper.contains("DEFINE DATA")
            || upper.contains("END-DEFINE")
            || (upper.contains("READ ") && upper.contains("END-READ"))
            || upper.contains("INPUT USING MAP");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut in_define_data = false;
        let mut define_scope = "LOCAL";
        let mut adabas_files: Vec<String> = Vec::new();
        let mut maps_used: Vec<String> = Vec::new();
        let mut subroutine_calls: Vec<String> = Vec::new();

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('*') { continue; }
            let upper = trimmed.to_uppercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // DEFINE DATA LOCAL/GLOBAL/PARAMETER
            if upper.starts_with("DEFINE DATA") {
                in_define_data = true;
                define_scope = if upper.contains("LOCAL") { "LOCAL" }
                    else if upper.contains("GLOBAL") { "GLOBAL" }
                    else if upper.contains("PARAMETER") { "PARAMETER" }
                    else { "LOCAL" };
                ast_nodes.push(AstNode {
                    id: format!("defdata-{}", i), kind: AstNodeKind::Custom("DefineData".to_string()),
                    name: Some(define_scope.to_string()), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("scope".to_string(), serde_json::json!(define_scope))]),
                });
                continue;
            }
            if upper == "END-DEFINE" {
                in_define_data = false;
                continue;
            }

            // Inside DEFINE DATA: variable declarations (level number + name + format)
            if in_define_data {
                let parts: Vec<&str> = upper.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(level) = parts[0].parse::<u8>() {
                        let name = parts[1].trim_matches('#');
                        let format = parts.get(2).map(|f| {
                            if f.starts_with('(') { f.trim_matches(|c: char| c == '(' || c == ')').to_string() }
                            else { f.to_string() }
                        });
                        // Check for VIEW keyword (Adabas file reference)
                        if upper.contains(" VIEW ") {
                            if let Some(file_ref) = parts.iter().position(|p| *p == "OF").and_then(|pos| parts.get(pos + 1)) {
                                if !adabas_files.contains(&file_ref.to_string()) {
                                    adabas_files.push(file_ref.to_string());
                                }
                            }
                        }
                        symbols.push(Symbol {
                            name: name.to_string(), kind: SymbolKind::Variable,
                            span: span.clone(), visibility: Visibility::Internal,
                            data_type: format,
                            properties: HashMap::from([
                                ("level".to_string(), serde_json::json!(level)),
                                ("scope".to_string(), serde_json::json!(define_scope)),
                            ]),
                        });
                    }
                }
                continue;
            }

            // READ / FIND / HISTOGRAM (Adabas access)
            if upper.starts_with("READ ") && !upper.contains("WORK FILE") {
                let file_ref = upper[5..].split_whitespace().next().unwrap_or("").to_string();
                if !file_ref.is_empty() && !adabas_files.contains(&file_ref) {
                    adabas_files.push(file_ref.clone());
                }
                ast_nodes.push(AstNode {
                    id: format!("read-{}", i), kind: AstNodeKind::ReadStatement,
                    name: Some(file_ref), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("operation".to_string(), serde_json::json!("READ"))]),
                });
            }
            if upper.starts_with("FIND ") {
                let file_ref = upper[5..].split_whitespace().next().unwrap_or("").to_string();
                if !file_ref.is_empty() && !adabas_files.contains(&file_ref) {
                    adabas_files.push(file_ref.clone());
                }
                ast_nodes.push(AstNode {
                    id: format!("find-{}", i), kind: AstNodeKind::ReadStatement,
                    name: Some(file_ref), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("operation".to_string(), serde_json::json!("FIND"))]),
                });
            }
            if upper.starts_with("HISTOGRAM ") {
                let file_ref = upper[10..].split_whitespace().next().unwrap_or("").to_string();
                ast_nodes.push(AstNode {
                    id: format!("histogram-{}", i), kind: AstNodeKind::ReadStatement,
                    name: Some(file_ref), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("operation".to_string(), serde_json::json!("HISTOGRAM"))]),
                });
            }
            if upper.starts_with("STORE ") || upper.starts_with("UPDATE ") || upper.starts_with("DELETE ") {
                let op = upper.split_whitespace().next().unwrap_or("");
                ast_nodes.push(AstNode {
                    id: format!("dml-{}", i), kind: AstNodeKind::WriteStatement,
                    name: None, span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("operation".to_string(), serde_json::json!(op))]),
                });
            }

            // INPUT USING MAP (screen I/O)
            if upper.contains("INPUT USING MAP") || upper.contains("WRITE USING MAP") {
                let map_name = upper.split("MAP").nth(1)
                    .and_then(|s| s.trim().split_whitespace().next())
                    .unwrap_or("").trim_matches('\'').to_string();
                if !map_name.is_empty() && !maps_used.contains(&map_name) {
                    maps_used.push(map_name.clone());
                }
                ast_nodes.push(AstNode {
                    id: format!("map-{}", i), kind: AstNodeKind::Custom("MapIO".to_string()),
                    name: Some(map_name), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // PERFORM / CALLNAT (subroutine/subprogram call)
            if upper.starts_with("PERFORM ") {
                let target = upper[8..].split_whitespace().next().unwrap_or("").to_string();
                subroutine_calls.push(target.clone());
                ast_nodes.push(AstNode {
                    id: format!("perform-{}", i), kind: AstNodeKind::PerformStatement,
                    name: Some(target), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }
            if upper.starts_with("CALLNAT ") {
                let target = upper[8..].trim_matches('\'').split('\'').next()
                    .unwrap_or("").to_string();
                ast_nodes.push(AstNode {
                    id: format!("callnat-{}", i), kind: AstNodeKind::CallStatement,
                    name: Some(target), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("type".to_string(), serde_json::json!("CALLNAT"))]),
                });
            }

            // DEFINE SUBROUTINE
            if upper.starts_with("DEFINE SUBROUTINE ") {
                let name = upper[18..].trim().to_string();
                symbols.push(Symbol {
                    name, kind: SymbolKind::Subroutine,
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // IF / DECIDE (control flow)
            if upper.starts_with("IF ") {
                ast_nodes.push(AstNode {
                    id: format!("if-{}", i), kind: AstNodeKind::IfStatement,
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }
            if upper.starts_with("DECIDE ") {
                ast_nodes.push(AstNode {
                    id: format!("decide-{}", i), kind: AstNodeKind::EvaluateStatement,
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // INCLUDE (copycode)
            if upper.starts_with("INCLUDE ") {
                let target = upper[8..].split_whitespace().next().unwrap_or("").to_string();
                ast_nodes.push(AstNode {
                    id: format!("include-{}", i), kind: AstNodeKind::CopyStatement,
                    name: Some(target), span, children: vec![], properties: HashMap::new(),
                });
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("adabas_files".to_string(), serde_json::json!(adabas_files));
        metadata.insert("maps_used".to_string(), serde_json::json!(maps_used));
        metadata.insert("subroutine_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Subroutine)).count()
        ));
        metadata.insert("variable_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Variable)).count()
        ));
        metadata.insert("callnat_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::CallStatement)).count()
        ));
        metadata.insert("adabas_operations".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::ReadStatement | AstNodeKind::WriteStatement)).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: "NATURAL-9".to_string(),
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
        let mut deps = Vec::new();
        for node in &module.ast_nodes {
            if let AstNodeKind::CallStatement = &node.kind {
                if let Some(name) = &node.name {
                    deps.push(DependencyRef {
                        from_module: module.source_path.clone(),
                        to_module: name.clone(),
                        dependency_type: DependencyType::ProgramCall,
                        source_span: node.span.clone(),
                        reference_text: format!("CALLNAT '{}'", name),
                    });
                }
            }
            if let AstNodeKind::CopyStatement = &node.kind {
                if let Some(name) = &node.name {
                    deps.push(DependencyRef {
                        from_module: module.source_path.clone(),
                        to_module: name.clone(),
                        dependency_type: DependencyType::CopyInclude,
                        source_span: node.span.clone(),
                        reference_text: format!("INCLUDE {}", name),
                    });
                }
            }
        }
        // Adabas file dependencies
        if let Some(files) = module.metadata.get("adabas_files") {
            if let Some(arr) = files.as_array() {
                for f in arr {
                    if let Some(name) = f.as_str() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: format!("Adabas:{}", name),
                            dependency_type: DependencyType::DatabaseAccess,
                            source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                            reference_text: format!("Adabas file {}", name),
                        });
                    }
                }
            }
        }
        deps
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes: vec![], edges: vec![], business_rules: vec![], data_flows: vec![],
        })
    }
}
