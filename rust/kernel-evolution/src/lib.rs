//! Kernel Evolution — Learning extraction and self-improvement for Finger
//!
//! Provides:
//! - Learning extraction from reasoning.stop events in context ledger
//! - Structured storage to MEMORY.md ## Learnings section
//! - Deduplication of learning records

pub mod types;
pub mod learning_extractor;
pub mod memory_writer;
pub mod mempalace_bridge;

pub use types::*;
pub use learning_extractor::*;
pub use memory_writer::*;
