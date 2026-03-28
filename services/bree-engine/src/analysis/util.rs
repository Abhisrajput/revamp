//! Shared utility functions for analysis modules — humanize variable names,
//! split camelCase, strip UI prefixes, etc.

/// Convert legacy variable names to human-readable text.
/// Handles COBOL (WS-ACCT-BALANCE), RPG (ORDTOTAL), VB6 (txtOrderTotal),
/// PL/I, CL, JCL, and other naming conventions.
pub fn humanize(name: &str) -> String {
    let s = name.trim();

    // VB6/VB.NET: camelCase/PascalCase — split and strip UI prefixes
    if s.chars().any(|c| c.is_lowercase()) && s.chars().any(|c| c.is_uppercase()) && !s.contains('-') {
        let stripped = strip_vb_prefix(s);
        return split_camel_case(&stripped).to_lowercase();
    }

    // COBOL/RPG/CL: uppercase with hyphens or all-caps
    s.replace("WS-", "").replace("W-", "").replace("LK-", "").replace("LS-", "")
        .replace("GRP-", "").replace("IX-", "").replace("SW-", "")
        .replace("TXN-", "transaction ").replace("ACCT-", "account ")
        .replace("CUST-", "customer ").replace("ORD-", "order ")
        .replace("INV-", "invoice ").replace("EMP-", "employee ")
        .replace("PAY-", "payment ").replace("CLM-", "claim ")
        .replace("POL-", "policy ").replace("PRM-", "premium ")
        .replace("PAT-", "patient ").replace("DX-", "diagnosis ")
        .replace("-", " ")
        .trim().to_lowercase()
}

pub fn strip_vb_prefix(name: &str) -> String {
    let prefixes = ["txt", "cmd", "btn", "lbl", "frm", "lst", "cmb", "chk", "opt", "pic", "tmr", "dw_", "ds_"];
    for p in &prefixes {
        if name.starts_with(p) && name.len() > p.len() && name[p.len()..].starts_with(|c: char| c.is_uppercase()) {
            return name[p.len()..].to_string();
        }
    }
    name.to_string()
}

pub fn split_camel_case(name: &str) -> String {
    let mut result = String::new();
    for (i, c) in name.chars().enumerate() {
        if i > 0 && c.is_uppercase() {
            result.push(' ');
        }
        result.push(c);
    }
    result
}

pub fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}
