//! MEMORY.md writer — appends learning records to the ## Learnings section

use crate::types::LearningRecord;
use crate::learning_extractor::dedup_learnings;
use std::fs;
use std::path::Path;

const LEARNINGS_HEADER: &str = "## Learnings";

/// Append learning records to a MEMORY.md file.
///
/// - Creates `## Learnings` section if it doesn't exist
/// - Deduplicates against existing entries AND within new_records (by dedup_key)
/// - Preserves all other content in the file
pub fn append_learnings_to_memory(
    path: &Path,
    new_records: &[LearningRecord],
) -> Result<usize, String> {
    if new_records.is_empty() {
        return Ok(0);
    }

    // Dedup new_records themselves first
    let deduped_new = dedup_learnings(new_records);

    let content = fs::read_to_string(path).unwrap_or_default();
    let existing_keys = extract_existing_keys(&content);

    let mut appended = 0;
    let mut additions = String::new();
    for record in deduped_new {
        let key = record.dedup_key();
        if existing_keys.contains(&key) {
            continue;
        }
        additions.push_str(&format_record(&record));
        appended += 1;
    }

    if appended == 0 {
        return Ok(0);
    }

    let new_content = if content.contains(LEARNINGS_HEADER) {
        // Insert after the header line
        if let Some(pos) = content.find(LEARNINGS_HEADER) {
            let after_header = pos + LEARNINGS_HEADER.len();
            // Skip past the header line and any trailing newline
            let insert_pos = content[after_header..]
                .find('\n')
                .map(|i| after_header + i + 1)
                .unwrap_or(content.len());
            format!("{}{}{}", &content[..insert_pos], additions, &content[insert_pos..])
        } else {
            format!("{}\n{}", content, additions)
        }
    } else {
        // Append new section
        format!("{}\n\n{}\n{}\n", content.trim_end(), LEARNINGS_HEADER, additions)
    };

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    fs::write(path, new_content).map_err(|e| format!("Failed to write MEMORY.md: {}", e))?;
    Ok(appended)
}

/// Extract existing dedup keys from the ## Learnings section
fn extract_existing_keys(content: &str) -> Vec<String> {
    let section = extract_learnings_section(content);
    // Look for dedup key markers embedded as HTML comments
    let mut keys = Vec::new();
    for line in section.lines() {
        if let Some(key) = line.strip_prefix("<!-- dedup:") {
            if let Some(end) = key.find("-->") {
                keys.push(key[..end].to_string());
            }
        }
    }
    keys
}

/// Extract the ## Learnings section content
fn extract_learnings_section(content: &str) -> String {
    if let Some(start) = content.find(LEARNINGS_HEADER) {
        let after_header = &content[start + LEARNINGS_HEADER.len()..];
        // Find the next ## header (if any)
        let end = after_header
            .find("\n## ")
            .unwrap_or(after_header.len());
        after_header[..end].to_string()
    } else {
        String::new()
    }
}

fn format_record(record: &LearningRecord) -> String {
    let mut lines = Vec::new();
    lines.push(format!("<!-- dedup:{} -->", record.dedup_key()));
    lines.push(format!("### {} [{}]", record.timestamp, record.agent_id));
    lines.push(format!("Goal: {}", record.goal));
    if !record.successes.is_empty() {
        lines.push("Successes:".to_string());
        for s in &record.successes {
            lines.push(format!("- {}", s));
        }
    }
    if !record.failures.is_empty() {
        lines.push("Failures:".to_string());
        for f in &record.failures {
            lines.push(format!("- {}", f));
        }
    }
    if !record.tags.is_empty() {
        lines.push(format!("Tags: {}", record.tags.join(", ")));
    }
    lines.push(format!("Summary: {}", record.summary));
    lines.push(String::new()); // blank line separator
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TaskOutcome;
    use tempfile::NamedTempFile;

    fn test_record(goal: &str, tags: Vec<&str>, failures: Vec<&str>) -> LearningRecord {
        LearningRecord {
            id: "test-id".to_string(),
            timestamp: "2026-04-09T15:00:00Z".to_string(),
            agent_id: "test-agent".to_string(),
            session_id: "test-session".to_string(),
            goal: goal.to_string(),
            summary: format!("Summary for {}", goal),
            successes: vec!["success1".to_string()],
            failures: failures.into_iter().map(String::from).collect(),
            tags: tags.into_iter().map(String::from).collect(),
            tools_used: vec![],
            outcome: TaskOutcome::Completed,
        }
    }

    #[test]
    fn test_creates_learnings_section() {
        let file = NamedTempFile::new().unwrap();
        fs::write(file.path(), "# System Memory\n\nSome content\n").unwrap();

        let records = vec![test_record("G1", vec!["t1"], vec![])];
        let count = append_learnings_to_memory(file.path(), &records).unwrap();
        assert_eq!(count, 1);

        let result = fs::read_to_string(file.path()).unwrap();
        assert!(result.contains("## Learnings"));
        assert!(result.contains("Goal: G1"));
        assert!(result.contains("# System Memory"));
    }

    #[test]
    fn test_dedup_prevents_duplicate() {
        let file = NamedTempFile::new().unwrap();
        fs::write(file.path(), "").unwrap();

        let records = vec![
            test_record("G1", vec!["t1"], vec!["f1"]),
            test_record("G1", vec!["t1"], vec!["f1"]), // same dedup key
        ];
        let count = append_learnings_to_memory(file.path(), &records).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_append_to_existing_section() {
        let file = NamedTempFile::new().unwrap();
        fs::write(file.path(), "# Memory\n\n## Learnings\n\nExisting\n\n## Other\n\nOther content\n").unwrap();

        let records = vec![test_record("NewGoal", vec![], vec![])];
        let count = append_learnings_to_memory(file.path(), &records).unwrap();
        assert_eq!(count, 1);

        let result = fs::read_to_string(file.path()).unwrap();
        assert!(result.contains("Existing"));
        assert!(result.contains("Goal: NewGoal"));
        assert!(result.contains("## Other"));
    }

    #[test]
    fn test_empty_records() {
        let file = NamedTempFile::new().unwrap();
        let count = append_learnings_to_memory(file.path(), &[]).unwrap();
        assert_eq!(count, 0);
    }
}
