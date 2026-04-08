//! Task Digest Generation

use crate::types::*;

/// Identify tasks from ledger entries (task = turn_start to reasoning.stop)
pub fn identify_tasks(entries: &[serde_json::Value]) -> Vec<Task> {
    let mut tasks = Vec::new();
    let mut current_task: Option<Task> = None;
    let mut current_turns: Vec<serde_json::Value> = Vec::new();
    
    for entry in entries {
        let event_type = entry.get("event_type").and_then(|v| v.as_str()).unwrap_or("");
        
        // Track turn_start for task boundary
        if event_type == "turn_start" {
            // If we have accumulated turns but no reasoning.stop, create a task
            if current_task.is_none() && current_turns.len() > 0 {
                // This is an incomplete task, skip it
                current_turns.clear();
            }
            
            current_task = Some(Task {
                turns: vec![],
                start_timestamp: entry.get("timestamp_iso").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                end_timestamp: "".to_string(),
                session_id: entry.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                agent_id: entry.get("agent_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                mode: entry.get("mode").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                finish_turn: None,
            });
        }
        
        // Accumulate all entries
        if let Some(ref mut task) = current_task {
            task.turns.push(entry.clone());
            
            // Check if reasoning.stop was called
            if event_type == "tool_call" {
                let tool_name = entry.get("payload")
                    .and_then(|p| p.get("tool_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                
                if tool_name == "reasoning.stop" {
                    task.end_timestamp = entry.get("timestamp_iso").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    task.finish_turn = Some(entry.clone());
                    tasks.push(task.clone());
                    current_task = None;
                }
            }
        }
    }
    
    tasks
}

/// Task structure
#[derive(Debug, Clone)]
pub struct Task {
    pub turns: Vec<serde_json::Value>,
    pub start_timestamp: String,
    pub end_timestamp: String,
    pub session_id: String,
    pub agent_id: String,
    pub mode: String,
    pub finish_turn: Option<serde_json::Value>,
}

impl Task {
    /// Extract tags from finish turn (reasoning.stop input.tags)
    pub fn extract_tags(&self) -> Vec<String> {
        if let Some(ref finish) = self.finish_turn {
            finish.get("payload")
                .and_then(|p| p.get("input"))
                .and_then(|i| i.get("tags"))
                .and_then(|t| t.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        }
    }
    
    /// Extract key turns (reasoning.stop, agent.dispatch, etc.)
    pub fn extract_key_turns(&self) -> Vec<KeyTurn> {
        let mut key_turns = Vec::new();
        
        for entry in &self.turns {
            if entry.get("event_type").and_then(|v| v.as_str()) == Some("tool_call") {
                let tool_name = entry.get("payload")
                    .and_then(|p| p.get("tool_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                
                if KEY_TOOLS.contains(&tool_name) {
                    key_turns.push(KeyTurn {
                        tool: tool_name.to_string(),
                        timestamp: entry.get("timestamp_iso").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        summary: extract_tool_summary(entry),
                        target: extract_target_agent(entry),
                        outcome: extract_outcome(entry),
                    });
                }
            }
        }
        
        key_turns
    }
    
    /// Build digest from task
    pub fn build_digest(&self) -> TaskDigest {
        let key_turns = self.extract_key_turns();
        
        // Extract goal from reasoning.stop input.goal
        let goal = self.finish_turn
            .as_ref()
            .and_then(|f| f.get("payload"))
            .and_then(|p| p.get("input"))
            .and_then(|i| i.get("goal"))
            .and_then(|g| g.as_str())
            .unwrap_or("")
            .to_string();
        
        // Extract result from reasoning.stop input.summary
        let result = self.finish_turn
            .as_ref()
            .and_then(|f| f.get("payload"))
            .and_then(|p| p.get("input"))
            .and_then(|i| i.get("summary"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        
        // Extract changed files
        let changed_files = extract_changed_files(&self.turns);
        
        // Determine outcome
        let outcome = determine_outcome(&self.turns);
        
        // Estimate tokens (chars / 4)
        let digest_text = format!("{} {}", goal, result);
        let estimated_tokens = digest_text.len() / 4;
        
        TaskDigest {
            goal,
            result,
            key_turns,
            changed_files,
            outcome,
            estimated_tokens,
        }
    }
}

fn extract_tool_summary(entry: &serde_json::Value) -> String {
    entry.get("payload")
        .and_then(|p| p.get("input"))
        .and_then(|i| i.get("summary"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .chars()
        .take(100)
        .collect()
}

fn extract_target_agent(entry: &serde_json::Value) -> Option<String> {
    entry.get("payload")
        .and_then(|p| p.get("input"))
        .and_then(|i| i.get("targetAgentId"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

fn extract_outcome(entry: &serde_json::Value) -> Option<String> {
    entry.get("payload")
        .and_then(|p| p.get("output"))
        .and_then(|o| o.get("approved"))
        .and_then(|v| v.as_bool())
        .map(|b| if b { "approved" } else { "rejected" }.to_string())
}

fn extract_changed_files(turns: &[serde_json::Value]) -> Vec<String> {
    let mut files = Vec::new();
    for entry in turns {
        if entry.get("event_type").and_then(|v| v.as_str()) == Some("tool_result") {
            let output = entry.get("payload").and_then(|p| p.get("output"));
            if let Some(o) = output {
                if let Some(changed) = o.get("changedFiles") {
                    if let Some(arr) = changed.as_array() {
                        for f in arr {
                            if let Some(s) = f.as_str() {
                                files.push(s.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    files
}

fn determine_outcome(turns: &[serde_json::Value]) -> TaskOutcome {
    for entry in turns.iter().rev() {
        if entry.get("event_type").and_then(|v| v.as_str()) == Some("tool_result") {
            let tool_name = entry.get("payload")
                .and_then(|p| p.get("tool_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            
            if tool_name == "project.approve_task" {
                return TaskOutcome::Success;
            }
            if tool_name == "project.reject_task" {
                return TaskOutcome::Rejected;
            }
        }
    }
    
    // Default to success if reasoning.stop was called
    TaskOutcome::Success
}
