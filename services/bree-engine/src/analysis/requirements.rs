//! Requirements document generator — extracts functional requirements
//! directly from parsed COBOL code. Every description is derived from
//! the code itself (variable names, 88-levels, string literals, PIC clauses),
//! not from hardcoded templates. Works for any domain.

use crate::analysis::util::humanize;
use crate::parser::nir::*;
use crate::analysis::business_rules;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct RequirementsDocument {
    pub program_id: String,
    pub program_description: String,
    pub functional_requirements: Vec<FunctionalRequirement>,
    pub data_dictionary: Vec<DataField>,
    pub integration_points: IntegrationPoints,
    pub hardcoded_values: Vec<business_rules::HardcodedValue>,
    pub process_flow: Vec<FlowStep>,
    pub summary: RequirementsSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct FunctionalRequirement {
    pub id: String,
    pub name: String,
    pub paragraph: String,
    pub source_lines: (usize, usize),
    pub description: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub rules: Vec<DerivedRule>,
    pub calculations: Vec<DerivedCalculation>,
    pub error_handling: Vec<String>,
    pub calls: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DerivedRule {
    pub condition_raw: String,
    pub description: String,
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DerivedCalculation {
    pub target: String,
    pub formula_raw: String,
    pub description: String,
    pub hardcoded: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DataField {
    pub name: String,
    pub level: String,
    pub pic: String,
    pub description: String,
    pub values: Vec<String>, // 88-level values
    pub group_parent: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntegrationPoints {
    pub database_tables: Vec<DatabaseRef>,
    pub external_programs: Vec<String>,
    pub cics_maps: Vec<String>,
    pub copybooks: Vec<String>,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseRef {
    pub table: String,
    pub operation: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlowStep {
    pub sequence: usize,
    pub paragraph: String,
    pub calls_to: Vec<String>,
    pub is_conditional: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RequirementsSummary {
    pub total_requirements: usize,
    pub total_rules: usize,
    pub total_calculations: usize,
    pub total_integrations: usize,
    pub total_data_fields: usize,
    pub hardcoded_count: usize,
    pub complexity_rating: String,
}

/// Generate a requirements document entirely from parsed code.
pub fn generate_requirements(output: &ParseOutput) -> RequirementsDocument {
    let program_id = extract_program_id(output);
    let program_description = derive_program_description(output);

    // Build paragraph boundaries: [(name, start_line, end_line)]
    let paragraphs = build_paragraph_map(output);

    // Build 88-level map: parent_field → [(condition_name, value)]
    let level_88_map = build_88_level_map(output);

    // Collect all PERFORM targets from the first paragraph (main flow)
    let process_flow = build_process_flow(output, &paragraphs);

    // Generate one FunctionalRequirement per paragraph
    let mut func_reqs = Vec::new();
    for (idx, (para_name, start, end)) in paragraphs.iter().enumerate() {
        let nodes_in_para = nodes_in_range(&output.ast_nodes, *start, *end);
        let fr = build_functional_requirement(
            idx + 1, para_name, *start, *end,
            &nodes_in_para, &output.symbols, &level_88_map, output,
        );
        func_reqs.push(fr);
    }

    // Data dictionary from symbols
    let data_dictionary = build_data_dictionary(&output.symbols, &level_88_map);

    // Integration points
    let integration_points = extract_integrations(output);

    // Collect all hardcoded values
    let mut all_hardcoded = Vec::new();
    for fr in &func_reqs {
        for calc in &fr.calculations {
            for hv in &calc.hardcoded {
                all_hardcoded.push(business_rules::HardcodedValue {
                    value: hv.clone(),
                    meaning: format!("Hardcoded value in {}", fr.paragraph),
                    risk: "high",
                    recommendation: format!("Extract {} to configuration", hv),
                });
            }
        }
    }

    let total_rules: usize = func_reqs.iter().map(|f| f.rules.len()).sum();
    let total_calcs: usize = func_reqs.iter().map(|f| f.calculations.len()).sum();
    let total_integrations = integration_points.database_tables.len()
        + integration_points.external_programs.len()
        + integration_points.cics_maps.len()
        + integration_points.copybooks.len();

    let complexity_rating = if total_rules > 15 || func_reqs.len() > 10 {
        "High"
    } else if total_rules > 8 || func_reqs.len() > 5 {
        "Medium"
    } else {
        "Low"
    }.to_string();

    let summary = RequirementsSummary {
        total_requirements: func_reqs.len(),
        total_rules,
        total_calculations: total_calcs,
        total_integrations,
        total_data_fields: data_dictionary.len(),
        hardcoded_count: all_hardcoded.len(),
        complexity_rating,
    };

    RequirementsDocument {
        program_id,
        program_description,
        functional_requirements: func_reqs,
        data_dictionary,
        integration_points,
        hardcoded_values: all_hardcoded,
        process_flow,
        summary,
    }
}

// ─── Extract program ID from metadata or symbols ────────────────────

fn extract_program_id(output: &ParseOutput) -> String {
    if let Some(pid) = output.metadata.get("program_id").and_then(|v| v.as_str()) {
        return pid.to_string();
    }
    for sym in &output.symbols {
        if matches!(sym.kind, SymbolKind::Program) {
            return sym.name.clone();
        }
    }
    output.source_path.rsplit('/').next().unwrap_or("UNKNOWN").to_string()
}

/// Derive program description from paragraph names and data structures.
fn derive_program_description(output: &ParseOutput) -> String {
    let para_names: Vec<&str> = output.symbols.iter()
        .filter(|s| matches!(s.kind, SymbolKind::Paragraph))
        .map(|s| s.name.as_str())
        .collect();

    let has_sql = output.embedded_blocks.iter().any(|b| matches!(b.block_type, EmbeddedBlockType::ExecSql));
    let has_cics = output.embedded_blocks.iter().any(|b| matches!(b.block_type, EmbeddedBlockType::ExecCics));
    let has_calls = output.ast_nodes.iter().any(|n| matches!(n.kind, AstNodeKind::CallStatement));

    // Derive description from what the code actually does
    let mut activities = Vec::new();
    for name in &para_names {
        let upper = name.to_uppercase();
        if upper.contains("VALID") || upper.contains("CHECK") || upper.contains("VERIFY") {
            activities.push("validates input data");
        } else if upper.contains("PROCESS") || upper.contains("PROC") {
            activities.push("processes transactions");
        } else if upper.contains("CALC") || upper.contains("COMPUTE") || upper.contains("FEE") {
            activities.push("performs calculations");
        } else if upper.contains("UPDATE") || upper.contains("WRITE") || upper.contains("SAVE") {
            activities.push("updates persistent storage");
        } else if upper.contains("REPORT") || upper.contains("PRINT") || upper.contains("DISPLAY") {
            activities.push("generates output");
        } else if upper.contains("INIT") || upper.contains("SETUP") || upper.contains("OPEN") {
            activities.push("initializes resources");
        } else if upper.contains("CLEAN") || upper.contains("CLOSE") || upper.contains("TERM") {
            activities.push("performs cleanup");
        } else if upper.contains("READ") || upper.contains("FETCH") || upper.contains("GET") {
            activities.push("retrieves data");
        } else if upper.contains("TRANSFER") || upper.contains("XFER") || upper.contains("SEND") {
            activities.push("transfers data to external systems");
        } else if upper.contains("ERROR") || upper.contains("ABORT") || upper.contains("EXCEPT") {
            activities.push("handles error conditions");
        }
    }

    // Deduplicate
    activities.sort();
    activities.dedup();

    let mut desc = format!("Program that {}", if activities.is_empty() {
        "performs business processing".to_string()
    } else {
        activities.join(", ")
    });

    if has_sql { desc.push_str(". Accesses database via embedded SQL"); }
    if has_cics { desc.push_str(". Interacts with CICS terminal screens"); }
    if has_calls { desc.push_str(". Delegates to external programs"); }

    desc
}

// ─── Build paragraph map ────────────────────────────────────────────

fn build_paragraph_map(output: &ParseOutput) -> Vec<(String, usize, usize)> {
    // Language-agnostic: treat any function-like boundary as a "paragraph"
    // COBOL: Paragraph, Section | RPG: Procedure, Subroutine | VB6: Function, Procedure
    // Delphi: Function, Procedure | PL/I: Procedure | etc.
    let mut paras: Vec<(String, usize)> = output.symbols.iter()
        .filter(|s| matches!(s.kind,
            SymbolKind::Paragraph | SymbolKind::Section | SymbolKind::Subroutine
            | SymbolKind::Procedure | SymbolKind::Function
        ) || matches!(&s.kind, SymbolKind::Custom(k) if
            k == "Class" || k == "Event" || k == "Window" || k == "Method"
            || k == "Package" || k == "Task" || k == "Module"
        ))
        .map(|s| (s.name.clone(), s.span.start_line))
        .collect();

    paras.sort_by_key(|(_, line)| *line);

    let total = output.total_lines;
    let mut result = Vec::new();
    for (i, (name, start)) in paras.iter().enumerate() {
        let end = if i + 1 < paras.len() { paras[i + 1].1.saturating_sub(1) } else { total };
        result.push((name.clone(), *start, end));
    }
    result
}

// ─── Build 88-level map ─────────────────────────────────────────────

fn build_88_level_map(output: &ParseOutput) -> HashMap<String, Vec<(String, String)>> {
    let mut map: HashMap<String, Vec<(String, String)>> = HashMap::new();

    // From metadata if available
    if let Some(conditions) = output.metadata.get("level_88_conditions") {
        if let Some(arr) = conditions.as_array() {
            for c in arr {
                if let (Some(name), Some(value), Some(parent)) = (
                    c.get("name").and_then(|v| v.as_str()),
                    c.get("value").and_then(|v| v.as_str()),
                    c.get("parent").and_then(|v| v.as_str()),
                ) {
                    map.entry(parent.to_uppercase())
                        .or_default()
                        .push((name.to_string(), value.to_string()));
                }
            }
        }
    }

    // Also scan symbols for Condition88 kinds
    let data_items: Vec<&Symbol> = output.symbols.iter()
        .filter(|s| matches!(s.kind, SymbolKind::DataItem | SymbolKind::Variable))
        .collect();

    for sym in &output.symbols {
        if let SymbolKind::Custom(ref kind) = sym.kind {
            if kind == "Condition88" {
                // Find the parent (previous data item at same or higher level)
                if let Some(parent) = data_items.iter().rev()
                    .find(|d| d.span.start_line < sym.span.start_line)
                {
                    let value = sym.properties.get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("").to_string();
                    map.entry(parent.name.to_uppercase())
                        .or_default()
                        .push((sym.name.clone(), value));
                }
            }
        }
    }

    map
}

// ─── Build functional requirement from paragraph ────────────────────

fn build_functional_requirement(
    idx: usize,
    para_name: &str,
    start: usize,
    end: usize,
    nodes: &[&AstNode],
    all_symbols: &[Symbol],
    _level_88: &HashMap<String, Vec<(String, String)>>,
    output: &ParseOutput,
) -> FunctionalRequirement {
    let mut rules = Vec::new();
    let mut calculations = Vec::new();
    let mut calls = Vec::new();
    let mut error_handling = Vec::new();
    let mut inputs = Vec::new();
    let mut outputs_list = Vec::new();

    for node in nodes {
        match &node.kind {
            AstNodeKind::IfStatement => {
                if let Some(cond) = node.properties.get("condition").and_then(|v| v.as_str()) {
                    let actions = derive_actions_after_if(node, nodes, output);
                    let desc = derive_condition_from_code(cond, &actions, all_symbols);

                    // Check if it's error handling
                    if actions.iter().any(|a| a.contains("RETURN-CODE") || a.contains("ERROR") || a.contains("MSG")) {
                        error_handling.push(desc.clone());
                    }

                    rules.push(DerivedRule {
                        condition_raw: cond.to_string(),
                        description: desc,
                        actions,
                    });
                }
            }
            AstNodeKind::EvaluateStatement => {
                if let Some(subject) = &node.name {
                    let desc = format!(
                        "Process based on {} value — each case triggers specific actions",
                        humanize_var(subject)
                    );
                    rules.push(DerivedRule {
                        condition_raw: subject.clone(),
                        description: desc,
                        actions: vec![format!("EVALUATE {}", subject)],
                    });
                }
            }
            AstNodeKind::ComputeStatement => {
                if let Some(expr) = node.properties.get("expr").and_then(|v| v.as_str()) {
                    let (target, formula) = split_assignment(expr);
                    let desc = describe_formula(&target, &formula);
                    let hardcoded = extract_literals(&formula);

                    outputs_list.push(humanize_var(&target));
                    // Derive inputs from formula variables
                    for var in extract_variables(&formula) {
                        if !inputs.contains(&var) { inputs.push(var); }
                    }

                    calculations.push(DerivedCalculation {
                        target: target.clone(),
                        formula_raw: expr.to_string(),
                        description: desc,
                        hardcoded,
                    });
                }
            }
            AstNodeKind::MoveStatement => {
                if let Some(expr) = node.properties.get("expr").and_then(|v| v.as_str()) {
                    // "SOURCE TO TARGET"
                    if let Some(to_idx) = expr.find(" TO ") {
                        let target = expr[to_idx + 4..].trim().trim_end_matches('.');
                        outputs_list.push(humanize_var(target));
                    }
                }
            }
            AstNodeKind::PerformStatement => {
                if let Some(target) = node.properties.get("target").and_then(|v| v.as_str()) {
                    calls.push(format!("PERFORM {}", target));
                }
                if let Some(name) = &node.name {
                    calls.push(format!("PERFORM {}", name));
                }
            }
            AstNodeKind::CallStatement => {
                if let Some(name) = &node.name {
                    calls.push(format!("CALL '{}'", name));
                }
            }
            AstNodeKind::ReadStatement => {
                if let Some(name) = &node.name {
                    inputs.push(format!("{} (file read)", humanize_var(name)));
                }
            }
            AstNodeKind::WriteStatement => {
                if let Some(name) = &node.name {
                    outputs_list.push(format!("{} (file write)", humanize_var(name)));
                }
            }
            AstNodeKind::ExecSqlBlock => {
                if let Some(sql) = node.properties.get("content").and_then(|v| v.as_str()) {
                    let upper = sql.to_uppercase();
                    if upper.contains("SELECT") { inputs.push("Database query result".to_string()); }
                    if upper.contains("INSERT") || upper.contains("UPDATE") || upper.contains("DELETE") {
                        outputs_list.push("Database modification".to_string());
                    }
                }
                calls.push("Embedded SQL".to_string());
            }
            _ => {}
        }
    }

    // Dedup
    inputs.sort(); inputs.dedup();
    outputs_list.sort(); outputs_list.dedup();
    calls.sort(); calls.dedup();

    // Generate paragraph description from its content
    let description = derive_paragraph_description(para_name, &rules, &calculations, &calls, &error_handling);

    FunctionalRequirement {
        id: format!("FR-{:03}", idx),
        name: humanize_paragraph(para_name),
        paragraph: para_name.to_string(),
        source_lines: (start, end),
        description,
        inputs,
        outputs: outputs_list,
        rules,
        calculations,
        error_handling,
        calls,
    }
}

// ─── Derive descriptions from code, not templates ───────────────────

fn derive_condition_from_code(cond: &str, actions: &[String], symbols: &[Symbol]) -> String {
    let upper = cond.to_uppercase();

    // For 88-level conditions, look up what value they represent
    let mut parts = Vec::new();
    for word in upper.split_whitespace() {
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
        if clean.starts_with("IS-") || clean.starts_with("NOT") {
            // Keep as-is for readability
            parts.push(humanize_var(clean));
        } else if clean.len() > 2 && clean.contains('-') {
            parts.push(humanize_var(clean));
        } else {
            parts.push(clean.to_lowercase());
        }
    }

    let readable_cond = parts.join(" ");

    // Describe what happens when condition is true (from actions)
    if actions.is_empty() {
        return format!("When {}", readable_cond);
    }

    let action_summary = summarize_actions(actions, symbols);
    format!("When {}: {}", readable_cond, action_summary)
}

fn summarize_actions(actions: &[String], _symbols: &[Symbol]) -> String {
    let mut summaries = Vec::new();
    for action in actions {
        let upper = action.to_uppercase();
        if upper.contains("MOVE") && upper.contains("TO") && upper.contains("MSG") {
            // Extract the message string if quoted
            if let Some(start) = action.find('\'') {
                if let Some(end) = action[start+1..].find('\'') {
                    let msg = &action[start+1..start+1+end];
                    summaries.push(format!("set message to '{}'", msg));
                    continue;
                }
            }
            summaries.push("set error message".to_string());
        } else if upper.contains("RETURN-CODE") || upper.contains("RETURN CODE") {
            // Extract the return code value
            for word in upper.split_whitespace() {
                if let Ok(code) = word.parse::<i32>() {
                    if code > 0 {
                        summaries.push(format!("set return code to {} (error)", code));
                    }
                }
            }
        } else if upper.contains("ADD") || upper.contains("SUBTRACT") || upper.contains("COMPUTE") {
            summaries.push("update calculated value".to_string());
        } else if upper.contains("PERFORM") {
            let target = upper.replace("PERFORM ", "");
            summaries.push(format!("execute {}", humanize_var(target.trim())));
        }
    }

    if summaries.is_empty() {
        "execute conditional logic".to_string()
    } else {
        summaries.join(", ")
    }
}

fn derive_actions_after_if(node: &AstNode, all_nodes: &[&AstNode], output: &ParseOutput) -> Vec<String> {
    let mut actions = Vec::new();
    let start = node.span.start_line;
    let end = start + 10; // Look at next ~10 lines

    for line in output.source_path.lines().take(0) { let _ = line; } // noop

    // Look for MOVE/COMPUTE/PERFORM/CALL nodes right after this IF
    for n in all_nodes {
        if n.span.start_line > start && n.span.start_line <= end {
            match &n.kind {
                AstNodeKind::MoveStatement => {
                    if let Some(expr) = n.properties.get("expr").and_then(|v| v.as_str()) {
                        actions.push(format!("MOVE {}", expr));
                    }
                }
                AstNodeKind::ComputeStatement => {
                    if let Some(expr) = n.properties.get("expr").and_then(|v| v.as_str()) {
                        actions.push(format!("COMPUTE {}", expr));
                    }
                }
                AstNodeKind::PerformStatement => {
                    if let Some(target) = n.properties.get("target").and_then(|v| v.as_str()) {
                        actions.push(format!("PERFORM {}", target));
                    }
                }
                AstNodeKind::IfStatement => break, // Next condition = stop
                _ => {}
            }
        }
    }

    actions
}

fn derive_paragraph_description(
    name: &str,
    rules: &[DerivedRule],
    calcs: &[DerivedCalculation],
    calls: &[String],
    errors: &[String],
) -> String {
    let mut parts = Vec::new();

    if !rules.is_empty() {
        parts.push(format!("Applies {} business rule{}", rules.len(), if rules.len() > 1 { "s" } else { "" }));
    }
    if !calcs.is_empty() {
        parts.push(format!("performs {} calculation{}", calcs.len(), if calcs.len() > 1 { "s" } else { "" }));
    }
    let ext_calls: Vec<&String> = calls.iter().filter(|c| c.starts_with("CALL") || c.contains("SQL")).collect();
    if !ext_calls.is_empty() {
        parts.push(format!("interfaces with {} external system{}", ext_calls.len(), if ext_calls.len() > 1 { "s" } else { "" }));
    }
    if !errors.is_empty() {
        parts.push("includes error handling".to_string());
    }

    if parts.is_empty() {
        format!("{} processing step", humanize_paragraph(name))
    } else {
        format!("{}: {}", humanize_paragraph(name), parts.join(", "))
    }
}

fn describe_formula(target: &str, formula: &str) -> String {
    let target_h = humanize_var(target);
    let vars = extract_variables(formula);
    let literals = extract_literals(formula);

    let var_names: Vec<String> = vars.iter().map(|v| humanize_var(v)).collect();

    if var_names.is_empty() && !literals.is_empty() {
        return format!("Set {} to {}", target_h, literals.join(" "));
    }

    // Build formula description from components
    let formula_parts: Vec<String> = formula.split(|c: char| c == '*' || c == '/' || c == '+' || c == '-')
        .map(|p| {
            let t = p.trim();
            if t.parse::<f64>().is_ok() {
                t.to_string()
            } else {
                humanize_var(t)
            }
        })
        .collect();

    // Reconstruct with operators
    let ops: Vec<char> = formula.chars().filter(|c| "*/-+".contains(*c)).collect();
    let mut desc = formula_parts[0].clone();
    for (i, op) in ops.iter().enumerate() {
        let op_word = match op {
            '*' => "multiplied by",
            '/' => "divided by",
            '+' => "plus",
            '-' => "minus",
            _ => "?",
        };
        if i + 1 < formula_parts.len() {
            desc = format!("{} {} {}", desc, op_word, formula_parts[i + 1]);
        }
    }

    format!("{} = {}", target_h, desc)
}

// ─── Build data dictionary ──────────────────────────────────────────

fn build_data_dictionary(
    symbols: &[Symbol],
    level_88: &HashMap<String, Vec<(String, String)>>,
) -> Vec<DataField> {
    let mut fields = Vec::new();

    for sym in symbols {
        match &sym.kind {
            SymbolKind::DataItem | SymbolKind::Variable => {
                if sym.name == "FILLER" { continue; }

                let level = sym.properties.get("level")
                    .and_then(|v| v.as_str())
                    .unwrap_or("05").to_string();

                let pic = sym.data_type.clone().unwrap_or_default();

                // Get 88-level values if any
                let values: Vec<String> = level_88.get(&sym.name.to_uppercase())
                    .map(|v| v.iter().map(|(n, val)| format!("{} = '{}'", n, val)).collect())
                    .unwrap_or_default();

                let description = derive_field_description(&sym.name, &pic, &values);

                let parent = if level != "01" && level != "77" {
                    // Find parent (previous 01-level)
                    symbols.iter()
                        .filter(|s| s.span.start_line < sym.span.start_line)
                        .filter(|s| s.properties.get("level").and_then(|v| v.as_str()) == Some("01"))
                        .last()
                        .map(|s| s.name.clone())
                } else {
                    None
                };

                fields.push(DataField {
                    name: sym.name.clone(),
                    level,
                    pic,
                    description,
                    values,
                    group_parent: parent,
                });
            }
            _ => {}
        }
    }

    fields
}

fn derive_field_description(name: &str, pic: &str, values: &[String]) -> String {
    let mut desc = humanize_var(name);

    // Add type info from PIC
    if !pic.is_empty() {
        let upper_pic = pic.to_uppercase();
        if upper_pic.contains("X(") {
            desc = format!("{} (text)", desc);
        } else if upper_pic.contains("9(") && upper_pic.contains("V") {
            desc = format!("{} (decimal number)", desc);
        } else if upper_pic.contains("9(") {
            desc = format!("{} (integer)", desc);
        } else if upper_pic.contains("S9") {
            desc = format!("{} (signed number)", desc);
        }
    }

    // Add valid values from 88-levels
    if !values.is_empty() {
        desc = format!("{}. Valid states: {}", desc, values.join(", "));
    }

    desc
}

// ─── Extract integration points ─────────────────────────────────────

fn extract_integrations(output: &ParseOutput) -> IntegrationPoints {
    let mut db_tables = Vec::new();
    let mut ext_programs = Vec::new();
    let mut cics_maps = Vec::new();
    let mut copybooks = Vec::new();
    let mut files = Vec::new();

    for block in &output.embedded_blocks {
        let upper = block.content.to_uppercase();
        if matches!(block.block_type, EmbeddedBlockType::ExecSql) {
            let op = if upper.contains("SELECT") { "SELECT" }
                else if upper.contains("INSERT") { "INSERT" }
                else if upper.contains("UPDATE") { "UPDATE" }
                else if upper.contains("DELETE") { "DELETE" }
                else { "SQL" };

            // Extract table names after FROM/INTO/UPDATE
            let tables = extract_sql_tables(&upper);
            let fields = extract_sql_fields(&upper);

            for table in tables {
                db_tables.push(DatabaseRef {
                    table,
                    operation: op.to_string(),
                    fields: fields.clone(),
                });
            }
        }
        if matches!(block.block_type, EmbeddedBlockType::ExecCics) {
            if upper.contains("MAP(") || upper.contains("MAP (") {
                if let Some(map) = extract_paren_value(&upper, "MAP") {
                    cics_maps.push(map);
                }
            }
        }
    }

    for node in &output.ast_nodes {
        if matches!(node.kind, AstNodeKind::CallStatement) {
            if let Some(name) = &node.name {
                if !ext_programs.contains(name) { ext_programs.push(name.clone()); }
            }
        }
        if matches!(node.kind, AstNodeKind::CopyStatement) {
            if let Some(name) = &node.name {
                if !copybooks.contains(name) { copybooks.push(name.clone()); }
            }
        }
        if matches!(node.kind, AstNodeKind::ReadStatement | AstNodeKind::WriteStatement) {
            if let Some(name) = &node.name {
                if !files.contains(name) { files.push(name.clone()); }
            }
        }
    }

    IntegrationPoints { database_tables: db_tables, external_programs: ext_programs, cics_maps, copybooks, files }
}

// ─── Build process flow ─────────────────────────────────────────────

fn build_process_flow(output: &ParseOutput, paragraphs: &[(String, usize, usize)]) -> Vec<FlowStep> {
    if paragraphs.is_empty() { return vec![]; }

    let mut steps = Vec::new();
    let first_para = &paragraphs[0];
    let first_end = first_para.2;

    // Get PERFORM targets from the first paragraph
    let mut seq = 0;
    steps.push(FlowStep {
        sequence: { seq += 1; seq },
        paragraph: first_para.0.clone(),
        calls_to: vec![],
        is_conditional: false,
    });

    for node in &output.ast_nodes {
        if node.span.start_line > first_end { break; }
        if node.span.start_line < first_para.1 { continue; }

        if matches!(node.kind, AstNodeKind::PerformStatement) {
            let target = node.properties.get("target").and_then(|v| v.as_str())
                .or(node.name.as_deref())
                .unwrap_or("?");

            let is_cond = node.properties.get("has_until").and_then(|v| v.as_bool()).unwrap_or(false);

            steps.push(FlowStep {
                sequence: { seq += 1; seq },
                paragraph: target.to_string(),
                calls_to: vec![],
                is_conditional: is_cond,
            });
        }
    }

    steps
}

// ─── Utility helpers ────────────────────────────────────────────────

fn nodes_in_range<'a>(nodes: &'a [AstNode], start: usize, end: usize) -> Vec<&'a AstNode> {
    nodes.iter().filter(|n| n.span.start_line >= start && n.span.start_line <= end).collect()
}

/// Alias for shared humanize — requirements module historically called this `humanize_var`.
fn humanize_var(name: &str) -> String {
    humanize(name)
}

fn humanize_paragraph(name: &str) -> String {
    // Remove numeric prefix: "1000-INIT" → "Init", "0000-MAIN" → "Main"
    let stripped = name.trim_start_matches(|c: char| c.is_numeric() || c == '-');
    if stripped.is_empty() { return name.to_string(); }
    let lower = stripped.replace('-', " ").to_lowercase();
    let mut chars = lower.chars();
    match chars.next() {
        None => lower,
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

fn split_assignment(expr: &str) -> (String, String) {
    if let Some(eq) = expr.find('=') {
        (expr[..eq].trim().to_string(), expr[eq+1..].trim().to_string())
    } else {
        (expr.to_string(), String::new())
    }
}

fn extract_variables(formula: &str) -> Vec<String> {
    let mut vars = Vec::new();
    for token in formula.split(|c: char| c == '*' || c == '/' || c == '+' || c == '-' || c == '(' || c == ')') {
        let t = token.trim();
        if t.parse::<f64>().is_err() && t.len() > 1 && t.contains('-') {
            vars.push(t.to_string());
        }
    }
    vars
}

fn extract_literals(formula: &str) -> Vec<String> {
    let mut lits = Vec::new();
    for token in formula.split(|c: char| c == '*' || c == '/' || c == '+' || c == '-' || c == '(' || c == ')') {
        let t = token.trim();
        if let Ok(val) = t.parse::<f64>() {
            if val != 0.0 && val != 1.0 {
                lits.push(t.to_string());
            }
        }
    }
    lits
}

fn extract_sql_tables(sql: &str) -> Vec<String> {
    let mut tables = Vec::new();
    for keyword in &["FROM ", "INTO ", "UPDATE ", "JOIN "] {
        if let Some(pos) = sql.find(keyword) {
            let after = &sql[pos + keyword.len()..];
            let table = after.split(|c: char| c.is_whitespace() || c == '(' || c == ',')
                .next().unwrap_or("").trim();
            if !table.is_empty() && table.len() < 30 && !table.starts_with(':') && !table.starts_with('(') {
                if !tables.contains(&table.to_string()) {
                    tables.push(table.to_string());
                }
            }
        }
    }
    tables
}

fn extract_sql_fields(sql: &str) -> Vec<String> {
    let mut fields = Vec::new();
    for token in sql.split(|c: char| c == ',' || c == '=' || c.is_whitespace()) {
        let t = token.trim().trim_start_matches(':');
        if t.contains('-') && t.len() > 2 && t.len() < 30 {
            fields.push(t.to_string());
        }
    }
    fields
}

fn extract_paren_value(text: &str, keyword: &str) -> Option<String> {
    let pattern = format!("{}(", keyword);
    let alt_pattern = format!("{} (", keyword);
    let search = if text.contains(&pattern) { &pattern } else { &alt_pattern };
    if let Some(pos) = text.find(search.as_str()) {
        let after = &text[pos + search.len()..];
        if let Some(end) = after.find(')') {
            return Some(after[..end].trim().trim_matches('\'').to_string());
        }
    }
    None
}
