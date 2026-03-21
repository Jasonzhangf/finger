use std::time::Duration;
use tokio::time::sleep;

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::Value;

use crate::protocol::response::WireResponseBody;
use crate::ModelError;

pub(crate) async fn send_responses_http(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    payload: &Value,
    expect_sse: bool,
) -> Result<WireResponseBody, ModelError> {
    const MAX_RETRIES: u32 = 10;
    const INITIAL_BACKOFF_MS: u64 = 500;

    let endpoint = format!("{}/v1/responses", base_url.trim_end_matches('/'));
    let accept_header = if expect_sse {
        "text/event-stream"
    } else {
        "application/json"
    };
    let mut last_error = None;
    for attempt in 0..MAX_RETRIES {
        let response = client
            .post(&endpoint)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, accept_header)
            .header("OpenAI-Beta", "responses=experimental")
            .bearer_auth(api_key)
            .json(payload)
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.bytes().await?;
                if !status.is_success() {
                    // Retry on server errors (5xx) with exponential backoff
                    if status.is_server_error() && attempt < MAX_RETRIES - 1 {
                        let backoff_ms = INITIAL_BACKOFF_MS * (1 << attempt.min(6)); // cap at 64x
                        sleep(Duration::from_millis(backoff_ms)).await;
                        last_error = Some(ModelError::HttpStatus {
                            status: status.as_u16(),
                            body: String::from_utf8_lossy(&body).to_string(),
                        });
                        continue;
                    }
                    return Err(ModelError::HttpStatus {
                        status: status.as_u16(),
                        body: String::from_utf8_lossy(&body).to_string(),
                    });
                }

                if expect_sse {
                    return Ok(WireResponseBody::Sse(
                        String::from_utf8_lossy(&body).to_string(),
                    ));
                }

                return Ok(WireResponseBody::Json(body.to_vec()));
            }
            Err(e) => {
                // Retry on connection errors with exponential backoff
                if attempt < MAX_RETRIES - 1 {
                    let backoff_ms = INITIAL_BACKOFF_MS * (1 << attempt.min(6));
                    sleep(Duration::from_millis(backoff_ms)).await;
                    last_error = Some(ModelError::Request(e));
                    continue;
                }
                return Err(ModelError::Request(e));
            }
        }
    }

    // Should never reach here, but return the last error if we do
    Err(last_error.unwrap_or_else(|| ModelError::HttpStatus {
        status: 0,
        body: "Max retries exceeded".to_string(),
    }))
}
