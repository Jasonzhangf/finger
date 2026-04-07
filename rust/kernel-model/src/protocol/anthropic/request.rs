//! Anthropic Messages API request builder.
//!
//! Transforms Finger kernel request format to Anthropic Messages API format.

/// Stream mode for Anthropic API.
const STREAM_MODE: bool = true;

use finger_kernel_protocol::{AnthropicRequestOptions, InputItem, ToolSpec};
use serde_json::{json, Value};

/// Default max tokens for Anthropic API (required field).
const DEFAULT_MAX_TOKENS: u64 = 4096;

/// Build Anthropic Messages API request payload.
pub fn build_anthropic_request_payload(
    model: &str,
    items: &[InputItem],
    system_prompt: Option<&str>,
    tools: Option<&[ToolSpec]>,
    anthropic: Option<&AnthropicRequestOptions>,
) -> Value {
    let max_tokens = anthropic
        .and_then(|opts| opts.max_tokens)
        .unwrap_or(DEFAULT_MAX_TOKENS);

    let mut payload = json!({
        "stream": STREAM_MODE,

        "model": model,
        "max_tokens": max_tokens,
    });

    // System prompt (Anthropic uses "system" field, not "instructions")
    if let Some(system) = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["system"] = Value::String(system.to_string());
    }

    // Convert InputItem to Anthropic messages format (simple string format)
    // Use single user message with string content (not array)
    let user_content = items
        .iter()
        .filter_map(|item| match item {
            InputItem::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    payload["messages"] = json!([
        {"role": "user", "content": user_content}
    ]);

    // Tools
    if let Some(tool_defs) = tools.filter(|defs| !defs.is_empty()) {
        payload["tools"] = Value::Array(
            tool_defs
                .iter()
                .map(|tool| json!({
                    "name": tool.name,
                    "description": tool.description.clone().unwrap_or_default(),
                    "input_schema": tool.input_schema.clone().unwrap_or(json!({})),
                }))
                .collect(),
        );

        // Tool choice
        payload["tool_choice"] = json!({ "type": "auto" });
    }

    // Parallel tool calls (Anthropic uses inverted semantics)
    if let Some(disable_parallel) = anthropic.and_then(|opts| opts.disable_parallel_tool_use) {
        payload["disable_parallel_tool_use"] = Value::Bool(disable_parallel);
    }

    // Thinking options (extended thinking for Claude models)
    if let Some(thinking) = anthropic.and_then(|opts| opts.thinking.as_ref()) {
        if thinking.budget_tokens.is_some() {
            payload["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": thinking.budget_tokens.unwrap_or(10000),
            });
        }
    }

    payload
}

/// Build Anthropic messages format (array of content blocks).
pub fn build_anthropic_messages(items: &[InputItem]) -> Vec<Value> {
    items
        .iter()
        .filter_map(|item| match item {
            InputItem::Text { text } => Some(json!({
                "type": "text",
                "text": text,
            })),
            InputItem::Image { image_url } => Some(json!({
                "type": "image",
                "source": {
                    "type": "url",
                    "url": image_url,
                },
            })),
            _ => None,
        })
        .collect()
}

/// Convert history items to Anthropic messages format.
pub fn convert_history_to_anthropic_messages(history: &[Value]) -> Vec<Value> {
    history.iter().map(convert_history_item_to_anthropic).collect()
}

fn convert_history_item_to_anthropic(item: &Value) -> Value {
    let role = item.get("role").and_then(|r| r.as_str()).unwrap_or("user");
    let content = item.get("content").cloned().unwrap_or(json!(""));

    json!({
        "role": role,
        "content": content,
    })
}

fn convert_content_block_to_anthropic(block: &Value) -> Value {
    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("text");

    match block_type {
        "text" => {
            let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
            json!({"type": "text", "text": text})
        }
        "image" => {
            let url = block
                .get("image_url")
                .and_then(|u| u.as_str())
                .unwrap_or("");
            json!({
                "type": "image",
                "source": {"type": "url", "url": url},
            })
        }
        _ => block.clone(),
    }
}
