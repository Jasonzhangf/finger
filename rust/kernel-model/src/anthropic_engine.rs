//! Anthropic Messages API ChatEngine implementation.
static VEC_EMPTY: Vec<Value> = vec![];


use std::sync::Arc;

use async_trait::async_trait;
use finger_kernel_config::LocalModelConfig;
use finger_kernel_core::{ChatEngine, TurnRequest, TurnRunResult};
use finger_kernel_protocol::{EventMsg, InputItem, UserTurnOptions};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::anthropic::request::build_anthropic_request_payload;
use crate::protocol::anthropic::response::{
    parse_anthropic_event_type, parse_anthropic_sse_data, AnthropicEventType,
};
use crate::protocol::anthropic::transport::{send_anthropic_http, AnthropicResponseBody};
use crate::{FunctionCallItem, ModelError, ParsedResponse, ParsedUsage, TurnCompletion};

/// ChatEngine implementation for Anthropic Messages API.
pub struct AnthropicChatEngine {
    config: LocalModelConfig,
    client: Arc<reqwest::Client>,
}

impl AnthropicChatEngine {
    pub fn new(config: LocalModelConfig) -> Self {
        Self {
            config,
            client: Arc::new(reqwest::Client::new()),
        }
    }

    pub async fn complete_text(&self, user_text: &str) -> Result<String, ModelError> {
        let completion = self
            .complete_with_options(
                &[InputItem::Text {
                    text: user_text.to_string(),
                }],
                &UserTurnOptions::default(),
                None,
            )
            .await?;
        Ok(completion.output_text)
    }

    pub async fn complete_items(&self, items: &[InputItem]) -> Result<String, ModelError> {
        let completion = self
            .complete_with_options(items, &UserTurnOptions::default(), None)
            .await?;
        Ok(completion.output_text)
    }

    async fn complete_with_options(
        &self,
        items: &[InputItem],
        options: &UserTurnOptions,
        _progress_tx: Option<&UnboundedSender<EventMsg>>,
    ) -> Result<TurnCompletion, ModelError> {
        let anthropic_opts = options.anthropic.as_ref();
        let tools_slice = if options.tools.is_empty() {
            None
        } else {
            Some(options.tools.as_slice())
        };

        // Build request payload
        let payload = build_anthropic_request_payload(
            &self.config.model,
            items,
            options.system_prompt.as_deref(),
            tools_slice,
            anthropic_opts,
        );

        eprintln!("anthropic request payload: {}", payload);

        // Send request
        let response = send_anthropic_http(
            &self.client,
            &self.config.base_url,
            &self.config.api_key,
            &payload,
            true,
        )
        .await?;

        // Parse response
        let parsed = match response {
            AnthropicResponseBody::Sse(sse_text) => {
                self.parse_anthropic_sse(&sse_text)
            }
            AnthropicResponseBody::Json(json_bytes) => {
                let json_value: Value = serde_json::from_slice(&json_bytes)?;
                self.parse_anthropic_json(&json_value)
            }
        };

        Ok(TurnCompletion {
            output_text: parsed?.output_text.unwrap_or_default(),
            metadata_json: None,
        })
    }

    fn parse_anthropic_sse(&self, sse_text: &str) -> Result<ParsedResponse, ModelError> {
        let mut output_text = String::new();
        let mut function_calls = Vec::new();
        let mut usage = ParsedUsage::default();
        let mut finish_reason = None;
        let mut response_id: Option<String> = None;
        let mut tool_call_inputs: std::collections::HashMap<usize, String> =
            std::collections::HashMap::new();

        for line in sse_text.lines() {
            if !line.starts_with("data: ") {
                continue;
            }

            let data_str = line.strip_prefix("data:").unwrap_or("");
            if data_str.trim().is_empty() {
                continue;
            }

            let data = match parse_anthropic_sse_data(data_str) {
                Some(d) => d,
                None => continue,
            };

            let event_type = data
                .get("type")
                .and_then(|t| t.as_str())
                .map(parse_anthropic_event_type)
                .unwrap_or(AnthropicEventType::Ping);

            match event_type {
                AnthropicEventType::MessageStart => {
                    response_id = data
                        .get("message")
                        .and_then(|m| m.get("id"))
                        .and_then(|i| i.as_str())
                        .map(|s| s.to_string());

                    if let Some(msg_usage) = data.get("message").and_then(|m| m.get("usage")) {
                        usage.input_tokens = msg_usage.get("input_tokens").and_then(|t| t.as_u64());
                    }
                }
                AnthropicEventType::ContentBlockStart => {
                    let block_index = data
                        .get("index")
                        .and_then(|i| i.as_u64())
                        .unwrap_or(0) as usize;

                    let content_block = data.get("content_block").cloned().unwrap_or(json!({}));
                    let block_type = content_block
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("");

                    if block_type == "tool_use" {
                        let tool_id = content_block
                            .get("id")
                            .and_then(|i| i.as_str())
                            .unwrap_or("")
                            .to_string();
                        let tool_name = content_block
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string();
                        function_calls.push(FunctionCallItem {
                            call_id: tool_id,
                            name: tool_name,
                            arguments: String::new(),
                        });
                        // Mark position for later input assembly
                        tool_call_inputs.insert(block_index, String::new());
                    }
                }
                AnthropicEventType::ContentBlockDelta => {
                    let block_index = data
                        .get("index")
                        .and_then(|i| i.as_u64())
                        .unwrap_or(0) as usize;

                    let delta = data.get("delta").cloned().unwrap_or(json!({}));
                    let delta_type = delta
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("");

                    if delta_type == "text_delta" {
                        let text = delta.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        output_text.push_str(text);
                    } else if delta_type == "thinking_delta" {
                        let thinking = delta.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                        output_text.push_str(thinking);
                    } else if delta_type == "input_json_delta" {
                        let partial_json = delta
                            .get("partial_json")
                            .and_then(|j| j.as_str())
                            .unwrap_or("");
                        tool_call_inputs
                            .entry(block_index)
                            .and_modify(|e| e.push_str(partial_json))
                            .or_insert_with(|| partial_json.to_string());
                    }
                }
                AnthropicEventType::ContentBlockStop => {
                    // Finalize tool call arguments
                    let block_index = data
                        .get("index")
                        .and_then(|i| i.as_u64())
                        .unwrap_or(0) as usize;

                    if let Some(input_json) = tool_call_inputs.remove(&block_index) {
                        // Find the corresponding function call by index
                        if let Some(fc) = function_calls.iter_mut().nth(block_index) {
                            fc.arguments = input_json;
                        }
                    }
                }
                AnthropicEventType::MessageDelta => {
                    let stop_reason = data
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("");

                    finish_reason = Some(map_anthropic_stop_reason_to_finish(stop_reason));

                    if let Some(delta_usage) = data.get("usage") {
                        usage.output_tokens =
                            delta_usage.get("output_tokens").and_then(|t| t.as_u64());
                        usage.total_tokens = usage.input_tokens.and_then(|i| {
                            usage.output_tokens.map(|o| i + o)
                        });
                    }
                }
                AnthropicEventType::MessageStop => {
                    // End of message
                }
                AnthropicEventType::Ping => {
                    // Keep-alive ping, ignore
                }
                AnthropicEventType::Error => {
                    let error_msg = data
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown error");

                    return Err(ModelError::StreamFailed {
                        message: error_msg.to_string(),
                    });
                }
            }
        }

        Ok(ParsedResponse {
            output_text: Some(output_text),
            function_calls,
            history_items: vec![],
            reasoning: vec![],
            finish_reason,
            response_status: None,
            response_incomplete_reason: None,
            response_id,
            usage,
        })
    }

    fn parse_anthropic_json(&self, json_value: &Value) -> Result<ParsedResponse, ModelError> {
        let content_blocks: &Vec<Value> = json_value
            .get("content")
            .and_then(|c| c.as_array())
            .unwrap_or(&VEC_EMPTY);

        let output_text = content_blocks
            .iter()
            .filter_map(|block| {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match block_type {
                    "text" => block.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()),
                    "thinking" => block.get("thinking").and_then(|t| t.as_str()).map(|s| s.to_string()),
                    _ => None,
                }
            })
            .collect::<Vec<_>>()
            .join("\n");

        let function_calls = content_blocks
            .iter()
            .enumerate()
            .filter_map(|(idx, block)| {
                if block.get("type").and_then(|t| t.as_str())? == "tool_use" {
                    Some(FunctionCallItem {
                        call_id: block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                        name: block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        arguments: block
                            .get("input")
                            .and_then(|i| serde_json::to_string(i).ok())
                            .unwrap_or_default(),
                    })
                } else {
                    None
                }
            })
            .collect();

        let stop_reason = json_value
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .unwrap_or("");

        let usage = ParsedUsage {
            input_tokens: json_value
                .get("usage")
                .and_then(|u| u.get("input_tokens"))
                .and_then(|t| t.as_u64()),
            output_tokens: json_value
                .get("usage")
                .and_then(|u| u.get("output_tokens"))
                .and_then(|t| t.as_u64()),
            total_tokens: json_value
                .get("usage")
                .and_then(|u| u.get("input_tokens").and_then(|i| i.as_u64()))
                .and_then(|i| {
                    json_value.get("usage").and_then(|u| u.get("output_tokens").and_then(|o| o.as_u64())).map(|o| i + o)
                }),
        };

        Ok(ParsedResponse {
            output_text: Some(output_text),
            function_calls,
            history_items: vec![],
            reasoning: vec![],
            finish_reason: Some(map_anthropic_stop_reason_to_finish(stop_reason)),
            response_status: None,
            response_incomplete_reason: None,
            response_id: json_value.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()),
            usage,
        })
    }
}

fn map_anthropic_stop_reason_to_finish(stop_reason: &str) -> String {
    match stop_reason {
        "end_turn" => "stop",
        "tool_use" => "tool_use",
        "max_tokens" => "length",
        "stop_sequence" => "stop",
        _ => "stop",
    }
    .to_string()
}

#[async_trait]
impl ChatEngine for AnthropicChatEngine {
    async fn run_turn(
        &self,
        request: &TurnRequest,
        _progress_tx: Option<UnboundedSender<EventMsg>>,
    ) -> Result<TurnRunResult, String> {
        // Check for valid input
        let has_supported_input = request.items.iter().any(|item| match item {
            InputItem::Text { text } => !text.trim().is_empty(),
            InputItem::Image { image_url } => !image_url.trim().is_empty(),
            InputItem::LocalImage { path } => !path.trim().is_empty(),
        });

        if !has_supported_input {
            return Ok(TurnRunResult::default());
        }

        let completion = self
            .complete_with_options(&request.items, &request.options, None)
            .await
            .map_err(|err| err.to_string())?;

        Ok(TurnRunResult {
            last_agent_message: Some(completion.output_text),
            metadata_json: completion.metadata_json,
        })
    }
}
