use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use finger_kernel_config::LocalModelConfig;
#[cfg(test)]
use finger_kernel_context_ledger::LedgerQueryRequest;
use finger_kernel_context_ledger::{ContextLedger, ContextLedgerConfig};
use finger_kernel_core::{ChatEngine, TurnRequest, TurnRunResult};
use finger_kernel_protocol::{
    CompactConfig, EventMsg, InputItem, ModelRoundEvent, ResponsesRequestOptions, ToolCallEvent,
    ToolErrorEvent, ToolExecutionConfig, ToolResultEvent, ToolSpec, TurnContext, UserTurnOptions,
};
use serde_json::{json, Value};
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::{sleep, Duration};

mod protocol;

use protocol::request::build_responses_request_payload;
use protocol::response::parse_wire_response;
use protocol::transport::send_responses_http;

const MAX_TOOL_LOOP_ROUNDS: usize = 64;
const DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO: f64 = 0.85;
const DEFAULT_FOCUS_MAX_CHARS: usize = 20_000;

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
    #[error("responses stream failed: {message}")]
    StreamFailed { message: String },
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
        progress_tx: Option<&UnboundedSender<EventMsg>>,
    ) -> Result<TurnCompletion, ModelError> {
        let tool_bindings = build_tool_bindings(&options.tools);
        let context_ledger = build_context_ledger(options);
        let mut rolling_input = build_initial_input(items, options)?;

        if let Some(ledger) = context_ledger.as_ref() {
            safe_append_ledger(
                ledger,
                "turn_start",
                json!({
                    "items_count": items.len(),
                    "history_items_count": options.history_items.len(),
                    "tool_count": options.tools.len(),
                    "mode": options.mode,
                }),
            );
            if let Ok(Some(focus_text)) = ledger.read_focus() {
                let recall_block = format!(
                    "OLD_MEMORY_RECALL_ZONE\nThis block contains recalled old memory extracted from prior history.\nIt is for recall/reference and may not represent the latest state.\n{}\nEND_OLD_MEMORY_RECALL_ZONE",
                    focus_text
                );
                maybe_inject_context_block(
                    &mut rolling_input,
                    "context_ledger_focus",
                    Some(recall_block.as_str()),
                    "user",
                );
                safe_append_ledger(
                    ledger,
                    "focus_injected",
                    json!({
                        "chars": focus_text.chars().count(),
                    }),
                );
            }
        }

        if let Some(fork_user_message_index) = options.fork_user_message_index {
            rolling_input = apply_fork_truncate(rolling_input, fork_user_message_index);
        }

        let mut tool_trace: Vec<Value> = Vec::new();
        let mut reasoning_trace: Vec<String> = Vec::new();
        let mut round_trace: Vec<Value> = Vec::new();
        let mut final_text: Option<String> = None;
        let mut progress_seq: u64 = 0;
        let baseline_tokens = options
            .context_window
            .as_ref()
            .and_then(|cfg| cfg.baseline_tokens)
            .unwrap_or(0);
        let threshold_ratio = options
            .context_window
            .as_ref()
            .and_then(|cfg| cfg.auto_compact_threshold_ratio)
            .unwrap_or(DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO);
        let max_input_tokens = options
            .context_window
            .as_ref()
            .and_then(|cfg| cfg.max_input_tokens);
        let threshold_percent = Some((threshold_ratio * 100.0).round() as u64);
        let include_reasoning_items = should_replay_reasoning_items(options.responses.as_ref());

        for round in 0..MAX_TOOL_LOOP_ROUNDS {
            let response = self
                .send_responses_request(&rolling_input, options, &tool_bindings)
                .await?;
            let parsed = parse_responses_payload(&response)?;
            let replay_history_items =
                filter_history_items_for_replay(&parsed.history_items, include_reasoning_items);
            if !replay_history_items.is_empty() {
                rolling_input.extend(replay_history_items);
            }
            let estimated_tokens_in_window =
                estimate_tokens_in_history(&rolling_input).saturating_sub(baseline_tokens);
            let estimated_tokens_compactable =
                estimate_tokens_excluding_ledger_focus(&rolling_input)
                    .saturating_sub(baseline_tokens);
            let context_usage_percent = max_input_tokens.and_then(|max| {
                if max == 0 {
                    None
                } else {
                    Some(((estimated_tokens_in_window.saturating_mul(100)) / max).min(100))
                }
            });
            let has_output_text = parsed
                .output_text
                .as_ref()
                .map(|text| !text.trim().is_empty())
                .unwrap_or(false);
            let round_finish_reason = parsed.finish_reason.clone().or_else(|| {
                if !parsed.function_calls.is_empty() {
                    Some("tool_calls".to_string())
                } else if has_output_text {
                    Some("stop".to_string())
                } else {
                    None
                }
            });
            if let Some(ledger) = context_ledger.as_ref() {
                safe_append_ledger(
                    ledger,
                    "model_round",
                    json!({
                        "round": round + 1,
                        "tool_count": tool_bindings.len(),
                        "reasoning_count": parsed.reasoning.len(),
                        "history_items_count": parsed.history_items.len(),
                        "function_calls_count": parsed.function_calls.len(),
                        "has_output_text": has_output_text,
                        "finish_reason": round_finish_reason.clone(),
                        "response_status": parsed.response_status.clone(),
                        "response_incomplete_reason": parsed.response_incomplete_reason.clone(),
                        "input_tokens": parsed.usage.input_tokens,
                        "output_tokens": parsed.usage.output_tokens,
                        "total_tokens": parsed.usage.total_tokens,
                        "estimated_tokens_in_context_window": estimated_tokens_in_window,
                        "estimated_tokens_compactable": estimated_tokens_compactable,
                        "context_usage_percent": context_usage_percent,
                        "max_input_tokens": max_input_tokens,
                        "threshold_percent": threshold_percent,
                    }),
                );
            }
            if !parsed.reasoning.is_empty() {
                reasoning_trace.extend(parsed.reasoning.clone());
            }
            let model_round_seq = next_progress_seq(&mut progress_seq);
            round_trace.push(json!({
                "seq": model_round_seq,
                "round": round + 1,
                "function_calls_count": parsed.function_calls.len(),
                "reasoning_count": parsed.reasoning.len(),
                "history_items_count": rolling_input.len(),
                "has_output_text": has_output_text,
                "finish_reason": round_finish_reason.clone(),
                "response_status": parsed.response_status.clone(),
                "response_incomplete_reason": parsed.response_incomplete_reason.clone(),
                "response_id": parsed.response_id.clone(),
                "input_tokens": parsed.usage.input_tokens,
                "output_tokens": parsed.usage.output_tokens,
                "total_tokens": parsed.usage.total_tokens,
                "estimated_tokens_in_context_window": estimated_tokens_in_window,
                "estimated_tokens_compactable": estimated_tokens_compactable,
                "context_usage_percent": context_usage_percent,
                "max_input_tokens": max_input_tokens,
                "threshold_percent": threshold_percent,
            }));
            emit_progress_event(
                progress_tx,
                EventMsg::ModelRound(ModelRoundEvent {
                    seq: model_round_seq,
                    round: (round + 1) as u64,
                    function_calls_count: parsed.function_calls.len() as u64,
                    reasoning_count: parsed.reasoning.len() as u64,
                    history_items_count: rolling_input.len() as u64,
                    has_output_text,
                    finish_reason: round_finish_reason,
                    response_status: parsed.response_status.clone(),
                    response_incomplete_reason: parsed.response_incomplete_reason.clone(),
                    response_id: parsed.response_id.clone(),
                    input_tokens: parsed.usage.input_tokens,
                    output_tokens: parsed.usage.output_tokens,
                    total_tokens: parsed.usage.total_tokens,
                    estimated_tokens_in_context_window: Some(estimated_tokens_in_window),
                    estimated_tokens_compactable: Some(estimated_tokens_compactable),
                    context_usage_percent,
                    max_input_tokens,
                    threshold_percent,
                }),
            );

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
                    context_ledger.as_ref(),
                    progress_tx,
                    &mut progress_seq,
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
        let mut estimated_tokens_compactable =
            estimate_tokens_excluding_ledger_focus(&rolling_input);
        estimated_tokens_in_window = estimated_tokens_in_window.saturating_sub(baseline_tokens);
        estimated_tokens_compactable = estimated_tokens_compactable.saturating_sub(baseline_tokens);
        let auto_compact_triggered = max_input_tokens
            .map(|max| (estimated_tokens_in_window as f64) > (max as f64) * threshold_ratio)
            .unwrap_or(false);
        let manual_compact = options
            .compact
            .as_ref()
            .map(|cfg| cfg.manual)
            .unwrap_or(false);
        let compact_required = manual_compact || auto_compact_triggered;

        let mut compact_applied = false;
        let mut compact_summary: Option<String> = None;
        let mut compacted_at_ms: Option<u64> = None;
        let mut compacted_at_iso: Option<String> = None;
        let mut compacted_source_start: Option<String> = None;
        let mut compacted_source_end: Option<String> = None;
        if compact_required {
            let compact_result = compact_history(&rolling_input, options.compact.as_ref());
            rolling_input = compact_result.history;
            compact_summary = compact_result.summary;
            compacted_at_ms = Some(compact_result.compressed_at_ms);
            compacted_at_iso = Some(compact_result.compressed_at_iso);
            compacted_source_start = compact_result.source_time_start;
            compacted_source_end = compact_result.source_time_end;
            let compact_summary_for_cache =
                sanitize_compact_cache_summary(compact_summary.as_deref());
            compact_applied = true;
            estimated_tokens_in_window =
                estimate_tokens_in_history(&rolling_input).saturating_sub(baseline_tokens);
            estimated_tokens_compactable = estimate_tokens_excluding_ledger_focus(&rolling_input)
                .saturating_sub(baseline_tokens);
            if let Some(ledger) = context_ledger.as_ref() {
                safe_append_ledger(
                    ledger,
                    "context_compact",
                    json!({
                        "manual": manual_compact,
                        "auto": auto_compact_triggered,
                        "summary": compact_summary,
                        "compressed_at_ms": compacted_at_ms,
                        "compressed_at_iso": compacted_at_iso,
                        "source_time_start": compacted_source_start,
                        "source_time_end": compacted_source_end,
                        "estimated_tokens_in_context_window": estimated_tokens_in_window,
                        "estimated_tokens_compactable": estimated_tokens_compactable,
                    }),
                );
                let _ = ledger.append_compact_memory(json!({
                    "manual": manual_compact,
                    "auto": auto_compact_triggered,
                    "summary": compact_summary_for_cache,
                    "compressed_at_ms": compacted_at_ms,
                    "compressed_at_iso": compacted_at_iso,
                    "source_time_start": compacted_source_start,
                    "source_time_end": compacted_source_end,
                    "timeline_order": "ascending",
                    "note": "Compacted context is a time-ordered copy. Original ledger remains immutable append-only.",
                }));
            }
        }

        let metadata_value = json!({
            "session_id": options.session_id,
            "mode": options.mode,
            "tool_trace": tool_trace,
            "round_trace": round_trace,
            "reasoning_trace": reasoning_trace,
            "api_history": rolling_input,
            "context_budget": {
                "estimated_tokens_in_context_window": estimated_tokens_in_window,
                "estimated_tokens_compactable": estimated_tokens_compactable,
                "ledger_reserved_tokens": estimated_tokens_in_window.saturating_sub(estimated_tokens_compactable),
                "baseline_tokens": baseline_tokens,
                "max_input_tokens": max_input_tokens,
                "threshold_ratio": threshold_ratio,
            },
            "compact": {
                "requested_manual": manual_compact,
                "requested_auto": auto_compact_triggered,
                "applied": compact_applied,
                "summary": compact_summary,
                "compressed_at_ms": compacted_at_ms,
                "compressed_at_iso": compacted_at_iso,
                "source_time_start": compacted_source_start,
                "source_time_end": compacted_source_end,
                "timeline_order": "ascending",
                "note": "Compacted context is a time-ordered copy. Original ledger remains immutable append-only.",
            },
        });

        if let Some(ledger) = context_ledger.as_ref() {
            safe_append_ledger(
                ledger,
                "turn_complete",
                json!({
                    "reply_chars": output_text.chars().count(),
                    "tool_trace_count": tool_trace.len(),
                    "reasoning_count": reasoning_trace.len(),
                    "compact_applied": compact_applied,
                }),
            );
        }

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
        let tool_payload = if tool_bindings.is_empty() {
            None
        } else {
            Some(
                tool_bindings
                    .iter()
                    .map(build_responses_tool)
                    .collect::<Vec<_>>(),
            )
        };
        let mut store_retry_override: Option<ResponsesRequestOptions> = None;
        let mut has_retried_store = false;
        let mut sanitized_input_override: Option<Vec<Value>> = None;
        let mut has_retried_without_reasoning = false;
        let mut authentication_retry_count: u8 = 0;

        loop {
            let request_input = sanitized_input_override.as_deref().unwrap_or(input);
            let responses_opts = store_retry_override.as_ref().or(options.responses.as_ref());
            let payload = build_responses_request_payload(
                &self.config.model,
                request_input,
                options.system_prompt.as_deref(),
                tool_payload.as_deref(),
                options.session_id.as_deref(),
                responses_opts,
                Some(self.config.base_url.as_str()),
            );
            let expect_sse = payload
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let wire_body = match send_responses_http(
                &self.client,
                &self.config.base_url,
                &self.config.api_key,
                &payload,
                expect_sse,
            )
            .await
            {
                Ok(body) => body,
                Err(ModelError::HttpStatus { status, body })
                    if !has_retried_store
                        && should_retry_with_store(status, body.as_str())
                        && !responses_opts.and_then(|opts| opts.store).unwrap_or(false) =>
                {
                    has_retried_store = true;
                    store_retry_override = Some(responses_with_store_enabled(responses_opts));
                    continue;
                }
                Err(ModelError::HttpStatus { status, body })
                    if !has_retried_without_reasoning
                        && should_retry_without_reasoning_items(status, body.as_str()) =>
                {
                    let sanitized = strip_reasoning_history_items(request_input);
                    if sanitized.len() != request_input.len() {
                        has_retried_without_reasoning = true;
                        sanitized_input_override = Some(sanitized);
                        continue;
                    }
                    return Err(ModelError::HttpStatus { status, body });
                }
                Err(ModelError::HttpStatus { status, body })
                    if should_retry_authentication_failure(status, body.as_str())
                        && authentication_retry_count < 2 =>
                {
                    authentication_retry_count = authentication_retry_count.saturating_add(1);
                    let backoff_ms = 200_u64.saturating_mul(authentication_retry_count as u64);
                    sleep(Duration::from_millis(backoff_ms)).await;
                    continue;
                }
                Err(error) => return Err(error),
            };

            return parse_wire_response(wire_body);
        }
    }

    async fn execute_function_calls(
        &self,
        function_calls: &[FunctionCallItem],
        execution_config: Option<&ToolExecutionConfig>,
        tool_bindings: &[ToolBinding],
        context_ledger: Option<&ContextLedger>,
        progress_tx: Option<&UnboundedSender<EventMsg>>,
        progress_seq: &mut u64,
    ) -> ToolExecutionBatch {
        let runtime_config = execution_config.cloned().unwrap_or(ToolExecutionConfig {
            daemon_url: self.config.tool_daemon_url.clone(),
            agent_id: self.config.tool_agent_id.clone(),
        });

        let mut output_items = Vec::with_capacity(function_calls.len());
        let mut traces = Vec::with_capacity(function_calls.len());
        for call in function_calls {
            let runtime_tool_name = resolve_runtime_tool_name(&call.name, tool_bindings);
            let tool_input_snapshot = parse_function_arguments(&call.arguments);
            let tool_call_seq = next_progress_seq(progress_seq);
            emit_progress_event(
                progress_tx,
                EventMsg::ToolCall(ToolCallEvent {
                    seq: tool_call_seq,
                    call_id: call.call_id.clone(),
                    tool_name: runtime_tool_name.clone(),
                    input: tool_input_snapshot.clone(),
                }),
            );
            if let Some(ledger) = context_ledger {
                safe_append_ledger(
                    ledger,
                    "tool_call",
                    json!({
                        "call_id": call.call_id,
                        "tool_name": runtime_tool_name,
                    }),
                );
            }
            let started_at = Instant::now();
            let output_payload = match self
                .execute_single_tool_call(
                    call,
                    &runtime_config,
                    runtime_tool_name.as_str(),
                    context_ledger,
                )
                .await
            {
                Ok(result) => {
                    let duration_ms = started_at.elapsed().as_millis() as u64;
                    let tool_result_seq = next_progress_seq(progress_seq);
                    emit_progress_event(
                        progress_tx,
                        EventMsg::ToolResult(ToolResultEvent {
                            seq: tool_result_seq,
                            call_id: call.call_id.clone(),
                            tool_name: runtime_tool_name.clone(),
                            output: result.clone(),
                            duration_ms,
                        }),
                    );
                    traces.push(json!({
                        "call_id": call.call_id,
                        "tool": runtime_tool_name,
                        "status": "ok",
                        "seq": tool_result_seq,
                        "input": tool_input_snapshot.clone(),
                        "output": result.clone(),
                        "duration_ms": duration_ms,
                    }));
                    json!({
                        "ok": true,
                        "tool": runtime_tool_name,
                        "result": result,
                    })
                }
                Err(error) => {
                    let duration_ms = started_at.elapsed().as_millis() as u64;
                    let tool_error_seq = next_progress_seq(progress_seq);
                    emit_progress_event(
                        progress_tx,
                        EventMsg::ToolError(ToolErrorEvent {
                            seq: tool_error_seq,
                            call_id: call.call_id.clone(),
                            tool_name: runtime_tool_name.clone(),
                            error: error.to_string(),
                            duration_ms,
                        }),
                    );
                    traces.push(json!({
                        "call_id": call.call_id,
                        "tool": runtime_tool_name,
                        "status": "error",
                        "seq": tool_error_seq,
                        "input": tool_input_snapshot.clone(),
                        "error": error.to_string(),
                        "duration_ms": duration_ms,
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
        context_ledger: Option<&ContextLedger>,
    ) -> Result<Value, ModelError> {
        let endpoint = format!(
            "{}/api/v1/tools/execute",
            config.daemon_url.trim_end_matches('/')
        );
        let mut parsed_input = parse_function_arguments(&call.arguments);
        if runtime_tool_name == "context_ledger.memory" {
            parsed_input = inject_context_ledger_runtime_context(parsed_input, context_ledger);
        }
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

        if let Some(ledger) = context_ledger {
            safe_append_ledger(
                ledger,
                "tool_result",
                json!({
                    "tool_name": runtime_tool_name,
                    "ok": true,
                }),
            );
        }

        Ok(payload.get("result").cloned().unwrap_or(Value::Null))
    }
}

fn inject_context_ledger_runtime_context(
    input: Value,
    context_ledger: Option<&ContextLedger>,
) -> Value {
    let Some(ledger) = context_ledger else {
        return input;
    };

    let mut object = match input {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        other => {
            let mut map = serde_json::Map::new();
            map.insert("value".to_string(), other);
            map
        }
    };

    let runtime_context = json!({
        "root_dir": ledger.root_dir().to_string_lossy().to_string(),
        "session_id": ledger.session_id(),
        "agent_id": ledger.agent_id(),
        "mode": ledger.mode(),
        "can_read_all": ledger.can_read_all(),
        "readable_agents": ledger.readable_agents(),
        "focus_max_chars": ledger.focus_max_chars(),
    });

    object.insert("_runtime_context".to_string(), runtime_context);
    Value::Object(object)
}

#[async_trait]
impl ChatEngine for ResponsesChatEngine {
    async fn run_turn(
        &self,
        request: &TurnRequest,
        progress_tx: Option<UnboundedSender<EventMsg>>,
    ) -> Result<TurnRunResult, String> {
        let has_supported_input = request.items.iter().any(|item| match item {
            InputItem::Text { text } => !text.trim().is_empty(),
            InputItem::Image { image_url } => !image_url.trim().is_empty(),
            InputItem::LocalImage { path } => !path.trim().is_empty(),
        });

        if !has_supported_input {
            return Ok(TurnRunResult::default());
        }

        let completion = self
            .complete_with_options(&request.items, &request.options, progress_tx.as_ref())
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
    finish_reason: Option<String>,
    response_status: Option<String>,
    response_incomplete_reason: Option<String>,
    response_id: Option<String>,
    usage: ParsedUsage,
}

#[derive(Debug, Clone, Default)]
struct ParsedUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
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

fn emit_progress_event(progress_tx: Option<&UnboundedSender<EventMsg>>, event: EventMsg) {
    if let Some(tx) = progress_tx {
        let _ = tx.send(event);
    }
}

fn should_retry_with_store(status: u16, body: &str) -> bool {
    if status != 404 && status != 400 {
        return false;
    }
    let normalized = body.to_ascii_lowercase();
    normalized.contains("items are not persisted when `store` is set to false")
        || normalized.contains("items are not persisted when store is set to false")
}

fn should_retry_without_reasoning_items(status: u16, body: &str) -> bool {
    if status != 404 && status != 400 {
        return false;
    }
    let normalized = body.to_ascii_lowercase();
    normalized.contains("item with id 'rs_")
        || normalized.contains("item with id \"rs_")
        || normalized.contains("items are not persisted when `store` is set to false")
        || normalized.contains("items are not persisted when store is set to false")
}

fn should_retry_authentication_failure(status: u16, body: &str) -> bool {
    if status != 500 && status != 401 && status != 403 {
        return false;
    }
    let normalized = body.to_ascii_lowercase();
    normalized.contains("authentication failed")
}

fn responses_with_store_enabled(
    current: Option<&ResponsesRequestOptions>,
) -> ResponsesRequestOptions {
    let mut next = current.cloned().unwrap_or_default();
    next.store = Some(true);
    next
}

fn should_replay_reasoning_items(responses: Option<&ResponsesRequestOptions>) -> bool {
    let Some(reasoning) = responses.and_then(|options| options.reasoning.as_ref()) else {
        return true;
    };
    let enabled = reasoning.enabled.unwrap_or(true);
    let include_encrypted_content = reasoning.include_encrypted_content.unwrap_or(true);
    enabled && include_encrypted_content
}

fn filter_history_items_for_replay(
    history_items: &[Value],
    include_reasoning_items: bool,
) -> Vec<Value> {
    history_items
        .iter()
        .filter(|item| {
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            include_reasoning_items || item_type != "reasoning"
        })
        .cloned()
        .collect()
}

fn strip_reasoning_history_items(items: &[Value]) -> Vec<Value> {
    filter_history_items_for_replay(items, false)
}

fn next_progress_seq(progress_seq: &mut u64) -> u64 {
    *progress_seq = progress_seq.saturating_add(1);
    *progress_seq
}

fn build_context_ledger(options: &UserTurnOptions) -> Option<ContextLedger> {
    let ledger_opts = options.context_ledger.as_ref()?;
    if !ledger_opts.enabled {
        return None;
    }

    let root_dir = ledger_opts
        .root_dir
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(ContextLedger::default_root_dir);
    let session_id = options
        .session_id
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("default-session")
        .to_string();
    let agent_id = ledger_opts
        .agent_id
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("chat-codex")
        .to_string();
    let mode = ledger_opts
        .mode
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            options
                .mode
                .as_deref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("main")
        .to_string();
    let role = ledger_opts
        .role
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    ContextLedger::new(ContextLedgerConfig {
        root_dir,
        session_id,
        agent_id,
        mode,
        role,
        can_read_all: ledger_opts.can_read_all,
        readable_agents: ledger_opts.readable_agents.clone(),
        focus_enabled: ledger_opts.focus_enabled,
        focus_max_chars: ledger_opts
            .focus_max_chars
            .unwrap_or(DEFAULT_FOCUS_MAX_CHARS)
            .max(1),
    })
    .ok()
}

fn safe_append_ledger(ledger: &ContextLedger, event_type: &str, payload: Value) {
    let _ = ledger.append_event(event_type, payload);
}

#[cfg(test)]
fn execute_context_ledger_query(
    call: &FunctionCallItem,
    context_ledger: Option<&ContextLedger>,
) -> Result<Value, ModelError> {
    let Some(ledger) = context_ledger else {
        return Err(ModelError::ToolExecution {
            tool_name: "context_ledger.query".to_string(),
            message: "context ledger is not enabled for this agent".to_string(),
        });
    };
    let args = parse_function_arguments(&call.arguments);

    let limit = args
        .get("limit")
        .and_then(parse_u64)
        .map(|value| value as usize)
        .or(Some(50));
    let query = LedgerQueryRequest {
        session_id: first_string_field(&args, &["session_id", "sessionId"]),
        agent_id: first_string_field(&args, &["agent_id", "agentId"]),
        mode: first_string_field(&args, &["mode"]),
        since_ms: args
            .get("since_ms")
            .and_then(parse_u64)
            .or_else(|| args.get("sinceMs").and_then(parse_u64)),
        until_ms: args
            .get("until_ms")
            .and_then(parse_u64)
            .or_else(|| args.get("untilMs").and_then(parse_u64)),
        limit,
        contains: first_string_field(&args, &["contains", "query", "keyword"]),
        fuzzy: args.get("fuzzy").and_then(Value::as_bool).unwrap_or(false),
        event_types: extract_string_array(&args, "event_types")
            .or_else(|| extract_string_array(&args, "eventTypes"))
            .unwrap_or_default(),
    };

    let response = ledger
        .query(&query)
        .map_err(|error| ModelError::ToolExecution {
            tool_name: "context_ledger.query".to_string(),
            message: error.to_string(),
        })?;

    Ok(json!({
        "entries": response.entries,
        "timeline": response.timeline,
        "total": response.total,
        "truncated": response.truncated,
        "source": response.source,
    }))
}

#[cfg(test)]
fn execute_context_ledger_insert(
    call: &FunctionCallItem,
    context_ledger: Option<&ContextLedger>,
) -> Result<Value, ModelError> {
    let Some(ledger) = context_ledger else {
        return Err(ModelError::ToolExecution {
            tool_name: "context_ledger.insert".to_string(),
            message: "context ledger is not enabled for this agent".to_string(),
        });
    };

    let args = parse_function_arguments(&call.arguments);
    let text = first_string_field(&args, &["text", "content"]).unwrap_or_default();
    let append = args.get("append").and_then(Value::as_bool).unwrap_or(false);

    let inserted = ledger
        .insert_focus(text.as_str(), append)
        .map_err(|error| ModelError::ToolExecution {
            tool_name: "context_ledger.insert".to_string(),
            message: error.to_string(),
        })?;

    Ok(json!({
        "ok": true,
        "chars": inserted.chars,
        "truncated": inserted.truncated,
    }))
}

#[cfg(test)]
fn parse_u64(value: &Value) -> Option<u64> {
    if let Some(raw) = value.as_u64() {
        return Some(raw);
    }
    value
        .as_str()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
}

#[cfg(test)]
fn first_string_field(value: &Value, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        value
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
    })
}

#[cfg(test)]
fn extract_string_array(value: &Value, field: &str) -> Option<Vec<String>> {
    value.get(field).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    })
}

fn parse_responses_payload(payload: &Value) -> Result<ParsedResponse, ModelError> {
    if !payload.is_object() {
        return Err(ModelError::ParsePayload(serde_json::Error::io(
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "responses payload must be an object",
            ),
        )));
    }

    let mut output_text = payload
        .get("output_text")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let mut function_calls = Vec::new();
    let mut history_items = Vec::new();
    let mut reasoning = Vec::new();
    let response_status = payload
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let response_incomplete_reason = payload
        .get("incomplete_details")
        .and_then(Value::as_object)
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let response_id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let usage = parse_usage(payload.get("usage"));
    let mut finish_reason = payload
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

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

    if finish_reason.is_none() {
        finish_reason = if !function_calls.is_empty() {
            Some("tool_calls".to_string())
        } else if output_text
            .as_ref()
            .map(|text| !text.trim().is_empty())
            .unwrap_or(false)
        {
            Some("stop".to_string())
        } else if let Some(reason) = response_incomplete_reason.clone() {
            Some(reason)
        } else {
            None
        };
    }

    Ok(ParsedResponse {
        output_text,
        function_calls,
        history_items,
        reasoning,
        finish_reason,
        response_status,
        response_incomplete_reason,
        response_id,
        usage,
    })
}

fn parse_usage(raw: Option<&Value>) -> ParsedUsage {
    let Some(raw) = raw else {
        return ParsedUsage::default();
    };
    let Some(object) = raw.as_object() else {
        return ParsedUsage::default();
    };

    ParsedUsage {
        input_tokens: parse_json_u64(object.get("input_tokens")),
        output_tokens: parse_json_u64(object.get("output_tokens")),
        total_tokens: parse_json_u64(object.get("total_tokens")),
    }
}

fn parse_json_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(raw) = value.as_u64() {
        return Some(raw);
    }
    value
        .as_str()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
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
        if content_type != "output_text" && content_type != "text" {
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

fn build_initial_input(
    items: &[InputItem],
    options: &UserTurnOptions,
) -> Result<Vec<Value>, ModelError> {
    let mut input = normalize_history_items(&options.history_items);

    maybe_inject_context_block(
        &mut input,
        "developer_instructions",
        options.developer_instructions.as_deref(),
        "developer",
    );
    if let Some(turn_context_text) = render_turn_context_block(options.turn_context.as_ref()) {
        maybe_inject_context_block(
            &mut input,
            "turn_context",
            Some(turn_context_text.as_str()),
            "developer",
        );
    }

    maybe_inject_context_block(
        &mut input,
        "user_instructions",
        options.user_instructions.as_deref(),
        "user",
    );
    maybe_inject_context_block(
        &mut input,
        "environment_context",
        options.environment_context.as_deref(),
        "user",
    );

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

fn maybe_inject_context_block(
    input: &mut Vec<Value>,
    block_name: &str,
    content: Option<&str>,
    role: &str,
) {
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
    input.push(build_text_message(role, block));
}

fn history_contains_block(history: &[Value], block_name: &str, full_block_text: &str) -> bool {
    let open_tag = format!("<{block_name}>");
    history.iter().any(|item| {
        extract_text_from_history_item(item)
            .map(|text| text.contains(&open_tag) || text.contains(full_block_text))
            .unwrap_or(false)
    })
}

fn build_text_message(role: &str, text: String) -> Value {
    json!({
        "role": role,
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

    if let Some(cwd) = context
        .cwd
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
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
    if let Some(model) = context
        .model
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
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

fn estimate_tokens_excluding_ledger_focus(history: &[Value]) -> u64 {
    let mut chars = 0_usize;
    for item in history {
        if is_ledger_focus_history_item(item) {
            continue;
        }
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
    compressed_at_ms: u64,
    compressed_at_iso: String,
    source_time_start: Option<String>,
    source_time_end: Option<String>,
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
    let mut previous_summary: Option<String> = None;
    let (compressed_at_ms, compressed_at_iso) = now_timestamp_local();
    let (source_time_start, source_time_end) = extract_history_time_bounds(history);

    for item in history {
        let role = item.get("role").and_then(Value::as_str).unwrap_or_default();
        let text = extract_text_from_history_item(item);

        if role == "user"
            && text
                .as_deref()
                .map(is_initial_context_block)
                .unwrap_or(false)
        {
            if !initial_context_blocks
                .iter()
                .any(|existing| existing == item)
            {
                initial_context_blocks.push(item.clone());
            }
            continue;
        }

        if text
            .as_deref()
            .map(is_filtered_compact_text)
            .unwrap_or(false)
        {
            continue;
        }

        if let Some(summary_text) = text
            .as_deref()
            .and_then(|raw| extract_context_block(raw, "history_summary"))
        {
            let normalized = sanitize_compact_cache_summary(Some(summary_text)).unwrap_or_default();
            if !normalized.trim().is_empty() {
                previous_summary = Some(normalized);
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
        user_messages
            .into_iter()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };

    let summary_text = build_compact_summary(
        previous_summary.as_deref(),
        &narrative_lines,
        summary_hint.as_deref(),
        compressed_at_ms,
        compressed_at_iso.as_str(),
        source_time_start.as_deref(),
        source_time_end.as_deref(),
    );
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
        compressed_at_ms,
        compressed_at_iso,
        source_time_start,
        source_time_end,
    }
}

fn is_initial_context_block(text: &str) -> bool {
    text.contains("<developer_instructions>")
        || text.contains("<user_instructions>")
        || text.contains("<environment_context>")
        || text.contains("<turn_context>")
        || text.contains("<context_ledger_focus>")
}

fn is_filtered_compact_text(text: &str) -> bool {
    is_initial_context_block(text) || text.contains("<system_message>")
}

fn is_ledger_focus_history_item(item: &Value) -> bool {
    extract_text_from_history_item(item)
        .map(|text| text.contains("<context_ledger_focus>"))
        .unwrap_or(false)
}

fn sanitize_compact_cache_summary(summary: Option<&str>) -> Option<String> {
    let Some(raw) = summary else {
        return None;
    };
    let sanitized = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_filtered_compact_text(line))
        .collect::<Vec<_>>()
        .join("\n");
    if sanitized.trim().is_empty() {
        return None;
    }
    Some(sanitized)
}

fn extract_context_block<'a>(text: &'a str, block_name: &str) -> Option<&'a str> {
    let start = format!("<{block_name}>");
    let end = format!("</{block_name}>");
    let start_index = text.find(start.as_str())?;
    let content_start = start_index + start.len();
    let end_index = text[content_start..].find(end.as_str())?;
    let absolute_end = content_start + end_index;
    Some(text[content_start..absolute_end].trim())
}

fn build_compact_summary(
    previous_summary: Option<&str>,
    lines: &[String],
    summary_hint: Option<&str>,
    compressed_at_ms: u64,
    compressed_at_iso: &str,
    source_time_start: Option<&str>,
    source_time_end: Option<&str>,
) -> String {
    let mut pieces: Vec<String> = Vec::new();
    pieces.push(format!("compressed_at_ms={compressed_at_ms}"));
    pieces.push(format!("compressed_at_iso={compressed_at_iso}"));
    pieces.push(format!(
        "source_time_start={}",
        source_time_start.unwrap_or("unknown")
    ));
    pieces.push(format!(
        "source_time_end={}",
        source_time_end.unwrap_or("unknown")
    ));
    pieces.push("timeline_order=ascending".to_string());
    pieces.push(
        "note=Compacted context is a time-ordered copy. Original ledger remains immutable append-only."
            .to_string(),
    );
    if let Some(previous) = previous_summary {
        let merged = previous
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !is_filtered_compact_text(line))
            .collect::<Vec<_>>()
            .join("\n");
        if !merged.is_empty() {
            pieces.push("previous_summary=".to_string());
            pieces.push(merged);
        }
    }
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

fn extract_history_time_bounds(history: &[Value]) -> (Option<String>, Option<String>) {
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    for item in history {
        if let Some(label) = extract_time_label_from_history_item(item) {
            if first.is_none() {
                first = Some(label.clone());
            }
            last = Some(label);
        }
    }
    (first, last)
}

fn extract_time_label_from_history_item(item: &Value) -> Option<String> {
    for field in ["timestamp_iso", "timestamp", "created_at", "time"] {
        if let Some(text) = item.get(field).and_then(Value::as_str).map(str::trim) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    for field in ["timestamp_ms", "time_ms", "created_at_ms"] {
        if let Some(number) = item.get(field).and_then(Value::as_u64) {
            return Some(number.to_string());
        }
    }
    None
}

fn now_timestamp_local() -> (u64, String) {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let iso = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| format!("{ms}"));
    (ms, iso)
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
    use finger_kernel_protocol::ResponsesReasoningOptions;
    use mockito::{Matcher, Server};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::mpsc::UnboundedReceiver;

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
    fn parse_payload_reads_message_text_content_type() {
        let payload = json!({
            "id": "resp_text",
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "text", "text": "final from text type" }
                    ]
                }
            ]
        });

        let parsed = parse_responses_payload(&payload).expect("parse payload");
        assert_eq!(parsed.output_text, Some("final from text type".to_string()));
        assert_eq!(parsed.function_calls.len(), 0);
    }

    #[test]
    fn should_disable_reasoning_replay_when_encrypted_content_is_disabled() {
        let options = ResponsesRequestOptions {
            reasoning: Some(ResponsesReasoningOptions {
                enabled: Some(true),
                effort: None,
                summary: None,
                include_encrypted_content: Some(false),
            }),
            ..ResponsesRequestOptions::default()
        };

        assert!(!should_replay_reasoning_items(Some(&options)));
    }

    #[test]
    fn strip_reasoning_history_items_removes_reasoning_entries() {
        let items = vec![
            json!({
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "hello" }],
            }),
            json!({
                "type": "reasoning",
                "id": "rs_123",
                "summary": [{ "type": "summary_text", "text": "internal" }],
            }),
            json!({
                "type": "function_call",
                "id": "call_1",
                "name": "shell.exec",
                "arguments": "{\"cmd\":\"pwd\"}",
            }),
        ];

        let sanitized = strip_reasoning_history_items(&items);
        assert_eq!(sanitized.len(), 2);
        assert!(sanitized
            .iter()
            .all(|item| item.get("type").and_then(Value::as_str) != Some("reasoning")));
    }

    #[test]
    fn parse_sse_uses_output_items_and_requires_completed() {
        let ok_stream = concat!(
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"text\",\"text\":\"final from stream item\"}]}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"output\":[]}}\n\n",
            "data: [DONE]\n\n",
        );
        let parsed_ok =
            super::protocol::response::parse_sse_response(ok_stream).expect("parse sse");
        let payload_ok = parse_responses_payload(&parsed_ok).expect("parse payload from sse");
        assert_eq!(
            payload_ok.output_text,
            Some("final from stream item".to_string())
        );

        let missing_completed_stream = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_only_created\"}}\n\n",
            "data: [DONE]\n\n",
        );
        let parsed_err = super::protocol::response::parse_sse_response(missing_completed_stream);
        assert!(matches!(parsed_err, Err(ModelError::MissingStreamResponse)));
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

    #[test]
    fn build_initial_input_partitions_context_into_developer_and_user_blocks() {
        let options = UserTurnOptions {
            developer_instructions: Some("permissions=sandboxed".to_string()),
            user_instructions: Some("# AGENTS.md instructions for /repo".to_string()),
            environment_context: Some("cwd=/repo".to_string()),
            turn_context: Some(TurnContext {
                cwd: Some("/repo".to_string()),
                approval: Some("never".to_string()),
                sandbox: Some("danger-full-access".to_string()),
                model: Some("gpt-5.3-codex".to_string()),
            }),
            ..UserTurnOptions::default()
        };

        let input = build_initial_input(
            &[InputItem::Text {
                text: "hello".to_string(),
            }],
            &options,
        )
        .expect("build initial input");

        assert_eq!(input.len(), 5);
        assert_eq!(input[0]["role"], "developer");
        assert_eq!(input[1]["role"], "developer");
        assert_eq!(input[2]["role"], "user");
        assert_eq!(input[3]["role"], "user");
        assert_eq!(input[4]["role"], "user");

        let first_text = input[0]["content"][0]["text"]
            .as_str()
            .expect("developer instructions text");
        let second_text = input[1]["content"][0]["text"]
            .as_str()
            .expect("turn context text");
        let third_text = input[2]["content"][0]["text"]
            .as_str()
            .expect("user instructions text");
        let fourth_text = input[3]["content"][0]["text"]
            .as_str()
            .expect("environment context text");
        let user_input_text = input[4]["content"][0]["text"]
            .as_str()
            .expect("user input text");

        assert!(first_text.contains("<developer_instructions>"));
        assert!(second_text.contains("<turn_context>"));
        assert!(third_text.contains("<user_instructions>"));
        assert!(fourth_text.contains("<environment_context>"));
        assert_eq!(user_input_text, "hello");
    }

    #[test]
    fn initial_context_block_detection_includes_developer_instructions() {
        assert!(is_initial_context_block(
            "<developer_instructions>\npolicy\n</developer_instructions>"
        ));
    }

    #[test]
    fn context_ledger_insert_and_query_roundtrip() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("duration since epoch")
            .as_millis();
        let root = std::env::temp_dir().join(format!("finger-kernel-model-ledger-{ts}"));

        let options = UserTurnOptions {
            session_id: Some("session-test".to_string()),
            mode: Some("main".to_string()),
            context_ledger: Some(finger_kernel_protocol::ContextLedgerOptions {
                enabled: true,
                root_dir: Some(root.to_string_lossy().to_string()),
                agent_id: Some("chat-codex".to_string()),
                role: Some("coding".to_string()),
                mode: Some("main".to_string()),
                can_read_all: true,
                readable_agents: vec![],
                focus_enabled: true,
                focus_max_chars: Some(20_000),
            }),
            ..UserTurnOptions::default()
        };
        let ledger = build_context_ledger(&options).expect("ledger");

        let insert_call = FunctionCallItem {
            call_id: "call_insert".to_string(),
            name: "context_ledger.insert".to_string(),
            arguments: "{\"text\":\"important context\",\"append\":false}".to_string(),
        };
        let insert_result =
            execute_context_ledger_insert(&insert_call, Some(&ledger)).expect("insert result");
        assert_eq!(insert_result["ok"], true);

        let query_call = FunctionCallItem {
            call_id: "call_query".to_string(),
            name: "context_ledger.query".to_string(),
            arguments: "{\"event_types\":[\"focus_insert\"],\"limit\":5}".to_string(),
        };
        let query_result =
            execute_context_ledger_query(&query_call, Some(&ledger)).expect("query result");
        assert!(query_result["total"].as_u64().unwrap_or(0) >= 1);
    }

    #[test]
    fn compact_history_filters_prompt_blocks_and_preserves_timeline_order() {
        let history = vec![
            json!({
                "role": "user",
                "timestamp_iso": "2026-02-01T10:00:00Z",
                "content": [{ "type": "input_text", "text": "<user_instructions>do not leak</user_instructions>" }]
            }),
            json!({
                "role": "user",
                "timestamp_iso": "2026-02-01T10:00:10Z",
                "content": [{ "type": "input_text", "text": "<system_message>internal prompt</system_message>" }]
            }),
            json!({
                "role": "user",
                "timestamp_iso": "2026-02-01T10:00:20Z",
                "content": [{ "type": "input_text", "text": "请列出本地文件并写入 README" }]
            }),
            json!({
                "role": "assistant",
                "timestamp_iso": "2026-02-01T10:00:30Z",
                "content": [{ "type": "output_text", "text": "收到，开始执行。" }]
            }),
        ];

        let result = compact_history(&history, None);
        let summary = result.summary.unwrap_or_default();

        assert!(summary.contains("timeline_order=ascending"));
        assert!(summary.contains("source_time_start=2026-02-01T10:00:00Z"));
        assert!(summary.contains("source_time_end=2026-02-01T10:00:30Z"));
        assert!(!summary.contains("<user_instructions>"));
        assert!(!summary.contains("<system_message>"));
        assert!(summary.contains("请列出本地文件并写入 README"));

        let compacted = result.history;
        assert!(compacted.len() >= 2);
    }

    #[test]
    fn compact_budget_counts_ledger_focus_block() {
        let history = vec![
            json!({
                "role": "user",
                "content": [{ "type": "input_text", "text": "<context_ledger_focus>\nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n</context_ledger_focus>" }]
            }),
            json!({
                "role": "user",
                "content": [{ "type": "input_text", "text": "short user message" }]
            }),
        ];

        let total_tokens = estimate_tokens_in_history(&history);
        let compactable_tokens = estimate_tokens_excluding_ledger_focus(&history);
        assert!(total_tokens > compactable_tokens);
        let threshold_tokens = compactable_tokens + 1;
        let trigger_by_total = total_tokens > threshold_tokens;
        let trigger_by_compactable = compactable_tokens > threshold_tokens;
        assert!(trigger_by_total);
        assert!(!trigger_by_compactable);
    }

    #[test]
    fn compact_history_reuses_previous_summary_block() {
        let history = vec![
            json!({
                "role": "assistant",
                "timestamp_iso": "2026-02-01T10:00:00Z",
                "content": [{ "type": "output_text", "text": "<history_summary>\nold summary line\n</history_summary>" }]
            }),
            json!({
                "role": "user",
                "timestamp_iso": "2026-02-01T10:00:20Z",
                "content": [{ "type": "input_text", "text": "new user work item" }]
            }),
        ];

        let result = compact_history(&history, None);
        let summary = result.summary.unwrap_or_default();
        assert!(summary.contains("previous_summary="));
        assert!(summary.contains("old summary line"));
        assert!(summary.contains("new user work item"));
        assert!(!summary.contains("<history_summary>"));
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
            .run_turn(
                &TurnRequest {
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
                },
                None,
            )
            .await
            .expect("run turn");

        assert_eq!(result.last_agent_message.as_deref(), Some("final answer"));

        first_response_mock.assert_async().await;
        tool_execute_mock.assert_async().await;
        second_response_mock.assert_async().await;
    }

    #[tokio::test]
    async fn retries_with_store_enabled_when_provider_requires_persisted_items() {
        let mut server = Server::new_async().await;

        let first_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .match_body(Matcher::Regex(r#""store":false"#.to_string()))
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "error": {
                        "message": "Item with id 'rs_test' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true."
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
            .match_body(Matcher::Regex(r#""store":true"#.to_string()))
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_retry\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"retry ok\"}]}]}}\n\n",
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

        let output = engine
            .complete_text("hello")
            .await
            .expect("complete text should retry with store=true");
        assert_eq!(output, "retry ok");

        first_response_mock.assert_async().await;
        second_response_mock.assert_async().await;
    }

    #[tokio::test]
    async fn retries_on_transient_authentication_failure() {
        let mut server = Server::new_async().await;

        let first_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(json!({ "error": { "message": "Authentication failed" } }).to_string())
            .expect(1)
            .create_async()
            .await;

        let second_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_retry_auth\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"auth retry ok\"}]}]}}\n\n",
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

        let output = engine
            .complete_text("hello")
            .await
            .expect("complete text should retry on transient auth failure");
        assert_eq!(output, "auth retry ok");

        first_response_mock.assert_async().await;
        second_response_mock.assert_async().await;
    }

    #[tokio::test]
    async fn retries_without_reasoning_items_when_provider_rejects_rs_references() {
        let mut server = Server::new_async().await;

        let first_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .match_body(Matcher::Regex(r#""type":"reasoning""#.to_string()))
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "error": {
                        "message": "Item with id 'rs_test' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true."
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
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_retry_no_reasoning\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"retry ok without reasoning\"}]}]}}\n\n",
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
            .run_turn(
                &TurnRequest {
                    items: vec![InputItem::Text {
                        text: "retry without reasoning items".to_string(),
                    }],
                    options: UserTurnOptions {
                        history_items: vec![json!({
                            "type": "reasoning",
                            "id": "rs_test",
                            "summary": [{ "type": "summary_text", "text": "internal" }],
                        })],
                        responses: Some(ResponsesRequestOptions {
                            store: Some(true),
                            ..ResponsesRequestOptions::default()
                        }),
                        ..UserTurnOptions::default()
                    },
                },
                None,
            )
            .await
            .expect("run turn should retry without reasoning items");

        assert_eq!(
            result.last_agent_message.as_deref(),
            Some("retry ok without reasoning")
        );
        first_response_mock.assert_async().await;
        second_response_mock.assert_async().await;
    }

    #[tokio::test]
    async fn run_turn_emits_sequenced_progress_for_multiple_function_calls() {
        let mut server = Server::new_async().await;

        let first_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"output\":[",
                "{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"shell_exec\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"},",
                "{\"type\":\"function_call\",\"call_id\":\"call_2\",\"name\":\"shell_exec\",\"arguments\":\"{\\\"cmd\\\":\\\"ls\\\"}\"}",
                "]}}\n\n",
                "data: [DONE]\n\n"
            ))
            .expect(1)
            .create_async()
            .await;

        let tool_execute_pwd_mock = server
            .mock("POST", "/api/v1/tools/execute")
            .match_body(Matcher::Regex(r#""toolName":"shell.exec""#.to_string()))
            .match_body(Matcher::Regex(r#""command":"pwd""#.to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(json!({ "success": true, "result": { "stdout": "/tmp" } }).to_string())
            .expect(1)
            .create_async()
            .await;

        let tool_execute_ls_mock = server
            .mock("POST", "/api/v1/tools/execute")
            .match_body(Matcher::Regex(r#""toolName":"shell.exec""#.to_string()))
            .match_body(Matcher::Regex(r#""command":"ls""#.to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(json!({ "success": true, "result": { "stdout": "a\nb" } }).to_string())
            .expect(1)
            .create_async()
            .await;

        let second_response_mock = server
            .mock("POST", "/v1/responses")
            .match_header("authorization", "Bearer test-key")
            .match_body(Matcher::Regex(r#""type":"function_call_output""#.to_string()))
            .match_body(Matcher::Regex(r#""call_id":"call_1""#.to_string()))
            .match_body(Matcher::Regex(r#""call_id":"call_2""#.to_string()))
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"all done\"}]}]}}\n\n",
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

        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<EventMsg>();
        let result = engine
            .run_turn(
                &TurnRequest {
                    items: vec![InputItem::Text {
                        text: "run two tools".to_string(),
                    }],
                    options: UserTurnOptions {
                        tools: vec![ToolSpec {
                            name: "shell.exec".to_string(),
                            description: Some("Execute shell command".to_string()),
                            input_schema: Some(json!({
                                "type": "object",
                                "properties": { "cmd": { "type": "string" } },
                                "required": ["cmd"],
                            })),
                        }],
                        tool_execution: Some(ToolExecutionConfig {
                            daemon_url: server.url(),
                            agent_id: "chat-codex".to_string(),
                        }),
                        ..UserTurnOptions::default()
                    },
                },
                Some(progress_tx),
            )
            .await
            .expect("run turn");
        assert_eq!(result.last_agent_message.as_deref(), Some("all done"));

        let progress_events = drain_progress_events(&mut progress_rx);
        assert_eq!(progress_events.len(), 6);
        assert!(matches!(progress_events[0], EventMsg::ModelRound(_)));
        assert!(matches!(progress_events[1], EventMsg::ToolCall(_)));
        assert!(matches!(progress_events[2], EventMsg::ToolResult(_)));
        assert!(matches!(progress_events[3], EventMsg::ToolCall(_)));
        assert!(matches!(progress_events[4], EventMsg::ToolResult(_)));
        assert!(matches!(progress_events[5], EventMsg::ModelRound(_)));

        let seqs = progress_events
            .iter()
            .filter_map(extract_progress_seq)
            .collect::<Vec<_>>();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6]);

        first_response_mock.assert_async().await;
        tool_execute_pwd_mock.assert_async().await;
        tool_execute_ls_mock.assert_async().await;
        second_response_mock.assert_async().await;
    }

    #[tokio::test]
    async fn run_turn_emits_tool_error_progress_when_tool_execution_fails() {
        let mut server = Server::new_async().await;

        let first_response_mock = server
            .mock("POST", "/v1/responses")
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_fail\",\"name\":\"shell_exec\",\"arguments\":\"{\\\"cmd\\\":\\\"rm\\\"}\"}]}}\n\n",
                "data: [DONE]\n\n"
            ))
            .expect(1)
            .create_async()
            .await;

        let tool_execute_mock = server
            .mock("POST", "/api/v1/tools/execute")
            .match_body(Matcher::Regex(r#""toolName":"shell.exec""#.to_string()))
            .match_body(Matcher::Regex(r#""command":"rm""#.to_string()))
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(json!({ "error": "permission denied" }).to_string())
            .expect(1)
            .create_async()
            .await;

        let second_response_mock = server
            .mock("POST", "/v1/responses")
            .match_body(Matcher::Regex(r#""type":"function_call_output""#.to_string()))
            .match_body(Matcher::Regex(r#""call_id":"call_fail""#.to_string()))
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"handled failure\"}]}]}}\n\n",
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

        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<EventMsg>();
        let result = engine
            .run_turn(
                &TurnRequest {
                    items: vec![InputItem::Text {
                        text: "run failing tool".to_string(),
                    }],
                    options: UserTurnOptions {
                        tools: vec![ToolSpec {
                            name: "shell.exec".to_string(),
                            description: Some("Execute shell command".to_string()),
                            input_schema: Some(json!({
                                "type": "object",
                                "properties": { "cmd": { "type": "string" } },
                                "required": ["cmd"],
                            })),
                        }],
                        tool_execution: Some(ToolExecutionConfig {
                            daemon_url: server.url(),
                            agent_id: "chat-codex".to_string(),
                        }),
                        ..UserTurnOptions::default()
                    },
                },
                Some(progress_tx),
            )
            .await
            .expect("run turn");
        assert_eq!(
            result.last_agent_message.as_deref(),
            Some("handled failure")
        );

        let progress_events = drain_progress_events(&mut progress_rx);
        let tool_error = progress_events.iter().find_map(|event| match event {
            EventMsg::ToolError(error_event) => Some(error_event),
            _ => None,
        });
        assert!(tool_error.is_some());
        let tool_error = tool_error.expect("tool error event");
        assert_eq!(tool_error.tool_name, "shell.exec");
        assert!(tool_error.error.contains("permission denied"));

        let seqs = progress_events
            .iter()
            .filter_map(extract_progress_seq)
            .collect::<Vec<_>>();
        assert_eq!(seqs, vec![1, 2, 3, 4]);

        first_response_mock.assert_async().await;
        tool_execute_mock.assert_async().await;
        second_response_mock.assert_async().await;
    }

    fn drain_progress_events(progress_rx: &mut UnboundedReceiver<EventMsg>) -> Vec<EventMsg> {
        let mut events = Vec::new();
        while let Ok(event) = progress_rx.try_recv() {
            events.push(event);
        }
        events
    }

    fn extract_progress_seq(event: &EventMsg) -> Option<u64> {
        match event {
            EventMsg::ModelRound(model_round) => Some(model_round.seq),
            EventMsg::ToolCall(tool_call) => Some(tool_call.seq),
            EventMsg::ToolResult(tool_result) => Some(tool_result.seq),
            EventMsg::ToolError(tool_error) => Some(tool_error.seq),
            _ => None,
        }
    }
}
