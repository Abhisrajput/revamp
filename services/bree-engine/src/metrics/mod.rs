//! Prometheus metrics for BREE engine.

use metrics::{counter, gauge, describe_counter, describe_gauge};

pub fn register_metrics() {
    describe_counter!("bree_files_parsed_total", "Total files parsed by language");
    describe_counter!("bree_detection_runs_total", "Total language detection runs");
    describe_gauge!("bree_registered_parsers", "Number of registered language parsers");
    describe_gauge!("bree_languages_detected", "Languages detected in last run");
}

pub fn record_detection_run(languages_found: usize) {
    counter!("bree_detection_runs_total").increment(1);
    gauge!("bree_languages_detected").set(languages_found as f64);
}

pub fn record_files_parsed(language: &str, count: usize) {
    counter!("bree_files_parsed_total", "language" => language.to_string()).increment(count as u64);
}

pub fn set_registered_parsers(count: usize) {
    gauge!("bree_registered_parsers").set(count as f64);
}
