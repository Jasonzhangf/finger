//! Compact Current History

use crate::types::*;
use crate::task_digest::identify_tasks;

/// Compact current history when contextUsage >= 85%
pub fn compact_current_history(
    entries: &[serde_json::Value],
    session_id: &str,
    agent_id: &str,
    mode: &str,
) -> Vec<TaskDigestEntry> {
    let tasks = identify_tasks(entries);
    
    tasks.iter().map(|task| {
        let tags = task.extract_tags();
        let digest = task.build_digest();
        let original = OriginalLayer {
            turns: task.turns.clone(),
            total_bytes: task.turns.iter().map(|e| e.to_string().len()).sum(),
        };
        
        TaskDigestEntry::new(
            session_id.to_string(),
            agent_id.to_string(),
            mode.to_string(),
            task.start_timestamp.clone(),
            task.end_timestamp.clone(),
            tags,
            TwoLayerFormat { original, digest },
        )
    }).collect()
}
