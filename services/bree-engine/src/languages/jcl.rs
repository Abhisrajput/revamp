//! JCL (z/OS Job Control Language) parser — deep extraction of all JCL constructs.
//!
//! Handles JES2/JES3 JCL with thorough structural parsing:
//!   - JOB card with CLASS, MSGCLASS, MSGLEVEL, NOTIFY, REGION parameters
//!   - EXEC statements with PGM=/PROC=, PARM=, COND=, TIME=, REGION=
//!   - DD statements: DSN=, DISP=, SPACE=, DCB=, SYSOUT=, DUMMY, DD *, concatenation
//!   - GDG detection: DSN(+1), DSN(0), DSN(-1) patterns
//!   - PROC/PEND procedure boundaries
//!   - SET symbolic parameter assignments
//!   - IF/THEN/ELSE/ENDIF conditional execution
//!   - INCLUDE MEMBER= and JCLLIB ORDER=
//!   - Utility detection: IEBCOPY, IDCAMS, DFSORT, SYNCSORT, ICETOOL, IEBGENER, IEFBR14
//!   - JOBLIB/STEPLIB DD library references
//!   - OUTPUT JCL (SYSOUT handling)
//!   - Comment counting (//* lines)
//!   - Continuation line handling (non-blank in col 16+)
//!   - Dataset data-flow edges in analysis graph (step writes → step reads)

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

pub struct JclParser;

impl JclParser {
    pub fn new() -> Self { Self }

    // ── helpers ────────────────────────────────────────────────────

    /// Extract a keyword parameter value from the uppercased remainder of a JCL statement.
    /// Handles simple `KEY=val` and parenthesized `KEY=(a,b,c)`.
    fn extract_param(upper: &str, key: &str) -> Option<String> {
        let needle = format!("{}=", key);
        let start = upper.find(&needle)?;
        let after = &upper[start + needle.len()..];
        if after.starts_with('(') {
            // find matching close paren
            let mut depth = 0;
            let mut end = 0;
            for (i, ch) in after.char_indices() {
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 { end = i + 1; break; }
                    }
                    _ => {}
                }
            }
            Some(after[..end].to_string())
        } else {
            let val: String = after.chars()
                .take_while(|c| !c.is_whitespace() && *c != ',')
                .collect();
            Some(val)
        }
    }

    /// Extract a simple `KEY=val` (no parens) stopping at comma or space.
    fn extract_simple(upper: &str, key: &str) -> Option<String> {
        let needle = format!("{}=", key);
        let start = upper.find(&needle)?;
        let after = &upper[start + needle.len()..];
        let val: String = after.chars()
            .take_while(|c| !c.is_whitespace() && *c != ',' && *c != ')')
            .collect();
        if val.is_empty() { None } else { Some(val) }
    }

    /// Classify a program name into a utility category, if recognized.
    fn classify_utility(pgm: &str) -> Option<&'static str> {
        match pgm {
            "IEBCOPY"  => Some("dataset-copy"),
            "IEBGENER" => Some("dataset-copy"),
            "IEFBR14"  => Some("null-utility"),
            "IDCAMS"   => Some("ams-utility"),
            "DFSORT" | "SORT" | "SYNCSORT" | "ICEMAN" => Some("sort-utility"),
            "ICETOOL"  => Some("sort-tool"),
            "IEBUPDTE" => Some("pds-update"),
            "IEBCOMPR" => Some("dataset-compare"),
            "IEBEDIT"  => Some("jcl-edit"),
            "IEHLIST"  => Some("catalog-list"),
            "IEHPROGM" => Some("catalog-maintain"),
            "IEHMOVE"  => Some("dataset-move"),
            "IKJEFT01" | "IKJEFT1B" => Some("tso-batch"),
            "IRXJCL"   => Some("rexx-batch"),
            "ADRDSSU"  => Some("dfhsm-utility"),
            "GIMSMP"   => Some("smp-e"),
            "IEWL" | "IEWBLINK" | "HEWL" => Some("linkage-editor"),
            _ => None,
        }
    }

    /// Detect GDG relative generation from a DSN value.
    fn detect_gdg(dsn: &str) -> Option<i32> {
        // patterns: DSN=MY.GDG(+1), DSN=MY.GDG(0), DSN=MY.GDG(-1)
        if let Some(pos) = dsn.rfind('(') {
            let inner = dsn[pos..].trim_start_matches('(').trim_end_matches(')');
            if let Ok(gen) = inner.parse::<i32>() {
                return Some(gen);
            }
        }
        None
    }

    /// Join continuation lines starting from `start_idx`.
    /// JCL continuation: if column 72 is non-blank or next line starts with "// " with
    /// content beginning at column 16 or later, it is a continuation.
    /// Returns (joined_upper_line, last_line_index).
    fn join_continuation(lines: &[&str], start_idx: usize) -> (String, usize) {
        let mut joined = lines[start_idx].to_string();
        let mut last = start_idx;
        for i in (start_idx + 1)..lines.len() {
            let l = lines[i];
            if l.starts_with("//*") { continue; } // skip comments
            if l.starts_with("//") && l.len() > 15 {
                let after_slash = &l[2..];
                // continuation: name field blank (starts with spaces) and content at col 16+
                let leading_spaces = after_slash.chars().take_while(|c| *c == ' ').count();
                if leading_spaces >= 14 {
                    // this is a continuation line
                    joined.push(' ');
                    joined.push_str(after_slash.trim());
                    last = i;
                    continue;
                }
            }
            break;
        }
        (joined.to_uppercase(), last)
    }
}

impl LanguageParser for JclParser {
    fn language_id(&self) -> &'static str { "jcl" }
    fn display_name(&self) -> &'static str { "JCL (z/OS Job Control Language)" }
    fn supported_dialects(&self) -> &[&'static str] { &["JES2", "JES3"] }
    fn file_extensions(&self) -> &[&'static str] { &["jcl", "proc", "prc"] }

    fn can_parse(&self, file: &SourceFile) -> bool {
        let ext_match = self.file_extensions().contains(&file.extension.as_str());
        let content_match = file.header.lines().take(5).any(|l| {
            l.starts_with("//") && (l.contains(" JOB ") || l.contains(" EXEC ") || l.contains(" DD "))
        });
        ext_match || content_match
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let mut ast_nodes: Vec<AstNode> = Vec::new();
        let mut symbols: Vec<Symbol> = Vec::new();
        let mut diagnostics: Vec<Diagnostic> = Vec::new();
        let mut metadata: HashMap<String, serde_json::Value> = HashMap::new();

        // Counters
        let mut step_count: usize = 0;
        let mut dd_count: usize = 0;
        let mut dataset_count: usize = 0;
        let mut utility_count: usize = 0;
        let mut proc_count: usize = 0;
        let mut comment_count: usize = 0;
        let mut set_count: usize = 0;
        let mut if_count: usize = 0;
        let mut include_count: usize = 0;

        let mut utilities_used: Vec<serde_json::Value> = Vec::new();
        let mut datasets_seen: Vec<serde_json::Value> = Vec::new();

        // State tracking
        let mut current_step: Option<String> = None; // step name of current EXEC
        let mut current_step_line: usize = 0;
        let mut in_proc = false;
        let mut current_proc_name: Option<String> = None;
        let mut current_proc_start: usize = 0;

        // Track dataset → step relationships for data-flow graph
        // (dataset_name, step_name, "read" | "write", line)
        let mut ds_access: Vec<(String, String, String, usize)> = Vec::new();

        let lines: Vec<&str> = source.content.lines().collect();
        let total_lines = lines.len();
        let mut i = 0;

        while i < total_lines {
            let line = lines[i];

            // ── Comment lines ──────────────────────────────────────────
            if line.starts_with("//*") {
                comment_count += 1;
                i += 1;
                continue;
            }

            // ── Inline data (non-JCL lines after DD * / DD DATA) ──────
            if !line.starts_with("//") {
                i += 1;
                continue;
            }

            let raw_content = &line[2..];
            let (joined_upper, last_idx) = Self::join_continuation(&lines, i);
            let upper = &joined_upper;

            // Derive name field (characters before first space in raw_content)
            let name_field: String = raw_content.chars()
                .take_while(|c| !c.is_whitespace())
                .collect();

            // ── JOB card ──────────────────────────────────────────────
            if upper.contains(" JOB ") {
                let job_name = if name_field.is_empty() { "UNNAMED".to_string() } else { name_field.clone() };

                let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                if let Some(v) = Self::extract_simple(upper, "CLASS") {
                    props.insert("class".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_simple(upper, "MSGCLASS") {
                    props.insert("msgclass".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_param(upper, "MSGLEVEL") {
                    props.insert("msglevel".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_simple(upper, "NOTIFY") {
                    props.insert("notify".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_simple(upper, "REGION") {
                    props.insert("region".into(), serde_json::json!(v));
                }

                symbols.push(Symbol {
                    name: job_name.clone(),
                    kind: SymbolKind::Program,
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    visibility: Visibility::Public,
                    data_type: None,
                    properties: props.clone(),
                });

                ast_nodes.push(AstNode {
                    id: format!("job-{i}"),
                    kind: AstNodeKind::Custom("JOBCard".into()),
                    name: Some(job_name),
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: props,
                });

                i = last_idx + 1;
                continue;
            }

            // ── JCLLIB ORDER ──────────────────────────────────────────
            if upper.contains(" JCLLIB ") && upper.contains("ORDER") {
                let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                if let Some(v) = Self::extract_param(upper, "ORDER") {
                    props.insert("order".into(), serde_json::json!(v));
                }
                ast_nodes.push(AstNode {
                    id: format!("jcllib-{i}"),
                    kind: AstNodeKind::Custom("JCLLIB".into()),
                    name: None,
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: props,
                });
                i = last_idx + 1;
                continue;
            }

            // ── INCLUDE MEMBER= ───────────────────────────────────────
            if upper.contains(" INCLUDE ") && upper.contains("MEMBER=") {
                include_count += 1;
                let member = Self::extract_simple(upper, "MEMBER").unwrap_or_default();
                ast_nodes.push(AstNode {
                    id: format!("include-{i}"),
                    kind: AstNodeKind::CopyStatement,
                    name: Some(member.clone()),
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: HashMap::from([
                        ("member".into(), serde_json::json!(member)),
                    ]),
                });
                i = last_idx + 1;
                continue;
            }

            // ── SET symbolic= ─────────────────────────────────────────
            if upper.contains(" SET ") {
                set_count += 1;
                // SET VAR=VALUE  — extract left and right of first '='
                let set_part = upper.split(" SET ").nth(1).unwrap_or("");
                let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                if let Some(eq) = set_part.find('=') {
                    let var_name = set_part[..eq].trim().to_string();
                    let var_value = set_part[eq + 1..].trim()
                        .chars().take_while(|c| !c.is_whitespace()).collect::<String>();
                    props.insert("variable".into(), serde_json::json!(var_name));
                    props.insert("value".into(), serde_json::json!(var_value));
                }
                ast_nodes.push(AstNode {
                    id: format!("set-{i}"),
                    kind: AstNodeKind::Assignment,
                    name: props.get("variable").and_then(|v| v.as_str()).map(String::from),
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: props,
                });
                i = last_idx + 1;
                continue;
            }

            // ── IF / THEN / ELSE / ENDIF ──────────────────────────────
            if upper.contains(" IF ") && upper.contains(" THEN") {
                if_count += 1;
                // Extract condition between IF and THEN
                let cond = upper
                    .split(" IF ").nth(1).unwrap_or("")
                    .split(" THEN").next().unwrap_or("").trim().to_string();
                ast_nodes.push(AstNode {
                    id: format!("if-{i}"),
                    kind: AstNodeKind::IfStatement,
                    name: None,
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: HashMap::from([
                        ("condition".into(), serde_json::json!(cond)),
                    ]),
                });
                i = last_idx + 1;
                continue;
            }
            if upper.contains(" ELSE") && !upper.contains(" ENDIF") {
                ast_nodes.push(AstNode {
                    id: format!("else-{i}"),
                    kind: AstNodeKind::Custom("ELSE".into()),
                    name: None,
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: line.len() },
                    children: vec![],
                    properties: HashMap::new(),
                });
                i = last_idx + 1;
                continue;
            }
            if upper.contains(" ENDIF") {
                ast_nodes.push(AstNode {
                    id: format!("endif-{i}"),
                    kind: AstNodeKind::Custom("ENDIF".into()),
                    name: None,
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: line.len() },
                    children: vec![],
                    properties: HashMap::new(),
                });
                i = last_idx + 1;
                continue;
            }

            // ── PROC ──────────────────────────────────────────────────
            if upper.contains(" PROC ") || upper.trim_end().ends_with(" PROC") {
                in_proc = true;
                proc_count += 1;
                current_proc_name = if name_field.is_empty() { None } else { Some(name_field.clone()) };
                current_proc_start = i;
                let proc_name = current_proc_name.clone().unwrap_or_else(|| format!("PROC_{i}"));
                symbols.push(Symbol {
                    name: proc_name.clone(),
                    kind: SymbolKind::Procedure,
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: line.len() },
                    visibility: Visibility::Public,
                    data_type: None,
                    properties: HashMap::new(),
                });
                ast_nodes.push(AstNode {
                    id: format!("proc-{i}"),
                    kind: AstNodeKind::Procedure,
                    name: Some(proc_name),
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: line.len() },
                    children: vec![],
                    properties: HashMap::new(),
                });
                i = last_idx + 1;
                continue;
            }

            // ── PEND ──────────────────────────────────────────────────
            if upper.contains(" PEND") {
                if in_proc {
                    // Update the PROC node span to include PEND
                    if let Some(proc_node) = ast_nodes.iter_mut().rev()
                        .find(|n| matches!(n.kind, AstNodeKind::Procedure))
                    {
                        proc_node.span.end_line = i;
                        proc_node.span.end_col = line.len();
                    }
                    in_proc = false;
                    current_proc_name = None;
                }
                ast_nodes.push(AstNode {
                    id: format!("pend-{i}"),
                    kind: AstNodeKind::Custom("PEND".into()),
                    name: None,
                    span: Span { start_line: i, start_col: 0, end_line: i, end_col: line.len() },
                    children: vec![],
                    properties: HashMap::new(),
                });
                i = last_idx + 1;
                continue;
            }

            // ── OUTPUT JCL ────────────────────────────────────────────
            if upper.contains(" OUTPUT ") && (upper.contains("DEFAULT=") || upper.contains("JESDS=") || upper.contains("DEST=")) {
                let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                if let Some(v) = Self::extract_simple(upper, "DEFAULT") {
                    props.insert("default".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_simple(upper, "DEST") {
                    props.insert("dest".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_simple(upper, "CLASS") {
                    props.insert("class".into(), serde_json::json!(v));
                }
                ast_nodes.push(AstNode {
                    id: format!("output-{i}"),
                    kind: AstNodeKind::Custom("OUTPUT".into()),
                    name: if name_field.is_empty() { None } else { Some(name_field.clone()) },
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: props,
                });
                i = last_idx + 1;
                continue;
            }

            // ── EXEC statement ────────────────────────────────────────
            if upper.contains(" EXEC ") {
                step_count += 1;
                let step_name = if name_field.is_empty() {
                    format!("STEP{step_count}")
                } else {
                    name_field.clone()
                };

                current_step = Some(step_name.clone());
                current_step_line = i;

                let pgm = Self::extract_simple(upper, "PGM").unwrap_or_default();
                let proc_ref = Self::extract_simple(upper, "PROC")
                    .or_else(|| {
                        // bare EXEC procname (no PGM= or PROC=)
                        if pgm.is_empty() {
                            let after_exec = upper.split(" EXEC ").nth(1)?;
                            let first_token = after_exec.split_whitespace().next()?;
                            if !first_token.contains('=') { Some(first_token.to_string()) } else { None }
                        } else { None }
                    });

                let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                props.insert("step_name".into(), serde_json::json!(step_name));
                if !pgm.is_empty() {
                    props.insert("pgm".into(), serde_json::json!(pgm));
                }
                if let Some(ref pr) = proc_ref {
                    props.insert("proc".into(), serde_json::json!(pr));
                }
                if let Some(v) = Self::extract_param(upper, "PARM") {
                    props.insert("parm".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_param(upper, "COND") {
                    props.insert("cond".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_simple(upper, "TIME") {
                    props.insert("time".into(), serde_json::json!(v));
                }
                if let Some(v) = Self::extract_simple(upper, "REGION") {
                    props.insert("region".into(), serde_json::json!(v));
                }

                // Utility classification
                let target = if !pgm.is_empty() { &pgm } else { proc_ref.as_deref().unwrap_or("") };
                if let Some(util_class) = Self::classify_utility(target) {
                    utility_count += 1;
                    props.insert("utility_class".into(), serde_json::json!(util_class));
                    utilities_used.push(serde_json::json!({
                        "program": target,
                        "class": util_class,
                        "step": step_name,
                        "line": i,
                    }));
                }

                let exec_name = if !pgm.is_empty() { pgm.clone() } else {
                    proc_ref.clone().unwrap_or_default()
                };

                ast_nodes.push(AstNode {
                    id: format!("exec-{i}"),
                    kind: AstNodeKind::CallStatement,
                    name: Some(exec_name),
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: props,
                });

                i = last_idx + 1;
                continue;
            }

            // ── DD statement ──────────────────────────────────────────
            if upper.contains(" DD ") || upper.contains(" DD\t") || upper.trim_end().ends_with(" DD") {
                dd_count += 1;

                // DD name: the name field, which may be empty for concatenation
                let dd_name = if name_field.is_empty() { String::new() } else { name_field.clone() };
                let is_concatenation = dd_name.is_empty() && dd_count > 1;

                let step_ref = current_step.clone().unwrap_or_else(|| "GLOBAL".into());

                let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                props.insert("dd_name".into(), serde_json::json!(dd_name));
                props.insert("step_name".into(), serde_json::json!(step_ref));

                if is_concatenation {
                    props.insert("concatenation".into(), serde_json::json!(true));
                }

                // ── DUMMY ─────────────────────────────────────────────
                if upper.contains(" DUMMY") || upper.trim_end().ends_with("DUMMY") {
                    props.insert("dummy".into(), serde_json::json!(true));
                }

                // ── DD * or DD DATA (inline SYSIN) ────────────────────
                let dd_pos = upper.find(" DD ").unwrap_or(0);
                let after_dd = &upper[dd_pos + 4..];
                let after_dd_trimmed = after_dd.trim_start();
                if after_dd_trimmed.starts_with('*') || after_dd_trimmed.starts_with("DATA") {
                    props.insert("inline_data".into(), serde_json::json!(true));
                    // Collect inline data lines until /* or next // statement
                    let mut inline_lines: Vec<String> = Vec::new();
                    let mut j = last_idx + 1;
                    while j < total_lines {
                        let dl = lines[j];
                        if dl.starts_with("//") || dl.starts_with("/*") {
                            break;
                        }
                        inline_lines.push(dl.to_string());
                        j += 1;
                    }
                    if !inline_lines.is_empty() {
                        props.insert("inline_line_count".into(), serde_json::json!(inline_lines.len()));
                        // Store first few lines for preview
                        let preview: Vec<&str> = inline_lines.iter()
                            .take(5).map(|s| s.as_str()).collect();
                        props.insert("inline_preview".into(), serde_json::json!(preview));
                    }
                }

                // ── SYSOUT=class ──────────────────────────────────────
                if let Some(v) = Self::extract_simple(upper, "SYSOUT") {
                    props.insert("sysout".into(), serde_json::json!(v));
                }

                // ── DSN= / DSNAME= ───────────────────────────────────
                let dsn = Self::extract_param(upper, "DSN")
                    .or_else(|| Self::extract_param(upper, "DSNAME"));
                if let Some(ref dsn_val) = dsn {
                    dataset_count += 1;
                    props.insert("dsn".into(), serde_json::json!(dsn_val));

                    // GDG detection
                    if let Some(gen) = Self::detect_gdg(dsn_val) {
                        props.insert("gdg_generation".into(), serde_json::json!(gen));
                        props.insert("is_gdg".into(), serde_json::json!(true));
                    }

                    // Temporary dataset (&&)
                    if dsn_val.starts_with("&&") {
                        props.insert("temporary".into(), serde_json::json!(true));
                    }

                    datasets_seen.push(serde_json::json!({
                        "dsn": dsn_val,
                        "dd_name": dd_name,
                        "step": step_ref,
                        "line": i,
                    }));
                }

                // ── DISP=(status,normal,abnormal) ─────────────────────
                if let Some(v) = Self::extract_param(upper, "DISP") {
                    props.insert("disp".into(), serde_json::json!(v));
                    let disp_str = v.trim_start_matches('(').trim_end_matches(')');
                    let disp_parts: Vec<&str> = disp_str.split(',').collect();
                    if let Some(status) = disp_parts.first() {
                        let s = status.trim();
                        props.insert("disp_status".into(), serde_json::json!(s));
                        // Determine read vs write for data-flow
                        if let Some(ref dsn_val) = dsn {
                            let access = match s {
                                "NEW" | "MOD" => "write",
                                "OLD" => "readwrite",
                                "SHR" => "read",
                                _ => "read",
                            };
                            props.insert("access_mode".into(), serde_json::json!(access));
                            ds_access.push((
                                dsn_val.clone(),
                                step_ref.clone(),
                                access.to_string(),
                                i,
                            ));
                        }
                    }
                    if let Some(normal) = disp_parts.get(1) {
                        props.insert("disp_normal".into(), serde_json::json!(normal.trim()));
                    }
                    if let Some(abnormal) = disp_parts.get(2) {
                        props.insert("disp_abnormal".into(), serde_json::json!(abnormal.trim()));
                    }
                } else if dsn.is_some() {
                    // No DISP specified — default is (NEW,DELETE,DELETE) for temp, (SHR) otherwise
                    let is_temp = dsn.as_ref().map(|d| d.starts_with("&&")).unwrap_or(false);
                    let access = if is_temp { "write" } else { "read" };
                    props.insert("access_mode".into(), serde_json::json!(access));
                    if let Some(ref dsn_val) = dsn {
                        ds_access.push((dsn_val.clone(), step_ref.clone(), access.to_string(), i));
                    }
                }

                // ── SPACE=(unit,(primary,secondary,directory)) ────────
                if let Some(v) = Self::extract_param(upper, "SPACE") {
                    props.insert("space".into(), serde_json::json!(v));
                    let space_inner = v.trim_start_matches('(').trim_end_matches(')');
                    let space_parts: Vec<&str> = space_inner.split(',').collect();
                    if let Some(unit) = space_parts.first() {
                        props.insert("space_unit".into(), serde_json::json!(unit.trim().trim_start_matches('(')));
                    }
                }

                // ── DCB=(RECFM=,LRECL=,BLKSIZE=) ─────────────────────
                if let Some(v) = Self::extract_param(upper, "DCB") {
                    props.insert("dcb".into(), serde_json::json!(v));
                    let dcb_inner = v.trim_start_matches('(').trim_end_matches(')');
                    if let Some(recfm) = Self::extract_simple(dcb_inner, "RECFM") {
                        props.insert("recfm".into(), serde_json::json!(recfm));
                    }
                    if let Some(lrecl) = Self::extract_simple(dcb_inner, "LRECL") {
                        props.insert("lrecl".into(), serde_json::json!(lrecl));
                    }
                    if let Some(blksize) = Self::extract_simple(dcb_inner, "BLKSIZE") {
                        props.insert("blksize".into(), serde_json::json!(blksize));
                    }
                }
                // Also check for top-level RECFM=, LRECL=, BLKSIZE= (without DCB wrapper)
                if !props.contains_key("recfm") {
                    if let Some(v) = Self::extract_simple(upper, "RECFM") {
                        props.insert("recfm".into(), serde_json::json!(v));
                    }
                }
                if !props.contains_key("lrecl") {
                    if let Some(v) = Self::extract_simple(upper, "LRECL") {
                        props.insert("lrecl".into(), serde_json::json!(v));
                    }
                }
                if !props.contains_key("blksize") {
                    if let Some(v) = Self::extract_simple(upper, "BLKSIZE") {
                        props.insert("blksize".into(), serde_json::json!(v));
                    }
                }

                // ── JOBLIB / STEPLIB detection ────────────────────────
                let upper_dd = dd_name.to_uppercase();
                if upper_dd == "JOBLIB" || upper_dd == "STEPLIB" {
                    props.insert("library_dd".into(), serde_json::json!(true));
                    props.insert("library_type".into(), serde_json::json!(upper_dd));
                }

                // ── VOL=SER= ─────────────────────────────────────────
                if let Some(v) = Self::extract_param(upper, "VOL") {
                    props.insert("vol".into(), serde_json::json!(v));
                }

                // ── UNIT= ────────────────────────────────────────────
                if let Some(v) = Self::extract_simple(upper, "UNIT") {
                    props.insert("unit".into(), serde_json::json!(v));
                }

                ast_nodes.push(AstNode {
                    id: format!("dd-{i}"),
                    kind: AstNodeKind::Custom("DDStatement".into()),
                    name: Some(dd_name),
                    span: Span { start_line: i, start_col: 0, end_line: last_idx, end_col: lines[last_idx].len() },
                    children: vec![],
                    properties: props,
                });

                i = last_idx + 1;
                continue;
            }

            // ── Null statement (// alone) or unrecognized ─────────────
            i += 1;
        }

        // ── Populate metadata ─────────────────────────────────────────
        metadata.insert("step_count".into(), serde_json::json!(step_count));
        metadata.insert("dd_count".into(), serde_json::json!(dd_count));
        metadata.insert("dataset_count".into(), serde_json::json!(dataset_count));
        metadata.insert("utility_count".into(), serde_json::json!(utility_count));
        metadata.insert("procedure_count".into(), serde_json::json!(proc_count));
        metadata.insert("comment_count".into(), serde_json::json!(comment_count));
        metadata.insert("set_count".into(), serde_json::json!(set_count));
        metadata.insert("if_count".into(), serde_json::json!(if_count));
        metadata.insert("include_count".into(), serde_json::json!(include_count));
        if !utilities_used.is_empty() {
            metadata.insert("utilities_used".into(), serde_json::json!(utilities_used));
        }
        if !datasets_seen.is_empty() {
            metadata.insert("datasets".into(), serde_json::json!(datasets_seen));
        }

        // Emit diagnostic if no JOB card found (common in PROC members)
        let has_job = symbols.iter().any(|s| s.kind == SymbolKind::Program);
        if !has_job && proc_count == 0 {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Info,
                message: "No JOB card found — may be a procedure or JCL fragment".into(),
                span: Span { start_line: 0, start_col: 0, end_line: 0, end_col: 0 },
                code: Some("JCL001".into()),
            });
        }

        // Detect JES dialect from content heuristics
        let upper_all = source.content.to_uppercase();
        let dialect = if upper_all.contains("/*JOBPARM") || upper_all.contains("/*ROUTE") || upper_all.contains("/*PRIORITY") {
            "JES2"
        } else if upper_all.contains("//*MAIN") || upper_all.contains("//*NET") || upper_all.contains("//*FORMAT") {
            "JES3"
        } else {
            "JES2" // default
        };

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
        Ok(PartialParseOutput { output, parsed_up_to_line: total, error: String::new(), coverage: 1.0 })
    }

    fn resolve_dependencies(&self, module: &ParseOutput, _vault: &SourceVault) -> Vec<DependencyRef> {
        let mut deps = Vec::new();

        for node in &module.ast_nodes {
            match &node.kind {
                // EXEC PGM= → cross-language dependency on COBOL/ASM program
                AstNodeKind::CallStatement => {
                    if let Some(ref name) = node.name {
                        let is_utility = node.properties.get("utility_class").is_some();
                        let has_proc = node.properties.get("proc").is_some();
                        if !name.is_empty() && !is_utility {
                            let dep_type = if has_proc {
                                DependencyType::CrossLanguage { target_language: "jcl".to_string() }
                            } else {
                                DependencyType::CrossLanguage { target_language: "cobol".to_string() }
                            };
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: name.clone(),
                                dependency_type: dep_type,
                                source_span: node.span,
                                reference_text: if has_proc {
                                    format!("EXEC PROC={}", name)
                                } else {
                                    format!("EXEC PGM={}", name)
                                },
                            });
                        }
                    }
                }
                // INCLUDE MEMBER= → JCL include dependency
                AstNodeKind::CopyStatement => {
                    if let Some(ref name) = node.name {
                        deps.push(DependencyRef {
                            from_module: module.source_path.clone(),
                            to_module: name.clone(),
                            dependency_type: DependencyType::CopyInclude,
                            source_span: node.span,
                            reference_text: format!("INCLUDE MEMBER={}", name),
                        });
                    }
                }
                // DD with DSN= → file access dependency
                AstNodeKind::Custom(ref kind) if kind == "DDStatement" => {
                    if let Some(dsn) = node.properties.get("dsn").and_then(|v| v.as_str()) {
                        if !dsn.starts_with("&&") {
                            deps.push(DependencyRef {
                                from_module: module.source_path.clone(),
                                to_module: dsn.to_string(),
                                dependency_type: DependencyType::FileAccess,
                                source_span: node.span,
                                reference_text: format!("DD DSN={}", dsn),
                            });
                        }
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
        let mut data_flows: Vec<DataFlow> = Vec::new();

        // Collect EXEC steps as nodes
        let exec_nodes: Vec<&AstNode> = output.ast_nodes.iter()
            .filter(|n| matches!(n.kind, AstNodeKind::CallStatement))
            .collect();

        // Track which datasets each step writes and reads
        // step_name → Vec<(dsn, access_mode)>
        let mut step_writes: HashMap<String, Vec<String>> = HashMap::new();
        let mut step_reads: HashMap<String, Vec<String>> = HashMap::new();

        // Build step analysis nodes and sequential flow edges
        let mut prev_step_id: Option<String> = None;
        for exec in &exec_nodes {
            let step_name = exec.properties.get("step_name")
                .and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
            let pgm = exec.name.as_deref().unwrap_or("UNKNOWN");
            let node_id = exec.id.clone();

            let kind = if exec.properties.get("utility_class").is_some() {
                AnalysisNodeKind::DataTransformation
            } else {
                AnalysisNodeKind::ExternalCall
            };

            let mut props: HashMap<String, serde_json::Value> = HashMap::new();
            props.insert("program".into(), serde_json::json!(pgm));
            if let Some(util) = exec.properties.get("utility_class") {
                props.insert("utility_class".into(), util.clone());
            }

            nodes.push(AnalysisNode {
                id: node_id.clone(),
                kind,
                name: format!("{} ({})", step_name, pgm),
                source_span: exec.span,
                properties: props,
            });

            // Sequential control flow edge from previous step
            if let Some(ref prev) = prev_step_id {
                edges.push(AnalysisEdge {
                    from: prev.clone(),
                    to: node_id.clone(),
                    kind: AnalysisEdgeKind::ControlFlow,
                    label: Some("next-step".into()),
                });
            }
            prev_step_id = Some(node_id);
        }

        // Collect DD statements and their dataset accesses per step
        for dd in output.ast_nodes.iter()
            .filter(|n| matches!(&n.kind, AstNodeKind::Custom(k) if k == "DDStatement"))
        {
            let step = dd.properties.get("step_name")
                .and_then(|v| v.as_str()).unwrap_or("GLOBAL");
            let dsn = match dd.properties.get("dsn").and_then(|v| v.as_str()) {
                Some(d) => d.to_string(),
                None => continue,
            };
            let access = dd.properties.get("access_mode")
                .and_then(|v| v.as_str()).unwrap_or("read");

            match access {
                "write" => step_writes.entry(step.to_string()).or_default().push(dsn.clone()),
                "readwrite" => {
                    step_writes.entry(step.to_string()).or_default().push(dsn.clone());
                    step_reads.entry(step.to_string()).or_default().push(dsn.clone());
                }
                _ => step_reads.entry(step.to_string()).or_default().push(dsn.clone()),
            }

            // Add file operation node for significant datasets
            if !dsn.starts_with("&&") {
                let dd_name = dd.properties.get("dd_name")
                    .and_then(|v| v.as_str()).unwrap_or("?");
                let file_node_id = format!("ds-{}-{}", step, dd_name);

                let edge_kind = if access == "write" || access == "readwrite" {
                    AnalysisEdgeKind::WritesTo
                } else {
                    AnalysisEdgeKind::ReadsFrom
                };

                // Find the exec node for this step
                if let Some(exec) = exec_nodes.iter()
                    .find(|e| e.properties.get("step_name").and_then(|v| v.as_str()) == Some(step))
                {
                    nodes.push(AnalysisNode {
                        id: file_node_id.clone(),
                        kind: AnalysisNodeKind::FileOperation,
                        name: dsn.clone(),
                        source_span: dd.span,
                        properties: HashMap::from([
                            ("dsn".into(), serde_json::json!(dsn)),
                            ("access".into(), serde_json::json!(access)),
                        ]),
                    });

                    edges.push(AnalysisEdge {
                        from: exec.id.clone(),
                        to: file_node_id,
                        kind: edge_kind,
                        label: Some(format!("{} {}", dd_name, access)),
                    });
                }
            }
        }

        // ── Cross-step data-flow edges: step A writes DSN → step B reads same DSN ──
        for (writer_step, written_dsns) in &step_writes {
            for (reader_step, read_dsns) in &step_reads {
                if writer_step == reader_step { continue; }
                for dsn in written_dsns {
                    if read_dsns.contains(dsn) {
                        // Find the exec node IDs
                        let writer_id = exec_nodes.iter()
                            .find(|e| e.properties.get("step_name").and_then(|v| v.as_str()) == Some(writer_step))
                            .map(|e| e.id.clone());
                        let reader_id = exec_nodes.iter()
                            .find(|e| e.properties.get("step_name").and_then(|v| v.as_str()) == Some(reader_step))
                            .map(|e| e.id.clone());

                        if let (Some(w_id), Some(r_id)) = (writer_id, reader_id) {
                            edges.push(AnalysisEdge {
                                from: w_id.clone(),
                                to: r_id.clone(),
                                kind: AnalysisEdgeKind::DataFlow,
                                label: Some(format!("via {}", dsn)),
                            });

                            data_flows.push(DataFlow {
                                id: format!("flow-{}-{}-{}", writer_step, reader_step, dsn),
                                description: format!(
                                    "Step {} writes {} which step {} reads",
                                    writer_step, dsn, reader_step
                                ),
                                source_node: w_id,
                                sink_node: r_id,
                                transformations: vec![dsn.clone()],
                            });
                        }
                    }
                }
            }
        }

        Ok(AnalysisGraph {
            source_language: self.language_id().to_string(),
            source_path: output.source_path.clone(),
            nodes,
            edges,
            business_rules: vec![],
            data_flows,
        })
    }
}
