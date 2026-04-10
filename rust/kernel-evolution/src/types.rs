//! Evolution system types

use serde::{Deserialize, Serialize};

/// Outcome of a task, extracted from reasoning.stop status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskOutcome {
    Completed,
    Blocked,
    Handoff,
}

/// Record of a tool usage from a task
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUsage {
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    pub status: String,
}

/// A single learning record extracted from a reasoning.stop event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningRecord {
    pub id: String,
    pub timestamp: String,
    pub agent_id: String,
    pub session_id: String,
    pub goal: String,
    pub summary: String,
    pub successes: Vec<String>,
    pub failures: Vec<String>,
    pub tags: Vec<String>,
    pub tools_used: Vec<ToolUsage>,
    pub outcome: TaskOutcome,
}

impl LearningRecord {
    /// Generate a dedup key from tags + failures combination
    pub fn dedup_key(&self) -> String {
        let mut sorted_tags = self.tags.clone();
        sorted_tags.sort();
        let mut sorted_failures = self.failures.clone();
        sorted_failures.sort();
        format!("{}|{}|{}", sorted_tags.join(","), sorted_failures.join(","), self.goal)
    }
}
