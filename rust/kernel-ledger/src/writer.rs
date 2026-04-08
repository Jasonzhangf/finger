//! Ledger Writer

use std::path::Path;
use std::fs::OpenOptions;
use std::io::Write;
use crate::types::TaskDigestEntry;

pub fn append_task_digest(path: &Path, entry: &TaskDigestEntry) -> Result<(), std::io::Error> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let json = serde_json::to_string(entry)?;
    writeln!(file, "{}", json)?;
    Ok(())
}
