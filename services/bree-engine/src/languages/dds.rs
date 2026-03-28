//! DDS (Data Description Specifications) parser — Tier 1 deep parser for IBM i.
//!
//! DDS defines the database schema, screen layouts, and print formats on IBM i (AS/400).
//! Five file types:
//!   - PF (Physical File): database table — fields, types, keys
//!   - LF (Logical File): database view/index — select/omit, join, key fields
//!   - DSPF (Display File): 5250 terminal screen layout — subfiles, indicators, function keys
//!   - PRTF (Printer File): print layout — spacing, fields, page control
//!   - ICFF (ICF File): intersystem communications (rare)
//!
//! DDS is column-positional source (columns 1-80):
//!   1-5:   Sequence number
//!   6:     Form type (always 'A' for DDS, or '*' for comment)
//!   7-16:  Conditioning indicators (3 pairs of 2-digit AND/OR indicators)
//!   17:    Name type (R=record, K=key, S=select, O=omit, J=join, blank=field)
//!   18-28: Name (record, field, or key field name)
//!   29-34: Reference / Length
//!   35:    Data type (A=alpha, P=packed, S=zoned, B=binary, L=date, T=time, Z=timestamp, F=float)
//!   36-37: Decimal positions
//!   38-44: Usage (B=both, I=input, O=output, H=hidden — for DSPF)
//!   45-80: Keywords and functions

use crate::parser::nir::*;
use crate::parser::traits::*;
use std::collections::HashMap;

// ─── DDS File Type Detection ─────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum DdsFileType {
    PhysicalFile,
    LogicalFile,
    DisplayFile,
    PrinterFile,
    IcfFile,
}

impl DdsFileType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::PhysicalFile => "PF",
            Self::LogicalFile => "LF",
            Self::DisplayFile => "DSPF",
            Self::PrinterFile => "PRTF",
            Self::IcfFile => "ICFF",
        }
    }
}

// ─── Column Constants ────────────────────────────────────────────
// DDS column positions (0-indexed from IBM 1-based spec)
const COL_FORM_TYPE: usize = 5;       // Column 6
const COL_NAME_TYPE: usize = 16;      // Column 17
const COL_NAME_START: usize = 18;     // Column 19 (name starts here, 11 chars)
const COL_NAME_END: usize = 28;       // Column 29 (exclusive)
const COL_LENGTH_START: usize = 29;   // Column 30 (reference/length, 5 chars)
const COL_LENGTH_END: usize = 34;     // Column 34
const COL_DATA_TYPE: usize = 34;      // Column 35
const COL_DECIMAL_START: usize = 35;  // Column 36
const COL_DECIMAL_END: usize = 37;    // Column 37
const COL_USAGE_START: usize = 37;    // Column 38
const COL_USAGE_END: usize = 41;      // Column 41
const COL_KEYWORD_START: usize = 44;  // Column 45

// ─── Parser ──────────────────────────────────────────────────────

pub struct DdsParser;

impl DdsParser {
    pub fn new() -> Self { Self }

    /// Extract a column range from a DDS line, returning trimmed text.
    fn col_range(line: &str, start: usize, end: usize) -> &str {
        let bytes = line.as_bytes();
        let len = bytes.len();
        if start >= len { return ""; }
        let actual_end = end.min(len);
        line[start..actual_end].trim()
    }

    /// Extract a single column character.
    fn col_char(line: &str, col: usize) -> char {
        line.as_bytes().get(col).map(|&b| b as char).unwrap_or(' ')
    }

    /// Detect DDS file type from content heuristics.
    fn detect_file_type(content: &str, extension: &str) -> DdsFileType {
        // Extension hints
        match extension {
            "pf" => return DdsFileType::PhysicalFile,
            "lf" => return DdsFileType::LogicalFile,
            "dspf" => return DdsFileType::DisplayFile,
            "prtf" => return DdsFileType::PrinterFile,
            "icff" => return DdsFileType::IcfFile,
            _ => {}
        }

        let upper = content.to_uppercase();

        // DSPF indicators: subfile keywords, display attributes, function keys
        if upper.contains("SFLCTL(") || upper.contains("SFL ")
            || upper.contains("DSPATR(") || upper.contains("CF01(")
            || upper.contains("CA01(") || upper.contains("CA03(")
            || upper.contains("CF03(") || upper.contains("WINDOW(")
        {
            return DdsFileType::DisplayFile;
        }

        // PRTF indicators: spacing, skip, print-specific keywords
        if upper.contains("SPACEA(") || upper.contains("SPACEB(")
            || upper.contains("SKIPA(") || upper.contains("SKIPB(")
            || upper.contains("PAGNBR") || upper.contains("PRTQLTY(")
            || upper.contains("CPI(") || upper.contains("LPI(")
        {
            return DdsFileType::PrinterFile;
        }

        // ICFF indicators
        if upper.contains("EVOKE(") || upper.contains("INVITE")
            || upper.contains("TIMER(") || upper.contains("DETACH")
        {
            return DdsFileType::IcfFile;
        }

        // LF indicators: references a physical file
        if upper.contains("PFILE(") || upper.contains("JFILE(") {
            return DdsFileType::LogicalFile;
        }

        // Default: Physical File
        DdsFileType::PhysicalFile
    }

    /// Extract keyword area text from a line, handling continuation lines.
    fn extract_keywords(line: &str) -> String {
        if line.len() <= COL_KEYWORD_START {
            return String::new();
        }
        line[COL_KEYWORD_START..].trim().to_string()
    }

    /// Parse a PFILE(...) or JFILE(...) keyword, extracting file names.
    fn parse_file_reference(keywords: &str, keyword: &str) -> Vec<String> {
        let upper = keywords.to_uppercase();
        let mut files = Vec::new();
        if let Some(start) = upper.find(&format!("{}(", keyword)) {
            let paren_start = start + keyword.len() + 1;
            if let Some(paren_end) = upper[paren_start..].find(')') {
                let file_list = &keywords[paren_start..paren_start + paren_end];
                for f in file_list.split_whitespace() {
                    let name = f.trim().to_uppercase();
                    if !name.is_empty() {
                        files.push(name);
                    }
                }
            }
        }
        files
    }

    /// Extract indicator numbers from conditioning indicator columns (7-16).
    fn extract_indicators(line: &str) -> Vec<String> {
        let mut indicators = Vec::new();
        // Columns 7-8, 9-10, 11-12, 13-14, 15-16 (3 indicator pairs + not markers)
        for start in [6, 8, 10, 12, 14] {
            let ind = Self::col_range(line, start, start + 2);
            if !ind.is_empty() && ind.chars().all(|c| c.is_ascii_digit()) {
                indicators.push(ind.to_string());
            }
        }
        indicators
    }

    /// Map DDS data type character to readable type name.
    fn data_type_name(dt: char) -> &'static str {
        match dt {
            'A' => "CHAR",
            'P' => "PACKED",
            'S' => "ZONED",
            'B' => "BINARY",
            'F' => "FLOAT",
            'L' => "DATE",
            'T' => "TIME",
            'Z' => "TIMESTAMP",
            'H' => "VARGRAPHIC",
            'G' => "GRAPHIC",
            'O' => "BLOB/CLOB",
            _ => "CHAR", // default
        }
    }

    /// Parse all DDS lines into structured records.
    fn parse_dds_lines(content: &str) -> Vec<DdsLine> {
        let mut lines = Vec::new();
        let mut continuation_keywords = String::new();
        let mut continuation_target: Option<usize> = None;

        for (idx, raw_line) in content.lines().enumerate() {
            let line_num = idx + 1;

            // Skip blank lines
            if raw_line.trim().is_empty() {
                continue;
            }

            // Comments: column 7 is '*'
            if raw_line.len() > 6 && raw_line.as_bytes()[6] == b'*' {
                continue;
            }
            // Also skip lines starting with '*'
            if raw_line.trim_start().starts_with('*') {
                continue;
            }

            let form_type = Self::col_char(raw_line, COL_FORM_TYPE);
            let name_type = Self::col_char(raw_line, COL_NAME_TYPE);
            let name = Self::col_range(raw_line, COL_NAME_START, COL_NAME_END).to_uppercase();
            let length_str = Self::col_range(raw_line, COL_LENGTH_START, COL_LENGTH_END);
            let data_type = Self::col_char(raw_line, COL_DATA_TYPE);
            let decimal_str = Self::col_range(raw_line, COL_DECIMAL_START, COL_DECIMAL_END);
            let usage = Self::col_range(raw_line, COL_USAGE_START, COL_USAGE_END).to_uppercase();
            let keywords = Self::extract_keywords(raw_line);
            let indicators = Self::extract_indicators(raw_line);

            let length: Option<u32> = length_str.parse().ok();
            let decimals: Option<u32> = decimal_str.parse().ok();

            // Handle continuation lines (keyword area only, no name type or name).
            // But don't treat file-level keywords (UNIQUE, REF, PRINT, CF/CA, SPACEA, etc.) as continuations.
            let kw_upper_check = keywords.to_uppercase();
            let is_file_level_keyword = kw_upper_check.contains("UNIQUE")
                || kw_upper_check.contains("REF(")
                || kw_upper_check.contains("PRINT")
                || kw_upper_check.contains("INDARA")
                || kw_upper_check.starts_with("CF") || kw_upper_check.starts_with("CA")
                || kw_upper_check.contains("SPACEA(") || kw_upper_check.contains("SPACEB(")
                || kw_upper_check.contains("SKIPA(") || kw_upper_check.contains("SKIPB(")
                || kw_upper_check.contains("SFLSIZ(") || kw_upper_check.contains("SFLPAG(");

            if name_type == ' ' && name.is_empty() && !keywords.is_empty() && !is_file_level_keyword {
                continuation_keywords.push(' ');
                continuation_keywords.push_str(&keywords);
                continue;
            }

            // Flush any accumulated continuation to the previous DDS line
            if let Some(target_idx) = continuation_target {
                if !continuation_keywords.is_empty() {
                    if let Some(prev) = lines.get_mut(target_idx) {
                        let prev: &mut DdsLine = prev;
                        prev.keywords.push(' ');
                        prev.keywords.push_str(&continuation_keywords);
                    }
                    continuation_keywords.clear();
                }
            }

            lines.push(DdsLine {
                line_num,
                name_type,
                name: if name.is_empty() { None } else { Some(name) },
                length,
                data_type: if data_type == ' ' { None } else { Some(data_type) },
                decimals,
                usage: if usage.is_empty() { None } else { Some(usage) },
                keywords,
                indicators,
            });

            continuation_target = Some(lines.len() - 1);
        }

        // Flush final continuation
        if let Some(target_idx) = continuation_target {
            if !continuation_keywords.is_empty() {
                if let Some(prev) = lines.get_mut(target_idx) {
                    prev.keywords.push(' ');
                    prev.keywords.push_str(&continuation_keywords);
                }
            }
        }

        lines
    }
}

#[derive(Debug, Clone)]
struct DdsLine {
    line_num: usize,
    name_type: char,
    name: Option<String>,
    length: Option<u32>,
    data_type: Option<char>,
    decimals: Option<u32>,
    usage: Option<String>,
    keywords: String,
    indicators: Vec<String>,
}

// ─── LanguageParser Implementation ───────────────────────────────

impl LanguageParser for DdsParser {
    fn language_id(&self) -> &'static str { "dds" }

    fn display_name(&self) -> &'static str { "DDS (IBM i Data Description)" }

    fn supported_dialects(&self) -> &[&'static str] {
        &["DDS-PF", "DDS-LF", "DDS-DSPF", "DDS-PRTF", "DDS-ICFF"]
    }

    fn file_extensions(&self) -> &[&'static str] {
        &["dds", "pf", "lf", "dspf", "prtf", "icff"]
    }

    fn can_parse(&self, file: &SourceFile) -> bool {
        // Extension match
        if self.file_extensions().contains(&file.extension.as_str()) {
            return true;
        }
        // Content heuristic: DDS column format with 'A' in column 6
        let header = file.header.to_uppercase();
        header.contains("PFILE(") || header.contains("JFILE(")
            || header.contains("SFLCTL(") || header.contains("UNIQUE")
            || header.contains("TEXT(") || header.contains("COLHDG(")
            || header.contains("SPACEA(") || header.contains("SPACEB(")
    }

    fn parse(&self, source: &SourceFile) -> anyhow::Result<ParseOutput> {
        let file_type = Self::detect_file_type(&source.content, &source.extension);
        let dialect = format!("DDS-{}", file_type.as_str());
        let dds_lines = Self::parse_dds_lines(&source.content);

        let mut ast_nodes: Vec<AstNode> = Vec::new();
        let mut symbols: Vec<Symbol> = Vec::new();
        let mut metadata: HashMap<String, serde_json::Value> = HashMap::new();
        let mut diagnostics: Vec<Diagnostic> = Vec::new();

        // Counters
        let mut record_format_count = 0u32;
        let mut field_count = 0u32;
        let mut key_field_count = 0u32;
        let mut select_omit_count = 0u32;
        let mut subfile_count = 0u32;
        let mut function_key_count = 0u32;
        let mut has_unique = false;
        let mut pfile_refs: Vec<String> = Vec::new();
        let mut jfile_refs: Vec<String> = Vec::new();
        let mut indicator_map: HashMap<String, String> = HashMap::new();
        let mut text_descriptions: Vec<String> = Vec::new();
        let mut current_record_format: Option<String> = None;

        for dds_line in &dds_lines {
            let span = Span {
                start_line: dds_line.line_num,
                start_col: 0,
                end_line: dds_line.line_num,
                end_col: 80,
            };

            let kw_upper = dds_line.keywords.to_uppercase();

            match dds_line.name_type {
                // ── Record Format ────────────────────────────────
                'R' => {
                    record_format_count += 1;
                    let name = dds_line.name.clone().unwrap_or_default();
                    current_record_format = Some(name.clone());

                    // Check for PFILE/JFILE on record format line
                    let pf = Self::parse_file_reference(&dds_line.keywords, "PFILE");
                    pfile_refs.extend(pf.clone());
                    let jf = Self::parse_file_reference(&dds_line.keywords, "JFILE");
                    jfile_refs.extend(jf.clone());

                    // Check for subfile keywords (DSPF)
                    let is_subfile = kw_upper.contains("SFL");
                    let is_subfile_ctl = kw_upper.contains("SFLCTL(");
                    if is_subfile && !is_subfile_ctl {
                        subfile_count += 1;
                    }

                    let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                    props.insert("dds_type".to_string(), serde_json::json!(file_type.as_str()));
                    if !pf.is_empty() {
                        props.insert("pfile".to_string(), serde_json::json!(pf));
                    }
                    if !jf.is_empty() {
                        props.insert("jfile".to_string(), serde_json::json!(jf));
                    }
                    if is_subfile {
                        props.insert("subfile".to_string(), serde_json::json!(true));
                    }
                    if is_subfile_ctl {
                        props.insert("subfile_control".to_string(), serde_json::json!(true));
                    }

                    let kind_label = match file_type {
                        DdsFileType::DisplayFile if is_subfile => "SubfileRecord",
                        DdsFileType::DisplayFile if is_subfile_ctl => "SubfileControl",
                        DdsFileType::DisplayFile => "ScreenRecord",
                        DdsFileType::PrinterFile => "PrintRecord",
                        DdsFileType::LogicalFile => "LogicalRecord",
                        _ => "RecordFormat",
                    };

                    symbols.push(Symbol {
                        name: name.clone(),
                        kind: SymbolKind::Custom("RecordFormat".to_string()),
                        span,
                        visibility: Visibility::Public,
                        data_type: Some(kind_label.to_string()),
                        properties: props.clone(),
                    });

                    ast_nodes.push(AstNode {
                        id: format!("rec-{}", dds_line.line_num),
                        kind: AstNodeKind::Custom(kind_label.to_string()),
                        name: Some(name),
                        span,
                        children: vec![],
                        properties: props,
                    });
                }

                // ── Key Field ────────────────────────────────────
                'K' => {
                    key_field_count += 1;
                    let name = dds_line.name.clone().unwrap_or_default();

                    // Check for UNIQUE keyword on key specification
                    if kw_upper.contains("UNIQUE") {
                        has_unique = true;
                    }

                    // DESCEND keyword
                    let descending = kw_upper.contains("DESCEND");

                    let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                    props.insert("key_type".to_string(), serde_json::json!(
                        if descending { "descending" } else { "ascending" }
                    ));
                    if has_unique {
                        props.insert("unique".to_string(), serde_json::json!(true));
                    }
                    if let Some(ref rf) = current_record_format {
                        props.insert("record_format".to_string(), serde_json::json!(rf));
                    }

                    symbols.push(Symbol {
                        name: name.clone(),
                        kind: SymbolKind::Index,
                        span,
                        visibility: Visibility::Public,
                        data_type: Some("KEY".to_string()),
                        properties: props.clone(),
                    });

                    ast_nodes.push(AstNode {
                        id: format!("key-{}", dds_line.line_num),
                        kind: AstNodeKind::Custom("KeyField".to_string()),
                        name: Some(name),
                        span,
                        children: vec![],
                        properties: props,
                    });
                }

                // ── Select / Omit (Logical File) ─────────────────
                'S' | 'O' => {
                    select_omit_count += 1;
                    let select_or_omit = if dds_line.name_type == 'S' { "SELECT" } else { "OMIT" };
                    let field_name = dds_line.name.clone().unwrap_or_default();

                    let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                    props.insert("operation".to_string(), serde_json::json!(select_or_omit));
                    if !field_name.is_empty() {
                        props.insert("field".to_string(), serde_json::json!(field_name));
                    }
                    if !dds_line.keywords.is_empty() {
                        props.insert("criteria".to_string(), serde_json::json!(dds_line.keywords.trim()));
                    }

                    ast_nodes.push(AstNode {
                        id: format!("so-{}", dds_line.line_num),
                        kind: AstNodeKind::Custom("SelectOmit".to_string()),
                        name: Some(format!("{} {}", select_or_omit, field_name)),
                        span,
                        children: vec![],
                        properties: props,
                    });
                }

                // ── Join specification (Logical File) ────────────
                'J' => {
                    let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                    // JFLD keyword
                    if kw_upper.contains("JFLD(") {
                        if let Some(start) = kw_upper.find("JFLD(") {
                            let ps = start + 5;
                            if let Some(pe) = kw_upper[ps..].find(')') {
                                let fields = &dds_line.keywords[ps..ps + pe];
                                props.insert("join_fields".to_string(), serde_json::json!(fields.trim()));
                            }
                        }
                    }
                    if kw_upper.contains("JOIN(") {
                        if let Some(start) = kw_upper.find("JOIN(") {
                            let ps = start + 5;
                            if let Some(pe) = kw_upper[ps..].find(')') {
                                let join_spec = &dds_line.keywords[ps..ps + pe];
                                props.insert("join_spec".to_string(), serde_json::json!(join_spec.trim()));
                            }
                        }
                    }

                    ast_nodes.push(AstNode {
                        id: format!("join-{}", dds_line.line_num),
                        kind: AstNodeKind::Custom("JoinSpec".to_string()),
                        name: dds_line.name.clone(),
                        span,
                        children: vec![],
                        properties: props,
                    });
                }

                // ── Field definition (blank name type with a name) ─
                _ if dds_line.name.is_some() => {
                    field_count += 1;
                    let name = dds_line.name.clone().unwrap_or_default();
                    let dt = dds_line.data_type.unwrap_or('A');
                    let type_name = Self::data_type_name(dt);

                    let mut props: HashMap<String, serde_json::Value> = HashMap::new();
                    props.insert("data_type".to_string(), serde_json::json!(type_name));
                    if let Some(len) = dds_line.length {
                        props.insert("length".to_string(), serde_json::json!(len));
                    }
                    if let Some(dec) = dds_line.decimals {
                        props.insert("decimals".to_string(), serde_json::json!(dec));
                    }
                    if let Some(ref usage) = dds_line.usage {
                        if !usage.is_empty() {
                            props.insert("usage".to_string(), serde_json::json!(usage));
                        }
                    }
                    if let Some(ref rf) = current_record_format {
                        props.insert("record_format".to_string(), serde_json::json!(rf));
                    }

                    // Extract TEXT('...') description
                    if let Some(text) = Self::extract_keyword_value(&kw_upper, &dds_line.keywords, "TEXT") {
                        props.insert("text".to_string(), serde_json::json!(text));
                        text_descriptions.push(format!("{}: {}", name, text));
                    }

                    // Extract COLHDG('...')
                    if let Some(colhdg) = Self::extract_keyword_value(&kw_upper, &dds_line.keywords, "COLHDG") {
                        props.insert("column_heading".to_string(), serde_json::json!(colhdg));
                    }

                    // Validation keywords
                    let mut validations: Vec<String> = Vec::new();
                    for kw in &["CHECK(", "VALUES(", "RANGE(", "COMP(", "EDTCDE(", "EDTWRD("] {
                        if kw_upper.contains(kw) {
                            validations.push(kw.trim_end_matches('(').to_string());
                        }
                    }
                    if !validations.is_empty() {
                        props.insert("validations".to_string(), serde_json::json!(validations));
                    }

                    // REF/REFFLD references
                    if kw_upper.contains("REF(") || kw_upper.contains("REFFLD(") {
                        if let Some(r) = Self::extract_keyword_value(&kw_upper, &dds_line.keywords, "REF") {
                            props.insert("ref_file".to_string(), serde_json::json!(r));
                        }
                        if let Some(r) = Self::extract_keyword_value(&kw_upper, &dds_line.keywords, "REFFLD") {
                            props.insert("ref_field".to_string(), serde_json::json!(r));
                        }
                    }

                    // DSPATR for display files
                    if kw_upper.contains("DSPATR(") {
                        if let Some(attr) = Self::extract_keyword_value(&kw_upper, &dds_line.keywords, "DSPATR") {
                            props.insert("display_attribute".to_string(), serde_json::json!(attr));
                        }
                    }

                    // Indicator associations
                    for ind in &dds_line.indicators {
                        indicator_map.insert(ind.clone(), format!("Field {} conditioning", name));
                    }

                    // Function key detection (DSPF: CF/CA keywords at file level)
                    for prefix in &["CF", "CA"] {
                        for num in 1..=24u32 {
                            let fk = format!("{}{:02}(", prefix, num);
                            if kw_upper.contains(&fk) {
                                function_key_count += 1;
                                let fk_name = format!("{}{:02}", prefix, num);
                                // Extract indicator assignment
                                if let Some(val) = Self::extract_keyword_value(&kw_upper, &dds_line.keywords, &fk_name) {
                                    indicator_map.insert(fk_name.clone(), val.clone());
                                }
                            }
                        }
                    }

                    let node_kind = match file_type {
                        DdsFileType::DisplayFile => "ScreenField",
                        DdsFileType::PrinterFile => "PrintField",
                        _ => "FieldDefinition",
                    };

                    symbols.push(Symbol {
                        name: name.clone(),
                        kind: SymbolKind::DataItem,
                        span,
                        visibility: Visibility::Public,
                        data_type: Some(format!("{}({}{})",
                            type_name,
                            dds_line.length.map(|l| l.to_string()).unwrap_or_default(),
                            dds_line.decimals.map(|d| format!(",{}", d)).unwrap_or_default()
                        )),
                        properties: props.clone(),
                    });

                    ast_nodes.push(AstNode {
                        id: format!("fld-{}", dds_line.line_num),
                        kind: AstNodeKind::DataDeclaration,
                        name: Some(name),
                        span,
                        children: vec![],
                        properties: props,
                    });
                }

                _ => {
                    // File-level keywords (no name type, no name) — e.g., UNIQUE, REF, PRINT
                    if kw_upper.contains("UNIQUE") {
                        has_unique = true;
                    }
                    // File-level function keys (DSPF)
                    for prefix in &["CF", "CA"] {
                        for num in 1..=24u32 {
                            let fk = format!("{}{:02}(", prefix, num);
                            if kw_upper.contains(&fk) {
                                function_key_count += 1;
                                let fk_name = format!("{}{:02}", prefix, num);
                                if let Some(val) = Self::extract_keyword_value(&kw_upper, &dds_line.keywords, &fk_name) {
                                    indicator_map.insert(fk_name, val);
                                }
                            }
                        }
                    }
                    // SPACEA/SPACEB/SKIPA/SKIPB for PRTF
                    if file_type == DdsFileType::PrinterFile {
                        for kw in &["SPACEA", "SPACEB", "SKIPA", "SKIPB"] {
                            if kw_upper.contains(&format!("{}(", kw)) {
                                ast_nodes.push(AstNode {
                                    id: format!("pg-{}", dds_line.line_num),
                                    kind: AstNodeKind::Custom("PageControl".to_string()),
                                    name: Some(kw.to_string()),
                                    span,
                                    children: vec![],
                                    properties: HashMap::from([(
                                        "control".to_string(),
                                        serde_json::json!(kw),
                                    )]),
                                });
                            }
                        }
                    }
                }
            }
        }

        // ── Populate metadata ─────────────────────────────────────
        metadata.insert("dds_type".to_string(), serde_json::json!(file_type.as_str()));
        metadata.insert("record_format_count".to_string(), serde_json::json!(record_format_count));
        metadata.insert("field_count".to_string(), serde_json::json!(field_count));
        metadata.insert("key_field_count".to_string(), serde_json::json!(key_field_count));
        metadata.insert("unique_keys".to_string(), serde_json::json!(has_unique));

        if !pfile_refs.is_empty() {
            metadata.insert("pfile_references".to_string(), serde_json::json!(pfile_refs));
        }
        if !jfile_refs.is_empty() {
            metadata.insert("jfile_references".to_string(), serde_json::json!(jfile_refs));
        }
        if select_omit_count > 0 {
            metadata.insert("select_omit_count".to_string(), serde_json::json!(select_omit_count));
        }
        if subfile_count > 0 {
            metadata.insert("subfile_count".to_string(), serde_json::json!(subfile_count));
        }
        if function_key_count > 0 {
            metadata.insert("function_key_count".to_string(), serde_json::json!(function_key_count));
        }
        if !indicator_map.is_empty() {
            metadata.insert("indicator_assignments".to_string(), serde_json::json!(indicator_map));
        }
        if !text_descriptions.is_empty() {
            metadata.insert("text_descriptions".to_string(), serde_json::json!(text_descriptions));
        }

        Ok(ParseOutput {
            language_id: "dds".to_string(),
            dialect,
            source_path: source.path.to_string_lossy().to_string(),
            total_lines: source.line_count,
            ast_nodes,
            symbols,
            embedded_blocks: vec![],
            diagnostics,
            metadata,
        })
    }

    fn parse_partial(&self, source: &SourceFile) -> anyhow::Result<PartialParseOutput> {
        match self.parse(source) {
            Ok(output) => Ok(PartialParseOutput {
                parsed_up_to_line: output.total_lines,
                coverage: 1.0,
                error: String::new(),
                output,
            }),
            Err(e) => Ok(PartialParseOutput {
                output: ParseOutput {
                    language_id: "dds".to_string(),
                    dialect: "DDS-PF".to_string(),
                    source_path: source.path.to_string_lossy().to_string(),
                    total_lines: source.line_count,
                    ast_nodes: vec![],
                    symbols: vec![],
                    embedded_blocks: vec![],
                    diagnostics: vec![],
                    metadata: HashMap::new(),
                },
                parsed_up_to_line: 0,
                error: e.to_string(),
                coverage: 0.0,
            }),
        }
    }

    fn resolve_dependencies(&self, module: &ParseOutput, _vault: &SourceVault) -> Vec<DependencyRef> {
        let mut deps = Vec::new();
        let from = module.source_path.clone();

        // LF -> PF dependencies via PFILE
        if let Some(pfiles) = module.metadata.get("pfile_references") {
            if let Some(files) = pfiles.as_array() {
                for f in files {
                    if let Some(name) = f.as_str() {
                        deps.push(DependencyRef {
                            from_module: from.clone(),
                            to_module: name.to_string(),
                            dependency_type: DependencyType::FileAccess,
                            source_span: Span { start_line: 1, start_col: 0, end_line: 1, end_col: 0 },
                            reference_text: format!("PFILE({})", name),
                        });
                    }
                }
            }
        }

        // LF -> PF dependencies via JFILE (join logical)
        if let Some(jfiles) = module.metadata.get("jfile_references") {
            if let Some(files) = jfiles.as_array() {
                for f in files {
                    if let Some(name) = f.as_str() {
                        deps.push(DependencyRef {
                            from_module: from.clone(),
                            to_module: name.to_string(),
                            dependency_type: DependencyType::FileAccess,
                            source_span: Span { start_line: 1, start_col: 0, end_line: 1, end_col: 0 },
                            reference_text: format!("JFILE({})", name),
                        });
                    }
                }
            }
        }

        // REF/REFFLD dependencies on fields
        for node in &module.ast_nodes {
            if let Some(ref_file) = node.properties.get("ref_file") {
                if let Some(name) = ref_file.as_str() {
                    deps.push(DependencyRef {
                        from_module: from.clone(),
                        to_module: name.to_string(),
                        dependency_type: DependencyType::FileAccess,
                        source_span: node.span,
                        reference_text: format!("REF({})", name),
                    });
                }
            }
        }

        deps
    }

    fn to_analysis_graph(&self, output: &ParseOutput) -> anyhow::Result<AnalysisGraph> {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut business_rules = Vec::new();
        let mut data_flows = Vec::new();

        let dds_type = output.metadata.get("dds_type")
            .and_then(|v| v.as_str())
            .unwrap_or("PF");

        // Create a top-level node for the DDS file
        let file_node_id = format!("dds-file-{}", output.source_path);
        let file_node_kind = match dds_type {
            "PF" | "LF" => AnalysisNodeKind::DatabaseOperation,
            "DSPF" => AnalysisNodeKind::UIInteraction,
            "PRTF" => AnalysisNodeKind::FileOperation,
            _ => AnalysisNodeKind::FileOperation,
        };

        nodes.push(AnalysisNode {
            id: file_node_id.clone(),
            kind: file_node_kind,
            name: format!("{} definition: {}", dds_type, output.source_path),
            source_span: Span { start_line: 1, start_col: 0, end_line: output.total_lines, end_col: 0 },
            properties: HashMap::from([
                ("dds_type".to_string(), serde_json::json!(dds_type)),
            ]),
        });

        // LF -> PF edges
        if let Some(pfiles) = output.metadata.get("pfile_references") {
            if let Some(files) = pfiles.as_array() {
                for f in files {
                    if let Some(name) = f.as_str() {
                        let pf_id = format!("pfile-{}", name);
                        edges.push(AnalysisEdge {
                            from: file_node_id.clone(),
                            to: pf_id,
                            kind: AnalysisEdgeKind::ReadsFrom,
                            label: Some(format!("PFILE({})", name)),
                        });
                    }
                }
            }
        }

        // Key fields -> Constraint business rules
        if output.metadata.get("unique_keys").and_then(|v| v.as_bool()).unwrap_or(false) {
            let key_count = output.metadata.get("key_field_count")
                .and_then(|v| v.as_u64()).unwrap_or(0);
            business_rules.push(BusinessRule {
                id: format!("br-unique-{}", output.source_path),
                description: format!("Unique key constraint ({} fields)", key_count),
                rule_type: BusinessRuleType::Constraint,
                source_span: Span { start_line: 1, start_col: 0, end_line: 1, end_col: 0 },
                confidence: 0.95,
            });
        }

        // Select/Omit -> Validation business rules
        for node in &output.ast_nodes {
            if node.kind == AstNodeKind::Custom("SelectOmit".to_string()) {
                business_rules.push(BusinessRule {
                    id: format!("br-{}", node.id),
                    description: format!("Data filtering: {}", node.name.as_deref().unwrap_or("unknown")),
                    rule_type: BusinessRuleType::Validation,
                    source_span: node.span,
                    confidence: 0.85,
                });
            }

            // Field validations (CHECK, VALUES, RANGE, COMP)
            if let Some(validations) = node.properties.get("validations") {
                if let Some(vals) = validations.as_array() {
                    for v in vals {
                        if let Some(vname) = v.as_str() {
                            business_rules.push(BusinessRule {
                                id: format!("br-val-{}-{}", vname, node.id),
                                description: format!("{} validation on field {}",
                                    vname,
                                    node.name.as_deref().unwrap_or("unknown")
                                ),
                                rule_type: BusinessRuleType::Validation,
                                source_span: node.span,
                                confidence: 0.90,
                            });
                        }
                    }
                }
            }
        }

        Ok(AnalysisGraph {
            source_language: "dds".to_string(),
            source_path: output.source_path.clone(),
            nodes,
            edges,
            business_rules,
            data_flows,
        })
    }
}

impl DdsParser {
    /// Extract the value inside a DDS keyword like TEXT('some text') or COLHDG('heading').
    fn extract_keyword_value(upper: &str, original: &str, keyword: &str) -> Option<String> {
        let pattern = format!("{}(", keyword.to_uppercase());
        if let Some(start) = upper.find(&pattern) {
            let val_start = start + pattern.len();
            // Handle quoted values: TEXT('...')
            if upper.as_bytes().get(val_start) == Some(&b'\'') {
                let content_start = val_start + 1;
                if let Some(end) = original[content_start..].find('\'') {
                    return Some(original[content_start..content_start + end].to_string());
                }
            }
            // Handle unquoted: PFILE(CUSTMAS)
            if let Some(end) = upper[val_start..].find(')') {
                return Some(original[val_start..val_start + end].trim().to_string());
            }
        }
        None
    }
}
