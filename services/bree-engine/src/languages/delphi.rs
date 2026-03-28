//! Delphi / Object Pascal parser — Tier 2 stub.
//!
//! Handles Delphi units (.pas), projects (.dpr), packages (.dpk), forms (.dfm).
//! Key challenges: VCL component model, DFM resource files, units with
//! interface/implementation split, inline assembly, COM automation.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct DelphiParser;

impl DelphiParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for DelphiParser {
    fn language_id(&self) -> &'static str { "delphi" }
    fn display_name(&self) -> &'static str { "Delphi / Object Pascal" }
    fn supported_dialects(&self) -> &[&'static str] { &["Delphi-7", "Delphi-XE", "Delphi-11"] }
    fn file_extensions(&self) -> &[&'static str] { &["pas", "dpr", "dpk", "dfm"] }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let lower = file.header.to_lowercase();
        let content_match = lower.contains("unit ") && lower.contains("interface")
            || lower.contains("program ") && lower.contains("uses ")
            || lower.starts_with("object ");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let ast_nodes = Vec::new();
        let mut in_interface = false;
        let mut in_implementation = false;
        let mut uses_clauses: Vec<String> = Vec::new();

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('{') { continue; }
            let lower = trimmed.to_lowercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // Unit name
            if lower.starts_with("unit ") {
                let name = lower[5..].trim_end_matches(';').trim();
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Program,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // Section boundaries
            if lower == "interface" { in_interface = true; in_implementation = false; }
            if lower == "implementation" { in_implementation = true; in_interface = false; }

            // Uses clause
            if lower.starts_with("uses ") || lower.starts_with("uses") {
                let units_str = lower.replace("uses", "").trim_end_matches(';').trim().to_string();
                for u in units_str.split(',') {
                    let unit = u.trim().to_string();
                    if !unit.is_empty() { uses_clauses.push(unit); }
                }
            }

            // Type declarations (TClassName = class)
            if lower.contains("= class") || lower.contains("= class(") {
                let name = lower.split('=').next().unwrap_or("").trim();
                let parent = if lower.contains("class(") {
                    lower.split("class(").nth(1).and_then(|s| s.split(')').next())
                        .map(|s| s.trim().to_string())
                } else { None };

                let mut props = HashMap::new();
                if let Some(ref p) = parent { props.insert("parent".to_string(), serde_json::json!(p)); }
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Class".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: parent, properties: HashMap::new(),
                });
            }

            // Procedure/function declarations
            if lower.starts_with("procedure ") || lower.starts_with("function ") {
                let is_func = lower.starts_with("function");
                let rest = if is_func { &lower[9..] } else { &lower[10..] };
                let name = rest.split(|c: char| c == '(' || c == ';' || c == ':')
                    .next().unwrap_or("").trim();
                let vis = if in_interface { Visibility::Public } else { Visibility::Private };

                symbols.push(Symbol {
                    name: name.to_string(),
                    kind: if is_func { SymbolKind::Function } else { SymbolKind::Procedure },
                    span: span.clone(), visibility: vis,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // Published/public property
            if lower.starts_with("property ") {
                let name = lower[9..].split(|c: char| c == ':' || c == '[' || c == ' ')
                    .next().unwrap_or("").trim();
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Property".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("uses_units".to_string(), serde_json::json!(uses_clauses));
        metadata.insert("has_interface_section".to_string(), serde_json::json!(in_interface || in_implementation));
        metadata.insert("class_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Class".to_string())).count()
        ));
        metadata.insert("procedure_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()
        ));
        metadata.insert("function_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: "Delphi-XE".to_string(),
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
        if let Some(uses) = module.metadata.get("uses_units") {
            if let Some(arr) = uses.as_array() {
                for u in arr {
                    if let Some(name) = u.as_str() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.to_string(),
                            dependency_type: DependencyType::CopyInclude,
                            source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                            reference_text: format!("uses {}", name),
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
