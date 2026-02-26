use std::fs;
use std::path::Path;
use std::collections::HashSet;

use async_trait::async_trait;
use base64::Engine;
use finger_kernel_config::LocalModelConfig;
use finger_kernel_core::{ChatEngine, TurnRequest, TurnRunResult};
use finger_kernel_protocol::{CompactConfig, InputItem, ToolExecutionConfig, ToolSpec, TurnContext, UserTurnOptions};
use serde_json::{json, Value};
use thiserror::Error;

const MAX_TOOL_LOOP_ROUNDS: usize = 16;
const DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO: f64 = 0.85;

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("http request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("responses api returned non-success status: {status}; body: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("invalid responses payload: {0}")]
    ParsePayload(#[from] serde_json::Error),
    #[error("failed to read local image from {path}: {error}")]
    LocalImageRead { path: String, error: String },
    #[error("responses api returned empty output")]
    EmptyOutput,
    #[error("responses stream did not contain a completed response payload")]
    MissingStreamResponse,
    #[error("responses api tool loop exceeded {max_rounds} rounds")]
    ToolLoopExceeded { max_rounds: usize },
    #[error("tool execution failed for {tool_name}: {message}")]
    ToolExecution { tool_name: String, message: String },
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
        let completion = self
            .complete_with_options(
            &[InputItem::Text {
                text: user_text.to_string(),
            }],
            &UserTurnOptions::default(),
        )
        .await?;
        Ok(completion.output_text)
    }

    pub async fn complete_items(&self, items: &[InputItem]) -> Result<String, ModelError> {
        let completion = self
            .complete_with_options(items, &UserTurnOptions::default())
            .await?;
        Ok(completion.output_text)
    }

    async fn complete_with_options(
        &self,
        items: &[InputItem],
        options: &UserTurnOptions,
    ) -> Result<TurnCompletion, ModelError> {
        let tool_bindings = build_tool_bindings(&options.tools);
        let mut rolling_input = build_initial_input(items, options)?;
        if let Some(fork_user_message_index) = options.fork_user_message_index {
            rolling_input = apply_fork_truncate(rolling_input, fork_user_message_index);
        }

        let mut tool_trace: Vec<Value> = Vec::new();
        let mut reasoning_trace: Vec<String> = Vec::new();
        let mut final_text: Option<String> = None;

        for _round in 0..MAX_TOOL_LOOP_ROUNDS {
            let response = self
                .send_responses_request(&rolling_input, options, &tool_bindings)
                .await?;
            let parsed = parse_responses_payload(&response)?;
            if !parsed.reasoning.is_empty() {
                reasoning_trace.extend(parsed.reasoning.clone());
            }
            if !parsed.history_items.is_empty() {
                rolling_input.extend(parsed.history_items);
            }

            if parsed.function_calls.is_empty() {
                if let Some(text) = parsed.output_text.clone() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        final_text = Some(trimmed.to_string());
                        break;
                    }
                }
                return Err(ModelError::EmptyOutput);
            }

            let function_call_batch = self
                .execute_function_calls(
                    &parsed.function_calls,
                    options.tool_execution.as_ref(),
                    &tool_bindings,
                )
                .await;
            if !function_call_batch.traces.is_empty() {
                tool_trace.extend(function_call_batch.traces);
            }
            if !function_call_batch.output_items.is_empty() {
                rolling_input.extend(function_call_batch.output_items);
            }
        }

        let output_text = if let Some(text) = final_text {
            text
        } else {
            return Err(ModelError::ToolLoopExceeded {
                max_rounds: MAX_TOOL_LOOP_ROUNDS,
            });
        };

        let mut estimated_tokens_in_window = estimate_tokens_in_history(&rolling_input);
        let baseline_tokens = options
            .context_window
            .as_ref()
            .and_then(|cfg| cfg.baseline_tokens)
            .unwrap_or(0);
        estimated_tokens_in_window = estimated_tokens_in_window.saturating_sub(baseline_tokens);

        let threshold_ratio = options
            .context_window
            .as_ref()
            .and_then(|cfg| cfg.auto_compact_threshold_ratio)
            .unwrap_or(DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO);
        let max_input_tokens = options.context_window.as_ref().and_then(|cfg| cfg.max_input_tokens);
        let auto_compact_triggered = max_input_tokens
            .map(|max| (estimated_tokens_in_window as f64) > (max as f64) * threshold_ratio)
            .unwrap_or(false);
        let manual_compact = options.compact.as_ref().map(|cfg| cfg.manual).unwrap_or(false);
        let compact_required = manual_compact || auto_compact_triggered;

        let mut compact_applied = false;
        let mut compact_summary: Option<String> = None;
        if compact_required {
            let compact_result = compact_history(&rolling_input, options.compact.as_ref());
            rolling_input = compact_result.history;
            compact_summary = compact_result.summary;
            compact_applied = true;
            estimated_tokens_in_window = estimate_tokens_in_history(&rolling_input).saturating_sub(baseline_tokens);
        }

        let metadata_value = json!({
            "session_id": options.session_id,
            "mode": options.mode,
            "tool_trace": tool_trace,
            "reasoning_trace": reasoning_trace,
            "api_history": rolling_input,
            "context_budget": {
                "estimated_tokens_in_context_window": estimated_tokens_in_window,
                "baseline_tokens": baseline_tokens,
                "max_input_tokens": max_input_tokens,
                "threshold_ratio": threshold_ratio,
            },
            "compact": {
                "requested_manual": manual_compact,
                "requested_auto": auto_compact_triggered,
                "applied": compact_applied,
                "summary": compact_summary,
            },
        });

        let metadata_json = serde_json::to_string(&metadata_value).ok();

        Ok(TurnCompletion {
            output_text,
            metadata_json,
        })
    }

    async fn send_responses_request(
        &self,
        input: &[Value],
        options: &UserTurnOptions,
        tool_bindings: &[ToolBinding],
    ) -> Result<Value, ModelError> {
        let endpoint = format!("{}/v1/responses", self.config.base_url.trim_end_matches('/'));
        let mut payload = json!({
            "model": self.config.model,
            "stream": false,
            "input": input,
        });

        if let Some(instructions) = options.system_prompt.as_ref().map(|item| item.trim()) {
            if !instructions.is_empty() {
                payload["instructions"] = Value::String(instructions.to_string());
            }
        }

        if !tool_bindings.is_empty() {
            payload["stream"] = Value::Bool(true);
            payload["tools"] = Value::Array(tool_bindings.iter().map(build_responses_tool).collect());
            payload["tool_choice"] = Value::String("auto".to_string());
            payload["parallel_tool_calls"] = Value::Bool(false);
        }

        let response = self
            .client
            .post(endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .header("OpenAI-Beta", "responses=experimental")
            .bearer_auth(&self.config.api_key)
            .json(&payload)
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

        if !tool_bindings.is_empty() {
            let stream_text = String::from_utf8_lossy(&body).to_string();
            return parse_sse_response(&stream_text);
        }

        serde_json::from_slice::<Value>(&body).map_err(ModelError::from)
    }

    async fn execute_function_calls(
        &self,
        function_calls: &[FunctionCallItem],
        execution_config: Option<&ToolExecutionConfig>,
        tool_bindings: &[ToolBinding],
    ) -> ToolExecutionBatch {
        let runtime_config = execution_config.cloned().unwrap_or(ToolExecutionConfig {
            daemon_url: self.config.tool_daemon_url.clone(),
            agent_id: self.config.tool_agent_id.clone(),
        });

        let mut output_items = Vec::with_capacity(function_calls.len());
        let mut traces = Vec::with_capacity(function_calls.len());
        for call in function_calls {
            let runtime_tool_name = resolve_runtime_tool_name(&call.name, tool_bindings);
            let output_payload = match self
                .execute_single_tool_call(call, &runtime_config, runtime_tool_name.as_str())
                .await
            {
                Ok(result) => {
                    traces.push(json!({
                        "call_id": call.call_id,
                        "tool": runtime_tool_name,
                        "status": "ok",
                    }));
                    json!({
                        "ok": true,
                        "tool": runtime_tool_name,
                        "result": result,
                    })
                }
                Err(error) => {
                    traces.push(json!({
                        "call_id": call.call_id,
                        "tool": runtime_tool_name,
                        "status": "error",
                        "error": error.to_string(),
                    }));
                    json!({
                        "ok": false,
                        "tool": runtime_tool_name,
                        "error": error.to_string(),
                    })
                }
            };

            output_items.push(json!({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": output_payload.to_string(),
            }));
        }

        ToolExecutionBatch {
            output_items,
            traces,
        }
    }

    async fn execute_single_tool_call(
        &self,
        call: &FunctionCallItem,
        config: &ToolExecutionConfig,
        runtime_tool_name: &str,
    ) -> Result<Value, ModelError> {
        let endpoint = format!(
            "{}/api/v1/tools/execute",
            config.daemon_url.trim_end_matches('/')
        );
        let mut parsed_input = parse_function_arguments(&call.arguments);
        if runtime_tool_name == "shell.exec" {
            parsed_input = normalize_shell_exec_input(parsed_input);
        }
        let request_payload = json!({
            "agentId": config.agent_id,
            "toolName": runtime_tool_name,
            "input": parsed_input,
        });

        let response = self
            .client
            .post(endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&request_payload)
            .send()
            .await?;

        let status = response.status();
        let body = response.bytes().await?;
        let payload = serde_json::from_slice::<Value>(&body).map_err(ModelError::from)?;

        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| String::from_utf8_lossy(&body).to_string());
            return Err(ModelError::ToolExecution {
                tool_name: runtime_tool_name.to_string(),
                message,
            });
        }

        if let Some(error_message) = payload.get("error").and_then(Value::as_str) {
            return Err(ModelError::ToolExecution {
                tool_name: runtime_tool_name.to_string(),
                message: error_message.to_string(),
            });
        }

        Ok(payload.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[async_trait]
impl ChatEngine for ResponsesChatEngine {
    async fn run_turn(&self, request: &TurnRequest) -> Result<TurnRunResult, String> {
        let has_supported_input = request.items.iter().any(|item| match item {
            InputItem::Text { text } => !text.trim().is_empty(),
            InputItem::Image { image_url } => !image_url.trim().is_empty(),
            InputItem::LocalImage { path } => !path.trim().is_empty(),
        });

        if !has_supported_input {
            return Ok(TurnRunResult::default());
        }

        let completion = self
            .complete_with_options(&request.items, &request.options)
            .await
            .map_err(|err| err.to_string())?;

        Ok(TurnRunResult {
            last_agent_message: Some(completion.output_text),
            metadata_json: completion.metadata_json,
        })
    }
}

#[derive(Debug, Clone)]
struct ParsedResponse {
    output_text: Option<String>,
    function_calls: Vec<FunctionCallItem>,
    history_items: Vec<Value>,
    reasoning: Vec<String>,
}

#[derive(Debug, Clone)]
struct FunctionCallItem {
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Clone)]
struct ToolBinding {
    runtime_name: String,
    model_name: String,
    description: Option<String>,
    input_schema: Option<Value>,
}

#[derive(Debug, Clone)]
struct TurnCompletion {
    output_text: String,
    metadata_json: Option<String>,
}

#[derive(Debug, Clone)]
struct ToolExecutionBatch {
    output_items: Vec<Value>,
    traces: Vec<Value>,
}

fn parse_responses_payload(payload: &Value) -> Result<ParsedResponse, ModelError> {
    if !payload.is_object() {
        return Err(ModelError::ParsePayload(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "responses payload must be an object",
        ))));
    }

    let mut output_text = payload
        .get("output_text")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let mut function_calls = Vec::new();
    let mut history_items = Vec::new();
    let mut reasoning = Vec::new();

    if let Some(items) = payload.get("output").and_then(Value::as_array) {
        for item in items {
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if is_api_relevant_output_item(item_type) {
                history_items.push(item.clone());
            }
            match item_type {
                "function_call" => {
                    if let Some(call) = parse_function_call_item(item) {
                        function_calls.push(call);
                    }
                }
                "message" => {
                    if output_text.is_none() {
                        output_text = parse_output_text_from_message(item);
                    }
                }
                "reasoning" => {
                    if let Some(text) = parse_reasoning_text(item) {
                        reasoning.push(text);
                    }
                }
                _ => {}
            }
        }
    }

    Ok(ParsedResponse {
        output_text,
        function_calls,
        history_items,
        reasoning,
    })
}

fn is_api_relevant_output_item(item_type: &str) -> bool {
    matches!(item_type, "function_call" | "message" | "reasoning")
}

fn parse_reasoning_text(item: &Value) -> Option<String> {
    if let Some(summary_items) = item.get("summary").and_then(Value::as_array) {
        for summary in summary_items {
            if let Some(text) = summary.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    if let Some(text) = item.get("text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn parse_function_call_item(item: &Value) -> Option<FunctionCallItem> {
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .or_else(|| item.get("id").and_then(Value::as_str))?
        .trim()
        .to_string();
    if call_id.is_empty() {
        return None;
    }

    let name = item.get("name").and_then(Value::as_str)?.trim().to_string();
    if name.is_empty() {
        return None;
    }

    let arguments = match item.get("arguments") {
        Some(Value::String(arguments)) => arguments.clone(),
        Some(value) => value.to_string(),
        None => "{}".to_string(),
    };

    Some(FunctionCallItem {
        call_id,
        name,
        arguments,
    })
}

fn parse_output_text_from_message(item: &Value) -> Option<String> {
    let content_items = item.get("content").and_then(Value::as_array)?;
    for content_item in content_items {
        let content_type = content_item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if content_type != "output_text" {
            continue;
        }
        if let Some(text) = content_item.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn parse_sse_response(raw: &str) -> Result<Value, ModelError> {
    let normalized = raw.replace("\r\n", "\n");
    let mut completed_response: Option<Value> = None;

    for chunk in normalized.split("\n\n") {
        let mut data_lines: Vec<&str> = Vec::new();
        for line in chunk.lines() {
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
        if let Some(response) = event_value.get("response") {
            completed_response = Some(response.clone());
        }
    }

    completed_response.ok_or(ModelError::MissingStreamResponse)
}

fn parse_function_arguments(arguments: &str) -> Value {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return Value::Object(serde_json::Map::new());
    }

    serde_json::from_str::<Value>(trimmed).unwrap_or_else(|_| Value::String(trimmed.to_string()))
}

fn normalize_shell_exec_input(input: Value) -> Value {
    let mut map = match input {
        Value::Object(map) => map,
        other => return other,
    };

    if map.contains_key("command") {
        return Value::Object(map);
    }
    if let Some(cmd) = map.get("cmd").cloned() {
        map.insert("command".to_string(), cmd);
    }
    Value::Object(map)
}

fn build_responses_tool(tool: &ToolBinding) -> Value {
    let description = tool
        .description
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("Execute tool {}", tool.runtime_name));
    let parameters = tool
        .input_schema
        .clone()
        .unwrap_or_else(|| json!({ "type": "object", "additionalProperties": true }));

    json!({
        "type": "function",
        "name": tool.model_name,
        "description": description,
        "parameters": parameters,
    })
}


fn build_tool_bindings(tools: &[ToolSpec]) -> Vec<ToolBinding> {
    let mut used_names = HashSet::new();
    let mut bindings = Vec::with_capacity(tools.len());

    for tool in tools {
        let base_name = sanitize_model_tool_name(&tool.name);
        let mut model_name = base_name.clone();
        let mut suffix = 1_usize;
        while used_names.contains(&model_name) {
            suffix += 1;
            model_name = format!("{base_name}_{suffix}");
        }
        used_names.insert(model_name.clone());

        bindings.push(ToolBinding {
            runtime_name: tool.name.clone(),
            model_name,
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        });
    }

    bindings
}

fn sanitize_model_tool_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            normalized.push(ch);
        } else {
            normalized.push('_');
        }
    }
    if normalized.is_empty() {
        return "tool".to_string();
    }
    if normalized.chars().all(|ch| ch == '_') {
        return "tool".to_string();
    }
    normalized
}

fn resolve_runtime_tool_name(model_name: &str, bindings: &[ToolBinding]) -> String {
    for binding in bindings {
        if binding.model_name == model_name {
            return binding.runtime_name.clone();
        }
    }
    model_name.to_string()
}

fn build_initial_input(items: &[InputItem], options: &UserTurnOptions) -> Result<Vec<Value>, ModelError> {
    let mut input = normalize_history_items(&options.history_items);

    maybe_inject_context_block(
        &mut input,
        "user_instructions",
        options.user_instructions.as_deref(),
    );
    maybe_inject_context_block(
        &mut input,
        "environment_context",
        options.environment_context.as_deref(),
    );
    if let Some(turn_context_text) = render_turn_context_block(options.turn_context.as_ref()) {
        maybe_inject_context_block(&mut input, "turn_context", Some(turn_context_text.as_str()));
    }

    input.push(build_user_message_input(items)?);
    Ok(input)
}

fn normalize_history_items(history_items: &[Value]) -> Vec<Value> {
    history_items
        .iter()
        .filter(|item| item.is_object())
        .cloned()
        .collect()
}

fn maybe_inject_context_block(input: &mut Vec<Value>, block_name: &str, content: Option<&str>) {
    let Some(raw_content) = content else {
        return;
    };
    let trimmed = raw_content.trim();
    if trimmed.is_empty() {
        return;
    }
    let block = wrap_context_block(block_name, trimmed);
    if history_contains_block(input, block_name, &block) {
        return;
    }
    input.push(build_text_user_message(block));
}

fn history_contains_block(history: &[Value], block_name: &str, full_block_text: &str) -> bool {
    let open_tag = format!("<{block_name}>");
    history.iter().any(|item| {
        extract_text_from_history_item(item)
            .map(|text| text.contains(&open_tag) || text.contains(full_block_text))
            .unwrap_or(false)
    })
}

fn build_text_user_message(text: String) -> Value {
    json!({
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": text,
            }
        ],
    })
}

fn wrap_context_block(name: &str, content: &str) -> String {
    format!("<{name}>\n{content}\n</{name}>")
}

fn render_turn_context_block(turn_context: Option<&TurnContext>) -> Option<String> {
    let context = turn_context?;
    let mut fields: Vec<String> = Vec::new();

    if let Some(cwd) = context.cwd.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        fields.push(format!("cwd={cwd}"));
    }
    if let Some(approval) = context
        .approval
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        fields.push(format!("approval={approval}"));
    }
    if let Some(sandbox) = context
        .sandbox
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        fields.push(format!("sandbox={sandbox}"));
    }
    if let Some(model) = context.model.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        fields.push(format!("model={model}"));
    }

    if fields.is_empty() {
        return None;
    }
    Some(fields.join("\n"))
}

fn extract_text_from_history_item(item: &Value) -> Option<String> {
    let role_based = item.get("content")?.as_array()?;
    for part in role_based {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(input_text) = part.get("input_text").and_then(Value::as_str) {
            let trimmed = input_text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn apply_fork_truncate(history: Vec<Value>, user_message_index: usize) -> Vec<Value> {
    let mut current_user_index = 0_usize;
    let mut result = Vec::new();

    for item in history {
        let role = item.get("role").and_then(Value::as_str).unwrap_or_default();
        if role == "user" {
            if current_user_index > user_message_index {
                break;
            }
            current_user_index += 1;
        }
        result.push(item);
    }

    result
}

fn estimate_tokens_in_history(history: &[Value]) -> u64 {
    let mut chars = 0_usize;
    for item in history {
        chars += estimate_chars_in_json(item);
    }
    ((chars as f64) / 4.0).ceil() as u64
}

fn estimate_chars_in_json(value: &Value) -> usize {
    match value {
        Value::Null => 0,
        Value::Bool(_) => 1,
        Value::Number(_) => 8,
        Value::String(text) => text.len(),
        Value::Array(items) => items.iter().map(estimate_chars_in_json).sum(),
        Value::Object(map) => map
            .iter()
            .map(|(key, item)| key.len() + estimate_chars_in_json(item))
            .sum(),
    }
}

struct CompactResult {
    history: Vec<Value>,
    summary: Option<String>,
}

fn compact_history(history: &[Value], compact_cfg: Option<&CompactConfig>) -> CompactResult {
    let preserve_user_messages = compact_cfg
        .map(|cfg| cfg.preserve_user_messages)
        .unwrap_or(true);
    let summary_hint = compact_cfg
        .and_then(|cfg| cfg.summary_hint.as_ref())
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string());

    let mut initial_context_blocks: Vec<Value> = Vec::new();
    let mut user_messages: Vec<Value> = Vec::new();
    let mut narrative_lines: Vec<String> = Vec::new();

    for item in history {
        let role = item.get("role").and_then(Value::as_str).unwrap_or_default();
        let text = extract_text_from_history_item(item);

        if role == "user" && text.as_deref().map(is_initial_context_block).unwrap_or(false) {
            if !initial_context_blocks.iter().any(|existing| existing == item) {
                initial_context_blocks.push(item.clone());
            }
            continue;
        }

        if role == "user" {
            user_messages.push(item.clone());
        }

        if let Some(content) = text {
            let normalized = content.replace('\n', " ").trim().to_string();
            if !normalized.is_empty() {
                narrative_lines.push(format!("[{role}] {normalized}"));
            }
        }
    }

    let kept_user_messages = if preserve_user_messages {
        user_messages
    } else {
        user_messages.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect()
    };

    let summary_text = build_compact_summary(&narrative_lines, summary_hint.as_deref());
    let mut compacted_history = Vec::new();
    compacted_history.extend(initial_context_blocks);
    compacted_history.extend(kept_user_messages);
    compacted_history.push(json!({
        "role": "assistant",
        "content": [
            {
                "type": "output_text",
                "text": wrap_context_block("history_summary", summary_text.as_str()),
            }
        ],
    }));

    CompactResult {
        history: compacted_history,
        summary: Some(summary_text),
    }
}

fn is_initial_context_block(text: &str) -> bool {
    text.contains("<user_instructions>")
        || text.contains("<environment_context>")
        || text.contains("<turn_context>")
}

fn build_compact_summary(lines: &[String], summary_hint: Option<&str>) -> String {
    let mut pieces: Vec<String> = Vec::new();
    if let Some(hint) = summary_hint {
        pieces.push(format!("hint: {hint}"));
    }
    for line in lines.iter().rev().take(24).rev() {
        pieces.push(line.clone());
    }
    if pieces.is_empty() {
        return "No prior conversation details.".to_string();
    }
    pieces.join("\n")
}

fn build_user_message_input(items: &[InputItem]) -> Result<Value, ModelError> {
    let content = build_response_input_content(items)?;
    Ok(json!({
        "role": "user",
        "content": content,
    }))
}

fn build_response_input_content(items: &[InputItem]) -> Result<Vec<Value>, ModelError> {
    let mut content = Vec::new();
    for item in items {
        match item {
            InputItem::Text { text } => {
                if text.trim().is_empty() {
                    continue;
                }
                content.push(json!({
                    "type": "input_text",
                    "text": text,
                }));
            }
            InputItem::Image { image_url } => {
                if image_url.trim().is_empty() {
                    continue;
                }
                content.push(json!({
                    "type": "input_image",
                    "image_url": image_url,
                }));
            }
            InputItem::LocalImage { path } => {
                if path.trim().is_empty() {
                    continue;
                }
                content.push(json!({
                    "type": "input_image",
                    "image_url": to_data_url_from_local_image(path)?,
                }));
            }
        }
    }
    Ok(content)
}

fn to_data_url_from_local_image(path: &str) -> Result<String, ModelError> {
    let bytes = fs::read(path).map_err(|error| ModelError::LocalImageRead {
        path: path.to_string(),
        error: error.to_string(),
    })?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = infer_image_mime_type(path);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn infer_image_mime_type(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::{Matcher, Server};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parse_payload_reads_message_and_function_calls() {
        let payload = json!({
            "id": "resp_123",
            "output": [
                {
                    "type": "function_call",
                    "id": "call_1",
                    "name": "shell.exec",
                    "arguments": "{\"cmd\":\"pwd\"}"
                },
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "done" }
                    ]
                }
            ]
        });

        let parsed = parse_responses_payload(&payload).expect("parse payload");
        assert_eq!(parsed.output_text, Some("done".to_string()));
        assert_eq!(parsed.function_calls.len(), 1);
        assert_eq!(parsed.function_calls[0].name, "shell.exec");
    }

    #[test]
    fn build_response_input_content_maps_text_and_image() {
        let content = build_response_input_content(&[
            InputItem::Text {
                text: "hello".to_string(),
            },
            InputItem::Image {
                image_url: "https://example.com/demo.png".to_string(),
            },
        ])
        .expect("content");

        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[0]["text"], "hello");
        assert_eq!(content[1]["type"], "input_image");
    }

    #[test]
    fn build_response_input_content_maps_local_image_to_data_url() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("duration since epoch")
            .as_nanos();
        let temp_path = std::env::temp_dir().join(format!("finger-kernel-model-{unique}.png"));
        fs::write(&temp_path, [0x89_u8, 0x50, 0x4E, 0x47]).expect("write png header");

        let result = build_response_input_content(&[InputItem::LocalImage {
            path: temp_path.to_string_lossy().to_string(),
        }])
        .expect("content");

        let _ = fs::remove_file(&temp_path);

        assert_eq!(result.len(), 1);
        let image_url = result[0]["image_url"].as_str().expect("image_url");
        assert!(image_url.starts_with("data:image/png;base64,"));
    }

    #[tokio::test]
    async fn run_turn_executes_function_call_loop_and_returns_final_message() {
        let mut server = Server::new_async().await;

        let first_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .match_body(Matcher::Regex(r#""stream":true"#.to_string()))
            .match_body(Matcher::Regex(r#""tool_choice":"auto""#.to_string()))
            .match_body(Matcher::Regex(r#""parallel_tool_calls":false"#.to_string()))
            .match_body(Matcher::Regex(r#""name":"shell_exec""#.to_string()))
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"shell_exec\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}]}}\n\n",
                "data: [DONE]\n\n"
            ))
            .expect(1)
            .create_async()
            .await;

        let tool_execute_mock = server
            .mock("POST", "/api/v1/tools/execute")
            .match_body(Matcher::Regex(r#""toolName":"shell.exec""#.to_string()))
            .match_body(Matcher::Regex(r#""agentId":"chat-codex""#.to_string()))
            .match_body(Matcher::Regex(r#""command":"pwd""#.to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "result": {
                        "stdout": "/tmp"
                    }
                })
                .to_string(),
            )
            .expect(1)
            .create_async()
            .await;

        let second_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .match_body(Matcher::Regex(r#""stream":true"#.to_string()))
            .match_body(Matcher::Regex(r#""type":"function_call""#.to_string()))
            .match_body(Matcher::Regex(r#""name":"shell_exec""#.to_string()))
            .match_body(Matcher::Regex(r#""type":"function_call_output""#.to_string()))
            .match_body(Matcher::Regex(r#""call_id":"call_1""#.to_string()))
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"final answer\"}]}]}}\n\n",
                "data: [DONE]\n\n"
            ))
            .expect(1)
            .create_async()
            .await;

        let engine = ResponsesChatEngine::new(LocalModelConfig {
            provider_id: "test".to_string(),
            provider_name: "test".to_string(),
            base_url: server.url(),
            wire_api: "responses".to_string(),
            env_key: "TEST_KEY".to_string(),
            api_key: "test-key".to_string(),
            model: "gpt-test".to_string(),
            tool_daemon_url: server.url(),
            tool_agent_id: "chat-codex".to_string(),
        });

        let result = engine
            .run_turn(&TurnRequest {
                items: vec![InputItem::Text {
                    text: "run pwd".to_string(),
                }],
                options: UserTurnOptions {
                    system_prompt: Some("You are a test runner.".to_string()),
                    tools: vec![ToolSpec {
                        name: "shell.exec".to_string(),
                        description: Some("Execute shell command".to_string()),
                        input_schema: Some(json!({
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            },
                            "required": ["cmd"]
                        })),
                    }],
                    tool_execution: Some(ToolExecutionConfig {
                        daemon_url: server.url(),
                        agent_id: "chat-codex".to_string(),
                    }),
                    ..UserTurnOptions::default()
                },
            })
            .await
            .expect("run turn");

        assert_eq!(result.last_agent_message.as_deref(), Some("final answer"));

        first_response_mock.assert_async().await;
        tool_execute_mock.assert_async().await;
        second_response_mock.assert_async().await;
    }
}
