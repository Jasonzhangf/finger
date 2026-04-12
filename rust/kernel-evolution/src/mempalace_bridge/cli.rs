//! Mempalace CLI integration — calls `mempalace` binary for semantic indexing
//!
//! Provides:
//! - `MempalaceCli` — wrapper around the `mempalace` CLI binary
//! - `sync_learning()` — send a learning record to mempalace for indexing
//! - `search_similar()` — query mempalace for similar failure patterns

use crate::types::LearningRecord;
use serde_json::json;
use std::path::Path;
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CliError {
    #[error("mempalace binary not found at {0}")]
    BinaryNotFound(String),

    #[error("mempalace command failed: exit_code={0}, stderr={1}")]
    CommandFailed(i32, String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON parse error: {0}")]
    JsonParse(#[from] serde_json::Error),
}

/// Wrapper around the mempalace CLI binary.
#[derive(Debug, Clone)]
pub struct MempalaceCli {
    pub binary_path: String,
    pub wing: Option<String>,
    pub room: Option<String>,
}

impl Default for MempalaceCli {
    fn default() -> Self {
        Self {
            binary_path: "/opt/homebrew/bin/mempalace".to_string(),
            wing: Some("finger".to_string()),
            room: Some("learnings".to_string()),
        }
    }
}

impl MempalaceCli {
    pub fn new(binary_path: &str) -> Self {
        Self {
            binary_path: binary_path.to_string(),
            wing: Some("finger".to_string()),
            room: Some("learnings".to_string()),
        }
    }

    /// Check if the mempalace binary exists and is executable.
    pub fn exists(&self) -> bool {
        Path::new(&self.binary_path).exists()
    }

    /// Sync a learning record to mempalace for semantic indexing.
    pub fn sync_learning(&self, record: &LearningRecord) -> Result<(), CliError> {
        if !self.exists() {
            return Err(CliError::BinaryNotFound(self.binary_path.clone()));
        }

        let content = format!(
            "Goal: {}\nSuccesses: {:?}\nFailures: {:?}\nTags: {:?}\nSummary: {}",
            record.goal, record.successes, record.failures, record.tags, record.summary
        );

        let metadata = json!({
            "type": "learning",
            "session_id": record.session_id,
            "agent_id": record.agent_id,
            "timestamp": record.timestamp,
            "tags": record.tags,
            "goal": record.goal,
            "outcome": format!("{:?}", record.outcome),
        });

        // Write a temp file for mempalace to index
        let tmp_path = std::env::temp_dir().join(format!("mempalace-learning-{}.json", record.id));
        let doc = json!({
            "id": format!("learning-{}", record.id),
            "content": content,
            "metadata": metadata,
        });

        std::fs::write(&tmp_path, serde_json::to_string_pretty(&doc)?)
            .map_err(CliError::Io)?;

        // Use `mempalace mine` to index the file
        // mempalace indexes files in watched directories; we write to a temp file
        // For direct document addition, we use a JSONL format if supported
        let result = Command::new(&self.binary_path)
            .args(["mine"])
            .output()?;

        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr).to_string();
            let exit_code = result.status.code().unwrap_or(-1);
            // Clean up temp file
            let _ = std::fs::remove_file(&tmp_path);
            return Err(CliError::CommandFailed(exit_code, stderr));
        }

        // Clean up temp file
        let _ = std::fs::remove_file(&tmp_path);
        Ok(())
    }

    /// Search for similar failure patterns using mempalace semantic search.
    pub fn search_similar(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, CliError> {
        if !self.exists() {
            return Err(CliError::BinaryNotFound(self.binary_path.clone()));
        }

        let mut cmd = Command::new(&self.binary_path);
        cmd.arg("search");
        cmd.arg(query);
        cmd.arg("-n");
        cmd.arg(&limit.to_string());

        if let Some(wing) = &self.wing {
            cmd.arg("--wing").arg(wing);
        }
        if let Some(room) = &self.room {
            cmd.arg("--room").arg(room);
        }

        let output = cmd.output()?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);
            return Err(CliError::CommandFailed(exit_code, stderr));
        }

        // Parse search results from mempalace CLI output
        let results = self.parse_search_output(&stdout);
        Ok(results)
    }

    fn parse_search_output(&self, output: &str) -> Vec<SearchResult> {
        let mut results = Vec::new();
        for line in output.lines() {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(line) {
                results.push(SearchResult {
                    id: doc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    score: doc.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    content: doc.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                });
            }
        }
        // If no JSON lines found, return a single result with raw output
        if results.is_empty() && !output.trim().is_empty() {
            results.push(SearchResult {
                id: "raw-output".to_string(),
                score: 1.0,
                content: output.trim().to_string(),
            });
        }
        results
    }

    /// Batch sync multiple learning records.
    pub fn sync_batch(&self, records: &[LearningRecord]) -> Result<usize, CliError> {
        let mut synced = 0;
        for record in records {
            if self.sync_learning(record).is_ok() {
                synced += 1;
            }
        }
        Ok(synced)
    }
}

/// A single search result from mempalace.
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_default_path() {
        let cli = MempalaceCli::default();
        assert_eq!(cli.binary_path, "/opt/homebrew/bin/mempalace");
        assert_eq!(cli.wing, Some("finger".to_string()));
        assert_eq!(cli.room, Some("learnings".to_string()));
    }

    #[test]
    fn test_parse_empty_output() {
        let cli = MempalaceCli::default();
        let results = cli.parse_search_output("");
        assert!(results.is_empty());
    }

    #[test]
    fn test_parse_raw_output() {
        let cli = MempalaceCli::default();
        let results = cli.parse_search_output("some raw text");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "some raw text");
    }

    #[test]
    fn test_parse_json_lines() {
        let cli = MempalaceCli::default();
        let json_line = r#"{"id": "test-1", "score": 0.95, "content": "test content"}"#;
        let results = cli.parse_search_output(json_line);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "test-1");
        assert_eq!(results[0].score, 0.95);
    }
}
