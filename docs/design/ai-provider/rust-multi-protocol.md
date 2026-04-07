# Rust Binary 多协议支持方案

## 当前架构

```text
rust/
├── kernel-config/src/lib.rs        # 配置加载
│   └── wire_api: "responses" (硬编码)
│
├── kernel-model/src/
│   ├── lib.rs                      # ResponsesChatEngine
│   └── protocol/
│       ├── request.rs              # 构建 responses 请求
│       ├── response.rs             # 解析 responses 响应 (SSE/JSON)
│       └── transport.rs            # HTTP 发送 (/v1/responses)
│
└── kernel-bridge-bin/src/main.rs   # 入口，创建 ResponsesChatEngine
```

**限制**：
- 只支持 `responses` wire_api
- endpoint 固定为 `/v1/responses`
- SSE 响应解析只处理 `response.output_item.done` 等 OpenAI events

---

## 多协议改动方案

### 1. kernel-config: wire_api 类型支持

**当前**：
```rust
pub const DEFAULT_WIRE_API: &str = "responses";
```

**改为**：
```rust
pub enum WireApi {
    Responses,    // OpenAI Responses API (/v1/responses)
    Anthropic,    // Anthropic Messages API (/v1/messages)
    OpenAIChat,   // OpenAI Chat Completions API (/v1/chat/completions)
}

impl WireApi {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "responses" => WireApi::Responses,
            "anthropic" | "anthropic-wire" => WireApi::Anthropic,
            "chat" | "openai-chat" => WireApi::OpenAIChat,
            _ => WireApi::Responses, // fallback
        }
    }
}

pub struct LocalModelConfig {
    pub wire_api: WireApi,  // 改为枚举
    // ...
}
```

---

### 2. kernel-model: 多协议 protocol 模块

**新增目录结构**：
```text
rust/kernel-model/src/protocol/
├── mod.rs              # 路由到具体 protocol
├── responses/
│   ├── request.rs      # (现有)
│   ├── response.rs     # (现有)
│   ├── transport.rs    # (现有)
└── anthropic/
    ├── request.rs      # 新增：构建 Anthropic Messages 请求
    ├── response.rs     # 新增：解析 Anthropic SSE 响应
    └── transport.rs    # 新增：HTTP 发送 (/v1/messages)
```

**protocol/mod.rs**:
```rust
pub(crate) mod responses;
pub(crate) mod anthropic;

use crate::ModelError;
use serde_json::Value;

pub enum ProtocolRequestPayload {
    Responses(Value),
    Anthropic(Value),
}

pub enum ProtocolResponseBody {
    Json(Vec<u8>),
    Sse(String),
}

pub fn build_request_payload(
    wire_api: &WireApi,
    model: &str,
    input: &[Value],
    system_prompt: Option<&str>,
    tools: Option<&[Value]>,
    options: &UserTurnOptions,
) -> ProtocolRequestPayload {
    match wire_api {
        WireApi::Responses => {
            let payload = responses::request::build_responses_request_payload(...);
            ProtocolRequestPayload::Responses(payload)
        }
        WireApi::Anthropic => {
            let payload = anthropic::request::build_anthropic_request_payload(...);
            ProtocolRequestPayload::Anthropic(payload)
        }
        WireApi::OpenAIChat => {
            // TODO: Phase 5
            unimplemented!("OpenAI Chat protocol not yet supported")
        }
    }
}

pub fn parse_response(
    wire_api: &WireApi,
    body: ProtocolResponseBody,
) -> Result<Value, ModelError> {
    match wire_api {
        WireApi::Responses => responses::response::parse_wire_response(body),
        WireApi::Anthropic => anthropic::response::parse_anthropic_response(body),
        WireApi::OpenAIChat => unimplemented!(),
    }
}

pub async fn send_http(
    wire_api: &WireApi,
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    payload: &ProtocolRequestPayload,
    expect_sse: bool,
) -> Result<ProtocolResponseBody, ModelError> {
    match wire_api {
        WireApi::Responses => {
            responses::transport::send_responses_http(client, base_url, api_key, payload, expect_sse)
        }
        WireApi::Anthropic => {
            anthropic::transport::send_anthropic_http(client, base_url, api_key, payload, expect_sse)
        }
        WireApi::OpenAIChat => unimplemented!(),
    }
}
```

---

### 3. anthropic protocol 实现

**anthropic/request.rs**:
```rust
use serde_json::{json, Value};

pub(crate) fn build_anthropic_request_payload(
    model: &str,
    input: &[Value],
    system_prompt: Option<&str>,
    tools: Option<&[Value]>,
    max_tokens: usize,
) -> Value {
    let messages = input.iter().map(|item| {
        // 转换 OpenAI 格式到 Anthropic 格式
        if let Some(content) = item.get("content") {
            if let Some(text) = content.as_str() {
                return json!({
                    "role": item.get("role").unwrap_or(&json!("user")),
                    "content": text,
                });
            }
        }
        item.clone()
    }).collect::<Vec<_>>();

    let mut payload = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    });

    if let Some(system) = system_prompt {
        payload["system"] = Value::String(system.to_string());
    }

    if let Some(tool_defs) = tools.filter(|defs| !defs.is_empty()) {
        payload["tools"] = Value::Array(tool_defs.iter().map(|t| {
            json!({
                "name": t.get("name"),
                "description": t.get("description"),
                "input_schema": t.get("input_schema"),
            })
        }).collect());
    }

    payload
}
```

**anthropic/response.rs**:
```rust
use serde_json::{json, Value};
use crate::ModelError;

pub(crate) fn parse_anthropic_response(body: ProtocolResponseBody) -> Result<Value, ModelError> {
    match body {
        ProtocolResponseBody::Json(bytes) => {
            serde_json::from_slice::<Value>(&bytes).map_err(ModelError::from)
        }
        ProtocolResponseBody::Sse(raw) => parse_anthropic_sse(&raw),
    }
}

pub(crate) fn parse_anthropic_sse(raw: &str) -> Result<Value, ModelError> {
    let normalized = raw.replace("\r\n", "\n");
    let mut content_blocks: Vec<Value> = Vec::new();
    let mut usage: Option<Value> = None;
    let mut stop_reason: Option<String> = None;

    for chunk in normalized.split("\n\n") {
        let mut data_lines: Vec<&str> = Vec::new();
        let mut event_name: Option<String> = None;

        for line in chunk.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                event_name = Some(rest.trim().to_string());
            }
            if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start());
            }
        }

        if data_lines.is_empty() { continue; }
        let data = data_lines.join("\n");
        if data.trim() == "[DONE]" { continue; }

        let event_value = serde_json::from_str::<Value>(&data)?;
        let event_type = event_name.as_deref().unwrap_or("");

        match event_type {
            "content_block_start" => {
                if let Some(block) = event_value.get("content_block") {
                    content_blocks.push(block.clone());
                }
            }
            "content_block_delta" => {
                // 合并 delta 到对应 block
                let index = event_value.get("index").and_then(Value::as_u64).unwrap_or(0);
                if let Some(delta) = event_value.get("delta") {
                    if let Some(text) = delta.get("text").and_then(Value::as_str) {
                        if let Some(block) = content_blocks.get_mut(index as usize) {
                            if let Some(existing) = block.get("text").and_then(Value::as_str) {
                                block["text"] = Value::String(format!("{}{}", existing, text));
                            } else {
                                block["text"] = Value::String(text.to_string());
                            }
                        }
                    }
                }
            }
            "message_stop" => {
                stop_reason = Some("end_turn".to_string());
            }
            "message_delta" => {
                if let Some(sr) = event_value.get("delta").and_then(|d| d.get("stop_reason")) {
                    stop_reason = sr.as_str().map(String::from);
                }
                if let Some(u) = event_value.get("usage") {
                    usage = Some(u.clone());
                }
            }
            _ => {}
        }
    }

    Ok(json!({
        "output": content_blocks,
        "stop_reason": stop_reason,
        "usage": usage,
    }))
}
```

**anthropic/transport.rs**:
```rust
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use crate::protocol::ProtocolRequestPayload;
use crate::ModelError;

pub(crate) async fn send_anthropic_http(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    payload: &ProtocolRequestPayload,
    expect_sse: bool,
) -> Result<ProtocolResponseBody, ModelError> {
    let endpoint = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let accept_header = if expect_sse { "text/event-stream" } else { "application/json" };

    let ProtocolRequestPayload::Anthropic(data) = payload else {
        return Err(ModelError::ParsePayload(serde_json::Error::custom("wrong payload type")));
    };

    let response = client
        .post(&endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, accept_header)
        .header("anthropic-version", "2023-06-01")
        .header("x-api-key", api_key)  // Anthropic 用 x-api-key，不是 Bearer
        .json(data)
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
        Ok(ProtocolResponseBody::Sse(String::from_utf8_lossy(&body).to_string()))
    } else {
        Ok(ProtocolResponseBody::Json(body.to_vec()))
    }
}
```

---

### 4. kernel-model: 多引擎支持

**lib.rs 改动**:
```rust
use std::sync::Arc;

pub enum ChatEngineType {
    Responses(ResponsesChatEngine),
    Anthropic(AnthropicChatEngine),
}

pub struct MultiProtocolChatEngine {
    engine: ChatEngineType,
}

impl MultiProtocolChatEngine {
    pub fn new(config: LocalModelConfig) -> Self {
        match config.wire_api {
            WireApi::Responses => {
                Self { engine: ChatEngineType::Responses(ResponsesChatEngine::new(config)) }
            }
            WireApi::Anthropic => {
                Self { engine: ChatEngineType::Anthropic(AnthropicChatEngine::new(config)) }
            }
            WireApi::OpenAIChat => {
                unimplemented!("OpenAI Chat not yet supported")
            }
        }
    }
}

#[async_trait]
impl ChatEngine for MultiProtocolChatEngine {
    async fn run_turn(&self, request: TurnRequest) -> TurnRunResult {
        match &self.engine {
            ChatEngineType::Responses(e) => e.run_turn(request),
            ChatEngineType::Anthropic(e) => e.run_turn(request),
        }
    }
}

pub struct AnthropicChatEngine {
    config: LocalModelConfig,
    client: reqwest::Client,
}

impl AnthropicChatEngine {
    pub fn new(config: LocalModelConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl ChatEngine for AnthropicChatEngine {
    async fn run_turn(&self, request: TurnRequest) -> TurnRunResult {
        // 使用 protocol/anthropic 模块
        let payload = protocol::build_request_payload(
            &WireApi::Anthropic,
            &self.config.model,
            &request.input,
            request.system_prompt.as_deref(),
            request.tools.as_deref(),
            &request.options,
        );

        let body = protocol::send_http(
            &WireApi::Anthropic,
            &self.client,
            &self.config.base_url,
            &self.config.api_key,
            &payload,
            true,  // expect SSE
        ).await?;

        let response = protocol::parse_response(&WireApi::Anthropic, body)?;

        // 转换为 TurnRunResult
        TurnRunResult {
            output_text: extract_anthropic_text(&response),
            tool_calls: extract_anthropic_tool_calls(&response),
            usage: extract_anthropic_usage(&response),
        }
    }
}
```

---

### 5. kernel-bridge-bin: 入口改动

**main.rs**:
```rust
use finger_kernel_model::MultiProtocolChatEngine;

fn main() -> io::Result<()> {
    let config = load_local_model_config()?;
    let chat_engine: Arc<dyn ChatEngine> = Arc::new(MultiProtocolChatEngine::new(config));
    
    let mut runtime = KernelRuntime::spawn_with_engine(KernelConfig::default(), chat_engine);
    // ...
}
```

---

## 实施路线

| Phase | 内容 | 时间 |
|-------|------|------|
| **Phase A** | kernel-config 添加 WireApi 枚举 | 0.5d |
| **Phase B** | protocol/anthropic 模块实现 | 1d |
| **Phase C** | MultiProtocolChatEngine + AnthropicChatEngine | 1d |
| **Phase D** | kernel-bridge-bin 入口改动 | 0.5d |
| **Phase E** | Rust 测试 + 集成测试 | 1d |

---

## 关键差异对比

| 协议 | Endpoint | Auth Header | SSE Events |
|------|----------|------------|------------|
| Responses | `/v1/responses` | `Authorization: Bearer` | `response.output_item.done` |
| Anthropic | `/v1/messages` | `x-api-key` | `content_block_delta`, `message_stop` |
| OpenAI Chat | `/v1/chat/completions` | `Authorization: Bearer` | `data: {...}` |

---

## 配置示例

**user-settings.json**:
```json
{
  "aiProviders": {
    "ali-coding-plan": {
      "wire_api": "anthropic",  // 新增字段
      "base_url": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      "env_key": "ALI_CODINGPLAN_KEY",
      "model": "glm-5"
    }
  }
}
```

Rust 会读取 `wire_api: "anthropic"` 并创建 `AnthropicChatEngine`。
