//! Integration tests for BREE analysis modules.

use bree_engine::parser::traits::*;
use bree_engine::parser::registry::ParserRegistry;
use bree_engine::languages::cobol::CobolParser;
use bree_engine::languages::rpg::RpgParser;
use bree_engine::languages::jcl::JclParser;
use bree_engine::analysis::{dead_code, complexity, call_graph, data_lineage, business_rules, pipeline};
use bree_engine::parser::nir::DependencyRef;
use std::path::PathBuf;

fn make_file(name: &str, content: &str) -> SourceFile {
    SourceFile::new(PathBuf::from(name), content.to_string())
}

fn parse_cobol(content: &str, name: &str) -> bree_engine::parser::nir::ParseOutput {
    let parser = CobolParser::new();
    let file = make_file(name, content);
    parser.parse(&file).unwrap()
}

// ─── Dead Code Tests ────────────────────────────────────────────

#[test]
fn dead_code_finds_unreachable_paragraph() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           PERFORM USED-PARA\n           STOP RUN.\n       USED-PARA.\n           DISPLAY \"HI\".\n       ORPHAN.\n           DISPLAY \"NEVER\".",
        "TEST.cbl",
    );
    let report = dead_code::detect_dead_code(&[&output]);
    assert!(report.unreachable_paragraphs.iter().any(|p| p.name == "ORPHAN"),
        "Should detect ORPHAN as unreachable");
    assert!(!report.unreachable_paragraphs.iter().any(|p| p.name == "USED-PARA"),
        "USED-PARA is called by PERFORM");
}

#[test]
fn dead_code_finds_unused_variables() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       01  WS-USED     PIC X.\n       01  WS-UNUSED   PIC X.\n       PROCEDURE DIVISION.\n       MAIN.\n           MOVE \"A\" TO WS-USED\n           STOP RUN.",
        "TEST.cbl",
    );
    let report = dead_code::detect_dead_code(&[&output]);
    // WS-UNUSED should be in unused list
    assert!(report.unused_variables.iter().any(|v| v.name == "WS-UNUSED"),
        "Should detect WS-UNUSED as unused");
}

// ─── Complexity Tests ───────────────────────────────────────────

#[test]
fn complexity_counts_if_statements() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           IF X = 1\n               DISPLAY \"A\"\n           END-IF\n           IF Y = 2\n               DISPLAY \"B\"\n           END-IF\n           STOP RUN.",
        "TEST.cbl",
    );
    let report = complexity::analyze_complexity(&[&output]);
    assert!(!report.functions.is_empty());
    let main_fn = report.functions.iter().find(|f| f.name == "MAIN").unwrap();
    assert_eq!(main_fn.decision_points, 2, "Should have 2 IF statements");
    assert_eq!(main_fn.complexity, 3, "Complexity = decisions + 1 = 3");
}

#[test]
fn complexity_rates_risk() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       SIMPLE.\n           DISPLAY \"HI\".\n           STOP RUN.",
        "TEST.cbl",
    );
    let report = complexity::analyze_complexity(&[&output]);
    for f in &report.functions {
        assert_eq!(f.risk, "low", "Simple function should be low risk");
    }
}

// ─── Call Graph Tests ───────────────────────────────────────────

#[test]
fn call_graph_builds_edges() {
    let cobol_parser = CobolParser::new();
    let jcl_parser = JclParser::new();

    let cobol_file = make_file("PROG.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG.\n       PROCEDURE DIVISION.\n       MAIN.\n           CALL 'SUB1'\n           STOP RUN.");
    let jcl_file = make_file("RUN.jcl", "//JOB1 JOB (ACCT),\"TEST\"\n//STEP1 EXEC PGM=PROG");

    let cobol_out = cobol_parser.parse(&cobol_file).unwrap();
    let jcl_out = jcl_parser.parse(&jcl_file).unwrap();
    let vault = SourceVault::new(PathBuf::from("."));

    let mut deps = Vec::new();
    deps.extend(cobol_parser.resolve_dependencies(&cobol_out, &vault));
    deps.extend(jcl_parser.resolve_dependencies(&jcl_out, &vault));

    let graph = call_graph::build_call_graph(&[&cobol_out, &jcl_out], &deps);

    assert!(graph.stats.total_nodes > 0, "Should have nodes");
    assert!(graph.stats.total_edges > 0, "Should have edges");
    assert!(!graph.mermaid.is_empty(), "Should generate Mermaid");
    assert!(graph.mermaid.contains("graph TD"), "Mermaid should start with graph TD");
}

#[test]
fn call_graph_mermaid_has_styles() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           CALL 'EXT'\n           STOP RUN.",
        "TEST.cbl",
    );
    let vault = SourceVault::new(PathBuf::from("."));
    let parser = CobolParser::new();
    let deps = parser.resolve_dependencies(&output, &vault);
    let graph = call_graph::build_call_graph(&[&output], &deps);

    assert!(graph.mermaid.contains("classDef"), "Should have style classes");
}

// ─── Data Lineage Tests ─────────────────────────────────────────

#[test]
fn lineage_tracks_move_statement() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       01  WS-SOURCE  PIC X(10).\n       01  WS-TARGET  PIC X(10).\n       PROCEDURE DIVISION.\n       MAIN.\n           MOVE WS-SOURCE TO WS-TARGET\n           STOP RUN.",
        "TEST.cbl",
    );
    let report = data_lineage::trace_lineage(&[&output]);
    assert!(report.total_fields_tracked > 0);

    let target = report.fields.iter().find(|f| f.name == "WS-TARGET");
    assert!(target.is_some(), "Should track WS-TARGET");
    if let Some(t) = target {
        assert!(!t.writes.is_empty(), "WS-TARGET should have write from MOVE TO");
    }
}

#[test]
fn lineage_tracks_if_reads() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       01  WS-STATUS  PIC X.\n       PROCEDURE DIVISION.\n       MAIN.\n           IF WS-STATUS = \"A\"\n               DISPLAY \"ACTIVE\"\n           END-IF\n           STOP RUN.",
        "TEST.cbl",
    );
    let report = data_lineage::trace_lineage(&[&output]);
    let status = report.fields.iter().find(|f| f.name == "WS-STATUS");
    assert!(status.is_some());
    if let Some(s) = status {
        assert!(!s.reads.is_empty(), "WS-STATUS should be read in IF condition");
    }
}

// ─── Business Rule Tests ────────────────────────────────────────

#[test]
fn rules_extracts_validation() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           IF WS-AMOUNT > 0\n               DISPLAY \"VALID\"\n           END-IF\n           STOP RUN.",
        "TEST.cbl",
    );
    let report = business_rules::extract_rules(&[&output]);
    assert!(report.total_rules >= 1, "Should extract at least 1 rule");
    assert!(report.rules.iter().any(|r| r.id.starts_with("BR-")), "Rules should have BR-XXXX IDs");
}

#[test]
fn rules_extracts_calculation() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           COMPUTE WS-TAX = WS-AMOUNT * 0.15\n           STOP RUN.",
        "TEST.cbl",
    );
    let report = business_rules::extract_rules(&[&output]);
    let calc_rules: Vec<_> = report.rules.iter().filter(|r| r.rule_type == "calculation").collect();
    assert!(!calc_rules.is_empty(), "Should extract calculation rule");
}

#[test]
fn rules_classifies_workflow() {
    let output = parse_cobol(
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           IF WS-STATUS = \"ACTIVE\"\n               PERFORM PROCESS\n           END-IF\n           STOP RUN.\n       PROCESS.\n           DISPLAY \"OK\".",
        "TEST.cbl",
    );
    let report = business_rules::extract_rules(&[&output]);
    let status_rules: Vec<_> = report.rules.iter().filter(|r| r.rule_type == "validation").collect();
    assert!(!status_rules.is_empty(), "Should classify STATUS = check as validation rule");
}

// ─── Full Pipeline with Deep Analysis ───────────────────────────

#[test]
fn pipeline_includes_deep_analysis() {
    let mut registry = ParserRegistry::new();
    registry.register(Box::new(CobolParser::new()));

    let mut vault = SourceVault::new(PathBuf::from("."));
    vault.add_file(make_file("TEST.cbl",
        "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       01  WS-X  PIC 9.\n       PROCEDURE DIVISION.\n       MAIN.\n           IF WS-X > 5\n               COMPUTE WS-X = WS-X * 2\n           END-IF\n           STOP RUN."));

    let report = pipeline::run_pipeline(&vault, &registry);

    // Check all deep analysis sections are populated
    assert!(report.complexity.functions.len() > 0, "Should have complexity data");
    assert!(report.business_rules.total_rules > 0, "Should have business rules");
    assert!(report.data_lineage.total_fields_tracked > 0, "Should have lineage data");
    assert!(report.call_graph.stats.total_nodes > 0, "Should have call graph");
}
