//! Query interface for mempalace data access through the memory bridge.
//!
//! Provides a high-level query API for reading, filtering, and
//! transforming mempalace bridge data.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors that can occur during query operations.
#[derive(Debug, Error)]
pub enum QueryError {
    #[error("query parse error: {0}")]
    ParseError(String),
    #[error("execution error: {0}")]
    ExecutionError(String),
    #[error("no results found for query: {0}")]
    NoResults(String),
    #[error("invalid field name: {0}")]
    InvalidField(String),
}

/// A typed data record stored in the mempalace bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataRecord {
    pub id: String,
    pub namespace: String,
    pub payload: serde_json::Value,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl DataRecord {
    pub fn new(namespace: String, payload: serde_json::Value) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();
        Self {
            id,
            namespace,
            payload,
            tags: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Result of a query execution.
#[derive(Debug, Clone)]
pub struct QueryResult {
    pub records: Vec<DataRecord>,
    pub total_count: usize,
    pub query_hash: String,
}

impl QueryResult {
    pub fn empty() -> Self {
        Self {
            records: Vec::new(),
            total_count: 0,
            query_hash: String::new(),
        }
    }

    pub fn from_records(records: Vec<DataRecord>) -> Self {
        let total_count = records.len();
        Self {
            records,
            total_count,
            query_hash: String::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

/// Filter conditions for querying bridge data.
#[derive(Debug, Clone)]
pub struct QueryFilter {
    pub namespace: Option<String>,
    pub tags: Vec<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

impl QueryFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn in_namespace(mut self, ns: &str) -> Self {
        self.namespace = Some(ns.to_string());
        self
    }

    pub fn with_tag(mut self, tag: &str) -> Self {
        self.tags.push(tag.to_string());
        self
    }

    pub fn limit(mut self, n: usize) -> Self {
        self.limit = Some(n);
        self
    }

    pub fn offset(mut self, n: usize) -> Self {
        self.offset = Some(n);
        self
    }

    /// Check if a record matches this filter.
    pub fn matches(&self, record: &DataRecord) -> bool {
        if let Some(ref ns) = self.namespace {
            if record.namespace != *ns {
                return false;
            }
        }
        if !self.tags.is_empty() {
            let all_tags_present = self
                .tags
                .iter()
                .all(|t| record.tags.contains(t));
            if !all_tags_present {
                return false;
            }
        }
        true
    }
}

impl Default for QueryFilter {
    fn default() -> Self {
        Self {
            namespace: None,
            tags: Vec::new(),
            limit: None,
            offset: None,
        }
    }
}

/// Query engine for mempalace bridge data.
///
/// Stores records in-memory and supports filtered queries
/// with namespace and tag-based matching.
#[derive(Debug, Clone, Default)]
pub struct MempalaceQuery {
    records: HashMap<String, DataRecord>,
}

impl MempalaceQuery {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a data record into the query index.
    pub fn insert(&mut self, record: DataRecord) {
        self.records.insert(record.id.clone(), record);
    }

    /// Remove a record by ID.
    pub fn remove(&mut self, id: &str) -> Option<DataRecord> {
        self.records.remove(id)
    }

    /// Get a single record by ID.
    pub fn get(&self, id: &str) -> Option<&DataRecord> {
        self.records.get(id)
    }

    /// Execute a filtered query.
    pub fn query(&self, filter: &QueryFilter) -> QueryResult {
        let mut matched: Vec<DataRecord> = self
            .records
            .values()
            .filter(|r| filter.matches(r))
            .cloned()
            .collect();

        if let Some(offset) = filter.offset {
            let drop = offset.min(matched.len());
            matched.drain(..drop);
        }
        if let Some(limit) = filter.limit {
            matched.truncate(limit);
        }

        let total = matched.len();
        QueryResult {
            records: matched,
            total_count: total,
            query_hash: format!("{:x}", simple_hash(&format!("{:?}", filter))),
        }
    }

    /// List all records in a namespace.
    pub fn list_namespace(&self, namespace: &str) -> Vec<&DataRecord> {
        self.records
            .values()
            .filter(|r| r.namespace == namespace)
            .collect()
    }

    /// Count records across all namespaces.
    pub fn count(&self) -> usize {
        self.records.len()
    }

    /// Get all unique namespaces.
    pub fn namespaces(&self) -> Vec<String> {
        let mut ns: Vec<String> = self
            .records
            .values()
            .map(|r| r.namespace.clone())
            .collect();
        ns.sort();
        ns.dedup();
        ns
    }
}

/// Simple deterministic hash for query fingerprinting.
fn simple_hash(input: &str) -> u64 {
    let mut hash: u64 = 5381;
    for byte in input.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(byte as u64);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(ns: &str, tags: Vec<&str>) -> DataRecord {
        DataRecord::new(ns.to_string(), serde_json::json!({"test": true}))
            .with_tags(tags.into_iter().map(String::from).collect())
    }

    #[test]
    fn test_insert_and_get() {
        let mut q = MempalaceQuery::new();
        let rec = make_record("ns1", vec!["a"]);
        let id = rec.id.clone();
        q.insert(rec);
        assert!(q.get(&id).is_some());
    }

    #[test]
    fn test_query_by_namespace() {
        let mut q = MempalaceQuery::new();
        q.insert(make_record("alpha", vec![]));
        q.insert(make_record("beta", vec![]));
        q.insert(make_record("alpha", vec![]));

        let filter = QueryFilter::new().in_namespace("alpha");
        let result = q.query(&filter);
        assert_eq!(result.total_count, 2);
    }

    #[test]
    fn test_query_by_tags() {
        let mut q = MempalaceQuery::new();
        q.insert(make_record("ns", vec!["rust", "sync"]));
        q.insert(make_record("ns", vec!["rust"]));
        q.insert(make_record("ns", vec!["python"]));

        let filter = QueryFilter::new().with_tag("rust").with_tag("sync");
        let result = q.query(&filter);
        assert_eq!(result.total_count, 1);
    }

    #[test]
    fn test_query_with_limit_offset() {
        let mut q = MempalaceQuery::new();
        for i in 0..10 {
            q.insert(make_record("ns", vec![&format!("tag{}", i)]));
        }
        let filter = QueryFilter::new().in_namespace("ns").limit(3).offset(2);
        let result = q.query(&filter);
        assert_eq!(result.records.len(), 3);
    }

    #[test]
    fn test_remove() {
        let mut q = MempalaceQuery::new();
        let rec = make_record("ns", vec![]);
        let id = rec.id.clone();
        q.insert(rec);
        assert!(q.remove(&id).is_some());
        assert!(q.get(&id).is_none());
    }

    #[test]
    fn test_namespaces() {
        let mut q = MempalaceQuery::new();
        q.insert(make_record("a", vec![]));
        q.insert(make_record("b", vec![]));
        q.insert(make_record("a", vec![]));
        let ns = q.namespaces();
        assert_eq!(ns, vec!["a", "b"]);
    }
}
