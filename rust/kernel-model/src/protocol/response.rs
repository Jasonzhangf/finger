use serde_json::{json, Value};

use crate::ModelError;

pub(crate) enum WireResponseBody {
    Json(Vec<u8>),
    Sse(String),
}

pub(crate) fn parse_wire_response(body: WireResponseBody) -> Result<Value, ModelError> {
    match body {
        WireResponseBody::Json(bytes) => {
            serde_json::from_slice::<Value>(&bytes).map_err(ModelError::from)
        }
        WireResponseBody::Sse(raw) => parse_sse_response(&raw),
    }
}

pub(crate) fn parse_sse_response(raw: &str) -> Result<Value, ModelError> {
    let normalized = raw.replace("\r\n", "\n");
    let mut completed_response: Option<Value> = None;
    let mut output_items: Vec<Value> = Vec::new();

    for chunk in normalized.split("\n\n") {
        let mut data_lines: Vec<&str> = Vec::new();
        let mut event_name: Option<String> = None;
        for line in chunk.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                let normalized_event = rest.trim();
                if !normalized_event.is_empty() {
                    event_name = Some(normalized_event.to_string());
                }
                continue;
            }
            if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start());
            }
        }
        if data_lines.is_empty() {
            continue;
        }

        let data = data_lines.join("\n");
        if data.trim() == "[DONE]" {
            continue;
        }

        let event_value = serde_json::from_str::<Value>(&data).map_err(ModelError::from)?;
        let event_type = event_value
            .get("type")
            .and_then(Value::as_str)
            .or(event_name.as_deref())
            .unwrap_or_default();

        match event_type {
            "response.output_item.done" => {
                if let Some(item) = event_value.get("item") {
                    output_items.push(item.clone());
                }
            }
            "response.failed" => {
                let message = extract_response_failed_message(&event_value);
                return Err(ModelError::StreamFailed { message });
            }
            "response.completed" => {
                if let Some(response) = event_value.get("response").cloned() {
                    completed_response = Some(response);
                }
            }
            _ => {}
        }
    }

    if let Some(mut response) = completed_response {
        if !output_items.is_empty() {
            match response {
                Value::Object(ref mut map) => {
                    map.insert("output".to_string(), Value::Array(output_items));
                }
                _ => {
                    response = json!({
                        "output": output_items,
                    });
                }
            }
        }
        return Ok(response);
    }

    Err(ModelError::MissingStreamResponse)
}

fn extract_response_failed_message(event_value: &Value) -> String {
    if let Some(message) = event_value
        .get("response")
        .and_then(Value::as_object)
        .and_then(|response| response.get("error"))
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return message.to_string();
    }

    if let Some(message) = event_value
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return message.to_string();
    }

    "responses stream returned response.failed".to_string()
}
