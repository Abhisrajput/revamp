//! Cross-language boundary mapper — identifies how languages interact
//! within a polyglot codebase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolyglotAnalysis {
    pub boundaries: Vec<LanguageBoundary>,
    pub complexity_score: f64,
    pub recommendations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanguageBoundary {
    pub from_language: String,
    pub to_language: String,
    pub mechanism: BoundaryMechanism,
    pub occurrence_count: usize,
    pub example_files: Vec<String>,
    pub migration_impact: MigrationImpact,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BoundaryMechanism {
    /// COBOL CALL 'PROGRAM', RPG CALLP
    ProgramCall,
    /// EXEC SQL ... END-EXEC, EXEC CICS ... END-EXEC
    EmbeddedLanguage,
    /// COM/ActiveX invocation
    ComInterface,
    /// JNI, FFI, ctypes
    ForeignFunctionInterface,
    /// File-based data exchange (CSV, XML, flat files)
    FileExchange,
    /// Message queue (MQ Series, RabbitMQ)
    MessageQueue,
    /// Shared database tables
    SharedDatabase,
    /// JCL EXEC PGM=... invoking programs
    JobControl,
    /// CL CALL PGM(...) invoking RPG/COBOL
    CommandLanguage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MigrationImpact {
    /// Both sides must migrate together
    TightCoupling,
    /// Can migrate independently with adapter layer
    LooseCoupling,
    /// Standard protocol — independent migration
    StandardInterface,
}

/// Known polyglot patterns in enterprise systems.
pub fn known_polyglot_patterns() -> Vec<PolyglotPattern> {
    vec![
        PolyglotPattern {
            name: "IBM i Stack",
            languages: vec!["rpg", "cl", "dds", "db2sql"],
            description: "RPG programs call CL programs, CL manipulates environment, DDS defines files/screens, both use DB2 for i",
            boundaries: vec![
                ("rpg", "cl", BoundaryMechanism::ProgramCall),
                ("cl", "rpg", BoundaryMechanism::CommandLanguage),
                ("rpg", "db2sql", BoundaryMechanism::EmbeddedLanguage),
                ("rpg", "dds", BoundaryMechanism::SharedDatabase),
                ("cl", "dds", BoundaryMechanism::SharedDatabase),
                ("cl", "db2sql", BoundaryMechanism::EmbeddedLanguage),
                ("dds", "dds", BoundaryMechanism::SharedDatabase),
            ],
        },
        PolyglotPattern {
            name: "z/OS Mainframe Stack",
            languages: vec!["cobol", "jcl", "pli", "db2sql", "assembler-zos"],
            description: "JCL orchestrates COBOL/PL/I programs, embedded DB2 SQL and CICS calls",
            boundaries: vec![
                ("jcl", "cobol", BoundaryMechanism::JobControl),
                ("cobol", "cobol", BoundaryMechanism::ProgramCall),
                ("cobol", "db2sql", BoundaryMechanism::EmbeddedLanguage),
                ("cobol", "pli", BoundaryMechanism::ProgramCall),
            ],
        },
        PolyglotPattern {
            name: "Windows Desktop + COM",
            languages: vec!["vb6", "delphi", "asp-classic"],
            description: "VB6 forms invoke COM/ActiveX components, some written in Delphi or C++",
            boundaries: vec![
                ("vb6", "delphi", BoundaryMechanism::ComInterface),
                ("asp-classic", "vb6", BoundaryMechanism::ComInterface),
            ],
        },
        PolyglotPattern {
            name: "Oracle Stack",
            languages: vec!["oracle-forms", "plsql"],
            description: "Oracle Forms with PL/SQL triggers calling stored procedures in the database",
            boundaries: vec![
                ("oracle-forms", "plsql", BoundaryMechanism::EmbeddedLanguage),
            ],
        },
        PolyglotPattern {
            name: "NATURAL/Adabas Stack",
            languages: vec!["natural", "cobol"],
            description: "NATURAL programs on Adabas, sometimes calling COBOL modules for batch processing",
            boundaries: vec![
                ("natural", "cobol", BoundaryMechanism::ProgramCall),
            ],
        },
    ]
}

#[derive(Debug, Clone)]
pub struct PolyglotPattern {
    pub name: &'static str,
    pub languages: Vec<&'static str>,
    pub description: &'static str,
    pub boundaries: Vec<(&'static str, &'static str, BoundaryMechanism)>,
}
