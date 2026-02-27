use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

static ENTRY_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LedgerEntry {
    pub id: String,
    pub timestamp_ms: u64,
    pub timestamp_iso: String,
    pub session_id: String,
    pub agent_id: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextLedgerConfig {
    pub root_dir: PathBuf,
    pub session_id: String,
    pub agent_id: String,
    pub mode: String,
    pub role: Option<String>,
    pub can_read_all: bool,
    pub readable_agents: Vec<String>,
    pub focus_enabled: bool,
    pub focus_max_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LedgerQueryRequest {
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub mode: Option<String>,
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    pub limit: Option<usize>,
    pub contains: Option<String>,
    #[serde(default)]
    pub fuzzy: bool,
    pub event_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LedgerQueryResponse {
    pub entries: Vec<LedgerEntry>,
    pub timeline: Vec<LedgerTimelinePoint>,
    pub total: usize,
    pub truncated: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LedgerTimelinePoint {
    pub id: String,
    pub timestamp_ms: u64,
    pub timestamp_iso: String,
    pub event_type: String,
    pub agent_id: String,
    pub mode: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FocusInsertResult {
    pub chars: usize,
    pub truncated: bool,
}

#[derive(Debug, Error)]
pub enum ContextLedgerError {
    #[error("invalid config: {0}")]
    InvalidConfig(String),
    #[error("permission denied to read ledger for agent '{agent_id}'")]
    PermissionDenied { agent_id: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct ContextLedger {
    cfg: ContextLedgerConfig,
    readable_agent_set: HashSet<String>,
}

impl ContextLedger {
    pub fn new(cfg: ContextLedgerConfig) -> Result<Self, ContextLedgerError> {
        if cfg.session_id.trim().is_empty() {
            return Err(ContextLedgerError::InvalidConfig(
                "session_id cannot be empty".to_string(),
            ));
        }
        if cfg.agent_id.trim().is_empty() {
            return Err(ContextLedgerError::InvalidConfig(
                "agent_id cannot be empty".to_string(),
            ));
        }
        if cfg.mode.trim().is_empty() {
            return Err(ContextLedgerError::InvalidConfig(
                "mode cannot be empty".to_string(),
            ));
        }
        if cfg.focus_max_chars == 0 {
            return Err(ContextLedgerError::InvalidConfig(
                "focus_max_chars must be greater than 0".to_string(),
            ));
        }

        fs::create_dir_all(Self::resolve_base_dir(
            &cfg.root_dir,
            cfg.session_id.as_str(),
            cfg.agent_id.as_str(),
            cfg.mode.as_str(),
        ))?;

        let readable_agent_set = cfg
            .readable_agents
            .iter()
            .map(|item| sanitize_component(item))
            .filter(|item| !item.is_empty())
            .collect::<HashSet<_>>();

        Ok(Self {
            cfg,
            readable_agent_set,
        })
    }

    pub fn append_event(&self, event_type: &str, payload: Value) -> Result<(), ContextLedgerError> {
        let event_type = event_type.trim();
        if event_type.is_empty() {
            return Err(ContextLedgerError::InvalidConfig(
                "event_type cannot be empty".to_string(),
            ));
        }

        let (timestamp_ms, timestamp_iso) = now_timestamp();
        let id = format!(
            "led-{}-{}",
            timestamp_ms,
            ENTRY_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let entry = LedgerEntry {
            id,
            timestamp_ms,
            timestamp_iso,
            session_id: self.cfg.session_id.clone(),
            agent_id: self.cfg.agent_id.clone(),
            mode: self.cfg.mode.clone(),
            role: self.cfg.role.clone(),
            event_type: event_type.to_string(),
            payload,
        };

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.ledger_path())?;
        let line = serde_json::to_string(&entry)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()?;
        Ok(())
    }

    pub fn append_compact_memory(&self, payload: Value) -> Result<(), ContextLedgerError> {
        let (timestamp_ms, timestamp_iso) = now_timestamp();
        let id = format!(
            "cpt-{}-{}",
            timestamp_ms,
            ENTRY_COUNTER.fetch_add(1, Ordering::Relaxed)
        );

        let entry = serde_json::json!({
            "id": id,
            "timestamp_ms": timestamp_ms,
            "timestamp_iso": timestamp_iso,
            "session_id": self.cfg.session_id.as_str(),
            "agent_id": self.cfg.agent_id.as_str(),
            "mode": self.cfg.mode.as_str(),
            "role": self.cfg.role.as_deref(),
            "payload": payload,
        });

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.compact_memory_path())?;
        let line = serde_json::to_string(&entry)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()?;
        self.rebuild_compact_memory_index()?;
        Ok(())
    }

    pub fn read_focus(&self) -> Result<Option<String>, ContextLedgerError> {
        if !self.cfg.focus_enabled {
            return Ok(None);
        }
        let path = self.focus_path();
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        Ok(Some(trimmed.to_string()))
    }

    pub fn insert_focus(
        &self,
        text: &str,
        append: bool,
    ) -> Result<FocusInsertResult, ContextLedgerError> {
        if !self.cfg.focus_enabled {
            return Err(ContextLedgerError::InvalidConfig(
                "focus slot is disabled".to_string(),
            ));
        }
        let incoming = text.trim();
        if incoming.is_empty() {
            return Err(ContextLedgerError::InvalidConfig(
                "focus text cannot be empty".to_string(),
            ));
        }

        let mut merged = if append {
            match self.read_focus()? {
                Some(existing) if !existing.trim().is_empty() => format!("{existing}\n{incoming}"),
                _ => incoming.to_string(),
            }
        } else {
            incoming.to_string()
        };

        let original_chars = merged.chars().count();
        let mut truncated = false;
        if original_chars > self.cfg.focus_max_chars {
            merged = keep_tail_chars(&merged, self.cfg.focus_max_chars);
            truncated = true;
        }

        fs::write(self.focus_path(), merged.as_bytes())?;
        let _ = self.append_event(
            "focus_insert",
            serde_json::json!({
                "append": append,
                "chars": merged.chars().count(),
                "truncated": truncated,
            }),
        );

        Ok(FocusInsertResult {
            chars: merged.chars().count(),
            truncated,
        })
    }

    pub fn query(
        &self,
        request: &LedgerQueryRequest,
    ) -> Result<LedgerQueryResponse, ContextLedgerError> {
        let target_session = request
            .session_id
            .as_deref()
            .map(sanitize_component)
            .filter(|item| !item.is_empty())
            .unwrap_or_else(|| sanitize_component(self.cfg.session_id.as_str()));
        let target_agent = request
            .agent_id
            .as_deref()
            .map(sanitize_component)
            .filter(|item| !item.is_empty())
            .unwrap_or_else(|| sanitize_component(self.cfg.agent_id.as_str()));
        let target_mode = request
            .mode
            .as_deref()
            .map(sanitize_component)
            .filter(|item| !item.is_empty())
            .unwrap_or_else(|| sanitize_component(self.cfg.mode.as_str()));

        if target_agent != sanitize_component(self.cfg.agent_id.as_str())
            && !self.cfg.can_read_all
            && !self.readable_agent_set.contains(target_agent.as_str())
        {
            return Err(ContextLedgerError::PermissionDenied {
                agent_id: target_agent,
            });
        }

        let ledger_path = Self::resolve_ledger_path(
            &self.cfg.root_dir,
            target_session.as_str(),
            target_agent.as_str(),
            target_mode.as_str(),
        );

        let entries = read_entries(ledger_path.as_path())?;
        let filtered = filter_entries(entries, request);
        let total = filtered.len();
        let limit = request.limit.unwrap_or(50).max(1).min(500);
        let truncated = total > limit;
        let final_entries = if truncated {
            filtered[total - limit..].to_vec()
        } else {
            filtered
        };

        Ok(LedgerQueryResponse {
            timeline: build_timeline(&final_entries),
            entries: final_entries,
            total,
            truncated,
            source: ledger_path.to_string_lossy().to_string(),
        })
    }

    pub fn default_root_dir() -> PathBuf {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".finger")
            .join("sessions")
    }

    pub fn root_dir(&self) -> &Path {
        self.cfg.root_dir.as_path()
    }

    pub fn session_id(&self) -> &str {
        self.cfg.session_id.as_str()
    }

    pub fn agent_id(&self) -> &str {
        self.cfg.agent_id.as_str()
    }

    pub fn mode(&self) -> &str {
        self.cfg.mode.as_str()
    }

    pub fn can_read_all(&self) -> bool {
        self.cfg.can_read_all
    }

    pub fn readable_agents(&self) -> &[String] {
        self.cfg.readable_agents.as_slice()
    }

    pub fn focus_max_chars(&self) -> usize {
        self.cfg.focus_max_chars
    }

    fn ledger_path(&self) -> PathBuf {
        Self::resolve_ledger_path(
            &self.cfg.root_dir,
            self.cfg.session_id.as_str(),
            self.cfg.agent_id.as_str(),
            self.cfg.mode.as_str(),
        )
    }

    fn focus_path(&self) -> PathBuf {
        Self::resolve_base_dir(
            &self.cfg.root_dir,
            self.cfg.session_id.as_str(),
            self.cfg.agent_id.as_str(),
            self.cfg.mode.as_str(),
        )
        .join("focus-slot.txt")
    }

    fn compact_memory_path(&self) -> PathBuf {
        Self::resolve_base_dir(
            &self.cfg.root_dir,
            self.cfg.session_id.as_str(),
            self.cfg.agent_id.as_str(),
            self.cfg.mode.as_str(),
        )
        .join("compact-memory.jsonl")
    }

    fn compact_memory_index_path(&self) -> PathBuf {
        Self::resolve_base_dir(
            &self.cfg.root_dir,
            self.cfg.session_id.as_str(),
            self.cfg.agent_id.as_str(),
            self.cfg.mode.as_str(),
        )
        .join("compact-memory-index.json")
    }

    fn rebuild_compact_memory_index(&self) -> Result<(), ContextLedgerError> {
        let compact_path = self.compact_memory_path();
        let index_path = self.compact_memory_index_path();
        let mut entries: Vec<Value> = Vec::new();

        if compact_path.exists() {
            let file = File::open(compact_path)?;
            let reader = BufReader::new(file);
            for line in reader.lines() {
                let raw = line?;
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let parsed = serde_json::from_str::<Value>(trimmed)?;
                let Some(obj) = parsed.as_object() else {
                    continue;
                };
                let id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let timestamp_ms = obj.get("timestamp_ms").and_then(Value::as_u64).unwrap_or(0);
                let timestamp_iso = obj
                    .get("timestamp_iso")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let payload = obj.get("payload").cloned().unwrap_or(Value::Null);
                let summary_text = payload
                    .get("summary")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| payload.to_string());
                let summary = sanitize_compact_summary_text(summary_text.as_str());
                if summary.trim().is_empty() {
                    continue;
                }
                entries.push(serde_json::json!({
                    "id": id,
                    "timestamp_ms": timestamp_ms,
                    "timestamp_iso": timestamp_iso,
                    "summary": summary,
                    "source_time_start": payload.get("source_time_start").and_then(Value::as_str),
                    "source_time_end": payload.get("source_time_end").and_then(Value::as_str),
                }));
            }
        }

        entries.sort_by_key(|item| {
            item.get("timestamp_ms")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        });
        let (rebuilt_at_ms, rebuilt_at_iso) = now_timestamp();
        let index_doc = serde_json::json!({
            "timeline_order": "ascending",
            "rebuilt_at_ms": rebuilt_at_ms,
            "rebuilt_at_iso": rebuilt_at_iso,
            "entry_count": entries.len(),
            "entries": entries,
        });
        fs::write(index_path, serde_json::to_string(&index_doc)?)?;
        Ok(())
    }

    fn resolve_ledger_path(root: &Path, session_id: &str, agent_id: &str, mode: &str) -> PathBuf {
        Self::resolve_base_dir(root, session_id, agent_id, mode).join("context-ledger.jsonl")
    }

    fn resolve_base_dir(root: &Path, session_id: &str, agent_id: &str, mode: &str) -> PathBuf {
        root.join(sanitize_component(session_id))
            .join(sanitize_component(agent_id))
            .join(sanitize_component(mode))
    }
}

fn read_entries(path: &Path) -> Result<Vec<LedgerEntry>, ContextLedgerError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let raw = line?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<LedgerEntry>(trimmed)?;
        entries.push(parsed);
    }
    Ok(entries)
}

fn filter_entries(entries: Vec<LedgerEntry>, request: &LedgerQueryRequest) -> Vec<LedgerEntry> {
    let since_ms = request.since_ms;
    let until_ms = request.until_ms;
    let contains = request
        .contains
        .as_ref()
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty());
    let event_types = request
        .event_types
        .iter()
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect::<HashSet<_>>();

    let mut filtered = entries
        .into_iter()
        .filter(|entry| {
            since_ms
                .map(|cutoff| entry.timestamp_ms >= cutoff)
                .unwrap_or(true)
                && until_ms
                    .map(|cutoff| entry.timestamp_ms <= cutoff)
                    .unwrap_or(true)
                && (event_types.is_empty()
                    || event_types.contains(entry.event_type.trim().to_lowercase().as_str()))
                && !contains_prompt_like_block(entry.payload.to_string().as_str())
                && contains
                    .as_ref()
                    .map(|needle| {
                        let payload_text = entry.payload.to_string().to_lowercase();
                        if payload_text.contains(needle)
                            || entry.event_type.to_lowercase().contains(needle)
                        {
                            return true;
                        }
                        if request.fuzzy {
                            return fuzzy_score(payload_text.as_str(), needle.as_str()) >= 0.18;
                        }
                        false
                    })
                    .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    filtered.sort_by_key(|entry| entry.timestamp_ms);
    filtered
}

fn build_timeline(entries: &[LedgerEntry]) -> Vec<LedgerTimelinePoint> {
    entries
        .iter()
        .map(|entry| LedgerTimelinePoint {
            id: entry.id.clone(),
            timestamp_ms: entry.timestamp_ms,
            timestamp_iso: entry.timestamp_iso.clone(),
            event_type: entry.event_type.clone(),
            agent_id: entry.agent_id.clone(),
            mode: entry.mode.clone(),
            preview: build_preview(entry.payload.to_string().as_str(), 160),
        })
        .collect()
}

fn build_preview(input: &str, max_chars: usize) -> String {
    let normalized = input.replace('\n', " ").trim().to_string();
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let mut out = String::new();
    for ch in normalized.chars().take(max_chars) {
        out.push(ch);
    }
    out.push_str("...");
    out
}

fn contains_prompt_like_block(text: &str) -> bool {
    let lowered = text.to_lowercase();
    lowered.contains("<developer_instructions>")
        || lowered.contains("<user_instructions>")
        || lowered.contains("<environment_context>")
        || lowered.contains("<turn_context>")
        || lowered.contains("<context_ledger_focus>")
        || lowered.contains("<system_message>")
}

fn sanitize_compact_summary_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !contains_prompt_like_block(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn fuzzy_score(text: &str, query: &str) -> f64 {
    let text_bigrams = to_bigrams(text);
    let query_bigrams = to_bigrams(query);
    if text_bigrams.is_empty() || query_bigrams.is_empty() {
        return 0.0;
    }
    let intersection = query_bigrams
        .iter()
        .filter(|item| text_bigrams.contains(*item))
        .count() as f64;
    intersection / query_bigrams.len() as f64
}

fn to_bigrams(input: &str) -> HashSet<String> {
    let normalized = input
        .chars()
        .filter(|ch| ch.is_alphanumeric() || ch.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    let chars = normalized.chars().collect::<Vec<_>>();
    let mut bigrams = HashSet::new();
    for window in chars.windows(2) {
        let token = window.iter().collect::<String>();
        if !token.trim().is_empty() {
            bigrams.insert(token);
        }
    }
    bigrams
}

fn keep_tail_chars(input: &str, max_chars: usize) -> String {
    let total = input.chars().count();
    if total <= max_chars {
        return input.to_string();
    }
    input.chars().skip(total - max_chars).collect()
}

fn sanitize_component(raw: &str) -> String {
    raw.trim()
        .replace('\\', "_")
        .replace('/', "_")
        .replace(':', "_")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn now_timestamp() -> (u64, String) {
    let ms = now_millis();
    let iso = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| format!("{ms}"));
    (ms, iso)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let ts = now_millis();
        std::env::temp_dir().join(format!("finger-ledger-{name}-{ts}"))
    }

    #[test]
    fn append_and_query_own_agent() {
        let root = temp_root("append-query");
        let ledger = ContextLedger::new(ContextLedgerConfig {
            root_dir: root.clone(),
            session_id: "s1".to_string(),
            agent_id: "a1".to_string(),
            mode: "main".to_string(),
            role: Some("coding".to_string()),
            can_read_all: false,
            readable_agents: vec![],
            focus_enabled: true,
            focus_max_chars: 20_000,
        })
        .expect("create ledger");

        ledger
            .append_event("turn_start", serde_json::json!({"text":"hello"}))
            .expect("append");
        ledger
            .append_event("tool_call", serde_json::json!({"name":"shell.exec"}))
            .expect("append");

        let result = ledger
            .query(&LedgerQueryRequest {
                limit: Some(10),
                ..LedgerQueryRequest::default()
            })
            .expect("query");
        assert_eq!(result.total, 2);
        assert_eq!(result.entries.len(), 2);
    }

    #[test]
    fn focus_insert_enforces_limit() {
        let root = temp_root("focus");
        let ledger = ContextLedger::new(ContextLedgerConfig {
            root_dir: root,
            session_id: "s2".to_string(),
            agent_id: "a2".to_string(),
            mode: "main".to_string(),
            role: None,
            can_read_all: false,
            readable_agents: vec![],
            focus_enabled: true,
            focus_max_chars: 10,
        })
        .expect("create ledger");

        let inserted = ledger
            .insert_focus("123456789012345", false)
            .expect("insert focus");
        assert!(inserted.truncated);
        assert_eq!(inserted.chars, 10);
        let focus = ledger.read_focus().expect("read").expect("focus");
        assert_eq!(focus.chars().count(), 10);
    }

    #[test]
    fn query_respects_permissions() {
        let root = temp_root("permissions");
        let agent_a = ContextLedger::new(ContextLedgerConfig {
            root_dir: root.clone(),
            session_id: "s3".to_string(),
            agent_id: "a3".to_string(),
            mode: "main".to_string(),
            role: None,
            can_read_all: false,
            readable_agents: vec![],
            focus_enabled: true,
            focus_max_chars: 20_000,
        })
        .expect("create ledger");
        agent_a
            .append_event("turn_start", serde_json::json!({"text":"secret"}))
            .expect("append");

        let agent_b = ContextLedger::new(ContextLedgerConfig {
            root_dir: root,
            session_id: "s3".to_string(),
            agent_id: "b3".to_string(),
            mode: "main".to_string(),
            role: None,
            can_read_all: false,
            readable_agents: vec![],
            focus_enabled: true,
            focus_max_chars: 20_000,
        })
        .expect("create ledger");

        let err = agent_b
            .query(&LedgerQueryRequest {
                agent_id: Some("a3".to_string()),
                ..LedgerQueryRequest::default()
            })
            .expect_err("should deny");
        assert!(matches!(err, ContextLedgerError::PermissionDenied { .. }));
    }

    #[test]
    fn append_compact_memory_writes_jsonl() {
        let root = temp_root("compact-memory");
        let ledger = ContextLedger::new(ContextLedgerConfig {
            root_dir: root.clone(),
            session_id: "s4".to_string(),
            agent_id: "a4".to_string(),
            mode: "main".to_string(),
            role: None,
            can_read_all: false,
            readable_agents: vec![],
            focus_enabled: true,
            focus_max_chars: 20_000,
        })
        .expect("create ledger");

        ledger
            .append_compact_memory(serde_json::json!({
                "summary": "compressed",
                "source_time_start": "2026-01-01T00:00:00Z",
                "source_time_end": "2026-01-01T00:01:00Z",
            }))
            .expect("append compact memory");
        ledger
            .append_compact_memory(serde_json::json!({
                "summary": "compressed second",
                "source_time_start": "2026-01-01T00:01:00Z",
                "source_time_end": "2026-01-01T00:02:00Z",
            }))
            .expect("append compact memory second");

        let path = root
            .join("s4")
            .join("a4")
            .join("main")
            .join("compact-memory.jsonl");
        let content = std::fs::read_to_string(path).expect("read compact file");
        assert!(content.contains("\"summary\":\"compressed\""));

        let index_path = root
            .join("s4")
            .join("a4")
            .join("main")
            .join("compact-memory-index.json");
        let index_content = std::fs::read_to_string(index_path).expect("read compact index file");
        let index_json: Value =
            serde_json::from_str(index_content.as_str()).expect("parse index json");
        assert_eq!(index_json["timeline_order"], "ascending");
        assert_eq!(index_json["entry_count"], 2);
        let entries = index_json["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 2);
        let first_ms = entries[0]["timestamp_ms"]
            .as_u64()
            .expect("first timestamp");
        let second_ms = entries[1]["timestamp_ms"]
            .as_u64()
            .expect("second timestamp");
        assert!(first_ms <= second_ms);
    }
}
