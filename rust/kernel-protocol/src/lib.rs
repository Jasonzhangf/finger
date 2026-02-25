use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Submission {
    pub id: String,
    pub op: Op,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Op {
    UserTurn { items: Vec<InputItem> },
    Interrupt,
    Shutdown,
    ExecApproval { id: String, decision: ReviewDecision },
    PatchApproval { id: String, decision: ReviewDecision },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputItem {
    Text { text: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Event {
    pub id: String,
    pub msg: EventMsg,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TaskCompleteEvent {
    pub last_agent_message: Option<String>,
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
                items: vec![InputItem::Text {
                    text: "hello".to_string(),
                }],
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
