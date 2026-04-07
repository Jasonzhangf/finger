# Rust 统一核心重构方案

## 当前架构问题

两个独立 ChatEngine 实现：
- `ResponsesChatEngine`（lib.rs）- Responses API 协议
- `AnthropicChatEngine`（anthropic_engine.rs）- Anthropic Messages API 协议

问题：无法维护，每个协议都要完整实现 tool execution loop。

## 目标架构

```
ChatEngine（统一核心）
  ├─ complete_with_options（保留，tool loop + context ledger）
  ├─ send_protocol_request（根据 wire_api 判断）
  │    ├─ wire_api=responses → build_responses_request_payload + /v1/responses
  │    └─ wire_api=anthropic → build_anthropic_request_payload + /v1/messages
  └─ parse_protocol_payload（根据 wire_api 判断）
       ├─ wire_api=responses → parse_responses_payload
       └─ wire_api=anthropic → parse_anthropic_payload
```

## 重构步骤

### Step 1: 改名 ResponsesChatEngine → ChatEngine

文件：`rust/kernel-model/src/lib.rs`

修改点：
- Line 59: `pub struct ResponsesChatEngine` → `pub struct ChatEngine`
- Line 62-65: `impl ResponsesChatEngine` → `impl ChatEngine`
- Line 789: `impl ChatEngine for ResponsesChatEngine` → `impl ChatEngine for ChatEngine`

### Step 2: send_responses_request → send_protocol_request

文件：`rust/kernel-model/src/lib.rs`

修改点：
- Line 415: 函数名改为 `send_protocol_request`
- Line 440-449: 添加 wire_api 判断：
```rust
let (endpoint, payload) = match self.config.wire_api {
    WireApi::Responses => {
        let endpoint = format!("{}/v1/responses", self.config.base_url);
        let payload = build_responses_request_payload(...);
        (endpoint, payload)
    }
    WireApi::Anthropic => {
        let endpoint = format!("{}/v1/messages", self.config.base_url);
        let payload = build_anthropic_request_payload(...);
        (endpoint, payload)
    }
    WireApi::OpenAIChat => {
        // TODO
        ...
    }
};
```

### Step 3: parse_responses_payload → parse_protocol_payload

文件：`rust/kernel-model/src/lib.rs`

修改点：
- Line 1152: 函数名改为 `parse_protocol_payload`
- 添加 wire_api 参数：
```rust
fn parse_protocol_payload(wire_api: WireApi, payload: &Value) -> Result<ParsedResponse, ModelError> {
    match wire_api {
        WireApi::Responses => parse_responses_payload_internal(payload),
        WireApi::Anthropic => parse_anthropic_payload_internal(payload),
        WireApi::OpenAIChat => { ... }
    }
}
```

### Step 4: 删除 AnthropicChatEngine

文件：`rust/kernel-model/src/anthropic_engine.rs`

删除整个文件。

文件：`rust/kernel-model/src/lib.rs`

删除：
- Line 12: `pub use anthropic_engine::AnthropicChatEngine;`

### Step 5: main.rs 使用统一 ChatEngine

文件：`rust/kernel-bridge-bin/src/main.rs`

修改点：
- Line 6: 删除 `AnthropicChatEngine` import
- Line 12-22: 简化为：
```rust
let chat_engine: Arc<dyn ChatEngine> = match load_local_model_config() {
    Ok(model_config) => Arc::new(ChatEngine::new(model_config)),
    Err(err) => Arc::new(EchoChatEngine),
};
```

## 编译验证

每一步后运行：
```bash
cd rust && cargo build --release
```

## E2E 测试

完成后运行：
```bash
# tcm provider (anthropic wire_api)
export FINGER_CONFIG_PATH=~/.finger/config/config.json
echo '{"id":"test","op":{"type":"user_turn","items":[{"type":"text","text":"5*7"}]}}' | ./rust/target/release/finger-kernel-bridge-bin
```

## 预期结果

- ChatEngine 支持 Responses + Anthropic + OpenAIChat 协议
- 只有一个核心实现（tool loop + context ledger）
- 新协议只需添加 payload builder + parser
