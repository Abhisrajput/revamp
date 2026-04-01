//! PL/SQL parser — Database Logic implementing LanguageParser trait.
//!
//! Handles Oracle PL/SQL stored procedures, packages, functions, triggers.
//! NOT legacy — actively developed (Oracle 23ai) — but critical for extracting
//! business rules buried in decades of stored procedures.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct PlsqlParser;

impl PlsqlParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for PlsqlParser {
    fn language_id(&self) -> &'static str { "plsql" }
    fn display_name(&self) -> &'static str { "PL/SQL (Oracle)" }
    fn supported_dialects(&self) -> &[&'static str] { &["Oracle-12c", "Oracle-19c", "Oracle-23ai"] }
    fn file_extensions(&self) -> &[&'static str] { &["pls", "plb", "pck", "pkb", "pks", "sql"] }

    fn nir_coverage_pct(&self) -> f64 { 0.80 }
    fn recommended_backend(&self) -> &'static str { "ANTLR (mature PlSql grammar)" }
    fn estimated_dev_effort(&self) -> &'static str { "1 week to production" }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = ["pls", "plb", "pck", "pkb", "pks"].contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let content_match = upper.contains("CREATE OR REPLACE")
            || (upper.contains("DECLARE") && upper.contains("BEGIN"))
            || upper.contains("PACKAGE BODY")
            || upper.contains("CREATE TRIGGER");
        // .sql is ambiguous — only match if content looks like PL/SQL
        let sql_with_plsql = file.extension == "sql" && content_match;
        ext_match || sql_with_plsql
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut tables_referenced: Vec<String> = Vec::new();
        let mut is_package = false;
        let mut cursor_count = 0;
        let mut exception_count = 0;

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("--") { continue; }
            let upper = trimmed.to_uppercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // CREATE OR REPLACE PROCEDURE/FUNCTION/PACKAGE/TRIGGER
            if upper.starts_with("CREATE") && upper.contains("REPLACE") {
                let obj_type = if upper.contains("PACKAGE BODY") { "PackageBody" }
                    else if upper.contains("PACKAGE") { "PackageSpec" }
                    else if upper.contains("PROCEDURE") { "Procedure" }
                    else if upper.contains("FUNCTION") { "Function" }
                    else if upper.contains("TRIGGER") { "Trigger" }
                    else if upper.contains("TYPE BODY") { "TypeBody" }
                    else if upper.contains("TYPE") { "Type" }
                    else { "Unknown" };

                if obj_type.contains("Package") { is_package = true; }

                let keyword = match obj_type {
                    "PackageBody" => "PACKAGE BODY",
                    "PackageSpec" => "PACKAGE",
                    "Procedure" => "PROCEDURE",
                    "Function" => "FUNCTION",
                    "Trigger" => "TRIGGER",
                    "TypeBody" => "TYPE BODY",
                    "Type" => "TYPE",
                    _ => "",
                };
                let name = upper.split(keyword).nth(1)
                    .and_then(|s| s.trim().split(|c: char| c.is_whitespace() || c == '(' || c == ';').next())
                    .unwrap_or("").to_string();

                symbols.push(Symbol {
                    name: name.clone(), kind: SymbolKind::Custom(obj_type.to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
                ast_nodes.push(AstNode {
                    id: format!("create-{}", i), kind: AstNodeKind::Procedure,
                    name: Some(name), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("object_type".to_string(), serde_json::json!(obj_type))]),
                });
            }

            // Standalone PROCEDURE/FUNCTION inside package body
            if !upper.starts_with("CREATE") && (upper.starts_with("PROCEDURE ") || upper.starts_with("FUNCTION ")) {
                let is_func = upper.starts_with("FUNCTION");
                let rest = if is_func { &upper[9..] } else { &upper[10..] };
                let name = rest.split(|c: char| c.is_whitespace() || c == '(' || c == ';')
                    .next().unwrap_or("").to_string();
                if !name.is_empty() {
                    symbols.push(Symbol {
                        name, kind: if is_func { SymbolKind::Function } else { SymbolKind::Procedure },
                        span: span.clone(), visibility: Visibility::Public,
                        data_type: None, properties: HashMap::new(),
                    });
                }
            }

            // CURSOR declarations
            if upper.starts_with("CURSOR ") || upper.contains(" CURSOR ") && upper.contains(" IS") {
                cursor_count += 1;
                let name = if upper.starts_with("CURSOR ") {
                    upper[7..].split_whitespace().next().unwrap_or("")
                } else {
                    upper.split(" CURSOR").next().and_then(|s| s.split_whitespace().last()).unwrap_or("")
                };
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Cursor".to_string()),
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // EXCEPTION handling
            if upper == "EXCEPTION" || upper.starts_with("EXCEPTION") {
                exception_count += 1;
            }
            if upper.starts_with("WHEN ") && upper.contains("THEN") {
                let exc_name = upper[5..].split(" THEN").next().unwrap_or("").trim();
                ast_nodes.push(AstNode {
                    id: format!("when-{}", i), kind: AstNodeKind::Custom("ExceptionHandler".to_string()),
                    name: Some(exc_name.to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // EXECUTE IMMEDIATE (dynamic SQL)
            if upper.contains("EXECUTE IMMEDIATE") {
                ast_nodes.push(AstNode {
                    id: format!("execimm-{}", i), kind: AstNodeKind::Custom("DynamicSQL".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // Table references: FROM, INTO, UPDATE, INSERT INTO, DELETE FROM, JOIN
            for kw in &["FROM ", "INTO ", "UPDATE ", "JOIN "] {
                if upper.contains(kw) {
                    for part in upper.split(kw).skip(1) {
                        let table = part.split_whitespace().next().unwrap_or("")
                            .trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '.');
                        if table.len() > 1 && !table.starts_with('(') && !table.starts_with(':')
                            && table != "DUAL" && !tables_referenced.contains(&table.to_string()) {
                            tables_referenced.push(table.to_string());
                        }
                    }
                }
            }

            // PRAGMA AUTONOMOUS_TRANSACTION
            if upper.contains("PRAGMA AUTONOMOUS_TRANSACTION") {
                ast_nodes.push(AstNode {
                    id: format!("pragma-{}", i),
                    kind: AstNodeKind::Custom("AutonomousTransaction".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // BULK COLLECT / FORALL
            if upper.contains("BULK COLLECT") || upper.starts_with("FORALL ") {
                ast_nodes.push(AstNode {
                    id: format!("bulk-{}", i), kind: AstNodeKind::Custom("BulkOperation".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("is_package".to_string(), serde_json::json!(is_package));
        metadata.insert("tables_referenced".to_string(), serde_json::json!(tables_referenced));
        metadata.insert("cursor_count".to_string(), serde_json::json!(cursor_count));
        metadata.insert("exception_handlers".to_string(), serde_json::json!(exception_count));
        metadata.insert("dynamic_sql_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("DynamicSQL".to_string())).count()
        ));
        metadata.insert("autonomous_transactions".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("AutonomousTransaction".to_string())).count()
        ));
        metadata.insert("bulk_operations".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("BulkOperation".to_string())).count()
        ));
        metadata.insert("procedure_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()
        ));
        metadata.insert("function_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: "Oracle-19c".to_string(),
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
        if let Some(tables) = module.metadata.get("tables_referenced") {
            if let Some(arr) = tables.as_array() {
                for t in arr {
                    if let Some(name) = t.as_str() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.to_string(),
                            dependency_type: DependencyType::DatabaseAccess,
                            source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                            reference_text: format!("Table: {}", name),
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
