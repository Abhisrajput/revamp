//! PHP parser — Tier 2.
//!
//! Handles PHP source files (.php, .php3, .php5, .php7, .php8, .phtml).
//! Key challenges: dynamic typing, superglobal access patterns, raw SQL
//! injection risks, magic methods, trait composition, mixed HTML/PHP,
//! and dialect detection across PHP 5.6 through 8.3 (enums, readonly,
//! match expressions, attributes, named arguments, union types).

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct PhpParser;

impl PhpParser {
    pub fn new() -> Self { Self }
}

impl LanguageParser for PhpParser {
    fn language_id(&self) -> &'static str { "php" }
    fn display_name(&self) -> &'static str { "PHP" }
    fn supported_dialects(&self) -> &[&'static str] {
        &["PHP-5.6", "PHP-7.0", "PHP-7.4", "PHP-8.0", "PHP-8.1", "PHP-8.2", "PHP-8.3"]
    }
    fn file_extensions(&self) -> &[&'static str] {
        &["php", "php3", "php5", "php7", "php8", "phtml"]
    }

    fn nir_coverage_pct(&self) -> f64 { 0.65 }
    fn recommended_backend(&self) -> &'static str { "tree-sitter (PHP) + custom" }
    fn estimated_dev_effort(&self) -> &'static str { "2-3 weeks to production" }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let lower = file.header.to_lowercase();
        let content_match = lower.contains("<?php")
            || lower.contains("$_get")
            || lower.contains("$_post")
            || lower.contains("function ")
            || lower.contains("class ")
            || lower.contains("namespace ");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let mut ast_nodes = Vec::new();
        let mut uses: Vec<String> = Vec::new();
        let mut superglobals_used: Vec<String> = Vec::new();
        let mut detected_namespace = String::new();
        let mut include_count: usize = 0;
        let mut magic_method_count: usize = 0;
        let mut raw_sql_count: usize = 0;
        let mut has_enum = false;
        let mut has_readonly = false;
        let mut has_match = false;
        let mut has_named_args = false;
        let mut has_attributes = false;
        let mut has_type_hints = false;
        let mut has_null_coalescing = false;
        let mut node_counter: usize = 0;

        let magic_methods = [
            "__construct", "__destruct", "__call", "__callstatic",
            "__get", "__set", "__isset", "__unset", "__sleep",
            "__wakeup", "__serialize", "__unserialize", "__tostring",
            "__invoke", "__set_state", "__clone", "__debuginfo",
        ];

        let superglobal_names = [
            "$_GET", "$_POST", "$_SESSION", "$_COOKIE", "$_REQUEST",
            "$_SERVER", "$_FILES", "$_ENV", "$GLOBALS",
        ];

        let sql_keywords = [
            "mysql_query", "mysqli_query", "pg_query", "->query(",
            "->exec(", "->execute(", "->prepare(",
        ];

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            // Skip single-line comments (but not lines that contain code + comment)
            if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with('*') {
                continue;
            }
            let lower = trimmed.to_lowercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // ── Namespace ──────────────────────────────────────────
            if lower.starts_with("namespace ") {
                let name = trimmed["namespace ".len()..].trim_end_matches(';').trim();
                detected_namespace = name.to_string();
                symbols.push(Symbol {
                    name: name.to_string(),
                    kind: SymbolKind::Custom("Namespace".to_string()),
                    span,
                    visibility: Visibility::Public,
                    data_type: None,
                    properties: HashMap::new(),
                });
            }

            // ── Use statements ─────────────────────────────────────
            if lower.starts_with("use ") && !lower.starts_with("use (") {
                let raw = trimmed["use ".len()..].trim_end_matches(';').trim();
                // Handle grouped use: use App\{Foo, Bar};
                if raw.contains('{') && raw.contains('}') {
                    let prefix = raw.split('{').next().unwrap_or("").trim_end_matches('\\');
                    let group = raw.split('{').nth(1).unwrap_or("").trim_end_matches('}');
                    for part in group.split(',') {
                        let full = format!("{}\\{}", prefix, part.trim());
                        uses.push(full);
                    }
                } else {
                    // May contain alias: use Foo\Bar as Baz;
                    let import = raw.split(" as ").next().unwrap_or(raw).trim();
                    uses.push(import.to_string());
                }
            }

            // ── Class declaration ──────────────────────────────────
            if let Some(class_name) = extract_class_name(&lower, trimmed) {
                let parent = if lower.contains(" extends ") {
                    lower.split(" extends ").nth(1)
                        .and_then(|s| s.split_whitespace().next())
                        .map(|s| s.trim_end_matches('{').to_string())
                } else { None };
                let mut props = HashMap::new();
                if let Some(ref p) = parent {
                    props.insert("parent".to_string(), serde_json::json!(p));
                }
                if lower.contains(" implements ") {
                    let ifaces = lower.split(" implements ").nth(1)
                        .unwrap_or("").trim_end_matches('{').trim();
                    props.insert("implements".to_string(), serde_json::json!(ifaces));
                }
                if lower.starts_with("abstract ") {
                    props.insert("abstract".to_string(), serde_json::json!(true));
                }
                if lower.starts_with("final ") {
                    props.insert("final".to_string(), serde_json::json!(true));
                }
                symbols.push(Symbol {
                    name: class_name,
                    kind: SymbolKind::Custom("Class".to_string()),
                    span,
                    visibility: Visibility::Public,
                    data_type: parent,
                    properties: props,
                });
            }

            // ── Interface declaration ──────────────────────────────
            if lower.starts_with("interface ") || lower.contains(" interface ") {
                // Avoid matching 'use' or 'implements' lines
                if !lower.starts_with("use ") && !lower.contains("implements") {
                    if let Some(name) = extract_keyword_name(&lower, "interface") {
                        symbols.push(Symbol {
                            name,
                            kind: SymbolKind::Custom("Interface".to_string()),
                            span,
                            visibility: Visibility::Public,
                            data_type: None,
                            properties: HashMap::new(),
                        });
                    }
                }
            }

            // ── Trait declaration ───────────────────────────────────
            if lower.starts_with("trait ") {
                let name = lower["trait ".len()..].split_whitespace().next()
                    .unwrap_or("").trim_end_matches('{').to_string();
                if !name.is_empty() {
                    symbols.push(Symbol {
                        name,
                        kind: SymbolKind::Custom("Trait".to_string()),
                        span,
                        visibility: Visibility::Public,
                        data_type: None,
                        properties: HashMap::new(),
                    });
                }
            }

            // ── Enum declaration (PHP 8.1+) ────────────────────────
            if lower.starts_with("enum ") {
                has_enum = true;
                let rest = trimmed["enum ".len()..].trim();
                let name = rest.split(|c: char| c == ':' || c == '{' || c == ' ')
                    .next().unwrap_or("").trim().to_string();
                let backed_type = if rest.contains(':') {
                    rest.split(':').nth(1)
                        .and_then(|s| s.split_whitespace().next())
                        .map(|s| s.trim_end_matches('{').trim().to_string())
                } else { None };
                if !name.is_empty() {
                    symbols.push(Symbol {
                        name,
                        kind: SymbolKind::Custom("Enum".to_string()),
                        span,
                        visibility: Visibility::Public,
                        data_type: backed_type,
                        properties: HashMap::new(),
                    });
                }
            }

            // ── Function / Method declarations ─────────────────────
            if lower.contains("function ") {
                // Extract function/method name
                if let Some(fname) = extract_function_name(&lower) {
                    let vis = if lower.contains("private") {
                        Visibility::Private
                    } else if lower.contains("protected") {
                        Visibility::Internal
                    } else {
                        Visibility::Public
                    };

                    // Check for magic method
                    let fname_lower = fname.to_lowercase();
                    if magic_methods.contains(&fname_lower.as_str()) {
                        magic_method_count += 1;
                    }

                    let mut props = HashMap::new();
                    if lower.contains("static") {
                        props.insert("static".to_string(), serde_json::json!(true));
                    }
                    if lower.contains("abstract") {
                        props.insert("abstract".to_string(), serde_json::json!(true));
                    }

                    symbols.push(Symbol {
                        name: fname,
                        kind: SymbolKind::Function,
                        span,
                        visibility: vis,
                        data_type: None,
                        properties: props,
                    });
                }
            }

            // ── Superglobal access ─────────────────────────────────
            for sg in &superglobal_names {
                if trimmed.contains(sg) {
                    let sg_str = sg.to_string();
                    if !superglobals_used.contains(&sg_str) {
                        superglobals_used.push(sg_str.clone());
                    }
                    node_counter += 1;
                    ast_nodes.push(AstNode {
                        id: format!("php-superglobal-{}", node_counter),
                        kind: AstNodeKind::Custom("SuperglobalAccess".to_string()),
                        name: Some(sg_str),
                        span,
                        children: vec![],
                        properties: HashMap::new(),
                    });
                }
            }

            // ── Include / Require ──────────────────────────────────
            if lower.starts_with("include ") || lower.starts_with("include_once ")
                || lower.starts_with("require ") || lower.starts_with("require_once ")
            {
                include_count += 1;
                let file_ref = trimmed.split(|c: char| c == '\'' || c == '"')
                    .nth(1).unwrap_or("unknown").to_string();
                node_counter += 1;
                ast_nodes.push(AstNode {
                    id: format!("php-include-{}", node_counter),
                    kind: AstNodeKind::CopyStatement,
                    name: Some(file_ref),
                    span,
                    children: vec![],
                    properties: HashMap::new(),
                });
            }

            // ── Raw SQL detection ──────────────────────────────────
            for kw in &sql_keywords {
                if lower.contains(&kw.to_lowercase()) {
                    raw_sql_count += 1;
                    node_counter += 1;
                    ast_nodes.push(AstNode {
                        id: format!("php-sql-{}", node_counter),
                        kind: AstNodeKind::ExecSqlBlock,
                        name: Some(kw.to_string()),
                        span,
                        children: vec![],
                        properties: HashMap::new(),
                    });
                    break; // count once per line
                }
            }

            // ── Control flow statements ────────────────────────────
            if lower.starts_with("if ") || lower.starts_with("if(")
                || lower.starts_with("} elseif") || lower.starts_with("elseif")
                || lower.starts_with("} else if") || lower.starts_with("else if")
            {
                node_counter += 1;
                ast_nodes.push(AstNode {
                    id: format!("php-if-{}", node_counter),
                    kind: AstNodeKind::IfStatement,
                    name: None,
                    span,
                    children: vec![],
                    properties: HashMap::new(),
                });
            }
            if lower.starts_with("switch ") || lower.starts_with("switch(")
                || lower.starts_with("match(") || lower.starts_with("match (")
            {
                node_counter += 1;
                ast_nodes.push(AstNode {
                    id: format!("php-switch-{}", node_counter),
                    kind: AstNodeKind::EvaluateStatement,
                    name: None,
                    span,
                    children: vec![],
                    properties: HashMap::new(),
                });
            }
            if lower.starts_with("foreach ") || lower.starts_with("foreach(")
                || lower.starts_with("for ") || lower.starts_with("for(")
                || lower.starts_with("while ") || lower.starts_with("while(")
                || lower.starts_with("do {") || lower.starts_with("do{")
            {
                node_counter += 1;
                ast_nodes.push(AstNode {
                    id: format!("php-loop-{}", node_counter),
                    kind: AstNodeKind::Loop,
                    name: None,
                    span,
                    children: vec![],
                    properties: HashMap::new(),
                });
            }

            // ── Function / method calls ───────────────────────────────
            // Detect $obj->method(...) or ClassName::method(...) or func(...)
            // but skip declarations (already captured above)
            if !lower.contains("function ") {
                let has_arrow_call = trimmed.contains("->") && trimmed.contains('(');
                let has_static_call = trimmed.contains("::") && trimmed.contains('(')
                    && !lower.starts_with("use ");
                let has_bare_call = {
                    // Simple heuristic: word followed by ( that isn't a keyword
                    let keywords = ["if", "elseif", "else", "for", "foreach", "while",
                        "switch", "match", "catch", "class", "interface", "trait", "enum",
                        "return", "echo", "print", "array", "list", "new"];
                    let first_word = lower.split(|c: char| c == '(' || c.is_whitespace())
                        .next().unwrap_or("").trim_start_matches('$');
                    trimmed.contains('(') && !keywords.contains(&first_word)
                        && !first_word.is_empty() && first_word.chars().next().map_or(false, |c| c.is_alphabetic())
                };
                if has_arrow_call || has_static_call || has_bare_call {
                    // Extract call target name
                    let call_name = if has_arrow_call {
                        trimmed.split("->").nth(1)
                            .and_then(|s| s.split('(').next())
                            .unwrap_or("unknown").to_string()
                    } else if has_static_call {
                        trimmed.split("::").nth(1)
                            .and_then(|s| s.split('(').next())
                            .unwrap_or("unknown").to_string()
                    } else {
                        lower.split('(').next().unwrap_or("unknown").trim().to_string()
                    };
                    if !call_name.is_empty() && call_name.len() < 80 {
                        node_counter += 1;
                        ast_nodes.push(AstNode {
                            id: format!("php-call-{}", node_counter),
                            kind: AstNodeKind::CallStatement,
                            name: Some(call_name),
                            span,
                            children: vec![],
                            properties: HashMap::new(),
                        });
                    }
                }
            }

            // ── Assignments (variable writes) ─────────────────────────
            if trimmed.contains(" = ") && !trimmed.contains("==") && !trimmed.contains("!=")
                && !lower.starts_with("if") && !lower.starts_with("while")
                && !lower.starts_with("for") && !lower.starts_with("return")
            {
                if let Some(var) = trimmed.split(" = ").next() {
                    let var_name = var.trim().to_string();
                    if var_name.starts_with('$') && var_name.len() < 80 {
                        node_counter += 1;
                        ast_nodes.push(AstNode {
                            id: format!("php-assign-{}", node_counter),
                            kind: AstNodeKind::Assignment,
                            name: Some(var_name),
                            span,
                            children: vec![],
                            properties: HashMap::new(),
                        });
                    }
                }
            }

            // ── Dialect feature detection ──────────────────────────
            if lower.contains("readonly ") { has_readonly = true; }
            if lower.contains("match(") || lower.contains("match (") { has_match = true; }
            if lower.contains("#[") { has_attributes = true; }
            if lower.contains(": int") || lower.contains(": string") || lower.contains(": float")
                || lower.contains(": bool") || lower.contains(": array")
                || lower.contains("?int") || lower.contains("?string")
            {
                has_type_hints = true;
            }
            if lower.contains("??") || lower.contains("??=") { has_null_coalescing = true; }
            // Named arguments: fn(name: value) — approximate check
            if lower.contains(": ") && lower.contains('(') && lower.contains(')') {
                // Heuristic: word followed by colon inside function call
                let parens_content = lower.split('(').nth(1).unwrap_or("");
                if parens_content.contains(": ") && !parens_content.starts_with("//") {
                    has_named_args = true;
                }
            }
        }

        // ── Dialect detection ──────────────────────────────────────
        let dialect = if has_enum || has_readonly {
            "PHP-8.1"
        } else if has_match || has_named_args || has_attributes {
            "PHP-8.0"
        } else if has_type_hints || has_null_coalescing {
            "PHP-7.0"
        } else {
            "PHP-5.6"
        };

        // ── Metadata ───────────────────────────────────────────────
        let mut metadata = HashMap::new();
        metadata.insert("namespace".to_string(), serde_json::json!(detected_namespace));
        metadata.insert("uses".to_string(), serde_json::json!(uses));
        metadata.insert("superglobals_used".to_string(), serde_json::json!(superglobals_used));
        metadata.insert("class_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Class".to_string())).count()
        ));
        metadata.insert("interface_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Interface".to_string())).count()
        ));
        metadata.insert("trait_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Trait".to_string())).count()
        ));
        metadata.insert("function_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));
        metadata.insert("include_count".to_string(), serde_json::json!(include_count));
        metadata.insert("magic_method_count".to_string(), serde_json::json!(magic_method_count));
        metadata.insert("raw_sql_count".to_string(), serde_json::json!(raw_sql_count));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: dialect.to_string(),
            source_path: source.path.to_string_lossy().to_string(),
            total_lines: source.content.lines().count(),
            ast_nodes,
            symbols,
            embedded_blocks: vec![],
            diagnostics: vec![],
            metadata,
        })
    }

    fn parse_partial(&self, source: &SourceFile) -> anyhow::Result<PartialParseOutput> {
        let output = self.parse(source)?;
        let total = output.total_lines;
        Ok(PartialParseOutput { output, parsed_up_to_line: total, error: String::new(), coverage: 1.0 })
    }

    fn resolve_dependencies(&self, module: &ParseOutput, _vault: &SourceVault) -> Vec<DependencyRef> {
        let mut deps = Vec::new();

        // Dependencies from `use` statements
        if let Some(uses) = module.metadata.get("uses") {
            if let Some(arr) = uses.as_array() {
                for u in arr {
                    if let Some(name) = u.as_str() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.to_string(),
                            dependency_type: DependencyType::CopyInclude,
                            source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                            reference_text: format!("use {}", name),
                        });
                    }
                }
            }
        }

        // Dependencies from include/require AST nodes
        for node in &module.ast_nodes {
            if node.kind == AstNodeKind::CopyStatement {
                if let Some(ref file_ref) = node.name {
                    deps.push(DependencyRef {
                        from_module: module.source_path.clone(),
                        to_module: file_ref.clone(),
                        dependency_type: DependencyType::CopyInclude,
                        source_span: node.span,
                        reference_text: format!("include/require {}", file_ref),
                    });
                }
            }
        }

        deps
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut business_rules = Vec::new();
        let mut data_flows = Vec::new();
        let mut rule_counter: usize = 0;

        // ── Classes and functions → entry point nodes ─────────────
        let mut prev_func: Option<String> = None;
        for symbol in &output.symbols {
            match &symbol.kind {
                SymbolKind::Function => {
                    let node_id = format!("func-{}", symbol.name);
                    nodes.push(AnalysisNode {
                        id: node_id.clone(),
                        kind: AnalysisNodeKind::EntryPoint,
                        name: symbol.name.clone(),
                        source_span: symbol.span,
                        properties: symbol.properties.clone(),
                    });
                    prev_func = Some(node_id);
                }
                SymbolKind::Custom(ref k) if k == "Class" || k == "Interface" || k == "Trait" => {
                    let node_id = format!("class-{}", symbol.name);
                    nodes.push(AnalysisNode {
                        id: node_id.clone(),
                        kind: AnalysisNodeKind::EntryPoint,
                        name: format!("{} {}", k, symbol.name),
                        source_span: symbol.span,
                        properties: symbol.properties.clone(),
                    });
                    // Class extends → dependency edge
                    if let Some(parent) = &symbol.data_type {
                        edges.push(AnalysisEdge {
                            from: node_id.clone(),
                            to: format!("class-{}", parent),
                            kind: AnalysisEdgeKind::Dependency,
                            label: Some("extends".to_string()),
                        });
                    }
                }
                _ => {}
            }
        }

        // ── AST nodes → control flow, calls, DB ops, rules ───────
        for node in &output.ast_nodes {
            match &node.kind {
                AstNodeKind::IfStatement | AstNodeKind::EvaluateStatement => {
                    let nid = format!("cf-{}", node.id);
                    nodes.push(AnalysisNode {
                        id: nid.clone(),
                        kind: AnalysisNodeKind::ControlFlow,
                        name: format!("decision at line {}", node.span.start_line + 1),
                        source_span: node.span,
                        properties: HashMap::new(),
                    });
                    if let Some(ref f) = prev_func {
                        edges.push(AnalysisEdge {
                            from: f.clone(), to: nid,
                            kind: AnalysisEdgeKind::ControlFlow,
                            label: None,
                        });
                    }
                    // Business rule: each conditional is a potential validation/workflow rule
                    rule_counter += 1;
                    business_rules.push(BusinessRule {
                        id: format!("rule-{}", rule_counter),
                        description: format!("Conditional logic at line {}", node.span.start_line + 1),
                        rule_type: BusinessRuleType::Validation,
                        source_span: node.span,
                        confidence: 0.5,
                    });
                }
                AstNodeKind::CallStatement => {
                    let target = node.name.as_deref().unwrap_or("unknown");
                    let nid = format!("call-{}", node.id);
                    nodes.push(AnalysisNode {
                        id: nid.clone(),
                        kind: AnalysisNodeKind::ExternalCall,
                        name: format!("call {}", target),
                        source_span: node.span,
                        properties: HashMap::new(),
                    });
                    if let Some(ref f) = prev_func {
                        edges.push(AnalysisEdge {
                            from: f.clone(), to: nid,
                            kind: AnalysisEdgeKind::CallsInto,
                            label: Some(target.to_string()),
                        });
                    }
                }
                AstNodeKind::ExecSqlBlock => {
                    let nid = format!("db-{}", node.id);
                    nodes.push(AnalysisNode {
                        id: nid.clone(),
                        kind: AnalysisNodeKind::DatabaseOperation,
                        name: format!("SQL at line {}", node.span.start_line + 1),
                        source_span: node.span,
                        properties: HashMap::new(),
                    });
                    if let Some(ref f) = prev_func {
                        edges.push(AnalysisEdge {
                            from: f.clone(), to: nid.clone(),
                            kind: AnalysisEdgeKind::WritesTo,
                            label: Some("SQL".to_string()),
                        });
                    }
                    // SQL access → data flow
                    data_flows.push(DataFlow {
                        id: nid,
                        description: format!("Database access at line {}", node.span.start_line + 1),
                        source_node: prev_func.clone().unwrap_or_default(),
                        sink_node: "database".to_string(),
                        transformations: vec!["SQL query".to_string()],
                    });
                }
                AstNodeKind::Custom(ref k) if k == "SuperglobalAccess" => {
                    let sg = node.name.as_deref().unwrap_or("unknown");
                    let nid = format!("sg-{}", node.id);
                    nodes.push(AnalysisNode {
                        id: nid.clone(),
                        kind: AnalysisNodeKind::UIInteraction,
                        name: format!("{} access", sg),
                        source_span: node.span,
                        properties: HashMap::new(),
                    });
                    // Superglobal access → data flow from external input
                    data_flows.push(DataFlow {
                        id: nid,
                        description: format!("{} read at line {}", sg, node.span.start_line + 1),
                        source_node: sg.to_string(),
                        sink_node: prev_func.clone().unwrap_or_default(),
                        transformations: vec![],
                    });
                }
                AstNodeKind::Assignment => {
                    let var = node.name.as_deref().unwrap_or("unknown");
                    data_flows.push(DataFlow {
                        id: node.id.clone(),
                        description: format!("{} assigned at line {}", var, node.span.start_line + 1),
                        source_node: prev_func.clone().unwrap_or_default(),
                        sink_node: var.to_string(),
                        transformations: vec![],
                    });
                }
                _ => {}
            }
        }

        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes, edges, business_rules, data_flows,
        })
    }
}

// ─── Helper Functions ──────────────────────────────────────────────

/// Extract a class name from a line that contains a class declaration.
/// Returns None if the line is not a class declaration.
fn extract_class_name(lower: &str, original: &str) -> Option<String> {
    // Match patterns: "class Foo", "abstract class Foo", "final class Foo"
    let class_pos = lower.find("class ")?;

    // Make sure "class" is preceded by start-of-line or a keyword (abstract/final)
    let before = lower[..class_pos].trim();
    if !before.is_empty() && before != "abstract" && before != "final" {
        return None;
    }

    let after = original[class_pos + "class ".len()..].trim();
    let name = after.split(|c: char| c.is_whitespace() || c == '{' || c == ':')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();

    if name.is_empty() { None } else { Some(name) }
}

/// Extract a keyword-declared name (interface, trait, etc.)
fn extract_keyword_name(lower: &str, keyword: &str) -> Option<String> {
    let pattern = format!("{} ", keyword);
    let pos = lower.find(&pattern)?;
    let after = lower[pos + pattern.len()..].trim();
    let name = after.split(|c: char| c.is_whitespace() || c == '{' || c == ':')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Extract a function/method name from a line containing "function".
fn extract_function_name(lower: &str) -> Option<String> {
    let pos = lower.find("function ")?;
    let after = lower[pos + "function ".len()..].trim();
    // Skip anonymous functions: function () or function (
    if after.starts_with('(') { return None; }
    let name = after.split(|c: char| c == '(' || c == ' ' || c == ':')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() { None } else { Some(name) }
}
