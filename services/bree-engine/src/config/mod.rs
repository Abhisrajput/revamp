//! Configuration loaded from environment variables.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default = "default_environment")]
    pub environment: String,
    #[serde(default = "default_metrics_port")]
    pub metrics_port: u16,
}

fn default_port() -> u16 { 8081 }
fn default_log_level() -> String { "info".to_string() }
fn default_environment() -> String { "development".to_string() }
fn default_metrics_port() -> u16 { 9091 }

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();
        let config: Config = envy::from_env()?;
        Ok(config)
    }
}
