//! Tier priority scoring — weighted additive formula.
//!
//! Score = (0.30 x EnterpriseDensity) + (0.25 x ModernizationUrgency)
//!       + (0.20 x AvailableTooling) + (0.15 x TalentRisk) + (0.10 x Complexity)
//!
//! Each dimension scored 1-10. Uses weighted addition (not multiplication)
//! because multiplicative formulas collapse when any factor is near-zero.

use crate::languages::tiers::{LanguageEntry, Tier};
use serde::{Deserialize, Serialize};

const W_DENSITY: f64 = 0.30;
const W_URGENCY: f64 = 0.25;
const W_TOOLING: f64 = 0.20;
const W_TALENT: f64 = 0.15;
const W_COMPLEXITY: f64 = 0.10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriorityScore {
    pub language_id: String,
    pub display_name: String,
    pub tier: Tier,
    pub enterprise_density: f64,
    pub modernization_urgency: f64,
    pub available_tooling: f64,
    pub talent_risk: f64,
    pub complexity_factor: f64,
    pub weighted_score: f64,
    pub rank: usize,
}

/// Compute priority scores for a set of detected languages.
pub fn compute_priority_scores(languages: &[&LanguageEntry]) -> Vec<PriorityScore> {
    let mut scores: Vec<PriorityScore> = languages
        .iter()
        .map(|lang| {
            let (density, urgency, tooling, talent, complexity) = default_scores(lang.id);
            let weighted = (W_DENSITY * density)
                + (W_URGENCY * urgency)
                + (W_TOOLING * tooling)
                + (W_TALENT * talent)
                + (W_COMPLEXITY * complexity);

            PriorityScore {
                language_id: lang.id.to_string(),
                display_name: lang.display_name.to_string(),
                tier: lang.tier,
                enterprise_density: density,
                modernization_urgency: urgency,
                available_tooling: tooling,
                talent_risk: talent,
                complexity_factor: complexity,
                weighted_score: weighted,
                rank: 0,
            }
        })
        .collect();

    scores.sort_by(|a, b| b.weighted_score.partial_cmp(&a.weighted_score).unwrap());
    for (i, score) in scores.iter_mut().enumerate() {
        score.rank = i + 1;
    }
    scores
}

/// Default dimension scores based on known language characteristics.
/// In production, these would be calibrated from customer data and market research.
fn default_scores(language_id: &str) -> (f64, f64, f64, f64, f64) {
    // (density, urgency, tooling, talent_risk, complexity)
    match language_id {
        // Tier 1
        "cobol"  => (10.0, 9.0, 7.0, 9.0, 8.0),
        "rpg"    => (7.0, 8.0, 4.0, 9.0, 8.0),
        "cl"     => (7.0, 6.0, 3.0, 7.0, 5.0),
        "jcl"    => (9.0, 7.0, 5.0, 7.0, 6.0),
        "pli"    => (5.0, 8.0, 3.0, 9.0, 9.0),
        // Tier 2
        "abap"   => (9.0, 6.0, 5.0, 5.0, 7.0),
        "vb6"    => (8.0, 8.0, 6.0, 8.0, 6.0),
        "vbnet-legacy" => (7.0, 5.0, 7.0, 4.0, 5.0),
        "asp-classic"  => (6.0, 7.0, 5.0, 6.0, 5.0),
        "sas"    => (8.0, 5.0, 4.0, 5.0, 6.0),
        "powerbuilder" => (5.0, 7.0, 3.0, 8.0, 7.0),
        "delphi" => (5.0, 6.0, 5.0, 6.0, 6.0),
        "natural" => (4.0, 7.0, 2.0, 9.0, 7.0),
        "oracle-forms" => (6.0, 7.0, 4.0, 6.0, 7.0),
        // Tier 3
        "fortran" => (5.0, 4.0, 6.0, 5.0, 7.0),
        "ada"     => (3.0, 3.0, 5.0, 6.0, 8.0),
        "mumps"   => (4.0, 6.0, 2.0, 9.0, 9.0),
        "progress-4gl" => (4.0, 5.0, 3.0, 6.0, 6.0),
        "visual-foxpro" => (3.0, 6.0, 3.0, 7.0, 5.0),
        "smalltalk" => (2.0, 5.0, 3.0, 8.0, 7.0),
        // Database Logic (high extraction value)
        "plsql"  => (9.0, 4.0, 7.0, 3.0, 6.0),
        "tsql"   => (9.0, 3.0, 8.0, 2.0, 5.0),
        "db2sql" => (7.0, 5.0, 4.0, 6.0, 6.0),
        // Default
        _        => (3.0, 3.0, 3.0, 3.0, 5.0),
    }
}
