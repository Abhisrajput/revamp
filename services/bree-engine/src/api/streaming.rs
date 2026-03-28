//! SSE streaming endpoint for analysis progress.

use crate::api::server::SharedState;
use crate::detection::{detector::PolyglotDetector, scanner};
use crate::analysis::{dead_code, complexity, call_graph, data_lineage, business_rules, resolver};
use crate::parser::nir::DependencyRef;
use crate::parser::traits::{SourceFile, SourceVault};
use axum::{
    extract::State,
    response::sse::{Event, Sse},
    Json,
};
use futures_util::stream::Stream;
use serde::Deserialize;
use std::convert::Infallible;
use std::path::PathBuf;
use tokio_stream::StreamExt;

#[derive(Deserialize)]
pub struct StreamRequest {
    pub path: Option<String>,
    pub files: Option<Vec<FileInput>>,
}

#[derive(Deserialize)]
pub struct FileInput {
    pub path: String,
    pub content: String,
}

pub async fn analyze_stream(
    State(state): State<SharedState>,
    Json(req): Json<StreamRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Event>(64);

    tokio::spawn(async move {
        // Build vault
        let vault = if let Some(path) = req.path {
            match scanner::scan_directory(std::path::Path::new(&path)) {
                Ok((v, summary)) => {
                    let _ = tx.send(Event::default().event("info")
                        .data(serde_json::json!({"message": "Directory scanned", "files": summary.files_included}).to_string())
                    ).await;
                    v
                }
                Err(e) => {
                    let _ = tx.send(Event::default().event("error")
                        .data(serde_json::json!({"error": e.to_string()}).to_string())
                    ).await;
                    return;
                }
            }
        } else if let Some(files) = req.files {
            let mut v = SourceVault::new(PathBuf::from("."));
            for f in files { v.add_file(SourceFile::new(PathBuf::from(&f.path), f.content)); }
            v
        } else {
            let _ = tx.send(Event::default().event("error")
                .data("{\"error\":\"No files or path\"}".to_string())
            ).await;
            return;
        };

        let total = vault.files.len();

        // Step 1: Detection
        let _ = tx.send(Event::default().event("step")
            .data(serde_json::json!({"step":"detection","status":"running","files":total}).to_string())
        ).await;

        let detector = PolyglotDetector::new();
        let profile = detector.detect(&vault);

        let _ = tx.send(Event::default().event("step")
            .data(serde_json::json!({"step":"detection","status":"done","languages":profile.stats.languages_found}).to_string())
        ).await;

        // Step 2: Parsing
        let _ = tx.send(Event::default().event("step")
            .data(serde_json::json!({"step":"parsing","status":"running"}).to_string())
        ).await;

        let mut outputs = Vec::new();
        let mut deps: Vec<DependencyRef> = Vec::new();
        let mut parsed = 0usize;

        for (i, file) in vault.files.iter().enumerate() {
            if let Some(parser) = state.registry.find_parser(file) {
                if let Ok(out) = parser.parse(file) {
                    deps.extend(parser.resolve_dependencies(&out, &vault));
                    outputs.push(out);
                    parsed += 1;
                }
            }
            if (i + 1) % 5 == 0 || i == total - 1 {
                let _ = tx.send(Event::default().event("progress")
                    .data(serde_json::json!({"step":"parsing","done":i+1,"total":total,"parsed":parsed}).to_string())
                ).await;
            }
        }

        let _ = tx.send(Event::default().event("step")
            .data(serde_json::json!({"step":"parsing","status":"done","parsed":parsed}).to_string())
        ).await;

        // Step 3: Deep analysis
        let _ = tx.send(Event::default().event("step")
            .data(serde_json::json!({"step":"analysis","status":"running"}).to_string())
        ).await;

        let refs: Vec<_> = outputs.iter().collect();
        let dc = dead_code::detect_dead_code(&refs);

        let _ = tx.send(Event::default().event("progress")
            .data(serde_json::json!({"step":"analysis","module":"dead_code","dead_paragraphs":dc.unreachable_paragraphs.len()}).to_string())
        ).await;

        let cx = complexity::analyze_complexity(&refs);

        let _ = tx.send(Event::default().event("progress")
            .data(serde_json::json!({"step":"analysis","module":"complexity","avg":format!("{:.1}",cx.average_complexity)}).to_string())
        ).await;

        let cg = call_graph::build_call_graph(&refs, &deps);

        let _ = tx.send(Event::default().event("progress")
            .data(serde_json::json!({"step":"analysis","module":"call_graph","nodes":cg.stats.total_nodes,"edges":cg.stats.total_edges}).to_string())
        ).await;

        let dl = data_lineage::trace_lineage(&refs);
        let br = business_rules::extract_rules(&refs);
        let resolved = resolver::resolve_dependencies(&deps, &vault);

        let _ = tx.send(Event::default().event("step")
            .data(serde_json::json!({
                "step":"analysis","status":"done",
                "dead_paragraphs":dc.unreachable_paragraphs.len(),
                "complexity_avg":format!("{:.1}",cx.average_complexity),
                "graph_nodes":cg.stats.total_nodes,
                "business_rules":br.total_rules,
                "fields_tracked":dl.total_fields_tracked,
                "resolved_rate":format!("{:.0}%",resolved.resolution_rate*100.0),
            }).to_string())
        ).await;

        // Send Mermaid diagram
        let _ = tx.send(Event::default().event("mermaid")
            .data(cg.mermaid)
        ).await;

        // Done
        let _ = tx.send(Event::default().event("done")
            .data(serde_json::json!({"files":total,"parsed":parsed,"rules":br.total_rules}).to_string())
        ).await;
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx)
        .map(|event| Ok::<_, Infallible>(event));

    Sse::new(stream)
}
