//! Task-Digest Ledger Types

use serde::{Deserialize, Serialize};

/// KeyTurn - 关键工具调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyTurn {
    /// 工具名称
    pub tool: String,
    /// 时间戳
    pub timestamp: String,
    /// 工具输出摘要
    pub summary: String,
    /// agent.dispatch 的目标 agent（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// approve/reject 的结果（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

/// Digest - 压缩摘要（发送给 LLM）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDigest {
    /// 用户原始请求
    pub goal: String,
    /// 最终结果摘要
    pub result: String,
    /// 关键工具调用
    pub key_turns: Vec<KeyTurn>,
    /// 变更文件列表
    pub changed_files: Vec<String>,
    /// 任务结果
    pub outcome: TaskOutcome,
    /// digest token 估算
    pub estimated_tokens: usize,
}

/// TaskOutcome - 任务结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskOutcome {
    Success,
    Failed,
    Rejected,
}

/// TwoLayerFormat - 两层格式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwoLayerFormat {
    /// 完整原文（保留但不发送给 LLM）
    pub original: OriginalLayer,
    /// 压缩摘要（发送给 LLM）
    pub digest: TaskDigest,
}

/// OriginalLayer - 原文层
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OriginalLayer {
    /// 完整 turns
    pub turns: Vec<serde_json::Value>,
    /// 总字节数
    pub total_bytes: usize,
}

/// TaskDigestEntry - Ledger entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDigestEntry {
    pub id: String,
    pub timestamp_start: String,
    pub timestamp_end: String,
    pub session_id: String,
    pub agent_id: String,
    pub mode: String,
    #[serde(rename = "event_type")]
    pub event_type: String,
    /// Tags：只从 finish turn（reasoning.stop）提取
    pub tags: Vec<String>,
    /// 两层格式
    #[serde(flatten)]
    pub layers: TwoLayerFormat,
}

impl TaskDigestEntry {
    pub fn new(
        session_id: String,
        agent_id: String,
        mode: String,
        timestamp_start: String,
        timestamp_end: String,
        tags: Vec<String>,
        layers: TwoLayerFormat,
    ) -> Self {
        Self {
            id: format!("task-{}-{}", timestamp_start.starts_with("led-").then(|| timestamp_start.clone()).unwrap_or_else(|| timestamp_start.clone()), rand::random::<u32>()),
            timestamp_start,
            timestamp_end,
            session_id,
            agent_id,
            mode,
            event_type: "task_digest".to_string(),
            tags,
            layers,
        }
    }
}

/// Key tools 白名单
pub const KEY_TOOLS: &[&str] = &[
    "reasoning.stop",
    "agent.dispatch",
    "project.claim_completion",
    "project.approve_task",
    "project.reject_task",
];
