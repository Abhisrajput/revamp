//! Data lineage tracking — traces where variables/fields get SET vs READ
//! across the codebase.

use crate::parser::nir::{AstNodeKind, ParseOutput, SymbolKind};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct DataLineageReport {
    pub fields: Vec<FieldLineage>,
    pub total_fields_tracked: usize,
    pub fields_write_only: usize,
    pub fields_read_only: usize,
    pub fields_read_write: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldLineage {
    pub name: String,
    pub defined_in: String,
    pub defined_line: usize,
    pub writes: Vec<FieldAccess>,
    pub reads: Vec<FieldAccess>,
    pub access_pattern: String, // "read-only", "write-only", "read-write", "unused"
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldAccess {
    pub file: String,
    pub line: usize,
    pub context: String, // "MOVE TO", "COMPUTE", "READ INTO", "IF condition", etc.
}

/// Build data lineage from parsed outputs.
pub fn trace_lineage(outputs: &[&ParseOutput]) -> DataLineageReport {
    let mut field_defs: HashMap<String, (String, usize)> = HashMap::new();
    let mut field_writes: HashMap<String, Vec<FieldAccess>> = HashMap::new();
    let mut field_reads: HashMap<String, Vec<FieldAccess>> = HashMap::new();

    for output in outputs {
        // Collect field definitions
        for sym in &output.symbols {
            if matches!(sym.kind, SymbolKind::Variable | SymbolKind::DataItem) {
                if sym.name != "FILLER" && !sym.name.is_empty() {
                    field_defs.entry(sym.name.to_uppercase()).or_insert((
                        output.source_path.clone(),
                        sym.span.start_line,
                    ));
                }
            }
        }

        // Track writes and reads from AST nodes
        for node in &output.ast_nodes {
            match &node.kind {
                AstNodeKind::MoveStatement => {
                    // MOVE X TO Y — Y is written, X is read
                    if let Some(expr) = node.properties.get("expr").and_then(|v| v.as_str()) {
                        let parts: Vec<&str> = expr.split(" TO ").collect();
                        if parts.len() == 2 {
                            // Source is read
                            for word in parts[0].split_whitespace() {
                                let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
                                if clean.len() > 1 {
                                    field_reads.entry(clean.to_uppercase()).or_default().push(FieldAccess {
                                        file: output.source_path.clone(),
                                        line: node.span.start_line,
                                        context: "MOVE (source)".to_string(),
                                    });
                                }
                            }
                            // Target is written
                            for word in parts[1].split_whitespace() {
                                let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
                                if clean.len() > 1 {
                                    field_writes.entry(clean.to_uppercase()).or_default().push(FieldAccess {
                                        file: output.source_path.clone(),
                                        line: node.span.start_line,
                                        context: "MOVE TO (target)".to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
                AstNodeKind::ComputeStatement => {
                    if let Some(expr) = node.properties.get("expr").and_then(|v| v.as_str()) {
                        let parts: Vec<&str> = expr.splitn(2, '=').collect();
                        if parts.len() == 2 {
                            let target = parts[0].trim();
                            if target.len() > 1 {
                                field_writes.entry(target.to_uppercase()).or_default().push(FieldAccess {
                                    file: output.source_path.clone(),
                                    line: node.span.start_line,
                                    context: "COMPUTE (target)".to_string(),
                                });
                            }
                            for word in parts[1].split_whitespace() {
                                let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
                                if clean.len() > 1 && !clean.chars().all(|c| c.is_ascii_digit()) {
                                    field_reads.entry(clean.to_uppercase()).or_default().push(FieldAccess {
                                        file: output.source_path.clone(),
                                        line: node.span.start_line,
                                        context: "COMPUTE (expression)".to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
                AstNodeKind::IfStatement => {
                    if let Some(cond) = node.properties.get("condition").and_then(|v| v.as_str()) {
                        for word in cond.split_whitespace() {
                            let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
                            if clean.len() > 1 && !clean.chars().all(|c| c.is_ascii_digit())
                                && !["AND", "OR", "NOT", "EQUAL", "GREATER", "LESS", "THAN", "TO", "IS", "IF", "OF"].contains(&clean) {
                                field_reads.entry(clean.to_uppercase()).or_default().push(FieldAccess {
                                    file: output.source_path.clone(),
                                    line: node.span.start_line,
                                    context: "IF condition".to_string(),
                                });
                            }
                        }
                    }
                }
                AstNodeKind::ReadStatement => {
                    // READ implicitly writes to the record area
                    if let Some(name) = &node.name {
                        field_writes.entry(name.to_uppercase()).or_default().push(FieldAccess {
                            file: output.source_path.clone(),
                            line: node.span.start_line,
                            context: "READ (file input)".to_string(),
                        });
                    }
                }
                AstNodeKind::WriteStatement => {
                    if let Some(name) = &node.name {
                        field_reads.entry(name.to_uppercase()).or_default().push(FieldAccess {
                            file: output.source_path.clone(),
                            line: node.span.start_line,
                            context: "WRITE (file output)".to_string(),
                        });
                    }
                }
                AstNodeKind::Assignment => {
                    // Generic assignment (RPG EVAL, etc.)
                    if let Some(name) = &node.name {
                        field_writes.entry(name.to_uppercase()).or_default().push(FieldAccess {
                            file: output.source_path.clone(),
                            line: node.span.start_line,
                            context: "assignment".to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
    }

    // Build lineage entries
    let mut fields: Vec<FieldLineage> = field_defs.iter().map(|(name, (file, line))| {
        let writes = field_writes.get(name).cloned().unwrap_or_default();
        let reads = field_reads.get(name).cloned().unwrap_or_default();
        let pattern = match (writes.is_empty(), reads.is_empty()) {
            (true, true) => "unused",
            (false, true) => "write-only",
            (true, false) => "read-only",
            (false, false) => "read-write",
        };
        FieldLineage {
            name: name.clone(),
            defined_in: file.clone(),
            defined_line: *line,
            writes,
            reads,
            access_pattern: pattern.to_string(),
        }
    }).collect();

    fields.sort_by(|a, b| a.name.cmp(&b.name));

    let write_only = fields.iter().filter(|f| f.access_pattern == "write-only").count();
    let read_only = fields.iter().filter(|f| f.access_pattern == "read-only").count();
    let read_write = fields.iter().filter(|f| f.access_pattern == "read-write").count();

    DataLineageReport {
        total_fields_tracked: fields.len(),
        fields_write_only: write_only,
        fields_read_only: read_only,
        fields_read_write: read_write,
        fields,
    }
}
