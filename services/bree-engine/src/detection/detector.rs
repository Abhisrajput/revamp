//! PolyglotDetector — 5-stage cascade for language detection.
//!
//! Stage 1: Modelines (vim/emacs hints in first 5 lines)
//! Stage 2: Shebangs (#!/usr/bin/perl, etc.)
//! Stage 3: File extensions
//! Stage 4: Content heuristics (IDENTIFICATION DIVISION, dcl-proc, etc.)
//! Stage 5: Bayesian classifier (for ambiguous files)

use crate::detection::signatures::{build_extension_map, SIGNATURES};
use crate::parser::traits::{SourceFile, SourceVault};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Result of polyglot detection for a source vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanguageProfile {
    /// Primary languages detected (highest file count / LOC).
    pub primary: Vec<DetectedLanguage>,
    /// Secondary languages (present but not dominant).
    pub secondary: Vec<DetectedLanguage>,
    /// Database languages found (PL/SQL, T-SQL, DB2 SQL — via embedded blocks).
    pub db_languages: Vec<DetectedLanguage>,
    /// Job control languages (JCL, CL).
    pub job_control: Vec<DetectedLanguage>,
    /// Cross-language call boundaries detected.
    pub polyglot_boundaries: Vec<PolyglotBoundary>,
    /// Per-language confidence scores.
    pub confidence_scores: HashMap<String, f64>,
    /// Files that could not be classified.
    pub unclassified_files: Vec<String>,
    /// Summary statistics.
    pub stats: DetectionStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedLanguage {
    pub language_id: String,
    pub display_name: String,
    pub file_count: usize,
    pub total_lines: usize,
    pub total_bytes: u64,
    pub confidence: f64,
    pub detection_method: DetectionMethod,
    pub sample_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DetectionMethod {
    Modeline,
    Shebang,
    Extension,
    ContentHeuristic,
    BayesianClassifier,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolyglotBoundary {
    pub from_language: String,
    pub to_language: String,
    pub mechanism: String,
    pub file_references: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DetectionStats {
    pub total_files: usize,
    pub classified_files: usize,
    pub unclassified_files: usize,
    pub languages_found: usize,
    pub total_lines: usize,
}

pub struct PolyglotDetector;

impl PolyglotDetector {
    pub fn new() -> Self { Self }

    /// Run the full 5-stage detection cascade on a source vault.
    pub fn detect(&self, vault: &SourceVault) -> LanguageProfile {
        let ext_map = build_extension_map();
        // Pre-compute uppercased header patterns once for all files (H2 fix).
        let upper_patterns = Self::build_upper_patterns();
        let mut lang_files: HashMap<String, (Vec<&SourceFile>, DetectionMethod)> = HashMap::new();
        let mut lang_confidence: HashMap<String, f64> = HashMap::new();
        let mut unclassified = Vec::new();

        for file in &vault.files {
            let mut detected = false;

            // Stage 1: Modelines
            if let Some(lang_id) = self.detect_modeline(file) {
                lang_files.entry(lang_id.to_string()).or_insert_with(|| (Vec::new(), DetectionMethod::Modeline)).0.push(file);
                lang_confidence.insert(lang_id.to_string(), 0.99);
                detected = true;
            }

            // Stage 2: Shebangs
            if !detected {
                if let Some(lang_id) = self.detect_shebang(file) {
                    lang_files.entry(lang_id.to_string()).or_insert_with(|| (Vec::new(), DetectionMethod::Shebang)).0.push(file);
                    lang_confidence.insert(lang_id.to_string(), 0.95);
                    detected = true;
                }
            }

            // Stage 3: Extension
            if !detected {
                if let Some(candidates) = ext_map.get(file.extension.as_str()) {
                    if candidates.len() == 1 {
                        let sig = SIGNATURES.iter().find(|s| s.language_id == candidates[0]);
                        let conf = sig.map(|s| s.extension_confidence).unwrap_or(0.7);
                        lang_files.entry(candidates[0].to_string()).or_insert_with(|| (Vec::new(), DetectionMethod::Extension)).0.push(file);
                        lang_confidence.entry(candidates[0].to_string())
                            .and_modify(|c| *c = c.max(conf))
                            .or_insert(conf);
                        detected = true;
                    } else {
                        // Ambiguous extension — fall through to content heuristics
                    }
                }
            }

            // Stage 4: Content heuristics
            if !detected {
                if let Some((lang_id, conf)) = self.detect_by_content_with_cache(file, &upper_patterns) {
                    lang_files.entry(lang_id.to_string()).or_insert_with(|| (Vec::new(), DetectionMethod::ContentHeuristic)).0.push(file);
                    lang_confidence.entry(lang_id.to_string())
                        .and_modify(|c| *c = c.max(conf))
                        .or_insert(conf);
                    detected = true;
                }
            }

            // Stage 5: Bayesian classifier (stub — would need training data)
            if !detected {
                unclassified.push(file.path.to_string_lossy().to_string());
            }
        }

        // Build detected language entries
        let mut all_detected: Vec<DetectedLanguage> = lang_files
            .iter()
            .map(|(lang_id, (files, method))| {
                let total_lines: usize = files.iter().map(|f| f.content.lines().count()).sum();
                let total_bytes: u64 = files.iter().map(|f| f.size).sum();
                let display_name = SIGNATURES
                    .iter()
                    .find(|s| s.language_id == lang_id)
                    .map(|s| s.language_id)
                    .unwrap_or(lang_id.as_str());

                DetectedLanguage {
                    language_id: lang_id.clone(),
                    display_name: display_name.to_string(),
                    file_count: files.len(),
                    total_lines,
                    total_bytes,
                    confidence: *lang_confidence.get(lang_id).unwrap_or(&0.5),
                    detection_method: method.clone(),
                    sample_files: files.iter().take(5).map(|f| f.path.to_string_lossy().to_string()).collect(),
                }
            })
            .collect();

        all_detected.sort_by(|a, b| b.total_lines.cmp(&a.total_lines));

        // Split into categories
        let db_ids = ["plsql", "tsql", "db2sql"];
        let jc_ids = ["jcl", "cl"];

        let primary: Vec<_> = all_detected.iter()
            .filter(|l| !db_ids.contains(&l.language_id.as_str()) && !jc_ids.contains(&l.language_id.as_str()))
            .take(3)
            .cloned()
            .collect();
        let secondary: Vec<_> = all_detected.iter()
            .filter(|l| !db_ids.contains(&l.language_id.as_str()) && !jc_ids.contains(&l.language_id.as_str()))
            .skip(3)
            .cloned()
            .collect();
        let db_languages: Vec<_> = all_detected.iter()
            .filter(|l| db_ids.contains(&l.language_id.as_str()))
            .cloned()
            .collect();
        let job_control: Vec<_> = all_detected.iter()
            .filter(|l| jc_ids.contains(&l.language_id.as_str()))
            .cloned()
            .collect();

        let stats = DetectionStats {
            total_files: vault.files.len(),
            classified_files: vault.files.len() - unclassified.len(),
            unclassified_files: unclassified.len(),
            languages_found: all_detected.len(),
            total_lines: vault.total_lines(),
        };

        LanguageProfile {
            primary,
            secondary,
            db_languages,
            job_control,
            polyglot_boundaries: vec![], // TODO: implement boundary detection
            confidence_scores: lang_confidence,
            unclassified_files: unclassified,
            stats,
        }
    }

    fn detect_modeline(&self, file: &SourceFile) -> Option<&'static str> {
        for line in file.content.lines().take(5) {
            // vim: set ft=cobol
            if line.contains("vim:") && line.contains("ft=") {
                let ft = line.split("ft=").nth(1)?
                    .split_whitespace().next()?
                    .trim_end_matches(':');
                return match ft {
                    "cobol" => Some("cobol"),
                    "rpg" | "rpgle" => Some("rpg"),
                    "sas" => Some("sas"),
                    _ => None,
                };
            }
        }
        None
    }

    fn detect_shebang(&self, file: &SourceFile) -> Option<&'static str> {
        let first_line = file.content.lines().next()?;
        if !first_line.starts_with("#!") { return None; }
        if first_line.contains("perl") { return Some("perl"); }
        if first_line.contains("python") { return Some("python"); }
        None
    }

    /// Pre-compute uppercased header patterns so they aren't re-allocated per file.
    fn build_upper_patterns() -> Vec<(&'static str, Vec<String>, f64)> {
        SIGNATURES.iter().map(|sig| {
            let upper_patterns: Vec<String> = sig.header_patterns.iter()
                .map(|p| p.to_uppercase())
                .collect();
            (sig.language_id, upper_patterns, sig.content_confidence)
        }).collect()
    }

    fn detect_by_content_with_cache(
        &self,
        file: &SourceFile,
        upper_patterns: &[(&'static str, Vec<String>, f64)],
    ) -> Option<(&'static str, f64)> {
        let upper_header = file.header.to_uppercase();
        for (lang_id, patterns, confidence) in upper_patterns {
            for pattern in patterns {
                if upper_header.contains(pattern.as_str()) {
                    return Some((lang_id, *confidence));
                }
            }
        }
        None
    }
}

impl Default for PolyglotDetector {
    fn default() -> Self { Self::new() }
}
