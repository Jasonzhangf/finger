//! Ledger Backfill Tool

use std::path::Path;
use crate::reader::read_ledger_entries;
use crate::writer::append_task_digest;
use crate::compact::compact_current_history;

/// Backfill existing ledger with task_digest entries
pub fn backfill_ledger(
    ledger_path: &Path,
    digest_path: &Path,
) -> Result<usize, std::io::Error> {
    let entries = read_ledger_entries(ledger_path)?;
    
    // Extract session_id, agent_id, mode from first entry
    let (session_id, agent_id, mode) = entries.first()
        .map(|e| {
            (
                e.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                e.get("agent_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                e.get("mode").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            )
        })
        .unwrap_or(("".to_string(), "".to_string(), "".to_string()));
    
    let task_digests = compact_current_history(&entries, &session_id, &agent_id, &mode);
    
    for entry in &task_digests {
        append_task_digest(digest_path, entry)?;
    }
    
    Ok(task_digests.len())
}
