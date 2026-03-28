//! SAS parser — Tier 2 stub implementing LanguageParser trait.
//!
//! Handles SAS programs with DATA step/PROC step distinction.
//! Key challenges: macro language (%macro, &variables), DATA step vs PROC,
//! ODS output delivery, format libraries, SAS/IML matrix ops.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct SasParser;

impl SasParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for SasParser {
    fn language_id(&self) -> &'static str { "sas" }
    fn display_name(&self) -> &'static str { "SAS" }
    fn supported_dialects(&self) -> &[&'static str] { &["SAS-Base", "SAS-Macro", "SAS-SQL"] }
    fn file_extensions(&self) -> &[&'static str] { &["sas"] }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let lower = file.header.to_lowercase();
        let content_match = lower.contains("data ") && lower.contains("run;")
            || lower.contains("proc ") && lower.contains("run;")
            || lower.contains("%macro") || lower.contains("%let");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut in_data_step = false;
        let mut in_proc_step = false;
        let mut macro_count = 0;
        let mut macro_var_count = 0;
        let mut data_sets: Vec<String> = Vec::new();
        let mut procs_used: Vec<String> = Vec::new();

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            // SAS comments: /* */ or * ;
            if trimmed.starts_with('*') && trimmed.ends_with(';') { continue; }
            let lower = trimmed.to_lowercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // DATA step: data <dataset>;
            if lower.starts_with("data ") && !in_data_step {
                in_data_step = true;
                in_proc_step = false;
                let ds_name = lower[5..].split(';').next().unwrap_or("").trim().to_string();
                if !ds_name.is_empty() {
                    data_sets.push(ds_name.clone());
                    symbols.push(Symbol {
                        name: ds_name, kind: SymbolKind::Custom("DataSet".to_string()),
                        span: span.clone(), visibility: Visibility::Public,
                        data_type: None, properties: HashMap::new(),
                    });
                }
                ast_nodes.push(AstNode {
                    id: format!("datastep-{}", i), kind: AstNodeKind::Custom("DataStep".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // PROC step: proc <procname>;
            if lower.starts_with("proc ") && !in_proc_step {
                in_proc_step = true;
                in_data_step = false;
                let proc_name = lower[5..].split(|c: char| c == ';' || c.is_whitespace())
                    .next().unwrap_or("").to_string();
                if !proc_name.is_empty() && !procs_used.contains(&proc_name) {
                    procs_used.push(proc_name.clone());
                }
                ast_nodes.push(AstNode {
                    id: format!("proc-{}", i), kind: AstNodeKind::Custom("ProcStep".to_string()),
                    name: Some(proc_name), span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // RUN; ends both DATA and PROC steps
            if lower.starts_with("run;") || lower == "run ;" {
                in_data_step = false;
                in_proc_step = false;
            }

            // Macro definitions: %macro <name>;
            if lower.starts_with("%macro ") {
                macro_count += 1;
                let name = lower[7..].split(|c: char| c == ';' || c == '(')
                    .next().unwrap_or("").trim().to_string();
                symbols.push(Symbol {
                    name, kind: SymbolKind::Custom("Macro".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // Macro variables: %let <var> = <value>;
            if lower.starts_with("%let ") {
                macro_var_count += 1;
                let name = lower[5..].split('=').next().unwrap_or("").trim().to_string();
                symbols.push(Symbol {
                    name, kind: SymbolKind::Custom("MacroVar".to_string()),
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: HashMap::new(),
                });
            }

            // %include (external file reference)
            if lower.starts_with("%include ") || lower.starts_with("%inc ") {
                let file_ref = lower.split_whitespace().nth(1)
                    .unwrap_or("").trim_matches(|c: char| c == '\'' || c == '"' || c == ';').to_string();
                ast_nodes.push(AstNode {
                    id: format!("include-{}", i), kind: AstNodeKind::CopyStatement,
                    name: Some(file_ref), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // PROC SQL
            if lower.starts_with("proc sql") {
                ast_nodes.push(AstNode {
                    id: format!("procsql-{}", i), kind: AstNodeKind::ExecSqlBlock,
                    name: Some("PROC SQL".to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // LIBNAME (library assignment — external data source)
            if lower.starts_with("libname ") {
                let parts: Vec<&str> = lower[8..].split_whitespace().collect();
                let lib_name = parts.first().unwrap_or(&"");
                let engine = parts.get(1).unwrap_or(&"");
                ast_nodes.push(AstNode {
                    id: format!("libname-{}", i), kind: AstNodeKind::Custom("Libname".to_string()),
                    name: Some(lib_name.to_string()), span: span.clone(),
                    children: vec![],
                    properties: HashMap::from([("engine".to_string(), serde_json::json!(engine))]),
                });
            }

            // ODS destinations
            if lower.starts_with("ods ") {
                let dest = lower[4..].split_whitespace().next().unwrap_or("");
                ast_nodes.push(AstNode {
                    id: format!("ods-{}", i), kind: AstNodeKind::Custom("ODS".to_string()),
                    name: Some(dest.to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("data_steps".to_string(), serde_json::json!(data_sets));
        metadata.insert("procs_used".to_string(), serde_json::json!(procs_used));
        metadata.insert("macro_count".to_string(), serde_json::json!(macro_count));
        metadata.insert("macro_var_count".to_string(), serde_json::json!(macro_var_count));
        metadata.insert("has_proc_sql".to_string(), serde_json::json!(
            ast_nodes.iter().any(|n| n.kind == AstNodeKind::ExecSqlBlock)
        ));
        metadata.insert("libname_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("Libname".to_string())).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: if macro_count > 0 { "SAS-Macro" } else { "SAS-Base" }.to_string(),
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
            .filter(|n| matches!(n.kind, AstNodeKind::CopyStatement))
            .filter_map(|n| n.name.as_ref().map(|name| DependencyRef {
                from_module: module.source_path.clone(),
                to_module: name.clone(),
                dependency_type: DependencyType::CopyInclude,
                source_span: n.span.clone(),
                reference_text: format!("%include {}", name),
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
