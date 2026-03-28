//! ParserRegistry — manages registered language parsers.
//!
//! Same pattern as providers.Registry in the Go LLM orchestrator:
//! HashMap of registered parsers, lookup by language ID or file.

use crate::parser::traits::{LanguageParser, SourceFile};
use std::collections::HashMap;
use tracing::info;

/// Central registry for all language parsers.
/// New language = new plugin registration, zero core changes.
pub struct ParserRegistry {
    parsers: HashMap<String, Box<dyn LanguageParser>>,
}

impl ParserRegistry {
    pub fn new() -> Self {
        Self {
            parsers: HashMap::new(),
        }
    }

    /// Register a new language parser.
    pub fn register(&mut self, parser: Box<dyn LanguageParser>) {
        let id = parser.language_id().to_string();
        let name = parser.display_name();
        let dialects = parser.supported_dialects();
        info!(
            language_id = %id,
            display_name = %name,
            dialects = ?dialects,
            "Registered language parser"
        );
        self.parsers.insert(id, parser);
    }

    /// Find a parser that can handle the given file.
    /// Prioritizes extension match over content match to avoid false positives
    /// (e.g. T-SQL's "GO" matching COBOL's "GOBACK").
    pub fn find_parser(&self, file: &SourceFile) -> Option<&dyn LanguageParser> {
        // First pass: match by file extension (strongest signal)
        if !file.extension.is_empty() {
            for p in self.parsers.values() {
                if p.file_extensions().contains(&file.extension.as_str()) {
                    return Some(p.as_ref());
                }
            }
        }
        // Second pass: match by content heuristics
        self.parsers
            .values()
            .find(|p| p.can_parse(file))
            .map(|p| p.as_ref())
    }

    /// Get a parser by language ID.
    pub fn get(&self, language_id: &str) -> Option<&dyn LanguageParser> {
        self.parsers.get(language_id).map(|p| p.as_ref())
    }

    /// List all registered language IDs.
    pub fn registered_languages(&self) -> Vec<&str> {
        self.parsers.values().map(|p| p.language_id()).collect()
    }

    /// Count of registered parsers.
    pub fn count(&self) -> usize {
        self.parsers.len()
    }

    /// Get details for all registered parsers.
    pub fn parser_details(&self) -> Vec<ParserInfo> {
        self.parsers
            .values()
            .map(|p| ParserInfo {
                language_id: p.language_id().to_string(),
                display_name: p.display_name().to_string(),
                dialects: p.supported_dialects().iter().map(|s| s.to_string()).collect(),
                extensions: p.file_extensions().iter().map(|s| s.to_string()).collect(),
            })
            .collect()
    }
}

impl Default for ParserRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Summary info about a registered parser.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ParserInfo {
    pub language_id: String,
    pub display_name: String,
    pub dialects: Vec<String>,
    pub extensions: Vec<String>,
}
