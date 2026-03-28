//! Copybook / include resolver — resolves COPY, /COPY, INCLUDE, uses
//! statements against actual files in the source vault.
//!
//! Produces a resolved dependency graph showing which includes were
//! found vs missing (unresolved).

use crate::parser::nir::DependencyRef;
use crate::parser::traits::SourceVault;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedDependencies {
    pub total_references: usize,
    pub resolved: Vec<ResolvedRef>,
    pub unresolved: Vec<UnresolvedRef>,
    pub resolution_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedRef {
    pub from_module: String,
    pub reference_name: String,
    pub resolved_path: String,
    pub reference_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnresolvedRef {
    pub from_module: String,
    pub reference_name: String,
    pub reference_text: String,
    pub search_attempted: Vec<String>,
}

/// Attempt to resolve all COPY/INCLUDE dependencies against files in the vault.
pub fn resolve_dependencies(
    deps: &[DependencyRef],
    vault: &SourceVault,
) -> ResolvedDependencies {
    // Build a lookup: filename stem → full path
    let mut file_index: HashMap<String, Vec<String>> = HashMap::new();
    for file in &vault.files {
        let stem = file.path.file_stem()
            .map(|s| s.to_string_lossy().to_uppercase())
            .unwrap_or_default();
        let full = file.path.to_string_lossy().to_string();
        file_index.entry(stem.clone()).or_default().push(full.clone());

        // Also index by filename with extension
        let name = file.path.file_name()
            .map(|s| s.to_string_lossy().to_uppercase())
            .unwrap_or_default();
        if name != stem {
            file_index.entry(name).or_default().push(full);
        }
    }

    let copy_deps: Vec<&DependencyRef> = deps.iter()
        .filter(|d| matches!(d.dependency_type,
            crate::parser::nir::DependencyType::CopyInclude))
        .collect();

    let mut resolved = Vec::new();
    let mut unresolved = Vec::new();

    for dep in &copy_deps {
        let ref_name = dep.to_module.to_uppercase();
        // Strip path components: "QRPGLESRC,CUSTDS" → "CUSTDS", "/opt/sas/macros/common.sas" → "COMMON"
        let clean_name = ref_name.rsplit(&['/', '\\', ','][..])
            .next().unwrap_or(&ref_name)
            .split('.').next().unwrap_or(&ref_name)
            .trim().to_string();

        // Search strategies
        let mut searched = Vec::new();
        let mut found = None;

        // 1. Exact stem match
        searched.push(format!("stem={}", clean_name));
        if let Some(paths) = file_index.get(&clean_name) {
            found = Some(paths[0].clone());
        }

        // 2. With common extensions
        if found.is_none() {
            for ext in &["CPY", "CBL", "COB", "RPGLE", "CLP", "PLL", "SAS", "INC"] {
                let with_ext = format!("{}.{}", clean_name, ext);
                searched.push(format!("name={}", with_ext));
                if let Some(paths) = file_index.get(&with_ext) {
                    found = Some(paths[0].clone());
                    break;
                }
            }
        }

        // 3. Substring match (for library-qualified names like QRPGLESRC/CUSTDS)
        if found.is_none() {
            for (key, paths) in &file_index {
                if key.contains(&clean_name) || clean_name.contains(key.as_str()) {
                    searched.push(format!("partial={}", key));
                    found = Some(paths[0].clone());
                    break;
                }
            }
        }

        match found {
            Some(path) => resolved.push(ResolvedRef {
                from_module: dep.from_module.clone(),
                reference_name: dep.to_module.clone(),
                resolved_path: path,
                reference_text: dep.reference_text.clone(),
            }),
            None => unresolved.push(UnresolvedRef {
                from_module: dep.from_module.clone(),
                reference_name: dep.to_module.clone(),
                reference_text: dep.reference_text.clone(),
                search_attempted: searched,
            }),
        }
    }

    let total = copy_deps.len();
    let rate = if total > 0 { resolved.len() as f64 / total as f64 } else { 1.0 };

    ResolvedDependencies {
        total_references: total,
        resolved,
        unresolved,
        resolution_rate: rate,
    }
}
