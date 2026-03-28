//! LLM strategy selector — maps detected language families to prompt strategies.

use crate::detection::detector::LanguageProfile;
use crate::detection::families::get_family_definitions;
use crate::languages::tiers::LanguageFamily;
use crate::llm::prompts;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmStrategy {
    pub families_detected: Vec<FamilyStrategy>,
    pub total_prompt_templates_needed: usize,
    pub recommendation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamilyStrategy {
    pub family: LanguageFamily,
    pub languages_in_project: Vec<String>,
    pub system_prompt: String,
    pub key_concepts: Vec<String>,
    pub prompt_focus: String,
}

/// Given a language profile, determine the optimal LLM prompt strategy.
pub fn select_strategy(profile: &LanguageProfile) -> LlmStrategy {
    let family_defs = get_family_definitions();
    let all_detected: Vec<&str> = profile
        .primary
        .iter()
        .chain(profile.secondary.iter())
        .chain(profile.db_languages.iter())
        .chain(profile.job_control.iter())
        .map(|l| l.language_id.as_str())
        .collect();

    let mut families_used: HashMap<LanguageFamily, Vec<String>> = HashMap::new();

    for def in &family_defs {
        let matching: Vec<String> = def
            .members
            .iter()
            .filter(|m| all_detected.contains(m))
            .map(|m| m.to_string())
            .collect();

        if !matching.is_empty() {
            families_used.insert(def.family, matching);
        }
    }

    let family_strategies: Vec<FamilyStrategy> = families_used
        .iter()
        .map(|(family, langs)| {
            let def = family_defs.iter().find(|d| d.family == *family);
            FamilyStrategy {
                family: *family,
                languages_in_project: langs.clone(),
                system_prompt: prompts::family_system_prompt(family).to_string(),
                key_concepts: def
                    .map(|d| d.key_concepts.iter().map(|s| s.to_string()).collect())
                    .unwrap_or_default(),
                prompt_focus: def.map(|d| d.llm_prompt_focus.to_string()).unwrap_or_default(),
            }
        })
        .collect();

    let count = family_strategies.len();
    let recommendation = if count <= 2 {
        format!("{} language families detected. Single LLM session with family-specific system prompts will suffice.", count)
    } else if count <= 4 {
        format!("{} language families detected. Use dedicated LLM sessions per family for optimal extraction quality.", count)
    } else {
        format!("{} language families detected. Complex polyglot system — recommend phased extraction: process Tier 1 families first, then expand.", count)
    };

    LlmStrategy {
        families_detected: family_strategies,
        total_prompt_templates_needed: count,
        recommendation,
    }
}
