//! PL/I parser — Deep parser implementing LanguageParser trait.
//!
//! Handles PL/I Enterprise and PL/I Open with thorough structural parsing:
//!   - PROCEDURE/PROC with OPTIONS(MAIN), ENTRY, RETURNS()
//!   - DCL/DECLARE with full type detection (CHAR, BIT, FIXED, FLOAT, POINTER, etc.)
//!   - Structure levels (1-99 level numbers)
//!   - CALL statements, DO/END blocks, SELECT/WHEN/OTHERWISE
//!   - IF/THEN/ELSE, GOTO/GO TO, RETURN
//!   - File I/O: OPEN/CLOSE, READ/WRITE/REWRITE/DELETE, GET/PUT
//!   - ALLOCATE/FREE, ON condition handlers, SIGNAL
//!   - %INCLUDE preprocessor, FETCH/RELEASE, EXEC SQL
//!   - BEGIN/END blocks, builtin function detection

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

/// Known PL/I builtin functions for detection.
const BUILTINS: &[&str] = &[
    "SUBSTR", "LENGTH", "INDEX", "VERIFY", "TRANSLATE", "TRIM", "REPEAT",
    "CHAR", "BIT", "FIXED", "FLOAT", "BINARY", "DECIMAL",
    "ABS", "MOD", "CEIL", "FLOOR", "ROUND", "SIGN", "SQRT", "LOG", "EXP",
    "MAX", "MIN", "SUM", "PROD",
    "DATE", "TIME", "DATETIME", "DAYS", "SECS",
    "ADDR", "NULL", "ALLOCATION", "STORAGE", "SIZE",
    "HBOUND", "LBOUND", "DIM",
    "ONCODE", "ONFILE", "ONKEY", "ONSOURCE",
    "UNSPEC", "COPY", "PLIRETV", "PLISRTA", "PLISRTB",
    "HIGH", "LOW", "COLLATE", "STRING",
    "BOOL", "PLICANC", "PLICKPT", "PLIDELETE", "PLIFILL", "PLIFREE",
];

pub struct PliParser;

impl PliParser {
    pub fn new() -> Self { Self }

    /// Strip a PL/I comment (/* ... */) from a line for simpler keyword matching.
    fn strip_comments(line: &str) -> String {
        let mut out = String::with_capacity(line.len());
        let mut in_comment = false;
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if !in_comment && i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
                in_comment = true;
                i += 2;
                continue;
            }
            if in_comment && i + 1 < bytes.len() && bytes[i] == b'*' && bytes[i + 1] == b'/' {
                in_comment = false;
                i += 2;
                out.push(' ');
                continue;
            }
            if !in_comment {
                out.push(bytes[i] as char);
            }
            i += 1;
        }
        out
    }

    /// Extract value between parentheses after a keyword: KEYWORD(value) -> value
    fn extract_paren(text: &str, keyword: &str) -> Option<String> {
        let upper = text.to_uppercase();
        if let Some(pos) = upper.find(keyword) {
            let after = &text[pos + keyword.len()..];
            let trimmed = after.trim_start();
            if trimmed.starts_with('(') {
                let mut depth = 0;
                let mut content = String::new();
                for ch in trimmed.chars() {
                    if ch == '(' {
                        depth += 1;
                        if depth > 1 { content.push(ch); }
                    } else if ch == ')' {
                        depth -= 1;
                        if depth == 0 { return Some(content.trim().to_string()); }
                        content.push(ch);
                    } else if depth >= 1 {
                        content.push(ch);
                    }
                }
            }
        }
        None
    }

    /// Detect PL/I data type from a DCL statement remainder.
    fn detect_data_type(rest: &str) -> Option<String> {
        let upper = rest.to_uppercase();
        let tokens: Vec<&str> = upper.split_whitespace().collect();

        // CHAR(n) / CHARACTER(n)
        if upper.contains("CHAR") {
            if let Some(n) = Self::extract_paren(&upper, "CHAR") {
                let varying = if upper.contains("VARYING") || upper.contains("VAR") {
                    " VARYING"
                } else { "" };
                return Some(format!("CHAR({}){}", n, varying));
            }
            return Some("CHAR".to_string());
        }
        // BIT(n)
        if upper.contains("BIT") {
            if let Some(n) = Self::extract_paren(&upper, "BIT") {
                return Some(format!("BIT({})", n));
            }
            return Some("BIT".to_string());
        }
        // PICTURE / PIC
        if upper.contains("PICTURE") || upper.contains(" PIC ") || upper.contains(" PIC'") {
            let pic_val = upper.split("PICTURE").nth(1)
                .or_else(|| upper.split("PIC").nth(1))
                .map(|s| s.trim().trim_matches('\'').trim_matches('"'))
                .unwrap_or("");
            return Some(format!("PICTURE '{}'", pic_val.split_whitespace().next().unwrap_or("")));
        }
        // FIXED BIN / FIXED DEC / FIXED BINARY / FIXED DECIMAL
        if upper.contains("FIXED") {
            let base = if upper.contains("BIN") || upper.contains("BINARY") {
                "FIXED BIN"
            } else {
                "FIXED DEC"
            };
            if let Some(pq) = Self::extract_paren(&upper, "FIXED") {
                return Some(format!("{}({})", base, pq));
            }
            // Check for precision after BIN/DEC keyword
            let after_key = if upper.contains("BINARY") {
                Self::extract_paren(&upper, "BINARY")
            } else if upper.contains("BIN") {
                Self::extract_paren(&upper, "BIN")
            } else if upper.contains("DECIMAL") {
                Self::extract_paren(&upper, "DECIMAL")
            } else {
                Self::extract_paren(&upper, "DEC")
            };
            if let Some(pq) = after_key {
                return Some(format!("{}({})", base, pq));
            }
            return Some(base.to_string());
        }
        // FLOAT BIN / FLOAT DEC
        if upper.contains("FLOAT") {
            let base = if upper.contains("BIN") || upper.contains("BINARY") {
                "FLOAT BIN"
            } else {
                "FLOAT DEC"
            };
            if let Some(p) = Self::extract_paren(&upper, "FLOAT") {
                return Some(format!("{}({})", base, p));
            }
            return Some(base.to_string());
        }
        // POINTER / PTR
        if tokens.contains(&"POINTER") || tokens.contains(&"PTR") {
            return Some("POINTER".to_string());
        }
        // ENTRY
        if tokens.contains(&"ENTRY") {
            let returns = Self::extract_paren(&upper, "RETURNS");
            if let Some(r) = returns {
                return Some(format!("ENTRY RETURNS({})", r));
            }
            return Some("ENTRY".to_string());
        }
        // LABEL
        if tokens.contains(&"LABEL") { return Some("LABEL".to_string()); }
        // FILE
        if tokens.contains(&"FILE") { return Some("FILE".to_string()); }
        // BUILTIN
        if tokens.contains(&"BUILTIN") { return Some("BUILTIN".to_string()); }
        // OFFSET
        if tokens.contains(&"OFFSET") { return Some("OFFSET".to_string()); }
        // AREA
        if upper.contains("AREA") {
            if let Some(n) = Self::extract_paren(&upper, "AREA") {
                return Some(format!("AREA({})", n));
            }
            return Some("AREA".to_string());
        }

        None
    }

    /// Detect all builtin function usages in a line.
    fn detect_builtins(line: &str) -> Vec<String> {
        let upper = line.to_uppercase();
        let mut found = Vec::new();
        for &b in BUILTINS {
            // Look for BUILTIN( pattern to avoid false positives with variable names
            let pattern = format!("{}(", b);
            if upper.contains(&pattern) {
                found.push(b.to_string());
            }
        }
        found
    }

    /// Accumulate a multi-line PL/I statement terminated by semicolon.
    /// Returns (accumulated_upper_text, start_line, end_line, next_index).
    fn accumulate_statement(
        lines: &[(usize, String)],
        start_idx: usize,
    ) -> (String, usize, usize, usize) {
        let (start_line, ref first) = lines[start_idx];
        let mut stmt = Self::strip_comments(first).trim().to_string();
        let mut end_line = start_line;
        let mut idx = start_idx + 1;

        // PL/I statements end with semicolon
        while !stmt.contains(';') && idx < lines.len() {
            let (ln, ref next) = lines[idx];
            let clean = Self::strip_comments(next);
            let trimmed = clean.trim();
            if !trimmed.is_empty() {
                stmt.push(' ');
                stmt.push_str(trimmed);
            }
            end_line = ln;
            idx += 1;
        }

        (stmt.to_uppercase(), start_line, end_line, idx)
    }
}

impl LanguageParser for PliParser {
    fn language_id(&self) -> &'static str { "pli" }
    fn display_name(&self) -> &'static str { "PL/I" }
    fn supported_dialects(&self) -> &[&'static str] { &["PL/I-Enterprise", "PL/I-Open"] }
    fn file_extensions(&self) -> &[&'static str] { &["pli", "pl1", "plinc"] }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let content_match = upper.contains("PROC OPTIONS(MAIN)")
            || upper.contains("PROCEDURE OPTIONS(MAIN)")
            || (upper.contains("DCL ") && (upper.contains("CHAR(") || upper.contains("FIXED")))
            || (upper.contains("DECLARE ") && (upper.contains("CHAR(") || upper.contains("FIXED")))
            || (upper.contains("%INCLUDE") && upper.contains("DCL "));
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut ast_nodes = Vec::new();
        let mut symbols = Vec::new();
        let mut embedded_blocks = Vec::new();
        let mut diagnostics = Vec::new();

        // Counters for metadata
        let mut procedure_count: usize = 0;
        let mut variable_count: usize = 0;
        let mut structure_count: usize = 0;
        let mut call_count: usize = 0;
        let mut sql_block_count: usize = 0;
        let mut on_unit_count: usize = 0;
        let mut file_io_count: usize = 0;
        let mut include_count: usize = 0;
        let mut goto_count: usize = 0;
        let mut do_loop_count: usize = 0;
        let mut select_count: usize = 0;
        let mut if_count: usize = 0;
        let mut begin_block_count: usize = 0;
        let mut return_count: usize = 0;
        let mut allocate_count: usize = 0;
        let mut signal_count: usize = 0;
        let mut fetch_count: usize = 0;
        let mut builtin_usages: Vec<String> = Vec::new();
        let mut call_targets: Vec<String> = Vec::new();
        let mut include_refs: Vec<String> = Vec::new();

        // Prepare lines: (line_number, content)
        let lines: Vec<(usize, String)> = source.content.lines()
            .enumerate()
            .map(|(i, l)| (i, l.to_string()))
            .collect();

        // Track multi-line comment state
        let mut in_block_comment = false;
        let mut in_exec_sql = false;
        let mut exec_sql_content = String::new();
        let mut exec_sql_start: usize = 0;

        let mut i = 0;
        while i < lines.len() {
            let (line_num, ref raw_line) = lines[i];

            // Handle block comments spanning multiple lines
            if in_block_comment {
                if raw_line.contains("*/") {
                    in_block_comment = false;
                }
                i += 1;
                continue;
            }
            let trimmed_raw = raw_line.trim();
            if trimmed_raw.starts_with("/*") && !trimmed_raw.contains("*/") {
                in_block_comment = true;
                i += 1;
                continue;
            }

            // ─── EXEC SQL block accumulation ───
            let clean = Self::strip_comments(raw_line);
            let upper_clean = clean.trim().to_uppercase();

            if in_exec_sql {
                if upper_clean.contains("END-EXEC") || upper_clean.contains("END EXEC") {
                    embedded_blocks.push(EmbeddedBlock {
                        language: "SQL".to_string(),
                        content: exec_sql_content.clone(),
                        span: Span { start_line: exec_sql_start, start_col: 0, end_line: line_num, end_col: raw_line.len() },
                        block_type: EmbeddedBlockType::ExecSql,
                    });
                    ast_nodes.push(AstNode {
                        id: format!("exec-sql-{}", exec_sql_start),
                        kind: AstNodeKind::ExecSqlBlock,
                        name: None,
                        span: Span { start_line: exec_sql_start, start_col: 0, end_line: line_num, end_col: raw_line.len() },
                        children: vec![],
                        properties: HashMap::from([
                            ("content".to_string(), serde_json::json!(exec_sql_content)),
                        ]),
                    });
                    sql_block_count += 1;
                    in_exec_sql = false;
                } else {
                    exec_sql_content.push_str(clean.trim());
                    exec_sql_content.push('\n');
                }
                i += 1;
                continue;
            }
            if upper_clean.starts_with("EXEC SQL") || upper_clean.starts_with("EXEC  SQL") {
                in_exec_sql = true;
                exec_sql_start = line_num;
                exec_sql_content.clear();
                let after = upper_clean.replacen("EXEC SQL", "", 1).replacen("EXEC  SQL", "", 1);
                let after = after.trim();
                if after.contains("END-EXEC") || after.contains("END EXEC") {
                    // Single-line EXEC SQL
                    let sql_text = after.replace("END-EXEC", "").replace("END EXEC", "")
                        .trim_end_matches(';').trim().to_string();
                    embedded_blocks.push(EmbeddedBlock {
                        language: "SQL".to_string(),
                        content: sql_text.clone(),
                        span: Span { start_line: line_num, start_col: 0, end_line: line_num, end_col: raw_line.len() },
                        block_type: EmbeddedBlockType::ExecSql,
                    });
                    ast_nodes.push(AstNode {
                        id: format!("exec-sql-{}", line_num),
                        kind: AstNodeKind::ExecSqlBlock,
                        name: None,
                        span: Span { start_line: line_num, start_col: 0, end_line: line_num, end_col: raw_line.len() },
                        children: vec![],
                        properties: HashMap::from([
                            ("content".to_string(), serde_json::json!(sql_text)),
                        ]),
                    });
                    sql_block_count += 1;
                    in_exec_sql = false;
                } else {
                    exec_sql_content.push_str(after);
                    exec_sql_content.push('\n');
                }
                i += 1;
                continue;
            }

            // ─── %INCLUDE preprocessor directive ───
            if upper_clean.starts_with("%INCLUDE") || upper_clean.starts_with("% INCLUDE") {
                let rest = upper_clean.replacen("%INCLUDE", "", 1).replacen("% INCLUDE", "", 1);
                let inc_name = rest.trim().trim_end_matches(';').trim()
                    .trim_matches('\'').trim_matches('"').to_string();
                if !inc_name.is_empty() {
                    ast_nodes.push(AstNode {
                        id: format!("include-{}", line_num),
                        kind: AstNodeKind::CopyStatement,
                        name: Some(inc_name.clone()),
                        span: Span { start_line: line_num, start_col: 0, end_line: line_num, end_col: raw_line.len() },
                        children: vec![],
                        properties: HashMap::from([
                            ("directive".to_string(), serde_json::json!("%INCLUDE")),
                        ]),
                    });
                    include_refs.push(inc_name);
                    include_count += 1;
                }
                i += 1;
                continue;
            }

            // Skip empty/comment-only lines
            if upper_clean.is_empty() {
                i += 1;
                continue;
            }

            // Accumulate full statement for complex matching
            let (stmt_upper, stmt_start, stmt_end, next_idx) =
                Self::accumulate_statement(&lines, i);
            let stmt_trimmed = stmt_upper.trim_end_matches(';').trim();
            let span = Span { start_line: stmt_start, start_col: 0, end_line: stmt_end, end_col: 80 };

            // ─── Detect builtin usages ───
            let found_builtins = Self::detect_builtins(&stmt_upper);
            for b in &found_builtins {
                if !builtin_usages.contains(b) {
                    builtin_usages.push(b.clone());
                }
            }
            if !found_builtins.is_empty() {
                ast_nodes.push(AstNode {
                    id: format!("builtin-{}", stmt_start),
                    kind: AstNodeKind::Custom("BuiltinUsage".to_string()),
                    name: None,
                    span,
                    children: vec![],
                    properties: HashMap::from([
                        ("builtins".to_string(), serde_json::json!(found_builtins)),
                    ]),
                });
            }

            // ─── PROCEDURE / PROC (with optional label: NAME: PROC ...) ───
            if stmt_trimmed.contains(": PROC ") || stmt_trimmed.contains(": PROCEDURE ")
                || stmt_trimmed.contains(":PROC ") || stmt_trimmed.contains(":PROCEDURE ")
                || stmt_trimmed.starts_with("PROC ") || stmt_trimmed.starts_with("PROCEDURE ")
                || stmt_trimmed.contains(": PROC;") || stmt_trimmed.contains(": PROCEDURE;")
                || stmt_trimmed.contains(":PROC;") || stmt_trimmed.contains(":PROCEDURE;")
            {
                // Extract the procedure name (label before colon)
                let proc_name = if stmt_trimmed.contains(':') {
                    stmt_trimmed.split(':').next().unwrap_or("").trim().to_string()
                } else {
                    String::new()
                };

                let mut props = HashMap::new();

                // OPTIONS(MAIN)
                let is_main = stmt_trimmed.contains("OPTIONS") && stmt_trimmed.contains("MAIN");
                if is_main {
                    props.insert("is_main".to_string(), serde_json::json!(true));
                }
                if let Some(opts) = Self::extract_paren(&stmt_upper, "OPTIONS") {
                    props.insert("options".to_string(), serde_json::json!(opts));
                }

                // RETURNS() type
                if let Some(ret_type) = Self::extract_paren(&stmt_upper, "RETURNS") {
                    props.insert("returns".to_string(), serde_json::json!(ret_type));
                }

                // ENTRY attribute detection
                let has_entry = stmt_trimmed.contains(" ENTRY");
                if has_entry {
                    props.insert("has_entry".to_string(), serde_json::json!(true));
                }

                // RECURSIVE
                if stmt_trimmed.contains("RECURSIVE") {
                    props.insert("recursive".to_string(), serde_json::json!(true));
                }
                // REORDER / ORDER
                if stmt_trimmed.contains("REORDER") {
                    props.insert("reorder".to_string(), serde_json::json!(true));
                }

                let visibility = if is_main { Visibility::Public } else { Visibility::Internal };

                if !proc_name.is_empty() {
                    symbols.push(Symbol {
                        name: proc_name.clone(),
                        kind: SymbolKind::Procedure,
                        span,
                        visibility,
                        data_type: Self::extract_paren(&stmt_upper, "RETURNS"),
                        properties: props.clone(),
                    });
                }

                ast_nodes.push(AstNode {
                    id: format!("proc-{}", stmt_start),
                    kind: AstNodeKind::Procedure,
                    name: if proc_name.is_empty() { None } else { Some(proc_name) },
                    span,
                    children: vec![],
                    properties: props,
                });
                procedure_count += 1;
                i = next_idx;
                continue;
            }

            // ─── ENTRY statement (secondary entry points) ───
            if (stmt_trimmed.contains(": ENTRY") || stmt_trimmed.starts_with("ENTRY"))
                && !stmt_trimmed.contains("DCL") && !stmt_trimmed.contains("DECLARE")
            {
                let entry_name = if stmt_trimmed.contains(':') {
                    stmt_trimmed.split(':').next().unwrap_or("").trim().to_string()
                } else {
                    String::new()
                };
                let mut props = HashMap::new();
                if let Some(ret) = Self::extract_paren(&stmt_upper, "RETURNS") {
                    props.insert("returns".to_string(), serde_json::json!(ret));
                }
                if !entry_name.is_empty() {
                    symbols.push(Symbol {
                        name: entry_name.clone(),
                        kind: SymbolKind::Custom("Entry".to_string()),
                        span,
                        visibility: Visibility::Public,
                        data_type: Self::extract_paren(&stmt_upper, "RETURNS"),
                        properties: props.clone(),
                    });
                }
                ast_nodes.push(AstNode {
                    id: format!("entry-{}", stmt_start),
                    kind: AstNodeKind::Custom("EntryStatement".to_string()),
                    name: if entry_name.is_empty() { None } else { Some(entry_name) },
                    span,
                    children: vec![],
                    properties: props,
                });
                i = next_idx;
                continue;
            }

            // ─── DCL / DECLARE statements ───
            if stmt_trimmed.starts_with("DCL ") || stmt_trimmed.starts_with("DECLARE ") {
                let prefix_len = if stmt_trimmed.starts_with("DCL ") { 4 } else { 8 };
                let rest = &stmt_trimmed[prefix_len..];

                // Check for structure level number: DCL 1 RECORD, ...
                let first_token = rest.split_whitespace().next().unwrap_or("");
                if let Ok(level) = first_token.parse::<u8>() {
                    if level >= 1 && level <= 99 {
                        // Structure declaration — parse all members
                        self.parse_structure_dcl(
                            rest, stmt_start, stmt_end,
                            &mut ast_nodes, &mut symbols, &mut structure_count, &mut variable_count,
                        );
                        i = next_idx;
                        continue;
                    }
                }

                // Simple variable or group declaration
                // Could be: DCL name type attrs; or DCL (a,b,c) type attrs;
                let is_factored = rest.trim_start().starts_with('(');
                if is_factored {
                    // Factored DCL: DCL (A, B, C) CHAR(10);
                    if let Some(names_str) = Self::extract_paren(rest, "") {
                        let type_rest = rest[rest.find(')').unwrap_or(0) + 1..].trim();
                        let data_type = Self::detect_data_type(type_rest);
                        for var_name in names_str.split(',') {
                            let vn = var_name.trim().to_string();
                            if !vn.is_empty() {
                                symbols.push(Symbol {
                                    name: vn.clone(),
                                    kind: SymbolKind::Variable,
                                    span,
                                    visibility: Visibility::Internal,
                                    data_type: data_type.clone(),
                                    properties: HashMap::new(),
                                });
                                ast_nodes.push(AstNode {
                                    id: format!("dcl-{}-{}", stmt_start, vn),
                                    kind: AstNodeKind::DataDeclaration,
                                    name: Some(vn),
                                    span,
                                    children: vec![],
                                    properties: if let Some(ref dt) = data_type {
                                        HashMap::from([("data_type".to_string(), serde_json::json!(dt))])
                                    } else { HashMap::new() },
                                });
                                variable_count += 1;
                            }
                        }
                    }
                } else {
                    // Single variable: DCL NAME TYPE ATTRS;
                    let var_name = first_token.trim_end_matches(';').trim_end_matches(',').to_string();
                    let type_rest = rest[first_token.len()..].trim();
                    let data_type = Self::detect_data_type(type_rest);

                    // Detect special attributes
                    let mut props = HashMap::new();
                    if stmt_upper.contains(" EXTERNAL") || stmt_upper.contains(" EXT") {
                        props.insert("external".to_string(), serde_json::json!(true));
                    }
                    if stmt_upper.contains(" STATIC") {
                        props.insert("static".to_string(), serde_json::json!(true));
                    }
                    if stmt_upper.contains(" AUTOMATIC") || stmt_upper.contains(" AUTO") {
                        props.insert("automatic".to_string(), serde_json::json!(true));
                    }
                    if stmt_upper.contains(" CONTROLLED") || stmt_upper.contains(" CTL") {
                        props.insert("controlled".to_string(), serde_json::json!(true));
                    }
                    if stmt_upper.contains(" BASED") {
                        props.insert("based".to_string(), serde_json::json!(true));
                    }
                    if stmt_upper.contains(" DEFINED") || stmt_upper.contains(" DEF") {
                        props.insert("defined".to_string(), serde_json::json!(true));
                    }
                    if stmt_upper.contains(" INIT(") || stmt_upper.contains(" INITIAL(") {
                        let init_val = Self::extract_paren(&stmt_upper, "INIT")
                            .or_else(|| Self::extract_paren(&stmt_upper, "INITIAL"));
                        if let Some(iv) = init_val {
                            props.insert("initial".to_string(), serde_json::json!(iv));
                        }
                    }
                    if let Some(ref dt) = data_type {
                        props.insert("data_type".to_string(), serde_json::json!(dt));
                    }

                    let visibility = if stmt_upper.contains(" EXTERNAL") || stmt_upper.contains(" EXT") {
                        Visibility::Public
                    } else {
                        Visibility::Internal
                    };

                    let sym_kind = if data_type.as_deref() == Some("FILE") {
                        SymbolKind::FileDescription
                    } else if data_type.as_deref() == Some("ENTRY")
                        || data_type.as_deref().map(|d| d.starts_with("ENTRY")).unwrap_or(false)
                    {
                        SymbolKind::Custom("EntryVariable".to_string())
                    } else if data_type.as_deref() == Some("LABEL") {
                        SymbolKind::Custom("LabelVariable".to_string())
                    } else if data_type.as_deref() == Some("BUILTIN") {
                        SymbolKind::Custom("Builtin".to_string())
                    } else {
                        SymbolKind::Variable
                    };

                    if !var_name.is_empty() && var_name != ";" {
                        symbols.push(Symbol {
                            name: var_name.clone(),
                            kind: sym_kind,
                            span,
                            visibility,
                            data_type,
                            properties: props.clone(),
                        });
                        ast_nodes.push(AstNode {
                            id: format!("dcl-{}", stmt_start),
                            kind: AstNodeKind::DataDeclaration,
                            name: Some(var_name),
                            span,
                            children: vec![],
                            properties: props,
                        });
                        variable_count += 1;
                    }
                }
                i = next_idx;
                continue;
            }

            // ─── CALL statement ───
            if stmt_trimmed.starts_with("CALL ") {
                let rest = &stmt_trimmed[5..];
                let target = rest.split(|c: char| c == '(' || c == ';' || c.is_whitespace())
                    .next().unwrap_or("").trim().to_string();
                let mut props = HashMap::new();
                props.insert("target".to_string(), serde_json::json!(target));
                // Extract arguments
                if let Some(args) = Self::extract_paren(rest, &target) {
                    props.insert("arguments".to_string(), serde_json::json!(args));
                }
                if !target.is_empty() {
                    call_targets.push(target.clone());
                }
                ast_nodes.push(AstNode {
                    id: format!("call-{}", stmt_start),
                    kind: AstNodeKind::CallStatement,
                    name: Some(target),
                    span,
                    children: vec![],
                    properties: props,
                });
                call_count += 1;
                i = next_idx;
                continue;
            }

            // ─── FETCH / RELEASE (dynamic program loading) ───
            if stmt_trimmed.starts_with("FETCH ") {
                let target = stmt_trimmed[6..].split(|c: char| c == ';' || c.is_whitespace())
                    .next().unwrap_or("").trim().to_string();
                ast_nodes.push(AstNode {
                    id: format!("fetch-{}", stmt_start),
                    kind: AstNodeKind::Custom("FetchStatement".to_string()),
                    name: Some(target.clone()),
                    span,
                    children: vec![],
                    properties: HashMap::from([
                        ("target".to_string(), serde_json::json!(target)),
                    ]),
                });
                fetch_count += 1;
                call_targets.push(target);
                i = next_idx;
                continue;
            }
            if stmt_trimmed.starts_with("RELEASE ") {
                let target = stmt_trimmed[8..].split(|c: char| c == ';' || c.is_whitespace())
                    .next().unwrap_or("").trim().to_string();
                ast_nodes.push(AstNode {
                    id: format!("release-{}", stmt_start),
                    kind: AstNodeKind::Custom("ReleaseStatement".to_string()),
                    name: Some(target),
                    span,
                    children: vec![],
                    properties: HashMap::new(),
                });
                i = next_idx;
                continue;
            }

            // ─── DO / END blocks ───
            if stmt_trimmed.starts_with("DO ") || stmt_trimmed == "DO" {
                let mut props = HashMap::new();
                let rest = if stmt_trimmed.len() > 3 { &stmt_trimmed[3..] } else { "" };
                if rest.starts_with("WHILE") || rest.contains("WHILE(") || rest.contains("WHILE (") {
                    props.insert("loop_type".to_string(), serde_json::json!("WHILE"));
                    if let Some(cond) = Self::extract_paren(&stmt_upper, "WHILE") {
                        props.insert("condition".to_string(), serde_json::json!(cond));
                    }
                } else if rest.starts_with("UNTIL") || rest.contains("UNTIL(") || rest.contains("UNTIL (") {
                    props.insert("loop_type".to_string(), serde_json::json!("UNTIL"));
                    if let Some(cond) = Self::extract_paren(&stmt_upper, "UNTIL") {
                        props.insert("condition".to_string(), serde_json::json!(cond));
                    }
                } else if rest.contains(" TO ") || rest.contains("=") {
                    // DO I = 1 TO N BY 1
                    props.insert("loop_type".to_string(), serde_json::json!("iterative"));
                    let var = rest.split('=').next().unwrap_or("").trim().to_string();
                    if !var.is_empty() {
                        props.insert("variable".to_string(), serde_json::json!(var));
                    }
                    if let Some(to_part) = rest.split(" TO ").nth(1) {
                        let limit = to_part.split(|c: char| c.is_whitespace() || c == ';')
                            .next().unwrap_or("").trim();
                        props.insert("to".to_string(), serde_json::json!(limit));
                    }
                    if let Some(by_part) = rest.split(" BY ").nth(1) {
                        let step = by_part.split(|c: char| c.is_whitespace() || c == ';')
                            .next().unwrap_or("").trim();
                        props.insert("by".to_string(), serde_json::json!(step));
                    }
                    props.insert("iteration_expr".to_string(), serde_json::json!(rest.trim()));
                } else if rest.is_empty() || rest.trim() == ";" || rest.trim().is_empty() {
                    props.insert("loop_type".to_string(), serde_json::json!("simple"));
                }

                ast_nodes.push(AstNode {
                    id: format!("do-{}", stmt_start),
                    kind: AstNodeKind::Loop,
                    name: None,
                    span,
                    children: vec![],
                    properties: props,
                });
                do_loop_count += 1;
                i = next_idx;
                continue;
            }

            // ─── SELECT / WHEN / OTHERWISE / END ───
            if stmt_trimmed.starts_with("SELECT") && !stmt_trimmed.starts_with("SELECT ")
                || stmt_trimmed.starts_with("SELECT;") || stmt_trimmed.starts_with("SELECT (")
            {
                let mut props = HashMap::new();
                if let Some(expr) = Self::extract_paren(&stmt_upper, "SELECT") {
                    props.insert("expression".to_string(), serde_json::json!(expr));
                }
                ast_nodes.push(AstNode {
                    id: format!("select-{}", stmt_start),
                    kind: AstNodeKind::EvaluateStatement,
                    name: None,
                    span,
                    children: vec![],
                    properties: props,
                });
                select_count += 1;
                i = next_idx;
                continue;
            }
            if stmt_trimmed.starts_with("WHEN ") || stmt_trimmed.starts_with("WHEN(") {
                let mut props = HashMap::new();
                if let Some(cond) = Self::extract_paren(&stmt_upper, "WHEN") {
                    props.insert("condition".to_string(), serde_json::json!(cond));
                } else {
                    let cond_text = stmt_trimmed[5..].trim_end_matches(';').trim();
                    props.insert("condition".to_string(), serde_json::json!(cond_text));
                }
                ast_nodes.push(AstNode {
                    id: format!("when-{}", stmt_start),
                    kind: AstNodeKind::Condition,
                    name: None,
                    span,
                    children: vec![],
                    properties: props,
                });
                i = next_idx;
                continue;
            }
            if stmt_trimmed.starts_with("OTHERWISE") || stmt_trimmed.starts_with("OTHER") {
                ast_nodes.push(AstNode {
                    id: format!("otherwise-{}", stmt_start),
                    kind: AstNodeKind::Condition,
                    name: Some("OTHERWISE".to_string()),
                    span,
                    children: vec![],
                    properties: HashMap::from([
                        ("is_default".to_string(), serde_json::json!(true)),
                    ]),
                });
                i = next_idx;
                continue;
            }

            // ─── IF / THEN / ELSE ───
            if stmt_trimmed.starts_with("IF ") {
                let mut props = HashMap::new();
                // Extract condition: text between IF and THEN
                let cond = if let Some(then_pos) = stmt_trimmed.find(" THEN") {
                    stmt_trimmed[3..then_pos].trim().to_string()
                } else {
                    stmt_trimmed[3..].trim_end_matches(';').trim().to_string()
                };
                props.insert("condition".to_string(), serde_json::json!(cond));
                if stmt_trimmed.contains(" ELSE ") || stmt_trimmed.ends_with(" ELSE") {
                    props.insert("has_else".to_string(), serde_json::json!(true));
                }
                ast_nodes.push(AstNode {
                    id: format!("if-{}", stmt_start),
                    kind: AstNodeKind::IfStatement,
                    name: None,
                    span,
                    children: vec![],
                    properties: props,
                });
                if_count += 1;
                i = next_idx;
                continue;
            }

            // ─── GOTO / GO TO ───
            if stmt_trimmed.starts_with("GOTO ") || stmt_trimmed.starts_with("GO TO ") {
                let rest = stmt_trimmed.replacen("GOTO ", "", 1).replacen("GO TO ", "", 1);
                let target = rest.trim_end_matches(';').trim().to_string();
                ast_nodes.push(AstNode {
                    id: format!("goto-{}", stmt_start),
                    kind: AstNodeKind::GoToStatement,
                    name: Some(target.clone()),
                    span,
                    children: vec![],
                    properties: HashMap::from([
                        ("target".to_string(), serde_json::json!(target)),
                    ]),
                });
                goto_count += 1;
                i = next_idx;
                continue;
            }

            // ─── RETURN statement ───
            if stmt_trimmed.starts_with("RETURN") {
                let mut props = HashMap::new();
                if let Some(val) = Self::extract_paren(&stmt_upper, "RETURN") {
                    props.insert("value".to_string(), serde_json::json!(val));
                }
                ast_nodes.push(AstNode {
                    id: format!("return-{}", stmt_start),
                    kind: AstNodeKind::Custom("ReturnStatement".to_string()),
                    name: None,
                    span,
                    children: vec![],
                    properties: props,
                });
                return_count += 1;
                i = next_idx;
                continue;
            }

            // ─── OPEN / CLOSE (file operations) ───
            if stmt_trimmed.starts_with("OPEN ") || stmt_trimmed.starts_with("CLOSE ") {
                let verb = if stmt_trimmed.starts_with("OPEN") { "OPEN" } else { "CLOSE" };
                let rest = &stmt_trimmed[verb.len()..];
                let mut props = HashMap::new();
                props.insert("operation".to_string(), serde_json::json!(verb));
                // Extract FILE(name)
                if let Some(file_name) = Self::extract_paren(rest, "FILE") {
                    props.insert("file".to_string(), serde_json::json!(file_name));
                } else {
                    // Might be: OPEN FILE(X) or just OPEN X
                    let file_name = rest.split(|c: char| c == ';' || c.is_whitespace())
                        .filter(|s| !s.is_empty() && *s != "INPUT" && *s != "OUTPUT"
                            && *s != "UPDATE" && *s != "PRINT" && *s != "STREAM"
                            && *s != "RECORD" && *s != "DIRECT" && *s != "SEQUENTIAL"
                            && *s != "KEYED" && *s != "BUFFERED" && *s != "UNBUFFERED"
                            && *s != "ENVIRONMENT" && *s != "TITLE")
                        .next().unwrap_or("").trim().to_string();
                    if !file_name.is_empty() {
                        props.insert("file".to_string(), serde_json::json!(file_name));
                    }
                }
                // Detect OPEN mode attributes
                if stmt_upper.contains(" INPUT") { props.insert("mode".to_string(), serde_json::json!("INPUT")); }
                if stmt_upper.contains(" OUTPUT") { props.insert("mode".to_string(), serde_json::json!("OUTPUT")); }
                if stmt_upper.contains(" UPDATE") { props.insert("mode".to_string(), serde_json::json!("UPDATE")); }
                if stmt_upper.contains(" PRINT") { props.insert("mode".to_string(), serde_json::json!("PRINT")); }

                ast_nodes.push(AstNode {
                    id: format!("fileop-{}-{}", verb.to_lowercase(), stmt_start),
                    kind: AstNodeKind::Custom("FileOperation".to_string()),
                    name: props.get("file").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    span,
                    children: vec![],
                    properties: props,
                });
                file_io_count += 1;
                i = next_idx;
                continue;
            }

            // ─── READ / WRITE / REWRITE / DELETE (record I/O) ───
            if stmt_trimmed.starts_with("READ ") || stmt_trimmed.starts_with("WRITE ")
                || stmt_trimmed.starts_with("REWRITE ") || stmt_trimmed.starts_with("DELETE ")
            {
                let verb = if stmt_trimmed.starts_with("READ") { "READ" }
                    else if stmt_trimmed.starts_with("WRITE") { "WRITE" }
                    else if stmt_trimmed.starts_with("REWRITE") { "REWRITE" }
                    else { "DELETE" };
                let rest = &stmt_trimmed[verb.len()..];
                let mut props = HashMap::new();
                props.insert("operation".to_string(), serde_json::json!(verb));
                if let Some(f) = Self::extract_paren(rest, "FILE") {
                    props.insert("file".to_string(), serde_json::json!(f));
                }
                if let Some(v) = Self::extract_paren(rest, "INTO") {
                    props.insert("into".to_string(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_paren(rest, "FROM") {
                    props.insert("from".to_string(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_paren(rest, "SET") {
                    props.insert("set".to_string(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_paren(rest, "KEY") {
                    props.insert("key".to_string(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_paren(rest, "KEYTO") {
                    props.insert("keyto".to_string(), serde_json::json!(v));
                }
                if stmt_upper.contains("IGNORE") {
                    if let Some(n) = Self::extract_paren(&stmt_upper, "IGNORE") {
                        props.insert("ignore".to_string(), serde_json::json!(n));
                    }
                }
                ast_nodes.push(AstNode {
                    id: format!("{}-{}", verb.to_lowercase(), stmt_start),
                    kind: if verb == "READ" { AstNodeKind::ReadStatement }
                        else if verb == "WRITE" { AstNodeKind::WriteStatement }
                        else { AstNodeKind::Custom(format!("{}Statement", verb)) },
                    name: props.get("file").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    span,
                    children: vec![],
                    properties: props,
                });
                file_io_count += 1;
                i = next_idx;
                continue;
            }

            // ─── GET / PUT (stream I/O) ───
            if stmt_trimmed.starts_with("GET ") || stmt_trimmed.starts_with("PUT ") {
                let verb = if stmt_trimmed.starts_with("GET") { "GET" } else { "PUT" };
                let rest = &stmt_trimmed[verb.len()..];
                let mut props = HashMap::new();
                props.insert("operation".to_string(), serde_json::json!(verb));
                if let Some(f) = Self::extract_paren(rest, "FILE") {
                    props.insert("file".to_string(), serde_json::json!(f));
                }
                // Stream I/O format: EDIT, LIST, DATA
                if rest.contains("EDIT") {
                    props.insert("format".to_string(), serde_json::json!("EDIT"));
                } else if rest.contains("LIST") {
                    props.insert("format".to_string(), serde_json::json!("LIST"));
                } else if rest.contains("DATA") {
                    props.insert("format".to_string(), serde_json::json!("DATA"));
                }
                if stmt_upper.contains(" SKIP") {
                    props.insert("skip".to_string(), serde_json::json!(true));
                }
                if stmt_upper.contains(" STRING") {
                    props.insert("string_io".to_string(), serde_json::json!(true));
                }
                ast_nodes.push(AstNode {
                    id: format!("{}-{}", verb.to_lowercase(), stmt_start),
                    kind: AstNodeKind::Custom(format!("{}Statement", verb)),
                    name: None,
                    span,
                    children: vec![],
                    properties: props,
                });
                file_io_count += 1;
                i = next_idx;
                continue;
            }

            // ─── ALLOCATE / FREE (dynamic storage) ───
            if stmt_trimmed.starts_with("ALLOCATE ") || stmt_trimmed.starts_with("ALLOC ") {
                let prefix_len = if stmt_trimmed.starts_with("ALLOCATE") { 9 } else { 6 };
                let target = stmt_trimmed[prefix_len..].split(|c: char| c == ';' || c.is_whitespace() || c == '(')
                    .next().unwrap_or("").trim().to_string();
                let mut props = HashMap::new();
                props.insert("target".to_string(), serde_json::json!(target));
                if let Some(set_ptr) = Self::extract_paren(&stmt_upper, "SET") {
                    props.insert("set".to_string(), serde_json::json!(set_ptr));
                }
                if let Some(init_val) = Self::extract_paren(&stmt_upper, "INIT") {
                    props.insert("initial".to_string(), serde_json::json!(init_val));
                }
                ast_nodes.push(AstNode {
                    id: format!("allocate-{}", stmt_start),
                    kind: AstNodeKind::Custom("AllocateStatement".to_string()),
                    name: Some(target),
                    span,
                    children: vec![],
                    properties: props,
                });
                allocate_count += 1;
                i = next_idx;
                continue;
            }
            if stmt_trimmed.starts_with("FREE ") {
                let target = stmt_trimmed[5..].split(|c: char| c == ';' || c.is_whitespace())
                    .next().unwrap_or("").trim().to_string();
                ast_nodes.push(AstNode {
                    id: format!("free-{}", stmt_start),
                    kind: AstNodeKind::Custom("FreeStatement".to_string()),
                    name: Some(target),
                    span,
                    children: vec![],
                    properties: HashMap::new(),
                });
                allocate_count += 1;
                i = next_idx;
                continue;
            }

            // ─── ON condition (error/event handlers) ───
            if stmt_trimmed.starts_with("ON ") {
                let rest = &stmt_trimmed[3..];
                let mut props = HashMap::new();

                // ON conditions: ENDFILE(file), CONVERSION, ERROR, SIZE, ZERODIVIDE,
                // OVERFLOW, UNDERFLOW, STRINGRANGE, STRINGSIZE, SUBSCRIPTRANGE,
                // UNDEFINEDFILE(file), KEY(file), RECORD(file), TRANSMIT(file),
                // AREA, ATTENTION, CONDITION(name), FINISH, STORAGE, NAME(file)
                let condition_keywords = [
                    "ENDFILE", "CONVERSION", "ERROR", "SIZE", "ZERODIVIDE",
                    "OVERFLOW", "UNDERFLOW", "STRINGRANGE", "STRINGSIZE",
                    "SUBSCRIPTRANGE", "UNDEFINEDFILE", "KEY", "RECORD",
                    "TRANSMIT", "AREA", "ATTENTION", "CONDITION", "FINISH",
                    "STORAGE", "NAME", "FIXEDOVERFLOW", "FOFL",
                ];
                let first_word = rest.split(|c: char| c == '(' || c.is_whitespace() || c == ';')
                    .next().unwrap_or("").trim();
                let is_on_condition = condition_keywords.iter()
                    .any(|kw| first_word == *kw);

                if is_on_condition || rest.trim_start().starts_with("ENDFILE")
                    || rest.trim_start().starts_with("ERROR")
                {
                    props.insert("condition".to_string(), serde_json::json!(first_word));
                    // Extract file/condition argument if present: ON ENDFILE(INFILE)
                    if let Some(arg) = Self::extract_paren(rest, first_word) {
                        props.insert("argument".to_string(), serde_json::json!(arg));
                    }
                    // Check for SNAP option
                    if stmt_upper.contains(" SNAP") {
                        props.insert("snap".to_string(), serde_json::json!(true));
                    }
                    // Check for SYSTEM option
                    if stmt_upper.contains(" SYSTEM") {
                        props.insert("system".to_string(), serde_json::json!(true));
                    }
                    ast_nodes.push(AstNode {
                        id: format!("on-{}", stmt_start),
                        kind: AstNodeKind::Custom("OnUnit".to_string()),
                        name: Some(first_word.to_string()),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    on_unit_count += 1;
                    i = next_idx;
                    continue;
                }
            }

            // ─── SIGNAL condition ───
            if stmt_trimmed.starts_with("SIGNAL ") {
                let condition = stmt_trimmed[7..].split(|c: char| c == ';' || c == '(')
                    .next().unwrap_or("").trim().to_string();
                let mut props = HashMap::new();
                props.insert("condition".to_string(), serde_json::json!(condition));
                if let Some(arg) = Self::extract_paren(&stmt_upper, &condition) {
                    props.insert("argument".to_string(), serde_json::json!(arg));
                }
                ast_nodes.push(AstNode {
                    id: format!("signal-{}", stmt_start),
                    kind: AstNodeKind::Custom("SignalStatement".to_string()),
                    name: Some(condition),
                    span,
                    children: vec![],
                    properties: props,
                });
                signal_count += 1;
                i = next_idx;
                continue;
            }

            // ─── BEGIN / END blocks ───
            if stmt_trimmed.starts_with("BEGIN") && (stmt_trimmed.len() == 5
                || stmt_trimmed.as_bytes().get(5).map(|&b| b == b';' || b == b' ').unwrap_or(true))
            {
                let mut props = HashMap::new();
                if stmt_upper.contains("ORDER") { props.insert("order".to_string(), serde_json::json!(true)); }
                if stmt_upper.contains("REORDER") { props.insert("reorder".to_string(), serde_json::json!(true)); }
                ast_nodes.push(AstNode {
                    id: format!("begin-{}", stmt_start),
                    kind: AstNodeKind::Block,
                    name: None,
                    span,
                    children: vec![],
                    properties: props,
                });
                begin_block_count += 1;
                i = next_idx;
                continue;
            }

            // ─── END statement ───
            if stmt_trimmed == "END" || stmt_trimmed.starts_with("END ") || stmt_trimmed.starts_with("END;") {
                let label = if stmt_trimmed.len() > 4 {
                    let rest = stmt_trimmed[3..].trim().trim_end_matches(';').trim();
                    if !rest.is_empty() { Some(rest.to_string()) } else { None }
                } else { None };
                ast_nodes.push(AstNode {
                    id: format!("end-{}", stmt_start),
                    kind: AstNodeKind::Custom("EndStatement".to_string()),
                    name: label,
                    span,
                    children: vec![],
                    properties: HashMap::new(),
                });
                i = next_idx;
                continue;
            }

            // Default: advance to next line (for assignments, expressions, etc.)
            i = next_idx;
        }

        // ─── Build metadata ───
        let mut metadata = HashMap::new();
        metadata.insert("procedure_count".to_string(), serde_json::json!(procedure_count));
        metadata.insert("variable_count".to_string(), serde_json::json!(variable_count));
        metadata.insert("structure_count".to_string(), serde_json::json!(structure_count));
        metadata.insert("call_count".to_string(), serde_json::json!(call_count));
        metadata.insert("sql_block_count".to_string(), serde_json::json!(sql_block_count));
        metadata.insert("on_unit_count".to_string(), serde_json::json!(on_unit_count));
        metadata.insert("file_io_count".to_string(), serde_json::json!(file_io_count));
        metadata.insert("include_count".to_string(), serde_json::json!(include_count));
        metadata.insert("goto_count".to_string(), serde_json::json!(goto_count));
        metadata.insert("do_loop_count".to_string(), serde_json::json!(do_loop_count));
        metadata.insert("select_count".to_string(), serde_json::json!(select_count));
        metadata.insert("if_count".to_string(), serde_json::json!(if_count));
        metadata.insert("begin_block_count".to_string(), serde_json::json!(begin_block_count));
        metadata.insert("return_count".to_string(), serde_json::json!(return_count));
        metadata.insert("allocate_free_count".to_string(), serde_json::json!(allocate_count));
        metadata.insert("signal_count".to_string(), serde_json::json!(signal_count));
        metadata.insert("fetch_count".to_string(), serde_json::json!(fetch_count));
        metadata.insert("total_ast_nodes".to_string(), serde_json::json!(ast_nodes.len()));
        metadata.insert("total_symbols".to_string(), serde_json::json!(symbols.len()));
        if !builtin_usages.is_empty() {
            metadata.insert("builtin_usages".to_string(), serde_json::json!(builtin_usages));
        }
        if !call_targets.is_empty() {
            metadata.insert("call_targets".to_string(), serde_json::json!(call_targets));
        }
        if !include_refs.is_empty() {
            metadata.insert("include_refs".to_string(), serde_json::json!(include_refs));
        }

        // Detect dialect
        let dialect = if source.content.to_uppercase().contains("FETCH ") ||
            source.content.to_uppercase().contains("THREAD") {
            "PL/I-Enterprise"
        } else {
            "PL/I-Open"
        };
        metadata.insert("dialect".to_string(), serde_json::json!(dialect));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: dialect.to_string(),
            source_path: source.path.to_string_lossy().to_string(),
            total_lines: source.content.lines().count(),
            ast_nodes,
            symbols,
            embedded_blocks,
            diagnostics,
            metadata,
        })
    }

    fn parse_partial(&self, source: &SourceFile) -> anyhow::Result<PartialParseOutput> {
        match self.parse(source) {
            Ok(output) => {
                let total = output.total_lines;
                Ok(PartialParseOutput {
                    output, parsed_up_to_line: total, error: String::new(), coverage: 1.0,
                })
            }
            Err(e) => Ok(PartialParseOutput {
                output: ParseOutput {
                    language_id: self.language_id().to_string(),
                    dialect: "PL/I-Enterprise".to_string(),
                    source_path: source.path.to_string_lossy().to_string(),
                    total_lines: source.content.lines().count(),
                    ast_nodes: vec![], symbols: vec![], embedded_blocks: vec![],
                    diagnostics: vec![Diagnostic {
                        severity: DiagnosticSeverity::Error,
                        message: e.to_string(),
                        span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                        code: None,
                    }],
                    metadata: HashMap::new(),
                },
                parsed_up_to_line: 0, error: e.to_string(), coverage: 0.0,
            }),
        }
    }

    fn resolve_dependencies(&self, module: &ParseOutput, _vault: &SourceVault) -> Vec<DependencyRef> {
        let mut deps = Vec::new();

        for node in &module.ast_nodes {
            match &node.kind {
                // %INCLUDE references
                AstNodeKind::CopyStatement => {
                    if let Some(name) = &node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::CopyInclude,
                            source_span: node.span,
                            reference_text: format!("%INCLUDE {}", name),
                        });
                    }
                }
                // CALL targets
                AstNodeKind::CallStatement => {
                    if let Some(name) = &node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::ProgramCall,
                            source_span: node.span,
                            reference_text: format!("CALL {}", name),
                        });
                    }
                }
                // FETCH targets (dynamic program loading)
                AstNodeKind::Custom(s) if s == "FetchStatement" => {
                    if let Some(name) = &node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::ProgramCall,
                            source_span: node.span,
                            reference_text: format!("FETCH {}", name),
                        });
                    }
                }
                // EXEC SQL blocks
                AstNodeKind::ExecSqlBlock => {
                    deps.push(DependencyRef {
                        from_module: module.source_path.clone(),
                        to_module: "SQL".to_string(),
                        dependency_type: DependencyType::DatabaseAccess,
                        source_span: node.span,
                        reference_text: format!("EXEC SQL block at line {}", node.span.start_line),
                    });
                }
                // File I/O operations
                AstNodeKind::ReadStatement | AstNodeKind::WriteStatement => {
                    if let Some(name) = &node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::FileAccess,
                            source_span: node.span,
                            reference_text: format!("File I/O on {}", name),
                        });
                    }
                }
                AstNodeKind::Custom(s) if s == "FileOperation" || s == "RewriteStatement" || s == "DeleteStatement" => {
                    if let Some(name) = &node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::FileAccess,
                            source_span: node.span,
                            reference_text: format!("File operation on {}", name),
                        });
                    }
                }
                _ => {}
            }
        }

        deps
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();

        // Create nodes for procedures
        let mut prev_proc: Option<String> = None;
        for symbol in &output.symbols {
            if matches!(symbol.kind, SymbolKind::Procedure) {
                let node_id = format!("proc-{}", symbol.name);
                let is_main = symbol.properties.get("is_main")
                    .and_then(|v| v.as_bool()).unwrap_or(false);
                nodes.push(AnalysisNode {
                    id: node_id.clone(),
                    kind: if is_main { AnalysisNodeKind::EntryPoint } else { AnalysisNodeKind::BusinessRule },
                    name: symbol.name.clone(),
                    source_span: symbol.span,
                    properties: HashMap::new(),
                });
                // Sequential flow between procedures
                if let Some(ref prev) = prev_proc {
                    edges.push(AnalysisEdge {
                        from: prev.clone(), to: node_id.clone(),
                        kind: AnalysisEdgeKind::ControlFlow,
                        label: Some("sequential".to_string()),
                    });
                }
                prev_proc = Some(node_id);
            }
        }

        // Create nodes and edges for CALL statements
        for node in &output.ast_nodes {
            match &node.kind {
                AstNodeKind::CallStatement => {
                    if let Some(target) = &node.name {
                        let call_node_id = format!("call-{}-{}", target, node.span.start_line);
                        let ext_node_id = format!("ext-{}", target);
                        nodes.push(AnalysisNode {
                            id: ext_node_id.clone(),
                            kind: AnalysisNodeKind::ExternalCall,
                            name: format!("CALL {}", target),
                            source_span: node.span,
                            properties: HashMap::new(),
                        });
                        // Find enclosing procedure and create edge
                        let caller = self.find_enclosing_proc(output, node.span.start_line);
                        edges.push(AnalysisEdge {
                            from: caller.unwrap_or_else(|| call_node_id),
                            to: ext_node_id,
                            kind: AnalysisEdgeKind::CallsInto,
                            label: Some("CALL".to_string()),
                        });
                    }
                }
                AstNodeKind::ExecSqlBlock => {
                    let db_node_id = format!("db-sql-{}", node.span.start_line);
                    nodes.push(AnalysisNode {
                        id: db_node_id.clone(),
                        kind: AnalysisNodeKind::DatabaseOperation,
                        name: format!("EXEC SQL at line {}", node.span.start_line),
                        source_span: node.span,
                        properties: HashMap::new(),
                    });
                    let caller = self.find_enclosing_proc(output, node.span.start_line);
                    if let Some(caller_id) = caller {
                        edges.push(AnalysisEdge {
                            from: caller_id, to: db_node_id,
                            kind: AnalysisEdgeKind::ReadsFrom,
                            label: Some("SQL".to_string()),
                        });
                    }
                }
                AstNodeKind::ReadStatement | AstNodeKind::WriteStatement => {
                    if let Some(file_name) = &node.name {
                        let file_node_id = format!("file-{}", file_name);
                        nodes.push(AnalysisNode {
                            id: file_node_id.clone(),
                            kind: AnalysisNodeKind::FileOperation,
                            name: format!("File {}", file_name),
                            source_span: node.span,
                            properties: HashMap::new(),
                        });
                        let caller = self.find_enclosing_proc(output, node.span.start_line);
                        let edge_kind = if matches!(node.kind, AstNodeKind::ReadStatement) {
                            AnalysisEdgeKind::ReadsFrom
                        } else {
                            AnalysisEdgeKind::WritesTo
                        };
                        if let Some(caller_id) = caller {
                            edges.push(AnalysisEdge {
                                from: caller_id, to: file_node_id,
                                kind: edge_kind,
                                label: Some(if matches!(node.kind, AstNodeKind::ReadStatement) {
                                    "READ".to_string()
                                } else {
                                    "WRITE".to_string()
                                }),
                            });
                        }
                    }
                }
                AstNodeKind::Custom(s) if s == "OnUnit" => {
                    if let Some(condition) = &node.name {
                        let handler_id = format!("on-{}-{}", condition, node.span.start_line);
                        nodes.push(AnalysisNode {
                            id: handler_id,
                            kind: AnalysisNodeKind::ErrorHandler,
                            name: format!("ON {}", condition),
                            source_span: node.span,
                            properties: HashMap::new(),
                        });
                    }
                }
                AstNodeKind::Custom(s) if s == "FetchStatement" => {
                    if let Some(target) = &node.name {
                        let ext_id = format!("fetch-{}", target);
                        nodes.push(AnalysisNode {
                            id: ext_id.clone(),
                            kind: AnalysisNodeKind::ExternalCall,
                            name: format!("FETCH {}", target),
                            source_span: node.span,
                            properties: HashMap::new(),
                        });
                        let caller = self.find_enclosing_proc(output, node.span.start_line);
                        if let Some(caller_id) = caller {
                            edges.push(AnalysisEdge {
                                from: caller_id, to: ext_id,
                                kind: AnalysisEdgeKind::CallsInto,
                                label: Some("FETCH".to_string()),
                            });
                        }
                    }
                }
                _ => {}
            }
        }

        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes,
            edges,
            business_rules: vec![],
            data_flows: vec![],
        })
    }
}

// ─── Private helpers (not part of the trait) ────────────────────

impl PliParser {
    /// Parse a structure-level DCL statement: DCL 1 RECORD, 2 FIELD1 CHAR(10), ...
    /// Handles both comma-separated single-line and multi-line structures.
    fn parse_structure_dcl(
        &self,
        rest: &str,
        stmt_start: usize,
        stmt_end: usize,
        ast_nodes: &mut Vec<AstNode>,
        symbols: &mut Vec<Symbol>,
        structure_count: &mut usize,
        variable_count: &mut usize,
    ) {
        let span = Span { start_line: stmt_start, start_col: 0, end_line: stmt_end, end_col: 80 };

        // Split by comma to get individual members
        // Each member: "level_number name type_attrs"
        let members: Vec<&str> = rest.split(',').collect();
        let mut parent_name = String::new();

        for member in &members {
            let trimmed = member.trim().trim_end_matches(';').trim();
            if trimmed.is_empty() { continue; }

            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            if tokens.is_empty() { continue; }

            // First token should be a level number
            if let Ok(level) = tokens[0].parse::<u8>() {
                if level >= 1 && level <= 99 {
                    let field_name = tokens.get(1).unwrap_or(&"FILLER").to_string();
                    let type_rest = if tokens.len() > 2 {
                        tokens[2..].join(" ")
                    } else {
                        String::new()
                    };
                    let data_type = Self::detect_data_type(&type_rest);
                    let is_group = data_type.is_none() && level < 99;

                    if level == 1 {
                        parent_name = field_name.clone();
                        *structure_count += 1;
                    }

                    let mut props = HashMap::new();
                    props.insert("level".to_string(), serde_json::json!(level));
                    if !parent_name.is_empty() && level > 1 {
                        props.insert("parent_structure".to_string(), serde_json::json!(parent_name));
                    }
                    if let Some(ref dt) = data_type {
                        props.insert("data_type".to_string(), serde_json::json!(dt));
                    }
                    if is_group {
                        props.insert("is_group".to_string(), serde_json::json!(true));
                    }

                    let node_kind = if is_group {
                        AstNodeKind::DataGroup
                    } else {
                        AstNodeKind::DataDeclaration
                    };

                    ast_nodes.push(AstNode {
                        id: format!("struct-{}-{}-{}", level, stmt_start, field_name),
                        kind: node_kind,
                        name: Some(field_name.clone()),
                        span,
                        children: vec![],
                        properties: props,
                    });

                    symbols.push(Symbol {
                        name: field_name,
                        kind: if is_group { SymbolKind::DataItem } else { SymbolKind::Variable },
                        span,
                        visibility: Visibility::Internal,
                        data_type,
                        properties: HashMap::from([
                            ("level".to_string(), serde_json::json!(level)),
                        ]),
                    });
                    *variable_count += 1;
                }
            }
        }
    }

    /// Find the enclosing procedure name for a given line number.
    /// Returns the analysis graph node ID for the procedure.
    fn find_enclosing_proc(&self, output: &ParseOutput, line: usize) -> Option<String> {
        let mut best: Option<(&Symbol, usize)> = None;
        for sym in &output.symbols {
            if matches!(sym.kind, SymbolKind::Procedure) && sym.span.start_line <= line {
                let dist = line - sym.span.start_line;
                if best.is_none() || dist < best.unwrap().1 {
                    best = Some((sym, dist));
                }
            }
        }
        best.map(|(sym, _)| format!("proc-{}", sym.name))
    }
}
