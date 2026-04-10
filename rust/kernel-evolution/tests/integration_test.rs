//! Integration test: ledger entries → extract → write MEMORY.md

use kernel_evolution::{extract_learnings, dedup_learnings, append_learnings_to_memory};
use serde_json::json;
use std::fs;
use tempfile::TempDir;

fn make_ledger_entry(summary: &str, goal: &str, tags: Vec<&str>, failures: Vec<&str>) -> serde_json::Value {
    json!({
        "event_type": "tool_call",
        "timestamp_iso": "2026-04-09T15:00:00Z",
        "session_id": "integration-session",
        "agent_id": "integration-agent",
        "payload": {
            "tool_name": "reasoning.stop",
            "input": {
                "summary": summary,
                "goal": goal,
                "successes": ["completed task"],
                "failures": failures,
                "tags": tags,
                "toolsUsed": [{"tool": "exec_command", "status": "success"}],
                "status": "completed"
            }
        }
    })
}

#[test]
fn test_full_pipeline() {
    let entries = vec![
        json!({"event_type": "turn_start"}),
        make_ledger_entry("Fixed the bug", "Fix login bug", vec!["debug", "auth"], vec!["first attempt failed"]),
        json!({"event_type": "turn_start"}),
        make_ledger_entry("Added feature", "Add dark mode", vec!["feature", "ui"], vec![]),
    ];

    // Step 1: Extract learnings
    let records = extract_learnings(&entries);
    assert_eq!(records.len(), 2);

    // Step 2: Dedup
    let deduped = dedup_learnings(&records);
    assert_eq!(deduped.len(), 2);

    // Step 3: Write to MEMORY.md
    let dir = TempDir::new().unwrap();
    let memory_path = dir.path().join("MEMORY.md");
    fs::write(&memory_path, "# System Memory\n\nExisting content\n").unwrap();

    let count = append_learnings_to_memory(&memory_path, &deduped).unwrap();
    assert_eq!(count, 2);

    // Verify content
    let result = fs::read_to_string(&memory_path).unwrap();
    assert!(result.contains("# System Memory"));
    assert!(result.contains("## Learnings"));
    assert!(result.contains("Goal: Fix login bug"));
    assert!(result.contains("Goal: Add dark mode"));
    assert!(result.contains("Existing content"));
}

#[test]
fn test_pipeline_with_dedup() {
    let entries = vec![
        make_ledger_entry("S1", "G1", vec!["t1"], vec!["f1"]),
        make_ledger_entry("S2", "G1", vec!["t1"], vec!["f1"]), // same dedup key
    ];

    let records = extract_learnings(&entries);
    let deduped = dedup_learnings(&records);

    let dir = TempDir::new().unwrap();
    let memory_path = dir.path().join("MEMORY.md");
    fs::write(&memory_path, "").unwrap();

    let count = append_learnings_to_memory(&memory_path, &deduped).unwrap();
    assert_eq!(count, 1);

    let result = fs::read_to_string(&memory_path).unwrap();
    assert!(result.contains("S2")); // kept the later one
}
