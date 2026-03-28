//! Business rule extraction — transforms conditional logic and calculations
//! into meaningful, human-readable business rule descriptions.
//!
//! Instead of echoing raw COBOL syntax ("IF IS-CLOSED"), produces natural
//! language: "Reject transaction when account status is closed".

use crate::analysis::util::{humanize, capitalize};
use crate::parser::nir::{AstNodeKind, ParseOutput};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct BusinessRuleReport {
    pub rules: Vec<ExtractedRule>,
    pub total_rules: usize,
    pub by_type: RuleTypeCounts,
    pub high_confidence_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtractedRule {
    pub id: String,
    pub name: String,
    pub rule_type: String,
    pub description: String,
    pub source_file: String,
    pub source_line: usize,
    pub condition: String,
    pub confidence: f64,
    pub complexity: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hardcoded_values: Vec<HardcodedValue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HardcodedValue {
    pub value: String,
    pub meaning: String,
    pub risk: &'static str,
    pub recommendation: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RuleTypeCounts {
    pub validation: usize,
    pub calculation: usize,
    pub authorization: usize,
    pub workflow: usize,
    pub constraint: usize,
}

/// Extract business rules from parsed outputs by analyzing conditionals and calculations.
pub fn extract_rules(outputs: &[&ParseOutput]) -> BusinessRuleReport {
    let mut rules = Vec::new();
    let mut rule_id = 0;
    let mut counts = RuleTypeCounts::default();

    for output in outputs {
        let short_file = output.source_path.rsplit('/').next().unwrap_or(&output.source_path);

        for node in &output.ast_nodes {
            match &node.kind {
                AstNodeKind::IfStatement => {
                    if let Some(cond) = node.properties.get("condition").and_then(|v| v.as_str()) {
                        if cond.len() < 5 { continue; }
                        rule_id += 1;

                        let interp = interpret_condition(cond);
                        match interp.rule_type {
                            "validation" => counts.validation += 1,
                            "calculation" => counts.calculation += 1,
                            "authorization" => counts.authorization += 1,
                            "workflow" => counts.workflow += 1,
                            _ => counts.constraint += 1,
                        }

                        rules.push(ExtractedRule {
                            id: format!("BR-{:04}", rule_id),
                            name: interp.name,
                            rule_type: interp.rule_type.to_string(),
                            description: interp.description,
                            source_file: short_file.to_string(),
                            source_line: node.span.start_line,
                            condition: cond.to_string(),
                            confidence: interp.confidence,
                            complexity: cond.matches(" AND ").count() as u32
                                + cond.matches(" OR ").count() as u32 + 1,
                            hardcoded_values: detect_hardcoded(cond),
                        });
                    }
                }
                AstNodeKind::EvaluateStatement => {
                    if let Some(subject) = &node.name {
                        rule_id += 1;
                        counts.workflow += 1;
                        let readable = humanize(subject);
                        rules.push(ExtractedRule {
                            id: format!("BR-{:04}", rule_id),
                            name: format!("{} routing logic", capitalize(&readable)),
                            rule_type: "workflow".to_string(),
                            description: format!(
                                "Route processing based on {} — each value triggers a different business action",
                                readable
                            ),
                            source_file: short_file.to_string(),
                            source_line: node.span.start_line,
                            condition: subject.clone(),
                            confidence: 0.92,
                            complexity: 3,
                            hardcoded_values: vec![],
                        });
                    }
                }
                AstNodeKind::ComputeStatement => {
                    if let Some(expr) = node.properties.get("expr").and_then(|v| v.as_str()) {
                        if expr.contains('*') || expr.contains('/') || (expr.contains('+') && expr.contains('-')) {
                            rule_id += 1;
                            counts.calculation += 1;
                            let interp = interpret_computation(expr);
                            rules.push(ExtractedRule {
                                id: format!("BR-{:04}", rule_id),
                                name: interp.name,
                                rule_type: "calculation".to_string(),
                                description: interp.description,
                                source_file: short_file.to_string(),
                                source_line: node.span.start_line,
                                condition: expr.to_string(),
                                confidence: 0.95,
                                complexity: 1,
                                hardcoded_values: detect_hardcoded(expr),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let high_conf = rules.iter().filter(|r| r.confidence >= 0.8).count();
    BusinessRuleReport {
        total_rules: rules.len(),
        by_type: counts,
        high_confidence_count: high_conf,
        rules,
    }
}

// ─── Condition Interpreter ──────────────────────────────────────────

struct Interpretation {
    name: String,
    rule_type: &'static str,
    description: String,
    confidence: f64,
}

fn interpret_condition(cond: &str) -> Interpretation {
    let upper = cond.to_uppercase();

    // 88-level / boolean status checks (any language):
    // COBOL: IS-CLOSED, IS-ACTIVE | RPG: *INLR, *IN03 | VB6: IsValid, bActive
    if upper.starts_with("IS-") || upper.starts_with("NOT IS-")
        || upper.starts_with("IS_") || upper.starts_with("NOT IS_")
        || upper.starts_with("*IN") // RPG indicators
    {
        let negated = upper.starts_with("NOT ");
        let name_part = if negated { &upper[4..] } else { &upper[..] };
        let status = humanize(name_part.trim_start_matches("IS-").trim_start_matches("IS_").trim_start_matches("*IN"));
        let action = if negated { "is not" } else { "is" };
        return Interpretation {
            name: format!("{} status check", capitalize(&status)),
            rule_type: "validation",
            description: format!(
                "Guard: reject or branch when status {} {}",
                action, status
            ),
            confidence: 0.95,
        };
    }

    // Compound conditions with AND/OR
    if upper.contains(" AND ") || upper.contains(" OR ") {
        let parts: Vec<&str> = upper.split(" AND ").flat_map(|s| s.split(" OR ")).collect();
        let readable_parts: Vec<String> = parts.iter().map(|p| humanize_condition(p.trim())).collect();
        let joiner = if upper.contains(" AND ") { " AND " } else { " OR " };
        return Interpretation {
            name: format!("Compound validation ({})", readable_parts.first().unwrap_or(&"check".to_string())),
            rule_type: if upper.contains("AMOUNT") || upper.contains("BALANCE") { "calculation" } else { "validation" },
            description: format!(
                "Validate that {}",
                readable_parts.join(joiner)
            ),
            confidence: 0.92,
        };
    }

    // Return code / error checking
    if (upper.contains("RETURN-CODE") || upper.contains("SQLCODE") || upper.contains("STATUS")) && upper.contains("=") {
        let is_success = upper.contains("= 0") && !upper.contains("NOT");
        let is_failure = upper.contains("NOT = 0") || upper.contains("NOT EQUAL 0")
            || upper.contains("> 0") || upper.contains("< 0");
        return Interpretation {
            name: "Processing status check".to_string(),
            rule_type: "validation",
            description: if is_success {
                "Continue processing only when prior step completed successfully (status = 0)".to_string()
            } else if is_failure {
                "Error handling: branch to error path when processing step reports a failure".to_string()
            } else {
                format!("Check processing status: {}", humanize_condition(&upper))
            },
            confidence: 0.90,
        };
    }

    // Amount/balance comparisons
    if upper.contains("AMOUNT") || upper.contains("BALANCE") || upper.contains("TOTAL") {
        let readable = humanize_condition(&upper);
        return Interpretation {
            name: "Financial threshold check".to_string(),
            rule_type: "calculation",
            description: format!("Validate that {}", readable),
            confidence: 0.92,
        };
    }

    // Type/code matching
    if upper.contains("TYPE") || upper.contains("CODE") || upper.contains("FLAG") {
        let readable = humanize_condition(&upper);
        return Interpretation {
            name: "Classification check".to_string(),
            rule_type: "constraint",
            description: format!("Branch based on {}", readable),
            confidence: 0.90,
        };
    }

    // Authorization / security
    if upper.contains("AUTH") || upper.contains("ROLE") || upper.contains("PERMISSION")
        || upper.contains("ACCESS") || upper.contains("SECURITY") {
        return Interpretation {
            name: "Authorization check".to_string(),
            rule_type: "authorization",
            description: format!("Verify access: {}", humanize_condition(&upper)),
            confidence: 0.95,
        };
    }

    // Threshold / limit checks
    if upper.contains(">") || upper.contains("<") {
        let readable = humanize_condition(&upper);
        return Interpretation {
            name: "Threshold check".to_string(),
            rule_type: "constraint",
            description: format!("Enforce limit: {}", readable),
            confidence: 0.90,
        };
    }

    // Default
    Interpretation {
        name: "Business condition".to_string(),
        rule_type: "constraint",
        description: format!("Conditional logic: {}", humanize_condition(&upper)),
        confidence: 0.85,
    }
}

// ─── Computation Interpreter ────────────────────────────────────────

fn interpret_computation(expr: &str) -> Interpretation {
    let upper = expr.to_uppercase();

    // Split on = to get target and formula
    let parts: Vec<&str> = upper.splitn(2, '=').collect();
    if parts.len() != 2 {
        return Interpretation {
            name: "Calculation".to_string(),
            rule_type: "calculation",
            description: format!("Calculate: {}", humanize(expr)),
            confidence: 0.90,
        };
    }

    let target = parts[0].trim();
    let formula = parts[1].trim();
    let target_name = humanize(target);

    // Percentage calculations: X * 0.0nn
    if let Some(pct) = extract_percentage(formula) {
        let base = extract_base_var(formula);
        let base_name = humanize(&base);

        // Detect rate patterns: X * rate / 12 (monthly)
        if formula.contains("/ 12") {
            let annual_pct = pct;
            return Interpretation {
                name: format!("Monthly {} calculation", target_name),
                rule_type: "calculation",
                description: format!(
                    "Calculate monthly {}: {:.1}% annual rate on {}, compounded monthly (÷ 12)",
                    target_name, annual_pct, base_name
                ),
                confidence: 0.95,
            };
        }

        return Interpretation {
            name: format!("{} calculation", capitalize(&target_name)),
            rule_type: "calculation",
            description: format!(
                "Calculate {} as {:.1}% of {}",
                target_name, pct, base_name
            ),
            confidence: 0.95,
        };
    }

    // Subtraction: A - B
    if formula.contains('-') && !formula.contains('*') && !formula.contains('/') {
        let operands: Vec<&str> = formula.split('-').collect();
        if operands.len() == 2 {
            return Interpretation {
                name: format!("Net {} calculation", target_name),
                rule_type: "calculation",
                description: format!(
                    "Calculate {} = {} minus {}",
                    target_name, humanize(operands[0].trim()), humanize(operands[1].trim())
                ),
                confidence: 0.93,
            };
        }
    }

    // Generic formula
    Interpretation {
        name: format!("{} formula", capitalize(&target_name)),
        rule_type: "calculation",
        description: format!("Derive {} from formula: {}", target_name, humanize_formula(formula)),
        confidence: 0.92,
    }
}

// ─── Helpers ────────────────────────────────────────────────────────


/// Humanize a condition expression.
fn humanize_condition(cond: &str) -> String {
    let mut s = cond.to_string();
    // Replace COBOL comparison operators
    s = s.replace(" NOT = ", " ≠ ").replace(" NOT EQUAL ", " ≠ ");
    s = s.replace(" GREATER THAN ", " > ").replace(" LESS THAN ", " < ");

    // Humanize variable names in the condition
    let words: Vec<String> = s.split_whitespace().map(|w| {
        let clean = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
        if clean.contains('-') && clean.len() > 3 && clean.chars().all(|c| c.is_alphanumeric() || c == '-') {
            humanize(clean)
        } else {
            w.to_lowercase()
        }
    }).collect();

    words.join(" ")
}

/// Humanize a formula expression.
fn humanize_formula(formula: &str) -> String {
    let mut result = formula.to_string();
    // Find and replace COBOL variable names
    let tokens: Vec<&str> = formula.split(|c: char| c == '*' || c == '/' || c == '+' || c == '-' || c == '(' || c == ')')
        .collect();
    for token in tokens {
        let t = token.trim();
        if t.contains('-') && t.len() > 3 && t.chars().all(|c| c.is_alphanumeric() || c == '-') {
            result = result.replace(t, &humanize(t));
        }
    }
    result.to_lowercase()
}

/// Extract percentage from formula like "X * 0.015" → 1.5
fn extract_percentage(formula: &str) -> Option<f64> {
    for token in formula.split(|c: char| c == '*' || c == '/' || c == '+' || c == '-') {
        let t = token.trim();
        if let Ok(val) = t.parse::<f64>() {
            if val > 0.0 && val < 1.0 {
                return Some(val * 100.0);
            }
        }
    }
    None
}

/// Extract the base variable from a formula.
fn extract_base_var(formula: &str) -> String {
    for token in formula.split('*') {
        let t = token.trim().trim_matches(|c: char| c == '(' || c == ')');
        if t.parse::<f64>().is_err() && t.len() > 2 {
            // Not a number, likely a variable
            let clean = t.split('/').next().unwrap_or(t).trim();
            return clean.to_string();
        }
    }
    "value".to_string()
}

// ─── Hardcoded Value Detection ──────────────────────────────────────

/// Detect hardcoded magic numbers in a condition or expression.
fn detect_hardcoded(expr: &str) -> Vec<HardcodedValue> {
    let mut found = Vec::new();
    let upper = expr.to_uppercase();

    for token in upper.split(|c: char| c == '*' || c == '/' || c == '+' || c == '='
        || c == '>' || c == '<' || c == '(' || c == ')' || c == ',')
    {
        let t = token.trim().trim_matches(|c: char| c.is_whitespace());
        if t.is_empty() { continue; }

        // Skip COBOL keywords and variable names
        if t.contains('-') || t.contains("NOT") || t.contains("AND") || t.contains("OR")
            || t == "0" || t == "1" || t == "SPACES" || t == "ZEROS" || t == "ZERO"
        {
            continue;
        }

        // Detect numeric literals
        if let Ok(val) = t.parse::<f64>() {
            // Skip trivial values and standard time-period divisors
            if val == 0.0 || val == 1.0 { continue; }
            if (val == 12.0 || val == 365.0 || val == 360.0 || val == 52.0 || val == 4.0 || val == 2.0)
                && upper.contains('/') { continue; } // Time period divisors in formulas are not magic numbers

            let (meaning, risk, recommendation) = classify_magic_number(val, &upper);
            found.push(HardcodedValue {
                value: t.to_string(),
                meaning,
                risk,
                recommendation,
            });
        }

        // Detect string literals
        if t.starts_with('\'') && t.ends_with('\'') && t.len() > 2 {
            let inner = &t[1..t.len()-1];
            if inner.len() <= 4 { // Short codes like 'WD', 'DP', 'A'
                found.push(HardcodedValue {
                    value: inner.to_string(),
                    meaning: format!("Code/status literal '{}'", inner),
                    risk: "medium",
                    recommendation: format!(
                        "Replace literal '{}' with a named constant or configuration value (e.g., TXN-TYPE-{} or lookup table)",
                        inner, inner
                    ),
                });
            }
        }
    }

    found
}

/// Classify a numeric magic number based on its value and context.
fn classify_magic_number(val: f64, context: &str) -> (String, &'static str, String) {
    // Percentage/rate (0.0 - 1.0 exclusive)
    if val > 0.0 && val < 1.0 {
        let pct = val * 100.0;
        let ctx = if context.contains("TAX") || context.contains("WITHHOLD") {
            "tax rate"
        } else if context.contains("INTEREST") || context.contains("RATE") {
            "interest rate"
        } else if context.contains("FEE") || context.contains("CHARGE") || context.contains("COMMISSION") {
            "fee rate"
        } else if context.contains("DISCOUNT") {
            "discount rate"
        } else {
            "rate/percentage"
        };

        return (
            format!("Hardcoded {} ({:.1}%)", ctx, pct),
            "high",
            format!(
                "Extract {:.1}% to a configuration parameter or rate table — business rates change frequently and should not be embedded in source code",
                pct
            ),
        );
    }

    // Currency thresholds
    if val >= 1.0 && val < 1_000_000.0 && (context.contains("FEE") || context.contains("AMOUNT")
        || context.contains("BALANCE") || context.contains("LIMIT") || context.contains("THRESHOLD")
        || context.contains("<") || context.contains(">"))
    {
        return (
            format!("Hardcoded threshold/limit ({})", format_currency(val)),
            "high",
            format!(
                "Extract {} to a configuration parameter — business limits change with policy and should be externalized",
                format_currency(val)
            ),
        );
    }

    // Divisors (12 = monthly, 365 = daily, 52 = weekly, 4 = quarterly)
    if val == 12.0 || val == 365.0 || val == 52.0 || val == 4.0 || val == 360.0 {
        let period = match val as u32 {
            12 => "monthly (÷ 12 months)",
            365 => "daily (÷ 365 days)",
            360 => "daily/banking (÷ 360 days)",
            52 => "weekly (÷ 52 weeks)",
            4 => "quarterly (÷ 4 quarters)",
            _ => "period-based",
        };
        return (
            format!("Time period divisor: {}", period),
            "low",
            "Standard time period constant — acceptable but consider a named constant for clarity".to_string(),
        );
    }

    // Multipliers > 1 (e.g., 1.05, 1.08 = 5%, 8% markup)
    if val > 1.0 && val < 2.0 {
        let markup = (val - 1.0) * 100.0;
        return (
            format!("Hardcoded markup/multiplier ({:.1}%)", markup),
            "high",
            format!(
                "Extract {:.1}% multiplier to a configuration parameter — markup rates are business-critical values",
                markup
            ),
        );
    }

    // Generic
    (
        format!("Hardcoded numeric literal ({})", val),
        "medium",
        format!("Consider extracting {} to a named constant or configuration value", val),
    )
}

fn format_currency(val: f64) -> String {
    if val == val.floor() {
        format!("${:.0}", val)
    } else {
        format!("${:.2}", val)
    }
}
