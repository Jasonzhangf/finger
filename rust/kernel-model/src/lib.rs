use async_trait::async_trait;
use finger_kernel_config::LocalModelConfig;
use finger_kernel_core::{ChatEngine, TurnRunResult};
use finger_kernel_protocol::InputItem;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("http request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("responses api returned non-success status: {status}; body: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("invalid responses payload: {0}")]
    ParsePayload(#[from] serde_json::Error),
    #[error("responses api returned empty output")]
    EmptyOutput,
}

#[derive(Clone)]
pub struct ResponsesChatEngine {
    config: LocalModelConfig,
    client: reqwest::Client,
}

impl ResponsesChatEngine {
    pub fn new(config: LocalModelConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    pub async fn complete_text(&self, user_text: &str) -> Result<String, ModelError> {
        let endpoint = format!("{}/v1/responses", self.config.base_url.trim_end_matches('/'));
        let request = ResponsesRequest {
            model: self.config.model.clone(),
            stream: true,
            input: vec![ResponsesInput {
                role: "user".to_string(),
                content: vec![ResponsesInputContent {
                    input_type: "input_text".to_string(),
                    text: user_text.to_string(),
                }],
            }],
        };

        let response = self
            .client
            .post(endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header("OpenAI-Beta", "responses=experimental")
            .bearer_auth(&self.config.api_key)
            .json(&request)
            .send()
            .await?;

        let status = response.status();
        let body = response.bytes().await?;
        if !status.is_success() {
            return Err(ModelError::HttpStatus {
                status: status.as_u16(),
                body: String::from_utf8_lossy(&body).to_string(),
            });
        }

        if let Ok(payload) = serde_json::from_slice::<ResponsesResponse>(&body) {
            if let Some(text) = extract_output_text(&payload) {
                return Ok(text);
            }
        }

        let sse_body = String::from_utf8_lossy(&body);
        extract_output_text_from_sse(&sse_body).ok_or(ModelError::EmptyOutput)
    }
}

#[async_trait]
impl ChatEngine for ResponsesChatEngine {
    async fn run_turn(&self, items: &[InputItem]) -> Result<TurnRunResult, String> {
        let user_text = items.iter().rev().find_map(|item| match item {
            InputItem::Text { text } => Some(text.as_str()),
        });

        let Some(user_text) = user_text else {
            return Ok(TurnRunResult::default());
        };

        let output = self
            .complete_text(user_text)
            .await
            .map_err(|err| err.to_string())?;
        Ok(TurnRunResult {
            last_agent_message: Some(output),
        })
    }
}

#[derive(Debug, Serialize)]
struct ResponsesRequest {
    model: String,
    stream: bool,
    input: Vec<ResponsesInput>,
}

#[derive(Debug, Serialize)]
struct ResponsesInput {
    role: String,
    content: Vec<ResponsesInputContent>,
}

#[derive(Debug, Serialize)]
struct ResponsesInputContent {
    #[serde(rename = "type")]
    input_type: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ResponsesResponse {
    #[serde(default)]
    output_text: Option<String>,
    #[serde(default)]
    output: Vec<ResponsesOutputItem>,
}

#[derive(Debug, Deserialize)]
struct ResponsesOutputItem {
    #[serde(default)]
    content: Vec<ResponsesContentItem>,
}

#[derive(Debug, Deserialize)]
struct ResponsesContentItem {
    #[serde(default)]
    text: Option<String>,
}

fn extract_output_text(payload: &ResponsesResponse) -> Option<String> {
    if let Some(text) = payload.output_text.as_ref() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    payload
        .output
        .iter()
        .flat_map(|item| item.content.iter())
        .filter_map(|content| content.text.as_ref())
        .map(|text| text.trim())
        .find(|text| !text.is_empty())
        .map(|text| text.to_string())
}

fn extract_output_text_from_sse(body: &str) -> Option<String> {
    let mut delta_buffer = String::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }

        let payload = trimmed.trim_start_matches("data:").trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }

        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            continue;
        };

        let event_type = event.get("type").and_then(Value::as_str);
        match event_type {
            Some("response.output_text.delta") => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    delta_buffer.push_str(delta);
                }
            }
            Some("response.output_text.done") => {
                if delta_buffer.trim().is_empty() {
                    if let Some(text) = event.get("text").and_then(Value::as_str) {
                        delta_buffer.push_str(text);
                    }
                }
            }
            Some("response.completed") => {
                if let Some(response_value) = event.get("response") {
                    if let Ok(response_payload) =
                        serde_json::from_value::<ResponsesResponse>(response_value.clone())
                    {
                        if let Some(text) = extract_output_text(&response_payload) {
                            if delta_buffer.trim().is_empty() {
                                return Some(text);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let text = delta_buffer.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_output_text_prefers_output_text() {
        let payload = ResponsesResponse {
            output_text: Some("hello".to_string()),
            output: vec![],
        };
        let text = extract_output_text(&payload).expect("output text");
        assert_eq!(text, "hello");
    }

    #[test]
    fn extract_output_text_falls_back_to_output_items() {
        let payload = ResponsesResponse {
            output_text: None,
            output: vec![ResponsesOutputItem {
                content: vec![ResponsesContentItem {
                    text: Some("fallback".to_string()),
                }],
            }],
        };
        let text = extract_output_text(&payload).expect("fallback text");
        assert_eq!(text, "fallback");
    }

    #[test]
    fn extract_output_text_from_sse_reads_delta_chunks() {
        let sse = r#"
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"E2E_"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"OK"}

event: response.completed
data: {"type":"response.completed","response":{"output_text":"E2E_OK","output":[]}}

data: [DONE]
"#;

        let text = extract_output_text_from_sse(sse).expect("sse text");
        assert_eq!(text, "E2E_OK");
    }
}
