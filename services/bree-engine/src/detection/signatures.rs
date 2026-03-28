//! File signatures for language detection — extensions, headers, and content heuristics.
//!
//! Modeled after GitHub Linguist's approach but specialized for legacy enterprise languages.

use std::collections::HashMap;

/// A signature rule for detecting a language from file properties.
#[derive(Debug, Clone)]
pub struct LanguageSignature {
    pub language_id: &'static str,
    pub extensions: &'static [&'static str],
    /// Strings that, if found in the first 512 bytes, strongly indicate this language.
    pub header_patterns: &'static [&'static str],
    /// Regex patterns for deeper content analysis (stage 4 of cascade).
    pub content_heuristics: &'static [&'static str],
    /// Confidence weight for extension-only match (0.0-1.0).
    pub extension_confidence: f64,
    /// Confidence weight for content match (0.0-1.0).
    pub content_confidence: f64,
}

/// Complete signature database for all supported languages.
pub static SIGNATURES: &[LanguageSignature] = &[
    // Tier 1
    LanguageSignature {
        language_id: "cobol",
        extensions: &["cbl", "cob", "cpy", "sqb"],
        header_patterns: &["IDENTIFICATION DIVISION", "PROCEDURE DIVISION", "DATA DIVISION", "WORKING-STORAGE"],
        content_heuristics: &[r"^\d{6}\s", r"PERFORM\s+\w+\s+THRU", r"EXEC\s+SQL"],
        extension_confidence: 0.9,
        content_confidence: 0.98,
    },
    LanguageSignature {
        language_id: "rpg",
        extensions: &["rpg", "rpgle", "sqlrpgle", "rpg38"],
        header_patterns: &["dcl-s", "dcl-proc", "begsr", "/free", "FQSYSPRT"],
        content_heuristics: &[r"^\s{5}[HFDICOPhfdicop]", r"dcl-(s|ds|proc|pi|pr)"],
        extension_confidence: 0.95,
        content_confidence: 0.95,
    },
    LanguageSignature {
        language_id: "dds",
        extensions: &["dds", "pf", "lf", "dspf", "prtf", "icff"],
        header_patterns: &["PFILE(", "JFILE(", "SFLCTL(", "UNIQUE", "COLHDG(", "TEXT("],
        content_heuristics: &[r"^\s{5}A\s{10}R\s", r"PFILE\(\w+\)", r"SFLCTL\(\w+\)"],
        extension_confidence: 0.92,
        content_confidence: 0.95,
    },
    LanguageSignature {
        language_id: "cl",
        extensions: &["clp", "clle", "cl"],
        header_patterns: &["PGM", "ENDPGM", "CHGVAR", "SNDPGMMSG", "OVRDBF"],
        content_heuristics: &[r"^\s+DCL\s+VAR\(", r"CALL\s+PGM\("],
        extension_confidence: 0.85,
        content_confidence: 0.92,
    },
    LanguageSignature {
        language_id: "jcl",
        extensions: &["jcl", "proc", "prc"],
        header_patterns: &[],
        content_heuristics: &[r"^//\w+\s+JOB\s", r"^//\w+\s+EXEC\s", r"^//\w+\s+DD\s"],
        extension_confidence: 0.8,
        content_confidence: 0.95,
    },
    LanguageSignature {
        language_id: "pli",
        extensions: &["pli", "pl1", "plinc"],
        header_patterns: &["PROC OPTIONS(MAIN)", "DECLARE ", "DCL "],
        content_heuristics: &[r"DCL\s+\w+\s+(CHAR|FIXED|FLOAT|BIN)", r"ON\s+(ERROR|ENDFILE|CONVERSION)"],
        extension_confidence: 0.9,
        content_confidence: 0.93,
    },
    // Tier 2
    LanguageSignature {
        language_id: "abap",
        extensions: &["abap"],
        header_patterns: &["REPORT ", "DATA:", "SELECT ", "ENDFORM"],
        content_heuristics: &[r"DATA:\s+\w+\s+TYPE", r"FORM\s+\w+"],
        extension_confidence: 0.95,
        content_confidence: 0.95,
    },
    LanguageSignature {
        language_id: "vb6",
        extensions: &["frm", "bas", "cls", "vbp", "ctl"],
        header_patterns: &["VERSION 5.00", "Begin VB.Form", "Attribute VB_Name", "Option Explicit"],
        content_heuristics: &[r"Dim\s+\w+\s+As\s+", r"Private\s+Sub\s+\w+_Click"],
        extension_confidence: 0.85,
        content_confidence: 0.95,
    },
    LanguageSignature {
        language_id: "sas",
        extensions: &["sas"],
        header_patterns: &["data ", "proc ", "run;", "%macro", "%let"],
        content_heuristics: &[r"^\s*data\s+\w+;", r"^\s*proc\s+(sql|means|freq|print)"],
        extension_confidence: 0.95,
        content_confidence: 0.97,
    },
    LanguageSignature {
        language_id: "natural",
        extensions: &["nsp", "nsn", "nss"],
        header_patterns: &["DEFINE DATA", "END-DEFINE", "DISPLAY"],
        content_heuristics: &[r"DEFINE\s+DATA\s+(LOCAL|GLOBAL|PARAMETER)", r"READ\s+WORK\s+FILE"],
        extension_confidence: 0.9,
        content_confidence: 0.95,
    },
    LanguageSignature {
        language_id: "powerbuilder",
        extensions: &["srw", "srd", "srf", "srm"],
        header_patterns: &["forward", "global type", "event type"],
        content_heuristics: &[r"global\s+type\s+\w+\s+from\s+\w+"],
        extension_confidence: 0.9,
        content_confidence: 0.92,
    },
    LanguageSignature {
        language_id: "delphi",
        extensions: &["pas", "dpr", "dpk", "dfm"],
        header_patterns: &["unit ", "interface", "implementation", "uses "],
        content_heuristics: &[r"^\s*unit\s+\w+;", r"^\s*procedure\s+TForm"],
        extension_confidence: 0.85,
        content_confidence: 0.9,
    },
    LanguageSignature {
        language_id: "asp-classic",
        extensions: &["asp", "asa"],
        header_patterns: &["<%", "Response.Write", "Request.Form", "Server.CreateObject"],
        content_heuristics: &[r"<%.*%>", r"Dim\s+\w+"],
        extension_confidence: 0.9,
        content_confidence: 0.85,
    },
    // Tier 3
    LanguageSignature {
        language_id: "fortran",
        extensions: &["f", "for", "ftn", "f77", "f90", "f95", "f03", "f08"],
        header_patterns: &["PROGRAM ", "SUBROUTINE ", "FUNCTION ", "IMPLICIT NONE"],
        content_heuristics: &[r"^\s{6}\w", r"COMMON\s+/\w+/", r"DO\s+\d+\s+\w+="],
        extension_confidence: 0.85,
        content_confidence: 0.92,
    },
    LanguageSignature {
        language_id: "ada",
        extensions: &["ada", "adb", "ads"],
        header_patterns: &["with ", "procedure ", "package "],
        content_heuristics: &[r"^\s*with\s+\w+;", r"^\s*package\s+(body\s+)?\w+\s+is"],
        extension_confidence: 0.9,
        content_confidence: 0.93,
    },
    LanguageSignature {
        language_id: "mumps",
        extensions: &["m", "mps", "ro"],
        header_patterns: &["SET ", "KILL ", "QUIT"],
        content_heuristics: &[r"^\w+(\(.*\))?\s+;", r"\^\w+\(", r"\s+S\s+\w+="],
        extension_confidence: 0.5, // .m conflicts with Objective-C and MATLAB
        content_confidence: 0.88,
    },
];

/// Build an extension-to-language lookup table.
pub fn build_extension_map() -> HashMap<&'static str, Vec<&'static str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    for sig in SIGNATURES {
        for ext in sig.extensions {
            map.entry(ext).or_default().push(sig.language_id);
        }
    }
    map
}
