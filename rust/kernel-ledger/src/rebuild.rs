//! Tag-Based Context Rebuild

use crate::types::TaskDigestEntry;

/// Rebuild context history using tag-based filtering
/// 
/// Algorithm:
/// 1. LLM picks relevant tags from currentUserMessage + globalTagTable
/// 2. Filter task digests by relevant tags
/// 3. Fill from newest to oldest within budget (20K tokens)
pub fn rebuild_context_history(
    digests: &[TaskDigestEntry],
    current_user_message: &str,
    global_tag_table: &[String],
    budget_tokens: usize,
) -> RebuildResult {
    // Step 1: LLM picks relevant tags
    let relevant_tags = pick_relevant_tags(current_user_message, global_tag_table);
    
    // Step 2: Filter by tags
    let filtered: Vec<&TaskDigestEntry> = digests
        .iter()
        .filter(|d| d.tags.iter().any(|t| relevant_tags.contains(t)))
        .collect();
    
    // Step 3: Fill from newest to oldest within budget
    let mut selected: Vec<&TaskDigestEntry> = Vec::new();
    let mut tokens_used: usize = 0;
    
    // Reverse to iterate from newest to oldest
    for entry in filtered.iter().rev() {
        let entry_tokens = entry.layers.digest.estimated_tokens;
        if tokens_used + entry_tokens > budget_tokens {
            break;
        }
        selected.push(*entry);
        tokens_used += entry_tokens;
    }
    
    // Reverse back to maintain chronological order
    selected.reverse();
    
    RebuildResult {
        selected_digests: selected.into_iter().cloned().collect(),
        relevant_tags,
        tokens_used,
        budget_tokens,
        total_filtered: filtered.len(),
        total_available: digests.len(),
    }
}

/// Pick relevant tags using LLM
/// 
/// This function should be called from TS layer via FFI.
/// For now, we use a simple keyword matching approach.
pub fn pick_relevant_tags(
    current_user_message: &str,
    global_tag_table: &[String],
) -> Vec<String> {
    let message_lower = current_user_message.to_lowercase();
    
    // Simple keyword matching (will be replaced by LLM call)
    let mut relevant: Vec<String> = Vec::new();
    
    for tag in global_tag_table {
        let tag_lower = tag.to_lowercase();
        
        // Direct match
        if message_lower.contains(&tag_lower) {
            relevant.push(tag.clone());
            continue;
        }
        
        // Semantic aliases (hardcoded for now)
        if tag_matches_alias(&tag_lower, &message_lower) {
            relevant.push(tag.clone());
        }
    }
    
    // If no matches, return all tags (fallback)
    if relevant.is_empty() {
        relevant = global_tag_table.to_vec();
    }
    
    relevant
}

fn tag_matches_alias(tag: &str, message: &str) -> bool {
    match tag {
        "build" => message.contains("编译") || message.contains("build") || message.contains("cargo"),
        "rust" => message.contains("rust") || message.contains("rs "),
        "multi-protocol" => message.contains("protocol") || message.contains("协议"),
        "recovery" => message.contains("recover") || message.contains("恢复"),
        "test" => message.contains("test") || message.contains("测试"),
        "e2e" => message.contains("e2e") || message.contains("end-to-end"),
        "ledger" => message.contains("ledger") || message.contains("账本"),
        "compact" => message.contains("compact") || message.contains("压缩"),
        "context" => message.contains("context") || message.contains("上下文"),
        _ => false,
    }
}

/// Rebuild result
#[derive(Debug, Clone)]
pub struct RebuildResult {
    pub selected_digests: Vec<TaskDigestEntry>,
    pub relevant_tags: Vec<String>,
    pub tokens_used: usize,
    pub budget_tokens: usize,
    pub total_filtered: usize,
    pub total_available: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    fn create_test_digest(tags: Vec<&str>, estimated_tokens: usize) -> TaskDigestEntry {
        TaskDigestEntry {
            id: "test-1".to_string(),
            timestamp_start: "2026-04-08T00:00:00Z".to_string(),
            timestamp_end: "2026-04-08T00:01:00Z".to_string(),
            session_id: "session-1".to_string(),
            agent_id: "finger-system-agent".to_string(),
            mode: "main".to_string(),
            event_type: "task_digest".to_string(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            layers: TwoLayerFormat {
                original: OriginalLayer {
                    turns: vec![],
                    total_bytes: 0,
                },
                digest: TaskDigest {
                    goal: "test goal".to_string(),
                    result: "test result".to_string(),
                    key_turns: vec![],
                    changed_files: vec![],
                    outcome: TaskOutcome::Success,
                    estimated_tokens,
                },
            },
        }
    }

    #[test]
    fn test_rebuild_filters_by_tag() {
        let digests = vec![
            create_test_digest(vec!["rust", "build"], 1000),
            create_test_digest(vec!["test", "e2e"], 1000),
            create_test_digest(vec!["ledger", "compact"], 1000),
        ];
        
        let global_tags = vec!["rust".to_string(), "build".to_string(), "test".to_string()];
        let result = rebuild_context_history(&digests, "fix rust build", &global_tags, 5000);
        
        // Should filter to only rust/build digest
        assert_eq!(result.selected_digests.len(), 1);
        assert!(result.selected_digests[0].tags.contains(&"rust".to_string()));
    }

    #[test]
    fn test_rebuild_respects_budget() {
        let digests = vec![
            create_test_digest(vec!["rust"], 5000),
            create_test_digest(vec!["rust"], 5000),
            create_test_digest(vec!["rust"], 5000),
        ];
        
        let global_tags = vec!["rust".to_string()];
        let result = rebuild_context_history(&digests, "rust stuff", &global_tags, 12000);
        
        // Should only fit 2 entries (10000 tokens) within 12000 budget
        assert_eq!(result.selected_digests.len(), 2);
        assert_eq!(result.tokens_used, 10000);
    }

    #[test]
    fn test_tag_alias_matching() {
        let global_tags = vec!["build".to_string(), "rust".to_string()];
        
        // Test "build" alias
        let relevant = pick_relevant_tags("cargo build failed", &global_tags);
        assert!(relevant.contains(&"build".to_string()));
        
        // Test "rust" alias
        let relevant = pick_relevant_tags("src/lib.rs error", &global_tags);
        assert!(relevant.contains(&"rust".to_string()));
    }
}
