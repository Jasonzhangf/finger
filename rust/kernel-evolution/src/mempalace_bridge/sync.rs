//! Thread-safe synchronization primitives for the mempalace memory bridge.
//!
//! Provides RwLock-based shared state management for concurrent access
//! to mempalace bridge data structures.

use std::collections::HashMap;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use thiserror::Error;

/// Errors that can occur during sync operations.
#[derive(Debug, Error)]
pub enum SyncError {
    #[error("failed to acquire lock: {0}")]
    LockPoisoned(String),
    #[error("resource not found: {0}")]
    NotFound(String),
    #[error("invalid state transition: {0}")]
    InvalidState(String),
}

impl<T> From<std::sync::PoisonError<RwLockReadGuard<'_, T>>> for SyncError {
    fn from(err: std::sync::PoisonError<RwLockReadGuard<'_, T>>) -> Self {
        SyncError::LockPoisoned(err.to_string())
    }
}

impl<T> From<std::sync::PoisonError<RwLockWriteGuard<'_, T>>> for SyncError {
    fn from(err: std::sync::PoisonError<RwLockWriteGuard<'_, T>>) -> Self {
        SyncError::LockPoisoned(err.to_string())
    }
}

/// A single entry in the mempalace bridge state.
#[derive(Debug, Clone)]
pub struct BridgeEntry {
    pub key: String,
    pub value: serde_json::Value,
    pub version: u64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl BridgeEntry {
    pub fn new(key: String, value: serde_json::Value) -> Self {
        let now = chrono::Utc::now();
        Self {
            key,
            value,
            version: 1,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn update(&mut self, value: serde_json::Value) {
        self.value = value;
        self.version += 1;
        self.updated_at = chrono::Utc::now();
    }
}

/// Internal state held behind the RwLock.
#[derive(Debug, Default)]
struct BridgeState {
    entries: HashMap<String, BridgeEntry>,
    generation: u64,
}

/// Thread-safe mempalace bridge state manager.
///
/// Uses `Arc<RwLock<>>` internally to allow cheap cloning
/// and concurrent read-heavy access patterns.
#[derive(Debug, Clone, Default)]
pub struct BridgeSync {
    state: Arc<RwLock<BridgeState>>,
}

impl BridgeSync {
    pub fn new() -> Self {
        Self {
            state: Arc::new(RwLock::new(BridgeState::default())),
        }
    }

    /// Insert or update an entry in the bridge.
    /// Returns the new version number on success.
    pub fn upsert(&self, key: String, value: serde_json::Value) -> Result<u64, SyncError> {
        let mut state = self.state.write()?;
        state.generation += 1;

        match state.entries.get_mut(&key) {
            Some(entry) => {
                entry.update(value);
                Ok(entry.version)
            }
            None => {
                let entry = BridgeEntry::new(key.clone(), value);
                let version = entry.version;
                state.entries.insert(key, entry);
                Ok(version)
            }
        }
    }

    /// Read a single entry by key.
    pub fn get(&self, key: &str) -> Result<Option<BridgeEntry>, SyncError> {
        let state = self.state.read()?;
        Ok(state.entries.get(key).cloned())
    }

    /// Read all keys currently in the bridge.
    pub fn keys(&self) -> Result<Vec<String>, SyncError> {
        let state = self.state.read()?;
        Ok(state.entries.keys().cloned().collect())
    }

    /// Remove an entry by key. Returns true if the entry existed.
    pub fn remove(&self, key: &str) -> Result<bool, SyncError> {
        let mut state = self.state.write()?;
        Ok(state.entries.remove(key).is_some())
    }

    /// Snapshot the current generation and entry count.
    pub fn snapshot(&self) -> Result<BridgeSnapshot, SyncError> {
        let state = self.state.read()?;
        Ok(BridgeSnapshot {
            generation: state.generation,
            entry_count: state.entries.len(),
        })
    }

    /// Clear all entries and increment generation.
    pub fn clear(&self) -> Result<(), SyncError> {
        let mut state = self.state.write()?;
        state.entries.clear();
        state.generation += 1;
        Ok(())
    }
}

/// Lightweight snapshot of bridge state for monitoring.
#[derive(Debug, Clone)]
pub struct BridgeSnapshot {
    pub generation: u64,
    pub entry_count: usize,
}

/// Atomic counter for tracking bridge operations.
#[derive(Debug, Clone, Default)]
pub struct OperationCounter {
    inner: Arc<RwLock<CounterState>>,
}

#[derive(Debug, Default)]
struct CounterState {
    reads: u64,
    writes: u64,
    errors: u64,
}

impl OperationCounter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_read(&self) {
        if let Ok(mut state) = self.inner.write() {
            state.reads += 1;
        }
    }

    pub fn record_write(&self) {
        if let Ok(mut state) = self.inner.write() {
            state.writes += 1;
        }
    }

    pub fn record_error(&self) {
        if let Ok(mut state) = self.inner.write() {
            state.errors += 1;
        }
    }

    pub fn totals(&self) -> CounterTotals {
        self.inner
            .read()
            .map(|s| CounterTotals {
                reads: s.reads,
                writes: s.writes,
                errors: s.errors,
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Default)]
pub struct CounterTotals {
    pub reads: u64,
    pub writes: u64,
    pub errors: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upsert_and_get() {
        let sync = BridgeSync::new();
        let version = sync
            .upsert("key1".to_string(), serde_json::json!({"data": "hello"}))
            .expect("upsert should succeed");
        assert_eq!(version, 1);

        let entry = sync.get("key1").expect("get should succeed");
        assert!(entry.is_some());
        let entry = entry.unwrap();
        assert_eq!(entry.version, 1);
    }

    #[test]
    fn test_update_increments_version() {
        let sync = BridgeSync::new();
        sync.upsert("k".to_string(), serde_json::json!(1))
            .unwrap();
        let v2 = sync
            .upsert("k".to_string(), serde_json::json!(2))
            .unwrap();
        assert_eq!(v2, 2);
    }

    #[test]
    fn test_remove() {
        let sync = BridgeSync::new();
        sync.upsert("x".to_string(), serde_json::json!("val"))
            .unwrap();
        assert!(sync.remove("x").unwrap());
        assert!(!sync.remove("x").unwrap());
        assert!(sync.get("x").unwrap().is_none());
    }

    #[test]
    fn test_snapshot() {
        let sync = BridgeSync::new();
        sync.upsert("a".to_string(), serde_json::json!(1)).unwrap();
        sync.upsert("b".to_string(), serde_json::json!(2)).unwrap();
        let snap = sync.snapshot().unwrap();
        assert_eq!(snap.entry_count, 2);
        assert!(snap.generation >= 2);
    }

    #[test]
    fn test_operation_counter() {
        let counter = OperationCounter::new();
        counter.record_read();
        counter.record_read();
        counter.record_write();
        counter.record_error();
        let t = counter.totals();
        assert_eq!(t.reads, 2);
        assert_eq!(t.writes, 1);
        assert_eq!(t.errors, 1);
    }
}
