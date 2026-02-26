use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Submission {
    pub id: String,
    pub op: Op,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Op {
    UserTurn {
        items: Vec<InputItem>,
        #[serde(default, skip_serializing_if = "UserTurnOptions::is_empty")]
        options: UserTurnOptions,
    },
    Interrupt,
    Shutdown,
    ExecApproval { id: String, decision: ReviewDecision },
    PatchApproval { id: String, decision: ReviewDecision },
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct UserTurnOptions {
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    #[serde(default)]
    pub tool_execution: Option<ToolExecutionConfig>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub history_items: Vec<Value>,
    #[serde(default)]
    pub user_instructions: Option<String>,
    #[serde(default)]
    pub environment_context: Option<String>,
    #[serde(default)]
    pub turn_context: Option<TurnContext>,
    #[serde(default)]
    pub context_window: Option<ContextWindowConfig>,
    #[serde(default)]
    pub compact: Option<CompactConfig>,
    #[serde(default)]
    pub fork_user_message_index: Option<usize>,
}

impl UserTurnOptions {
    fn is_empty(options: &Self) -> bool {
        options.system_prompt.is_none()
            && options.tools.is_empty()
            && options.tool_execution.is_none()
            && options.session_id.is_none()
            && options.mode.is_none()
            && options.history_items.is_empty()
            && options.user_instructions.is_none()
            && options.environment_context.is_none()
            && options.turn_context.is_none()
            && options.context_window.is_none()
            && options.compact.is_none()
            && options.fork_user_message_index.is_none()
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct TurnContext {
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub approval: Option<String>,
    #[serde(default)]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct ContextWindowConfig {
    #[serde(default)]
    pub max_input_tokens: Option<u64>,
    #[serde(default)]
    pub baseline_tokens: Option<u64>,
    #[serde(default)]
    pub auto_compact_threshold_ratio: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct CompactConfig {
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub preserve_user_messages: bool,
    #[serde(default)]
    pub summary_hint: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ToolExecutionConfig {
    pub daemon_url: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputItem {
    Text { text: String },
    Image { image_url: String },
    LocalImage { path: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub msg: EventMsg,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventMsg {
    SessionConfigured(SessionConfiguredEvent),
    TaskStarted(TaskStartedEvent),
    TaskComplete(TaskCompleteEvent),
    TurnAborted(TurnAbortedEvent),
    ShutdownComplete,
    Error(ErrorEvent),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionConfiguredEvent {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TaskStartedEvent {
    pub model_context_window: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TaskCompleteEvent {
    pub last_agent_message: Option<String>,
    #[serde(default)]
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TurnAbortedEvent {
    pub reason: TurnAbortReason,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnAbortReason {
    UserInterrupt,
    TaskReplaced,
    Shutdown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ErrorEvent {
    pub message: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ApprovedForSession,
    #[default]
    Denied,
    Abort,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_roundtrip_uses_tagged_variant() {
        let submission = Submission {
            id: "sub-1".to_string(),
            op: Op::UserTurn {
                items: vec![
                    InputItem::Text {
                        text: "hello".to_string(),
                    },
                    InputItem::Image {
                        image_url: "https://example.com/a.png".to_string(),
                    },
                    InputItem::LocalImage {
                        path: "/tmp/a.png".to_string(),
                    },
                ],
                options: UserTurnOptions::default(),
            },
        };

        let json = serde_json::to_string(&submission).expect("serialize submission");
        assert!(json.contains("\"type\":\"user_turn\""));

        let decoded: Submission = serde_json::from_str(&json).expect("deserialize submission");
        assert_eq!(decoded, submission);
    }

    #[test]
    fn event_roundtrip_uses_tagged_variant() {
        let event = Event {
            id: "sub-1".to_string(),
            msg: EventMsg::TurnAborted(TurnAbortedEvent {
                reason: TurnAbortReason::UserInterrupt,
            }),
        };

        let json = serde_json::to_string(&event).expect("serialize event");
        assert!(json.contains("\"type\":\"turn_aborted\""));

        let decoded: Event = serde_json::from_str(&json).expect("deserialize event");
        assert_eq!(decoded, event);
    }
}
