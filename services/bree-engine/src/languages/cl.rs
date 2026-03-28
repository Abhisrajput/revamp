//! CL (IBM i Control Language) parser — deep structural parser.
//!
//! Handles CLP/CLLE programs with full extraction:
//!   - PGM/ENDPGM program boundaries with parameter lists
//!   - DCL VAR and DCLF (file declarations) with TYPE/LEN
//!   - CHGVAR variable assignments
//!   - IF/THEN/ELSE/ENDIF conditional logic
//!   - DO/ENDDO loop constructs
//!   - GOTO label references and label definitions
//!   - MONMSG error monitoring with MSGID and EXEC()
//!   - CALL/CALLPRC program/procedure calls
//!   - SNDPGMMSG/SNDBRKMSG message sending
//!   - OVRDBF/DLTOVR file overrides
//!   - SBMJOB job submission with CMD() extraction
//!   - RTVJOBA/RTVMBRD/RTVDTAARA retrieve system values
//!   - ADDLIBLE/RMVLIBLE library list manipulation
//!   - CPYF file copy with FROMFILE/TOFILE
//!   - RCVMSG receive message
//!   - OPNQRYF/CLOF query file operations
//!   - DLYJOB delay job
//!   - DSPFFD display file field descriptions
//!   - Labels (GOTO targets) and continuation lines (+ suffix/prefix)

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct ClParser;

impl ClParser {
    pub fn new() -> Self { Self }

    /// Extract value of a named parameter from a CL command string.
    /// e.g. extract_parm("DCL VAR(&X) TYPE(*CHAR) LEN(10)", "TYPE") => Some("*CHAR")
    fn extract_parm(upper: &str, parm_name: &str) -> Option<String> {
        let needle = format!("{}(", parm_name);
        let start = upper.find(&needle)?;
        let after = &upper[start + needle.len()..];
        // Handle nested parens: find matching close paren
        let mut depth = 1usize;
        let mut end = 0;
        for (i, ch) in after.char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 { end = i; break; }
                }
                _ => {}
            }
        }
        if end > 0 {
            Some(after[..end].to_string())
        } else {
            // No closing paren found — take everything until whitespace or EOL
            let fallback = after.split_whitespace().next().unwrap_or("").trim_end_matches(')');
            if fallback.is_empty() { None } else { Some(fallback.to_string()) }
        }
    }

    /// Extract all &VAR references from a parameter value.
    fn extract_var_refs(value: &str) -> Vec<String> {
        let mut refs = Vec::new();
        let mut i = 0;
        let bytes = value.as_bytes();
        while i < bytes.len() {
            if bytes[i] == b'&' {
                let start = i;
                i += 1;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                if i > start + 1 {
                    refs.push(value[start..i].to_string());
                }
            } else {
                i += 1;
            }
        }
        refs
    }

    /// Parse PGM PARM() list: PARM(&A &B &C) => ["&A", "&B", "&C"]
    fn extract_pgm_parms(upper: &str) -> Vec<String> {
        if let Some(parm_val) = Self::extract_parm(upper, "PARM") {
            parm_val.split_whitespace()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            vec![]
        }
    }

    /// Join continuation lines. CL uses + at end-of-line or start-of-next-line.
    /// Returns Vec<(original_start_line, joined_upper_content, joined_raw_content)>.
    fn join_continuations(content: &str) -> Vec<(usize, String, String)> {
        let raw_lines: Vec<&str> = content.lines().collect();
        let mut result: Vec<(usize, String, String)> = Vec::new();
        let mut i = 0;

        while i < raw_lines.len() {
            let line = raw_lines[i];
            let trimmed = line.trim();

            // Skip pure comment lines (start with /*)
            if trimmed.starts_with("/*") {
                i += 1;
                continue;
            }

            // Strip inline comments: everything from /* onwards (outside quotes)
            let effective = Self::strip_inline_comment(trimmed);

            if effective.is_empty() {
                i += 1;
                continue;
            }

            let start_line = i;
            let mut accumulated = effective.to_string();

            // Handle continuation: line ends with + or - (CL continuation chars)
            while accumulated.ends_with('+') || accumulated.ends_with('-') {
                // Remove the continuation character
                let cont_char = accumulated.pop().unwrap();
                // + means strip leading blanks of next line, - means preserve
                i += 1;
                if i >= raw_lines.len() { break; }
                let next = raw_lines[i].trim();
                // Skip comment-only continuation lines
                if next.starts_with("/*") { continue; }
                let next_eff = Self::strip_inline_comment(next);
                if cont_char == '+' {
                    accumulated.push_str(next_eff.trim_start());
                } else {
                    accumulated.push_str(&next_eff);
                }
            }

            let upper = accumulated.trim().to_uppercase();
            if !upper.is_empty() {
                result.push((start_line, upper, accumulated.trim().to_string()));
            }
            i += 1;
        }
        result
    }

    /// Strip inline comment (/* ... */) from a line, respecting quotes.
    fn strip_inline_comment(line: &str) -> &str {
        let mut in_quote = false;
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                in_quote = !in_quote;
            } else if !in_quote && i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
                return line[..i].trim_end();
            }
            i += 1;
        }
        line
    }

    /// Detect dialect from source content.
    fn detect_dialect(content: &str) -> &'static str {
        let upper = content.to_uppercase();
        // CLLE (ILE CL) indicators: CALLPRC, DCLPRCOPT, SUBR, ENDSUBR, DCLF with OPNID
        if upper.contains("CALLPRC ") || upper.contains("DCLPRCOPT")
            || upper.contains("SUBR ") || upper.contains("ENDSUBR") {
            return "CLLE";
        }
        "CLP"
    }

    /// Increment a counter in the metadata map.
    fn inc_meta(meta: &mut HashMap<String, serde_json::Value>, key: &str) {
        let count = meta.entry(key.to_string())
            .or_insert_with(|| serde_json::json!(0))
            .as_u64().unwrap_or(0);
        meta.insert(key.to_string(), serde_json::json!(count + 1));
    }
}

impl LanguageParser for ClParser {
    fn language_id(&self) -> &'static str { "cl" }
    fn display_name(&self) -> &'static str { "CL (IBM i Control Language)" }
    fn supported_dialects(&self) -> &[&'static str] { &["CLP", "CLLE"] }
    fn file_extensions(&self) -> &[&'static str] { &["clp", "clp38", "clle", "cl"] }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let content_match = (upper.contains("PGM") && upper.contains("ENDPGM"))
            || upper.contains("DCL ")
            || upper.contains("DCLF ")
            || upper.contains("CHGVAR ")
            || upper.contains("SNDPGMMSG ")
            || upper.contains("MONMSG ")
            || upper.contains("CALL ")
            || upper.contains("CALLPRC ");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut symbols: Vec<Symbol> = Vec::new();
        let mut ast_nodes: Vec<AstNode> = Vec::new();
        let mut diagnostics: Vec<Diagnostic> = Vec::new();
        let mut metadata: HashMap<String, serde_json::Value> = HashMap::new();
        let total_lines = source.content.lines().count();
        let dialect = Self::detect_dialect(&source.content);

        // Join continuation lines before parsing
        let lines = Self::join_continuations(&source.content);

        // Track program boundary for nesting
        let mut pgm_start_line: Option<usize> = None;
        let mut pgm_parms: Vec<String> = Vec::new();
        let mut if_depth: usize = 0;
        let mut do_depth: usize = 0;
        let mut node_counter: usize = 0;

        // Helper closure replacement — we use node_counter for unique IDs
        let mut next_id = |prefix: &str, line: usize| -> String {
            node_counter += 1;
            format!("{}-{}-{}", prefix, line, node_counter)
        };

        for &(line_num, ref upper, ref raw) in &lines {
            let line_len = raw.len();
            let span = Span {
                start_line: line_num,
                start_col: 0,
                end_line: line_num,
                end_col: line_len,
            };

            // ── Labels: "LABEL:" at start of line (GOTO targets) ──
            // Labels appear as IDENTIFIER: at the very beginning, before any command
            if let Some(colon_pos) = upper.find(':') {
                let candidate = upper[..colon_pos].trim();
                // A valid label is purely alphanumeric/underscore, not a CL keyword with parens
                if !candidate.is_empty()
                    && candidate.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    && colon_pos + 1 < upper.len()
                    && !candidate.starts_with('&')
                    // Exclude things that look like commands by checking if remainder is a command
                    && !["IF", "DO", "DCL", "PGM", "ENDPGM", "CHGVAR", "GOTO", "CALL", "MONMSG"].contains(&candidate)
                {
                    let label_name = candidate.to_string();
                    symbols.push(Symbol {
                        name: label_name.clone(),
                        kind: SymbolKind::Custom("Label".to_string()),
                        span,
                        visibility: Visibility::Internal,
                        data_type: None,
                        properties: HashMap::from([
                            ("label_type".to_string(), serde_json::json!("goto_target")),
                        ]),
                    });
                    ast_nodes.push(AstNode {
                        id: next_id("label", line_num),
                        kind: AstNodeKind::Custom("Label".to_string()),
                        name: Some(label_name),
                        span,
                        children: vec![],
                        properties: HashMap::new(),
                    });
                    Self::inc_meta(&mut metadata, "label_count");
                    // The rest of the line after the label may contain a command;
                    // we continue to parse the full upper line which includes it.
                }
            }

            // Determine the command keyword — first token after optional label
            let cmd_upper = if let Some(colon_pos) = upper.find(':') {
                let candidate = upper[..colon_pos].trim();
                if !candidate.is_empty()
                    && candidate.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    && !candidate.starts_with('&')
                {
                    upper[colon_pos + 1..].trim_start()
                } else {
                    upper.as_str()
                }
            } else {
                upper.as_str()
            };

            let first_token = cmd_upper.split_whitespace().next().unwrap_or("")
                .split('(').next().unwrap_or("");

            match first_token {
                // ── PGM — Program boundary ──
                "PGM" => {
                    pgm_start_line = Some(line_num);
                    pgm_parms = Self::extract_pgm_parms(cmd_upper);
                    let parm_json: Vec<serde_json::Value> = pgm_parms.iter()
                        .map(|p| serde_json::json!(p))
                        .collect();
                    ast_nodes.push(AstNode {
                        id: next_id("pgm", line_num),
                        kind: AstNodeKind::Module,
                        name: Some("PGM".to_string()),
                        span,
                        children: vec![],
                        properties: HashMap::from([
                            ("parameters".to_string(), serde_json::json!(parm_json)),
                            ("parameter_count".to_string(), serde_json::json!(pgm_parms.len())),
                        ]),
                    });
                    // Register each PGM parameter as a symbol
                    for parm in &pgm_parms {
                        symbols.push(Symbol {
                            name: parm.clone(),
                            kind: SymbolKind::Variable,
                            span,
                            visibility: Visibility::Public,
                            data_type: None,
                            properties: HashMap::from([
                                ("source".to_string(), serde_json::json!("pgm_parm")),
                            ]),
                        });
                    }
                    Self::inc_meta(&mut metadata, "pgm_count");
                }

                // ── ENDPGM — Program end ──
                "ENDPGM" => {
                    if let Some(start) = pgm_start_line {
                        // Update the PGM node span to cover the whole program
                        if let Some(pgm_node) = ast_nodes.iter_mut().find(|n| {
                            n.kind == AstNodeKind::Module && n.span.start_line == start
                        }) {
                            pgm_node.span.end_line = line_num;
                            pgm_node.span.end_col = line_len;
                        }
                    }
                    pgm_start_line = None;
                }

                // ── DCL — Variable declaration ──
                "DCL" => {
                    let var_name = Self::extract_parm(cmd_upper, "VAR")
                        .unwrap_or_default();
                    let dcl_type = Self::extract_parm(cmd_upper, "TYPE")
                        .unwrap_or_default();
                    let dcl_len = Self::extract_parm(cmd_upper, "LEN")
                        .unwrap_or_default();
                    let dcl_value = Self::extract_parm(cmd_upper, "VALUE");

                    let data_type_str = if !dcl_type.is_empty() && !dcl_len.is_empty() {
                        Some(format!("{} LEN({})", dcl_type, dcl_len))
                    } else if !dcl_type.is_empty() {
                        Some(dcl_type.clone())
                    } else {
                        None
                    };

                    if !var_name.is_empty() {
                        let mut props = HashMap::new();
                        if !dcl_type.is_empty() {
                            props.insert("type".to_string(), serde_json::json!(dcl_type));
                        }
                        if !dcl_len.is_empty() {
                            props.insert("length".to_string(), serde_json::json!(dcl_len));
                        }
                        if let Some(ref val) = dcl_value {
                            props.insert("initial_value".to_string(), serde_json::json!(val));
                        }
                        props.insert("decl_kind".to_string(), serde_json::json!("VAR"));

                        symbols.push(Symbol {
                            name: var_name.clone(),
                            kind: SymbolKind::Variable,
                            span,
                            visibility: Visibility::Internal,
                            data_type: data_type_str.clone(),
                            properties: props.clone(),
                        });
                        ast_nodes.push(AstNode {
                            id: next_id("dcl-var", line_num),
                            kind: AstNodeKind::DataDeclaration,
                            name: Some(var_name),
                            span,
                            children: vec![],
                            properties: props,
                        });
                        Self::inc_meta(&mut metadata, "dcl_var_count");
                    }
                }

                // ── DCLF — File declaration ──
                "DCLF" => {
                    let file_name = Self::extract_parm(cmd_upper, "FILE")
                        .or_else(|| {
                            // DCLF FILE(name) or just DCLF name
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                        })
                        .unwrap_or_default();
                    let opnid = Self::extract_parm(cmd_upper, "OPNID");

                    if !file_name.is_empty() {
                        let mut props = HashMap::new();
                        props.insert("decl_kind".to_string(), serde_json::json!("FILE"));
                        if let Some(ref id) = opnid {
                            props.insert("opnid".to_string(), serde_json::json!(id));
                        }

                        symbols.push(Symbol {
                            name: file_name.clone(),
                            kind: SymbolKind::FileDescription,
                            span,
                            visibility: Visibility::Internal,
                            data_type: Some("FILE".to_string()),
                            properties: props.clone(),
                        });
                        ast_nodes.push(AstNode {
                            id: next_id("dclf", line_num),
                            kind: AstNodeKind::FileDeclaration,
                            name: Some(file_name),
                            span,
                            children: vec![],
                            properties: props,
                        });
                        Self::inc_meta(&mut metadata, "dclf_count");
                    }
                }

                // ── CHGVAR — Variable assignment ──
                "CHGVAR" => {
                    let target_var = Self::extract_parm(cmd_upper, "VAR")
                        .unwrap_or_default();
                    let value_expr = Self::extract_parm(cmd_upper, "VALUE")
                        .unwrap_or_default();

                    let mut props = HashMap::new();
                    props.insert("target".to_string(), serde_json::json!(target_var));
                    props.insert("value".to_string(), serde_json::json!(value_expr));

                    // Track variable references in the VALUE expression
                    let refs = Self::extract_var_refs(&value_expr);
                    if !refs.is_empty() {
                        props.insert("referenced_vars".to_string(), serde_json::json!(refs));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("chgvar", line_num),
                        kind: AstNodeKind::Assignment,
                        name: Some(target_var),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "chgvar_count");
                }

                // ── IF — Conditional statement ──
                "IF" => {
                    if_depth += 1;
                    let cond = Self::extract_parm(cmd_upper, "COND")
                        .unwrap_or_else(|| {
                            // IF COND(...) or IF (...)  — extract the condition
                            if let Some(paren_start) = cmd_upper.find('(') {
                                let after = &cmd_upper[paren_start + 1..];
                                // Find matching close paren
                                let mut depth = 1usize;
                                for (i, ch) in after.char_indices() {
                                    match ch {
                                        '(' => depth += 1,
                                        ')' => {
                                            depth -= 1;
                                            if depth == 0 { return after[..i].to_string(); }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            String::new()
                        });
                    let then_cmd = Self::extract_parm(cmd_upper, "THEN");

                    let mut props = HashMap::new();
                    props.insert("condition".to_string(), serde_json::json!(cond));
                    props.insert("nesting_depth".to_string(), serde_json::json!(if_depth));
                    if let Some(ref then_action) = then_cmd {
                        props.insert("then_action".to_string(), serde_json::json!(then_action));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("if", line_num),
                        kind: AstNodeKind::IfStatement,
                        name: None,
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "if_count");

                    // IF ... THEN(DO) implicitly opens a DO block on the same line
                    if let Some(ref then_action) = then_cmd {
                        let then_upper = then_action.trim().to_uppercase();
                        if then_upper == "DO" || then_upper.starts_with("DO ") {
                            do_depth += 1;
                            ast_nodes.push(AstNode {
                                id: next_id("do", line_num),
                                kind: AstNodeKind::Loop,
                                name: Some("DO".to_string()),
                                span,
                                children: vec![],
                                properties: HashMap::from([
                                    ("loop_type".to_string(), serde_json::json!("DO")),
                                    ("nesting_depth".to_string(), serde_json::json!(do_depth)),
                                    ("source".to_string(), serde_json::json!("THEN(DO)")),
                                ]),
                            });
                            Self::inc_meta(&mut metadata, "do_count");
                        }
                    }
                }

                // ── ELSE — Else branch ──
                "ELSE" => {
                    let else_cmd = if cmd_upper.len() > 5 {
                        Some(cmd_upper[5..].trim().to_string())
                    } else {
                        None
                    };
                    let mut props = HashMap::new();
                    if let Some(ref action) = else_cmd {
                        if !action.is_empty() {
                            props.insert("else_action".to_string(), serde_json::json!(action));
                        }
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("else", line_num),
                        kind: AstNodeKind::Custom("Else".to_string()),
                        name: None,
                        span,
                        children: vec![],
                        properties: props,
                    });

                    // ELSE CMD(DO) or ELSE DO implicitly opens a DO block
                    if let Some(ref action) = else_cmd {
                        let action_upper = action.trim().to_uppercase();
                        if action_upper == "DO" || action_upper.starts_with("DO ")
                            || action_upper == "CMD(DO)" {
                            do_depth += 1;
                            ast_nodes.push(AstNode {
                                id: next_id("do", line_num),
                                kind: AstNodeKind::Loop,
                                name: Some("DO".to_string()),
                                span,
                                children: vec![],
                                properties: HashMap::from([
                                    ("loop_type".to_string(), serde_json::json!("DO")),
                                    ("nesting_depth".to_string(), serde_json::json!(do_depth)),
                                    ("source".to_string(), serde_json::json!("ELSE DO")),
                                ]),
                            });
                            Self::inc_meta(&mut metadata, "do_count");
                        }
                    }
                }

                // ── ENDIF / ENDDO — Block terminators ──
                "ENDIF" => {
                    if if_depth > 0 { if_depth -= 1; }
                }

                "ENDDO" => {
                    if do_depth > 0 { do_depth -= 1; }
                }

                // ── DO — Loop construct ──
                "DO" | "DOWHILE" | "DOUNTIL" | "DOFOR" => {
                    do_depth += 1;
                    let loop_kind = first_token.to_string();
                    let mut props = HashMap::new();
                    props.insert("loop_type".to_string(), serde_json::json!(loop_kind));
                    props.insert("nesting_depth".to_string(), serde_json::json!(do_depth));

                    // Extract WHILE/UNTIL condition if present
                    if let Some(cond) = Self::extract_parm(cmd_upper, "COND") {
                        props.insert("condition".to_string(), serde_json::json!(cond));
                    }
                    // DOFOR: extract FROM/TO/BY
                    if first_token == "DOFOR" {
                        if let Some(var) = Self::extract_parm(cmd_upper, "VAR") {
                            props.insert("loop_var".to_string(), serde_json::json!(var));
                        }
                        if let Some(from) = Self::extract_parm(cmd_upper, "FROM") {
                            props.insert("from".to_string(), serde_json::json!(from));
                        }
                        if let Some(to) = Self::extract_parm(cmd_upper, "TO") {
                            props.insert("to".to_string(), serde_json::json!(to));
                        }
                        if let Some(by) = Self::extract_parm(cmd_upper, "BY") {
                            props.insert("by".to_string(), serde_json::json!(by));
                        }
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("do", line_num),
                        kind: AstNodeKind::Loop,
                        name: Some(loop_kind),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "do_count");
                }

                // ── GOTO — Transfer of control ──
                "GOTO" => {
                    let target_label = Self::extract_parm(cmd_upper, "CMDLBL")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                        })
                        .unwrap_or_default();

                    ast_nodes.push(AstNode {
                        id: next_id("goto", line_num),
                        kind: AstNodeKind::GoToStatement,
                        name: Some(target_label.clone()),
                        span,
                        children: vec![],
                        properties: HashMap::from([
                            ("target_label".to_string(), serde_json::json!(target_label)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "goto_count");
                }

                // ── MONMSG — Error monitoring ──
                "MONMSG" => {
                    let msgid = Self::extract_parm(cmd_upper, "MSGID")
                        .unwrap_or_else(|| {
                            // MONMSG MSGID(CPF0000) or MONMSG CPF0000
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                                .unwrap_or_default()
                        });
                    let exec_cmd = Self::extract_parm(cmd_upper, "EXEC");
                    let cmpdta = Self::extract_parm(cmd_upper, "CMPDTA");

                    let mut props = HashMap::new();
                    props.insert("msgid".to_string(), serde_json::json!(msgid));
                    if let Some(ref exec) = exec_cmd {
                        props.insert("exec_action".to_string(), serde_json::json!(exec));
                    }
                    if let Some(ref cmp) = cmpdta {
                        props.insert("compare_data".to_string(), serde_json::json!(cmp));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("monmsg", line_num),
                        kind: AstNodeKind::Custom("MonMsg".to_string()),
                        name: Some(msgid),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "monmsg_count");
                }

                // ── CALL — Program call ──
                "CALL" => {
                    let pgm_name = Self::extract_parm(cmd_upper, "PGM")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')', '\''][..]).to_string())
                        })
                        .unwrap_or_default();
                    let call_parms = Self::extract_parm(cmd_upper, "PARM");

                    let mut props = HashMap::new();
                    props.insert("call_type".to_string(), serde_json::json!("CALL"));
                    props.insert("target_program".to_string(), serde_json::json!(pgm_name));
                    if let Some(ref p) = call_parms {
                        let param_list = Self::extract_var_refs(p);
                        props.insert("parameters".to_string(), serde_json::json!(param_list));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("call", line_num),
                        kind: AstNodeKind::CallStatement,
                        name: Some(pgm_name),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "call_count");
                }

                // ── CALLPRC — Procedure call (ILE) ──
                "CALLPRC" => {
                    let prc_name = Self::extract_parm(cmd_upper, "PRC")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')', '\''][..]).to_string())
                        })
                        .unwrap_or_default();
                    let call_parms = Self::extract_parm(cmd_upper, "PARM");
                    let rtnval = Self::extract_parm(cmd_upper, "RTNVAL");

                    let mut props = HashMap::new();
                    props.insert("call_type".to_string(), serde_json::json!("CALLPRC"));
                    props.insert("target_procedure".to_string(), serde_json::json!(prc_name));
                    if let Some(ref p) = call_parms {
                        let param_list = Self::extract_var_refs(p);
                        props.insert("parameters".to_string(), serde_json::json!(param_list));
                    }
                    if let Some(ref rv) = rtnval {
                        props.insert("return_value".to_string(), serde_json::json!(rv));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("callprc", line_num),
                        kind: AstNodeKind::CallStatement,
                        name: Some(prc_name),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "callprc_count");
                }

                // ── SNDPGMMSG — Send program message ──
                "SNDPGMMSG" => {
                    let msgid = Self::extract_parm(cmd_upper, "MSGID");
                    let msg = Self::extract_parm(cmd_upper, "MSG");
                    let msgtype = Self::extract_parm(cmd_upper, "MSGTYPE");
                    let topgmq = Self::extract_parm(cmd_upper, "TOPGMQ");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("SNDPGMMSG"));
                    if let Some(ref id) = msgid {
                        props.insert("msgid".to_string(), serde_json::json!(id));
                    }
                    if let Some(ref m) = msg {
                        props.insert("message_text".to_string(), serde_json::json!(m));
                    }
                    if let Some(ref mt) = msgtype {
                        props.insert("msg_type".to_string(), serde_json::json!(mt));
                    }
                    if let Some(ref tq) = topgmq {
                        props.insert("to_pgm_queue".to_string(), serde_json::json!(tq));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("sndpgmmsg", line_num),
                        kind: AstNodeKind::Custom("SendMessage".to_string()),
                        name: msg.or(msgid),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "sndpgmmsg_count");
                }

                // ── SNDBRKMSG — Send break message ──
                "SNDBRKMSG" => {
                    let msg = Self::extract_parm(cmd_upper, "MSG").unwrap_or_default();
                    let tomsgq = Self::extract_parm(cmd_upper, "TOMSGQ");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("SNDBRKMSG"));
                    props.insert("message_text".to_string(), serde_json::json!(msg));
                    if let Some(ref q) = tomsgq {
                        props.insert("to_msg_queue".to_string(), serde_json::json!(q));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("sndbrkmsg", line_num),
                        kind: AstNodeKind::Custom("SendMessage".to_string()),
                        name: Some(msg),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "sndbrkmsg_count");
                }

                // ── OVRDBF — Override database file ──
                "OVRDBF" => {
                    let file = Self::extract_parm(cmd_upper, "FILE")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                        })
                        .unwrap_or_default();
                    let tofile = Self::extract_parm(cmd_upper, "TOFILE");
                    let mbr = Self::extract_parm(cmd_upper, "MBR");
                    let ovrscope = Self::extract_parm(cmd_upper, "OVRSCOPE");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("OVRDBF"));
                    props.insert("file".to_string(), serde_json::json!(file));
                    if let Some(ref tf) = tofile {
                        props.insert("to_file".to_string(), serde_json::json!(tf));
                    }
                    if let Some(ref m) = mbr {
                        props.insert("member".to_string(), serde_json::json!(m));
                    }
                    if let Some(ref scope) = ovrscope {
                        props.insert("override_scope".to_string(), serde_json::json!(scope));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("ovrdbf", line_num),
                        kind: AstNodeKind::Custom("FileOverride".to_string()),
                        name: Some(file),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "ovrdbf_count");
                }

                // ── DLTOVR — Delete override ──
                "DLTOVR" => {
                    let file = Self::extract_parm(cmd_upper, "FILE")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                        })
                        .unwrap_or_default();

                    ast_nodes.push(AstNode {
                        id: next_id("dltovr", line_num),
                        kind: AstNodeKind::Custom("DeleteOverride".to_string()),
                        name: Some(file.clone()),
                        span,
                        children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!("DLTOVR")),
                            ("file".to_string(), serde_json::json!(file)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "dltovr_count");
                }

                // ── SBMJOB — Submit job ──
                "SBMJOB" => {
                    let cmd_val = Self::extract_parm(cmd_upper, "CMD")
                        .unwrap_or_default();
                    let job_name = Self::extract_parm(cmd_upper, "JOB");
                    let jobq = Self::extract_parm(cmd_upper, "JOBQ");
                    let jobd = Self::extract_parm(cmd_upper, "JOBD");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("SBMJOB"));
                    props.insert("submitted_cmd".to_string(), serde_json::json!(cmd_val));
                    if let Some(ref jn) = job_name {
                        props.insert("job_name".to_string(), serde_json::json!(jn));
                    }
                    if let Some(ref jq) = jobq {
                        props.insert("job_queue".to_string(), serde_json::json!(jq));
                    }
                    if let Some(ref jd) = jobd {
                        props.insert("job_description".to_string(), serde_json::json!(jd));
                    }

                    // Try to extract the CALL target from within the submitted CMD
                    let submitted_call = if cmd_val.contains("CALL") {
                        Self::extract_parm(&cmd_val, "PGM")
                            .or_else(|| {
                                cmd_val.split_whitespace()
                                    .skip_while(|t| *t != "CALL")
                                    .nth(1)
                                    .map(|s| s.trim_matches(&['(', ')', '\''][..]).to_string())
                            })
                    } else {
                        None
                    };
                    if let Some(ref sc) = submitted_call {
                        props.insert("submitted_call_target".to_string(), serde_json::json!(sc));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("sbmjob", line_num),
                        kind: AstNodeKind::Custom("SubmitJob".to_string()),
                        name: job_name.or(Some(cmd_val)),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "sbmjob_count");
                }

                // ── RTVJOBA — Retrieve job attributes ──
                "RTVJOBA" => {
                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("RTVJOBA"));
                    // Extract common attributes retrieved
                    for attr in &["JOB", "USER", "NBR", "TYPE", "SWS", "CURLIB", "DATE", "DATETIME"] {
                        if let Some(val) = Self::extract_parm(cmd_upper, attr) {
                            props.insert(attr.to_lowercase(), serde_json::json!(val));
                        }
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("rtvjoba", line_num),
                        kind: AstNodeKind::Custom("RetrieveValue".to_string()),
                        name: Some("RTVJOBA".to_string()),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "rtvjoba_count");
                }

                // ── RTVMBRD — Retrieve member description ──
                "RTVMBRD" => {
                    let file = Self::extract_parm(cmd_upper, "FILE").unwrap_or_default();
                    let mbr = Self::extract_parm(cmd_upper, "MBR");
                    let rtnlib = Self::extract_parm(cmd_upper, "RTNLIB");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("RTVMBRD"));
                    props.insert("file".to_string(), serde_json::json!(file));
                    if let Some(ref m) = mbr {
                        props.insert("member".to_string(), serde_json::json!(m));
                    }
                    if let Some(ref rl) = rtnlib {
                        props.insert("return_library".to_string(), serde_json::json!(rl));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("rtvmbrd", line_num),
                        kind: AstNodeKind::Custom("RetrieveValue".to_string()),
                        name: Some("RTVMBRD".to_string()),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "rtvmbrd_count");
                }

                // ── RTVDTAARA — Retrieve data area ──
                "RTVDTAARA" => {
                    let dtaara = Self::extract_parm(cmd_upper, "DTAARA").unwrap_or_default();
                    let rtnvar = Self::extract_parm(cmd_upper, "RTNVAR");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("RTVDTAARA"));
                    props.insert("data_area".to_string(), serde_json::json!(dtaara));
                    if let Some(ref rv) = rtnvar {
                        props.insert("return_var".to_string(), serde_json::json!(rv));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("rtvdtaara", line_num),
                        kind: AstNodeKind::Custom("RetrieveValue".to_string()),
                        name: Some("RTVDTAARA".to_string()),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "rtvdtaara_count");
                }

                // ── ADDLIBLE — Add library to library list ──
                "ADDLIBLE" => {
                    let lib = Self::extract_parm(cmd_upper, "LIB")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                        })
                        .unwrap_or_default();
                    let position = Self::extract_parm(cmd_upper, "POSITION");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("ADDLIBLE"));
                    props.insert("library".to_string(), serde_json::json!(lib));
                    if let Some(ref pos) = position {
                        props.insert("position".to_string(), serde_json::json!(pos));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("addlible", line_num),
                        kind: AstNodeKind::Custom("LibraryList".to_string()),
                        name: Some(lib),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "addlible_count");
                }

                // ── RMVLIBLE — Remove library from library list ──
                "RMVLIBLE" => {
                    let lib = Self::extract_parm(cmd_upper, "LIB")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                        })
                        .unwrap_or_default();

                    ast_nodes.push(AstNode {
                        id: next_id("rmvlible", line_num),
                        kind: AstNodeKind::Custom("LibraryList".to_string()),
                        name: Some(lib.clone()),
                        span,
                        children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!("RMVLIBLE")),
                            ("library".to_string(), serde_json::json!(lib)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "rmvlible_count");
                }

                // ── CPYF — Copy file ──
                "CPYF" => {
                    let fromfile = Self::extract_parm(cmd_upper, "FROMFILE").unwrap_or_default();
                    let tofile = Self::extract_parm(cmd_upper, "TOFILE").unwrap_or_default();
                    let frommbr = Self::extract_parm(cmd_upper, "FROMMBR");
                    let tombr = Self::extract_parm(cmd_upper, "TOMBR");
                    let mbropt = Self::extract_parm(cmd_upper, "MBROPT");
                    let crtfile = Self::extract_parm(cmd_upper, "CRTFILE");
                    let fmtopt = Self::extract_parm(cmd_upper, "FMTOPT");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("CPYF"));
                    props.insert("from_file".to_string(), serde_json::json!(fromfile));
                    props.insert("to_file".to_string(), serde_json::json!(tofile));
                    if let Some(ref fm) = frommbr {
                        props.insert("from_member".to_string(), serde_json::json!(fm));
                    }
                    if let Some(ref tm) = tombr {
                        props.insert("to_member".to_string(), serde_json::json!(tm));
                    }
                    if let Some(ref mo) = mbropt {
                        props.insert("member_option".to_string(), serde_json::json!(mo));
                    }
                    if let Some(ref cf) = crtfile {
                        props.insert("create_file".to_string(), serde_json::json!(cf));
                    }
                    if let Some(ref fo) = fmtopt {
                        props.insert("format_option".to_string(), serde_json::json!(fo));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("cpyf", line_num),
                        kind: AstNodeKind::Custom("FileCopy".to_string()),
                        name: Some(format!("{} -> {}", fromfile, tofile)),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "cpyf_count");
                }

                // ── RCVMSG — Receive message ──
                "RCVMSG" => {
                    let pgmq = Self::extract_parm(cmd_upper, "PGMQ");
                    let msgtype = Self::extract_parm(cmd_upper, "MSGTYPE");
                    let msg_var = Self::extract_parm(cmd_upper, "MSG");
                    let msgid_var = Self::extract_parm(cmd_upper, "MSGID");
                    let msgdta_var = Self::extract_parm(cmd_upper, "MSGDTA");
                    let rpy = Self::extract_parm(cmd_upper, "RPY");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("RCVMSG"));
                    if let Some(ref q) = pgmq {
                        props.insert("pgm_queue".to_string(), serde_json::json!(q));
                    }
                    if let Some(ref mt) = msgtype {
                        props.insert("msg_type".to_string(), serde_json::json!(mt));
                    }
                    if let Some(ref m) = msg_var {
                        props.insert("msg_var".to_string(), serde_json::json!(m));
                    }
                    if let Some(ref mid) = msgid_var {
                        props.insert("msgid_var".to_string(), serde_json::json!(mid));
                    }
                    if let Some(ref md) = msgdta_var {
                        props.insert("msgdta_var".to_string(), serde_json::json!(md));
                    }
                    if let Some(ref r) = rpy {
                        props.insert("reply_var".to_string(), serde_json::json!(r));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("rcvmsg", line_num),
                        kind: AstNodeKind::Custom("ReceiveMessage".to_string()),
                        name: Some("RCVMSG".to_string()),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "rcvmsg_count");
                }

                // ── OPNQRYF — Open query file ──
                "OPNQRYF" => {
                    let file = Self::extract_parm(cmd_upper, "FILE").unwrap_or_default();
                    let qryslt = Self::extract_parm(cmd_upper, "QRYSLT");
                    let keyfld = Self::extract_parm(cmd_upper, "KEYFLD");
                    let mapfld = Self::extract_parm(cmd_upper, "MAPFLD");
                    let jfld = Self::extract_parm(cmd_upper, "JFLD");
                    let jdftval = Self::extract_parm(cmd_upper, "JDFTVAL");
                    let grpfld = Self::extract_parm(cmd_upper, "GRPFLD");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("OPNQRYF"));
                    props.insert("file".to_string(), serde_json::json!(file));
                    if let Some(ref qs) = qryslt {
                        props.insert("query_select".to_string(), serde_json::json!(qs));
                    }
                    if let Some(ref kf) = keyfld {
                        props.insert("key_fields".to_string(), serde_json::json!(kf));
                    }
                    if let Some(ref mf) = mapfld {
                        props.insert("map_fields".to_string(), serde_json::json!(mf));
                    }
                    if let Some(ref jf) = jfld {
                        props.insert("join_fields".to_string(), serde_json::json!(jf));
                    }
                    if let Some(ref jv) = jdftval {
                        props.insert("join_default_values".to_string(), serde_json::json!(jv));
                    }
                    if let Some(ref gf) = grpfld {
                        props.insert("group_fields".to_string(), serde_json::json!(gf));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("opnqryf", line_num),
                        kind: AstNodeKind::Custom("QueryFile".to_string()),
                        name: Some(file),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "opnqryf_count");
                }

                // ── CLOF — Close file ──
                "CLOF" => {
                    let opnid = Self::extract_parm(cmd_upper, "OPNID")
                        .or_else(|| {
                            cmd_upper.split_whitespace().nth(1)
                                .map(|s| s.trim_matches(&['(', ')'][..]).to_string())
                        })
                        .unwrap_or_default();

                    ast_nodes.push(AstNode {
                        id: next_id("clof", line_num),
                        kind: AstNodeKind::Custom("CloseFile".to_string()),
                        name: Some(opnid.clone()),
                        span,
                        children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!("CLOF")),
                            ("opnid".to_string(), serde_json::json!(opnid)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "clof_count");
                }

                // ── DLYJOB — Delay job ──
                "DLYJOB" => {
                    let dly = Self::extract_parm(cmd_upper, "DLY");
                    let rsmtime = Self::extract_parm(cmd_upper, "RSMTIME");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("DLYJOB"));
                    if let Some(ref d) = dly {
                        props.insert("delay_seconds".to_string(), serde_json::json!(d));
                    }
                    if let Some(ref rt) = rsmtime {
                        props.insert("resume_time".to_string(), serde_json::json!(rt));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("dlyjob", line_num),
                        kind: AstNodeKind::Custom("DelayJob".to_string()),
                        name: Some("DLYJOB".to_string()),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "dlyjob_count");
                }

                // ── DSPFFD — Display file field descriptions ──
                "DSPFFD" => {
                    let file = Self::extract_parm(cmd_upper, "FILE").unwrap_or_default();
                    let output = Self::extract_parm(cmd_upper, "OUTPUT");
                    let outfile = Self::extract_parm(cmd_upper, "OUTFILE");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("DSPFFD"));
                    props.insert("file".to_string(), serde_json::json!(file));
                    if let Some(ref o) = output {
                        props.insert("output".to_string(), serde_json::json!(o));
                    }
                    if let Some(ref of_) = outfile {
                        props.insert("outfile".to_string(), serde_json::json!(of_));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("dspffd", line_num),
                        kind: AstNodeKind::Custom("DisplayFileDesc".to_string()),
                        name: Some(file),
                        span,
                        children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "dspffd_count");
                }

                // ── CRTDTAARA — Create data area ──
                "CRTDTAARA" => {
                    let dtaara = Self::extract_parm(cmd_upper, "DTAARA").unwrap_or_default();
                    let dtype = Self::extract_parm(cmd_upper, "TYPE");
                    let len = Self::extract_parm(cmd_upper, "LEN");
                    let value = Self::extract_parm(cmd_upper, "VALUE");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("CRTDTAARA"));
                    props.insert("data_area".to_string(), serde_json::json!(dtaara));
                    if let Some(ref t) = dtype { props.insert("type".to_string(), serde_json::json!(t)); }
                    if let Some(ref l) = len { props.insert("length".to_string(), serde_json::json!(l)); }
                    if let Some(ref v) = value { props.insert("value".to_string(), serde_json::json!(v)); }

                    ast_nodes.push(AstNode {
                        id: next_id("crtdtaara", line_num),
                        kind: AstNodeKind::Custom("CreateDataArea".to_string()),
                        name: Some(dtaara), span, children: vec![], properties: props,
                    });
                    Self::inc_meta(&mut metadata, "crtdtaara_count");
                }

                // ── CHGDTAARA — Change data area ──
                "CHGDTAARA" => {
                    let dtaara = Self::extract_parm(cmd_upper, "DTAARA").unwrap_or_default();
                    let value = Self::extract_parm(cmd_upper, "VALUE").unwrap_or_default();

                    ast_nodes.push(AstNode {
                        id: next_id("chgdtaara", line_num),
                        kind: AstNodeKind::Custom("ChangeDataArea".to_string()),
                        name: Some(dtaara.clone()), span, children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!("CHGDTAARA")),
                            ("data_area".to_string(), serde_json::json!(dtaara)),
                            ("value".to_string(), serde_json::json!(value)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "chgdtaara_count");
                }

                // ── SNDRCVF — Send/Receive screen file (display file I/O) ──
                "SNDRCVF" => {
                    let rcdfmt = Self::extract_parm(cmd_upper, "RCDFMT");
                    let dev = Self::extract_parm(cmd_upper, "DEV");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("SNDRCVF"));
                    if let Some(ref r) = rcdfmt { props.insert("record_format".to_string(), serde_json::json!(r)); }
                    if let Some(ref d) = dev { props.insert("device".to_string(), serde_json::json!(d)); }

                    ast_nodes.push(AstNode {
                        id: next_id("sndrcvf", line_num),
                        kind: AstNodeKind::Custom("ScreenIO".to_string()),
                        name: rcdfmt.or(Some("SNDRCVF".to_string())), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "sndrcvf_count");
                }

                // ── SNDF — Send file (write to display) ──
                "SNDF" => {
                    let rcdfmt = Self::extract_parm(cmd_upper, "RCDFMT");

                    ast_nodes.push(AstNode {
                        id: next_id("sndf", line_num),
                        kind: AstNodeKind::Custom("ScreenIO".to_string()),
                        name: rcdfmt.clone().or(Some("SNDF".to_string())), span, children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!("SNDF")),
                            ("direction".to_string(), serde_json::json!("send")),
                            ("record_format".to_string(), serde_json::json!(rcdfmt.unwrap_or_default())),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "sndf_count");
                }

                // ── RCVF — Receive file (read from display) ──
                "RCVF" => {
                    let rcdfmt = Self::extract_parm(cmd_upper, "RCDFMT");
                    let dev = Self::extract_parm(cmd_upper, "DEV");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("RCVF"));
                    props.insert("direction".to_string(), serde_json::json!("receive"));
                    if let Some(ref r) = rcdfmt { props.insert("record_format".to_string(), serde_json::json!(r)); }
                    if let Some(ref d) = dev { props.insert("device".to_string(), serde_json::json!(d)); }

                    ast_nodes.push(AstNode {
                        id: next_id("rcvf", line_num),
                        kind: AstNodeKind::Custom("ScreenIO".to_string()),
                        name: rcdfmt.or(Some("RCVF".to_string())), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "rcvf_count");
                }

                // ── CHGLIBL — Change library list ──
                "CHGLIBL" => {
                    let libl = Self::extract_parm(cmd_upper, "LIBL").unwrap_or_default();
                    let curlib = Self::extract_parm(cmd_upper, "CURLIB");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("CHGLIBL"));
                    props.insert("library_list".to_string(), serde_json::json!(libl));
                    if let Some(ref cl) = curlib {
                        props.insert("current_library".to_string(), serde_json::json!(cl));
                    }

                    ast_nodes.push(AstNode {
                        id: next_id("chglibl", line_num),
                        kind: AstNodeKind::Custom("LibraryList".to_string()),
                        name: Some("CHGLIBL".to_string()), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "chglibl_count");
                }

                // ── CRTPF — Create physical file ──
                "CRTPF" => {
                    let file = Self::extract_parm(cmd_upper, "FILE").unwrap_or_default();
                    let srcfile = Self::extract_parm(cmd_upper, "SRCFILE");
                    let rcdlen = Self::extract_parm(cmd_upper, "RCDLEN");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("CRTPF"));
                    props.insert("file".to_string(), serde_json::json!(file));
                    if let Some(ref sf) = srcfile { props.insert("source_file".to_string(), serde_json::json!(sf)); }
                    if let Some(ref rl) = rcdlen { props.insert("record_length".to_string(), serde_json::json!(rl)); }

                    ast_nodes.push(AstNode {
                        id: next_id("crtpf", line_num),
                        kind: AstNodeKind::Custom("CreateObject".to_string()),
                        name: Some(file), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "crtpf_count");
                }

                // ── CRTLF — Create logical file ──
                "CRTLF" => {
                    let file = Self::extract_parm(cmd_upper, "FILE").unwrap_or_default();
                    let srcfile = Self::extract_parm(cmd_upper, "SRCFILE");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("CRTLF"));
                    props.insert("file".to_string(), serde_json::json!(file));
                    if let Some(ref sf) = srcfile { props.insert("source_file".to_string(), serde_json::json!(sf)); }

                    ast_nodes.push(AstNode {
                        id: next_id("crtlf", line_num),
                        kind: AstNodeKind::Custom("CreateObject".to_string()),
                        name: Some(file), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "crtlf_count");
                }

                // ── CRTBNDRPG — Create bound RPG program ──
                "CRTBNDRPG" => {
                    let pgm = Self::extract_parm(cmd_upper, "PGM").unwrap_or_default();
                    let srcfile = Self::extract_parm(cmd_upper, "SRCFILE");
                    let srcmbr = Self::extract_parm(cmd_upper, "SRCMBR");
                    let dftactgrp = Self::extract_parm(cmd_upper, "DFTACTGRP");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("CRTBNDRPG"));
                    props.insert("program".to_string(), serde_json::json!(pgm));
                    if let Some(ref sf) = srcfile { props.insert("source_file".to_string(), serde_json::json!(sf)); }
                    if let Some(ref sm) = srcmbr { props.insert("source_member".to_string(), serde_json::json!(sm)); }
                    if let Some(ref da) = dftactgrp { props.insert("dftactgrp".to_string(), serde_json::json!(da)); }

                    ast_nodes.push(AstNode {
                        id: next_id("crtbndrpg", line_num),
                        kind: AstNodeKind::Custom("CompileCommand".to_string()),
                        name: Some(pgm), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "crtbndrpg_count");
                }

                // ── CRTRPGMOD / CRTPGM / CRTSRVPGM — Additional compile commands ──
                "CRTRPGMOD" | "CRTPGM" | "CRTSRVPGM" | "CRTBNDCL" | "CRTCLPGM" => {
                    let target = Self::extract_parm(cmd_upper, "PGM")
                        .or_else(|| Self::extract_parm(cmd_upper, "MODULE"))
                        .or_else(|| Self::extract_parm(cmd_upper, "SRVPGM"))
                        .unwrap_or_default();

                    ast_nodes.push(AstNode {
                        id: next_id("compile", line_num),
                        kind: AstNodeKind::Custom("CompileCommand".to_string()),
                        name: Some(target.clone()), span, children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!(first_token)),
                            ("target".to_string(), serde_json::json!(target)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "compile_cmd_count");
                }

                // ── RUNSQL — Run SQL statement ──
                "RUNSQL" => {
                    let sql = Self::extract_parm(cmd_upper, "SQL").unwrap_or_default();
                    let commit = Self::extract_parm(cmd_upper, "COMMIT");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("RUNSQL"));
                    props.insert("sql".to_string(), serde_json::json!(sql));
                    if let Some(ref c) = commit { props.insert("commit".to_string(), serde_json::json!(c)); }

                    ast_nodes.push(AstNode {
                        id: next_id("runsql", line_num),
                        kind: AstNodeKind::Custom("RunSQL".to_string()),
                        name: Some("RUNSQL".to_string()), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "runsql_count");
                }

                // ── RUNSQLSTM — Run SQL statements from source ──
                "RUNSQLSTM" => {
                    let srcfile = Self::extract_parm(cmd_upper, "SRCFILE").unwrap_or_default();
                    let srcmbr = Self::extract_parm(cmd_upper, "SRCMBR");

                    let mut props = HashMap::new();
                    props.insert("command".to_string(), serde_json::json!("RUNSQLSTM"));
                    props.insert("source_file".to_string(), serde_json::json!(srcfile));
                    if let Some(ref sm) = srcmbr { props.insert("source_member".to_string(), serde_json::json!(sm)); }

                    ast_nodes.push(AstNode {
                        id: next_id("runsqlstm", line_num),
                        kind: AstNodeKind::Custom("RunSQL".to_string()),
                        name: Some("RUNSQLSTM".to_string()), span, children: vec![],
                        properties: props,
                    });
                    Self::inc_meta(&mut metadata, "runsqlstm_count");
                }

                // ── SUBR — Subroutine definition (CLLE ILE) ──
                "SUBR" => {
                    let subr_name = Self::extract_parm(cmd_upper, "SUBR")
                        .or_else(|| cmd_upper.split_whitespace().nth(1)
                            .map(|s| s.trim_matches(&['(', ')'][..]).to_string()))
                        .unwrap_or_default();

                    symbols.push(Symbol {
                        name: subr_name.clone(),
                        kind: SymbolKind::Subroutine,
                        span, visibility: Visibility::Internal,
                        data_type: None, properties: HashMap::new(),
                    });
                    ast_nodes.push(AstNode {
                        id: next_id("subr", line_num),
                        kind: AstNodeKind::Paragraph,
                        name: Some(subr_name), span, children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!("SUBR")),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "subr_count");
                }

                // ── ENDSUBR — End subroutine (CLLE ILE) ──
                "ENDSUBR" => {
                    let rtnval = Self::extract_parm(cmd_upper, "RTNVAL");
                    let mut props = HashMap::from([
                        ("command".to_string(), serde_json::json!("ENDSUBR")),
                    ]);
                    if let Some(ref rv) = rtnval {
                        props.insert("return_value".to_string(), serde_json::json!(rv));
                    }
                    ast_nodes.push(AstNode {
                        id: next_id("endsubr", line_num),
                        kind: AstNodeKind::Custom("EndSubroutine".to_string()),
                        name: None, span, children: vec![], properties: props,
                    });
                }

                // ── CHKOBJ — Check object existence ──
                "CHKOBJ" => {
                    let obj = Self::extract_parm(cmd_upper, "OBJ").unwrap_or_default();
                    let objtype = Self::extract_parm(cmd_upper, "OBJTYPE").unwrap_or_default();

                    ast_nodes.push(AstNode {
                        id: next_id("chkobj", line_num),
                        kind: AstNodeKind::Custom("CheckObject".to_string()),
                        name: Some(obj.clone()), span, children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!("CHKOBJ")),
                            ("object".to_string(), serde_json::json!(obj)),
                            ("object_type".to_string(), serde_json::json!(objtype)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "chkobj_count");
                }

                // ── WRKOBJ / DSPOBJD / WRKACTJOB — System admin commands ──
                "WRKOBJ" | "DSPOBJD" | "WRKACTJOB" | "WRKSPLF" | "WRKJOB"
                | "DSPJOB" | "DSPLOG" | "DSPMSG" | "WRKMSGQ" => {
                    ast_nodes.push(AstNode {
                        id: next_id("syscmd", line_num),
                        kind: AstNodeKind::Custom("SystemCommand".to_string()),
                        name: Some(first_token.to_string()), span, children: vec![],
                        properties: HashMap::from([
                            ("command".to_string(), serde_json::json!(first_token)),
                        ]),
                    });
                    Self::inc_meta(&mut metadata, "system_cmd_count");
                }

                // ── Unrecognized commands — still record them for coverage ──
                _ => {
                    // Only record non-empty tokens that look like CL commands (all-alpha, >= 2 chars)
                    if first_token.len() >= 2 && first_token.chars().all(|c| c.is_ascii_alphanumeric()) {
                        Self::inc_meta(&mut metadata, "other_command_count");
                    }
                }
            }
        }

        // Emit diagnostic if IF/DO blocks are unbalanced at end
        if if_depth > 0 {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Warning,
                message: format!("{} unclosed IF block(s) at end of source", if_depth),
                span: Span { start_line: total_lines.saturating_sub(1), start_col: 0, end_line: total_lines.saturating_sub(1), end_col: 0 },
                code: Some("CL-W001".to_string()),
            });
        }
        if do_depth > 0 {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Warning,
                message: format!("{} unclosed DO block(s) at end of source", do_depth),
                span: Span { start_line: total_lines.saturating_sub(1), start_col: 0, end_line: total_lines.saturating_sub(1), end_col: 0 },
                code: Some("CL-W002".to_string()),
            });
        }

        // Summary metadata
        metadata.insert("total_ast_nodes".to_string(), serde_json::json!(ast_nodes.len()));
        metadata.insert("total_symbols".to_string(), serde_json::json!(symbols.len()));
        metadata.insert("total_diagnostics".to_string(), serde_json::json!(diagnostics.len()));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: dialect.to_string(),
            source_path: source.path.to_string_lossy().to_string(),
            total_lines,
            ast_nodes,
            symbols,
            embedded_blocks: vec![],
            diagnostics,
            metadata,
        })
    }

    fn parse_partial(&self, source: &SourceFile) -> anyhow::Result<PartialParseOutput> {
        let output = self.parse(source)?;
        let total = output.total_lines;
        let has_errors = output.diagnostics.iter().any(|d| matches!(d.severity, DiagnosticSeverity::Error));
        let coverage = if has_errors { 0.9 } else { 1.0 };
        Ok(PartialParseOutput {
            output,
            parsed_up_to_line: total,
            error: String::new(),
            coverage,
        })
    }

    fn resolve_dependencies(&self, module: &ParseOutput, _vault: &SourceVault) -> Vec<DependencyRef> {
        let mut deps = Vec::new();

        for node in &module.ast_nodes {
            match &node.kind {
                // CALL / CALLPRC => ProgramCall dependency
                AstNodeKind::CallStatement => {
                    if let Some(ref name) = node.name {
                        let call_type = node.properties.get("call_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("CALL");
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::ProgramCall,
                            source_span: node.span,
                            reference_text: format!("{} {}", call_type, name),
                        });
                    }
                }

                // DCLF => FileAccess dependency
                AstNodeKind::FileDeclaration => {
                    if let Some(ref name) = node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::FileAccess,
                            source_span: node.span,
                            reference_text: format!("DCLF {}", name),
                        });
                    }
                }

                // SBMJOB with a CALL inside => ProgramCall dependency
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "SubmitJob" => {
                    if let Some(target) = node.properties.get("submitted_call_target")
                        .and_then(|v| v.as_str())
                    {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: target.to_string(),
                            dependency_type: DependencyType::ProgramCall,
                            source_span: node.span,
                            reference_text: format!("SBMJOB CMD(CALL {})", target),
                        });
                    }
                }

                // CPYF => FileAccess dependencies (from and to)
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "FileCopy" => {
                    if let Some(from) = node.properties.get("from_file").and_then(|v| v.as_str()) {
                        if !from.is_empty() {
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: from.to_string(),
                                dependency_type: DependencyType::FileAccess,
                                source_span: node.span,
                                reference_text: format!("CPYF FROMFILE({})", from),
                            });
                        }
                    }
                    if let Some(to) = node.properties.get("to_file").and_then(|v| v.as_str()) {
                        if !to.is_empty() {
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: to.to_string(),
                                dependency_type: DependencyType::FileAccess,
                                source_span: node.span,
                                reference_text: format!("CPYF TOFILE({})", to),
                            });
                        }
                    }
                }

                // OPNQRYF => FileAccess dependency
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "QueryFile" => {
                    if let Some(ref name) = node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::FileAccess,
                            source_span: node.span,
                            reference_text: format!("OPNQRYF FILE({})", name),
                        });
                    }
                }

                // OVRDBF => FileAccess dependency
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "FileOverride" => {
                    if let Some(tofile) = node.properties.get("to_file").and_then(|v| v.as_str()) {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: tofile.to_string(),
                            dependency_type: DependencyType::FileAccess,
                            source_span: node.span,
                            reference_text: format!("OVRDBF TOFILE({})", tofile),
                        });
                    }
                }

                // CRTBNDRPG / CRTRPGMOD => cross-language dependency to RPG source
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "CompileCommand" => {
                    if let Some(ref target) = node.name {
                        let cmd = node.properties.get("command")
                            .and_then(|v| v.as_str()).unwrap_or("");
                        if cmd == "CRTBNDRPG" || cmd == "CRTRPGMOD" {
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: target.clone(),
                                dependency_type: DependencyType::CrossLanguage { target_language: "rpg".to_string() },
                                source_span: node.span,
                                reference_text: format!("{} PGM({})", cmd, target),
                            });
                        } else if cmd == "CRTBNDCL" || cmd == "CRTCLPGM" {
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: target.clone(),
                                dependency_type: DependencyType::CrossLanguage { target_language: "cl".to_string() },
                                source_span: node.span,
                                reference_text: format!("{} PGM({})", cmd, target),
                            });
                        }
                    }
                }

                // CRTPF / CRTLF => cross-language dependency to DDS source
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "CreateObject" => {
                    if let Some(ref target) = node.name {
                        let cmd = node.properties.get("command")
                            .and_then(|v| v.as_str()).unwrap_or("");
                        if cmd == "CRTPF" || cmd == "CRTLF" {
                            if let Some(srcfile) = node.properties.get("source_file").and_then(|v| v.as_str()) {
                                deps.push(DependencyRef {
                                    from_module: module.source_path.clone(),
                                    to_module: srcfile.to_string(),
                                    dependency_type: DependencyType::CrossLanguage { target_language: "dds".to_string() },
                                    source_span: node.span,
                                    reference_text: format!("{} FILE({}) SRCFILE({})", cmd, target, srcfile),
                                });
                            }
                        }
                    }
                }

                // RUNSQL / RUNSQLSTM => DatabaseAccess dependency
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "RunSQL" => {
                    let cmd = node.properties.get("command")
                        .and_then(|v| v.as_str()).unwrap_or("RUNSQL");
                    let ref_text = if cmd == "RUNSQLSTM" {
                        let sf = node.properties.get("source_file")
                            .and_then(|v| v.as_str()).unwrap_or("");
                        format!("RUNSQLSTM SRCFILE({})", sf)
                    } else {
                        let sql = node.properties.get("sql")
                            .and_then(|v| v.as_str()).unwrap_or("");
                        format!("RUNSQL SQL({} chars)", sql.len())
                    };
                    deps.push(DependencyRef {
                        from_module: module.source_path.clone(),
                        to_module: "DB2-SQL".to_string(),
                        dependency_type: DependencyType::DatabaseAccess,
                        source_span: node.span,
                        reference_text: ref_text,
                    });
                }

                // ScreenIO (SNDRCVF/SNDF/RCVF) => cross-language DDS link
                AstNodeKind::Custom(ref custom_kind) if custom_kind == "ScreenIO" => {
                    // Screen I/O implies a DDS display file dependency
                    if let Some(ref rcdfmt) = node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: rcdfmt.clone(),
                            dependency_type: DependencyType::CrossLanguage { target_language: "dds".to_string() },
                            source_span: node.span,
                            reference_text: format!("Screen I/O RCDFMT({})", rcdfmt),
                        });
                    }
                }

                _ => {}
            }
        }

        deps
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        let mut nodes: Vec<AnalysisNode> = Vec::new();
        let mut edges: Vec<AnalysisEdge> = Vec::new();
        let mut business_rules: Vec<BusinessRule> = Vec::new();
        let mut data_flows: Vec<DataFlow> = Vec::new();

        // Create an entry-point node for the program itself
        let pgm_node_id = format!("entry-{}", output.source_path);
        let pgm_span = output.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Module)
            .map(|n| n.span)
            .unwrap_or(Span { start_line: 0, start_col: 0, end_line: output.total_lines, end_col: 0 });

        nodes.push(AnalysisNode {
            id: pgm_node_id.clone(),
            kind: AnalysisNodeKind::EntryPoint,
            name: output.source_path.clone(),
            source_span: pgm_span,
            properties: HashMap::from([
                ("language".to_string(), serde_json::json!("cl")),
                ("dialect".to_string(), serde_json::json!(&output.dialect)),
            ]),
        });

        let mut call_counter = 0usize;
        let mut rule_counter = 0usize;
        let mut flow_counter = 0usize;

        for node in &output.ast_nodes {
            match &node.kind {
                // CALL/CALLPRC -> ExternalCall node + CallsInto edge
                AstNodeKind::CallStatement => {
                    if let Some(ref target) = node.name {
                        call_counter += 1;
                        let call_node_id = format!("call-{}-{}", call_counter, target);
                        let call_type = node.properties.get("call_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("CALL");

                        nodes.push(AnalysisNode {
                            id: call_node_id.clone(),
                            kind: AnalysisNodeKind::ExternalCall,
                            name: format!("{} {}", call_type, target),
                            source_span: node.span,
                            properties: HashMap::from([
                                ("target".to_string(), serde_json::json!(target)),
                                ("call_type".to_string(), serde_json::json!(call_type)),
                            ]),
                        });
                        edges.push(AnalysisEdge {
                            from: pgm_node_id.clone(),
                            to: call_node_id,
                            kind: AnalysisEdgeKind::CallsInto,
                            label: Some(format!("{} {}", call_type, target)),
                        });
                    }
                }

                // SBMJOB with embedded call -> ExternalCall node
                AstNodeKind::Custom(ref kind) if kind == "SubmitJob" => {
                    if let Some(target) = node.properties.get("submitted_call_target")
                        .and_then(|v| v.as_str())
                    {
                        call_counter += 1;
                        let sbm_node_id = format!("sbmjob-call-{}-{}", call_counter, target);
                        nodes.push(AnalysisNode {
                            id: sbm_node_id.clone(),
                            kind: AnalysisNodeKind::ExternalCall,
                            name: format!("SBMJOB -> {}", target),
                            source_span: node.span,
                            properties: HashMap::from([
                                ("target".to_string(), serde_json::json!(target)),
                                ("submission".to_string(), serde_json::json!(true)),
                            ]),
                        });
                        edges.push(AnalysisEdge {
                            from: pgm_node_id.clone(),
                            to: sbm_node_id,
                            kind: AnalysisEdgeKind::CallsInto,
                            label: Some(format!("SBMJOB CMD(CALL {})", target)),
                        });
                    }
                }

                // MONMSG -> ErrorHandler node
                AstNodeKind::Custom(ref kind) if kind == "MonMsg" => {
                    let msgid = node.name.as_deref().unwrap_or("UNKNOWN");
                    let handler_id = format!("monmsg-{}-{}", node.span.start_line, msgid);
                    nodes.push(AnalysisNode {
                        id: handler_id.clone(),
                        kind: AnalysisNodeKind::ErrorHandler,
                        name: format!("MONMSG {}", msgid),
                        source_span: node.span,
                        properties: HashMap::from([
                            ("msgid".to_string(), serde_json::json!(msgid)),
                        ]),
                    });
                    edges.push(AnalysisEdge {
                        from: pgm_node_id.clone(),
                        to: handler_id,
                        kind: AnalysisEdgeKind::ControlFlow,
                        label: Some(format!("handles {}", msgid)),
                    });
                }

                // IF statements -> ControlFlow node + potential business rule
                AstNodeKind::IfStatement => {
                    let cond = node.properties.get("condition")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !cond.is_empty() {
                        rule_counter += 1;
                        let rule_id = format!("rule-if-{}", rule_counter);
                        let cf_node_id = format!("cf-if-{}", node.span.start_line);

                        nodes.push(AnalysisNode {
                            id: cf_node_id.clone(),
                            kind: AnalysisNodeKind::ControlFlow,
                            name: format!("IF {}", cond),
                            source_span: node.span,
                            properties: HashMap::from([
                                ("condition".to_string(), serde_json::json!(cond)),
                            ]),
                        });
                        edges.push(AnalysisEdge {
                            from: pgm_node_id.clone(),
                            to: cf_node_id,
                            kind: AnalysisEdgeKind::ControlFlow,
                            label: Some("conditional".to_string()),
                        });

                        business_rules.push(BusinessRule {
                            id: rule_id,
                            description: format!("Conditional check: {}", cond),
                            rule_type: BusinessRuleType::Validation,
                            source_span: node.span,
                            confidence: 0.5,
                        });
                    }
                }

                // File operations (DCLF, OPNQRYF, CPYF, OVRDBF) -> FileOperation node
                AstNodeKind::FileDeclaration => {
                    if let Some(ref fname) = node.name {
                        let file_node_id = format!("file-{}-{}", node.span.start_line, fname);
                        nodes.push(AnalysisNode {
                            id: file_node_id.clone(),
                            kind: AnalysisNodeKind::FileOperation,
                            name: format!("DCLF {}", fname),
                            source_span: node.span,
                            properties: HashMap::from([
                                ("file".to_string(), serde_json::json!(fname)),
                            ]),
                        });
                        edges.push(AnalysisEdge {
                            from: pgm_node_id.clone(),
                            to: file_node_id,
                            kind: AnalysisEdgeKind::ReadsFrom,
                            label: Some(format!("declares {}", fname)),
                        });
                    }
                }

                AstNodeKind::Custom(ref kind) if kind == "QueryFile" || kind == "FileCopy" => {
                    if let Some(ref fname) = node.name {
                        let op_node_id = format!("fileop-{}-{}", node.span.start_line, kind);
                        nodes.push(AnalysisNode {
                            id: op_node_id.clone(),
                            kind: AnalysisNodeKind::FileOperation,
                            name: fname.clone(),
                            source_span: node.span,
                            properties: node.properties.clone(),
                        });
                        let edge_kind = if kind == "FileCopy" {
                            AnalysisEdgeKind::WritesTo
                        } else {
                            AnalysisEdgeKind::ReadsFrom
                        };
                        edges.push(AnalysisEdge {
                            from: pgm_node_id.clone(),
                            to: op_node_id,
                            kind: edge_kind,
                            label: Some(fname.clone()),
                        });
                    }
                }

                // ScreenIO (SNDRCVF/SNDF/RCVF) -> UIInteraction node
                AstNodeKind::Custom(ref kind) if kind == "ScreenIO" => {
                    if let Some(ref name) = node.name {
                        let screen_id = format!("screen-{}-{}", node.span.start_line, name);
                        let cmd = node.properties.get("command")
                            .and_then(|v| v.as_str()).unwrap_or("SNDRCVF");
                        nodes.push(AnalysisNode {
                            id: screen_id.clone(),
                            kind: AnalysisNodeKind::UIInteraction,
                            name: format!("{} {}", cmd, name),
                            source_span: node.span,
                            properties: node.properties.clone(),
                        });
                        let edge_kind = match cmd {
                            "SNDF" => AnalysisEdgeKind::WritesTo,
                            "RCVF" => AnalysisEdgeKind::ReadsFrom,
                            _ => AnalysisEdgeKind::DataFlow, // SNDRCVF is both
                        };
                        edges.push(AnalysisEdge {
                            from: pgm_node_id.clone(),
                            to: screen_id,
                            kind: edge_kind,
                            label: Some(format!("{} {}", cmd, name)),
                        });
                    }
                }

                // RUNSQL -> DatabaseOperation node
                AstNodeKind::Custom(ref kind) if kind == "RunSQL" => {
                    let sql_id = format!("sql-{}", node.span.start_line);
                    let cmd = node.properties.get("command")
                        .and_then(|v| v.as_str()).unwrap_or("RUNSQL");
                    nodes.push(AnalysisNode {
                        id: sql_id.clone(),
                        kind: AnalysisNodeKind::DatabaseOperation,
                        name: cmd.to_string(),
                        source_span: node.span,
                        properties: node.properties.clone(),
                    });
                    edges.push(AnalysisEdge {
                        from: pgm_node_id.clone(),
                        to: sql_id,
                        kind: AnalysisEdgeKind::Dependency,
                        label: Some("executes SQL".to_string()),
                    });
                }

                // SUBR -> EntryPoint subroutine node
                AstNodeKind::Paragraph => {
                    if let Some(ref name) = node.name {
                        let subr_id = format!("subr-{}-{}", node.span.start_line, name);
                        nodes.push(AnalysisNode {
                            id: subr_id.clone(),
                            kind: AnalysisNodeKind::EntryPoint,
                            name: format!("SUBR {}", name),
                            source_span: node.span,
                            properties: HashMap::new(),
                        });
                        edges.push(AnalysisEdge {
                            from: pgm_node_id.clone(),
                            to: subr_id,
                            kind: AnalysisEdgeKind::ControlFlow,
                            label: Some(format!("subroutine {}", name)),
                        });
                    }
                }

                // CHGVAR assignments with expressions -> DataTransformation
                AstNodeKind::Assignment => {
                    let target = node.properties.get("target")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let value = node.properties.get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    // Only create a data flow if the value is a non-trivial expression
                    if !value.is_empty() && (value.contains('&') || value.contains("*") || value.contains('%')) {
                        flow_counter += 1;
                        data_flows.push(DataFlow {
                            id: format!("flow-{}", flow_counter),
                            description: format!("{} := {}", target, value),
                            source_node: value.to_string(),
                            sink_node: target.to_string(),
                            transformations: vec![format!("CHGVAR at line {}", node.span.start_line)],
                        });
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
            business_rules,
            data_flows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_source(content: &str) -> SourceFile {
        SourceFile::new(PathBuf::from("TEST.CLLE"), content.to_string())
    }

    #[test]
    fn test_pgm_with_parms() {
        let src = make_source("PGM PARM(&LIB &FILE)\nENDPGM");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Module));
        assert!(out.symbols.iter().any(|s| s.name == "&LIB"));
        assert!(out.symbols.iter().any(|s| s.name == "&FILE"));
    }

    #[test]
    fn test_dcl_var_extraction() {
        let src = make_source("DCL VAR(&MYVAR) TYPE(*CHAR) LEN(10) VALUE('HELLO')");
        let out = ClParser::new().parse(&src).unwrap();
        let sym = out.symbols.iter().find(|s| s.name == "&MYVAR").unwrap();
        assert_eq!(sym.kind, SymbolKind::Variable);
        assert_eq!(sym.data_type.as_deref(), Some("*CHAR LEN(10)"));
    }

    #[test]
    fn test_dclf() {
        let src = make_source("DCLF FILE(MYLIB/MYFILE)");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.symbols.iter().any(|s| s.name == "MYLIB/MYFILE" && s.kind == SymbolKind::FileDescription));
    }

    #[test]
    fn test_chgvar() {
        let src = make_source("CHGVAR VAR(&RESULT) VALUE(&A + &B)");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter().find(|n| n.kind == AstNodeKind::Assignment).unwrap();
        assert_eq!(node.name.as_deref(), Some("&RESULT"));
    }

    #[test]
    fn test_call_and_callprc() {
        let src = make_source("CALL PGM(MYPGM) PARM(&X)\nCALLPRC PRC('myproc') PARM(&Y)");
        let out = ClParser::new().parse(&src).unwrap();
        let calls: Vec<_> = out.ast_nodes.iter()
            .filter(|n| n.kind == AstNodeKind::CallStatement)
            .collect();
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn test_monmsg() {
        let src = make_source("MONMSG MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))");
        let out = ClParser::new().parse(&src).unwrap();
        let mm = out.ast_nodes.iter().find(|n| n.kind == AstNodeKind::Custom("MonMsg".to_string())).unwrap();
        assert_eq!(mm.name.as_deref(), Some("CPF0000"));
    }

    #[test]
    fn test_if_do_nesting() {
        let src = make_source("IF COND(&X *EQ 1) THEN(DO)\nCHGVAR VAR(&Y) VALUE(2)\nENDDO\nENDIF");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::IfStatement));
    }

    #[test]
    fn test_goto_and_label() {
        let src = make_source("ERROR: SNDPGMMSG MSG('Error occurred')\nGOTO CMDLBL(END)\nEND: ENDPGM");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::GoToStatement));
        assert!(out.symbols.iter().any(|s| s.name == "ERROR"));
    }

    #[test]
    fn test_continuation_lines() {
        let src = make_source("SNDPGMMSG MSG('This is a +\n  long message')");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("SendMessage".to_string())));
    }

    #[test]
    fn test_sbmjob() {
        let src = make_source("SBMJOB CMD(CALL PGM(NIGHTJOB)) JOB(BATCH01) JOBQ(QBATCH)");
        let out = ClParser::new().parse(&src).unwrap();
        let sbm = out.ast_nodes.iter().find(|n| n.kind == AstNodeKind::Custom("SubmitJob".to_string())).unwrap();
        assert!(sbm.properties.get("submitted_call_target").is_some());
    }

    #[test]
    fn test_cpyf() {
        let src = make_source("CPYF FROMFILE(LIB1/FILE1) TOFILE(LIB2/FILE2) MBROPT(*REPLACE)");
        let out = ClParser::new().parse(&src).unwrap();
        let cpyf = out.ast_nodes.iter().find(|n| n.kind == AstNodeKind::Custom("FileCopy".to_string())).unwrap();
        assert_eq!(cpyf.properties.get("from_file").unwrap().as_str(), Some("LIB1/FILE1"));
    }

    #[test]
    fn test_opnqryf() {
        let src = make_source("OPNQRYF FILE((CUSTFILE)) QRYSLT('CUSTID *EQ 100') KEYFLD((CUSTNM))");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("QueryFile".to_string())));
    }

    #[test]
    fn test_addlible_rmvlible() {
        let src = make_source("ADDLIBLE LIB(PRODLIB) POSITION(*FIRST)\nRMVLIBLE LIB(TESTLIB)");
        let out = ClParser::new().parse(&src).unwrap();
        let libops: Vec<_> = out.ast_nodes.iter()
            .filter(|n| n.kind == AstNodeKind::Custom("LibraryList".to_string()))
            .collect();
        assert_eq!(libops.len(), 2);
    }

    #[test]
    fn test_rtvjoba() {
        let src = make_source("RTVJOBA JOB(&JOBNAME) USER(&USERNAME)");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("RetrieveValue".to_string())));
    }

    #[test]
    fn test_resolve_dependencies() {
        let src = make_source("DCLF FILE(CUSTFILE)\nCALL PGM(PGM1)\nCALLPRC PRC('PROC2')\nSBMJOB CMD(CALL PGM(PGM3))");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let vault = SourceVault::new(PathBuf::from("/"));
        let deps = parser.resolve_dependencies(&out, &vault);
        assert!(deps.iter().any(|d| d.to_module == "PGM1"));
        assert!(deps.iter().any(|d| d.to_module == "'PROC2'"));
        assert!(deps.iter().any(|d| d.to_module == "PGM3"));
        assert!(deps.iter().any(|d| d.to_module == "CUSTFILE"));
    }

    #[test]
    fn test_analysis_graph() {
        let src = make_source("PGM\nCALL PGM(RPGPGM)\nMONMSG MSGID(CPF0000)\nENDPGM");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let graph = parser.to_analysis_graph(&out).unwrap();
        assert!(graph.nodes.iter().any(|n| matches!(n.kind, AnalysisNodeKind::EntryPoint)));
        assert!(graph.nodes.iter().any(|n| matches!(n.kind, AnalysisNodeKind::ExternalCall)));
        assert!(graph.nodes.iter().any(|n| matches!(n.kind, AnalysisNodeKind::ErrorHandler)));
        assert!(graph.edges.iter().any(|e| matches!(e.kind, AnalysisEdgeKind::CallsInto)));
    }

    #[test]
    fn test_metadata_counts() {
        let src = make_source(
            "PGM PARM(&X)\n\
             DCL VAR(&X) TYPE(*CHAR) LEN(10)\n\
             DCLF FILE(MYFILE)\n\
             CHGVAR VAR(&X) VALUE('TEST')\n\
             IF COND(&X *EQ 'TEST') THEN(DO)\n\
             CALL PGM(PGM1)\n\
             MONMSG MSGID(CPF0000)\n\
             ENDDO\n\
             ENDIF\n\
             ENDPGM"
        );
        let out = ClParser::new().parse(&src).unwrap();
        assert_eq!(out.metadata.get("pgm_count").unwrap().as_u64(), Some(1));
        assert_eq!(out.metadata.get("dcl_var_count").unwrap().as_u64(), Some(1));
        assert_eq!(out.metadata.get("dclf_count").unwrap().as_u64(), Some(1));
        assert_eq!(out.metadata.get("chgvar_count").unwrap().as_u64(), Some(1));
        assert_eq!(out.metadata.get("if_count").unwrap().as_u64(), Some(1));
        assert_eq!(out.metadata.get("call_count").unwrap().as_u64(), Some(1));
        assert_eq!(out.metadata.get("monmsg_count").unwrap().as_u64(), Some(1));
        assert_eq!(out.metadata.get("do_count").unwrap().as_u64(), Some(1));
    }

    #[test]
    fn test_dlyjob() {
        let src = make_source("DLYJOB DLY(30)");
        let out = ClParser::new().parse(&src).unwrap();
        let dly = out.ast_nodes.iter().find(|n| n.kind == AstNodeKind::Custom("DelayJob".to_string())).unwrap();
        assert_eq!(dly.properties.get("delay_seconds").unwrap().as_str(), Some("30"));
    }

    #[test]
    fn test_dspffd() {
        let src = make_source("DSPFFD FILE(MYLIB/MYFILE) OUTPUT(*OUTFILE) OUTFILE(QTEMP/FFDOUT)");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("DisplayFileDesc".to_string())));
    }

    #[test]
    fn test_ovrdbf_dltovr() {
        let src = make_source("OVRDBF FILE(LOGICALF) TOFILE(PHYSLIB/PHYSICALF) MBR(MBR01)\nDLTOVR FILE(LOGICALF)");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("FileOverride".to_string())));
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("DeleteOverride".to_string())));
    }

    #[test]
    fn test_rtvdtaara() {
        let src = make_source("RTVDTAARA DTAARA(MYLIB/MYAREA) RTNVAR(&RESULT)");
        let out = ClParser::new().parse(&src).unwrap();
        let rtv = out.ast_nodes.iter().find(|n| {
            n.kind == AstNodeKind::Custom("RetrieveValue".to_string()) && n.name.as_deref() == Some("RTVDTAARA")
        }).unwrap();
        assert_eq!(rtv.properties.get("data_area").unwrap().as_str(), Some("MYLIB/MYAREA"));
    }

    #[test]
    fn test_rcvmsg() {
        let src = make_source("RCVMSG PGMQ(*SAME) MSGTYPE(*LAST) MSG(&MSGTEXT) MSGID(&MSGID)");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("ReceiveMessage".to_string())));
    }

    #[test]
    fn test_clof() {
        let src = make_source("CLOF OPNID(CUSTFILE)");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("CloseFile".to_string())));
    }

    #[test]
    fn test_can_parse_positive() {
        let src = make_source("PGM\nDCL VAR(&X) TYPE(*CHAR) LEN(10)\nENDPGM");
        assert!(ClParser::new().can_parse(&src));
    }

    #[test]
    fn test_dialect_detection() {
        let clle_src = "PGM\nCALLPRC PRC('myproc')\nENDPGM";
        assert_eq!(ClParser::detect_dialect(clle_src), "CLLE");

        let clp_src = "PGM\nCALL PGM(MYPGM)\nENDPGM";
        assert_eq!(ClParser::detect_dialect(clp_src), "CLP");
    }

    #[test]
    fn test_extract_parm_nested_parens() {
        let line = "OPNQRYF FILE((CUSTFILE)) QRYSLT('CUSTID *EQ 100')";
        assert_eq!(ClParser::extract_parm(line, "FILE"), Some("(CUSTFILE)".to_string()));
        assert_eq!(ClParser::extract_parm(line, "QRYSLT"), Some("'CUSTID *EQ 100'".to_string()));
    }

    #[test]
    fn test_unbalanced_blocks_diagnostic() {
        let src = make_source("IF COND(&X *EQ 1) THEN(DO)\nCHGVAR VAR(&Y) VALUE(2)");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.diagnostics.iter().any(|d| d.message.contains("unclosed IF")));
        assert!(out.diagnostics.iter().any(|d| d.message.contains("unclosed DO")));
    }

    // ── Phase 3: New CL command tests ──────────────────────────────

    #[test]
    fn test_crtdtaara() {
        let src = make_source("CRTDTAARA DTAARA(MYLIB/MYAREA) TYPE(*CHAR) LEN(50) VALUE('INIT')");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("CreateDataArea".to_string())).unwrap();
        assert_eq!(node.name.as_deref(), Some("MYLIB/MYAREA"));
        assert_eq!(node.properties.get("type").unwrap().as_str(), Some("*CHAR"));
        assert_eq!(node.properties.get("length").unwrap().as_str(), Some("50"));
        assert_eq!(node.properties.get("value").unwrap().as_str(), Some("'INIT'"));
    }

    #[test]
    fn test_chgdtaara() {
        let src = make_source("CHGDTAARA DTAARA(MYLIB/CTLAREA) VALUE('RUNNING')");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("ChangeDataArea".to_string())).unwrap();
        assert_eq!(node.name.as_deref(), Some("MYLIB/CTLAREA"));
        assert_eq!(node.properties.get("value").unwrap().as_str(), Some("'RUNNING'"));
    }

    #[test]
    fn test_sndrcvf() {
        let src = make_source("DCLF FILE(MYLIB/SCREEN01)\nSNDRCVF RCDFMT(PROMPT)");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("ScreenIO".to_string())).unwrap();
        assert_eq!(node.name.as_deref(), Some("PROMPT"));
        assert_eq!(node.properties.get("command").unwrap().as_str(), Some("SNDRCVF"));
    }

    #[test]
    fn test_sndf_rcvf() {
        let src = make_source("SNDF RCDFMT(HDR)\nRCVF RCDFMT(DTL) DEV(*REQUESTER)");
        let out = ClParser::new().parse(&src).unwrap();
        let screen_nodes: Vec<_> = out.ast_nodes.iter()
            .filter(|n| n.kind == AstNodeKind::Custom("ScreenIO".to_string()))
            .collect();
        assert_eq!(screen_nodes.len(), 2);
        // SNDF
        assert_eq!(screen_nodes[0].properties.get("direction").unwrap().as_str(), Some("send"));
        // RCVF
        assert_eq!(screen_nodes[1].properties.get("direction").unwrap().as_str(), Some("receive"));
    }

    #[test]
    fn test_chglibl() {
        let src = make_source("CHGLIBL LIBL(LIB1 LIB2 LIB3) CURLIB(MYLIB)");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("LibraryList".to_string()) && n.name.as_deref() == Some("CHGLIBL"))
            .unwrap();
        assert!(node.properties.get("library_list").is_some());
        assert_eq!(node.properties.get("current_library").unwrap().as_str(), Some("MYLIB"));
    }

    #[test]
    fn test_crtpf_crtlf() {
        let src = make_source("CRTPF FILE(MYLIB/CUSTPF) SRCFILE(QDDSSRC)\nCRTLF FILE(MYLIB/CUSTLF) SRCFILE(QDDSSRC)");
        let out = ClParser::new().parse(&src).unwrap();
        let creates: Vec<_> = out.ast_nodes.iter()
            .filter(|n| n.kind == AstNodeKind::Custom("CreateObject".to_string()))
            .collect();
        assert_eq!(creates.len(), 2);
        assert_eq!(creates[0].name.as_deref(), Some("MYLIB/CUSTPF"));
        assert_eq!(creates[1].name.as_deref(), Some("MYLIB/CUSTLF"));
    }

    #[test]
    fn test_crtbndrpg() {
        let src = make_source("CRTBNDRPG PGM(MYLIB/MYPGM) SRCFILE(QRPGLESRC) SRCMBR(MYPGM) DFTACTGRP(*NO)");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("CompileCommand".to_string())).unwrap();
        assert_eq!(node.name.as_deref(), Some("MYLIB/MYPGM"));
        assert_eq!(node.properties.get("command").unwrap().as_str(), Some("CRTBNDRPG"));
    }

    #[test]
    fn test_compile_commands_other() {
        let src = make_source("CRTRPGMOD MODULE(MYLIB/MOD1)\nCRTSRVPGM SRVPGM(MYLIB/SRV1)\nCRTBNDCL PGM(MYLIB/CLPGM)");
        let out = ClParser::new().parse(&src).unwrap();
        let compiles: Vec<_> = out.ast_nodes.iter()
            .filter(|n| n.kind == AstNodeKind::Custom("CompileCommand".to_string()))
            .collect();
        assert_eq!(compiles.len(), 3);
    }

    #[test]
    fn test_runsql() {
        let src = make_source("RUNSQL SQL('CREATE TABLE MYLIB/MYTBL (ID INT, NAME CHAR(50))') COMMIT(*NONE)");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("RunSQL".to_string())).unwrap();
        assert_eq!(node.properties.get("command").unwrap().as_str(), Some("RUNSQL"));
        assert!(node.properties.get("sql").unwrap().as_str().unwrap().contains("CREATE TABLE"));
    }

    #[test]
    fn test_runsqlstm() {
        let src = make_source("RUNSQLSTM SRCFILE(MYLIB/QSQLSRC) SRCMBR(SETUP)");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("RunSQL".to_string())).unwrap();
        assert_eq!(node.properties.get("command").unwrap().as_str(), Some("RUNSQLSTM"));
        assert_eq!(node.properties.get("source_file").unwrap().as_str(), Some("MYLIB/QSQLSRC"));
    }

    #[test]
    fn test_subr_endsubr() {
        let src = make_source("PGM\nSUBR SUBR(CLEANUP)\nDLTOVR FILE(*ALL)\nENDSUBR\nENDPGM");
        let out = ClParser::new().parse(&src).unwrap();
        assert!(out.symbols.iter().any(|s| s.name == "CLEANUP" && s.kind == SymbolKind::Subroutine));
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Paragraph));
        assert!(out.ast_nodes.iter().any(|n| n.kind == AstNodeKind::Custom("EndSubroutine".to_string())));
    }

    #[test]
    fn test_chkobj() {
        let src = make_source("CHKOBJ OBJ(MYLIB/MYFILE) OBJTYPE(*FILE)");
        let out = ClParser::new().parse(&src).unwrap();
        let node = out.ast_nodes.iter()
            .find(|n| n.kind == AstNodeKind::Custom("CheckObject".to_string())).unwrap();
        assert_eq!(node.name.as_deref(), Some("MYLIB/MYFILE"));
        assert_eq!(node.properties.get("object_type").unwrap().as_str(), Some("*FILE"));
    }

    #[test]
    fn test_system_commands() {
        let src = make_source("WRKOBJ OBJ(MYLIB/*ALL)\nDSPOBJD OBJ(MYLIB/MYPGM) OBJTYPE(*PGM)");
        let out = ClParser::new().parse(&src).unwrap();
        let sys: Vec<_> = out.ast_nodes.iter()
            .filter(|n| n.kind == AstNodeKind::Custom("SystemCommand".to_string()))
            .collect();
        assert_eq!(sys.len(), 2);
    }

    #[test]
    fn test_cross_language_deps_compile() {
        let src = make_source("CRTBNDRPG PGM(MYLIB/RPGPGM) SRCFILE(QRPGLESRC)\nCRTBNDCL PGM(MYLIB/CLPGM)");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let vault = SourceVault::new(PathBuf::from("/"));
        let deps = parser.resolve_dependencies(&out, &vault);
        // CRTBNDRPG => cross-language to RPG
        assert!(deps.iter().any(|d| matches!(&d.dependency_type,
            DependencyType::CrossLanguage { target_language } if target_language == "rpg")));
        // CRTBNDCL => cross-language to CL
        assert!(deps.iter().any(|d| matches!(&d.dependency_type,
            DependencyType::CrossLanguage { target_language } if target_language == "cl")));
    }

    #[test]
    fn test_cross_language_deps_create_file() {
        let src = make_source("CRTPF FILE(MYLIB/CUSTPF) SRCFILE(QDDSSRC)");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let vault = SourceVault::new(PathBuf::from("/"));
        let deps = parser.resolve_dependencies(&out, &vault);
        assert!(deps.iter().any(|d| matches!(&d.dependency_type,
            DependencyType::CrossLanguage { target_language } if target_language == "dds")));
    }

    #[test]
    fn test_runsql_dependency() {
        let src = make_source("RUNSQL SQL('SELECT * FROM MYTABLE')");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let vault = SourceVault::new(PathBuf::from("/"));
        let deps = parser.resolve_dependencies(&out, &vault);
        assert!(deps.iter().any(|d| matches!(d.dependency_type, DependencyType::DatabaseAccess)));
    }

    #[test]
    fn test_screen_io_dependency() {
        let src = make_source("DCLF FILE(MYLIB/SCRN01)\nSNDRCVF RCDFMT(MAIN)");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let vault = SourceVault::new(PathBuf::from("/"));
        let deps = parser.resolve_dependencies(&out, &vault);
        assert!(deps.iter().any(|d| matches!(&d.dependency_type,
            DependencyType::CrossLanguage { target_language } if target_language == "dds")));
    }

    #[test]
    fn test_analysis_graph_screen_io() {
        let src = make_source("PGM\nDCLF FILE(SCRN01)\nSNDRCVF RCDFMT(PROMPT)\nENDPGM");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let graph = parser.to_analysis_graph(&out).unwrap();
        assert!(graph.nodes.iter().any(|n| matches!(n.kind, AnalysisNodeKind::UIInteraction)));
    }

    #[test]
    fn test_analysis_graph_runsql() {
        let src = make_source("PGM\nRUNSQL SQL('INSERT INTO LOG VALUES(1)')\nENDPGM");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let graph = parser.to_analysis_graph(&out).unwrap();
        assert!(graph.nodes.iter().any(|n| matches!(n.kind, AnalysisNodeKind::DatabaseOperation)));
    }

    #[test]
    fn test_analysis_graph_subroutine() {
        let src = make_source("PGM\nSUBR SUBR(INIT)\nCHGVAR VAR(&X) VALUE('Y')\nENDSUBR\nENDPGM");
        let parser = ClParser::new();
        let out = parser.parse(&src).unwrap();
        let graph = parser.to_analysis_graph(&out).unwrap();
        // Subroutine creates an EntryPoint (in addition to the program entry)
        let entry_nodes: Vec<_> = graph.nodes.iter()
            .filter(|n| matches!(n.kind, AnalysisNodeKind::EntryPoint))
            .collect();
        assert!(entry_nodes.len() >= 2, "Should have program entry + subroutine entry");
    }
}
