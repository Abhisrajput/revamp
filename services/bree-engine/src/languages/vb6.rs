//! VB6 parser — Tier 2 stub implementing LanguageParser trait.
//!
//! Handles Visual Basic 6 forms (.frm), modules (.bas), class modules (.cls).
//! Key challenges: COM/ActiveX coupling, OCX controls, UI/logic entanglement,
//! registry dependencies, On Error handling, Crystal Reports integration.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct Vb6Parser;

impl Vb6Parser {
    pub fn new() -> Self { Self }

    /// Detect file subtype: Form, Module, Class, or UserControl.
    fn detect_subtype(content: &str) -> &'static str {
        let upper = content.to_uppercase();
        if upper.contains("BEGIN VB.FORM") { return "Form"; }
        if upper.contains("BEGIN VB.USERCONTROL") { return "UserControl"; }
        if upper.contains("BEGIN VB.MDIFORM") { return "MDIForm"; }
        if upper.contains("VERSION 1.0 CLASS") { return "ClassModule"; }
        "StandardModule"
    }

    /// Extract COM/ActiveX references (CreateObject, New, References).
    fn extract_com_references(content: &str) -> Vec<(String, usize)> {
        let mut refs = Vec::new();
        for (i, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            let upper = trimmed.to_uppercase();

            // CreateObject("ProgID")
            if upper.contains("CREATEOBJECT(") {
                if let Some(start) = trimmed.find("CreateObject(\"").or(trimmed.find("CreateObject(\"")) {
                    let after = &trimmed[start + 14..];
                    if let Some(end) = after.find('"') {
                        refs.push((after[..end].to_string(), i));
                    }
                }
            }
            // New ClassName
            if upper.contains(" NEW ") && !upper.starts_with("'") {
                let parts: Vec<&str> = upper.split(" NEW ").collect();
                if parts.len() >= 2 {
                    let class_name = parts[1].split_whitespace().next().unwrap_or("").to_string();
                    if !class_name.is_empty() && class_name != "(" {
                        refs.push((class_name, i));
                    }
                }
            }
        }
        refs
    }

    /// Extract OCX/ActiveX controls from form definitions.
    fn extract_controls(content: &str) -> Vec<(String, String, usize)> {
        let mut controls = Vec::new();
        for (i, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            // Begin VB.CommandButton cmdSubmit
            // Begin MSComctlLib.TreeView tvwMain
            if trimmed.starts_with("Begin ") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    let control_type = parts[1].to_string();
                    let control_name = parts[2].to_string();
                    controls.push((control_type, control_name, i));
                }
            }
            // Object = "{GUID}#version; filename.ocx"
            if trimmed.starts_with("Object = ") {
                let ocx_ref = trimmed[9..].trim_matches('"').to_string();
                controls.push(("OCX-Reference".to_string(), ocx_ref, i));
            }
        }
        controls
    }
}

impl LanguageParser for Vb6Parser {
    fn language_id(&self) -> &'static str { "vb6" }
    fn display_name(&self) -> &'static str { "Visual Basic 6" }
    fn supported_dialects(&self) -> &[&'static str] { &["VB6-SP6"] }
    fn file_extensions(&self) -> &[&'static str] { &["frm", "bas", "cls", "vbp", "ctl"] }

    fn nir_coverage_pct(&self) -> f64 { 0.82 }
    fn recommended_backend(&self) -> &'static str { "ANTLR (vb6 grammar)" }
    fn estimated_dev_effort(&self) -> &'static str { "1-2 weeks to production" }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let content_match = file.header.contains("VERSION 5.00")
            || file.header.contains("Begin VB.Form")
            || file.header.contains("Attribute VB_Name")
            || file.header.contains("Option Explicit");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let subtype = Self::detect_subtype(&source.content);
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut in_code_section = false;

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('\'') { continue; }
            let upper = trimmed.to_uppercase();

            // Form files: code starts after "Attribute" block
            if upper.starts_with("ATTRIBUTE VB_") { in_code_section = true; continue; }

            // Sub/Function declarations
            if upper.starts_with("PUBLIC SUB ") || upper.starts_with("PRIVATE SUB ")
                || upper.starts_with("SUB ") {
                let name = trimmed.split('(').next().unwrap_or("")
                    .split_whitespace().last().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Procedure,
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() },
                    visibility: if upper.starts_with("PRIVATE") { Visibility::Private } else { Visibility::Public },
                    data_type: None, properties: HashMap::new(),
                });
            }
            if upper.starts_with("PUBLIC FUNCTION ") || upper.starts_with("PRIVATE FUNCTION ")
                || upper.starts_with("FUNCTION ") {
                let name = trimmed.split('(').next().unwrap_or("")
                    .split_whitespace().last().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Function,
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() },
                    visibility: if upper.starts_with("PRIVATE") { Visibility::Private } else { Visibility::Public },
                    data_type: None, properties: HashMap::new(),
                });
            }
            // Property Get/Let/Set
            if upper.starts_with("PUBLIC PROPERTY ") || upper.starts_with("PROPERTY ") {
                let name = trimmed.split('(').next().unwrap_or("")
                    .split_whitespace().last().unwrap_or("");
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Custom("Property".to_string()),
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() },
                    visibility: Visibility::Public, data_type: None, properties: HashMap::new(),
                });
            }

            // Dim/Public/Private variable declarations
            if (upper.starts_with("DIM ") || upper.starts_with("PUBLIC ") || upper.starts_with("PRIVATE "))
                && upper.contains(" AS ") && !upper.contains("SUB ") && !upper.contains("FUNCTION ")
                && !upper.contains("PROPERTY ") {
                let name = upper.split(" AS ").next().unwrap_or("")
                    .split_whitespace().last().unwrap_or("");
                let data_type = upper.split(" AS ").nth(1)
                    .map(|s| s.split_whitespace().next().unwrap_or("").to_string());
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Variable,
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() },
                    visibility: Visibility::Internal, data_type, properties: HashMap::new(),
                });
            }

            // Declare Function (DLL imports — external dependency!)
            if upper.starts_with("DECLARE FUNCTION ") || upper.starts_with("PRIVATE DECLARE ") || upper.starts_with("PUBLIC DECLARE ") {
                let lib_start = upper.find(" LIB \"").map(|p| p + 6);
                let dll = lib_start.and_then(|s| upper[s..].find('"').map(|e| upper[s..s+e].to_string()));
                let mut props = HashMap::new();
                if let Some(ref d) = dll { props.insert("dll".to_string(), serde_json::json!(d)); }
                ast_nodes.push(AstNode {
                    id: format!("declare-{}", i), kind: AstNodeKind::Custom("DLLDeclare".to_string()),
                    name: dll, span: Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() },
                    children: vec![], properties: props,
                });
            }

            // On Error handling
            if upper.starts_with("ON ERROR ") {
                let handler = if upper.contains("RESUME NEXT") { "resume-next" }
                    else if upper.contains("GOTO 0") { "goto-0" }
                    else if upper.contains("GOTO ") { "goto-label" }
                    else { "unknown" };
                ast_nodes.push(AstNode {
                    id: format!("onerror-{}", i), kind: AstNodeKind::Custom("OnError".to_string()),
                    name: Some(handler.to_string()),
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() },
                    children: vec![],
                    properties: HashMap::from([("handler".to_string(), serde_json::json!(handler))]),
                });
            }

            // DoEvents (UI responsiveness — indicates tight loop)
            if upper.contains("DOEVENTS") {
                ast_nodes.push(AstNode {
                    id: format!("doevents-{}", i), kind: AstNodeKind::Custom("DoEvents".to_string()),
                    name: None, span: Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() },
                    children: vec![], properties: HashMap::new(),
                });
            }
        }

        // Extract COM references and controls
        let com_refs = Self::extract_com_references(&source.content);
        let controls = Self::extract_controls(&source.content);

        let mut metadata = HashMap::new();
        metadata.insert("subtype".to_string(), serde_json::json!(subtype));
        metadata.insert("com_references".to_string(), serde_json::json!(
            com_refs.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>()
        ));
        metadata.insert("controls_count".to_string(), serde_json::json!(controls.len()));
        metadata.insert("control_types".to_string(), serde_json::json!(
            controls.iter().map(|(t, n, _)| format!("{}: {}", t, n)).collect::<Vec<_>>()
        ));
        metadata.insert("sub_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()
        ));
        metadata.insert("function_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));
        metadata.insert("dll_declares".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("DLLDeclare".to_string())).count()
        ));
        metadata.insert("on_error_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("OnError".to_string())).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: "VB6-SP6".to_string(),
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
        // COM CreateObject references
        if let Some(refs) = module.metadata.get("com_references") {
            if let Some(arr) = refs.as_array() {
                for r in arr {
                    if let Some(prog_id) = r.as_str() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: prog_id.to_string(),
                            dependency_type: DependencyType::ExternalSystem,
                            source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                            reference_text: format!("CreateObject(\"{}\")", prog_id),
                        });
                    }
                }
            }
        }
        // DLL declares
        for node in &module.ast_nodes {
            if node.kind == AstNodeKind::Custom("DLLDeclare".to_string()) {
                if let Some(name) = &node.name {
                    deps.push(DependencyRef {
                        from_module: module.source_path.clone(),
                        to_module: name.clone(),
                        dependency_type: DependencyType::ExternalSystem,
                        source_span: node.span.clone(),
                        reference_text: format!("Declare Lib \"{}\"", name),
                    });
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
