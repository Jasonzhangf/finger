# AI Provider 多协议支持 Epic

## 概述

为 Finger 添加多协议 AI Provider 支持，参考 novelmobile 的 LLMProvider 抽象层设计，支持 OpenAI-compatible、Anthropic Wire、OpenAI Native 等多协议输入。

## 设计目标

1. **多协议支持**：OpenAI-compatible（Iflow/RouteCodex）、Anthropic Wire、OpenAI Native
2. **配置驱动**：所有模型配置从 user-settings.json 读取，禁止硬编码
3. **协议适配层**：统一的 LLMProvider interface，各协议实现 formatRequest/parseResponse
4. **Provider Registry**：动态注册、配置加载、默认 provider 切换

## 架构设计

```
src/providers/
├── base/
│   ├── provider-interface.ts      # LLMProvider interface
│   ├── provider-config.ts         # ProviderConfig type
│   └── model-id-parser.ts         # parseModelId()
│
├── protocols/
│   ├── openai-compatible.ts       # Iflow/RouteCodex/OpenAI-compatible
│   ├── anthropic-wire.ts          # Anthropic Wire protocol
│   ├── openai-native.ts           # OpenAI Native (o1/o3)
│   └── custom-adapter.ts          # Plugin extension point
│
├── registry/
│   ├── provider-registry.ts       # ProviderRegistry (singleton)
│   └── provider-factory.ts        # createProvider()
│
└── index.ts                       # Export all
```

## 核心接口

### LLMProvider Interface

```typescript
export type LLMProviderType = 'openai-compatible' | 'anthropic-wire' | 'openai-native' | 'custom';

export interface LLMProviderConfig {
  id: string;                      // provider ID (e.g., 'iflow', 'anthropic', 'openai')
  type: LLMProviderType;
  apiKey: string;
  baseURL: string;
  defaultModel?: string;           // 从配置读取，禁止硬编码
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface LLMProvider {
  readonly id: string;
  readonly type: LLMProviderType;
  
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  stream?(request: LLMChatRequest): AsyncIterable<LLMStreamEvent>;
  listModels?(): Promise<string[]>;
  
  formatRequest(request: LLMChatRequest): unknown;
  parseResponse(response: unknown): LLMChatResponse;
}
```

### Model ID Parser

```typescript
/**
 * 从模型 ID 解析出 provider 和实际模型名
 * 支持格式：
 * - "anthropic:claude-sonnet-4" → { provider: "anthropic", model: "claude-sonnet-4" }
 * - "openai:gpt-5" → { provider: "openai", model: "gpt-5" }
 * - "iflow.kimi-k2.5" → { provider: "iflow", model: "kimi-k2.5" } (默认)
 */
export function parseModelId(
  modelId: string,
  registry: ProviderRegistry
): { provider: string; model: string };
```

## 配置规范

**user-settings.json（唯一真源）**：

```json
{
  "aiProviders": {
    "defaultProvider": "iflow",
    "providers": {
      "iflow": {
        "name": "Iflow",
        "base_url": "http://127.0.0.1:8765",
        "env_key": "IFLOW_API_KEY",
        "model": "kimi-k2.5",
        "timeout_ms": 30000,
        "enabled": true
      },
      "anthropic": {
        "name": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "env_key": "ANTHROPIC_API_KEY",
        "model": "claude-sonnet-4-20250514",
        "timeout_ms": 60000,
        "enabled": true
      },
      "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "env_key": "OPENAI_API_KEY",
        "model": "gpt-5",
        "timeout_ms": 30000,
        "enabled": false
      }
    }
  }
}
```

**约束**：
- 所有模型配置从 user-settings.json 读取
- 禁止硬编码默认模型、timeout、baseURL
- env_key 必须通过环境变量解析
- disabled provider 不加载

## 协议适配器

### OpenAI-compatible（Iflow/RouteCodex）

```typescript
export class OpenAICompatibleProvider implements LLMProvider {
  readonly type = 'openai-compatible';
  
  formatRequest(request: LLMChatRequest): OpenAIChatRequest {
    return {
      model: request.model,
      messages: [
        ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
        ...request.messages,
      ],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stop: request.stopSequences,
      tools: request.tools,
      tool_choice: request.toolChoice,
    };
  }
  
  parseResponse(response: OpenAIChatResponse): LLMChatResponse {
    const choice = response.choices[0];
    return {
      id: response.id,
      model: response.model,
      content: choice.message.content || '',
      finishReason: mapFinishReason(choice.finish_reason),
      toolCalls: choice.message.tool_calls,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
    };
  }
}
```

### Anthropic Wire

```typescript
export class AnthropicWireProvider implements LLMProvider {
  readonly type = 'anthropic-wire';
  
  formatRequest(request: LLMChatRequest): AnthropicMessagesRequest {
    return {
      model: request.model,
      max_tokens: request.maxTokens || 4096,
      system: request.systemPrompt,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      tools: request.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    };
  }
  
  parseResponse(response: AnthropicMessagesResponse): LLMChatResponse {
    // ... Anthropic Wire 响应解析
  }
}
```

## Provider Registry

```typescript
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private defaultProviderId: string;
  
  register(provider: LLMProvider): void;
  get(id: string): LLMProvider | undefined;
  has(id: string): boolean;
  setDefault(id: string): void;
  getDefault(): LLMProvider;
  
  // 从 user-settings.json 加载配置
  loadFromUserSettings(settings: UserSettings): void;
}
```

## 协议检测逻辑

```typescript
function detectProtocolType(config: AIProviderConfig): LLMProviderType {
  const baseURL = config.base_url.toLowerCase();
  const model = config.model.toLowerCase();
  
  // Anthropic Wire
  if (baseURL.includes('anthropic.com') || model.startsWith('claude-')) {
    return 'anthropic-wire';
  }
  
  // OpenAI Native
  if (baseURL.includes('api.openai.com') || model.startsWith('o1') || model.startsWith('o3')) {
    return 'openai-native';
  }
  
  // 默认：OpenAI-compatible
  return 'openai-compatible';
}
```

## 集成点

### agent-runtime-block 改动

```typescript
// 当前：直接 HTTP 调用
const response = await runtimeFacade.executeKernelRequest(request);

// 改为：通过 ProviderRegistry 调用
const registry = ProviderRegistry.getInstance();
const { provider: providerId, model } = parseModelId(request.model, registry);
const provider = registry.get(providerId);

const response = await provider.chat({
  model,
  messages: request.messages,
  tools: request.tools,
  ...request.options,
});
```

## 子任务

### Phase 1：基础架构
- [ ] src/providers/base/provider-interface.ts
- [ ] src/providers/base/provider-config.ts
- [ ] src/providers/base/model-id-parser.ts
- [ ] src/providers/registry/provider-registry.ts
- [ ] src/providers/registry/provider-factory.ts

### Phase 2：OpenAI-compatible Adapter
- [ ] src/providers/protocols/openai-compatible.ts
- [ ] 重构现有 HTTP 调用逻辑
- [ ] 单元测试

### Phase 3：Anthropic Wire Adapter
- [ ] src/providers/protocols/anthropic-wire.ts
- [ ] Anthropic API 调用实现
- [ ] 单元测试

### Phase 4：集成
- [ ] agent-runtime-block 改用 ProviderRegistry
- [ ] runtime-facade 改用 ProviderRegistry
- [ ] user-settings.json 加载逻辑

### Phase 5：测试与文档
- [ ] E2E 测试：多 provider 切换
- [ ] 文档更新：user-settings.example.json
- [ ] AGENTS.md 更新

## 验收标准

1. 所有模型配置从 user-settings.json 读取，无硬编码
2. 支持至少 2 种协议：OpenAI-compatible + Anthropic Wire
3. Provider Registry 可以动态切换 default provider
4. parseModelId 支持多种格式：colon、dot、plain
5. 单元测试覆盖率 > 80%

## 参考

- novelmobile/packages/llm-client/src/providers.ts
- docs/DECISION_LLM_PROVIDERS.md（novelmobile）
