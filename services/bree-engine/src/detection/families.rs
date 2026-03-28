//! Language family classification — 9 families for LLM prompt strategy.
//!
//! NATURAL is separate from Mainframe because it's a 4GL intrinsically coupled
//! to Adabas (inverted-list DB), sharing almost no characteristics with COBOL
//! beyond running on mainframes.

use crate::languages::tiers::LanguageFamily;
use serde::{Deserialize, Serialize};

/// Detailed family definition with LLM prompt strategy guidance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamilyDefinition {
    pub family: LanguageFamily,
    pub members: Vec<&'static str>,
    pub shared_characteristics: &'static str,
    pub llm_prompt_focus: &'static str,
    pub key_concepts: Vec<&'static str>,
}

pub fn get_family_definitions() -> Vec<FamilyDefinition> {
    vec![
        FamilyDefinition {
            family: LanguageFamily::IbmI,
            members: vec!["rpg", "cl", "dds", "db2-for-i"],
            shared_characteristics: "Integrated object system, library lists, built-in DB, job queues",
            llm_prompt_focus: "Focus on RPG spec types, CL commands, integrated file system, library list resolution, data areas, and job queue patterns.",
            key_concepts: vec![
                "Library lists and object resolution",
                "Data areas and data queues",
                "Integrated file system (IFS)",
                "RPG cycle processing",
                "Indicator-based logic (01-99, LR, OF)",
                "Physical/Logical file DDS",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::Mainframe,
            members: vec!["cobol", "jcl", "pli", "assembler-zos"],
            shared_characteristics: "z/OS concepts, dataset names, batch processing, CICS/IMS regions",
            llm_prompt_focus: "Focus on COBOL divisions, paragraph flow, PERFORM THRU ranges, copybooks, CICS/IMS transaction processing, JCL job streams, dataset allocation.",
            key_concepts: vec![
                "Dataset naming conventions (HLQ.MLQ.LLQ)",
                "Batch job scheduling and JCL streams",
                "CICS transaction processing (EXEC CICS)",
                "IMS hierarchical DB (EXEC DLI)",
                "VSAM file organizations (KSDS, ESDS, RRDS)",
                "Copybook resolution and nesting",
                "88-level condition names",
                "REDEFINES memory overlays",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::NaturalAdabas,
            members: vec!["natural"],
            shared_characteristics: "4GL coupled to Adabas inverted-list DB, PREDICT data dictionary",
            llm_prompt_focus: "Focus on DEFINE DATA blocks (local/global/parameter), Adabas file descriptors, NATURAL maps for screen I/O, PREDICT metadata. Do NOT conflate with COBOL — fundamentally different paradigm.",
            key_concepts: vec![
                "DEFINE DATA blocks (LOCAL, GLOBAL, PARAMETER)",
                "Adabas inverted-list database",
                "NATURAL maps (screen definitions)",
                "PREDICT data dictionary",
                "Super/sub descriptors",
                "NATURAL Security system",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::SapAbap,
            members: vec!["abap"],
            shared_characteristics: "SAP data dictionary, transport system, enhancement framework",
            llm_prompt_focus: "Focus on SAP data dictionary types, internal tables, ALV reports, BAdI/enhancement points, Dynpro dialog programming, transport requests. SAP-specific patterns differ fundamentally from general-purpose languages.",
            key_concepts: vec![
                "SAP Data Dictionary (DDIC) types",
                "Internal tables and work areas",
                "ALV (SAP List Viewer) reports",
                "BAdI / enhancement points / user exits",
                "Dynpro dialog programming",
                "Transport system and change requests",
                "ABAP Cloud vs classic ABAP",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::WindowsLegacy,
            members: vec!["vb6", "vbnet-legacy", "delphi", "powerbuilder", "visual-foxpro", "smalltalk", "clipper", "silverlight", "lotusscript"],
            shared_characteristics: "COM/COM+, Windows registry, WinForms, event-driven desktop",
            llm_prompt_focus: "Focus on COM interfaces (CLSIDs, ProgIDs), ActiveX/OCX controls, event-driven form code-behind, ADO/DAO data access, Crystal Reports integration, DLL dependencies.",
            key_concepts: vec![
                "COM / ActiveX / OCX component model",
                "Event-driven programming (Click, Load, Change)",
                "Windows registry dependencies",
                "ADO / DAO data access layers",
                "Crystal Reports / report generators",
                "DLL Hell and versioning issues",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::WebLegacy,
            members: vec!["asp-classic", "coldfusion", "perl"],
            shared_characteristics: "HTTP request/response, session state, inline business logic in HTML",
            llm_prompt_focus: "Focus on server-side rendering, session/application state, inline scripting in HTML templates, ADO recordsets (ASP), CGI patterns (Perl), custom tag libraries (CF).",
            key_concepts: vec![
                "Server-side rendering with inline code",
                "Session and Application state",
                "Classic ADO recordsets (ASP)",
                "CGI request handling (Perl)",
                "Server-side includes",
                "Global.asa / Application events",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::Scientific,
            members: vec!["fortran", "sas"],
            shared_characteristics: "Numerical arrays, precision rules, DO loops, COMMON blocks, statistical procedures",
            llm_prompt_focus: "Focus on numerical precision handling, array operations, COMMON/EQUIVALENCE state sharing (Fortran), DATA step vs PROC step (SAS), OpenMP/MPI parallel constructs, format libraries.",
            key_concepts: vec![
                "Fixed-format vs free-format source",
                "COMMON blocks (Fortran shared state)",
                "EQUIVALENCE aliasing (memory overlaps)",
                "DATA step / PROC step (SAS)",
                "SAS macro language (%macro, &vars)",
                "OpenMP / MPI parallel constructs",
                "Numerical precision and rounding",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::SafetyCritical,
            members: vec!["ada"],
            shared_characteristics: "Contracts, tasking, real-time, formal verification (SPARK)",
            llm_prompt_focus: "Focus on Ada's strong typing with subtypes and constraints, tasking model, SPARK formal verification annotations, Ravenscar real-time profile, representation clauses for hardware mapping.",
            key_concepts: vec![
                "Strong typing with subtypes and ranges",
                "Tasking model (concurrent programming)",
                "SPARK contracts (Pre, Post, Global)",
                "Ravenscar profile (real-time)",
                "Generic packages (templates)",
                "Representation clauses (hardware)",
                "DO-178C / EN 50128 compliance",
            ],
        },
        FamilyDefinition {
            family: LanguageFamily::DatabaseLogic,
            members: vec!["plsql", "tsql", "db2sql", "oracle-forms", "mumps", "progress-4gl"],
            shared_characteristics: "Cursors, triggers, stored procedures, set-based thinking, packages",
            llm_prompt_focus: "Focus on stored procedure control flow, cursor handling, trigger logic, package spec/body splits (PL/SQL), dynamic SQL, bulk operations. These are NOT legacy but contain decades of embedded business rules.",
            key_concepts: vec![
                "Stored procedures with complex control flow",
                "Cursor-based record processing",
                "Trigger logic (row-level, statement-level)",
                "Packages with spec/body separation (PL/SQL)",
                "Dynamic SQL (EXECUTE IMMEDIATE, sp_executesql)",
                "Common table expressions and recursive queries",
                "Global variables and hierarchical storage (MUMPS)",
            ],
        },
    ]
}
