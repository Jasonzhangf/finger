# Rust Kernel Anthropic Wire 语义差异分析

## 当前 Kernel 协议语义（Responses API）

```rust
// rust/kernel-protocol/src/lib.rs

pub struct UserTurnOptions {
    pub system_prompt: Option<String>,      // Responses: instructions 字段
    pub tools: Vec<ToolSpec>,               // 两边都支持
    pub responses: Option<ResponsesRequestOptions>, // Responses 特有
    pub turn_context: Option<TurnContext>,  // 包含 model/cwd/approval/sandbox
    pub history_items: Vec<Value>,          // OpenAI 格式历史
}

pub struct ResponsesRequestOptions {
    pub reasoning: Option<ResponsesReasoningOptions>,  // Responses 特有
    pub text: Option<ResponsesTextOptions>,            // Responses 特有
    pub include: Vec<String>,
    pub store: Option<bool>,
    pub parallel_tool_calls: Option<bool>,
}

pub struct ResponsesReasoningOptions {
    pub enabled: Option<bool>,
    pub effort: Option<String>,       // minimal/low/medium/high
    pub summary: Option<String>,      // concise/detailed
    pub include_encrypted_content: Option<bool>,
}

pub struct ResponsesTextOptions {
    pub enabled: Option<bool>,
    pub verbosity: Option<String>,    // low/medium/high
    pub output_schema: Option<Value>, // JSON schema 强制格式化输出
}

pub struct ToolSpec {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,  // JSON schema
}

pub enum InputItem {
    Text { text: String },
    Image { image_url: String },
    LocalImage { path: String },
}
```

---

## Anthropic Messages API 语义

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "system": "System prompt here",           // 不是 instructions
  "messages": [
    {
      "role": "user",
      "content": "Hello"                     // 可以是字符串或数组
    },
    {
      "role": "assistant", 
      "content": [
        { "type": "text", "text": "Response" },
        { "type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": {} }
      ]
    }
  ],
  "tools": [
    {
      "name": "get_weather",
      "description": "Get weather info",
      "input_schema": { ... }                // 和 Responses 一样
    }
  ],
  "tool_choice": {
    "type": "auto"                           // 或 { "type": "tool", "name": "xxx" }
  },
  "parallel_tool_calls": false               // 实际是 disable_parallel_tool_use
}
```

---

## 语义差异对比表

| 语义 | Responses API | Anthropic Messages API | 兼容性 |
|------|--------------|----------------------|--------|
| **System Prompt** | `instructions` 字段 | `system` 字段 | ✅ 可映射 |
| **Messages Format** | `input: [{ role, content: [...] }]` | `messages: [{ role, content: string/array }]` | ⚠️ 需转换 |
| **Tool Schema** | `input_schema` | `input_schema` | ✅ 一致 |
| **Tool Choice** | `tool_choice: "auto"/"required"/"none"` | `tool_choice: { type: "auto" } 或 { type: "tool", name: "xxx" }` | ⚠️ 需转换 |
| **Parallel Tool Calls** | `parallel_tool_calls: true/false` | `disable_parallel_tool_use: true/false`（反向语义） | ⚠️ 需反转 |
| **Reasoning** | `reasoning.effort/summary` | **没有对应参数** | ❌ 不支持 |
| **Text Output Schema** | `text.format.type=json_schema` | **不支持**（需要用 tool 强制格式） | ❌ 不支持 |
| **Max Tokens** | 不需要（Responses 自动管理） | `max_tokens` **必填** | ⚠️ 需添加 |
| **Temperature** | 不支持（Responses 自动管理） | 支持 | ⚠️ 可忽略 |
| **Stop Sequences** | 不支持 | 支持 | ⚠️ 可忽略 |

---

## 关键问题

### 1. Reasoning 参数不兼容

**Responses API**：
```json
{
  "reasoning": {
    "effort": "high",
    "summary": "detailed"
  }
}
```

**Anthropic API**：
- 没有对应的 reasoning 参数
- Claude 模型会自动进行推理，无法控制 effort/summary
- `include_encrypted_content` 对 Anthropic 无意义

**影响**：
- 高 reasoning effort 的请求在 Anthropic 上无法精确控制
- 可能导致模型行为差异

**解决方案**：
- 方案 A：忽略 reasoning 参数，让 Anthropic 模型自动决定
- 方案 B：用 prompt 提示语补偿："请进行深度推理，详细展示思考过程"
- **推荐方案 A**（不破坏协议语义）

---

### 2. Text Output Schema 不兼容

**Responses API**：
```json
{
  "text": {
    "format": {
      "type": "json_schema",
      "schema": { ... }
    }
  }
}
```

**Anthropic API**：
- 不支持 text output schema
- 无法强制模型输出 JSON 格式

**影响**：
- Finger 的结构化输出功能在 Anthropic 上失效
- control block 解析可能失败

**解决方案**：
- 方案 A：降级为普通 text 输出，由 TS 层解析 JSON
- 方案 B：用 tool 强制格式（创建 `submit_json_output` tool）
- 方案 C：Anthropic 禁用 text.output_schema 功能
- **推荐方案 C**（在 TS 层设置 anthropic provider 时禁用 output_schema）

---

### 3. Messages 格式转换

**Responses input 格式**：
```json
{
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Hello" },
        { "type": "input_image", "image_url": "..." }
      ]
    }
  ]
}
```

**Anthropic messages 格式**：
```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Hello" },
        { "type": "image", "source": { "type": "url", "url": "..." } }
      ]
    }
  ]
}
```

**差异**：
- `input_text` → `text`
- `input_image` → `image`
- `image_url` → `source: { type: "url", url: "..." }`
- Anthropic 还支持 `source: { type: "base64", media_type: "image/png", data: "..." }`

---

### 4. Tool Use 响应格式

**Responses tool_use**：
```json
{
  "type": "tool_use",
  "id": "call_123",
  "name": "get_weather",
  "input": { "location": "SF" }
}
```

**Anthropic tool_use**：
```json
{
  "type": "tool_use",
  "id": "toolu_01A...",  // Anthropic ID 格式不同
  "name": "get_weather",
  "input": { "location": "SF" }
}
```

**差异**：
- ID 格式不同（`call_xxx` vs `toolu_xxx`）
- 结构一致

---

### 5. Tool Result 格式

**Responses tool_result**：
```json
{
  "type": "tool_result",
  "tool_use_id": "call_123",
  "content": "Sunny, 72°F"
}
```

**Anthropic tool_result**：
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A...",
      "content": "Sunny, 72°F"
    }
  ]
}
```

**差异**：
- Anthropic tool_result 必须放在 `role: "user"` message 里
- Responses 直接放在 input 数组

---

## Rust Kernel 改动建议

### 1. 添加 AnthropicRequestOptions

```rust
// rust/kernel-protocol/src/lib.rs

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct AnthropicRequestOptions {
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(default)]
    pub disable_parallel_tool_use: Option<bool>,
}

// UserTurnOptions 添加
pub struct UserTurnOptions {
    // ...
    #[serde(default)]
    pub anthropic: Option<AnthropicRequestOptions>,
}
```

---

### 2. WireApi 枚举

```rust
// rust/kernel-config/src/lib.rs

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireApi {
    Responses,
    Anthropic,
    OpenAIChat,
}

impl WireApi {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "responses" => WireApi::Responses,
            "anthropic" | "anthropic-wire" => WireApi::Anthropic,
            _ => WireApi::Responses,
        }
    }
}

pub struct LocalModelConfig {
    pub wire_api: WireApi,
    // ...
}
```

---

### 3. Protocol 层转换

**request.rs**：
```rust
pub fn build_anthropic_request_payload(
    options: &UserTurnOptions,
    // ...
) -> Value {
    // 1. 转换 system_prompt → system
    // 2. 转换 history_items → messages（格式转换）
    // 3. 转换 tools（结构一致）
    // 4. 转换 tool_choice（"auto"/"required"/"none" → { type: "auto" }）
    // 5. 反转 parallel_tool_calls → disable_parallel_tool_use
    // 6. 添加 max_tokens（从 anthropic.max_tokens 或默认 4096）
    // 7. 忽略 reasoning/text.output_schema
}
```

---

### 4. TS → Rust 消息协议

**当前 TS 发送给 Rust 的消息**：
```json
{
  "id": "sub-1",
  "op": {
    "type": "user_turn",
    "items": [ { "type": "text", "text": "hello" } ],
    "options": {
      "system_prompt": "...",
      "tools": [ ... ],
      "responses": {
        "reasoning": { "effort": "high" },
        "text": { "output_schema": { ... } }
      }
    }
  }
}
```

**Rust 处理 Anthropic**：
- 检测 `wire_api: Anthropic`
- 读取 `options.anthropic`（新增字段）
- 转换消息格式
- 发送到 `/v1/messages`

---

## 不支持的语义（降级处理）

| 语义 | Responses | Anthropic | 降级策略 |
|------|-----------|-----------|----------|
| `reasoning.effort` | ✅ | ❌ | 忽略，模型自动决定 |
| `reasoning.summary` | ✅ | ❌ | 忽略 |
| `text.output_schema` | ✅ | ❌ | 禁用结构化输出 |
| `text.verbosity` | ✅ | ❌ | 忽略 |
| `include encrypted_content` | ✅ | ❌ | 忽略 |

---

## 实施建议

### Phase A（协议层）
1. 添加 `WireApi` 枚举到 kernel-config
2. 添加 `AnthropicRequestOptions` 到 kernel-protocol
3. 修改 `LocalModelConfig` 支持 `wire_api`

### Phase B（转换层）
1. 实现 `anthropic/request.rs`：消息格式转换
2. 实现 `anthropic/response.rs`：SSE 解析
3. 实现 `anthropic/transport.rs`：HTTP 发送

### Phase C（引擎层）
1. 实现 `AnthropicChatEngine`
2. 实现 `MultiProtocolChatEngine` 路由

### Phase D（TS 集成）
1. TS 层设置 `wire_api: "anthropic"` 到 user-settings.json
2. TS 层设置 `anthropic.max_tokens` 默认值
3. TS 层禁用 `text.output_schema`（对于 Anthropic provider）

---

## 测试场景

1. **基础对话**：Text input → Anthropic → Text output
2. **多模态**：Image input → Anthropic → Text output
3. **Tool use**：Tool call → Anthropic → Tool result
4. **多轮对话**：History items → Anthropic → Continued conversation
5. **降级测试**：`reasoning` 参数被忽略 → 验证模型行为正常

