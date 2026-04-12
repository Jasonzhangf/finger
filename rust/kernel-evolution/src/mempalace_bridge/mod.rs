//! Mempalace Bridge — Shared memory bridge for kernel evolution data
//!
//! This module provides a thread-safe interface for reading and writing
//! mempalace data through shared memory synchronization primitives.
//!
//! # Architecture
//! - `sync` — Thread-safe synchronization primitives (Mutex/RwLock based)
//! - `query` — Query API for mempalace data access
//!
//! # Thread Safety
//! All public types are `Send + Sync` and safe to share across threads.

pub mod sync;
pub mod cli;
pub mod query;

// Re-export key sync types for ergonomic access
pub use sync::{BridgeSync, BridgeEntry, BridgeSnapshot, SyncError, OperationCounter, CounterTotals};

// Re-export key query types for ergonomic access
pub use query::{MempalaceQuery, QueryFilter, QueryResult, QueryError, DataRecord};

// Re-export key cli types for ergonomic access
pub use cli::{MempalaceCli, CliError};

/// Public module version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_is_nonempty() {
        assert!(!VERSION.is_empty());
    }

    #[test]
    fn test_sync_creation() {
        let sync = BridgeSync::new();
        let snap = sync.snapshot().expect("snapshot should work");
        assert_eq!(snap.entry_count, 0);
    }

    #[test]
    fn test_query_creation() {
        let query = MempalaceQuery::new();
        assert_eq!(query.count(), 0);
    }
}
