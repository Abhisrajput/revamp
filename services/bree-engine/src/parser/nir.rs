//! Two-layer Intermediate Representation for BREE.
//!
//! Layer 1: ParseOutput — Language-specific AST preserving full semantics.
//! Layer 2: AnalysisGraph — Normalized cross-language analysis structure.
//!
//! The key insight: you cannot normalize COBOL (REDEFINES, paragraph flow, 88-levels)
//! and RPG (indicators, cycle processing, built-in I/O) into the same flat IR without
//! losing critical information. So we keep both layers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── LAYER 1: Language-Specific Parse Output ────────────────────

/// Full parse result preserving language-specific semantics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseOutput {
    /// Language identifier (e.g., "cobol-85").
    pub language_id: String,
    /// Detected dialect version.
    pub dialect: String,
    /// Source file path.
    pub source_path: String,
    /// Total lines parsed.
    pub total_lines: usize,
    /// Language-specific AST nodes (polymorphic per language).
    pub ast_nodes: Vec<AstNode>,
    /// Symbols defined in this module (functions, paragraphs, data items, etc.).
    pub symbols: Vec<Symbol>,
    /// Embedded language blocks (e.g., EXEC SQL in COBOL, EXEC CICS).
    pub embedded_blocks: Vec<EmbeddedBlock>,
    /// Parse diagnostics (warnings, errors recovered from).
    pub diagnostics: Vec<Diagnostic>,
    /// Language-specific metadata (e.g., COBOL divisions, RPG specs).
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Partial parse result when full parsing fails.
/// Returns whatever was successfully parsed before the error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartialParseOutput {
    pub output: ParseOutput,
    /// Lines successfully parsed before failure.
    pub parsed_up_to_line: usize,
    /// The error that stopped full parsing.
    pub error: String,
    /// Percentage of file successfully parsed (0.0 - 1.0).
    pub coverage: f64,
}

/// Generic AST node — language-specific details stored in `kind` and `properties`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstNode {
    pub id: String,
    pub kind: AstNodeKind,
    pub name: Option<String>,
    pub span: Span,
    pub children: Vec<String>,
    pub properties: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AstNodeKind {
    // Structural
    Module,
    Division,       // COBOL: IDENTIFICATION, DATA, PROCEDURE, ENVIRONMENT
    Section,        // COBOL: FILE SECTION, WORKING-STORAGE, etc.
    Paragraph,      // COBOL paragraph, RPG subroutine
    Procedure,      // PL/I PROCEDURE, Ada subprogram
    Function,
    Block,

    // Data
    DataDeclaration, // COBOL 01-level, RPG D-spec, PL/I DECLARE
    DataGroup,       // COBOL group items, RPG data structures
    Redefines,       // COBOL REDEFINES (critical — memory overlay)
    LevelCondition,  // COBOL 88-level conditions
    FileDeclaration,

    // Control flow
    IfStatement,
    EvaluateStatement, // COBOL EVALUATE (switch/case)
    PerformStatement,  // COBOL PERFORM (loop/call hybrid)
    CallStatement,
    GoToStatement,
    Loop,

    // I/O
    ReadStatement,
    WriteStatement,
    DisplayStatement,

    // Business logic
    ComputeStatement,  // COBOL COMPUTE, RPG EVAL
    MoveStatement,     // COBOL MOVE
    Condition,
    Assignment,

    // Embedded
    ExecSqlBlock,      // EXEC SQL ... END-EXEC
    ExecCicsBlock,     // EXEC CICS ... END-EXEC
    CopyStatement,     // COBOL COPY, RPG /COPY

    // Language-specific extensibility
    Custom(String),
}

/// Source location span.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Span {
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
}

/// Symbol defined in the source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub span: Span,
    pub visibility: Visibility,
    pub data_type: Option<String>,
    pub properties: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SymbolKind {
    Program,
    Paragraph,
    Section,
    DataItem,
    FileDescription,
    Index,
    Condition88,
    Subroutine,
    Procedure,
    Function,
    Variable,
    Constant,
    Custom(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Visibility {
    Public,
    Private,
    Internal,
}

/// Embedded language block within host language.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedBlock {
    pub language: String,
    pub content: String,
    pub span: Span,
    pub block_type: EmbeddedBlockType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EmbeddedBlockType {
    ExecSql,
    ExecCics,
    ExecDli,
    InlineAssembly,
    HtmlTemplate,
    Custom(String),
}

/// Parse diagnostic message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub span: Span,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

// ─── LAYER 2: Normalized Analysis Graph ─────────────────────────

/// Cross-language analysis graph — the uniform layer for business rule extraction,
/// dependency mapping, and polyglot boundary detection.
///
/// This is intentionally lossy: it captures what matters for modernization analysis
/// without preserving every language-specific nuance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisGraph {
    pub source_language: String,
    pub source_path: String,
    pub nodes: Vec<AnalysisNode>,
    pub edges: Vec<AnalysisEdge>,
    pub business_rules: Vec<BusinessRule>,
    pub data_flows: Vec<DataFlow>,
}

/// A node in the analysis graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisNode {
    pub id: String,
    pub kind: AnalysisNodeKind,
    pub name: String,
    pub source_span: Span,
    pub properties: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AnalysisNodeKind {
    EntryPoint,
    BusinessRule,
    DataTransformation,
    ExternalCall,
    DatabaseOperation,
    FileOperation,
    UIInteraction,
    ErrorHandler,
    ControlFlow,
}

/// An edge connecting two analysis nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEdge {
    pub from: String,
    pub to: String,
    pub kind: AnalysisEdgeKind,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AnalysisEdgeKind {
    ControlFlow,
    DataFlow,
    Dependency,
    CallsInto,
    ReadsFrom,
    WritesTo,
}

/// A business rule extracted from code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusinessRule {
    pub id: String,
    pub description: String,
    pub rule_type: BusinessRuleType,
    pub source_span: Span,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BusinessRuleType {
    Validation,
    Calculation,
    Authorization,
    Workflow,
    Constraint,
}

/// A data flow path through the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataFlow {
    pub id: String,
    pub description: String,
    pub source_node: String,
    pub sink_node: String,
    pub transformations: Vec<String>,
}

// ─── Cross-Module Dependencies ──────────────────────────────────

/// A dependency reference between modules.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyRef {
    pub from_module: String,
    pub to_module: String,
    pub dependency_type: DependencyType,
    pub source_span: Span,
    /// The actual reference text (e.g., "COPY CUSTFILE", "CALL 'PROGA'").
    pub reference_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DependencyType {
    /// COBOL COPY, RPG /COPY, PL/I %INCLUDE
    CopyInclude,
    /// COBOL CALL, RPG CALLP, PL/I CALL
    ProgramCall,
    /// EXEC SQL, embedded DB access
    DatabaseAccess,
    /// File I/O operations
    FileAccess,
    /// External system integration (API, queue, etc.)
    ExternalSystem,
    /// Cross-language boundary (e.g., COBOL calling JCL)
    CrossLanguage { target_language: String },
}
