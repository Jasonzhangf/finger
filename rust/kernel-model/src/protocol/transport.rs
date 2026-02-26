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
    let endpoint = format!("{}/v1/responses", base_url.trim_end_matches('/'));
    let accept_header = if expect_sse {
        "text/event-stream"
    } else {
        "application/json"
    };
    let response = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, accept_header)
        .header("OpenAI-Beta", "responses=experimental")
        .bearer_auth(api_key)
        .json(payload)
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

    if expect_sse {
        return Ok(WireResponseBody::Sse(
            String::from_utf8_lossy(&body).to_string(),
        ));
    }

    Ok(WireResponseBody::Json(body.to_vec()))
}
