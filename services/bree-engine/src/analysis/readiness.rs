//! Parser readiness assessment — evaluates parser coverage per language.

use crate::languages::tiers::ParserStatus;
use crate::parser::registry::ParserRegistry;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadinessMatrix {
    pub entries: Vec<ReadinessEntry>,
    pub overall_coverage: f64,
    pub languages_with_parser: usize,
    pub languages_without_parser: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadinessEntry {
    pub language_id: String,
    pub display_name: String,
    pub parser_status: ParserStatus,
    pub has_registered_parser: bool,
    pub nir_coverage_pct: f64,
    pub estimated_dev_effort: String,
    pub recommended_backend: String,
}

pub fn assess_readiness(detected_languages: &[String], registry: &ParserRegistry) -> ReadinessMatrix {
    let entries: Vec<ReadinessEntry> = detected_languages.iter().map(|lang_id| {
        let has_parser = registry.get(lang_id).is_some();
        let info = language_readiness(lang_id);
        ReadinessEntry {
            language_id: lang_id.clone(), display_name: lang_id.clone(),
            parser_status: info.0, has_registered_parser: has_parser,
            nir_coverage_pct: info.1, estimated_dev_effort: info.2.to_string(),
            recommended_backend: info.3.to_string(),
        }
    }).collect();
    let total = entries.len().max(1) as f64;
    let sum: f64 = entries.iter().map(|e| e.nir_coverage_pct).sum();
    let with_parser = entries.iter().filter(|e| e.has_registered_parser).count();
    ReadinessMatrix {
        overall_coverage: sum / total, languages_with_parser: with_parser,
        languages_without_parser: entries.len() - with_parser, entries,
    }
}

// (Status, NIR%, DevEffort, Backend)
fn language_readiness(id: &str) -> (ParserStatus, f64, &'static str, &'static str) {
    match id {
        // ── Deep parsers: full AST + control flow + embedded + deps + analysis graph ──
        "cobol"   => (ParserStatus::Partial, 0.93, "1 week to production", "tree-sitter + ProLeap COBOL"),
        "rpg"     => (ParserStatus::Partial, 0.92, "1 week to production", "custom (fixed + free format, indicators, KLIST/PLIST, loops, monitor, analysis graph)"),
        "cl"      => (ParserStatus::Partial, 0.88, "1 week to production", "custom CL command parser (45+ commands, cross-language deps, screen I/O, RUNSQL, subroutines)"),
        "dds"     => (ParserStatus::Partial, 0.85, "1 week to production", "custom column-positional (PF/LF/DSPF/PRTF/ICFF, key fields, subfiles, indicators)"),
        "pli"     => (ParserStatus::Partial, 0.74, "2-3 weeks to production", "custom PL/I + ANTLR grammar"),
        "jcl"     => (ParserStatus::Partial, 0.72, "1 week to production", "custom JCL statement parser"),
        // ── Strong parsers: symbols + control flow + domain-specific constructs ──
        "vb6"     => (ParserStatus::Partial, 0.82, "1-2 weeks to production", "ANTLR (vb6 grammar)"),
        "plsql"   => (ParserStatus::Partial, 0.80, "1 week to production", "ANTLR (mature PlSql grammar)"),
        "abap"    => (ParserStatus::Partial, 0.72, "2-3 weeks to production", "custom (SAP-specific)"),
        "sas"     => (ParserStatus::Partial, 0.70, "2-3 weeks to production", "custom (DATA/PROC + macros)"),
        "natural"  => (ParserStatus::Partial, 0.70, "2-3 weeks to production", "custom (no OSS NATURAL parser)"),
        "fortran" => (ParserStatus::Partial, 0.68, "1-2 weeks to production", "tree-sitter (fortran grammar)"),
        "mumps"   => (ParserStatus::Partial, 0.68, "3-4 weeks to production", "custom PEG grammar"),
        // ── Solid parsers: symbols + deps + structure + section tracking ──
        "delphi"  => (ParserStatus::Partial, 0.58, "2-3 weeks to production", "tree-sitter (pascal) + DFM"),
        "powerbuilder" => (ParserStatus::Partial, 0.58, "3-4 weeks to production", "custom PBL + PowerScript"),
        "vbnet-legacy" => (ParserStatus::Partial, 0.52, "2-3 weeks to production", "Roslyn (CodeAnalysis.VB)"),
        "ada"     => (ParserStatus::Partial, 0.52, "2-3 weeks to production", "tree-sitter + libadalang"),
        "progress-4gl" => (ParserStatus::Partial, 0.52, "3-4 weeks to production", "custom (ABLParser ref)"),
        "tsql"    => (ParserStatus::Partial, 0.52, "1-2 weeks to production", "ANTLR (mature TSql grammar)"),
        "db2sql"  => (ParserStatus::Partial, 0.52, "2-3 weeks to production", "custom DB2 dialect (ANTLR SQL)"),
        "asp-classic" => (ParserStatus::Partial, 0.50, "2-3 weeks to production", "custom VBScript + HTML"),
        "visual-foxpro" => (ParserStatus::Partial, 0.50, "2-3 weeks to production", "custom Xbase + SCX"),
        "perl"    => (ParserStatus::Partial, 0.50, "2-3 weeks to production", "tree-sitter (perl) + PPI"),
        "clipper"  => (ParserStatus::Partial, 0.50, "2-3 weeks to production", "custom Xbase (Harbour ref)"),
        "coldfusion" => (ParserStatus::Partial, 0.50, "2-3 weeks to production", "ANTLR (CFML) + CFScript"),
        // ── Working parsers: focused symbol + call extraction ──
        "oracle-forms" => (ParserStatus::Partial, 0.48, "4-6 weeks to production", "FMB decompiler + PL/SQL ANTLR"),
        "assembler-zos" => (ParserStatus::Stub, 0.48, "6-8 weeks to production", "custom HLASM (macro complex)"),
        "rexx"    => (ParserStatus::Stub, 0.48, "2-3 weeks to production", "custom (PARSE instruction)"),
        "lotusscript" => (ParserStatus::Stub, 0.48, "2-3 weeks to production", "custom (VB-like + Notes)"),
        "smalltalk" => (ParserStatus::Stub, 0.42, "4-6 weeks to production", "custom (Pharo image + chunks)"),
        "silverlight" => (ParserStatus::Stub, 0.42, "2-3 weeks to production", "Roslyn (C#/VB) + XAML"),
        "ca-gen"  => (ParserStatus::Stub, 0.38, "6-8 weeks to production", "CA Gen model + COBOL parser"),
        _ => (ParserStatus::Community, 0.0, "Unknown", "community contribution"),
    }
}
