//! Anthropic Messages API response parser.
//!
//! Parses Anthropic SSE events and converts to kernel Event format.

use serde_json::{json, Value};

/// Anthropic SSE event types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnthropicEventType {
    MessageStart,
    ContentBlockStart,
    ContentBlockDelta,
    ContentBlockStop,
    MessageDelta,
    MessageStop,
    Ping,
    Error,
}

/// Parse Anthropic SSE event type from event name.
pub fn parse_anthropic_event_type(event_name: &str) -> AnthropicEventType {
    match event_name.trim() {
        "message_start" => AnthropicEventType::MessageStart,
        "content_block_start" => AnthropicEventType::ContentBlockStart,
        "content_block_delta" => AnthropicEventType::ContentBlockDelta,
        "content_block_stop" => AnthropicEventType::ContentBlockStop,
        "message_delta" => AnthropicEventType::MessageDelta,
        "message_stop" => AnthropicEventType::MessageStop,
        "ping" => AnthropicEventType::Ping,
        "error" => AnthropicEventType::Error,
        _ => AnthropicEventType::Error,
    }
}

/// Parse Anthropic SSE data JSON and extract relevant fields.
pub fn parse_anthropic_sse_data(data: &str) -> Option<Value> {
    if data.trim() == "" {
        return None;
    }

    serde_json::from_str::<Value>(data).ok()
}

/// Convert Anthropic message_start event to kernel event.
///
/// Anthropic format:
/// ```json
/// {
///   "type": "message_start",
///   "message": {
///     "id": "msg_xxx",
///     "type": "message",
///     "role": "assistant",
///     "model": "claude-sonnet-4",
///     "usage": { "input_tokens": 10, "output_tokens": 0 }
///   }
/// }
/// ```
pub fn convert_message_start_to_kernel_event(data: &Value, event_id: &str) -> Value {
    let message = data.get("message").cloned().unwrap_or(json!({}));
    let usage = message.get("usage").cloned().unwrap_or(json!({}));

    json!({
        "id": event_id,
        "msg": {
            "type": "session_configured",
            "session_id": message.get("id").and_then(|i| i.as_str()).unwrap_or(""),
            "model": message.get("model").and_then(|m| m.as_str()).unwrap_or(""),
            "input_tokens": usage.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0),
        }
    })
}

/// Convert Anthropic content_block_start event to kernel event.
///
/// Anthropic format:
/// ```json
/// {
///   "type": "content_block_start",
///   "index": 0,
///   "content_block": {
///     "type": "text" | "tool_use",
///     "text": "...",  // for text blocks (empty at start)
///     "id": "toolu_xxx", "name": "tool_name", "input": {}  // for tool_use
///   }
/// }
/// ```
pub fn convert_content_block_start_to_kernel_event(
    data: &Value,
    event_id: &str,
    block_index: usize,
) -> Value {
    let content_block = data.get("content_block").cloned().unwrap_or(json!({}));
    let block_type = content_block.get("type").and_then(|t| t.as_str()).unwrap_or("text");

    match block_type {
        "tool_use" => json!({
            "id": event_id,
            "msg": {
                "type": "tool_call",
                "call_id": content_block.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                "name": content_block.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                "index": block_index,
                "status": "in_progress",
            }
        }),
        _ => json!({
            "id": event_id,
            "msg": {
                "type": "model_round",
                "text": "",
                "index": block_index,
                "status": "in_progress",
            }
        }),
    }
}

/// Convert Anthropic content_block_delta event to kernel event.
///
/// Anthropic format:
/// ```json
/// {
///   "type": "content_block_delta",
///   "index": 0,
///   "delta": {
///     "type": "text_delta" | "input_json_delta",
///     "text": "...",  // for text_delta
///     "partial_json": "..."  // for input_json_delta (tool input)
///   }
/// }
/// ```
pub fn convert_content_block_delta_to_kernel_event(
    data: &Value,
    event_id: &str,
    block_index: usize,
) -> Value {
    let delta = data.get("delta").cloned().unwrap_or(json!({}));
    let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("text_delta");

    match delta_type {
        "input_json_delta" => json!({
            "id": event_id,
            "msg": {
                "type": "tool_call",
                "index": block_index,
                "partial_input": delta.get("partial_json").and_then(|j| j.as_str()).unwrap_or(""),
                "status": "in_progress",
            }
        }),
        _ => json!({
            "id": event_id,
            "msg": {
                "type": "model_round",
                "text": delta.get("text").and_then(|t| t.as_str()).unwrap_or(""),
                "index": block_index,
                "status": "in_progress",
            }
        }),
    }
}

/// Convert Anthropic content_block_stop event to kernel event.
///
/// Anthropic format:
/// ```json
/// {
///   "type": "content_block_stop",
///   "index": 0
/// }
/// ```
pub fn convert_content_block_stop_to_kernel_event(
    data: &Value,
    event_id: &str,
    block_index: usize,
) -> Value {
    json!({
        "id": event_id,
        "msg": {
            "type": "model_round",
            "index": block_index,
            "status": "completed",
        }
    })
}

/// Convert Anthropic message_delta event to kernel event.
///
/// Anthropic format:
/// ```json
/// {
///   "type": "message_delta",
///   "delta": {
///     "stop_reason": "end_turn" | "tool_use" | "max_tokens",
///     "usage": { "output_tokens": 100 }
///   }
/// }
/// ```
pub fn convert_message_delta_to_kernel_event(data: &Value, event_id: &str) -> Value {
    let delta = data.get("delta").cloned().unwrap_or(json!({}));
    let usage = data.get("usage").cloned().unwrap_or(json!({}));
    let stop_reason = delta.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("");

    let finish_reason = map_anthropic_stop_reason(stop_reason);

    json!({
        "id": event_id,
        "msg": {
            "type": "model_round",
            "finish_reason": finish_reason,
            "output_tokens": usage.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0),
            "status": "completed",
        }
    })
}

/// Convert Anthropic message_stop event to kernel event.
pub fn convert_message_stop_to_kernel_event(event_id: &str) -> Value {
    json!({
        "id": event_id,
        "msg": {
            "type": "model_round",
            "status": "done",
        }
    })
}

/// Convert Anthropic error event to kernel event.
///
/// Anthropic format:
/// ```json
/// {
///   "type": "error",
///   "error": {
///     "type": "overloaded_error",
///     "message": "..."
///   }
/// }
/// ```
pub fn convert_error_to_kernel_event(data: &Value, event_id: &str) -> Value {
    let error = data.get("error").cloned().unwrap_or(json!({}));

    json!({
        "id": event_id,
        "msg": {
            "type": "model_round",
            "status": "error",
            "error_type": error.get("type").and_then(|t| t.as_str()).unwrap_or("unknown"),
            "error_message": error.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown error"),
        }
    })
}

/// Map Anthropic stop_reason to kernel finish_reason.
fn map_anthropic_stop_reason(stop_reason: &str) -> &str {
    match stop_reason {
        "end_turn" => "stop",
        "tool_use" => "tool_use",
        "max_tokens" => "length",
        "stop_sequence" => "stop",
        _ => "stop",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_event_types() {
        assert_eq!(parse_anthropic_event_type("message_start"), AnthropicEventType::MessageStart);
        assert_eq!(parse_anthropic_event_type("content_block_delta"), AnthropicEventType::ContentBlockDelta);
        assert_eq!(parse_anthropic_event_type("message_stop"), AnthropicEventType::MessageStop);
    }

    #[test]
    fn converts_message_start() {
        let data = json!({
            "type": "message_start",
            "message": {
                "id": "msg_123",
                "model": "claude-sonnet-4",
                "usage": { "input_tokens": 10 }
            }
        });

        let event = convert_message_start_to_kernel_event(&data, "evt-1");

        assert_eq!(event["msg"]["type"], "session_configured");
        assert_eq!(event["msg"]["model"], "claude-sonnet-4");
    }

    #[test]
    fn converts_content_block_delta_text() {
        let data = json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "text_delta",
                "text": "Hello"
            }
        });

        let event = convert_content_block_delta_to_kernel_event(&data, "evt-1", 0);

        assert_eq!(event["msg"]["type"], "model_round");
        assert_eq!(event["msg"]["text"], "Hello");
    }

    #[test]
    fn converts_message_delta_with_tool_use() {
        let data = json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": "tool_use"
            },
            "usage": { "output_tokens": 50 }
        });

        let event = convert_message_delta_to_kernel_event(&data, "evt-1");

        assert_eq!(event["msg"]["finish_reason"], "tool_use");
        assert_eq!(event["msg"]["output_tokens"], 50);
    }
}
