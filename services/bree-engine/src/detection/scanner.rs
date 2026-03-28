//! Source vault directory scanner — walks a filesystem path and builds
//! a SourceVault with all source files for detection and parsing.
//!
//! Filters out binary files, node_modules, .git, build artifacts, etc.

use crate::parser::traits::{SourceFile, SourceVault};
use std::collections::HashSet;
use std::path::Path;
use tracing::{debug, info, warn};

/// Directories to always skip.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "target", "bin", "obj",
    "dist", "build", ".next", "__pycache__", ".gradle", ".idea",
    ".vscode", ".DS_Store", "vendor", ".terraform",
];

/// Binary file extensions to skip.
const BINARY_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "o", "a", "lib", "class", "jar",
    "war", "ear", "zip", "tar", "gz", "bz2", "7z", "rar",
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "mp3", "mp4", "avi", "mov", "wmv", "flv",
    "woff", "woff2", "ttf", "eot", "otf",
    "pbl", "pbd", "fmb", "fmx", // PowerBuilder/Oracle Forms binary formats
    "sas7bdat", // SAS binary dataset
];

/// Maximum file size to read (10 MB).
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// Scan results summary.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanSummary {
    pub root_path: String,
    pub total_files_found: usize,
    pub files_included: usize,
    pub files_skipped_binary: usize,
    pub files_skipped_too_large: usize,
    pub files_skipped_unreadable: usize,
    pub directories_skipped: usize,
    pub total_lines: usize,
    pub total_bytes: u64,
}

/// Scan a directory and build a SourceVault.
pub fn scan_directory(root: &Path) -> anyhow::Result<(SourceVault, ScanSummary)> {
    if !root.exists() {
        anyhow::bail!("Path does not exist: {}", root.display());
    }
    if !root.is_dir() {
        anyhow::bail!("Path is not a directory: {}", root.display());
    }

    let skip_dirs: HashSet<&str> = SKIP_DIRS.iter().copied().collect();
    let binary_exts: HashSet<&str> = BINARY_EXTENSIONS.iter().copied().collect();

    let mut vault = SourceVault::new(root.to_path_buf());
    let mut summary = ScanSummary {
        root_path: root.to_string_lossy().to_string(),
        total_files_found: 0,
        files_included: 0,
        files_skipped_binary: 0,
        files_skipped_too_large: 0,
        files_skipped_unreadable: 0,
        directories_skipped: 0,
        total_lines: 0,
        total_bytes: 0,
    };

    walk_dir(root, &skip_dirs, &binary_exts, &mut vault, &mut summary)?;

    summary.total_lines = vault.total_lines();
    summary.total_bytes = vault.files.iter().map(|f| f.size).sum();

    info!(
        root = %root.display(),
        files = summary.files_included,
        lines = summary.total_lines,
        bytes = summary.total_bytes,
        skipped_binary = summary.files_skipped_binary,
        skipped_large = summary.files_skipped_too_large,
        "Directory scan complete"
    );

    Ok((vault, summary))
}

fn walk_dir(
    dir: &Path,
    skip_dirs: &HashSet<&str>,
    binary_exts: &HashSet<&str>,
    vault: &mut SourceVault,
    summary: &mut ScanSummary,
) -> anyhow::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            warn!(dir = %dir.display(), error = %e, "Cannot read directory");
            return Ok(());
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();

        if path.is_dir() {
            let dir_name = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if skip_dirs.contains(dir_name.as_str()) || dir_name.starts_with('.') {
                summary.directories_skipped += 1;
                debug!(dir = %dir_name, "Skipping directory");
                continue;
            }
            walk_dir(&path, skip_dirs, binary_exts, vault, summary)?;
        } else if path.is_file() {
            summary.total_files_found += 1;

            let ext = path.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            // Skip binary files
            if binary_exts.contains(ext.as_str()) {
                summary.files_skipped_binary += 1;
                continue;
            }

            // Skip too-large files
            let metadata = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    summary.files_skipped_unreadable += 1;
                    continue;
                }
            };
            if metadata.len() > MAX_FILE_SIZE {
                summary.files_skipped_too_large += 1;
                continue;
            }

            // Read file content
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    vault.add_file(SourceFile::new(path, content));
                    summary.files_included += 1;
                }
                Err(_) => {
                    // Likely binary content — skip silently
                    summary.files_skipped_unreadable += 1;
                }
            }
        }
    }
    Ok(())
}

/// Quick scan — only count files and detect extensions without reading contents.
/// Much faster for large codebases when you just need a language inventory.
pub fn quick_scan(root: &Path) -> anyhow::Result<QuickScanResult> {
    if !root.is_dir() {
        anyhow::bail!("Not a directory: {}", root.display());
    }

    let skip_dirs: HashSet<&str> = SKIP_DIRS.iter().copied().collect();
    let binary_exts: HashSet<&str> = BINARY_EXTENSIONS.iter().copied().collect();
    let mut result = QuickScanResult {
        root_path: root.to_string_lossy().to_string(),
        extension_counts: std::collections::HashMap::new(),
        total_files: 0,
    };

    quick_walk(root, &skip_dirs, &binary_exts, &mut result)?;
    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct QuickScanResult {
    pub root_path: String,
    pub extension_counts: std::collections::HashMap<String, usize>,
    pub total_files: usize,
}

fn quick_walk(
    dir: &Path,
    skip_dirs: &HashSet<&str>,
    binary_exts: &HashSet<&str>,
    result: &mut QuickScanResult,
) -> anyhow::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if !skip_dirs.contains(name.as_str()) && !name.starts_with('.') {
                quick_walk(&path, skip_dirs, binary_exts, result)?;
            }
        } else if path.is_file() {
            let ext = path.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_else(|| "no-ext".to_string());
            if !binary_exts.contains(ext.as_str()) {
                *result.extension_counts.entry(ext).or_insert(0) += 1;
                result.total_files += 1;
            }
        }
    }
    Ok(())
}
