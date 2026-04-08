//! Ledger Reader

use std::path::Path;
use std::fs::File;
use std::io::BufRead;
use std::io::BufReader;
use crate::types::TaskDigestEntry;

pub fn read_ledger_entries(path: &Path) -> Result<Vec<serde_json::Value>, std::io::Error> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let entries: Vec<serde_json::Value> = reader
        .lines()
        .filter_map(|line| line.ok())
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect();
    Ok(entries)
}

pub fn read_task_digests(path: &Path) -> Result<Vec<TaskDigestEntry>, std::io::Error> {
    let entries = read_ledger_entries(path)?;
    let digests: Vec<TaskDigestEntry> = entries
        .into_iter()
        .filter_map(|e| serde_json::from_value(e).ok())
        .collect();
    Ok(digests)
}
