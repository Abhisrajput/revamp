//! Call graph generation — builds dependency graphs and outputs Mermaid diagrams.

use crate::parser::nir::{AstNodeKind, DependencyRef, DependencyType, ParseOutput};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
pub struct CallGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub mermaid: String,
    pub stats: GraphStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub node_type: String,
    pub file: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub edge_type: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphStats {
    pub total_nodes: usize,
    pub total_edges: usize,
    pub max_fan_out: usize,
    pub max_fan_in: usize,
    pub orphan_nodes: usize,
}

/// Build a call graph from parsed outputs and resolved dependencies.
pub fn build_call_graph(
    outputs: &[&ParseOutput],
    dependencies: &[DependencyRef],
) -> CallGraph {
    let mut nodes: HashMap<String, GraphNode> = HashMap::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut fan_out: HashMap<String, usize> = HashMap::new();
    let mut fan_in: HashMap<String, usize> = HashMap::new();

    // Add program/module nodes
    for output in outputs {
        let short = output.source_path.rsplit('/').next().unwrap_or(&output.source_path);
        let id = sanitize_id(short);
        nodes.insert(id.clone(), GraphNode {
            id: id.clone(),
            label: short.to_string(),
            node_type: "program".to_string(),
            file: output.source_path.clone(),
            language: output.language_id.clone(),
        });

        // Add internal paragraph/function nodes
        for sym in &output.symbols {
            if matches!(sym.kind, crate::parser::nir::SymbolKind::Paragraph
                | crate::parser::nir::SymbolKind::Procedure
                | crate::parser::nir::SymbolKind::Function
                | crate::parser::nir::SymbolKind::Subroutine) {
                let sub_id = format!("{}_{}", id, sanitize_id(&sym.name));
                nodes.insert(sub_id.clone(), GraphNode {
                    id: sub_id,
                    label: sym.name.clone(),
                    node_type: "function".to_string(),
                    file: output.source_path.clone(),
                    language: output.language_id.clone(),
                });
            }
        }

        // Add internal call edges (PERFORM, EXSR)
        for node in &output.ast_nodes {
            if matches!(node.kind, AstNodeKind::PerformStatement) {
                if let Some(target) = &node.name {
                    let from_id = id.clone();
                    let to_id = format!("{}_{}", id, sanitize_id(target));
                    edges.push(GraphEdge {
                        from: from_id.clone(), to: to_id.clone(),
                        edge_type: "perform".to_string(), label: "PERFORM".to_string(),
                    });
                    *fan_out.entry(from_id).or_insert(0) += 1;
                    *fan_in.entry(to_id).or_insert(0) += 1;
                }
            }
        }
    }

    // Add cross-module edges from dependencies
    for dep in dependencies {
        let from_short = dep.from_module.rsplit('/').next().unwrap_or(&dep.from_module);
        let from_id = sanitize_id(from_short);

        match &dep.dependency_type {
            DependencyType::ProgramCall => {
                let to_id = sanitize_id(&dep.to_module);
                // Add target node if not exists
                nodes.entry(to_id.clone()).or_insert(GraphNode {
                    id: to_id.clone(), label: dep.to_module.clone(),
                    node_type: "external_program".to_string(),
                    file: String::new(), language: String::new(),
                });
                edges.push(GraphEdge {
                    from: from_id.clone(), to: to_id.clone(),
                    edge_type: "call".to_string(), label: "CALL".to_string(),
                });
                *fan_out.entry(from_id).or_insert(0) += 1;
                *fan_in.entry(to_id).or_insert(0) += 1;
            }
            DependencyType::CopyInclude => {
                let to_id = sanitize_id(&dep.to_module);
                nodes.entry(to_id.clone()).or_insert(GraphNode {
                    id: to_id.clone(), label: dep.to_module.clone(),
                    node_type: "copybook".to_string(),
                    file: String::new(), language: String::new(),
                });
                edges.push(GraphEdge {
                    from: from_id.clone(), to: to_id.clone(),
                    edge_type: "copy".to_string(), label: "COPY".to_string(),
                });
            }
            DependencyType::DatabaseAccess => {
                let to_id = format!("db_{}", sanitize_id(&dep.to_module));
                nodes.entry(to_id.clone()).or_insert(GraphNode {
                    id: to_id.clone(), label: dep.to_module.clone(),
                    node_type: "database".to_string(),
                    file: String::new(), language: String::new(),
                });
                edges.push(GraphEdge {
                    from: from_id.clone(), to: to_id.clone(),
                    edge_type: "db_access".to_string(), label: "SQL".to_string(),
                });
            }
            DependencyType::CrossLanguage { target_language } => {
                let to_id = sanitize_id(&dep.to_module);
                nodes.entry(to_id.clone()).or_insert(GraphNode {
                    id: to_id.clone(), label: dep.to_module.clone(),
                    node_type: format!("cross_lang_{}", target_language),
                    file: String::new(), language: target_language.clone(),
                });
                edges.push(GraphEdge {
                    from: from_id.clone(), to: to_id.clone(),
                    edge_type: "cross_language".to_string(),
                    label: format!("→{}", target_language),
                });
            }
            _ => {}
        }
    }

    // Dedup edges
    let mut seen_edges: HashSet<String> = HashSet::new();
    edges.retain(|e| {
        let key = format!("{}->{}", e.from, e.to);
        seen_edges.insert(key)
    });

    // Generate Mermaid
    let mermaid = generate_mermaid(&nodes, &edges);

    // Stats
    let all_edge_nodes: HashSet<&str> = edges.iter()
        .flat_map(|e| vec![e.from.as_str(), e.to.as_str()])
        .collect();
    let orphans = nodes.keys().filter(|k| !all_edge_nodes.contains(k.as_str())).count();

    let stats = GraphStats {
        total_nodes: nodes.len(),
        total_edges: edges.len(),
        max_fan_out: fan_out.values().copied().max().unwrap_or(0),
        max_fan_in: fan_in.values().copied().max().unwrap_or(0),
        orphan_nodes: orphans,
    };

    CallGraph {
        nodes: nodes.into_values().collect(),
        edges,
        mermaid,
        stats,
    }
}

fn generate_mermaid(nodes: &HashMap<String, GraphNode>, edges: &[GraphEdge]) -> String {
    let mut md = String::from("graph TD\n");

    // Style nodes by type
    for node in nodes.values() {
        let shape = match node.node_type.as_str() {
            "program" => format!("    {}[\"{}\"]\n", node.id, node.label),
            "function" => format!("    {}(\"{}\")\n", node.id, node.label),
            "external_program" => format!("    {}[[\"{}\"]]:::external\n", node.id, node.label),
            "copybook" => format!("    {}>\"{}\"]\n", node.id, node.label),
            "database" => format!("    {}[(\"{}\")]:::db\n", node.id, node.label),
            _ => format!("    {}{{\"{}\"}}:::crosslang\n", node.id, node.label),
        };
        md.push_str(&shape);
    }

    // Add edges
    for edge in edges {
        let arrow = match edge.edge_type.as_str() {
            "call" => "-->",
            "perform" => "-.->",
            "copy" => "-.-o",
            "db_access" => "==>",
            "cross_language" => "-->",
            _ => "-->",
        };
        md.push_str(&format!("    {} {}|{}| {}\n", edge.from, arrow, edge.label, edge.to));
    }

    // Styles
    md.push_str("    classDef external fill:#f96,stroke:#333\n");
    md.push_str("    classDef db fill:#69f,stroke:#333\n");
    md.push_str("    classDef crosslang fill:#f6f,stroke:#333\n");

    md
}

fn sanitize_id(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}
