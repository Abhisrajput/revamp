//! Integration tests for BREE language parsers.

use bree_engine::parser::traits::*;
use bree_engine::parser::registry::ParserRegistry;
use bree_engine::languages::cobol::CobolParser;
use bree_engine::languages::rpg::RpgParser;
use bree_engine::languages::cl::ClParser;
use bree_engine::languages::dds::DdsParser;
use bree_engine::languages::jcl::JclParser;
use bree_engine::languages::vb6::Vb6Parser;
use bree_engine::languages::abap::AbapParser;
use bree_engine::languages::sas::SasParser;
use bree_engine::languages::delphi::DelphiParser;
use bree_engine::languages::powerbuilder::PowerBuilderParser;
use bree_engine::languages::natural::NaturalParser;
use bree_engine::languages::plsql::PlsqlParser;
use bree_engine::languages::fortran::FortranParser;
use bree_engine::languages::mumps::MumpsParser;
use bree_engine::languages::remaining::*;
use bree_engine::detection::detector::PolyglotDetector;
use bree_engine::analysis::{priority, pipeline, resolver};
use bree_engine::languages::tiers::{find_language, all_languages, Tier, languages_by_tier};
use std::path::PathBuf;

fn make_file(name: &str, content: &str) -> SourceFile {
    SourceFile::new(PathBuf::from(name), content.to_string())
}

// ─── COBOL Parser Tests ──────────────────────────────────────────

#[test]
fn cobol_detects_divisions() {
    let parser = CobolParser::new();
    let file = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       01  WS-X  PIC X.\n       PROCEDURE DIVISION.\n       MAIN-PARA.\n           STOP RUN.");
    let output = parser.parse(&file).unwrap();
    let divs: Vec<_> = output.metadata.get("divisions").unwrap().as_array().unwrap()
        .iter().filter_map(|v| v.as_str()).collect();
    assert!(divs.contains(&"IDENTIFICATION"));
    assert!(divs.contains(&"DATA"));
    assert!(divs.contains(&"PROCEDURE"));
}

#[test]
fn cobol_extracts_program_id() {
    let parser = CobolParser::new();
    let file = make_file("CUSTMAST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. CUSTMAST.\n       PROCEDURE DIVISION.\n       MAIN-PARA.\n           STOP RUN.");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata.get("program_id").unwrap().as_str().unwrap(), "CUSTMAST");
}

#[test]
fn cobol_detects_88_level_conditions() {
    let parser = CobolParser::new();
    let file = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       01  WS-STATUS   PIC X.\n           88 ACTIVE    VALUE \"A\".\n           88 INACTIVE  VALUE \"I\".\n       PROCEDURE DIVISION.\n       MAIN.\n           STOP RUN.");
    let output = parser.parse(&file).unwrap();
    let count = output.metadata.get("condition_88_count").unwrap().as_u64().unwrap();
    assert_eq!(count, 2);
}

#[test]
fn cobol_detects_perform_thru() {
    let parser = CobolParser::new();
    let file = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           PERFORM PROCESS THRU PROCESS-EXIT.\n           STOP RUN.\n       PROCESS.\n           DISPLAY \"HI\".\n       PROCESS-EXIT.\n           EXIT.");
    let output = parser.parse(&file).unwrap();
    let thru = output.metadata.get("perform_thru_count").unwrap().as_u64().unwrap();
    assert!(thru >= 1, "Expected at least 1 PERFORM THRU, got {}", thru);
}

#[test]
fn cobol_extracts_call_targets() {
    let parser = CobolParser::new();
    let file = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           CALL 'AUDITPGM' USING WS-DATA.\n           STOP RUN.");
    let output = parser.parse(&file).unwrap();
    let calls = output.metadata.get("call_count").unwrap().as_u64().unwrap();
    assert_eq!(calls, 1);
}

#[test]
fn cobol_detects_embedded_sql() {
    let parser = CobolParser::new();
    let file = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           EXEC SQL\n               SELECT COUNT(*) INTO :WS-CNT FROM CUSTOMERS\n           END-EXEC.\n           STOP RUN.");
    let output = parser.parse(&file).unwrap();
    assert!(!output.embedded_blocks.is_empty(), "Should detect EXEC SQL block");
    assert_eq!(output.embedded_blocks[0].language, "DB2-SQL");
    let tables = output.metadata.get("sql_tables").unwrap().as_array().unwrap();
    assert!(tables.iter().any(|t| t.as_str() == Some("CUSTOMERS")));
}

#[test]
fn cobol_detects_copybooks() {
    let parser = CobolParser::new();
    let file = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       COPY CUSTCOPY.\n       PROCEDURE DIVISION.\n       MAIN.\n           STOP RUN.");
    let output = parser.parse(&file).unwrap();
    let copies = output.metadata.get("copy_count").unwrap().as_u64().unwrap();
    assert!(copies >= 1);
}

#[test]
fn cobol_detects_dialect() {
    let parser = CobolParser::new();
    // COBOL-85 uses END-IF
    let file85 = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST.\n       PROCEDURE DIVISION.\n       MAIN.\n           IF X = 1\n               DISPLAY \"YES\"\n           END-IF.\n           STOP RUN.");
    let out85 = parser.parse(&file85).unwrap();
    assert_eq!(out85.dialect, "COBOL-85");
}

// ─── RPG Parser Tests ────────────────────────────────────────────

#[test]
fn rpg_parses_free_format() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\ndcl-s myVar char(10);\ndcl-s count int(10);\ndcl-ds custDs qualified;\n  id char(10);\n  name char(30);\nend-ds;\ndcl-proc processOrder export;\n  dcl-pi *n;\n    orderId char(10);\n  end-pi;\n  // logic here\nend-proc;");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata.get("format").unwrap().as_str().unwrap(), "free");
    let procs = output.metadata.get("procedure_count").unwrap().as_u64().unwrap();
    assert_eq!(procs, 1);
    let vars = output.metadata.get("variable_count").unwrap().as_u64().unwrap();
    assert!(vars >= 2);
}

#[test]
fn rpg_parses_embedded_sql() {
    let parser = RpgParser::new();
    let file = make_file("TEST.sqlrpgle", "**free\ndcl-s custName char(30);\nexec sql\n  select cust_name into :custName\n  from customers\n  where cust_id = '001';\n");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.dialect, "SQLRPGLE");
    assert!(!output.embedded_blocks.is_empty());
    let sql_count = output.metadata.get("embedded_sql_count").unwrap().as_u64().unwrap();
    assert_eq!(sql_count, 1);
}

#[test]
fn rpg_parses_subroutines() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\nbegsr calcTax;\n  // tax logic\nendsr;\nexsr calcTax;");
    let output = parser.parse(&file).unwrap();
    let subs = output.metadata.get("subroutine_count").unwrap().as_u64().unwrap();
    assert_eq!(subs, 1);
}

#[test]
fn rpg_detects_copy_directives() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\n/copy qrpglesrc,custds\ndcl-s x int(10);");
    let output = parser.parse(&file).unwrap();
    let copies = output.metadata.get("copy_count").unwrap().as_u64().unwrap();
    assert_eq!(copies, 1);
}

#[test]
fn rpg_parses_ctl_opt() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\nctl-opt dftactgrp(*no) actgrp(*new) bnddir('MYLIB');\ndcl-s x int(10);");
    let output = parser.parse(&file).unwrap();
    assert!(output.metadata.get("has_control_spec").unwrap().as_bool().unwrap());
    let ctlopt = output.ast_nodes.iter().find(|n| n.kind == bree_engine::parser::nir::AstNodeKind::Custom("CTL-OPT".to_string())).unwrap();
    assert!(ctlopt.properties.get("bnddir").is_some());
}

#[test]
fn rpg_parses_dcl_pr_prototype() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\ndcl-pr SendEmail extpgm('SENDEML');\n  recipient char(100);\n  subject char(200);\nend-pr;\ndcl-s x int(10);");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata.get("prototype_count").unwrap().as_u64().unwrap(), 1);
    let proto = output.symbols.iter().find(|s| s.name == "SendEmail").unwrap();
    assert_eq!(proto.kind, bree_engine::parser::nir::SymbolKind::Custom("Prototype".to_string()));
}

#[test]
fn rpg_parses_dow_for_loops() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\ndcl-s i int(10);\ndow not %eof(custFile);\n  read custRec;\nenddo;\nfor i = 1 to 10;\n  dsply %char(i);\nendfor;");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata.get("loop_count").unwrap().as_u64().unwrap(), 2);
}

#[test]
fn rpg_parses_monitor_on_error() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\nmonitor;\n  result = num1 / num2;\non-error 00102;\n  result = 0;\nendmon;");
    let output = parser.parse(&file).unwrap();
    let has_monitor = output.ast_nodes.iter().any(|n| n.kind == bree_engine::parser::nir::AstNodeKind::Custom("Monitor".to_string()));
    let has_onerror = output.ast_nodes.iter().any(|n| n.kind == bree_engine::parser::nir::AstNodeKind::Custom("OnError".to_string()));
    assert!(has_monitor);
    assert!(has_onerror);
}

#[test]
fn rpg_detects_indicators() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\ndcl-s done ind;\nif *inlr;\n  return;\nendif;\nif *in50;\n  dsply 'active';\nendif;");
    let output = parser.parse(&file).unwrap();
    let inds = output.metadata.get("indicators_used").unwrap().as_array().unwrap();
    assert!(inds.len() >= 2);
}

#[test]
fn rpg_resolves_file_dependencies() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\ndcl-f custFile disk usage(*input) keyed;\ndcl-f orderFile disk usage(*output);\nread custRec;\nwrite orderRec;");
    let output = parser.parse(&file).unwrap();
    let vault = SourceVault::new(PathBuf::from("."));
    let deps = parser.resolve_dependencies(&output, &vault);
    let file_deps: Vec<_> = deps.iter().filter(|d| matches!(d.dependency_type, bree_engine::parser::nir::DependencyType::FileAccess)).collect();
    assert_eq!(file_deps.len(), 2);
}

#[test]
fn rpg_analysis_graph_has_edges() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\ndcl-proc doWork export;\n  dcl-pi *n;\n  end-pi;\n  read custRec;\n  write orderRec;\n  callp sendNotify('done');\nend-proc;");
    let output = parser.parse(&file).unwrap();
    let graph = parser.to_analysis_graph(&output).unwrap();
    assert!(!graph.nodes.is_empty());
    assert!(!graph.edges.is_empty());
    let has_read_edge = graph.edges.iter().any(|e| matches!(e.kind, bree_engine::parser::nir::AnalysisEdgeKind::ReadsFrom));
    let has_write_edge = graph.edges.iter().any(|e| matches!(e.kind, bree_engine::parser::nir::AnalysisEdgeKind::WritesTo));
    assert!(has_read_edge);
    assert!(has_write_edge);
}

#[test]
fn rpg_parses_select_when_other() {
    let parser = RpgParser::new();
    let file = make_file("TEST.rpgle", "**free\nselect;\n  when custType = 'A';\n    discount = 0.10;\n  when custType = 'B';\n    discount = 0.05;\n  other;\n    discount = 0;\nendsl;");
    let output = parser.parse(&file).unwrap();
    let selects = output.ast_nodes.iter().filter(|n| matches!(n.kind, bree_engine::parser::nir::AstNodeKind::EvaluateStatement)).count();
    let whens = output.ast_nodes.iter().filter(|n| matches!(n.kind, bree_engine::parser::nir::AstNodeKind::Condition)).count();
    assert_eq!(selects, 1);
    assert_eq!(whens, 2);
}

// ─── DDS Parser Tests ───────────────────────────────────────────

#[test]
fn dds_parses_physical_file() {
    let parser = DdsParser::new();
    // Proper 45+ column DDS format: col 6=A, col 17=name_type, col 19-28=name, col 45+=keywords
    let src = "     A          R CUSTREC\n     A            CUSNUM         6P 0       TEXT('Customer Number')\n     A            CUSNAM        30A         TEXT('Customer Name')\n     A            CUSADR        30A         TEXT('Customer Address')\n     A            CUSBAL         9P 2       TEXT('Customer Balance')\n     A          K CUSNUM";
    let file = make_file("CUSTMAS.pf", src);
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.dialect, "DDS-PF");
    assert_eq!(output.metadata["dds_type"].as_str().unwrap(), "PF");
    assert_eq!(output.metadata["record_format_count"].as_u64().unwrap(), 1);
    assert!(output.metadata["field_count"].as_u64().unwrap() >= 4);
    assert_eq!(output.metadata["key_field_count"].as_u64().unwrap(), 1);
}

#[test]
fn dds_parses_logical_file() {
    let parser = DdsParser::new();
    let src = "     A          R CUSTREC                     PFILE(CUSTMAS)\n     A          K CUSNAM";
    let file = make_file("CUSTNAML.lf", src);
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.dialect, "DDS-LF");
    let pfiles = output.metadata["pfile_references"].as_array().unwrap();
    assert!(pfiles.iter().any(|f| f.as_str().unwrap() == "CUSTMAS"));
}

#[test]
fn dds_parses_display_file() {
    let parser = DdsParser::new();
    let src = "     A                                        CF03(03 'Exit')\n     A          R SFLREC                      SFL\n     A            CUSNUM         6P 0B  5 10\n     A            CUSNAM        30A  B  5 20\n     A          R SFLCTL                      SFLCTL(SFLREC)\n     A                                        SFLSIZ(0014)\n     A                                        SFLPAG(0013)";
    let file = make_file("CUSTDSP.dspf", src);
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata["dds_type"].as_str().unwrap(), "DSPF");
    assert!(output.metadata["subfile_count"].as_u64().unwrap() >= 1);
    assert!(output.metadata["function_key_count"].as_u64().unwrap() >= 1);
}

#[test]
fn dds_parses_printer_file() {
    let parser = DdsParser::new();
    let src = "     A          R HEADER\n     A                                        SPACEA(3)\n     A            RPTDATE        8A\n     A            RPTTITLE      40A\n     A          R DETAIL\n     A                                        SPACEA(1)\n     A            CUSNUM         6P 0\n     A            CUSNAM        30A";
    let file = make_file("CUSTRPT.prtf", src);
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata["dds_type"].as_str().unwrap(), "PRTF");
    assert!(output.metadata["record_format_count"].as_u64().unwrap() >= 2);
}

#[test]
fn dds_resolves_lf_to_pf_dependency() {
    let parser = DdsParser::new();
    let src = "     A          R CUSTREC                     PFILE(CUSTMAS)\n     A          K CUSNAM";
    let file = make_file("CUSTNAML.lf", src);
    let output = parser.parse(&file).unwrap();
    let vault = SourceVault::new(PathBuf::from("/"));
    let deps = parser.resolve_dependencies(&output, &vault);
    assert!(!deps.is_empty());
    assert!(deps.iter().any(|d| d.to_module == "CUSTMAS"));
}

#[test]
fn dds_unique_key_detected() {
    let parser = DdsParser::new();
    let src = "     A                                        UNIQUE\n     A          R ORDREC\n     A            ORDNUM         8P 0       TEXT('Order Number')\n     A          K ORDNUM";
    let file = make_file("ORDMAS.pf", src);
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata["unique_keys"].as_bool().unwrap(), true);
}

// ─── VB6 Parser Tests ───────────────────────────────────────────

#[test]
fn vb6_detects_form_type() {
    let parser = Vb6Parser::new();
    let file = make_file("frmMain.frm", "VERSION 5.00\nBegin VB.Form frmMain\n   Begin VB.CommandButton cmdOK\n   End\nEnd\nAttribute VB_Name = \"frmMain\"\nPrivate Sub cmdOK_Click()\n  MsgBox \"Hello\"\nEnd Sub");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata.get("subtype").unwrap().as_str().unwrap(), "Form");
    let controls = output.metadata.get("controls_count").unwrap().as_u64().unwrap();
    assert!(controls >= 2);
}

#[test]
fn vb6_detects_com_references() {
    let parser = Vb6Parser::new();
    let file = make_file("Module1.bas", "Attribute VB_Name = \"Module1\"\nPublic Sub Main()\n  Dim xl As Object\n  Set xl = CreateObject(\"Excel.Application\")\nEnd Sub");
    let output = parser.parse(&file).unwrap();
    let refs = output.metadata.get("com_references").unwrap().as_array().unwrap();
    assert!(refs.iter().any(|r| r.as_str().unwrap().contains("Excel")));
}

#[test]
fn vb6_detects_on_error() {
    let parser = Vb6Parser::new();
    let file = make_file("Module1.bas", "Attribute VB_Name = \"Module1\"\nPublic Sub Risky()\n  On Error Resume Next\n  x = 1 / 0\nEnd Sub");
    let output = parser.parse(&file).unwrap();
    let errors = output.metadata.get("on_error_count").unwrap().as_u64().unwrap();
    assert_eq!(errors, 1);
}

// ─── ABAP Parser Tests ──────────────────────────────────────────

#[test]
fn abap_detects_report() {
    let parser = AbapParser::new();
    let file = make_file("ZTEST.abap", "REPORT ZTEST.\nDATA: lv_count TYPE i.\nSELECT COUNT(*) FROM customers INTO lv_count.\nFORM display.\n  WRITE: / lv_count.\nENDFORM.\nPERFORM display.");
    let output = parser.parse(&file).unwrap();
    let tables = output.metadata.get("db_tables").unwrap().as_array().unwrap();
    assert!(tables.iter().any(|t| t.as_str().unwrap().contains("CUSTOMERS")));
}

// ─── SAS Parser Tests ───────────────────────────────────────────

#[test]
fn sas_detects_macro() {
    let parser = SasParser::new();
    let file = make_file("test.sas", "%let cutoff = 01JAN2024;\n%macro process(ds);\ndata out; set &ds; run;\n%mend process;\nlibname db oracle path=\"PROD\";");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.dialect, "SAS-Macro");
    let macros = output.metadata.get("macro_count").unwrap().as_u64().unwrap();
    assert_eq!(macros, 1);
    let libs = output.metadata.get("libname_count").unwrap().as_u64().unwrap();
    assert_eq!(libs, 1);
}

// ─── Detection Tests ────────────────────────────────────────────

#[test]
fn detector_identifies_cobol() {
    let detector = PolyglotDetector::new();
    let mut vault = SourceVault::new(PathBuf::from("."));
    vault.add_file(make_file("TEST.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. TEST."));
    let profile = detector.detect(&vault);
    assert!(!profile.primary.is_empty() || !profile.secondary.is_empty());
    let all_ids: Vec<_> = profile.primary.iter().chain(profile.secondary.iter())
        .map(|l| l.language_id.as_str()).collect();
    assert!(all_ids.contains(&"cobol"));
}

#[test]
fn detector_handles_polyglot() {
    let detector = PolyglotDetector::new();
    let mut vault = SourceVault::new(PathBuf::from("."));
    vault.add_file(make_file("PROG.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG."));
    vault.add_file(make_file("RUN.jcl", "//JOB1 JOB (ACCT),\"TEST\"\n//STEP1 EXEC PGM=PROG"));
    vault.add_file(make_file("MYPROG.rpgle", "**free\ndcl-s x int(10);"));
    let profile = detector.detect(&vault);
    assert!(profile.stats.languages_found >= 2);
    assert_eq!(profile.unclassified_files.len(), 0);
}

// ─── Priority Scoring Tests ──────────────────────────────────────

#[test]
fn priority_ranks_cobol_highest() {
    let cobol = find_language("cobol").unwrap();
    let vb6 = find_language("vb6").unwrap();
    let scores = priority::compute_priority_scores(&[cobol, vb6]);
    assert_eq!(scores[0].language_id, "cobol");
    assert!(scores[0].weighted_score > scores[1].weighted_score);
}

#[test]
fn priority_score_is_positive() {
    let all = all_languages();
    let scores = priority::compute_priority_scores(&all);
    for s in &scores {
        assert!(s.weighted_score > 0.0, "{} has non-positive score", s.language_id);
    }
}

// ─── Tier Tests ──────────────────────────────────────────────────

#[test]
fn tier1_has_five_core_languages() {
    let t1 = languages_by_tier(Tier::Tier1);
    let ids: Vec<_> = t1.iter().map(|l| l.id).collect();
    assert!(ids.contains(&"cobol"));
    assert!(ids.contains(&"rpg"));
    assert!(ids.contains(&"cl"));
    assert!(ids.contains(&"jcl"));
    assert!(ids.contains(&"pli"));
}

#[test]
fn abap_is_tier2() {
    let abap = find_language("abap").unwrap();
    assert_eq!(abap.tier, Tier::Tier2);
}

// ─── Registry Tests ──────────────────────────────────────────────

#[test]
fn registry_finds_parser_by_file() {
    let mut registry = ParserRegistry::new();
    registry.register(Box::new(CobolParser::new()));
    registry.register(Box::new(RpgParser::new()));

    let cobol_file = make_file("TEST.cbl", "       IDENTIFICATION DIVISION.");
    let rpg_file = make_file("TEST.rpgle", "**free\ndcl-s x int(10);");
    let txt_file = make_file("readme.txt", "This is a readme.");

    assert!(registry.find_parser(&cobol_file).is_some());
    assert!(registry.find_parser(&rpg_file).is_some());
    assert!(registry.find_parser(&txt_file).is_none());
}

#[test]
fn registry_counts_parsers() {
    let mut registry = ParserRegistry::new();
    assert_eq!(registry.count(), 0);
    registry.register(Box::new(CobolParser::new()));
    registry.register(Box::new(RpgParser::new()));
    assert_eq!(registry.count(), 2);
}

// ─── NATURAL Parser Tests ───────────────────────────────────────

#[test]
fn natural_parses_define_data() {
    let parser = NaturalParser::new();
    let file = make_file("CUSTPROG.nsp", "DEFINE DATA LOCAL\n1 #CUST-ID (A10)\n1 #CUST-NAME (A30)\nEND-DEFINE\nREAD CUSTOMERS BY ISN\n  DISPLAY #CUST-ID #CUST-NAME\nEND-READ\nEND");
    let output = parser.parse(&file).unwrap();
    let vars = output.metadata.get("variable_count").unwrap().as_u64().unwrap();
    assert!(vars >= 2, "Expected 2+ variables, got {}", vars);
    let files = output.metadata.get("adabas_files").unwrap().as_array().unwrap();
    assert!(!files.is_empty(), "Should detect Adabas file reference");
}

#[test]
fn natural_detects_callnat() {
    let parser = NaturalParser::new();
    let file = make_file("MAIN.nsp", "DEFINE DATA LOCAL\nEND-DEFINE\nCALLNAT 'SUBPROG' #PARAM\nEND");
    let output = parser.parse(&file).unwrap();
    let calls = output.metadata.get("callnat_count").unwrap().as_u64().unwrap();
    assert_eq!(calls, 1);
}

// ─── PL/SQL Parser Tests ────────────────────────────────────────

#[test]
fn plsql_detects_package() {
    let parser = PlsqlParser::new();
    let file = make_file("cust_pkg.pks", "CREATE OR REPLACE PACKAGE cust_pkg AS\n  PROCEDURE get_customer(p_id NUMBER);\n  FUNCTION calc_balance(p_id NUMBER) RETURN NUMBER;\nEND cust_pkg;");
    let output = parser.parse(&file).unwrap();
    assert_eq!(output.metadata.get("is_package").unwrap().as_bool().unwrap(), true);
}

#[test]
fn plsql_extracts_tables() {
    let parser = PlsqlParser::new();
    let file = make_file("report.pls", "CREATE OR REPLACE PROCEDURE gen_report AS\n  CURSOR c IS SELECT * FROM customers;\nBEGIN\n  FOR r IN c LOOP\n    INSERT INTO report_output VALUES (r.name);\n  END LOOP;\nEND;");
    let output = parser.parse(&file).unwrap();
    let tables = output.metadata.get("tables_referenced").unwrap().as_array().unwrap();
    assert!(tables.iter().any(|t| t.as_str().unwrap().contains("CUSTOMERS")));
}

#[test]
fn plsql_detects_cursors() {
    let parser = PlsqlParser::new();
    let file = make_file("proc.pls", "DECLARE\n  CURSOR emp_cur IS SELECT * FROM employees;\nBEGIN\n  NULL;\nEND;");
    let output = parser.parse(&file).unwrap();
    let cursors = output.metadata.get("cursor_count").unwrap().as_u64().unwrap();
    assert_eq!(cursors, 1);
}

// ─── Fortran Parser Tests ───────────────────────────────────────

#[test]
fn fortran_detects_subroutines() {
    let parser = FortranParser::new();
    let file = make_file("calc.f90", "PROGRAM main\n  IMPLICIT NONE\n  CALL compute(10)\nCONTAINS\n  SUBROUTINE compute(n)\n    INTEGER, INTENT(IN) :: n\n    PRINT *, n * 2\n  END SUBROUTINE\nEND PROGRAM");
    let output = parser.parse(&file).unwrap();
    let subs = output.metadata.get("subroutine_count").unwrap().as_u64().unwrap();
    assert_eq!(subs, 1);
}

#[test]
fn fortran_detects_common_blocks() {
    let parser = FortranParser::new();
    let file = make_file("legacy.f", "      PROGRAM LEGACY\n      COMMON /SHARED/ X, Y, Z\n      COMMON /PARAMS/ A, B\n      CALL CALC\n      END");
    let output = parser.parse(&file).unwrap();
    let blocks = output.metadata.get("common_blocks").unwrap().as_array().unwrap();
    assert_eq!(blocks.len(), 2);
}

// ─── MUMPS Parser Tests ─────────────────────────────────────────

#[test]
fn mumps_detects_globals() {
    let parser = MumpsParser::new();
    let file = make_file("PATIENT.m", "PATIENT ; Patient lookup\n S ^PAT(ID,\"NAME\")=NAME\n S ^PAT(ID,\"DOB\")=DOB\n Q");
    let output = parser.parse(&file).unwrap();
    let globals = output.metadata.get("globals_referenced").unwrap().as_array().unwrap();
    assert!(globals.iter().any(|g| g.as_str().unwrap().starts_with("^PAT")));
}

#[test]
fn mumps_detects_routines() {
    let parser = MumpsParser::new();
    let file = make_file("MAIN.m", "MAIN ; Main entry\n D INIT\n D PROCESS\n Q\nINIT ; Initialize\n S X=0\n Q\nPROCESS ; Process data\n S ^DATA(1)=X\n Q");
    let output = parser.parse(&file).unwrap();
    let routines = output.metadata.get("routine_count").unwrap().as_u64().unwrap();
    assert!(routines >= 3, "Expected 3+ routines, got {}", routines);
}

// ─── Delphi Parser Tests ────────────────────────────────────────

#[test]
fn delphi_parses_unit() {
    let parser = DelphiParser::new();
    let file = make_file("Customer.pas", "unit Customer;\n\ninterface\n\nuses SysUtils, Classes;\n\ntype\n  TCustomer = class(TObject)\n    procedure Save;\n    function GetName: string;\n  end;\n\nimplementation\n\nprocedure TCustomer.Save;\nbegin\nend;\n\nfunction TCustomer.GetName: string;\nbegin\n  Result := '';\nend;\n\nend.");
    let output = parser.parse(&file).unwrap();
    let classes = output.metadata.get("class_count").unwrap().as_u64().unwrap();
    assert_eq!(classes, 1);
    let procs = output.metadata.get("procedure_count").unwrap().as_u64().unwrap();
    assert!(procs >= 1);
}

// ─── Remaining Parser Tests (macro-generated) ───────────────────

#[test]
fn ada_parses_procedures() {
    let parser = AdaParser::new();
    let file = make_file("main.adb", "with Ada.Text_IO;\nprocedure Main is\nbegin\n  Ada.Text_IO.Put_Line(\"Hello\");\nend Main;");
    let output = parser.parse(&file).unwrap();
    assert!(!output.symbols.is_empty());
}

#[test]
fn perl_parses_subs() {
    let parser = PerlParser::new();
    let file = make_file("app.pl", "#!/usr/bin/perl\nuse strict;\nuse warnings;\n\nsub process_data {\n  my ($input) = @_;\n  return $input * 2;\n}\n\nsub main {\n  print process_data(42);\n}");
    let output = parser.parse(&file).unwrap();
    let subs = output.metadata.get("sub_count").unwrap().as_u64().unwrap();
    assert!(subs >= 2);
}

#[test]
fn tsql_parses_stored_procs() {
    let parser = TsqlParser::new();
    let file = make_file("GetCustomer.sql", "CREATE PROCEDURE dbo.GetCustomer\n  @CustID INT\nAS\nBEGIN\n  SELECT * FROM Customers WHERE ID = @CustID\nEND\nGO");
    let output = parser.parse(&file).unwrap();
    let procs = output.metadata.get("procedure_count").unwrap().as_u64().unwrap();
    assert_eq!(procs, 1);
}

#[test]
fn coldfusion_parses_functions() {
    let parser = ColdFusionParser::new();
    let file = make_file("api.cfc", "component {\n  <cffunction name=\"getUser\">\n    <cfquery name=\"q\">\n      SELECT * FROM users\n    </cfquery>\n  </cffunction>\n}");
    let output = parser.parse(&file).unwrap();
    let funcs = output.metadata.get("function_count").unwrap().as_u64().unwrap();
    assert!(funcs >= 1);
}

// ─── Copybook Resolver Tests ────────────────────────────────────

#[test]
fn resolver_resolves_cobol_copybook() {
    let cobol = CobolParser::new();
    let main_file = make_file("MAIN.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MAIN.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       COPY CUSTCOPY.\n       PROCEDURE DIVISION.\n       MAIN.\n           STOP RUN.");
    let copy_file = make_file("CUSTCOPY.cpy", "       01  WS-CUST-ID  PIC X(10).");

    let mut vault = SourceVault::new(PathBuf::from("."));
    vault.add_file(main_file.clone());
    vault.add_file(copy_file);

    let output = cobol.parse(&main_file).unwrap();
    let deps = cobol.resolve_dependencies(&output, &vault);
    let resolved = resolver::resolve_dependencies(&deps, &vault);

    assert!(resolved.resolution_rate > 0.0, "Should resolve at least one copybook");
    assert!(!resolved.resolved.is_empty(), "Should have resolved refs");
}

#[test]
fn resolver_reports_unresolved() {
    let cobol = CobolParser::new();
    let file = make_file("MAIN.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MAIN.\n       DATA DIVISION.\n       WORKING-STORAGE SECTION.\n       COPY MISSING.\n       PROCEDURE DIVISION.\n       MAIN.\n           STOP RUN.");

    let mut vault = SourceVault::new(PathBuf::from("."));
    vault.add_file(file.clone());

    let output = cobol.parse(&file).unwrap();
    let deps = cobol.resolve_dependencies(&output, &vault);
    let resolved = resolver::resolve_dependencies(&deps, &vault);

    assert!(!resolved.unresolved.is_empty(), "Should have unresolved refs");
}

// ─── Full Pipeline Test ─────────────────────────────────────────

#[test]
fn pipeline_runs_end_to_end() {
    let mut registry = ParserRegistry::new();
    registry.register(Box::new(CobolParser::new()));
    registry.register(Box::new(JclParser::new()));
    registry.register(Box::new(RpgParser::new()));

    let mut vault = SourceVault::new(PathBuf::from("."));
    vault.add_file(make_file("PROG.cbl", "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG.\n       PROCEDURE DIVISION.\n       MAIN.\n           CALL 'SUB1'\n           STOP RUN."));
    vault.add_file(make_file("RUN.jcl", "//JOB1 JOB (ACCT),\"TEST\"\n//STEP1 EXEC PGM=PROG"));

    let report = pipeline::run_pipeline(&vault, &registry);

    assert_eq!(report.summary.total_files, 2);
    assert!(report.summary.languages_detected >= 2);
    assert!(report.summary.files_parsed >= 2);
    assert!(!report.priority_scores.is_empty());
    assert!(!report.llm_strategy.families_detected.is_empty());
}

// ─── All 34 Languages Have Entries ──────────────────────────────

#[test]
fn all_languages_count_is_34() {
    let all = all_languages();
    assert_eq!(all.len(), 34, "Expected 34 languages, got {}", all.len());
}

#[test]
fn every_tier_has_languages() {
    for tier in &[Tier::Tier1, Tier::Tier2, Tier::Tier3, Tier::Tier4] {
        let langs = languages_by_tier(*tier);
        assert!(!langs.is_empty(), "{:?} should have languages", tier);
    }
}
