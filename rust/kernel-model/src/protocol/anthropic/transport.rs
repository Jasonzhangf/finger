//! Anthropic Messages API HTTP transport.
//!
//! Handles HTTP request/response for Anthropic Claude models.

use std::time::Duration;

use reqwest::{header, Client};
use serde_json::Value;

use crate::ModelError;

use header::{ACCEPT, CONTENT_TYPE};

/// Max retries for Anthropic API.
const MAX_RETRIES: usize = 2;

/// Auth header: `x-api-key` (not `Authorization: Bearer`)
const X_API_KEY_HEADER: &str = "x-api-key";

/// Anthropic API version header.
const ANTHROPIC_VERSION_HEADER: &str = "anthropic-version";
const ANTHROPIC_VERSION_VALUE: &str = "2023-06-01";

/// Anthropic response body (either SSE stream or JSON).
#[derive(Debug)]
pub enum AnthropicResponseBody {
    Sse(String),
    Json(Vec<u8>),
}

/// Send Anthropic Messages API request via HTTP.
pub async fn send_anthropic_http(
    client: &Client,
    base_url: &str,
    api_key: &str,
    payload: &Value,
    stream: bool,
) -> Result<AnthropicResponseBody, ModelError> {
    let accept_header = if stream { "text/event-stream" } else { "application/json" };
    let endpoint = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    eprintln!("=== Anthropic Request ===");
    eprintln!("endpoint: {}", endpoint);
    eprintln!("api_key length: {}", api_key.len());
    eprintln!("payload: {}", payload);

    let mut last_error: Option<String> = None;

    for attempt in 0..MAX_RETRIES {
        eprintln!("attempt {}", attempt);

        let response = client
            .post(&endpoint)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, accept_header)
            .header(X_API_KEY_HEADER, api_key)
            .header(ANTHROPIC_VERSION_HEADER, ANTHROPIC_VERSION_VALUE)
            .header("User-Agent", "curl/8.7.1")

            .json(payload)
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                eprintln!("response status: {}", status);
                
                let body = resp.bytes().await?;
                eprintln!("response body length: {}", body.len());

                if !status.is_success() {
                    let error_msg = String::from_utf8_lossy(&body).to_string();
                    eprintln!("error response: {}", error_msg);
                    last_error = Some(error_msg.clone());

                    // Retry on 5xx errors
                    if status.is_server_error() && attempt < MAX_RETRIES - 1 {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }

                    return Err(ModelError::HttpStatus {
                        status: status.as_u16(),
                        body: error_msg,
                    });
                }

                // Return response body
                if stream {
                    eprintln!("returning SSE response");
                    return Ok(AnthropicResponseBody::Sse(String::from_utf8_lossy(&body).to_string()));
                } else {
                    eprintln!("returning JSON response");
                    return Ok(AnthropicResponseBody::Json(body.to_vec()));
                }
            }
            Err(err) => {
                eprintln!("request error: {}", err);
                last_error = Some(err.to_string());

                if attempt < MAX_RETRIES - 1 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }

                return Err(ModelError::Request(err));
            }
        }
    }

    Err(ModelError::StreamFailed {
        message: last_error.unwrap_or_else(|| "Unknown error".to_string()),
    })
}
