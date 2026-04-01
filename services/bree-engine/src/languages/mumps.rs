//! MUMPS/M parser — Tier 3 implementing LanguageParser trait.
//!
//! MUMPS (Massachusetts General Hospital Utility Multi-Programming System) runs
//! Epic, VA VistA, MEDITECH. Everything is a string, global variables (^globals)
//! are persistent hierarchical storage, naked references, indirection (@),
//! post-conditional execution (command:condition), single-character abbreviations.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct MumpsParser;

impl MumpsParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for MumpsParser {
    fn language_id(&self) -> &'static str { "mumps" }
    fn display_name(&self) -> &'static str { "MUMPS / M" }
    fn supported_dialects(&self) -> &[&'static str] { &["ANSI-M", "InterSystems-Cache", "InterSystems-IRIS", "GT.M"] }
    fn file_extensions(&self) -> &[&'static str] { &["m", "mps", "zwr", "ro", "int"] }

    fn nir_coverage_pct(&self) -> f64 { 0.68 }
    fn recommended_backend(&self) -> &'static str { "custom PEG grammar" }
    fn estimated_dev_effort(&self) -> &'static str { "3-4 weeks to production" }

    fn can_parse(&self, file: &SourceFile) -> bool {
        // .m is ambiguous (also Objective-C, MATLAB)
        // Use content heuristics: MUMPS has SET/KILL/QUIT and ^global references
        let ext_match = ["mps", "zwr", "ro", "int"].contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let has_mumps_commands = (upper.contains(" S ") || upper.contains("SET "))
            && (upper.contains(" K ") || upper.contains("KILL ") || upper.contains(" Q") || upper.contains("QUIT"));
        let has_globals = file.header.contains('^');
        let content_match = has_mumps_commands || (has_globals && file.extension == "m");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut globals_referenced: Vec<String> = Vec::new();
        let mut has_indirection = false;
        let mut has_naked_refs = false;
        let mut routine_calls: Vec<String> = Vec::new();

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // Routine/label definition: starts at column 1 (no leading whitespace)
            // Format: LABEL(params) ; comment  or  LABEL ; comment
            if !line.starts_with(' ') && !line.starts_with('\t') && !trimmed.starts_with(';') {
                let label = trimmed.split(|c: char| c == '(' || c == ' ' || c == ';' || c == '\t')
                    .next().unwrap_or("");
                if !label.is_empty() && label.chars().next().map(|c| c.is_alphabetic() || c == '%').unwrap_or(false) {
                    symbols.push(Symbol {
                        name: label.to_string(), kind: SymbolKind::Custom("Routine".to_string()),
                        span: span.clone(), visibility: Visibility::Public,
                        data_type: None, properties: HashMap::new(),
                    });
                }
            }

            // Skip comment-only lines
            if trimmed.starts_with(';') { continue; }

            // Scan for globals (^NAME)
            let mut pos = 0;
            let chars: Vec<char> = trimmed.chars().collect();
            while pos < chars.len() {
                if chars[pos] == '^' {
                    let _start = pos;
                    pos += 1;
                    let mut global_name = String::new();
                    while pos < chars.len() && (chars[pos].is_alphanumeric() || chars[pos] == '.' || chars[pos] == '%') {
                        global_name.push(chars[pos]);
                        pos += 1;
                    }
                    if !global_name.is_empty() {
                        let full = format!("^{}", global_name);
                        if !globals_referenced.contains(&full) {
                            globals_referenced.push(full);
                        }
                    }
                } else {
                    pos += 1;
                }
            }

            // Check for indirection (@)
            if trimmed.contains('@') {
                has_indirection = true;
                ast_nodes.push(AstNode {
                    id: format!("indirect-{}", i), kind: AstNodeKind::Custom("Indirection".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // Check for naked references (^( — global reference without name)
            if trimmed.contains("^(") {
                has_naked_refs = true;
            }

            // DO (routine call) — D or DO
            let upper = trimmed.to_uppercase();
            let commands = upper.split_whitespace().collect::<Vec<_>>();
            for (ci, cmd) in commands.iter().enumerate() {
                let c = *cmd;
                // Post-conditional: CMD:condition
                let base_cmd = c.split(':').next().unwrap_or(c);

                match base_cmd {
                    "D" | "DO" => {
                        if let Some(target) = commands.get(ci + 1) {
                            let routine = target.split('(').next().unwrap_or(target)
                                .split(':').next().unwrap_or(target).to_string();
                            if !routine.is_empty() && routine != "." {
                                routine_calls.push(routine.clone());
                                ast_nodes.push(AstNode {
                                    id: format!("do-{}", i), kind: AstNodeKind::CallStatement,
                                    name: Some(routine), span: span.clone(),
                                    children: vec![], properties: HashMap::new(),
                                });
                            }
                        }
                    }
                    "S" | "SET" => {
                        ast_nodes.push(AstNode {
                            id: format!("set-{}", i), kind: AstNodeKind::Assignment,
                            name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                        });
                    }
                    "K" | "KILL" => {
                        ast_nodes.push(AstNode {
                            id: format!("kill-{}", i), kind: AstNodeKind::Custom("Kill".to_string()),
                            name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                        });
                    }
                    "I" | "IF" => {
                        ast_nodes.push(AstNode {
                            id: format!("if-{}", i), kind: AstNodeKind::IfStatement,
                            name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                        });
                    }
                    _ => {}
                }
            }
        }

        let mut metadata = HashMap::new();
        metadata.insert("globals_referenced".to_string(), serde_json::json!(globals_referenced));
        metadata.insert("global_count".to_string(), serde_json::json!(globals_referenced.len()));
        metadata.insert("has_indirection".to_string(), serde_json::json!(has_indirection));
        metadata.insert("has_naked_references".to_string(), serde_json::json!(has_naked_refs));
        metadata.insert("routine_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Routine".to_string())).count()
        ));
        metadata.insert("routine_calls".to_string(), serde_json::json!(routine_calls));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: "InterSystems-Cache".to_string(),
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
        // Routine calls
        for node in &module.ast_nodes {
            if matches!(node.kind, AstNodeKind::CallStatement) {
                if let Some(name) = &node.name {
                    // Check if it's a cross-routine call (contains ^)
                    if name.contains('^') {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::ProgramCall,
                            source_span: node.span.clone(),
                            reference_text: format!("DO {}", name),
                        });
                    }
                }
            }
        }
        // Global references as data dependencies
        if let Some(globals) = module.metadata.get("globals_referenced") {
            if let Some(arr) = globals.as_array() {
                for g in arr {
                    if let Some(name) = g.as_str() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.to_string(),
                            dependency_type: DependencyType::DatabaseAccess,
                            source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                            reference_text: format!("Global {}", name),
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
