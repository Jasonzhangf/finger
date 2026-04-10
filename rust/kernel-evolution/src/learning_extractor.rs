//! Learning Extractor — extracts structured learning records from ledger entries
//!
//! Scans tool_call events with tool_name == "reasoning.stop" and extracts
//! successes, failures, tags, toolsUsed, goal, summary into LearningRecord structs.

use crate::types::{LearningRecord, TaskOutcome, ToolUsage};
use serde_json::Value;

/// Extract all learning records from a slice of ledger entries.
///
/// Each ledger entry is a JSON object with at least:
/// - event_type: "tool_call"
/// - payload.tool_name: "reasoning.stop"
/// - payload.input.successes, failures, tags, toolsUsed, goal, summary, status
/// - timestamp_iso, session_id, agent_id
pub fn extract_learnings(entries: &[Value]) -> Vec<LearningRecord> {
    entries
        .iter()
        .filter(|e| {
            let event_type = e.get("event_type").and_then(|v| v.as_str()).unwrap_or("");
            let tool_name = e
                .get("payload")
                .and_then(|p| p.get("tool_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            event_type == "tool_call" && tool_name == "reasoning.stop"
        })
        .filter_map(|e| build_record(e))
        .collect()
}

/// Deduplicate learning records by their dedup_key, keeping the latest.
pub fn dedup_learnings(records: &[LearningRecord]) -> Vec<LearningRecord> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, r) in records.iter().enumerate() {
        let key = r.dedup_key();
        seen.entry(key).and_modify(|existing| {
            // keep later entry (higher index = later)
            *existing = i;
        }).or_insert(i);
    }
    let mut indices: Vec<usize> = seen.values().copied().collect();
    indices.sort();
    indices.into_iter().map(|i| records[i].clone()).collect()
}

fn build_record(entry: &Value) -> Option<LearningRecord> {
    let payload = entry.get("payload")?;
    let input = payload.get("input")?;

    let summary = input.get("summary").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let goal = input.get("goal").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if summary.is_empty() || goal.is_empty() {
        return None;
    }

    let successes = extract_string_array(input, "successes");
    let failures = extract_string_array(input, "failures");
    let tags = extract_string_array(input, "tags");
    let tools_used = extract_tools_used(input);
    let outcome = parse_outcome(input.get("status").and_then(|v| v.as_str()));

    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = entry
        .get("timestamp_iso")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let agent_id = entry
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let session_id = entry
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Some(LearningRecord {
        id,
        timestamp,
        agent_id,
        session_id,
        goal,
        summary,
        successes,
        failures,
        tags,
        tools_used,
        outcome,
    })
}

fn extract_string_array(obj: &Value, field: &str) -> Vec<String> {
    obj.get(field)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn extract_tools_used(input: &Value) -> Vec<ToolUsage> {
    input
        .get("toolsUsed")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let tool = v.get("tool").and_then(|t| t.as_str())?.to_string();
                    let status = v
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let args = v.get("args").and_then(|a| a.as_str()).map(String::from);
                    Some(ToolUsage { tool, args, status })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_outcome(status: Option<&str>) -> TaskOutcome {
    match status {
        Some("blocked") => TaskOutcome::Blocked,
        Some("handoff") => TaskOutcome::Handoff,
        _ => TaskOutcome::Completed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_reasoning_stop(summary: &str, goal: &str, tags: Vec<&str>, failures: Vec<&str>, status: &str) -> Value {
        json!({
            "event_type": "tool_call",
            "timestamp_iso": "2026-04-09T15:00:00Z",
            "session_id": "test-session",
            "agent_id": "test-agent",
            "payload": {
                "tool_name": "reasoning.stop",
                "input": {
                    "summary": summary,
                    "goal": goal,
                    "successes": ["s1"],
                    "failures": failures,
                    "tags": tags,
                    "toolsUsed": [{"tool": "exec_command", "status": "success"}],
                    "status": status
                }
            }
        })
    }

    #[test]
    fn test_extract_from_reasoning_stop() {
        let entries = vec![
            json!({"event_type": "turn_start"}),
            make_reasoning_stop("Test summary", "Test goal", vec!["tag1"], vec!["f1"], "completed"),
        ];
        let records = extract_learnings(&entries);
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.goal, "Test goal");
        assert_eq!(r.summary, "Test summary");
        assert_eq!(r.successes, vec!["s1"]);
        assert_eq!(r.failures, vec!["f1"]);
        assert_eq!(r.tags, vec!["tag1"]);
        assert_eq!(r.tools_used.len(), 1);
        assert_eq!(r.tools_used[0].tool, "exec_command");
        assert_eq!(r.outcome, TaskOutcome::Completed);
    }

    #[test]
    fn test_dedup() {
        let entries = vec![
            make_reasoning_stop("S1", "G1", vec!["t1"], vec!["f1"], "completed"),
            make_reasoning_stop("S2 updated", "G1", vec!["t1"], vec!["f1"], "completed"),
        ];
        let records = extract_learnings(&entries);
        assert_eq!(records.len(), 2);
        let deduped = dedup_learnings(&records);
        assert_eq!(deduped.len(), 1);
        // Should keep the later one
        assert_eq!(deduped[0].summary, "S2 updated");
    }

    #[test]
    fn test_empty_failures() {
        let entries = vec![make_reasoning_stop("All good", "No failures", vec!["success"], vec![], "completed")];
        let records = extract_learnings(&entries);
        assert_eq!(records.len(), 1);
        assert!(records[0].failures.is_empty());
    }

    #[test]
    fn test_skips_non_reasoning_stop() {
        let entries = vec![
            json!({"event_type": "tool_call", "payload": {"tool_name": "exec_command"}}),
            json!({"event_type": "turn_start"}),
        ];
        let records = extract_learnings(&entries);
        assert!(records.is_empty());
    }

    #[test]
    fn test_blocked_outcome() {
        let entries = vec![make_reasoning_stop("Blocked", "G", vec![], vec!["blocked"], "blocked")];
        let records = extract_learnings(&entries);
        assert_eq!(records[0].outcome, TaskOutcome::Blocked);
    }
}
