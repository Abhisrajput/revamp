//! Parser readiness assessment — evaluates parser coverage per language.
//!
//! Status is derived from each parser's self-reported `nir_coverage_pct()`
//! via `ParserStatus::from_coverage()`. No hardcoded status table.

use crate::languages::tiers::{self, ParserStatus};
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
        if let Some(parser) = registry.get(lang_id) {
            let nir = parser.nir_coverage_pct();
            ReadinessEntry {
                language_id: lang_id.clone(),
                display_name: parser.display_name().to_string(),
                parser_status: ParserStatus::from_coverage(nir),
                has_registered_parser: true,
                nir_coverage_pct: nir,
                estimated_dev_effort: parser.estimated_dev_effort().to_string(),
                recommended_backend: parser.recommended_backend().to_string(),
            }
        } else {
            // No registered parser — fall back to static language matrix
            let entry = tiers::find_language(lang_id);
            ReadinessEntry {
                language_id: lang_id.clone(),
                display_name: entry.map_or_else(|| lang_id.clone(), |e| e.display_name.to_string()),
                parser_status: entry.map_or(ParserStatus::Community, |e| e.parser_status),
                has_registered_parser: false,
                nir_coverage_pct: 0.0,
                estimated_dev_effort: "not started".to_string(),
                recommended_backend: "tbd".to_string(),
            }
        }
    }).collect();
    let total = entries.len().max(1) as f64;
    let sum: f64 = entries.iter().map(|e| e.nir_coverage_pct).sum();
    let with_parser = entries.iter().filter(|e| e.has_registered_parser).count();
    ReadinessMatrix {
        overall_coverage: sum / total,
        languages_with_parser: with_parser,
        languages_without_parser: entries.len() - with_parser,
        entries,
    }
}
