//! Dead code detection — finds unreachable paragraphs, unused variables,
//! and orphaned copybooks across a parsed codebase.

use crate::parser::nir::{AstNodeKind, ParseOutput, SymbolKind, Visibility};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
pub struct DeadCodeReport {
    pub unreachable_paragraphs: Vec<DeadSymbol>,
    pub unused_variables: Vec<DeadSymbol>,
    pub unused_copybooks: Vec<String>,
    pub dead_code_lines: usize,
    pub total_lines: usize,
    pub dead_code_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeadSymbol {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: usize,
    pub confidence: f64,
}

/// Analyze parsed outputs for dead code across all files.
pub fn detect_dead_code(outputs: &[&ParseOutput]) -> DeadCodeReport {
    let mut all_paragraphs: HashMap<String, (String, usize)> = HashMap::new(); // name → (file, line)
    let mut called_paragraphs: HashSet<String> = HashSet::new();
    let mut all_variables: HashMap<String, (String, usize)> = HashMap::new();
    let mut used_variables: HashSet<String> = HashSet::new();
    let mut all_copies: HashSet<String> = HashSet::new();
    let mut resolved_copies: HashSet<String> = HashSet::new();
    let mut total_lines = 0;

    for output in outputs {
        total_lines += output.total_lines;

        // Collect paragraph/subroutine definitions
        for sym in &output.symbols {
            match &sym.kind {
                SymbolKind::Paragraph | SymbolKind::Subroutine | SymbolKind::Section
                | SymbolKind::Procedure | SymbolKind::Function => {
                    all_paragraphs.insert(
                        sym.name.to_uppercase(),
                        (output.source_path.clone(), sym.span.start_line),
                    );
                }
                SymbolKind::Variable | SymbolKind::DataItem => {
                    if sym.name != "FILLER" && !sym.name.is_empty() {
                        all_variables.insert(
                            sym.name.to_uppercase(),
                            (output.source_path.clone(), sym.span.start_line),
                        );
                    }
                }
                _ => {}
            }
        }

        // Collect PERFORM/CALL/EXSR targets (these are "used" paragraphs)
        for node in &output.ast_nodes {
            match &node.kind {
                AstNodeKind::PerformStatement => {
                    if let Some(target) = node.properties.get("target").and_then(|v| v.as_str()) {
                        called_paragraphs.insert(target.to_uppercase());
                    }
                    if let Some(from) = node.properties.get("from").and_then(|v| v.as_str()) {
                        called_paragraphs.insert(from.to_uppercase());
                    }
                    if let Some(thru) = node.properties.get("thru").and_then(|v| v.as_str()) {
                        called_paragraphs.insert(thru.to_uppercase());
                    }
                    if let Some(name) = &node.name {
                        called_paragraphs.insert(name.to_uppercase());
                    }
                }
                AstNodeKind::CallStatement => {
                    if let Some(name) = &node.name {
                        called_paragraphs.insert(name.to_uppercase());
                    }
                }
                AstNodeKind::GoToStatement => {
                    if let Some(name) = &node.name {
                        called_paragraphs.insert(name.to_uppercase());
                    }
                }
                AstNodeKind::CopyStatement => {
                    if let Some(name) = &node.name {
                        all_copies.insert(name.to_uppercase());
                    }
                }
                _ => {}
            }

            // Track variable usage in expressions
            if let Some(expr) = node.properties.get("expr").and_then(|v| v.as_str()) {
                for word in expr.split_whitespace() {
                    let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
                    if clean.len() > 1 {
                        used_variables.insert(clean.to_uppercase());
                    }
                }
            }
        }
    }

    // Entry points that are always "called" (any language)
    // COBOL: MAIN, MAIN-PARA | RPG: *INZSR, main | VB6: Main, Form_Load
    let entry_patterns = [
        "MAIN", "MAIN-PARA", "MAIN-PARAGRAPH", "MAINLINE",
        "*INZSR",                             // RPG initialization subroutine
        "FORM_LOAD", "CLASS_INITIALIZE",      // VB6 entry points
        "MAIN()", "SUB MAIN",                 // VB.NET
        "PROGRAM",                            // Fortran
    ];
    for p in &entry_patterns {
        called_paragraphs.insert(p.to_string());
    }
    // The first function/paragraph in each file is always reachable
    for output in outputs {
        if let Some(first_para) = output.symbols.iter().find(|s|
            matches!(s.kind, SymbolKind::Paragraph | SymbolKind::Section
                | SymbolKind::Procedure | SymbolKind::Function | SymbolKind::Subroutine)
        ) {
            called_paragraphs.insert(first_para.name.to_uppercase());
        }
    }
    // VB6/VB.NET: event handlers (Sub xxx_Click, Sub xxx_Load) are entry points
    for name in all_paragraphs.keys() {
        if name.contains("_CLICK") || name.contains("_LOAD") || name.contains("_CHANGE")
            || name.contains("_SUBMIT") || name.contains("_INIT") || name.contains("_OPEN")
            || name.contains("_CLOSE") || name.contains("_TIMER") {
            called_paragraphs.insert(name.clone());
        }
    }
    // COBOL sections and EXIT paragraphs are reachable
    for name in all_paragraphs.keys() {
        if name.ends_with("-SECTION") || name.ends_with("SECTION")
            || name.ends_with("-EXIT") || name == "EXIT" {
            called_paragraphs.insert(name.clone());
        }
    }
    // RPG: exported procedures are always reachable
    for sym in outputs.iter().flat_map(|o| o.symbols.iter()) {
        if matches!(sym.visibility, Visibility::Public) &&
            matches!(sym.kind, SymbolKind::Procedure | SymbolKind::Function) {
            called_paragraphs.insert(sym.name.to_uppercase());
        }
    }

    // Find unreachable paragraphs
    let unreachable: Vec<DeadSymbol> = all_paragraphs.iter()
        .filter(|(name, _)| !called_paragraphs.contains(name.as_str()))
        .map(|(name, (file, line))| DeadSymbol {
            name: name.clone(),
            kind: "paragraph".to_string(),
            file: file.clone(),
            line: *line,
            confidence: 0.7, // Could be called via ALTER or dynamic dispatch
        })
        .collect();

    // Find unused variables (lower confidence — variables may be referenced via REDEFINES)
    let unused_vars: Vec<DeadSymbol> = all_variables.iter()
        .filter(|(name, _)| !used_variables.contains(name.as_str()))
        .map(|(name, (file, line))| DeadSymbol {
            name: name.clone(),
            kind: "variable".to_string(),
            file: file.clone(),
            line: *line,
            confidence: 0.5, // May be used via REDEFINES, copybooks, or dynamic reference
        })
        .collect();

    // Estimate dead lines from average paragraph size instead of a fixed constant.
    let avg_para_size = if all_paragraphs.is_empty() {
        5
    } else {
        total_lines / all_paragraphs.len().max(1)
    };
    let dead_lines = unreachable.len() * avg_para_size + unused_vars.len();
    let dead_pct = if total_lines > 0 { dead_lines as f64 / total_lines as f64 } else { 0.0 };

    DeadCodeReport {
        unreachable_paragraphs: unreachable,
        unused_variables: unused_vars,
        unused_copybooks: vec![], // Would need resolver data
        dead_code_lines: dead_lines,
        total_lines,
        dead_code_pct: dead_pct,
    }
}
