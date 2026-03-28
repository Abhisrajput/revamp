//! Cyclomatic complexity analysis — measures decision complexity
//! per function/paragraph/procedure across all parsed files.
//!
//! Complexity = number of decision points + 1
//! Decision points: IF, EVALUATE/WHEN, PERFORM UNTIL, ON ERROR, exception handlers

use crate::parser::nir::{AstNodeKind, ParseOutput, SymbolKind};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ComplexityReport {
    pub functions: Vec<FunctionComplexity>,
    pub average_complexity: f64,
    pub max_complexity: u32,
    pub high_complexity_count: usize,  // > 10
    pub critical_complexity_count: usize, // > 20
    pub total_decision_points: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct FunctionComplexity {
    pub name: String,
    pub file: String,
    pub language: String,
    pub line: usize,
    pub complexity: u32,
    pub decision_points: u32,
    pub risk: &'static str,
}

fn risk_level(complexity: u32) -> &'static str {
    match complexity {
        0..=5 => "low",
        6..=10 => "moderate",
        11..=20 => "high",
        _ => "critical",
    }
}

/// Calculate cyclomatic complexity for all functions/paragraphs in parsed outputs.
pub fn analyze_complexity(outputs: &[&ParseOutput]) -> ComplexityReport {
    let mut functions = Vec::new();

    for output in outputs {
        // Collect function/paragraph boundaries
        let mut boundaries: Vec<(String, usize)> = Vec::new();
        for sym in &output.symbols {
            match &sym.kind {
                SymbolKind::Paragraph | SymbolKind::Subroutine | SymbolKind::Procedure
                | SymbolKind::Function => {
                    boundaries.push((sym.name.clone(), sym.span.start_line));
                }
                _ => {}
            }
        }

        if boundaries.is_empty() {
            // Treat entire file as one unit
            let decisions = count_decisions(&output.ast_nodes, 0, output.total_lines);
            functions.push(FunctionComplexity {
                name: output.source_path.rsplit('/').next().unwrap_or("main").to_string(),
                file: output.source_path.clone(),
                language: output.language_id.clone(),
                line: 0,
                complexity: decisions + 1,
                decision_points: decisions,
                risk: risk_level(decisions + 1),
            });
        } else {
            // Calculate per function/paragraph
            for (idx, (name, start_line)) in boundaries.iter().enumerate() {
                let end_line = boundaries.get(idx + 1)
                    .map(|(_, l)| *l)
                    .unwrap_or(output.total_lines);

                let decisions = count_decisions(&output.ast_nodes, *start_line, end_line);
                let complexity = decisions + 1;

                functions.push(FunctionComplexity {
                    name: name.clone(),
                    file: output.source_path.clone(),
                    language: output.language_id.clone(),
                    line: *start_line,
                    complexity,
                    decision_points: decisions,
                    risk: risk_level(complexity),
                });
            }
        }
    }

    functions.sort_by(|a, b| b.complexity.cmp(&a.complexity));

    let total_decision: u32 = functions.iter().map(|f| f.decision_points).sum();
    let avg = if functions.is_empty() { 0.0 } else {
        functions.iter().map(|f| f.complexity as f64).sum::<f64>() / functions.len() as f64
    };
    let max = functions.iter().map(|f| f.complexity).max().unwrap_or(0);
    let high = functions.iter().filter(|f| f.complexity > 10).count();
    let critical = functions.iter().filter(|f| f.complexity > 20).count();

    ComplexityReport {
        functions,
        average_complexity: avg,
        max_complexity: max,
        high_complexity_count: high,
        critical_complexity_count: critical,
        total_decision_points: total_decision,
    }
}

fn count_decisions(nodes: &[crate::parser::nir::AstNode], start: usize, end: usize) -> u32 {
    let mut count = 0u32;
    for node in nodes {
        if node.span.start_line < start || node.span.start_line >= end { continue; }
        match &node.kind {
            AstNodeKind::IfStatement => count += 1,
            AstNodeKind::EvaluateStatement => {
                // Each WHEN branch is a decision point. Use stored when_count
                // if available, otherwise default to 3 (typical EVALUATE has 3-5 branches).
                let branches = node.properties.get("when_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(3) as u32;
                count += branches;
            }
            AstNodeKind::PerformStatement => {
                // PERFORM UNTIL/VARYING add a decision
                if node.properties.contains_key("until") || node.properties.contains_key("times") {
                    count += 1;
                }
            }
            AstNodeKind::GoToStatement => count += 1,
            AstNodeKind::Custom(s) if s == "OnError" || s == "ExceptionHandler" => count += 1,
            _ => {}
        }
    }
    count
}
