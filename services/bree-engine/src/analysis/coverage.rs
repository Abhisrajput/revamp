//! Actual NIR coverage — computed from real parse results, not estimates.
//!
//! Measures what percentage of source lines the parser actually understood
//! (produced an AST node, symbol, or embedded block) vs. skipped.

use crate::parser::nir::ParseOutput;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub struct CoverageReport {
    pub file_coverages: Vec<FileCoverage>,
    pub overall: OverallCoverage,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileCoverage {
    pub file: String,
    pub language: String,
    pub total_lines: usize,
    pub blank_comment_lines: usize,
    pub meaningful_lines: usize,
    pub covered_lines: usize,
    pub skipped_lines: usize,
    pub coverage_pct: f64,
    pub skipped_samples: Vec<String>, // First few skipped lines for debugging
}

#[derive(Debug, Clone, Serialize)]
pub struct OverallCoverage {
    pub total_files: usize,
    pub total_meaningful_lines: usize,
    pub total_covered_lines: usize,
    pub actual_coverage_pct: f64,
}

/// Compute actual NIR coverage for a single parsed file.
pub fn compute_file_coverage(output: &ParseOutput, content: &str) -> FileCoverage {
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    if total_lines == 0 {
        return FileCoverage {
            file: output.source_path.clone(),
            language: output.language_id.clone(),
            total_lines: 0, blank_comment_lines: 0, meaningful_lines: 0,
            covered_lines: 0, skipped_lines: 0, coverage_pct: 0.0,
            skipped_samples: vec![],
        };
    }

    // Count blank and comment lines (language-aware)
    let lang = output.language_id.as_str();
    let mut blank_comment = HashSet::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let line_num = i + 1; // 1-based to match spans

        if trimmed.is_empty() {
            blank_comment.insert(line_num);
            continue;
        }

        let is_comment = match lang {
            "cobol" => {
                // COBOL: column 7 indicator = * or /
                (line.len() > 6 && (line.as_bytes().get(6) == Some(&b'*') || line.as_bytes().get(6) == Some(&b'/')))
                || trimmed.starts_with('*')
            }
            "rpg" => {
                // RPG fixed: column 7 = *, RPG free: //
                trimmed.starts_with("//") || (line.len() > 6 && line.as_bytes().get(6) == Some(&b'*'))
            }
            "cl" => trimmed.starts_with("/*"),
            "jcl" => trimmed.starts_with("//*"),
            "pli" => trimmed.starts_with("/*"),
            "vb6" | "vbnet-legacy" | "asp-classic" | "lotusscript" => trimmed.starts_with('\''),
            "delphi" => trimmed.starts_with("//") || trimmed.starts_with('{') || trimmed.starts_with("(*"),
            "fortran" => {
                let first = trimmed.chars().next().unwrap_or(' ');
                first == 'C' || first == 'c' || first == '!' || trimmed.starts_with("!")
            }
            "ada" => trimmed.starts_with("--"),
            "plsql" | "tsql" | "db2sql" => trimmed.starts_with("--"),
            "perl" | "rexx" => trimmed.starts_with('#'),
            "coldfusion" => trimmed.starts_with("<!---"),
            "mumps" => trimmed.starts_with(';'),
            "abap" => trimmed.starts_with('*') || trimmed.starts_with('"'),
            "natural" => trimmed.starts_with('*'),
            "sas" => trimmed.starts_with('*') || trimmed.starts_with("/*"),
            _ => trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("--"),
        };

        if is_comment {
            blank_comment.insert(line_num);
        }
    }

    let blank_comment_count = blank_comment.len();
    let meaningful_lines = total_lines - blank_comment_count;

    if meaningful_lines == 0 {
        return FileCoverage {
            file: output.source_path.clone(),
            language: output.language_id.clone(),
            total_lines, blank_comment_lines: blank_comment_count, meaningful_lines: 0,
            covered_lines: 0, skipped_lines: 0, coverage_pct: 1.0,
            skipped_samples: vec![],
        };
    }

    // Build set of covered line numbers from AST nodes, symbols, and embedded blocks
    let mut covered: HashSet<usize> = HashSet::new();

    for node in &output.ast_nodes {
        for line in node.span.start_line..=node.span.end_line {
            if line > 0 && line <= total_lines {
                covered.insert(line);
            }
        }
    }

    for sym in &output.symbols {
        for line in sym.span.start_line..=sym.span.end_line {
            if line > 0 && line <= total_lines {
                covered.insert(line);
            }
        }
    }

    for block in &output.embedded_blocks {
        for line in block.span.start_line..=block.span.end_line {
            if line > 0 && line <= total_lines {
                covered.insert(line);
            }
        }
    }

    // Only count coverage of meaningful (non-blank, non-comment) lines
    let covered_meaningful = covered.iter()
        .filter(|l| !blank_comment.contains(l))
        .count();

    let skipped = meaningful_lines.saturating_sub(covered_meaningful);

    // Collect samples of skipped lines for debugging
    let mut skipped_samples: Vec<String> = Vec::new();
    for line_num in 1..=total_lines {
        if !blank_comment.contains(&line_num) && !covered.contains(&line_num) {
            if skipped_samples.len() < 5 {
                let text = lines.get(line_num.saturating_sub(1)).unwrap_or(&"");
                skipped_samples.push(format!("L{}: {}", line_num, text.trim()));
            }
        }
    }

    let coverage_pct = covered_meaningful as f64 / meaningful_lines as f64;

    FileCoverage {
        file: output.source_path.clone(),
        language: output.language_id.clone(),
        total_lines,
        blank_comment_lines: blank_comment_count,
        meaningful_lines,
        covered_lines: covered_meaningful,
        skipped_lines: skipped,
        coverage_pct,
        skipped_samples,
    }
}

/// Compute coverage across multiple parsed files.
pub fn compute_overall_coverage(file_coverages: &[FileCoverage]) -> OverallCoverage {
    let total_files = file_coverages.len();
    let total_meaningful: usize = file_coverages.iter().map(|f| f.meaningful_lines).sum();
    let total_covered: usize = file_coverages.iter().map(|f| f.covered_lines).sum();

    OverallCoverage {
        total_files,
        total_meaningful_lines: total_meaningful,
        total_covered_lines: total_covered,
        actual_coverage_pct: if total_meaningful > 0 {
            total_covered as f64 / total_meaningful as f64
        } else {
            0.0
        },
    }
}
