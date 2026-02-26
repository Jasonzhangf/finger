use std::collections::HashSet;

use finger_kernel_protocol::ResponsesRequestOptions;
use serde_json::{json, Map, Value};

const DEFAULT_REASONING_EFFORT: &str = "medium";
const DEFAULT_REASONING_SUMMARY: &str = "detailed";
const DEFAULT_TEXT_VERBOSITY: &str = "medium";
const REASONING_ENCRYPTED_CONTENT_INCLUDE: &str = "reasoning.encrypted_content";

pub(crate) fn build_responses_request_payload(
    model: &str,
    input: &[Value],
    system_prompt: Option<&str>,
    tools: Option<&[Value]>,
    prompt_cache_key: Option<&str>,
    responses: Option<&ResponsesRequestOptions>,
    base_url: Option<&str>,
) -> Value {
    let mut include = sanitize_include_list(responses.map(|options| options.include.as_slice()));
    let reasoning_opts = responses.and_then(|options| options.reasoning.as_ref());
    let reasoning_enabled = reasoning_opts.and_then(|opts| opts.enabled).unwrap_or(true);
    let include_reasoning_encrypted = reasoning_opts
        .and_then(|opts| opts.include_encrypted_content)
        .unwrap_or(true);
    if reasoning_enabled && include_reasoning_encrypted {
        push_unique_include(
            &mut include,
            REASONING_ENCRYPTED_CONTENT_INCLUDE.to_string(),
        );
    }
    let store = responses
        .and_then(|options| options.store)
        .unwrap_or_else(|| {
            if reasoning_enabled && !include_reasoning_encrypted {
                true
            } else {
                is_azure_responses_endpoint(base_url)
            }
        });

    let mut payload = json!({
        "model": model,
        "stream": true,
        "input": input,
        "store": store,
        "include": include,
    });

    if let Some(instructions) = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["instructions"] = Value::String(instructions.to_string());
    }

    if let Some(tool_defs) = tools.filter(|defs| !defs.is_empty()) {
        let parallel_tool_calls = responses
            .and_then(|options| options.parallel_tool_calls)
            .unwrap_or(true);
        payload["tools"] = Value::Array(tool_defs.to_vec());
        payload["tool_choice"] = Value::String("auto".to_string());
        payload["parallel_tool_calls"] = Value::Bool(parallel_tool_calls);
    }

    if reasoning_enabled {
        let effort = reasoning_opts
            .and_then(|opts| normalized_option(opts.effort.as_ref()))
            .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string());
        let summary = reasoning_opts
            .and_then(|opts| normalized_option(opts.summary.as_ref()))
            .unwrap_or_else(|| DEFAULT_REASONING_SUMMARY.to_string());
        payload["reasoning"] = json!({
            "effort": effort,
            "summary": summary,
        });
    }

    let text_opts = responses.and_then(|options| options.text.as_ref());
    let text_enabled = text_opts.and_then(|opts| opts.enabled).unwrap_or(true);
    if text_enabled {
        let verbosity = text_opts
            .and_then(|opts| normalized_option(opts.verbosity.as_ref()))
            .unwrap_or_else(|| DEFAULT_TEXT_VERBOSITY.to_string());
        let mut text = Map::new();
        text.insert("verbosity".to_string(), Value::String(verbosity));
        if let Some(schema) = text_opts.and_then(|opts| opts.output_schema.clone()) {
            text.insert(
                "format".to_string(),
                json!({
                    "type": "json_schema",
                    "strict": true,
                    "schema": schema,
                    "name": "finger_output_schema",
                }),
            );
        }
        payload["text"] = Value::Object(text);
    }

    if let Some(cache_key) = prompt_cache_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["prompt_cache_key"] = Value::String(cache_key.to_string());
    }

    payload
}

fn sanitize_include_list(raw: Option<&[String]>) -> Vec<String> {
    let Some(items) = raw else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut include = Vec::new();
    for item in items {
        let normalized = item.trim();
        if normalized.is_empty() || !seen.insert(normalized.to_string()) {
            continue;
        }
        include.push(normalized.to_string());
    }
    include
}

fn push_unique_include(include: &mut Vec<String>, entry: String) {
    if include.iter().any(|item| item == &entry) {
        return;
    }
    include.push(entry);
}

fn normalized_option(raw: Option<&String>) -> Option<String> {
    raw.map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn is_azure_responses_endpoint(base_url: Option<&str>) -> bool {
    let Some(base_url) = base_url else {
        return false;
    };
    let normalized = base_url.trim().to_ascii_lowercase();
    normalized.contains(".openai.azure.com")
        || (normalized.contains("azure") && normalized.contains("/openai"))
}

#[cfg(test)]
mod tests {
    use finger_kernel_protocol::{
        ResponsesReasoningOptions, ResponsesRequestOptions, ResponsesTextOptions,
    };

    use super::build_responses_request_payload;
    use serde_json::json;

    #[test]
    fn payload_defaults_to_streaming_and_enables_reasoning_text_controls() {
        let payload = build_responses_request_payload(
            "gpt-test",
            &[json!({"role":"user","content":[{"type":"input_text","text":"hello"}]})],
            None,
            None,
            Some("session-1"),
            None,
            Some("https://api.openai.com/v1"),
        );

        assert_eq!(payload.get("stream").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(payload.get("store").and_then(|v| v.as_bool()), Some(false));
        assert!(payload.get("tools").is_none());
        assert_eq!(
            payload
                .get("reasoning")
                .and_then(|item| item.get("effort"))
                .and_then(|item| item.as_str()),
            Some("medium")
        );
        assert_eq!(
            payload
                .get("text")
                .and_then(|item| item.get("verbosity"))
                .and_then(|item| item.as_str()),
            Some("medium")
        );
        assert!(payload
            .get("include")
            .and_then(|item| item.as_array())
            .is_some_and(|items| items
                .iter()
                .any(|entry| entry == "reasoning.encrypted_content")));
        assert_eq!(
            payload.get("prompt_cache_key").and_then(|v| v.as_str()),
            Some("session-1")
        );
    }

    #[test]
    fn payload_respects_switches_and_custom_values() {
        let payload = build_responses_request_payload(
            "gpt-test",
            &[json!({"role":"user","content":[{"type":"input_text","text":"hello"}]})],
            Some("system"),
            Some(&[json!({"type":"function","name":"shell_exec"})]),
            Some("session-2"),
            Some(&ResponsesRequestOptions {
                reasoning: Some(ResponsesReasoningOptions {
                    enabled: Some(false),
                    effort: None,
                    summary: None,
                    include_encrypted_content: Some(false),
                }),
                text: Some(ResponsesTextOptions {
                    enabled: Some(true),
                    verbosity: Some("high".to_string()),
                    output_schema: Some(json!({"type":"object"})),
                }),
                include: vec!["response.output_text.logprobs".to_string()],
                store: Some(true),
                parallel_tool_calls: Some(false),
            }),
            Some("https://resource.openai.azure.com/openai"),
        );

        assert_eq!(payload.get("store").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            payload.get("parallel_tool_calls").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert!(payload.get("reasoning").is_none());
        assert_eq!(
            payload
                .get("text")
                .and_then(|item| item.get("verbosity"))
                .and_then(|item| item.as_str()),
            Some("high")
        );
        assert_eq!(
            payload
                .get("text")
                .and_then(|item| item.get("format"))
                .and_then(|item| item.get("name"))
                .and_then(|item| item.as_str()),
            Some("finger_output_schema")
        );
        assert_eq!(
            payload
                .get("include")
                .and_then(|item| item.as_array())
                .map(|items| items.len()),
            Some(1)
        );
    }

    #[test]
    fn payload_forces_store_when_reasoning_encrypted_content_is_disabled() {
        let payload = build_responses_request_payload(
            "gpt-test",
            &[json!({"role":"user","content":[{"type":"input_text","text":"hello"}]})],
            None,
            None,
            None,
            Some(&ResponsesRequestOptions {
                reasoning: Some(ResponsesReasoningOptions {
                    enabled: Some(true),
                    effort: Some("medium".to_string()),
                    summary: Some("detailed".to_string()),
                    include_encrypted_content: Some(false),
                }),
                ..ResponsesRequestOptions::default()
            }),
            Some("https://api.openai.com/v1"),
        );
        assert_eq!(payload.get("store").and_then(|v| v.as_bool()), Some(true));
    }
}
