//! C# (.NET) parser — Tier 2.
//!
//! Handles C# source files (.cs) across multiple language versions (7.0 through 12.0).
//! Key features: namespace/class/interface/struct/enum extraction, method and property
//! detection, attribute parsing, LINQ query recognition, Entity Framework Core patterns,
//! dependency injection patterns, async/await detection, and dialect inference from
//! syntax features (nullable references, records, pattern matching, init accessors).

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct CsharpParser;

impl CsharpParser {
    pub fn new() -> Self { Self }

    /// Detect C# dialect version from syntax features present in source.
    fn detect_dialect(content: &str) -> &'static str {
        let has_file_scoped_namespace = content.contains("namespace ") && {
            content.lines().any(|l| {
                let t = l.trim();
                t.starts_with("namespace ") && t.ends_with(';') && !t.contains('{')
            })
        };
        let has_raw_string_literal = content.contains("\"\"\"");
        let has_required = content.contains("required ");
        let has_record = content.contains("record ");
        let has_init = content.contains("{ get; init; }") || content.contains("{ init; }");
        let has_pattern_matching = content.contains(" is ") && content.contains(" and ")
            || content.contains(" is ") && content.contains(" or ");
        let has_nullable_enable = content.contains("#nullable enable");
        let has_default_interface = content.contains("interface ") && content.contains("=> ");
        let has_switch_expr = content.contains("switch\n") || content.contains("switch {")
            || content.contains("=> ");

        if has_raw_string_literal || has_required {
            "C#-12.0"
        } else if has_file_scoped_namespace {
            "C#-10.0"
        } else if has_record || has_init {
            "C#-9.0"
        } else if has_nullable_enable || has_default_interface || has_switch_expr {
            "C#-8.0"
        } else if has_pattern_matching {
            "C#-7.0"
        } else {
            "C#-7.0"
        }
    }

    /// Extract visibility from a trimmed line prefix.
    fn extract_visibility(trimmed: &str) -> Visibility {
        if trimmed.starts_with("public ") {
            Visibility::Public
        } else if trimmed.starts_with("private ") {
            Visibility::Private
        } else if trimmed.starts_with("protected ") {
            Visibility::Private
        } else if trimmed.starts_with("internal ") {
            Visibility::Internal
        } else {
            Visibility::Private
        }
    }

    /// Check if a line represents an async method.
    fn is_async_line(trimmed: &str) -> bool {
        trimmed.contains("async ") || trimmed.contains("async\t")
    }

    /// Extract the name token after a keyword like "class", "interface", etc.
    fn extract_name_after_keyword(trimmed: &str, keyword: &str) -> Option<String> {
        let lower = trimmed.to_lowercase();
        if let Some(pos) = lower.find(keyword) {
            let after = &trimmed[pos + keyword.len()..];
            let name = after.trim()
                .split(|c: char| c == ':' || c == '{' || c == '<' || c == '(' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .trim();
            if !name.is_empty() {
                Some(name.to_string())
            } else {
                None
            }
        } else {
            None
        }
    }

    /// Extract parent/base type from a class/interface declaration line.
    fn extract_base_type(trimmed: &str) -> Option<String> {
        if let Some(colon_pos) = trimmed.find(':') {
            let after_colon = &trimmed[colon_pos + 1..];
            let base = after_colon.trim()
                .split(|c: char| c == ',' || c == '{' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !base.is_empty() { Some(base) } else { None }
        } else {
            None
        }
    }
}

impl LanguageParser for CsharpParser {
    fn language_id(&self) -> &'static str { "csharp" }
    fn display_name(&self) -> &'static str { "C# (.NET)" }
    fn supported_dialects(&self) -> &[&'static str] { &["C#-7.0", "C#-8.0", "C#-9.0", "C#-10.0", "C#-11.0", "C#-12.0"] }
    fn file_extensions(&self) -> &[&'static str] { &["cs"] }

    fn nir_coverage_pct(&self) -> f64 { 0.72 }
    fn recommended_backend(&self) -> &'static str { "Roslyn (CodeAnalysis.CSharp)" }
    fn estimated_dev_effort(&self) -> &'static str { "1-2 weeks to production" }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let lower = file.header.to_lowercase();
        let content_match = lower.contains("using system")
            || lower.contains("namespace ")
            || (lower.contains("class ") && lower.contains("{"))
            || lower.contains("async task");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols = Vec::new();
        let ast_nodes = Vec::new();
        let mut usings: Vec<String> = Vec::new();
        let mut has_async = false;
        let mut attribute_count: usize = 0;
        let mut linq_count: usize = 0;
        let mut uses_ef_core = false;
        let mut uses_di = false;

        for (i, line) in source.content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }

            // Skip single-line comments (but not doc comments which still carry info)
            if trimmed.starts_with("//") && !trimmed.starts_with("///") { continue; }

            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // ── Using statements ──────────────────────────────────────
            if trimmed.starts_with("using ") && trimmed.ends_with(';') && !trimmed.contains('(') {
                let using_target = trimmed[6..].trim_end_matches(';').trim();
                // Filter out using aliases like "using Foo = Bar.Baz;"
                let target = if using_target.contains('=') {
                    using_target.split('=').last().unwrap_or("").trim()
                } else {
                    using_target
                };
                // Handle "using static ..."
                let target = target.strip_prefix("static ").unwrap_or(target);
                usings.push(target.to_string());

                symbols.push(Symbol {
                    name: target.to_string(),
                    kind: SymbolKind::Custom("Using".to_string()),
                    span,
                    visibility: Visibility::Public,
                    data_type: None,
                    properties: HashMap::new(),
                });

                // Detect EF Core and DI from using statements
                if target.contains("Microsoft.EntityFrameworkCore") {
                    uses_ef_core = true;
                }
                if target.contains("Microsoft.Extensions.DependencyInjection") {
                    uses_di = true;
                }
                continue;
            }

            // ── Namespace declarations ────────────────────────────────
            if trimmed.starts_with("namespace ") {
                let name = trimmed[10..]
                    .trim_end_matches(';')
                    .trim_end_matches('{')
                    .trim();
                symbols.push(Symbol {
                    name: name.to_string(),
                    kind: SymbolKind::Custom("Namespace".to_string()),
                    span,
                    visibility: Visibility::Public,
                    data_type: None,
                    properties: HashMap::new(),
                });
                continue;
            }

            // ── Attributes ───────────────────────────────────────────
            if trimmed.starts_with('[') && trimmed.contains(']') && !trimmed.starts_with("[assembly:") {
                attribute_count += 1;
                let attr_content = trimmed.trim_start_matches('[');
                let attr_name = attr_content
                    .split(|c: char| c == ']' || c == '(')
                    .next()
                    .unwrap_or("")
                    .trim();
                if !attr_name.is_empty() {
                    symbols.push(Symbol {
                        name: attr_name.to_string(),
                        kind: SymbolKind::Custom("Attribute".to_string()),
                        span,
                        visibility: Visibility::Public,
                        data_type: None,
                        properties: HashMap::new(),
                    });
                }
                continue;
            }

            // ── Enum declarations ────────────────────────────────────
            if (trimmed.contains("enum ") && !trimmed.contains("\""))
                && (trimmed.starts_with("public ")
                    || trimmed.starts_with("private ")
                    || trimmed.starts_with("protected ")
                    || trimmed.starts_with("internal ")
                    || trimmed.starts_with("enum "))
            {
                if let Some(name) = Self::extract_name_after_keyword(trimmed, "enum ") {
                    let vis = Self::extract_visibility(trimmed);
                    symbols.push(Symbol {
                        name,
                        kind: SymbolKind::Custom("Enum".to_string()),
                        span,
                        visibility: vis,
                        data_type: None,
                        properties: HashMap::new(),
                    });
                }
                continue;
            }

            // ── Interface declarations ───────────────────────────────
            if trimmed.contains("interface ")
                && (trimmed.starts_with("public ")
                    || trimmed.starts_with("private ")
                    || trimmed.starts_with("protected ")
                    || trimmed.starts_with("internal ")
                    || trimmed.starts_with("interface "))
                && !trimmed.contains("\"")
            {
                if let Some(name) = Self::extract_name_after_keyword(trimmed, "interface ") {
                    let vis = Self::extract_visibility(trimmed);
                    let base = Self::extract_base_type(trimmed);
                    let mut properties = HashMap::new();
                    if let Some(ref b) = base {
                        properties.insert("base_type".to_string(), serde_json::json!(b));
                    }
                    symbols.push(Symbol {
                        name,
                        kind: SymbolKind::Custom("Interface".to_string()),
                        span,
                        visibility: vis,
                        data_type: base,
                        properties,
                    });
                }
                continue;
            }

            // ── Struct declarations ──────────────────────────────────
            if trimmed.contains("struct ")
                && (trimmed.starts_with("public ")
                    || trimmed.starts_with("private ")
                    || trimmed.starts_with("protected ")
                    || trimmed.starts_with("internal ")
                    || trimmed.starts_with("readonly ")
                    || trimmed.starts_with("struct "))
                && !trimmed.contains("\"")
            {
                if let Some(name) = Self::extract_name_after_keyword(trimmed, "struct ") {
                    let vis = Self::extract_visibility(trimmed);
                    symbols.push(Symbol {
                        name,
                        kind: SymbolKind::Custom("Struct".to_string()),
                        span,
                        visibility: vis,
                        data_type: None,
                        properties: HashMap::new(),
                    });
                }
                continue;
            }

            // ── Record declarations (C# 9.0+) ───────────────────────
            if trimmed.contains("record ")
                && (trimmed.starts_with("public ")
                    || trimmed.starts_with("private ")
                    || trimmed.starts_with("protected ")
                    || trimmed.starts_with("internal ")
                    || trimmed.starts_with("record "))
                && !trimmed.contains("\"")
            {
                if let Some(name) = Self::extract_name_after_keyword(trimmed, "record ") {
                    let vis = Self::extract_visibility(trimmed);
                    symbols.push(Symbol {
                        name,
                        kind: SymbolKind::Custom("Record".to_string()),
                        span,
                        visibility: vis,
                        data_type: None,
                        properties: HashMap::new(),
                    });
                }
                continue;
            }

            // ── Class declarations ───────────────────────────────────
            if trimmed.contains("class ")
                && (trimmed.starts_with("public ")
                    || trimmed.starts_with("private ")
                    || trimmed.starts_with("protected ")
                    || trimmed.starts_with("internal ")
                    || trimmed.starts_with("static ")
                    || trimmed.starts_with("abstract ")
                    || trimmed.starts_with("sealed ")
                    || trimmed.starts_with("partial ")
                    || trimmed.starts_with("class "))
                && !trimmed.contains("\"")
            {
                if let Some(name) = Self::extract_name_after_keyword(trimmed, "class ") {
                    let vis = Self::extract_visibility(trimmed);
                    let base = Self::extract_base_type(trimmed);
                    let mut properties = HashMap::new();
                    if trimmed.contains("abstract ") {
                        properties.insert("abstract".to_string(), serde_json::json!(true));
                    }
                    if trimmed.contains("static ") {
                        properties.insert("static".to_string(), serde_json::json!(true));
                    }
                    if trimmed.contains("sealed ") {
                        properties.insert("sealed".to_string(), serde_json::json!(true));
                    }
                    if trimmed.contains("partial ") {
                        properties.insert("partial".to_string(), serde_json::json!(true));
                    }
                    if let Some(ref b) = base {
                        properties.insert("base_type".to_string(), serde_json::json!(b));
                    }

                    // Detect EF Core DbContext subclass
                    if let Some(ref b) = base {
                        if b == "DbContext" || b.ends_with(".DbContext") {
                            uses_ef_core = true;
                            properties.insert("ef_db_context".to_string(), serde_json::json!(true));
                        }
                    }

                    symbols.push(Symbol {
                        name,
                        kind: SymbolKind::Custom("Class".to_string()),
                        span,
                        visibility: vis,
                        data_type: base,
                        properties,
                    });
                }
                continue;
            }

            // ── Properties (auto-properties with get/set/init) ──────
            if (trimmed.contains("{ get;") || trimmed.contains("{ set;") || trimmed.contains("{ init;"))
                && !trimmed.contains("(")
            {
                // Pattern: [visibility] [static] <Type> <Name> { get; set; }
                let vis = Self::extract_visibility(trimmed);
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                // Find the property name — it's the token before '{'
                if let Some(brace_pos) = parts.iter().position(|p| p.starts_with('{')) {
                    if brace_pos >= 2 {
                        let prop_name = parts[brace_pos - 1];
                        let prop_type = parts[brace_pos - 2];
                        if !prop_name.is_empty() {
                            let mut properties = HashMap::new();
                            if trimmed.contains("init;") {
                                properties.insert("init_only".to_string(), serde_json::json!(true));
                            }
                            symbols.push(Symbol {
                                name: prop_name.to_string(),
                                kind: SymbolKind::Custom("Property".to_string()),
                                span,
                                visibility: vis,
                                data_type: Some(prop_type.to_string()),
                                properties,
                            });
                        }
                    }
                }
                continue;
            }

            // ── Method declarations ──────────────────────────────────
            // Heuristic: line has '(' and ')' or '(', visibility keyword or void/Task/etc.,
            // and is not a control-flow statement
            if trimmed.contains('(')
                && !trimmed.starts_with("if ")
                && !trimmed.starts_with("if(")
                && !trimmed.starts_with("else ")
                && !trimmed.starts_with("while ")
                && !trimmed.starts_with("while(")
                && !trimmed.starts_with("for ")
                && !trimmed.starts_with("for(")
                && !trimmed.starts_with("foreach ")
                && !trimmed.starts_with("foreach(")
                && !trimmed.starts_with("switch ")
                && !trimmed.starts_with("switch(")
                && !trimmed.starts_with("catch ")
                && !trimmed.starts_with("catch(")
                && !trimmed.starts_with("return ")
                && !trimmed.starts_with("var ")
                && !trimmed.starts_with("//")
                && !trimmed.starts_with("///")
                && !trimmed.starts_with('[')
                && !trimmed.starts_with("using ")
                && !trimmed.starts_with("new ")
                && !trimmed.ends_with(',')
            {
                let is_method = trimmed.starts_with("public ")
                    || trimmed.starts_with("private ")
                    || trimmed.starts_with("protected ")
                    || trimmed.starts_with("internal ")
                    || trimmed.starts_with("static ")
                    || trimmed.starts_with("virtual ")
                    || trimmed.starts_with("override ")
                    || trimmed.starts_with("abstract ")
                    || trimmed.starts_with("async ")
                    || trimmed.starts_with("void ")
                    || trimmed.starts_with("Task ")
                    || trimmed.starts_with("Task<");

                if is_method {
                    let vis = Self::extract_visibility(trimmed);
                    let is_async = Self::is_async_line(trimmed);
                    if is_async { has_async = true; }

                    // Extract method name: token immediately before '('
                    let before_paren = trimmed.split('(').next().unwrap_or("");
                    let tokens: Vec<&str> = before_paren.split_whitespace().collect();
                    if let Some(method_name) = tokens.last() {
                        let method_name = method_name.trim();
                        // Skip constructors that match class names (still valid methods)
                        if !method_name.is_empty() && method_name != "{" {
                            let mut properties = HashMap::new();
                            if is_async {
                                properties.insert("async".to_string(), serde_json::json!(true));
                            }
                            if trimmed.contains("override ") {
                                properties.insert("override".to_string(), serde_json::json!(true));
                            }
                            if trimmed.contains("virtual ") {
                                properties.insert("virtual".to_string(), serde_json::json!(true));
                            }
                            if trimmed.contains("static ") {
                                properties.insert("static".to_string(), serde_json::json!(true));
                            }
                            if trimmed.contains("abstract ") {
                                properties.insert("abstract".to_string(), serde_json::json!(true));
                            }

                            // Detect return type (token before method name)
                            let return_type = if tokens.len() >= 2 {
                                let candidate = tokens[tokens.len() - 2];
                                // Filter out access modifiers and other keywords
                                match candidate {
                                    "public" | "private" | "protected" | "internal"
                                    | "static" | "virtual" | "override" | "abstract"
                                    | "async" | "sealed" | "new" | "partial" | "extern" => None,
                                    other => Some(other.to_string()),
                                }
                            } else {
                                None
                            };

                            symbols.push(Symbol {
                                name: method_name.to_string(),
                                kind: SymbolKind::Function,
                                span,
                                visibility: vis,
                                data_type: return_type,
                                properties,
                            });
                        }
                    }
                    continue;
                }
            }

            // ── LINQ queries ─────────────────────────────────────────
            if (trimmed.contains("from ") && trimmed.contains(" in ") && trimmed.contains(" select"))
                || trimmed.contains(".Select(")
                || trimmed.contains(".Where(")
                || trimmed.contains(".GroupBy(")
                || trimmed.contains(".OrderBy(")
                || trimmed.contains(".Join(")
            {
                linq_count += 1;
            }

            // ── EF Core patterns ─────────────────────────────────────
            if trimmed.contains("DbSet<")
                || trimmed.contains("DbContext")
                || trimmed.contains(".Include(")
                || trimmed.contains("OnModelCreating")
                || trimmed.contains("modelBuilder")
                || trimmed.contains(".HasOne(")
                || trimmed.contains(".HasMany(")
                || trimmed.contains(".ToTable(")
            {
                uses_ef_core = true;
            }

            // ── Dependency Injection patterns ────────────────────────
            if trimmed.contains("IServiceCollection")
                || trimmed.contains("AddScoped")
                || trimmed.contains("AddTransient")
                || trimmed.contains("AddSingleton")
                || trimmed.contains("IServiceProvider")
                || trimmed.contains("services.Add")
                || trimmed.contains(".AddDbContext")
            {
                uses_di = true;
            }

            // ── Async detection in method bodies ─────────────────────
            if trimmed.contains("await ") || trimmed.contains("async ") {
                has_async = true;
            }
        }

        // ── Detect dialect ───────────────────────────────────────────
        let dialect = Self::detect_dialect(&source.content).to_string();

        // ── Build metadata ───────────────────────────────────────────
        let mut metadata = HashMap::new();
        metadata.insert("usings".to_string(), serde_json::json!(usings));
        metadata.insert("has_async".to_string(), serde_json::json!(has_async));
        metadata.insert("class_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Class".to_string())).count()
        ));
        metadata.insert("interface_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Interface".to_string())).count()
        ));
        metadata.insert("attribute_count".to_string(), serde_json::json!(attribute_count));
        metadata.insert("linq_count".to_string(), serde_json::json!(linq_count));
        metadata.insert("uses_ef_core".to_string(), serde_json::json!(uses_ef_core));
        metadata.insert("uses_di".to_string(), serde_json::json!(uses_di));
        metadata.insert("method_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Function)).count()
        ));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect,
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
        if let Some(usings_val) = module.metadata.get("usings") {
            if let Some(arr) = usings_val.as_array() {
                for u in arr {
                    if let Some(name) = u.as_str() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.to_string(),
                            dependency_type: DependencyType::CopyInclude,
                            source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                            reference_text: format!("using {}", name),
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
            nodes: vec![],
            edges: vec![],
            business_rules: vec![],
            data_flows: vec![],
        })
    }
}
