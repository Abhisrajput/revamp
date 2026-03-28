//! COBOL parser — Tier 1 deep parser implementing LanguageParser trait.
//!
//! Handles COBOL 74/85/2002 with full structural parsing:
//!   - All 4 divisions (IDENTIFICATION, ENVIRONMENT, DATA, PROCEDURE)
//!   - DATA DIVISION: level numbers, PIC clauses, REDEFINES, 88-level conditions
//!   - PROCEDURE DIVISION: paragraphs, sections, PERFORM/PERFORM THRU, CALL, GO TO
//!   - Embedded: EXEC SQL, EXEC CICS, EXEC DLI with content extraction
//!   - COPY/REPLACE statements for dependency resolution
//!   - Dialect detection (fixed-format vs free-format, COBOL-74/85/2002)

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct CobolParser;

impl CobolParser {
    pub fn new() -> Self { Self }

    /// Extract the effective source line, skipping columns 1-6 (sequence) and
    /// column 7 (indicator) for fixed-format COBOL. Returns (indicator, content).
    fn effective_line(line: &str) -> (char, &str) {
        if line.len() <= 6 { return (' ', line.trim()); }
        let indicator = line.as_bytes().get(6).map(|&b| b as char).unwrap_or(' ');
        let content = if line.len() > 7 { &line[7..] } else { "" };
        (indicator, content)
    }

    /// Detect if this is fixed-format (columns 7-72) or free-format COBOL.
    fn detect_format(content: &str) -> &'static str {
        for line in content.lines().take(20) {
            let upper = line.to_uppercase();
            if upper.contains(">>SOURCE FORMAT IS FREE") || upper.contains(">>SOURCE FREE") {
                return "free";
            }
        }
        // Check if lines have content in columns 1-6 that looks like sequence numbers
        let mut seq_count = 0;
        for line in content.lines().take(30) {
            if line.len() >= 6 && line[..6].chars().all(|c| c.is_ascii_digit() || c == ' ') {
                seq_count += 1;
            }
        }
        if seq_count > 5 { "fixed" } else { "free" }
    }

    /// Detect COBOL dialect from source features.
    fn detect_dialect(content: &str) -> &'static str {
        let upper = content.to_uppercase();
        // COBOL-2002 features
        if upper.contains("INVOKE ") || upper.contains("CLASS-ID") || upper.contains("FACTORY") {
            return "COBOL-2002";
        }
        // COBOL-85 features (EVALUATE, NOT, END-IF, END-PERFORM, inline PERFORM)
        if upper.contains("EVALUATE ") || upper.contains("END-IF")
            || upper.contains("END-PERFORM") || upper.contains("END-CALL") {
            return "COBOL-85";
        }
        "COBOL-74"
    }

    /// Parse DATA DIVISION items: level numbers, PIC clauses, REDEFINES, 88-levels.
    fn parse_data_items(
        &self,
        lines: &[(usize, char, String)], // (line_num, indicator, content)
        start_idx: usize,
        end_idx: usize,
    ) -> (Vec<AstNode>, Vec<Symbol>) {
        let mut nodes = Vec::new();
        let mut symbols = Vec::new();
        let mut i = start_idx;

        while i < end_idx {
            let (line_num, indicator, ref content) = lines[i];

            // FD / SD file descriptions
            let trimmed_upper = content.trim().to_uppercase();
            if trimmed_upper.starts_with("FD ") || trimmed_upper.starts_with("SD ") {
                let prefix = if trimmed_upper.starts_with("FD") { "FD " } else { "SD " };
                let file_name = trimmed_upper[prefix.len()..].split_whitespace().next()
                    .unwrap_or("").trim_end_matches('.').to_string();
                if !file_name.is_empty() {
                    symbols.push(Symbol {
                        name: file_name.clone(), kind: SymbolKind::FileDescription,
                        span: Span { start_line: line_num, start_col: 0, end_line: line_num, end_col: content.len() },
                        visibility: Visibility::Public,
                        data_type: Some(prefix.trim().to_string()),
                        properties: HashMap::new(),
                    });
                    nodes.push(AstNode {
                        id: format!("fd-{}", line_num), kind: AstNodeKind::FileDeclaration,
                        name: Some(file_name),
                        span: Span { start_line: line_num, start_col: 0, end_line: line_num, end_col: content.len() },
                        children: vec![],
                        properties: HashMap::from([("type".to_string(), serde_json::json!(prefix.trim()))]),
                    });
                }
                i += 1; continue;
            }

            // SECTION headers
            if trimmed_upper.ends_with("SECTION.") || trimmed_upper.ends_with("SECTION") {
                nodes.push(AstNode {
                    id: format!("section-{}", line_num), kind: AstNodeKind::Section,
                    name: Some(trimmed_upper.split(" SECTION").next().unwrap_or("").to_string()),
                    span: Span { start_line: line_num, start_col: 0, end_line: line_num, end_col: content.len() },
                    children: vec![], properties: HashMap::new(),
                });
                i += 1; continue;
            }

            let (line_num, indicator, ref content) = lines[i];
            if indicator == '*' || indicator == '/' { i += 1; continue; } // Comment

            let trimmed = content.trim().to_uppercase();
            if trimmed.is_empty() { i += 1; continue; }

            // Accumulate continued lines (lines ending without period)
            let mut full_stmt = trimmed.clone();
            let stmt_start = line_num;
            let mut stmt_end = line_num;
            while !full_stmt.ends_with('.') && i + 1 < end_idx {
                i += 1;
                let (ln, ind, ref cont) = lines[i];
                if ind == '*' || ind == '/' { continue; }
                let next = cont.trim().to_uppercase();
                if next.is_empty() { continue; }
                full_stmt.push(' ');
                full_stmt.push_str(&next);
                stmt_end = ln;
            }
            let full_stmt = full_stmt.trim_end_matches('.').trim().to_string();

            // Parse level number
            let parts: Vec<&str> = full_stmt.split_whitespace().collect();
            if parts.is_empty() { i += 1; continue; }

            if let Ok(level) = parts[0].parse::<u8>() {
                if level <= 88 {
                    let data_name = parts.get(1).unwrap_or(&"FILLER").to_string();
                    let span = Span { start_line: stmt_start, start_col: 0, end_line: stmt_end, end_col: 72 };

                    // Extract PIC clause
                    let pic = full_stmt.split("PIC ").nth(1)
                        .or_else(|| full_stmt.split("PICTURE ").nth(1))
                        .map(|p| p.split_whitespace().next().unwrap_or("").to_string());

                    // Check for REDEFINES
                    let redefines = full_stmt.contains("REDEFINES ");
                    let redefines_target = if redefines {
                        full_stmt.split("REDEFINES ").nth(1)
                            .and_then(|r| r.split_whitespace().next())
                            .map(|s| s.to_string())
                    } else { None };

                    // Check for OCCURS
                    let occurs = full_stmt.contains("OCCURS ");

                    let mut props = HashMap::new();
                    props.insert("level".to_string(), serde_json::json!(level));
                    if let Some(ref p) = pic { props.insert("pic".to_string(), serde_json::json!(p)); }
                    if redefines { props.insert("redefines".to_string(), serde_json::json!(redefines_target)); }
                    if occurs { props.insert("occurs".to_string(), serde_json::json!(true)); }

                    let kind = if level == 88 {
                        AstNodeKind::LevelCondition
                    } else if redefines {
                        AstNodeKind::Redefines
                    } else if level == 1 || level == 77 {
                        AstNodeKind::DataDeclaration
                    } else {
                        AstNodeKind::DataDeclaration
                    };

                    let is_group = pic.is_none() && level != 88 && level != 77 && level != 66;

                    nodes.push(AstNode {
                        id: format!("data-{}-{}", level, stmt_start),
                        kind: if is_group { AstNodeKind::DataGroup } else { kind },
                        name: Some(data_name.clone()),
                        span: span.clone(),
                        children: vec![],
                        properties: props,
                    });

                    let sym_kind = if level == 88 { SymbolKind::Condition88 }
                        else { SymbolKind::DataItem };

                    symbols.push(Symbol {
                        name: data_name,
                        kind: sym_kind,
                        span,
                        visibility: Visibility::Internal,
                        data_type: pic,
                        properties: HashMap::new(),
                    });
                }
            }
            i += 1;
        }
        (nodes, symbols)
    }

    /// Parse PROCEDURE DIVISION: paragraphs, PERFORM, CALL, GO TO, IF, EVALUATE.
    fn parse_procedure(
        &self,
        lines: &[(usize, char, String)],
        start_idx: usize,
        end_idx: usize,
    ) -> (Vec<AstNode>, Vec<Symbol>) {
        let mut nodes = Vec::new();
        let mut symbols = Vec::new();

        for i in start_idx..end_idx {
            let (line_num, indicator, ref content) = lines[i];
            if indicator == '*' || indicator == '/' { continue; }

            let trimmed = content.trim();
            if trimmed.is_empty() { continue; }
            let upper = trimmed.to_uppercase();
            let span = Span { start_line: line_num, start_col: 0, end_line: line_num, end_col: trimmed.len() };

            // Section header: NAME SECTION.
            if upper.ends_with(" SECTION.") || upper.ends_with(" SECTION") {
                let name = upper.split(" SECTION").next().unwrap_or("").trim();
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Section,
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: HashMap::new(),
                });
                nodes.push(AstNode {
                    id: format!("section-{}", line_num), kind: AstNodeKind::Section,
                    name: Some(name.to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
                continue;
            }

            // Paragraph name: single word ending with period, starts in area A (col 8-11)
            // Exclude COBOL scope terminators and keywords
            if trimmed.ends_with('.') && !trimmed.contains(' ')
                && !upper.starts_with("STOP") && !upper.starts_with("EXIT")
                && !upper.starts_with("END-") && !upper.starts_with("GOBACK")
                && !upper.starts_with("CONTINUE") && !upper.starts_with("ELSE")
                && trimmed.len() > 1
            {
                let name = trimmed.trim_end_matches('.');
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Paragraph,
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: HashMap::new(),
                });
                nodes.push(AstNode {
                    id: format!("para-{}", line_num), kind: AstNodeKind::Paragraph,
                    name: Some(name.to_string()), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
                continue;
            }

            // PERFORM [paragraph] [THRU paragraph] [UNTIL condition] [TIMES]
            if upper.starts_with("PERFORM ") {
                let rest = &upper[8..].trim_end_matches('.');
                let mut props = HashMap::new();

                if rest.contains(" THRU ") || rest.contains(" THROUGH ") {
                    let sep = if rest.contains(" THRU ") { " THRU " } else { " THROUGH " };
                    let parts: Vec<&str> = rest.splitn(2, sep).collect();
                    let from_para = parts[0].split_whitespace().next().unwrap_or("");
                    let to_para = parts.get(1)
                        .and_then(|s| s.split_whitespace().next())
                        .unwrap_or("");
                    props.insert("from".to_string(), serde_json::json!(from_para));
                    props.insert("thru".to_string(), serde_json::json!(to_para));
                    props.insert("is_thru".to_string(), serde_json::json!(true));
                } else if rest.contains(" UNTIL ") {
                    let target = rest.split(" UNTIL ").next().unwrap_or("").trim();
                    let condition = rest.split(" UNTIL ").nth(1).unwrap_or("").trim();
                    props.insert("target".to_string(), serde_json::json!(target));
                    props.insert("until".to_string(), serde_json::json!(condition));
                } else if rest.contains(" TIMES") {
                    props.insert("target".to_string(), serde_json::json!(rest.replace(" TIMES", "").trim()));
                    props.insert("loop_type".to_string(), serde_json::json!("times"));
                } else {
                    let target = rest.split_whitespace().next().unwrap_or("");
                    props.insert("target".to_string(), serde_json::json!(target));
                }

                nodes.push(AstNode {
                    id: format!("perform-{}", line_num), kind: AstNodeKind::PerformStatement,
                    name: Some(rest.to_string()), span: span.clone(),
                    children: vec![], properties: props,
                });
                continue;
            }

            // CALL 'program-name' USING ...
            if upper.starts_with("CALL ") {
                let rest = &upper[5..];
                let program = rest.split('\'').nth(1)
                    .or_else(|| rest.split('"').nth(1))
                    .or_else(|| rest.split_whitespace().next())
                    .unwrap_or("UNKNOWN");

                let mut props = HashMap::new();
                props.insert("program".to_string(), serde_json::json!(program));

                // Extract USING parameters
                if let Some(using_part) = rest.split(" USING ").nth(1) {
                    let params: Vec<&str> = using_part.trim_end_matches('.')
                        .split_whitespace()
                        .filter(|s| *s != "BY" && *s != "REFERENCE" && *s != "CONTENT" && *s != "VALUE")
                        .collect();
                    props.insert("using".to_string(), serde_json::json!(params));
                }

                nodes.push(AstNode {
                    id: format!("call-{}", line_num), kind: AstNodeKind::CallStatement,
                    name: Some(program.to_string()), span: span.clone(),
                    children: vec![], properties: props,
                });
                continue;
            }

            // GO TO paragraph
            if upper.starts_with("GO TO ") || upper.starts_with("GOTO ") {
                let target = upper.replace("GO TO ", "").replace("GOTO ", "")
                    .trim_end_matches('.').trim().to_string();
                nodes.push(AstNode {
                    id: format!("goto-{}", line_num), kind: AstNodeKind::GoToStatement,
                    name: Some(target), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
                continue;
            }

            // EVALUATE (COBOL-85+ switch/case)
            if upper.starts_with("EVALUATE ") {
                let subject = upper[9..].trim_end_matches('.').trim().to_string();
                nodes.push(AstNode {
                    id: format!("evaluate-{}", line_num), kind: AstNodeKind::EvaluateStatement,
                    name: Some(subject), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
                continue;
            }

            // IF condition (may span multiple lines in COBOL)
            if upper.starts_with("IF ") {
                let mut condition = upper[3..].trim_end_matches('.').trim().to_string();
                let mut end_line_num = line_num;

                // COBOL IF conditions can span multiple continuation lines.
                // Look ahead and accumulate lines that are part of the condition
                // (i.e., lines that don't start with a known COBOL verb keyword).
                if !condition.ends_with('.') {
                    let verb_keywords = [
                        "PERFORM", "CALL", "MOVE", "COMPUTE", "ADD", "SUBTRACT",
                        "MULTIPLY", "DIVIDE", "GO", "STOP", "EXIT", "IF", "ELSE",
                        "END-IF", "EVALUATE", "WHEN", "END-EVALUATE", "READ", "WRITE",
                        "OPEN", "CLOSE", "DISPLAY", "ACCEPT", "EXEC", "COPY", "STRING",
                        "UNSTRING", "INSPECT", "SEARCH", "ALTER", "SORT", "MERGE", "SET",
                        "INITIALIZE", "END-PERFORM", "END-CALL", "END-READ",
                    ];
                    for j in (i + 1)..end_idx {
                        let (_, ind_j, ref cont_j) = lines[j];
                        if ind_j == '*' || ind_j == '/' { continue; }
                        let next_trimmed = cont_j.trim();
                        if next_trimmed.is_empty() { continue; }
                        let next_upper = next_trimmed.to_uppercase();
                        let first_word = next_upper.split_whitespace().next().unwrap_or("");
                        // Stop if the line starts with a known verb or scope terminator
                        if verb_keywords.iter().any(|v| first_word == *v || first_word.starts_with("END-")) {
                            break;
                        }
                        // Continuation tokens: AND, OR, NOT, or data names / comparisons
                        condition.push(' ');
                        condition.push_str(next_upper.trim_end_matches('.').trim());
                        end_line_num = lines[j].0;
                        if next_trimmed.ends_with('.') { break; }
                    }
                }

                let if_span = Span { start_line: line_num, start_col: 0, end_line: end_line_num, end_col: trimmed.len() };
                nodes.push(AstNode {
                    id: format!("if-{}", line_num), kind: AstNodeKind::IfStatement,
                    name: None, span: if_span,
                    children: vec![],
                    properties: HashMap::from([
                        ("condition".to_string(), serde_json::json!(condition)),
                    ]),
                });
                continue;
            }

            // COMPUTE / MOVE / ADD / SUBTRACT / MULTIPLY / DIVIDE
            if upper.starts_with("COMPUTE ") {
                nodes.push(AstNode {
                    id: format!("compute-{}", line_num), kind: AstNodeKind::ComputeStatement,
                    name: None, span: span.clone(), children: vec![],
                    properties: HashMap::from([("expr".to_string(), serde_json::json!(upper[8..].trim_end_matches('.')))]),
                });
            } else if upper.starts_with("MOVE ") {
                nodes.push(AstNode {
                    id: format!("move-{}", line_num), kind: AstNodeKind::MoveStatement,
                    name: None, span: span.clone(), children: vec![],
                    properties: HashMap::from([("expr".to_string(), serde_json::json!(upper[5..].trim_end_matches('.')))]),
                });
            }

            // COPY statement
            if upper.starts_with("COPY ") {
                let copy_name = upper[5..].split_whitespace().next()
                    .unwrap_or("").trim_end_matches('.').to_string();
                let mut props = HashMap::new();
                if upper.contains(" REPLACING ") {
                    props.insert("has_replacing".to_string(), serde_json::json!(true));
                }
                nodes.push(AstNode {
                    id: format!("copy-{}", line_num), kind: AstNodeKind::CopyStatement,
                    name: Some(copy_name), span: span.clone(),
                    children: vec![], properties: props,
                });
            }

            // READ / WRITE / DISPLAY
            if upper.starts_with("READ ") {
                let file = upper[5..].split_whitespace().next().unwrap_or("").trim_end_matches('.').to_string();
                nodes.push(AstNode {
                    id: format!("read-{}", line_num), kind: AstNodeKind::ReadStatement,
                    name: Some(file), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }
            if upper.starts_with("WRITE ") {
                let rec = upper[6..].split_whitespace().next().unwrap_or("").trim_end_matches('.').to_string();
                nodes.push(AstNode {
                    id: format!("write-{}", line_num), kind: AstNodeKind::WriteStatement,
                    name: Some(rec), span: span.clone(),
                    children: vec![], properties: HashMap::new(),
                });
            }

            // ADD / SUBTRACT / MULTIPLY / DIVIDE (arithmetic verbs)
            for verb in &["ADD ", "SUBTRACT ", "MULTIPLY ", "DIVIDE "] {
                if upper.starts_with(verb) {
                    nodes.push(AstNode {
                        id: format!("arith-{}", line_num), kind: AstNodeKind::ComputeStatement,
                        name: None, span: span.clone(), children: vec![],
                        properties: HashMap::from([
                            ("verb".to_string(), serde_json::json!(verb.trim())),
                            ("expr".to_string(), serde_json::json!(upper[verb.len()..].trim_end_matches('.'))),
                        ]),
                    });
                    break;
                }
            }

            // ALTER statement (dynamic GO TO modification — dangerous legacy pattern)
            if upper.starts_with("ALTER ") {
                let rest = upper[6..].trim_end_matches('.');
                nodes.push(AstNode {
                    id: format!("alter-{}", line_num), kind: AstNodeKind::Custom("AlterStatement".to_string()),
                    name: None, span: span.clone(), children: vec![],
                    properties: HashMap::from([("target".to_string(), serde_json::json!(rest))]),
                });
            }

            // DISPLAY
            if upper.starts_with("DISPLAY ") {
                nodes.push(AstNode {
                    id: format!("display-{}", line_num), kind: AstNodeKind::DisplayStatement,
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // OPEN / CLOSE (file operations)
            if upper.starts_with("OPEN ") || upper.starts_with("CLOSE ") {
                let verb = if upper.starts_with("OPEN") { "OPEN" } else { "CLOSE" };
                let files: Vec<&str> = upper[verb.len()..].split_whitespace()
                    .filter(|w| *w != "INPUT" && *w != "OUTPUT" && *w != "I-O" && *w != "EXTEND")
                    .map(|w| w.trim_end_matches('.'))
                    .filter(|w| !w.is_empty())
                    .collect();
                for f in &files {
                    nodes.push(AstNode {
                        id: format!("fileop-{}-{}", verb.to_lowercase(), line_num),
                        kind: AstNodeKind::Custom("FileOperation".to_string()),
                        name: Some(f.to_string()), span: span.clone(), children: vec![],
                        properties: HashMap::from([("operation".to_string(), serde_json::json!(verb))]),
                    });
                }
            }

            // STRING / UNSTRING (data manipulation)
            if upper.starts_with("STRING ") || upper.starts_with("UNSTRING ") {
                nodes.push(AstNode {
                    id: format!("string-{}", line_num), kind: AstNodeKind::Custom("StringOp".to_string()),
                    name: None, span: span.clone(), children: vec![],
                    properties: HashMap::from([("operation".to_string(),
                        serde_json::json!(if upper.starts_with("STRING") { "STRING" } else { "UNSTRING" }))]),
                });
            }

            // INSPECT (string inspection/replacement)
            if upper.starts_with("INSPECT ") {
                nodes.push(AstNode {
                    id: format!("inspect-{}", line_num), kind: AstNodeKind::Custom("Inspect".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // ACCEPT / ACCEPT FROM (system input)
            if upper.starts_with("ACCEPT ") {
                nodes.push(AstNode {
                    id: format!("accept-{}", line_num), kind: AstNodeKind::Custom("Accept".to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }

            // SORT / MERGE
            if upper.starts_with("SORT ") || upper.starts_with("MERGE ") {
                let verb = if upper.starts_with("SORT") { "SORT" } else { "MERGE" };
                nodes.push(AstNode {
                    id: format!("sort-{}", line_num), kind: AstNodeKind::Custom(verb.to_string()),
                    name: None, span: span.clone(), children: vec![], properties: HashMap::new(),
                });
            }
        }

        (nodes, symbols)
    }

    /// Parse embedded EXEC SQL / EXEC CICS / EXEC DLI blocks.
    fn parse_embedded_blocks(&self, content: &str) -> Vec<EmbeddedBlock> {
        let mut blocks = Vec::new();
        let mut in_exec = false;
        let mut exec_type = EmbeddedBlockType::ExecSql;
        let mut exec_content = String::new();
        let mut start_line = 0;

        for (i, line) in content.lines().enumerate() {
            let line_num = i + 1; // Convert 0-based enumerate to 1-based line numbers
            let (indicator, effective) = Self::effective_line(line);
            if indicator == '*' || indicator == '/' { continue; }

            let trimmed = effective.trim().to_uppercase();
            if trimmed.starts_with("EXEC SQL") && !in_exec {
                in_exec = true;
                exec_type = EmbeddedBlockType::ExecSql;
                exec_content.clear();
                start_line = line_num;
            } else if trimmed.starts_with("EXEC CICS") && !in_exec {
                in_exec = true;
                exec_type = EmbeddedBlockType::ExecCics;
                exec_content.clear();
                start_line = line_num;
            } else if trimmed.starts_with("EXEC DLI") && !in_exec {
                in_exec = true;
                exec_type = EmbeddedBlockType::ExecDli;
                exec_content.clear();
                start_line = line_num;
            } else if in_exec && trimmed.contains("END-EXEC") {
                blocks.push(EmbeddedBlock {
                    language: match exec_type {
                        EmbeddedBlockType::ExecSql => "DB2-SQL".to_string(),
                        EmbeddedBlockType::ExecCics => "CICS".to_string(),
                        EmbeddedBlockType::ExecDli => "DL/I".to_string(),
                        _ => "unknown".to_string(),
                    },
                    content: exec_content.clone(),
                    span: Span { start_line, start_col: 0, end_line: line_num, end_col: line.len() },
                    block_type: exec_type.clone(),
                });
                in_exec = false;
            } else if in_exec {
                exec_content.push_str(effective.trim());
                exec_content.push('\n');
            }
        }
        blocks
    }

    /// Extract CICS commands from EXEC CICS blocks.
    /// Returns (command, operands_map) tuples for: SEND MAP, RECEIVE MAP,
    /// LINK, XCTL, READ, WRITE, DELETE, REWRITE, STARTBR, etc.
    fn extract_cics_commands(blocks: &[EmbeddedBlock]) -> Vec<HashMap<String, String>> {
        let mut commands = Vec::new();
        for block in blocks {
            if block.language != "CICS" { continue; }
            let upper = block.content.to_uppercase();
            let tokens: Vec<&str> = upper.split_whitespace().collect();
            if tokens.is_empty() { continue; }

            let mut cmd = HashMap::new();
            let cics_cmd = tokens[0].to_string();
            cmd.insert("command".to_string(), cics_cmd.clone());
            cmd.insert("line".to_string(), block.span.start_line.to_string());

            // Parse key operands as KEY(VALUE) pairs
            for token in &tokens[1..] {
                if let Some(paren) = token.find('(') {
                    let key = &token[..paren];
                    let val = token[paren+1..].trim_end_matches(')');
                    cmd.insert(key.to_string(), val.to_string());
                }
            }

            // Extract meaningful details per command type
            match cics_cmd.as_str() {
                "SEND" | "RECEIVE" => {
                    // SEND MAP('mapname') MAPSET('mapsetname')
                    if let Some(map) = cmd.get("MAP") { cmd.insert("map_name".to_string(), map.clone()); }
                    if let Some(ms) = cmd.get("MAPSET") { cmd.insert("mapset_name".to_string(), ms.clone()); }
                }
                "LINK" | "XCTL" => {
                    // LINK PROGRAM('pgmname')
                    if let Some(pgm) = cmd.get("PROGRAM") { cmd.insert("target_program".to_string(), pgm.clone()); }
                }
                "READ" | "WRITE" | "DELETE" | "REWRITE" | "STARTBR" | "READNEXT" | "READPREV" => {
                    // READ DATASET('dsname') or FILE('filename')
                    if let Some(ds) = cmd.get("DATASET").or(cmd.get("FILE")) {
                        cmd.insert("dataset".to_string(), ds.clone());
                    }
                }
                "START" => {
                    // START TRANSID('txid')
                    if let Some(tx) = cmd.get("TRANSID") { cmd.insert("transaction_id".to_string(), tx.clone()); }
                }
                _ => {}
            }

            commands.push(cmd);
        }
        commands
    }

    /// Extract SQL table references from EXEC SQL blocks.
    fn extract_sql_tables(blocks: &[EmbeddedBlock]) -> Vec<String> {
        let mut tables = Vec::new();
        for block in blocks {
            if block.language != "DB2-SQL" { continue; }
            let upper = block.content.to_uppercase();
            // Simple extraction: FROM, INTO, UPDATE, INSERT INTO, DELETE FROM, JOIN
            for keyword in &["FROM ", "INTO ", "UPDATE ", "JOIN "] {
                for part in upper.split(keyword).skip(1) {
                    let table = part.split_whitespace().next()
                        .unwrap_or("").trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if !table.is_empty() && table != "(" && table.len() > 1 {
                        if !tables.contains(&table.to_string()) {
                            tables.push(table.to_string());
                        }
                    }
                }
            }
        }
        tables
    }
}

impl LanguageParser for CobolParser {
    fn language_id(&self) -> &'static str { "cobol" }
    fn display_name(&self) -> &'static str { "COBOL 74/85/2002" }

    fn supported_dialects(&self) -> &[&'static str] {
        &["COBOL-74", "COBOL-85", "COBOL-2002", "IBM-Enterprise-COBOL"]
    }

    fn file_extensions(&self) -> &[&'static str] {
        &["cbl", "cob", "cpy", "cbl38", "sqb"]
    }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let upper = file.header.to_uppercase();
        let content_match = upper.contains("IDENTIFICATION DIVISION")
            || upper.contains("PROCEDURE DIVISION")
            || upper.contains("DATA DIVISION")
            || (upper.contains("01 ") && upper.contains("PIC "));
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let format = Self::detect_format(&source.content);
        let dialect = Self::detect_dialect(&source.content);

        // Preprocess: extract (line_number, indicator, effective_content) tuples
        let processed_lines: Vec<(usize, char, String)> = source.content.lines()
            .enumerate()
            .map(|(i, line)| {
                if format == "fixed" {
                    let (ind, content) = Self::effective_line(line);
                    (i, ind, content.to_string())
                } else {
                    (i, ' ', line.to_string())
                }
            })
            .collect();

        // Identify division boundaries
        let mut divisions: Vec<(&str, usize)> = Vec::new();
        for (idx, (_ln, _ind, content)) in processed_lines.iter().enumerate() {
            let upper = content.trim().to_uppercase();
            if upper.contains("IDENTIFICATION DIVISION") { divisions.push(("IDENTIFICATION", idx)); }
            else if upper.contains("ENVIRONMENT DIVISION") { divisions.push(("ENVIRONMENT", idx)); }
            else if upper.contains("DATA DIVISION") { divisions.push(("DATA", idx)); }
            else if upper.contains("PROCEDURE DIVISION") { divisions.push(("PROCEDURE", idx)); }
        }

        let total_lines = processed_lines.len();
        let mut all_nodes = Vec::new();
        let mut all_symbols = Vec::new();

        // Add division nodes
        for (div_name, idx) in &divisions {
            let (ln, _, _) = processed_lines[*idx];
            all_nodes.push(AstNode {
                id: format!("div-{}", div_name.to_lowercase()),
                kind: AstNodeKind::Division,
                name: Some(div_name.to_string()),
                span: Span { start_line: ln, start_col: 0, end_line: ln, end_col: 72 },
                children: vec![],
                properties: HashMap::new(),
            });
        }

        // Extract PROGRAM-ID
        let mut program_id = String::new();
        for (_ln, ind, content) in &processed_lines {
            if *ind == '*' || *ind == '/' { continue; }
            let upper = content.trim().to_uppercase();
            if upper.starts_with("PROGRAM-ID") {
                program_id = upper.split("PROGRAM-ID")
                    .nth(1).unwrap_or("")
                    .trim_start_matches(|c: char| c == '.' || c == ' ')
                    .split(|c: char| c == '.' || c.is_whitespace())
                    .next().unwrap_or("UNKNOWN")
                    .to_string();
                all_symbols.push(Symbol {
                    name: program_id.clone(),
                    kind: SymbolKind::Program,
                    span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                    visibility: Visibility::Public,
                    data_type: None,
                    properties: HashMap::new(),
                });
                break;
            }
        }

        // Parse DATA DIVISION
        let data_start = divisions.iter().find(|(n, _)| *n == "DATA").map(|(_, i)| *i);
        let proc_start = divisions.iter().find(|(n, _)| *n == "PROCEDURE").map(|(_, i)| *i);
        if let Some(ds) = data_start {
            let de = proc_start.unwrap_or(total_lines);
            let (data_nodes, data_syms) = self.parse_data_items(&processed_lines, ds + 1, de);
            all_nodes.extend(data_nodes);
            all_symbols.extend(data_syms);
        }

        // Parse PROCEDURE DIVISION
        if let Some(ps) = proc_start {
            let (proc_nodes, proc_syms) = self.parse_procedure(&processed_lines, ps + 1, total_lines);
            all_nodes.extend(proc_nodes);
            all_symbols.extend(proc_syms);
        }

        // Parse embedded blocks (EXEC SQL, EXEC CICS, EXEC DLI)
        let embedded_blocks = self.parse_embedded_blocks(&source.content);
        let sql_tables = Self::extract_sql_tables(&embedded_blocks);
        let cics_commands = Self::extract_cics_commands(&embedded_blocks);

        // Collect COPY statements from all nodes for the AST (already parsed in procedure)
        // Also scan for COPY in data division
        for (_ln, ind, content) in &processed_lines {
            if *ind == '*' { continue; }
            let upper = content.trim().to_uppercase();
            if upper.starts_with("COPY ") {
                // Check if we already have this copy node
                let copy_name = upper[5..].split_whitespace().next()
                    .unwrap_or("").trim_end_matches('.');
                if !all_nodes.iter().any(|n| {
                    matches!(n.kind, AstNodeKind::CopyStatement) && n.name.as_deref() == Some(copy_name)
                }) {
                    all_nodes.push(AstNode {
                        id: format!("copy-extra-{}", copy_name),
                        kind: AstNodeKind::CopyStatement,
                        name: Some(copy_name.to_string()),
                        span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                        children: vec![], properties: HashMap::new(),
                    });
                }
            }
        }

        // Build metadata
        let mut metadata = HashMap::new();
        metadata.insert("format".to_string(), serde_json::json!(format));
        metadata.insert("dialect".to_string(), serde_json::json!(dialect));
        metadata.insert("program_id".to_string(), serde_json::json!(program_id));
        metadata.insert("divisions".to_string(), serde_json::json!(
            divisions.iter().map(|(n, _)| *n).collect::<Vec<_>>()
        ));
        metadata.insert("sql_tables".to_string(), serde_json::json!(sql_tables));
        metadata.insert("embedded_sql_count".to_string(), serde_json::json!(
            embedded_blocks.iter().filter(|b| b.language == "DB2-SQL").count()
        ));
        metadata.insert("embedded_cics_count".to_string(), serde_json::json!(
            embedded_blocks.iter().filter(|b| b.language == "CICS").count()
        ));
        if !cics_commands.is_empty() {
            metadata.insert("cics_commands".to_string(), serde_json::json!(cics_commands));
            let cics_maps: Vec<_> = cics_commands.iter()
                .filter_map(|c| c.get("map_name"))
                .collect();
            let cics_programs: Vec<_> = cics_commands.iter()
                .filter_map(|c| c.get("target_program"))
                .collect();
            let cics_datasets: Vec<_> = cics_commands.iter()
                .filter_map(|c| c.get("dataset"))
                .collect();
            if !cics_maps.is_empty() { metadata.insert("cics_maps".to_string(), serde_json::json!(cics_maps)); }
            if !cics_programs.is_empty() { metadata.insert("cics_linked_programs".to_string(), serde_json::json!(cics_programs)); }
            if !cics_datasets.is_empty() { metadata.insert("cics_datasets".to_string(), serde_json::json!(cics_datasets)); }
        }
        metadata.insert("paragraph_count".to_string(), serde_json::json!(
            all_symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Paragraph)).count()
        ));
        metadata.insert("data_item_count".to_string(), serde_json::json!(
            all_symbols.iter().filter(|s| matches!(s.kind, SymbolKind::DataItem)).count()
        ));
        metadata.insert("condition_88_count".to_string(), serde_json::json!(
            all_symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Condition88)).count()
        ));
        metadata.insert("perform_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::PerformStatement)).count()
        ));
        metadata.insert("perform_thru_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::PerformStatement)
                && n.properties.get("is_thru").and_then(|v| v.as_bool()).unwrap_or(false)).count()
        ));
        metadata.insert("call_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::CallStatement)).count()
        ));
        metadata.insert("goto_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::GoToStatement)).count()
        ));
        metadata.insert("copy_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::CopyStatement)).count()
        ));
        metadata.insert("redefines_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::Redefines)).count()
        ));
        metadata.insert("file_descriptions".to_string(), serde_json::json!(
            all_symbols.iter().filter(|s| matches!(s.kind, SymbolKind::FileDescription)).count()
        ));
        metadata.insert("alter_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("AlterStatement".to_string())).count()
        ));
        metadata.insert("arithmetic_verb_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::ComputeStatement)).count()
        ));
        metadata.insert("file_operation_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("FileOperation".to_string())).count()
        ));
        metadata.insert("string_operation_count".to_string(), serde_json::json!(
            all_nodes.iter().filter(|n| n.kind == AstNodeKind::Custom("StringOp".to_string()) || n.kind == AstNodeKind::Custom("Inspect".to_string())).count()
        ));
        metadata.insert("total_ast_nodes".to_string(), serde_json::json!(all_nodes.len()));
        metadata.insert("total_symbols".to_string(), serde_json::json!(all_symbols.len()));

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: dialect.to_string(),
            source_path: source.path.to_string_lossy().to_string(),
            total_lines: source.content.lines().count(),
            ast_nodes: all_nodes,
            symbols: all_symbols,
            embedded_blocks,
            diagnostics: vec![],
            metadata,
        })
    }

    fn parse_partial(&self, source: &SourceFile) -> anyhow::Result<PartialParseOutput> {
        match self.parse(source) {
            Ok(output) => {
                let total = output.total_lines;
                Ok(PartialParseOutput { output, parsed_up_to_line: total, error: String::new(), coverage: 1.0 })
            }
            Err(e) => Ok(PartialParseOutput {
                output: ParseOutput {
                    language_id: self.language_id().to_string(),
                    dialect: "COBOL-85".to_string(),
                    source_path: source.path.to_string_lossy().to_string(),
                    total_lines: source.content.lines().count(),
                    ast_nodes: vec![], symbols: vec![], embedded_blocks: vec![],
                    diagnostics: vec![Diagnostic {
                        severity: DiagnosticSeverity::Error, message: e.to_string(),
                        span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 }, code: None,
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
                AstNodeKind::CopyStatement => {
                    if let Some(name) = &node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::CopyInclude,
                            source_span: node.span.clone(),
                            reference_text: format!("COPY {}", name),
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
                            reference_text: format!("CALL '{}'", name),
                        });
                    }
                }
                _ => {}
            }
        }
        for block in &module.embedded_blocks {
            deps.push(DependencyRef {
                from_module: module.source_path.clone(),
                to_module: block.language.clone(),
                dependency_type: DependencyType::DatabaseAccess,
                source_span: block.span.clone(),
                reference_text: format!("EXEC {} block ({} lines)", block.language,
                    block.span.end_line - block.span.start_line + 1),
            });
        }
        deps
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut prev_para: Option<String> = None;

        for symbol in &output.symbols {
            if matches!(symbol.kind, SymbolKind::Paragraph | SymbolKind::Section) {
                let node_id = format!("para-{}", symbol.name);
                nodes.push(AnalysisNode {
                    id: node_id.clone(),
                    kind: AnalysisNodeKind::EntryPoint,
                    name: symbol.name.clone(),
                    source_span: symbol.span.clone(),
                    properties: HashMap::new(),
                });
                // Implicit fall-through edge from previous paragraph
                if let Some(ref prev) = prev_para {
                    edges.push(AnalysisEdge {
                        from: prev.clone(), to: node_id.clone(),
                        kind: AnalysisEdgeKind::ControlFlow,
                        label: Some("fall-through".to_string()),
                    });
                }
                prev_para = Some(node_id);
            }
        }

        // PERFORM edges
        for node in &output.ast_nodes {
            if matches!(node.kind, AstNodeKind::PerformStatement) {
                if let Some(target) = node.properties.get("target").and_then(|v| v.as_str()) {
                    edges.push(AnalysisEdge {
                        from: format!("perform-{}", node.span.start_line),
                        to: format!("para-{}", target),
                        kind: AnalysisEdgeKind::CallsInto,
                        label: Some("PERFORM".to_string()),
                    });
                }
            }
            if matches!(node.kind, AstNodeKind::CallStatement) {
                if let Some(name) = &node.name {
                    nodes.push(AnalysisNode {
                        id: format!("ext-{}", name),
                        kind: AnalysisNodeKind::ExternalCall,
                        name: format!("CALL {}", name),
                        source_span: node.span.clone(),
                        properties: HashMap::new(),
                    });
                }
            }
        }

        for block in &output.embedded_blocks {
            nodes.push(AnalysisNode {
                id: format!("db-{}-{}", block.language, block.span.start_line),
                kind: AnalysisNodeKind::DatabaseOperation,
                name: format!("{} at line {}", block.language, block.span.start_line),
                source_span: block.span.clone(),
                properties: HashMap::new(),
            });
        }

        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes, edges, business_rules: vec![], data_flows: vec![],
        })
    }
}
