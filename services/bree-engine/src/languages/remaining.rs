//! Remaining language parsers — Tier 2/3/4 + Database Logic.
//!
//! Each parser does real line-by-line extraction: symbol declarations,
//! control flow, calls, includes, and language-specific constructs.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

// ─── Parser implementation macro ────────────────────────────────

macro_rules! impl_parser {
    (
        $struct_name:ident,
        $id:expr, $display:expr, $dialects:expr, $extensions:expr,
        $header_patterns:expr,
        $parse_body:expr
    ) => {
        pub struct $struct_name;
        impl $struct_name { pub fn new() -> Self { Self } }

        impl LanguageParser for $struct_name {
            fn language_id(&self) -> &'static str { $id }
            fn display_name(&self) -> &'static str { $display }
            fn supported_dialects(&self) -> &[&'static str] { $dialects }
            fn file_extensions(&self) -> &[&'static str] { $extensions }

            fn can_parse(&self, file: &SourceFile) -> bool {
                let ext_match = self.file_extensions().contains(&file.extension.as_str());
                let patterns: &[&str] = $header_patterns;
                let upper = file.header.to_uppercase();
                let content_match = patterns.iter().any(|p| upper.contains(&p.to_uppercase()));
                ext_match || content_match
            }

            fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
                let parse_impl: fn(&SourceFile) -> (Vec<AstNode>, Vec<Symbol>, Vec<EmbeddedBlock>, HashMap<String, serde_json::Value>, &'static str) = $parse_body;
                let (ast_nodes, symbols, embedded, metadata, dialect) = parse_impl(source);
                Ok(ParseOutput {
                    language_id: self.language_id().to_string(),
                    dialect: dialect.to_string(),
                    source_path: source.path.to_string_lossy().to_string(),
                    total_lines: source.content.lines().count(),
                    ast_nodes, symbols, embedded_blocks: embedded,
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
                    match &node.kind {
                        AstNodeKind::CopyStatement => {
                            if let Some(name) = &node.name {
                                deps.push(DependencyRef {
                                    from_module: module.source_path.clone(),
                                    to_module: name.clone(),
                                    dependency_type: DependencyType::CopyInclude,
                                    source_span: node.span.clone(),
                                    reference_text: format!("include {}", name),
                                });
                            }
                        }
                        AstNodeKind::CallStatement => {
                            if let Some(name) = &node.name {
                                deps.push(DependencyRef {
                                    from_module: module.source_path.clone(),
                                    to_module: name.clone(),
                                    dependency_type: DependencyType::ProgramCall,
                                    source_span: node.span.clone(),
                                    reference_text: format!("call {}", name),
                                });
                            }
                        }
                        _ => {}
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
    };
}

// ─── Helper: span for line i ────────────────────────────────────
fn sp(i: usize, len: usize) -> Span {
    Span { start_line: i, start_col: 0, end_line: i, end_col: len }
}

// ═══════════════════════════════════════════════════════════════════
// VB.NET
// ═══════════════════════════════════════════════════════════════════
impl_parser!(VbNetParser, "vbnet-legacy", "VB.NET (Legacy .NET 1.x-3.5)",
    &["VB.NET-2.0", "VB.NET-3.5"], &["vb"],
    &["Imports System", "Module ", "Class ", "Sub Main", "Inherits System.Windows.Forms"],
    |source: &SourceFile| {
        let mut syms = Vec::new(); let mut nodes = Vec::new(); let mut meta = HashMap::new();
        let mut imports = Vec::new();
        for (i, line) in source.content.lines().enumerate() {
            let t = line.trim(); if t.is_empty() || t.starts_with('\'') { continue; }
            let u = t.to_uppercase(); let s = sp(i, t.len());
            if u.starts_with("IMPORTS ") { imports.push(t[8..].trim().to_string()); }
            if u.starts_with("PUBLIC CLASS ") || u.starts_with("PRIVATE CLASS ") || u.starts_with("CLASS ") {
                let n = u.rsplit("CLASS ").next().unwrap_or("").split_whitespace().next().unwrap_or("");
                syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Custom("Class".to_string()), span: s.clone(), visibility: Visibility::Public, data_type: None, properties: HashMap::new() });
            }
            if (u.contains("SUB ") || u.contains("FUNCTION ")) && !u.starts_with("END ") && !u.starts_with("'") {
                let is_func = u.contains("FUNCTION ");
                let kw = if is_func { "FUNCTION " } else { "SUB " };
                let n = u.split(kw).nth(1).unwrap_or("").split('(').next().unwrap_or("").trim();
                if !n.is_empty() { syms.push(Symbol { name: n.to_string(), kind: if is_func { SymbolKind::Function } else { SymbolKind::Procedure }, span: s.clone(), visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            }
            if u.starts_with("DIM ") && u.contains(" AS ") {
                let n = u.split(" AS ").next().unwrap_or("").split_whitespace().last().unwrap_or("");
                let dt = u.split(" AS ").nth(1).map(|s| s.split_whitespace().next().unwrap_or("").to_string());
                syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Variable, span: s, visibility: Visibility::Internal, data_type: dt, properties: HashMap::new() });
            }
            if u.contains("HANDLES ") { nodes.push(AstNode { id: format!("handler-{i}"), kind: AstNodeKind::Custom("EventHandler".to_string()), name: None, span: s, children: vec![], properties: HashMap::new() }); }
        }
        meta.insert("imports".to_string(), serde_json::json!(imports));
        meta.insert("class_count".to_string(), serde_json::json!(syms.iter().filter(|s| s.kind == SymbolKind::Custom("Class".to_string())).count()));
        meta.insert("method_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Function | SymbolKind::Procedure)).count()));
        meta.insert("variable_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Variable)).count()));
        meta.insert("event_handler_count".to_string(), serde_json::json!(nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("EventHandler".to_string())).count()));
        (nodes, syms, vec![], meta, "VB.NET-3.5")
    }
);

// ═══════════════════════════════════════════════════════════════════
// ASP Classic
// ═══════════════════════════════════════════════════════════════════
impl_parser!(AspClassicParser, "asp-classic", "ASP Classic (VBScript)",
    &["ASP-3.0"], &["asp", "asa"],
    &["<%", "Response.Write", "Request.Form", "Server.CreateObject"],
    |source: &SourceFile| {
        let mut syms = Vec::new(); let mut nodes = Vec::new(); let mut meta = HashMap::new();
        let mut com_refs = Vec::new(); let mut sql_blocks = Vec::new();
        let mut in_code = false;
        for (i, line) in source.content.lines().enumerate() {
            let t = line.trim(); let u = t.to_uppercase(); let s = sp(i, t.len());
            if t.contains("<%") { in_code = true; } if t.contains("%>") { in_code = false; }
            if u.starts_with("FUNCTION ") || u.starts_with("PUBLIC FUNCTION ") {
                let n = u.rsplit("FUNCTION ").next().unwrap_or("").split('(').next().unwrap_or("").trim();
                syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Function, span: s.clone(), visibility: Visibility::Public, data_type: None, properties: HashMap::new() });
            }
            if u.starts_with("SUB ") || u.starts_with("PUBLIC SUB ") {
                let n = u.rsplit("SUB ").next().unwrap_or("").split('(').next().unwrap_or("").trim();
                syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Procedure, span: s.clone(), visibility: Visibility::Public, data_type: None, properties: HashMap::new() });
            }
            if u.contains("CREATEOBJECT(") { if let Some(p) = t.find("CreateObject(\"").or(t.find("createobject(\"")) { let after = &t[p+14..]; if let Some(end) = after.find('"') { com_refs.push(after[..end].to_string()); } } }
            if u.contains("EXECUTE") || u.contains(".EXECUTE") || u.contains("CONN.OPEN") {
                sql_blocks.push(i);
                nodes.push(AstNode { id: format!("sql-{i}"), kind: AstNodeKind::ExecSqlBlock, name: None, span: s.clone(), children: vec![], properties: HashMap::new() });
            }
            if u.contains("SERVER.MAPPATH") || u.contains("REQUEST.FORM") || u.contains("REQUEST.QUERYSTRING") || u.contains("SESSION(") || u.contains("APPLICATION(") {
                nodes.push(AstNode { id: format!("asp-{i}"), kind: AstNodeKind::Custom("ASPIntrinsic".to_string()), name: None, span: s, children: vec![], properties: HashMap::new() });
            }
        }
        meta.insert("function_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()));
        meta.insert("sub_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()));
        meta.insert("com_references".to_string(), serde_json::json!(com_refs));
        meta.insert("sql_statement_count".to_string(), serde_json::json!(sql_blocks.len()));
        (nodes, syms, vec![], meta, "ASP-3.0")
    }
);

// ═══════════════════════════════════════════════════════════════════
// Oracle Forms
// ═══════════════════════════════════════════════════════════════════
impl_parser!(OracleFormsParser, "oracle-forms", "Oracle Forms",
    &["Oracle-Forms-12c", "Oracle-Forms-14c"], &["fmb", "fmx", "pll", "olb"],
    &[],
    |source: &SourceFile| {
        let mut syms = Vec::new(); let mut nodes = Vec::new(); let mut meta = HashMap::new();
        // PLL files are text-based PL/SQL libraries
        for (i, line) in source.content.lines().enumerate() {
            let t = line.trim(); if t.is_empty() || t.starts_with("--") { continue; }
            let u = t.to_uppercase(); let s = sp(i, t.len());
            if u.starts_with("PROCEDURE ") { let n = u[10..].split(|c: char| c == '(' || c.is_whitespace()).next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Procedure, span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if u.starts_with("FUNCTION ") { let n = u[9..].split(|c: char| c == '(' || c.is_whitespace()).next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Function, span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if u.starts_with("PACKAGE ") { let n = u[8..].split_whitespace().next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Custom("Package".to_string()), span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if u.contains("SELECT ") && u.contains(" FROM ") { nodes.push(AstNode { id: format!("sql-{i}"), kind: AstNodeKind::ExecSqlBlock, name: None, span: s, children: vec![], properties: HashMap::new() }); }
        }
        meta.insert("procedure_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()));
        meta.insert("function_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()));
        (nodes, syms, vec![], meta, "Oracle-Forms-14c")
    }
);

// ═══════════════════════════════════════════════════════════════════
// Ada / SPARK
// ═══════════════════════════════════════════════════════════════════
impl_parser!(AdaParser, "ada", "Ada / SPARK",
    &["Ada-95", "Ada-2012", "SPARK-2014"], &["ada", "adb", "ads"],
    &["with ", "procedure ", "package ", "pragma "],
    |source: &SourceFile| {
        let mut syms = Vec::new(); let mut nodes = Vec::new(); let mut meta = HashMap::new();
        let mut withs = Vec::new(); let mut has_spark = false;
        for (i, line) in source.content.lines().enumerate() {
            let t = line.trim(); if t.is_empty() || t.starts_with("--") { continue; }
            let l = t.to_lowercase(); let s = sp(i, t.len());
            if l.starts_with("with ") { let pkg = l[5..].trim_end_matches(';').trim(); withs.push(pkg.to_string()); nodes.push(AstNode { id: format!("with-{i}"), kind: AstNodeKind::CopyStatement, name: Some(pkg.to_string()), span: s, children: vec![], properties: HashMap::new() }); }
            if l.starts_with("procedure ") && !l.starts_with("procedure body") { let n = l[10..].split(|c: char| c == '(' || c == ' ' || c == ';').next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Procedure, span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if l.starts_with("function ") { let n = l[9..].split(|c: char| c == '(' || c == ' ' || c == ';').next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Function, span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if l.starts_with("package ") && !l.starts_with("package body") { let n = l[8..].split_whitespace().next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Custom("Package".to_string()), span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if l.starts_with("task ") { syms.push(Symbol { name: l[5..].split_whitespace().next().unwrap_or("").to_string(), kind: SymbolKind::Custom("Task".to_string()), span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if l.starts_with("protected ") { syms.push(Symbol { name: l[10..].split_whitespace().next().unwrap_or("").to_string(), kind: SymbolKind::Custom("Protected".to_string()), span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if l.starts_with("type ") && l.contains(" is ") { let n = l[5..].split_whitespace().next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Custom("Type".to_string()), span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if l.contains("pragma spark_mode") || l.contains("-- # ") { has_spark = true; }
        }
        meta.insert("with_clauses".to_string(), serde_json::json!(withs));
        meta.insert("has_spark".to_string(), serde_json::json!(has_spark));
        meta.insert("procedure_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()));
        meta.insert("function_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()));
        meta.insert("task_count".to_string(), serde_json::json!(syms.iter().filter(|s| s.kind == SymbolKind::Custom("Task".to_string())).count()));
        meta.insert("type_count".to_string(), serde_json::json!(syms.iter().filter(|s| s.kind == SymbolKind::Custom("Type".to_string())).count()));
        let dialect = if has_spark { "SPARK-2014" } else { "Ada-2012" };
        (nodes, syms, vec![], meta, dialect)
    }
);

// ═══════════════════════════════════════════════════════════════════
// Progress 4GL (OpenEdge)
// ═══════════════════════════════════════════════════════════════════
impl_parser!(Progress4glParser, "progress-4gl", "Progress 4GL (OpenEdge)",
    &["OpenEdge-11", "OpenEdge-12"], &["p", "w", "i", "cls"],
    &["DEFINE VARIABLE", "FOR EACH", "FIND FIRST", "RUN "],
    |source: &SourceFile| {
        let mut syms = Vec::new(); let mut nodes = Vec::new(); let mut meta = HashMap::new();
        let mut temp_tables = Vec::new(); let mut runs = Vec::new();
        for (i, line) in source.content.lines().enumerate() {
            let t = line.trim(); if t.is_empty() || t.starts_with("/*") { continue; }
            let u = t.to_uppercase(); let s = sp(i, t.len());
            if u.starts_with("DEFINE VARIABLE ") { let n = u[16..].split_whitespace().next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Variable, span: s, visibility: Visibility::Internal, data_type: None, properties: HashMap::new() }); }
            if u.starts_with("DEFINE TEMP-TABLE ") { let n = u[18..].split_whitespace().next().unwrap_or(""); temp_tables.push(n.to_string()); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Custom("TempTable".to_string()), span: s, visibility: Visibility::Internal, data_type: None, properties: HashMap::new() }); }
            if u.starts_with("DEFINE BUFFER ") { let n = u[14..].split_whitespace().next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Custom("Buffer".to_string()), span: s, visibility: Visibility::Internal, data_type: None, properties: HashMap::new() }); }
            if u.starts_with("PROCEDURE ") { let n = u[10..].split(':').next().unwrap_or("").trim(); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Procedure, span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if u.starts_with("FUNCTION ") { let n = u[9..].split_whitespace().next().unwrap_or(""); syms.push(Symbol { name: n.to_string(), kind: SymbolKind::Function, span: s, visibility: Visibility::Public, data_type: None, properties: HashMap::new() }); }
            if u.starts_with("RUN ") { let target = u[4..].split_whitespace().next().unwrap_or("").trim_end_matches('.'); runs.push(target.to_string()); nodes.push(AstNode { id: format!("run-{i}"), kind: AstNodeKind::CallStatement, name: Some(target.to_string()), span: s, children: vec![], properties: HashMap::new() }); }
            if u.starts_with("FOR EACH ") || u.starts_with("FIND FIRST ") || u.starts_with("FIND ") { nodes.push(AstNode { id: format!("query-{i}"), kind: AstNodeKind::ReadStatement, name: None, span: s, children: vec![], properties: HashMap::new() }); }
            if u.starts_with("{") && u.contains("}") { let inc = u.trim_matches(|c: char| c == '{' || c == '}').split_whitespace().next().unwrap_or(""); nodes.push(AstNode { id: format!("inc-{i}"), kind: AstNodeKind::CopyStatement, name: Some(inc.to_string()), span: s, children: vec![], properties: HashMap::new() }); }
        }
        meta.insert("temp_tables".to_string(), serde_json::json!(temp_tables));
        meta.insert("run_targets".to_string(), serde_json::json!(runs));
        meta.insert("procedure_count".to_string(), serde_json::json!(syms.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()));
        meta.insert("query_count".to_string(), serde_json::json!(nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::ReadStatement)).count()));
        (nodes, syms, vec![], meta, "OpenEdge-12")
    }
);

// ═══════════════════════════════════════════════════════════════════
// Remaining languages with focused extraction
// ═══════════════════════════════════════════════════════════════════

macro_rules! focused_parser {
    ($name:ident, $id:expr, $display:expr, $dialects:expr, $exts:expr, $headers:expr, $rules:expr, $dialect_val:expr) => {
        impl_parser!($name, $id, $display, $dialects, $exts, $headers,
            |source: &SourceFile| {
                let rules: &[(&str, SymbolKind, &str)] = $rules;
                let mut syms = Vec::new(); let mut nodes = Vec::new(); let mut meta = HashMap::new();
                let mut counters: HashMap<String, usize> = HashMap::new();
                for (i, line) in source.content.lines().enumerate() {
                    let t = line.trim(); if t.is_empty() { continue; }
                    let u = t.to_uppercase(); let s = sp(i, t.len());
                    for (kw, kind, key) in rules {
                        if u.starts_with(&kw.to_uppercase()) {
                            let rest = &u[kw.len()..];
                            let name = rest.split(|c: char| c == '(' || c == ';' || c == ':' || c == '{' || c.is_whitespace()).next().unwrap_or("").trim().to_string();
                            if !name.is_empty() && name.len() < 80 {
                                syms.push(Symbol { name, kind: kind.clone(), span: s.clone(), visibility: Visibility::Public, data_type: None, properties: HashMap::new() });
                            }
                            *counters.entry(key.to_string()).or_insert(0) += 1;
                            break;
                        }
                    }
                }
                for (k, v) in &counters { meta.insert(k.clone(), serde_json::json!(v)); }
                meta.insert("symbol_count".to_string(), serde_json::json!(syms.len()));
                (nodes, syms, vec![], meta, $dialect_val)
            }
        );
    };
}

focused_parser!(VisualFoxProParser, "visual-foxpro", "Visual FoxPro", &["VFP-9"], &["prg", "scx", "sct", "vcx", "frx"],
    &["LOCAL ", "SELECT ", "SCAN", "DO WHILE", "THISFORM"],
    &[("PROCEDURE ", SymbolKind::Procedure, "procedure_count"), ("FUNCTION ", SymbolKind::Function, "function_count"),
      ("DEFINE CLASS ", SymbolKind::Custom("Class".to_string()), "class_count"), ("LOCAL ", SymbolKind::Variable, "variable_count"),
      ("PUBLIC ", SymbolKind::Variable, "public_count"), ("DO ", SymbolKind::Custom("Do".to_string()), "do_count"),
      ("SELECT ", SymbolKind::Custom("Select".to_string()), "select_count"), ("USE ", SymbolKind::Custom("Use".to_string()), "use_count")],
    "VFP-9"
);

focused_parser!(SmalltalkParser, "smalltalk", "Smalltalk", &["Pharo", "Cincom-VisualWorks", "VA-Smalltalk"], &["st", "cs"],
    &["subclass:", "instanceVariableNames:", "methodsFor:"],
    &[("subclass:", SymbolKind::Custom("Class".to_string()), "class_count"),
      ("methodsFor:", SymbolKind::Custom("MethodCategory".to_string()), "method_category_count"),
      ("instanceVariableNames:", SymbolKind::Custom("InstanceVars".to_string()), "instance_var_decl_count")],
    "Pharo"
);

focused_parser!(CaGenParser, "ca-gen", "CA Gen / CA Telon", &["CA-Gen-8", "CA-Telon"], &[],
    &[],
    &[("GENERATED BY ", SymbolKind::Custom("Generated".to_string()), "generated_markers"),
      ("PERFORM ", SymbolKind::Custom("Perform".to_string()), "perform_count"),
      ("CALL ", SymbolKind::Custom("Call".to_string()), "call_count")],
    "CA-Gen-8"
);

focused_parser!(ClipperParser, "clipper", "Clipper / dBase", &["Clipper-5.3", "Harbour"], &["prg", "ch"],
    &["LOCAL ", "FUNCTION ", "RETURN", "@ "],
    &[("FUNCTION ", SymbolKind::Function, "function_count"), ("PROCEDURE ", SymbolKind::Procedure, "procedure_count"),
      ("LOCAL ", SymbolKind::Variable, "variable_count"), ("STATIC ", SymbolKind::Variable, "static_count"),
      ("USE ", SymbolKind::Custom("Use".to_string()), "use_count"), ("INDEX ON ", SymbolKind::Custom("Index".to_string()), "index_count"),
      ("@ ", SymbolKind::Custom("SAY".to_string()), "say_count"), ("REPLACE ", SymbolKind::Custom("Replace".to_string()), "replace_count")],
    "Harbour"
);

focused_parser!(SilverlightParser, "silverlight", "Silverlight", &["Silverlight-5"], &["xaml"],
    &["xmlns:sdk=", "Silverlight"],
    &[("x:Class=", SymbolKind::Custom("Class".to_string()), "class_count"),
      ("<UserControl ", SymbolKind::Custom("UserControl".to_string()), "control_count"),
      ("<Page ", SymbolKind::Custom("Page".to_string()), "page_count"),
      ("<Grid ", SymbolKind::Custom("Grid".to_string()), "grid_count"),
      ("<Button ", SymbolKind::Custom("Button".to_string()), "button_count")],
    "Silverlight-5"
);

focused_parser!(AssemblerParser, "assembler-zos", "Assembler (z/OS, IBM i)", &["HLASM", "ILE-ASM"], &["asm", "s", "mac"],
    &["CSECT", "USING ", "BALR ", "MVC "],
    &[("CSECT", SymbolKind::Custom("CSECT".to_string()), "csect_count"),
      ("DSECT", SymbolKind::Custom("DSECT".to_string()), "dsect_count"),
      ("MACRO", SymbolKind::Custom("Macro".to_string()), "macro_count"),
      ("ENTRY ", SymbolKind::Custom("Entry".to_string()), "entry_count"),
      ("USING ", SymbolKind::Custom("Using".to_string()), "using_count"),
      ("DC ", SymbolKind::Constant, "constant_count"),
      ("DS ", SymbolKind::Variable, "storage_count")],
    "HLASM"
);

focused_parser!(PerlParser, "perl", "Perl", &["Perl-5"], &["pl", "pm", "t", "cgi"],
    &["#!/usr/bin/perl", "use strict", "my $"],
    &[("sub ", SymbolKind::Function, "sub_count"), ("package ", SymbolKind::Custom("Package".to_string()), "package_count"),
      ("use ", SymbolKind::Custom("Use".to_string()), "use_count"), ("require ", SymbolKind::Custom("Require".to_string()), "require_count"),
      ("my ", SymbolKind::Variable, "my_count"), ("our ", SymbolKind::Variable, "our_count")],
    "Perl-5"
);

focused_parser!(RexxParser, "rexx", "REXX / NetREXX", &["REXX", "NetREXX"], &["rexx", "rex", "exec"],
    &["/* REXX */", "SAY ", "PARSE "],
    &[("CALL ", SymbolKind::Custom("Call".to_string()), "call_count"),
      ("PARSE ", SymbolKind::Custom("Parse".to_string()), "parse_count"),
      ("SAY ", SymbolKind::Custom("Say".to_string()), "say_count"),
      ("SIGNAL ", SymbolKind::Custom("Signal".to_string()), "signal_count"),
      ("DO ", SymbolKind::Custom("Do".to_string()), "do_count")],
    "REXX"
);

focused_parser!(LotusScriptParser, "lotusscript", "LotusScript (HCL Domino)", &["LotusScript-6"], &["lss", "lsa"],
    &["Sub ", "Dim ", "NotesDocument"],
    &[("Sub ", SymbolKind::Procedure, "sub_count"), ("Function ", SymbolKind::Function, "function_count"),
      ("Class ", SymbolKind::Custom("Class".to_string()), "class_count"), ("Dim ", SymbolKind::Variable, "variable_count"),
      ("Set ", SymbolKind::Custom("Set".to_string()), "set_count"), ("Property ", SymbolKind::Custom("Property".to_string()), "property_count")],
    "LotusScript-6"
);

focused_parser!(ColdFusionParser, "coldfusion", "ColdFusion", &["CF-2021", "CF-2025"], &["cfm", "cfc", "cfml"],
    &["<cfquery", "<cfoutput", "component {", "<cfset"],
    &[("<cffunction", SymbolKind::Function, "function_count"),
      ("<cfquery", SymbolKind::Custom("Query".to_string()), "query_count"),
      ("<cfcomponent", SymbolKind::Custom("Component".to_string()), "component_count"),
      ("component ", SymbolKind::Custom("Component".to_string()), "component_count"),
      ("<cfinvoke", SymbolKind::Custom("Invoke".to_string()), "invoke_count"),
      ("<cfinclude", SymbolKind::Custom("Include".to_string()), "include_count"),
      ("function ", SymbolKind::Function, "script_function_count")],
    "CF-2025"
);

focused_parser!(TsqlParser, "tsql", "T-SQL (SQL Server)", &["SQL-Server-2019", "SQL-Server-2022"], &["sql"],
    &["CREATE PROCEDURE", "CREATE FUNCTION", "DECLARE @", "SET @", "BEGIN TRANSACTION"],
    &[("CREATE PROCEDURE ", SymbolKind::Procedure, "procedure_count"), ("CREATE FUNCTION ", SymbolKind::Function, "function_count"),
      ("CREATE TRIGGER ", SymbolKind::Custom("Trigger".to_string()), "trigger_count"), ("CREATE VIEW ", SymbolKind::Custom("View".to_string()), "view_count"),
      ("EXEC ", SymbolKind::Custom("Exec".to_string()), "exec_count"), ("DECLARE ", SymbolKind::Variable, "declare_count"),
      ("BEGIN TRY", SymbolKind::Custom("TryCatch".to_string()), "try_catch_count")],
    "SQL-Server-2022"
);

focused_parser!(Db2SqlParser, "db2sql", "DB2 SQL (IBM)", &["DB2-for-i", "DB2-for-zOS"], &["sql", "sqb"],
    &["EXEC SQL", "CREATE PROCEDURE", "CREATE FUNCTION"],
    &[("CREATE PROCEDURE ", SymbolKind::Procedure, "procedure_count"), ("CREATE FUNCTION ", SymbolKind::Function, "function_count"),
      ("CREATE TRIGGER ", SymbolKind::Custom("Trigger".to_string()), "trigger_count"),
      ("DECLARE ", SymbolKind::Variable, "declare_count"),
      ("EXEC SQL", SymbolKind::Custom("ExecSql".to_string()), "exec_sql_count")],
    "DB2-for-zOS"
);
