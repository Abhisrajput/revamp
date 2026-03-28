//! RPG parser — Tier 1 deep parser implementing LanguageParser trait.
//!
//! Handles RPG II/III/IV fixed-format and RPG IV free-format (ILE RPG).
//! Key challenges: column-based spec types (H/F/D/I/C/O/P), indicators (01-99, LR, OF),
//! built-in I/O cycle, free-format declarations (dcl-s, dcl-ds, dcl-proc),
//! embedded SQL (SQLRPGLE), /COPY and /INCLUDE directives, KLIST/KFLD,
//! PLIST/PARM, CTL-OPT, dcl-pr prototypes, DOW/DOU/FOR/MONITOR loops.

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct RpgParser;

impl RpgParser {
    pub fn new() -> Self { Self }

    /// Detect RPG format: fixed (column-based) vs free-format.
    fn detect_format(content: &str) -> &'static str {
        for line in content.lines().take(50) {
            let lower = line.to_lowercase();
            if lower.contains("**free") || lower.contains("ctl-opt")
                || lower.contains("dcl-s") || lower.contains("dcl-proc")
                || lower.contains("dcl-f") || lower.contains("dcl-ds")
                || lower.contains("dcl-pr") {
                return "free";
            }
            // /free directive (deprecated but still used)
            if lower.trim() == "/free" {
                return "free";
            }
            if line.len() >= 6 {
                let spec_char = line.chars().nth(5).unwrap_or(' ').to_ascii_uppercase();
                if "HFDICOP".contains(spec_char) && line.len() > 7 {
                    return "fixed";
                }
            }
        }
        "free"
    }

    /// Classify an indicator string into its category.
    fn classify_indicator(ind: &str) -> &'static str {
        let upper = ind.to_uppercase();
        match upper.as_str() {
            "LR" => "last-record",
            "OF" => "overflow",
            "RT" => "return",
            "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8" | "H9" => "halt",
            "KA" | "KB" | "KC" | "KD" | "KE" | "KF" | "KG" | "KH" | "KI"
            | "KJ" | "KK" | "KL" | "KM" | "KN" | "KP" | "KQ" | "KR"
            | "KS" | "KT" | "KU" | "KV" | "KW" | "KX" | "KY" => "function-key",
            "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9" => "control-level",
            "MR" => "matching-record",
            "U1" | "U2" | "U3" | "U4" | "U5" | "U6" | "U7" | "U8" => "external",
            _ => {
                if upper.parse::<u32>().map(|n| (1..=99).contains(&n)).unwrap_or(false) {
                    "general"
                } else {
                    "unknown"
                }
            }
        }
    }

    /// Parse fixed-format RPG spec lines by type.
    fn parse_fixed_format(&self, content: &str) -> (Vec<AstNode>, Vec<Symbol>, Vec<EmbeddedBlock>, Vec<Diagnostic>) {
        let mut nodes = Vec::new();
        let mut symbols = Vec::new();
        let mut embedded = Vec::new();
        let mut diagnostics = Vec::new();
        let mut in_sql = false;
        let mut sql_content = String::new();
        let mut sql_start = 0;
        let mut indicators_used: Vec<(String, String)> = Vec::new(); // (indicator, category)
        let mut current_klist: Option<String> = None;
        let mut klist_fields: Vec<String> = Vec::new();
        let mut current_plist: Option<String> = None;
        let mut plist_parms: Vec<String> = Vec::new();

        for (i, line) in content.lines().enumerate() {
            if line.len() < 6 { continue; }

            // Check for /COPY, /INCLUDE, /EXEC before spec type check
            let trimmed = line.trim().to_uppercase();

            // Embedded SQL: /EXEC SQL ... /END-EXEC or C/EXEC SQL
            if trimmed.contains("EXEC SQL") || trimmed.contains("/EXEC SQL") {
                in_sql = true;
                sql_content.clear();
                sql_start = i;
                continue;
            }
            if in_sql && (trimmed.contains("END-EXEC") || trimmed.contains("/END-EXEC")) {
                embedded.push(EmbeddedBlock {
                    language: "DB2-SQL".to_string(),
                    content: sql_content.clone(),
                    span: Span { start_line: sql_start, start_col: 0, end_line: i, end_col: line.len() },
                    block_type: EmbeddedBlockType::ExecSql,
                });
                in_sql = false;
                continue;
            }
            if in_sql {
                let sql_line = if line.len() > 7 { &line[7..] } else { "" };
                sql_content.push_str(sql_line.trim());
                sql_content.push(' ');
                continue;
            }

            let spec = line.chars().nth(5).unwrap_or(' ').to_ascii_uppercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: line.len() };

            match spec {
                'H' => {
                    // H-spec: control/header specification
                    let raw = line.get(6..).unwrap_or("").trim();
                    let mut props = HashMap::from([("raw".to_string(), serde_json::json!(raw))]);
                    let upper_raw = raw.to_uppercase();
                    if upper_raw.contains("DFTACTGRP") {
                        props.insert("dftactgrp".to_string(),
                            serde_json::json!(upper_raw.contains("DFTACTGRP(*NO)")));
                    }
                    if upper_raw.contains("ACTGRP(") {
                        if let Some(start) = upper_raw.find("ACTGRP(") {
                            let rest = &upper_raw[start + 7..];
                            if let Some(end) = rest.find(')') {
                                props.insert("actgrp".to_string(), serde_json::json!(&rest[..end]));
                            }
                        }
                    }
                    if upper_raw.contains("BNDDIR(") {
                        if let Some(start) = upper_raw.find("BNDDIR(") {
                            let rest = &upper_raw[start + 7..];
                            if let Some(end) = rest.find(')') {
                                props.insert("bnddir".to_string(), serde_json::json!(&rest[..end]));
                            }
                        }
                    }
                    nodes.push(AstNode {
                        id: format!("hspec-{}", i), kind: AstNodeKind::Custom("H-Spec".to_string()),
                        name: None, span, children: vec![], properties: props,
                    });
                }
                'F' => {
                    // F-spec: file declaration (cols 6-15=name, 16=type, 17=desig, 18=eof, 19-20=seq,
                    // 21=format, 22-27=reclen, 28=limits, 29-33=keylength, 34=addr-type, 35=org, 36-42=device, 43-80=keywords)
                    if line.len() >= 16 {
                        let file_name = line[6..16].trim().to_string();
                        let file_type = line.chars().nth(16).unwrap_or(' ');
                        let file_desig = line.chars().nth(17).unwrap_or(' ');
                        let file_format = if line.len() > 21 { line.chars().nth(21).unwrap_or(' ') } else { ' ' };
                        let device = if line.len() >= 42 { line[35..42].trim().to_string() } else { String::new() };
                        let keywords = if line.len() > 43 { line[43..].trim().to_string() } else { String::new() };

                        if !file_name.is_empty() {
                            let mut props = HashMap::new();
                            props.insert("file_type".to_string(), serde_json::json!(match file_type {
                                'I' => "Input", 'O' => "Output", 'U' => "Update", 'C' => "Combined", _ => "Unknown"
                            }));
                            props.insert("file_designation".to_string(), serde_json::json!(match file_desig {
                                'P' => "Primary", 'S' => "Secondary", 'F' => "FullProcedural",
                                'R' => "RecordAddress", _ => "Unknown"
                            }));
                            props.insert("record_format".to_string(), serde_json::json!(match file_format {
                                'E' => "Externally-Described", 'F' => "Program-Described", _ => "Unknown"
                            }));
                            if !device.is_empty() {
                                props.insert("device".to_string(), serde_json::json!(device));
                            }
                            if !keywords.is_empty() {
                                let kw_upper = keywords.to_uppercase();
                                props.insert("keywords".to_string(), serde_json::json!(keywords));
                                // Extract RENAME, PREFIX, SFILE, USROPN
                                if kw_upper.contains("USROPN") {
                                    props.insert("user_open".to_string(), serde_json::json!(true));
                                }
                                if kw_upper.contains("SFILE(") {
                                    props.insert("has_subfile".to_string(), serde_json::json!(true));
                                }
                            }
                            symbols.push(Symbol {
                                name: file_name.clone(), kind: SymbolKind::FileDescription,
                                span: span.clone(), visibility: Visibility::Public,
                                data_type: None, properties: props.clone(),
                            });
                            nodes.push(AstNode {
                                id: format!("fspec-{}", i), kind: AstNodeKind::FileDeclaration,
                                name: Some(file_name), span, children: vec![], properties: props,
                            });
                        }
                    }
                }
                'D' => {
                    // D-spec: data definition
                    // Cols 6-20=name, 21=ext-desc, 22=ext-type, 23=def-type, 24-25=from, 26-32=to/length,
                    // 33=internal-type, 34-37=decimals, 38-80=keywords
                    if line.len() >= 25 {
                        let name = line[6..21].trim().to_string();
                        let ds_type = line.chars().nth(23).unwrap_or(' ').to_ascii_uppercase();
                        let keywords = if line.len() > 43 { line[43..].trim().to_string() } else { String::new() };

                        // D-spec can also define prototypes (PR) and procedure interfaces (PI)
                        let ext_type = if line.len() > 22 {
                            let c1 = line.chars().nth(21).unwrap_or(' ').to_ascii_uppercase();
                            let c2 = line.chars().nth(22).unwrap_or(' ').to_ascii_uppercase();
                            format!("{}{}", c1, c2)
                        } else { String::new() };

                        if ds_type == 'R' || ext_type.trim() == "PR" {
                            // Prototype definition
                            if !name.is_empty() {
                                let kw_upper = keywords.to_uppercase();
                                let extpgm = kw_upper.contains("EXTPGM(") || kw_upper.contains("EXTPROC(");
                                symbols.push(Symbol {
                                    name: name.clone(),
                                    kind: SymbolKind::Custom("Prototype".to_string()),
                                    span: span.clone(), visibility: Visibility::Public,
                                    data_type: None,
                                    properties: HashMap::from([
                                        ("external".to_string(), serde_json::json!(extpgm)),
                                    ]),
                                });
                                nodes.push(AstNode {
                                    id: format!("proto-{}", i),
                                    kind: AstNodeKind::Custom("Prototype".to_string()),
                                    name: Some(name), span, children: vec![],
                                    properties: HashMap::from([
                                        ("external".to_string(), serde_json::json!(extpgm)),
                                        ("keywords".to_string(), serde_json::json!(keywords)),
                                    ]),
                                });
                            }
                        } else if !name.is_empty() {
                            let kind = match ds_type {
                                'S' => "Standalone",
                                'D' => "DataStructure",
                                'C' => "Constant",
                                _ => "Field",
                            };
                            let sym_kind = if ds_type == 'C' { SymbolKind::Constant } else { SymbolKind::Variable };
                            symbols.push(Symbol {
                                name: name.clone(), kind: sym_kind,
                                span: span.clone(), visibility: Visibility::Internal,
                                data_type: Some(kind.to_string()),
                                properties: if !keywords.is_empty() {
                                    HashMap::from([("keywords".to_string(), serde_json::json!(keywords))])
                                } else { HashMap::new() },
                            });
                            nodes.push(AstNode {
                                id: format!("dspec-{}", i), kind: AstNodeKind::DataDeclaration,
                                name: Some(name), span, children: vec![],
                                properties: HashMap::from([("ds_type".to_string(), serde_json::json!(kind))]),
                            });
                        }
                    }
                }
                'I' => {
                    // I-spec: input specification
                    // Record identification (cols 6-16=file, 17-18=seq, 19=num, 20=option, 21-22=recid)
                    // or field description (cols 6-20=blank, 43-58=field name, etc.)
                    if line.len() >= 20 {
                        let file_or_blank = line[6..16].trim().to_string();
                        if !file_or_blank.is_empty() {
                            // Record identification entry
                            nodes.push(AstNode {
                                id: format!("ispec-rec-{}", i),
                                kind: AstNodeKind::Custom("I-Spec-Record".to_string()),
                                name: Some(file_or_blank), span, children: vec![],
                                properties: HashMap::new(),
                            });
                        } else if line.len() >= 58 {
                            // Field description entry
                            let field_name = line[42..58].trim().to_string();
                            if !field_name.is_empty() {
                                nodes.push(AstNode {
                                    id: format!("ispec-field-{}", i),
                                    kind: AstNodeKind::Custom("I-Spec-Field".to_string()),
                                    name: Some(field_name), span, children: vec![],
                                    properties: HashMap::new(),
                                });
                            }
                        }
                    }
                }
                'C' => {
                    // C-spec: calculation
                    if line.len() >= 28 {
                        // Indicators in columns 9-11 (conditioning), 71-76 (resulting)
                        let ind_cols = [
                            (7, 8), (8, 9), // Factor conditioning
                            (70, 71), (72, 73), (74, 75), // Resulting indicators
                        ];
                        for (s, e) in ind_cols {
                            if line.len() > e {
                                let ind = line[s..=e].trim().to_string();
                                if !ind.is_empty() && ind != "00" {
                                    let cat = Self::classify_indicator(&ind);
                                    if !indicators_used.iter().any(|(i, _)| i == &ind) {
                                        indicators_used.push((ind, cat.to_string()));
                                    }
                                }
                            }
                        }

                        let opcode_area = if line.len() >= 35 { line[25..35].trim().to_uppercase() } else { String::new() };
                        let opcode = opcode_area.split_whitespace().next().unwrap_or("").to_string();

                        match opcode.as_str() {
                            "CALL" | "CALLP" | "CALLB" => {
                                let target = if line.len() >= 49 { line[35..49].trim().trim_matches('\'').to_string() }
                                    else { String::new() };
                                // Flush any pending KLIST/PLIST
                                Self::flush_klist(&mut current_klist, &mut klist_fields, &mut nodes, &mut symbols, i);
                                Self::flush_plist(&mut current_plist, &mut plist_parms, &mut nodes, &mut symbols, i);
                                nodes.push(AstNode {
                                    id: format!("call-{}", i), kind: AstNodeKind::CallStatement,
                                    name: Some(target), span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "EXSR" => {
                                let target = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                nodes.push(AstNode {
                                    id: format!("exsr-{}", i), kind: AstNodeKind::PerformStatement,
                                    name: Some(target), span, children: vec![],
                                    properties: HashMap::from([("type".to_string(), serde_json::json!("EXSR"))]),
                                });
                            }
                            "BEGSR" => {
                                Self::flush_klist(&mut current_klist, &mut klist_fields, &mut nodes, &mut symbols, i);
                                Self::flush_plist(&mut current_plist, &mut plist_parms, &mut nodes, &mut symbols, i);
                                let name = if line.len() >= 20 { line[6..20].trim().to_string() }
                                    else { String::new() };
                                let is_cycle_sr = name == "*INZSR" || name == "*PSSR" || name == "*TERMSR";
                                symbols.push(Symbol {
                                    name: name.clone(), kind: SymbolKind::Subroutine,
                                    span: span.clone(), visibility: Visibility::Internal,
                                    data_type: None,
                                    properties: if is_cycle_sr {
                                        HashMap::from([("cycle_subroutine".to_string(), serde_json::json!(true))])
                                    } else { HashMap::new() },
                                });
                                nodes.push(AstNode {
                                    id: format!("begsr-{}", i), kind: AstNodeKind::Paragraph,
                                    name: Some(name), span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "ENDSR" => {
                                nodes.push(AstNode {
                                    id: format!("endsr-{}", i),
                                    kind: AstNodeKind::Custom("EndSubroutine".to_string()),
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "EVAL" | "EVALR" => {
                                let expr = if line.len() >= 49 { line[35..].trim().to_string() } else { String::new() };
                                nodes.push(AstNode {
                                    id: format!("eval-{}", i), kind: AstNodeKind::Assignment,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([
                                        ("opcode".to_string(), serde_json::json!(opcode)),
                                        ("expr".to_string(), serde_json::json!(expr)),
                                    ]),
                                });
                            }
                            "IF" | "IFXX" | "IFEQ" | "IFNE" | "IFGT" | "IFLT" | "IFGE" | "IFLE" => {
                                nodes.push(AstNode {
                                    id: format!("if-{}", i), kind: AstNodeKind::IfStatement,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "ELSE" => {
                                nodes.push(AstNode {
                                    id: format!("else-{}", i), kind: AstNodeKind::Custom("Else".to_string()),
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "SELECT" => {
                                nodes.push(AstNode {
                                    id: format!("select-{}", i), kind: AstNodeKind::EvaluateStatement,
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "WHEN" | "WHENEQ" | "WHENNE" | "WHENGT" | "WHENLT" | "WHENGE" | "WHENLE" => {
                                nodes.push(AstNode {
                                    id: format!("when-{}", i), kind: AstNodeKind::Condition,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "OTHER" => {
                                nodes.push(AstNode {
                                    id: format!("other-{}", i), kind: AstNodeKind::Custom("Other".to_string()),
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "DOW" | "DOWEQ" | "DOWNE" | "DOWGT" | "DOWLT" | "DOWGE" | "DOWLE" => {
                                nodes.push(AstNode {
                                    id: format!("dow-{}", i), kind: AstNodeKind::Loop,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([
                                        ("opcode".to_string(), serde_json::json!(opcode)),
                                        ("loop_type".to_string(), serde_json::json!("DOW")),
                                    ]),
                                });
                            }
                            "DOU" | "DOUEQ" | "DOUNE" | "DOUGT" | "DOULT" | "DOUGE" | "DOULE" => {
                                nodes.push(AstNode {
                                    id: format!("dou-{}", i), kind: AstNodeKind::Loop,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([
                                        ("opcode".to_string(), serde_json::json!(opcode)),
                                        ("loop_type".to_string(), serde_json::json!("DOU")),
                                    ]),
                                });
                            }
                            "DO" => {
                                nodes.push(AstNode {
                                    id: format!("do-{}", i), kind: AstNodeKind::Loop,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("loop_type".to_string(), serde_json::json!("DO"))]),
                                });
                            }
                            "FOR" => {
                                nodes.push(AstNode {
                                    id: format!("for-{}", i), kind: AstNodeKind::Loop,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("loop_type".to_string(), serde_json::json!("FOR"))]),
                                });
                            }
                            "MONITOR" => {
                                nodes.push(AstNode {
                                    id: format!("monitor-{}", i), kind: AstNodeKind::Custom("Monitor".to_string()),
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "ON-ERROR" => {
                                nodes.push(AstNode {
                                    id: format!("onerror-{}", i), kind: AstNodeKind::Custom("OnError".to_string()),
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "READ" | "READE" | "READP" | "READPE" | "READC" | "CHAIN" => {
                                let file = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                nodes.push(AstNode {
                                    id: format!("read-{}", i), kind: AstNodeKind::ReadStatement,
                                    name: Some(file), span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "WRITE" | "UPDATE" => {
                                let file = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                nodes.push(AstNode {
                                    id: format!("write-{}", i), kind: AstNodeKind::WriteStatement,
                                    name: Some(file), span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "DELETE" => {
                                let file = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                nodes.push(AstNode {
                                    id: format!("delete-{}", i),
                                    kind: AstNodeKind::Custom("DeleteStatement".to_string()),
                                    name: Some(file), span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!("DELETE"))]),
                                });
                            }
                            "SETLL" | "SETGT" => {
                                let file = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                nodes.push(AstNode {
                                    id: format!("setpos-{}", i),
                                    kind: AstNodeKind::Custom("SetPosition".to_string()),
                                    name: Some(file), span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "OPEN" | "CLOSE" => {
                                let file = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                nodes.push(AstNode {
                                    id: format!("fileop-{}", i),
                                    kind: AstNodeKind::Custom("FileOperation".to_string()),
                                    name: Some(file), span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "RETURN" => {
                                nodes.push(AstNode {
                                    id: format!("return-{}", i),
                                    kind: AstNodeKind::Custom("Return".to_string()),
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "LEAVE" | "LEAVESR" => {
                                nodes.push(AstNode {
                                    id: format!("leave-{}", i),
                                    kind: AstNodeKind::Custom("Leave".to_string()),
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "ITER" => {
                                nodes.push(AstNode {
                                    id: format!("iter-{}", i),
                                    kind: AstNodeKind::Custom("Iter".to_string()),
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "DSPLY" => {
                                nodes.push(AstNode {
                                    id: format!("dsply-{}", i), kind: AstNodeKind::DisplayStatement,
                                    name: None, span, children: vec![], properties: HashMap::new(),
                                });
                            }
                            "GOTO" | "TAG" => {
                                let target = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                if opcode == "GOTO" {
                                    nodes.push(AstNode {
                                        id: format!("goto-{}", i), kind: AstNodeKind::GoToStatement,
                                        name: Some(target), span, children: vec![], properties: HashMap::new(),
                                    });
                                    diagnostics.push(Diagnostic {
                                        severity: DiagnosticSeverity::Warning,
                                        message: "GOTO detected — spaghetti flow risk".to_string(),
                                        span: Span { start_line: i, start_col: 25, end_line: i, end_col: 35 },
                                        code: Some("RPG-GOTO".to_string()),
                                    });
                                } else {
                                    nodes.push(AstNode {
                                        id: format!("tag-{}", i),
                                        kind: AstNodeKind::Custom("Tag".to_string()),
                                        name: Some(target), span, children: vec![], properties: HashMap::new(),
                                    });
                                }
                            }
                            "MOVE" | "MOVEL" | "MOVEL(P)" => {
                                nodes.push(AstNode {
                                    id: format!("move-{}", i), kind: AstNodeKind::MoveStatement,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "Z-ADD" | "Z-SUB" | "ADD" | "SUB" | "MULT" | "DIV" | "MVR" | "SQRT" => {
                                nodes.push(AstNode {
                                    id: format!("arith-{}", i), kind: AstNodeKind::ComputeStatement,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "COMP" | "CABEQ" | "CABNE" | "CABGT" | "CABLT" | "CABGE" | "CABLE" => {
                                nodes.push(AstNode {
                                    id: format!("comp-{}", i), kind: AstNodeKind::Condition,
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "LOOKUP" => {
                                nodes.push(AstNode {
                                    id: format!("lookup-{}", i),
                                    kind: AstNodeKind::Custom("Lookup".to_string()),
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!("LOOKUP"))]),
                                });
                            }
                            "SCAN" | "XLATE" | "CHECK" | "CHECKR" | "CAT" | "SUBST" => {
                                nodes.push(AstNode {
                                    id: format!("strop-{}", i),
                                    kind: AstNodeKind::Custom("StringOp".to_string()),
                                    name: None, span, children: vec![],
                                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                                });
                            }
                            "KLIST" => {
                                // Flush previous KLIST if any
                                Self::flush_klist(&mut current_klist, &mut klist_fields, &mut nodes, &mut symbols, i);
                                let name = if line.len() >= 20 { line[6..20].trim().to_string() }
                                    else { String::new() };
                                current_klist = Some(name);
                                klist_fields.clear();
                            }
                            "KFLD" => {
                                let field = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                if !field.is_empty() {
                                    klist_fields.push(field);
                                }
                            }
                            "PLIST" => {
                                Self::flush_plist(&mut current_plist, &mut plist_parms, &mut nodes, &mut symbols, i);
                                let name = if line.len() >= 20 { line[6..20].trim().to_string() }
                                    else { String::new() };
                                current_plist = Some(name);
                                plist_parms.clear();
                            }
                            "PARM" => {
                                let parm = if line.len() >= 49 { line[35..49].trim().to_string() }
                                    else { String::new() };
                                if !parm.is_empty() {
                                    plist_parms.push(parm);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                'P' => {
                    // P-spec: procedure boundary
                    Self::flush_klist(&mut current_klist, &mut klist_fields, &mut nodes, &mut symbols, i);
                    Self::flush_plist(&mut current_plist, &mut plist_parms, &mut nodes, &mut symbols, i);
                    if line.len() >= 21 {
                        let name = line[6..21].trim().to_string();
                        let boundary = line.chars().nth(23).unwrap_or(' ');
                        let keywords = if line.len() > 43 { line[43..].trim().to_string() } else { String::new() };
                        let exported = keywords.to_uppercase().contains("EXPORT");
                        if boundary == 'B' && !name.is_empty() {
                            symbols.push(Symbol {
                                name: name.clone(), kind: SymbolKind::Procedure,
                                span: span.clone(),
                                visibility: if exported { Visibility::Public } else { Visibility::Private },
                                data_type: None, properties: HashMap::new(),
                            });
                        }
                        nodes.push(AstNode {
                            id: format!("pspec-{}", i), kind: AstNodeKind::Procedure,
                            name: Some(name), span, children: vec![],
                            properties: HashMap::from([
                                ("boundary".to_string(), serde_json::json!(
                                    if boundary == 'B' { "Begin" } else { "End" }
                                )),
                                ("exported".to_string(), serde_json::json!(exported)),
                            ]),
                        });
                    }
                }
                'O' => {
                    // O-spec: output specification
                    if line.len() >= 16 {
                        let file_or_blank = line[6..16].trim().to_string();
                        nodes.push(AstNode {
                            id: format!("ospec-{}", i), kind: AstNodeKind::Custom("O-Spec".to_string()),
                            name: if file_or_blank.is_empty() { None } else { Some(file_or_blank) },
                            span, children: vec![], properties: HashMap::new(),
                        });
                    }
                }
                _ => {
                    // /COPY or /INCLUDE directives (can appear outside spec lines)
                    let trimmed_lower = line.trim().to_lowercase();
                    if trimmed_lower.starts_with("/copy ") || trimmed_lower.starts_with("/include ") {
                        let target = trimmed_lower.split_whitespace().nth(1).unwrap_or("").to_string();
                        nodes.push(AstNode {
                            id: format!("copy-{}", i), kind: AstNodeKind::CopyStatement,
                            name: Some(target), span, children: vec![], properties: HashMap::new(),
                        });
                    }
                }
            }
        }

        // Flush any pending KLIST/PLIST
        let last_line = content.lines().count();
        Self::flush_klist(&mut current_klist, &mut klist_fields, &mut nodes, &mut symbols, last_line);
        Self::flush_plist(&mut current_plist, &mut plist_parms, &mut nodes, &mut symbols, last_line);

        if !indicators_used.is_empty() {
            let inds: Vec<&str> = indicators_used.iter().map(|(i, _)| i.as_str()).collect();
            let mut cat_counts: HashMap<String, usize> = HashMap::new();
            for (_, cat) in &indicators_used {
                *cat_counts.entry(cat.clone()).or_insert(0) += 1;
            }
            nodes.push(AstNode {
                id: "indicators-summary".to_string(),
                kind: AstNodeKind::Custom("IndicatorUsage".to_string()),
                name: None,
                span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                children: vec![],
                properties: HashMap::from([
                    ("indicators".to_string(), serde_json::json!(inds)),
                    ("count".to_string(), serde_json::json!(indicators_used.len())),
                    ("categories".to_string(), serde_json::json!(cat_counts)),
                ]),
            });
        }

        (nodes, symbols, embedded, diagnostics)
    }

    /// Flush a pending KLIST definition into nodes/symbols.
    fn flush_klist(
        current: &mut Option<String>, fields: &mut Vec<String>,
        nodes: &mut Vec<AstNode>, symbols: &mut Vec<Symbol>, line: usize,
    ) {
        if let Some(name) = current.take() {
            if !name.is_empty() {
                symbols.push(Symbol {
                    name: name.clone(),
                    kind: SymbolKind::Custom("KLIST".to_string()),
                    span: Span { start_line: line, start_col: 0, end_line: line, end_col: 0 },
                    visibility: Visibility::Internal,
                    data_type: None,
                    properties: HashMap::from([
                        ("fields".to_string(), serde_json::json!(fields.clone())),
                    ]),
                });
                nodes.push(AstNode {
                    id: format!("klist-{}", name),
                    kind: AstNodeKind::Custom("KLIST".to_string()),
                    name: Some(name), children: vec![],
                    span: Span { start_line: line, start_col: 0, end_line: line, end_col: 0 },
                    properties: HashMap::from([
                        ("fields".to_string(), serde_json::json!(fields.clone())),
                        ("field_count".to_string(), serde_json::json!(fields.len())),
                    ]),
                });
            }
            fields.clear();
        }
    }

    /// Flush a pending PLIST definition into nodes/symbols.
    fn flush_plist(
        current: &mut Option<String>, parms: &mut Vec<String>,
        nodes: &mut Vec<AstNode>, symbols: &mut Vec<Symbol>, line: usize,
    ) {
        if let Some(name) = current.take() {
            if !name.is_empty() {
                symbols.push(Symbol {
                    name: name.clone(),
                    kind: SymbolKind::Custom("PLIST".to_string()),
                    span: Span { start_line: line, start_col: 0, end_line: line, end_col: 0 },
                    visibility: Visibility::Internal,
                    data_type: None,
                    properties: HashMap::from([
                        ("parameters".to_string(), serde_json::json!(parms.clone())),
                    ]),
                });
                nodes.push(AstNode {
                    id: format!("plist-{}", name),
                    kind: AstNodeKind::Custom("PLIST".to_string()),
                    name: Some(name), children: vec![],
                    span: Span { start_line: line, start_col: 0, end_line: line, end_col: 0 },
                    properties: HashMap::from([
                        ("parameters".to_string(), serde_json::json!(parms.clone())),
                        ("parm_count".to_string(), serde_json::json!(parms.len())),
                    ]),
                });
            }
            parms.clear();
        }
    }

    /// Parse free-format RPG IV.
    fn parse_free_format(&self, content: &str) -> (Vec<AstNode>, Vec<Symbol>, Vec<EmbeddedBlock>, Vec<Diagnostic>) {
        let mut nodes = Vec::new();
        let mut symbols = Vec::new();
        let mut embedded = Vec::new();
        let mut diagnostics = Vec::new();
        let mut in_sql = false;
        let mut sql_content = String::new();
        let mut sql_start = 0;
        let mut indicators_used: Vec<(String, String)> = Vec::new();

        for (i, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("//") { continue; }
            // Skip **free directive line
            if trimmed.to_lowercase() == "**free" { continue; }

            let lower = trimmed.to_lowercase();
            let span = Span { start_line: i, start_col: 0, end_line: i, end_col: trimmed.len() };

            // Embedded SQL
            if lower.starts_with("exec sql") {
                in_sql = true;
                sql_content.clear();
                sql_start = i;
                let after = trimmed[8..].trim();
                if !after.is_empty() && !after.ends_with(';') {
                    sql_content.push_str(after);
                    sql_content.push(' ');
                }
                if after.ends_with(';') {
                    embedded.push(EmbeddedBlock {
                        language: "DB2-SQL".to_string(),
                        content: after.trim_end_matches(';').to_string(),
                        span: Span { start_line: sql_start, start_col: 0, end_line: i, end_col: trimmed.len() },
                        block_type: EmbeddedBlockType::ExecSql,
                    });
                    in_sql = false;
                }
                continue;
            }
            if in_sql {
                if trimmed.ends_with(';') {
                    sql_content.push_str(trimmed.trim_end_matches(';'));
                    embedded.push(EmbeddedBlock {
                        language: "DB2-SQL".to_string(),
                        content: sql_content.clone(),
                        span: Span { start_line: sql_start, start_col: 0, end_line: i, end_col: trimmed.len() },
                        block_type: EmbeddedBlockType::ExecSql,
                    });
                    in_sql = false;
                } else {
                    sql_content.push_str(trimmed);
                    sql_content.push(' ');
                }
                continue;
            }

            // Scan for indicator references (*INxx, *IN(xx))
            Self::scan_indicator_refs(trimmed, &mut indicators_used);

            // ctl-opt: Control options (replaces H-spec)
            if lower.starts_with("ctl-opt") {
                let opts = trimmed.get(7..).unwrap_or("").trim().trim_end_matches(';').trim();
                let mut props = HashMap::from([("raw".to_string(), serde_json::json!(opts))]);
                let opts_upper = opts.to_uppercase();
                if opts_upper.contains("DFTACTGRP") {
                    props.insert("dftactgrp".to_string(),
                        serde_json::json!(!opts_upper.contains("DFTACTGRP(*NO)")));
                }
                if opts_upper.contains("ACTGRP(") {
                    if let Some(val) = Self::extract_keyword_value(&opts_upper, "ACTGRP") {
                        props.insert("actgrp".to_string(), serde_json::json!(val));
                    }
                }
                if opts_upper.contains("BNDDIR(") {
                    if let Some(val) = Self::extract_keyword_value(&opts_upper, "BNDDIR") {
                        props.insert("bnddir".to_string(), serde_json::json!(val));
                    }
                }
                if opts_upper.contains("OPTION(") {
                    if let Some(val) = Self::extract_keyword_value(&opts_upper, "OPTION") {
                        props.insert("option".to_string(), serde_json::json!(val));
                    }
                }
                nodes.push(AstNode {
                    id: format!("ctlopt-{}", i), kind: AstNodeKind::Custom("CTL-OPT".to_string()),
                    name: None, span, children: vec![], properties: props,
                });
            }
            // dcl-f: File declaration
            else if lower.starts_with("dcl-f ") {
                let rest = trimmed[6..].trim();
                let name = rest.split(|c: char| c.is_whitespace() || c == ';')
                    .next().unwrap_or("").to_string();
                let rest_after_name = rest.get(name.len()..).unwrap_or("").trim();
                let mut props = HashMap::new();
                let rest_upper = rest_after_name.to_uppercase();
                if rest_upper.contains("USAGE(") {
                    if let Some(val) = Self::extract_keyword_value(&rest_upper, "USAGE") {
                        props.insert("usage".to_string(), serde_json::json!(val));
                    }
                }
                if rest_upper.contains("DISK") { props.insert("device".to_string(), serde_json::json!("DISK")); }
                if rest_upper.contains("PRINTER") { props.insert("device".to_string(), serde_json::json!("PRINTER")); }
                if rest_upper.contains("WORKSTN") { props.insert("device".to_string(), serde_json::json!("WORKSTN")); }
                if rest_upper.contains("USROPN") { props.insert("user_open".to_string(), serde_json::json!(true)); }
                if rest_upper.contains("SFILE(") { props.insert("has_subfile".to_string(), serde_json::json!(true)); }
                if rest_upper.contains("KEYED") { props.insert("keyed".to_string(), serde_json::json!(true)); }
                symbols.push(Symbol {
                    name: name.clone(), kind: SymbolKind::FileDescription,
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None, properties: props.clone(),
                });
                nodes.push(AstNode {
                    id: format!("dclf-{}", i), kind: AstNodeKind::FileDeclaration,
                    name: Some(name), span, children: vec![], properties: props,
                });
            }
            // dcl-s: Standalone variable
            else if lower.starts_with("dcl-s ") {
                let rest = &trimmed[6..];
                let name = rest.split(|c: char| c.is_whitespace() || c == ';').next().unwrap_or("");
                let rest_after = rest.get(name.len()..).unwrap_or("").trim();
                let data_type = rest_after.split(|c: char| c == ';' || c == '(')
                    .next().map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                symbols.push(Symbol {
                    name: name.to_string(), kind: SymbolKind::Variable,
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type, properties: HashMap::new(),
                });
                nodes.push(AstNode {
                    id: format!("dcls-{}", i), kind: AstNodeKind::DataDeclaration,
                    name: Some(name.to_string()), span, children: vec![],
                    properties: HashMap::from([("ds_type".to_string(), serde_json::json!("Standalone"))]),
                });
            }
            // dcl-ds: Data structure
            else if lower.starts_with("dcl-ds ") {
                let rest = &trimmed[7..];
                let name = rest.split(|c: char| c.is_whitespace() || c == ';')
                    .next().unwrap_or("").to_string();
                let rest_upper = rest.to_uppercase();
                let qualified = rest_upper.contains("QUALIFIED");
                let likeds = Self::extract_keyword_value(&rest_upper, "LIKEDS");
                let extname = Self::extract_keyword_value(&rest_upper, "EXTNAME");
                let mut props = HashMap::new();
                if qualified { props.insert("qualified".to_string(), serde_json::json!(true)); }
                if let Some(ref lds) = likeds { props.insert("likeds".to_string(), serde_json::json!(lds)); }
                if let Some(ref ext) = extname { props.insert("extname".to_string(), serde_json::json!(ext)); }
                symbols.push(Symbol {
                    name: name.clone(), kind: SymbolKind::Custom("DataStructure".to_string()),
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: props.clone(),
                });
                nodes.push(AstNode {
                    id: format!("dclds-{}", i), kind: AstNodeKind::DataGroup,
                    name: Some(name), span, children: vec![], properties: props,
                });
            }
            // dcl-c: Constant
            else if lower.starts_with("dcl-c ") {
                let rest = &trimmed[6..];
                let name = rest.split(|c: char| c.is_whitespace() || c == ';')
                    .next().unwrap_or("").to_string();
                let value = rest.get(name.len()..).unwrap_or("").trim().trim_end_matches(';').trim().to_string();
                symbols.push(Symbol {
                    name: name.clone(), kind: SymbolKind::Constant,
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None, properties: HashMap::new(),
                });
                nodes.push(AstNode {
                    id: format!("dclc-{}", i), kind: AstNodeKind::DataDeclaration,
                    name: Some(name), span, children: vec![],
                    properties: HashMap::from([
                        ("ds_type".to_string(), serde_json::json!("Constant")),
                        ("value".to_string(), serde_json::json!(value)),
                    ]),
                });
            }
            // dcl-pr: Procedure prototype
            else if lower.starts_with("dcl-pr ") {
                let rest = &trimmed[7..];
                let name = rest.split(|c: char| c.is_whitespace() || c == ';')
                    .next().unwrap_or("").to_string();
                let rest_upper = rest.to_uppercase();
                let extpgm = Self::extract_keyword_value(&rest_upper, "EXTPGM");
                let extproc = Self::extract_keyword_value(&rest_upper, "EXTPROC");
                let mut props = HashMap::new();
                if let Some(ref pgm) = extpgm {
                    props.insert("extpgm".to_string(), serde_json::json!(pgm));
                }
                if let Some(ref proc) = extproc {
                    props.insert("extproc".to_string(), serde_json::json!(proc));
                }
                props.insert("external".to_string(), serde_json::json!(extpgm.is_some() || extproc.is_some()));
                symbols.push(Symbol {
                    name: name.clone(),
                    kind: SymbolKind::Custom("Prototype".to_string()),
                    span: span.clone(), visibility: Visibility::Public,
                    data_type: None,
                    properties: props.clone(),
                });
                nodes.push(AstNode {
                    id: format!("dclpr-{}", i),
                    kind: AstNodeKind::Custom("Prototype".to_string()),
                    name: Some(name), span, children: vec![], properties: props,
                });
            }
            // dcl-proc: Procedure
            else if lower.starts_with("dcl-proc ") {
                let rest = &trimmed[9..];
                let name = rest.split(|c: char| c.is_whitespace() || c == ';')
                    .next().unwrap_or("").to_string();
                let exported = rest.to_uppercase().contains("EXPORT");
                symbols.push(Symbol {
                    name: name.clone(), kind: SymbolKind::Procedure,
                    span: span.clone(),
                    visibility: if exported { Visibility::Public } else { Visibility::Private },
                    data_type: None, properties: HashMap::new(),
                });
                nodes.push(AstNode {
                    id: format!("dclproc-{}", i), kind: AstNodeKind::Procedure,
                    name: Some(name), span, children: vec![],
                    properties: HashMap::from([("exported".to_string(), serde_json::json!(exported))]),
                });
            }
            // end-proc: Procedure end
            else if lower.starts_with("end-proc") {
                nodes.push(AstNode {
                    id: format!("endproc-{}", i),
                    kind: AstNodeKind::Custom("EndProcedure".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            // dcl-pi: Procedure interface
            else if lower.starts_with("dcl-pi ") {
                let rest = &trimmed[7..];
                let name = rest.split(|c: char| c.is_whitespace() || c == ';')
                    .next().unwrap_or("").to_string();
                nodes.push(AstNode {
                    id: format!("dclpi-{}", i), kind: AstNodeKind::Custom("ProcInterface".to_string()),
                    name: Some(name), span, children: vec![], properties: HashMap::new(),
                });
            }
            // begsr: Subroutine
            else if lower.starts_with("begsr ") || lower.starts_with("begsr;") {
                let name = if lower.starts_with("begsr;") {
                    String::new()
                } else {
                    lower[6..].trim_end_matches(';').trim().to_string()
                };
                let is_cycle_sr = name == "*inzsr" || name == "*pssr" || name == "*termsr";
                symbols.push(Symbol {
                    name: name.clone(), kind: SymbolKind::Subroutine,
                    span: span.clone(), visibility: Visibility::Internal,
                    data_type: None,
                    properties: if is_cycle_sr {
                        HashMap::from([("cycle_subroutine".to_string(), serde_json::json!(true))])
                    } else { HashMap::new() },
                });
                nodes.push(AstNode {
                    id: format!("begsr-{}", i), kind: AstNodeKind::Paragraph,
                    name: Some(name), span, children: vec![], properties: HashMap::new(),
                });
            }
            // endsr
            else if lower.starts_with("endsr") {
                nodes.push(AstNode {
                    id: format!("endsr-{}", i),
                    kind: AstNodeKind::Custom("EndSubroutine".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            // exsr: Call subroutine
            else if lower.starts_with("exsr ") {
                let target = lower[5..].trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("exsr-{}", i), kind: AstNodeKind::PerformStatement,
                    name: Some(target), span, children: vec![],
                    properties: HashMap::from([("type".to_string(), serde_json::json!("EXSR"))]),
                });
            }
            // callp: Procedure call
            else if lower.starts_with("callp ") || lower.starts_with("callp(") {
                let target = lower.replace("callp", "").trim_start_matches(|c: char| c == '(' || c == ' ')
                    .split('(').next().unwrap_or("").trim().to_string();
                nodes.push(AstNode {
                    id: format!("callp-{}", i), kind: AstNodeKind::CallStatement,
                    name: Some(target), span, children: vec![],
                    properties: HashMap::from([("opcode".to_string(), serde_json::json!("CALLP"))]),
                });
            }
            // return
            else if lower.starts_with("return") && (lower.len() == 6 || lower.as_bytes().get(6).map(|b| *b == b';' || *b == b' ').unwrap_or(false)) {
                nodes.push(AstNode {
                    id: format!("return-{}", i),
                    kind: AstNodeKind::Custom("Return".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            // if / elseif
            else if lower.starts_with("if ") || lower.starts_with("if;") {
                let condition = trimmed.get(2..).unwrap_or("").trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("if-{}", i), kind: AstNodeKind::IfStatement,
                    name: None, span, children: vec![],
                    properties: HashMap::from([("condition".to_string(), serde_json::json!(condition))]),
                });
            }
            else if lower.starts_with("elseif ") {
                let condition = trimmed.get(7..).unwrap_or("").trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("elseif-{}", i), kind: AstNodeKind::Custom("ElseIf".to_string()),
                    name: None, span, children: vec![],
                    properties: HashMap::from([("condition".to_string(), serde_json::json!(condition))]),
                });
            }
            else if lower.starts_with("else;") || lower == "else" {
                nodes.push(AstNode {
                    id: format!("else-{}", i), kind: AstNodeKind::Custom("Else".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            // select / when / other
            else if lower.starts_with("select;") || lower == "select" {
                nodes.push(AstNode {
                    id: format!("select-{}", i), kind: AstNodeKind::EvaluateStatement,
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            else if lower.starts_with("when ") {
                let condition = trimmed.get(5..).unwrap_or("").trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("when-{}", i), kind: AstNodeKind::Condition,
                    name: None, span, children: vec![],
                    properties: HashMap::from([("condition".to_string(), serde_json::json!(condition))]),
                });
            }
            else if lower.starts_with("other;") || lower == "other" {
                nodes.push(AstNode {
                    id: format!("other-{}", i), kind: AstNodeKind::Custom("Other".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            // dow / dou / for loops
            else if lower.starts_with("dow ") {
                let condition = trimmed.get(4..).unwrap_or("").trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("dow-{}", i), kind: AstNodeKind::Loop,
                    name: None, span, children: vec![],
                    properties: HashMap::from([
                        ("loop_type".to_string(), serde_json::json!("DOW")),
                        ("condition".to_string(), serde_json::json!(condition)),
                    ]),
                });
            }
            else if lower.starts_with("dou ") {
                let condition = trimmed.get(4..).unwrap_or("").trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("dou-{}", i), kind: AstNodeKind::Loop,
                    name: None, span, children: vec![],
                    properties: HashMap::from([
                        ("loop_type".to_string(), serde_json::json!("DOU")),
                        ("condition".to_string(), serde_json::json!(condition)),
                    ]),
                });
            }
            else if lower.starts_with("for ") {
                let expr = trimmed.get(4..).unwrap_or("").trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("for-{}", i), kind: AstNodeKind::Loop,
                    name: None, span, children: vec![],
                    properties: HashMap::from([
                        ("loop_type".to_string(), serde_json::json!("FOR")),
                        ("expr".to_string(), serde_json::json!(expr)),
                    ]),
                });
            }
            // monitor / on-error
            else if lower.starts_with("monitor;") || lower == "monitor" {
                nodes.push(AstNode {
                    id: format!("monitor-{}", i), kind: AstNodeKind::Custom("Monitor".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            else if lower.starts_with("on-error") {
                let codes = trimmed.get(8..).unwrap_or("").trim_end_matches(';').trim().to_string();
                nodes.push(AstNode {
                    id: format!("onerror-{}", i), kind: AstNodeKind::Custom("OnError".to_string()),
                    name: None, span, children: vec![],
                    properties: if codes.is_empty() { HashMap::new() }
                        else { HashMap::from([("codes".to_string(), serde_json::json!(codes))]) },
                });
            }
            // leave / iter
            else if lower.starts_with("leave;") || lower == "leave" {
                nodes.push(AstNode {
                    id: format!("leave-{}", i), kind: AstNodeKind::Custom("Leave".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            else if lower.starts_with("iter;") || lower == "iter" {
                nodes.push(AstNode {
                    id: format!("iter-{}", i), kind: AstNodeKind::Custom("Iter".to_string()),
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            // dsply
            else if lower.starts_with("dsply") {
                nodes.push(AstNode {
                    id: format!("dsply-{}", i), kind: AstNodeKind::DisplayStatement,
                    name: None, span, children: vec![], properties: HashMap::new(),
                });
            }
            // I/O operations
            else if lower.starts_with("read ") || lower.starts_with("reade ") || lower.starts_with("reade(")
                || lower.starts_with("readp ") || lower.starts_with("readpe ")
                || lower.starts_with("readc ") || lower.starts_with("chain ") || lower.starts_with("chain(") {
                let opcode = lower.split(|c: char| c.is_whitespace() || c == '(')
                    .next().unwrap_or("read").to_string();
                let target = lower.split(|c: char| c.is_whitespace() || c == '(')
                    .filter(|s| !s.is_empty() && *s != &opcode && !s.starts_with("e)") && !s.starts_with("n)"))
                    .next()
                    .unwrap_or("").trim_end_matches(';').to_string();
                nodes.push(AstNode {
                    id: format!("read-{}", i), kind: AstNodeKind::ReadStatement,
                    name: Some(target), span, children: vec![],
                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                });
            }
            else if lower.starts_with("write ") || lower.starts_with("update ") {
                let opcode = lower.split_whitespace().next().unwrap_or("write").to_string();
                let target = lower.split_whitespace().nth(1)
                    .unwrap_or("").trim_end_matches(';').to_string();
                nodes.push(AstNode {
                    id: format!("write-{}", i), kind: AstNodeKind::WriteStatement,
                    name: Some(target), span, children: vec![],
                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                });
            }
            else if lower.starts_with("delete ") || lower.starts_with("delete(") {
                let target = lower.split(|c: char| c.is_whitespace() || c == '(')
                    .filter(|s| !s.is_empty() && !s.starts_with("delete"))
                    .next()
                    .unwrap_or("").trim_end_matches(';').trim_end_matches(')').to_string();
                nodes.push(AstNode {
                    id: format!("delete-{}", i),
                    kind: AstNodeKind::Custom("DeleteStatement".to_string()),
                    name: Some(target), span, children: vec![],
                    properties: HashMap::from([("opcode".to_string(), serde_json::json!("delete"))]),
                });
            }
            else if lower.starts_with("setll ") || lower.starts_with("setll(")
                || lower.starts_with("setgt ") || lower.starts_with("setgt(") {
                let opcode = lower.split(|c: char| c.is_whitespace() || c == '(')
                    .next().unwrap_or("setll").to_string();
                let target = lower.split(|c: char| c.is_whitespace())
                    .filter(|s| !s.is_empty() && !s.starts_with(&opcode))
                    .next()
                    .unwrap_or("").trim_end_matches(';').to_string();
                nodes.push(AstNode {
                    id: format!("setpos-{}", i),
                    kind: AstNodeKind::Custom("SetPosition".to_string()),
                    name: Some(target), span, children: vec![],
                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                });
            }
            else if lower.starts_with("open ") || lower.starts_with("close ") {
                let opcode = lower.split_whitespace().next().unwrap_or("open").to_string();
                let target = lower.split_whitespace().nth(1)
                    .unwrap_or("").trim_end_matches(';').to_string();
                nodes.push(AstNode {
                    id: format!("fileop-{}", i),
                    kind: AstNodeKind::Custom("FileOperation".to_string()),
                    name: Some(target), span, children: vec![],
                    properties: HashMap::from([("opcode".to_string(), serde_json::json!(opcode))]),
                });
            }
            // /copy and /include
            else if lower.starts_with("/copy ") || lower.starts_with("/include ") {
                let target = lower.split_whitespace().nth(1).unwrap_or("").to_string();
                nodes.push(AstNode {
                    id: format!("copy-{}", i), kind: AstNodeKind::CopyStatement,
                    name: Some(target), span, children: vec![], properties: HashMap::new(),
                });
            }
            // end-* keywords (tracking structure)
            else if lower.starts_with("endif") || lower.starts_with("endsl")
                || lower.starts_with("enddo") || lower.starts_with("endfor")
                || lower.starts_with("endmon") {
                // Structural end - tracked implicitly
            }
            // Bare procedure call: name(args);
            else if !lower.starts_with("end-") && !lower.starts_with("dcl-")
                && !lower.starts_with("on-") && trimmed.contains('(') && trimmed.ends_with(';') {
                let name = trimmed.split('(').next().unwrap_or("").trim();
                // Heuristic: if it looks like an assignment (has = before parens), skip
                if !name.is_empty() && !name.contains('=') && !name.contains(' ')
                    && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '%') {
                    // Skip built-in functions (%xxx)
                    if !name.starts_with('%') {
                        nodes.push(AstNode {
                            id: format!("callp-{}", i), kind: AstNodeKind::CallStatement,
                            name: Some(name.to_lowercase()), span, children: vec![],
                            properties: HashMap::from([("opcode".to_string(), serde_json::json!("implicit-callp"))]),
                        });
                    }
                }
            }
        }

        // Indicator summary for free-format
        if !indicators_used.is_empty() {
            let inds: Vec<&str> = indicators_used.iter().map(|(i, _)| i.as_str()).collect();
            let mut cat_counts: HashMap<String, usize> = HashMap::new();
            for (_, cat) in &indicators_used {
                *cat_counts.entry(cat.clone()).or_insert(0) += 1;
            }
            nodes.push(AstNode {
                id: "indicators-summary".to_string(),
                kind: AstNodeKind::Custom("IndicatorUsage".to_string()),
                name: None,
                span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                children: vec![],
                properties: HashMap::from([
                    ("indicators".to_string(), serde_json::json!(inds)),
                    ("count".to_string(), serde_json::json!(indicators_used.len())),
                    ("categories".to_string(), serde_json::json!(cat_counts)),
                ]),
            });
        }

        (nodes, symbols, embedded, diagnostics)
    }

    /// Scan a line for *INxx indicator references and collect them.
    fn scan_indicator_refs(line: &str, indicators: &mut Vec<(String, String)>) {
        let upper = line.to_uppercase();
        // Match *INxx and *IN(xx) patterns
        let mut pos = 0;
        while let Some(idx) = upper[pos..].find("*IN") {
            let start = pos + idx + 3;
            if start >= upper.len() { break; }
            let rest = &upper[start..];
            let ind = if rest.starts_with('(') {
                // *IN(xx) form
                if let Some(end) = rest.find(')') {
                    rest[1..end].trim().to_string()
                } else { pos = start; continue; }
            } else {
                // *INxx form
                rest.chars().take_while(|c| c.is_alphanumeric()).collect::<String>()
            };
            if !ind.is_empty() {
                let cat = Self::classify_indicator(&ind).to_string();
                if !indicators.iter().any(|(i, _)| *i == ind) {
                    indicators.push((ind, cat));
                }
            }
            pos = start + 1;
        }
    }

    /// Extract keyword value from a keyword(value) pattern.
    fn extract_keyword_value(text: &str, keyword: &str) -> Option<String> {
        let pattern = format!("{}(", keyword);
        if let Some(start) = text.find(&pattern) {
            let rest = &text[start + pattern.len()..];
            // Handle nested parens
            let mut depth = 1;
            let mut end = 0;
            for (i, c) in rest.chars().enumerate() {
                match c {
                    '(' => depth += 1,
                    ')' => { depth -= 1; if depth == 0 { end = i; break; } }
                    _ => {}
                }
            }
            if end > 0 {
                return Some(rest[..end].to_string());
            }
        }
        None
    }

    /// Extract SQL tables from embedded blocks.
    fn extract_sql_tables(blocks: &[EmbeddedBlock]) -> Vec<String> {
        let mut tables = Vec::new();
        for block in blocks {
            let upper = block.content.to_uppercase();
            for kw in &["FROM ", "INTO ", "UPDATE ", "JOIN "] {
                for part in upper.split(kw).skip(1) {
                    let t = part.split_whitespace().next().unwrap_or("")
                        .trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if t.len() > 1 && !tables.contains(&t.to_string()) {
                        tables.push(t.to_string());
                    }
                }
            }
        }
        tables
    }
}

impl LanguageParser for RpgParser {
    fn language_id(&self) -> &'static str { "rpg" }
    fn display_name(&self) -> &'static str { "RPG II/III/IV/Free" }

    fn supported_dialects(&self) -> &[&'static str] {
        &["RPG-II", "RPG-III", "RPG-IV-Fixed", "RPG-IV-Free", "SQLRPGLE"]
    }

    fn file_extensions(&self) -> &[&'static str] {
        &["rpg", "rpgle", "sqlrpgle", "rpg38", "rpg36"]
    }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let content_match = file.header.contains("dcl-s")
            || file.header.contains("dcl-proc")
            || file.header.contains("begsr")
            || file.header.contains("/free")
            || file.header.contains("**free")
            || file.header.contains("ctl-opt")
            || file.header.contains("FQSYSPRT");
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let format = Self::detect_format(&source.content);

        let (ast_nodes, symbols, embedded_blocks, diagnostics) = if format == "fixed" {
            self.parse_fixed_format(&source.content)
        } else {
            self.parse_free_format(&source.content)
        };

        let has_sql = !embedded_blocks.is_empty()
            || source.extension == "sqlrpgle";

        let dialect = if has_sql { "SQLRPGLE" }
            else if format == "free" { "RPG-IV-Free" }
            else { "RPG-IV-Fixed" };

        let sql_tables = Self::extract_sql_tables(&embedded_blocks);

        let mut metadata = HashMap::new();
        metadata.insert("format".to_string(), serde_json::json!(format));
        metadata.insert("has_embedded_sql".to_string(), serde_json::json!(has_sql));
        metadata.insert("sql_tables".to_string(), serde_json::json!(sql_tables));
        metadata.insert("procedure_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Procedure)).count()
        ));
        metadata.insert("subroutine_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Subroutine)).count()
        ));
        metadata.insert("file_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::FileDescription)).count()
        ));
        metadata.insert("variable_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Variable)).count()
        ));
        metadata.insert("constant_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| matches!(s.kind, SymbolKind::Constant)).count()
        ));
        metadata.insert("data_structure_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("DataStructure".to_string())).count()
        ));
        metadata.insert("prototype_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("Prototype".to_string())).count()
        ));
        metadata.insert("klist_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("KLIST".to_string())).count()
        ));
        metadata.insert("plist_count".to_string(), serde_json::json!(
            symbols.iter().filter(|s| s.kind == SymbolKind::Custom("PLIST".to_string())).count()
        ));
        metadata.insert("copy_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::CopyStatement)).count()
        ));
        metadata.insert("call_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::CallStatement)).count()
        ));
        metadata.insert("loop_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::Loop)).count()
        ));
        metadata.insert("if_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::IfStatement)).count()
        ));
        metadata.insert("goto_count".to_string(), serde_json::json!(
            ast_nodes.iter().filter(|n| matches!(n.kind, AstNodeKind::GoToStatement)).count()
        ));
        metadata.insert("embedded_sql_count".to_string(), serde_json::json!(embedded_blocks.len()));

        // Indicator usage
        if let Some(ind_node) = ast_nodes.iter().find(|n| n.kind == AstNodeKind::Custom("IndicatorUsage".to_string())) {
            metadata.insert("indicators_used".to_string(),
                ind_node.properties.get("indicators").cloned().unwrap_or(serde_json::json!([])));
            metadata.insert("indicator_count".to_string(),
                ind_node.properties.get("count").cloned().unwrap_or(serde_json::json!(0)));
            if let Some(cats) = ind_node.properties.get("categories") {
                metadata.insert("indicator_categories".to_string(), cats.clone());
            }
        }

        // H-spec / CTL-OPT info
        let has_ctlopt = ast_nodes.iter().any(|n|
            n.kind == AstNodeKind::Custom("CTL-OPT".to_string())
            || n.kind == AstNodeKind::Custom("H-Spec".to_string()));
        metadata.insert("has_control_spec".to_string(), serde_json::json!(has_ctlopt));

        // Cycle subroutines
        let cycle_srs: Vec<&str> = symbols.iter()
            .filter(|s| matches!(s.kind, SymbolKind::Subroutine)
                && s.properties.get("cycle_subroutine").and_then(|v| v.as_bool()).unwrap_or(false))
            .map(|s| s.name.as_str())
            .collect();
        if !cycle_srs.is_empty() {
            metadata.insert("cycle_subroutines".to_string(), serde_json::json!(cycle_srs));
        }

        Ok(ParseOutput {
            language_id: self.language_id().to_string(),
            dialect: dialect.to_string(),
            source_path: source.path.to_string_lossy().to_string(),
            total_lines: source.content.lines().count(),
            ast_nodes, symbols, embedded_blocks,
            diagnostics, metadata,
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
                            reference_text: format!("/COPY {}", name),
                        });
                    }
                }
                AstNodeKind::CallStatement => {
                    if let Some(name) = &node.name {
                        if !name.is_empty() {
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: name.clone(),
                                dependency_type: DependencyType::ProgramCall,
                                source_span: node.span.clone(),
                                reference_text: format!("CALLP {}", name),
                            });
                        }
                    }
                }
                AstNodeKind::FileDeclaration => {
                    if let Some(name) = &node.name {
                        if !name.is_empty() {
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: name.clone(),
                                dependency_type: DependencyType::FileAccess,
                                source_span: node.span.clone(),
                                reference_text: format!("DCL-F {}", name),
                            });
                        }
                    }
                }
                _ => {}
            }

            // Prototypes with EXTPGM → external program dependency
            if node.kind == AstNodeKind::Custom("Prototype".to_string()) {
                if let Some(extpgm) = node.properties.get("extpgm").and_then(|v| v.as_str()) {
                    let pgm = extpgm.trim_matches('\'');
                    if !pgm.is_empty() {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: pgm.to_string(),
                            dependency_type: DependencyType::ProgramCall,
                            source_span: node.span.clone(),
                            reference_text: format!("EXTPGM('{}')", pgm),
                        });
                    }
                }
            }
        }

        // Embedded SQL → database dependencies
        for block in &module.embedded_blocks {
            deps.push(DependencyRef {
                from_module: module.source_path.clone(),
                to_module: "DB2-SQL".to_string(),
                dependency_type: DependencyType::DatabaseAccess,
                source_span: block.span.clone(),
                reference_text: format!("EXEC SQL ({} chars)", block.content.len()),
            });
        }

        // Individual SQL table references
        let sql_tables = Self::extract_sql_tables(&module.embedded_blocks);
        for table in &sql_tables {
            deps.push(DependencyRef {
                from_module: module.source_path.clone(),
                to_module: table.clone(),
                dependency_type: DependencyType::DatabaseAccess,
                source_span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                reference_text: format!("SQL table: {}", table),
            });
        }

        deps
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut business_rules = Vec::new();
        let mut data_flows = Vec::new();
        let mut rule_id = 0;

        // Entry points: procedures and subroutines
        for sym in &output.symbols {
            match &sym.kind {
                SymbolKind::Procedure => {
                    nodes.push(AnalysisNode {
                        id: format!("rpg-proc-{}", sym.name),
                        kind: AnalysisNodeKind::EntryPoint,
                        name: sym.name.clone(),
                        source_span: sym.span.clone(),
                        properties: HashMap::new(),
                    });
                }
                SymbolKind::Subroutine => {
                    nodes.push(AnalysisNode {
                        id: format!("rpg-sr-{}", sym.name),
                        kind: AnalysisNodeKind::EntryPoint,
                        name: sym.name.clone(),
                        source_span: sym.span.clone(),
                        properties: HashMap::new(),
                    });
                }
                _ => {}
            }
        }

        // External call nodes
        for ast_node in &output.ast_nodes {
            if let AstNodeKind::CallStatement = &ast_node.kind {
                if let Some(name) = &ast_node.name {
                    let call_id = format!("rpg-call-{}-{}", name, ast_node.span.start_line);
                    nodes.push(AnalysisNode {
                        id: call_id.clone(),
                        kind: AnalysisNodeKind::ExternalCall,
                        name: format!("CALL {}", name),
                        source_span: ast_node.span.clone(),
                        properties: HashMap::new(),
                    });
                    // Edge from enclosing procedure/subroutine to call target
                    edges.push(AnalysisEdge {
                        from: output.source_path.clone(),
                        to: call_id,
                        kind: AnalysisEdgeKind::CallsInto,
                        label: Some(format!("calls {}", name)),
                    });
                }
            }
        }

        // Database operation nodes from file I/O
        for ast_node in &output.ast_nodes {
            match &ast_node.kind {
                AstNodeKind::ReadStatement => {
                    if let Some(file) = &ast_node.name {
                        if !file.is_empty() {
                            let node_id = format!("rpg-read-{}-{}", file, ast_node.span.start_line);
                            nodes.push(AnalysisNode {
                                id: node_id.clone(),
                                kind: AnalysisNodeKind::DatabaseOperation,
                                name: format!("READ {}", file),
                                source_span: ast_node.span.clone(),
                                properties: HashMap::from([
                                    ("operation".to_string(), serde_json::json!("read")),
                                    ("file".to_string(), serde_json::json!(file)),
                                ]),
                            });
                            edges.push(AnalysisEdge {
                                from: output.source_path.clone(),
                                to: node_id,
                                kind: AnalysisEdgeKind::ReadsFrom,
                                label: Some(format!("reads {}", file)),
                            });
                        }
                    }
                }
                AstNodeKind::WriteStatement => {
                    if let Some(file) = &ast_node.name {
                        if !file.is_empty() {
                            let node_id = format!("rpg-write-{}-{}", file, ast_node.span.start_line);
                            nodes.push(AnalysisNode {
                                id: node_id.clone(),
                                kind: AnalysisNodeKind::DatabaseOperation,
                                name: format!("WRITE {}", file),
                                source_span: ast_node.span.clone(),
                                properties: HashMap::from([
                                    ("operation".to_string(), serde_json::json!("write")),
                                    ("file".to_string(), serde_json::json!(file)),
                                ]),
                            });
                            edges.push(AnalysisEdge {
                                from: output.source_path.clone(),
                                to: node_id,
                                kind: AnalysisEdgeKind::WritesTo,
                                label: Some(format!("writes {}", file)),
                            });
                        }
                    }
                }
                _ => {}
            }

            // Delete operations
            if ast_node.kind == AstNodeKind::Custom("DeleteStatement".to_string()) {
                if let Some(file) = &ast_node.name {
                    if !file.is_empty() {
                        let node_id = format!("rpg-delete-{}-{}", file, ast_node.span.start_line);
                        nodes.push(AnalysisNode {
                            id: node_id.clone(),
                            kind: AnalysisNodeKind::DatabaseOperation,
                            name: format!("DELETE {}", file),
                            source_span: ast_node.span.clone(),
                            properties: HashMap::from([
                                ("operation".to_string(), serde_json::json!("delete")),
                                ("file".to_string(), serde_json::json!(file)),
                            ]),
                        });
                        edges.push(AnalysisEdge {
                            from: output.source_path.clone(),
                            to: node_id,
                            kind: AnalysisEdgeKind::WritesTo,
                            label: Some(format!("deletes from {}", file)),
                        });
                    }
                }
            }
        }

        // Database operations from embedded SQL
        for block in &output.embedded_blocks {
            let node_id = format!("rpg-sql-{}", block.span.start_line);
            nodes.push(AnalysisNode {
                id: node_id.clone(),
                kind: AnalysisNodeKind::DatabaseOperation,
                name: format!("SQL (line {})", block.span.start_line),
                source_span: block.span.clone(),
                properties: HashMap::from([
                    ("sql".to_string(), serde_json::json!(block.content)),
                ]),
            });
            edges.push(AnalysisEdge {
                from: output.source_path.clone(),
                to: node_id,
                kind: AnalysisEdgeKind::Dependency,
                label: Some("embedded SQL".to_string()),
            });
        }

        // Business rules from IF conditions and loops
        for ast_node in &output.ast_nodes {
            if let AstNodeKind::IfStatement = &ast_node.kind {
                if let Some(cond) = ast_node.properties.get("condition").and_then(|v| v.as_str()) {
                    if !cond.is_empty() {
                        rule_id += 1;
                        let rule_type = if cond.contains(">=") || cond.contains("<=")
                            || cond.contains("> ") || cond.contains("< ") {
                            BusinessRuleType::Validation
                        } else if cond.contains("status") || cond.contains("error")
                            || cond.contains("*inlr") || cond.contains("found") {
                            BusinessRuleType::Workflow
                        } else {
                            BusinessRuleType::Constraint
                        };
                        business_rules.push(BusinessRule {
                            id: format!("rpg-rule-{}", rule_id),
                            description: format!("Condition: {}", cond),
                            rule_type,
                            source_span: ast_node.span.clone(),
                            confidence: 0.6,
                        });
                    }
                }
            }
        }

        // Data flows from read→write patterns on same file
        let reads: Vec<&str> = output.ast_nodes.iter()
            .filter(|n| matches!(n.kind, AstNodeKind::ReadStatement))
            .filter_map(|n| n.name.as_deref())
            .collect();
        let writes: Vec<&str> = output.ast_nodes.iter()
            .filter(|n| matches!(n.kind, AstNodeKind::WriteStatement))
            .filter_map(|n| n.name.as_deref())
            .collect();
        let mut flow_id = 0;
        for r in &reads {
            for w in &writes {
                if !r.is_empty() && !w.is_empty() {
                    flow_id += 1;
                    data_flows.push(DataFlow {
                        id: format!("rpg-flow-{}", flow_id),
                        description: format!("Data flows from {} to {}", r, w),
                        source_node: format!("rpg-read-{}", r),
                        sink_node: format!("rpg-write-{}", w),
                        transformations: vec![],
                    });
                }
            }
        }

        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes, edges, business_rules, data_flows,
        })
    }
}
