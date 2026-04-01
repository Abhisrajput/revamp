//! Core LanguageParser trait — the plugin interface that all language parsers implement.
//!
//! Two-layer IR design:
//!   Layer 1: Language-specific AST (ParseOutput) — preserves full semantics
//!   Layer 2: Normalized Analysis Graph (AnalysisGraph) — cross-language analysis
//!
//! This is how CAST Imaging and Micro Focus Enterprise Analyzer work: you cannot
//! flatten COBOL and RPG into the same IR without losing critical semantics
//! (REDEFINES, indicators, 88-level conditions, etc.).

use crate::parser::nir::{AnalysisGraph, DependencyRef, ParseOutput, PartialParseOutput};
use std::collections::HashMap;
use std::path::PathBuf;

/// A single source file in the vault.
#[derive(Debug, Clone)]
pub struct SourceFile {
    pub path: PathBuf,
    pub content: String,
    /// File extension (lowercase, without dot).
    pub extension: String,
    /// First 512 characters for content-based detection.
    pub header: String,
    /// File size in bytes.
    pub size: u64,
    /// Cached line count (avoids repeated O(n) scans).
    pub line_count: usize,
}

impl SourceFile {
    pub fn new(path: PathBuf, content: String) -> Self {
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let header = content.chars().take(512).collect();
        let size = content.len() as u64;
        let line_count = content.lines().count();
        Self {
            path,
            content,
            extension,
            header,
            size,
            line_count,
        }
    }
}

/// Collection of source files for a project.
#[derive(Debug, Clone, Default)]
pub struct SourceVault {
    pub files: Vec<SourceFile>,
    pub root_path: PathBuf,
    pub metadata: HashMap<String, String>,
}

impl SourceVault {
    pub fn new(root_path: PathBuf) -> Self {
        Self {
            files: Vec::new(),
            root_path,
            metadata: HashMap::new(),
        }
    }

    pub fn add_file(&mut self, file: SourceFile) {
        self.files.push(file);
    }

    pub fn files_by_extension(&self, ext: &str) -> Vec<&SourceFile> {
        self.files.iter().filter(|f| f.extension == ext).collect()
    }

    pub fn total_lines(&self) -> usize {
        self.files.iter().map(|f| f.line_count).sum()
    }
}

/// Every language parser implements this trait.
/// Add new languages without touching the core engine.
pub trait LanguageParser: Send + Sync {
    /// Unique identifier for this language (e.g., "cobol-85", "rpg-iv-free").
    fn language_id(&self) -> &'static str;

    /// Human-readable display name (e.g., "COBOL 85", "RPG IV Free Format").
    fn display_name(&self) -> &'static str;

    /// Supported dialect versions (e.g., ["COBOL-74", "COBOL-85", "COBOL-2002"]).
    fn supported_dialects(&self) -> &[&'static str];

    /// File extensions this parser handles (e.g., ["cbl", "cob", "cpy"]).
    fn file_extensions(&self) -> &[&'static str];

    /// NIR coverage percentage (0.0 to 1.0). Status is derived from this value
    /// via `ParserStatus::from_coverage()` instead of being hardcoded.
    fn nir_coverage_pct(&self) -> f64 { 0.0 }

    /// Recommended parsing backend for production use.
    fn recommended_backend(&self) -> &'static str { "unknown" }

    /// Estimated development effort to reach production readiness.
    fn estimated_dev_effort(&self) -> &'static str { "unknown" }

    /// Whether this parser can handle the given file.
    /// Uses extension check + content heuristics (e.g., IDENTIFICATION DIVISION).
    fn can_parse(&self, file: &SourceFile) -> bool;

    /// Parse source into a language-specific AST (Layer 1).
    /// Returns full parse output or error.
    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput>;

    /// Parse with error recovery — return partial results on failure.
    /// Critical for legacy code that may have syntax issues.
    fn parse_partial(&self, source: &SourceFile) -> anyhow::Result<PartialParseOutput>;

    /// Resolve cross-module dependencies (COPY, CALL, INCLUDE, etc.).
    fn resolve_dependencies(
        &self,
        module: &ParseOutput,
        vault: &SourceVault,
    ) -> Vec<DependencyRef>;

    /// Lift language-specific AST into the Normalized Analysis Graph (Layer 2).
    /// This is a lossy transformation that enables cross-language analysis.
    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph>;
}
