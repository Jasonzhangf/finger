# 兼容性处理规则

## Compatibility层职责边界

### ✅ 应该做的
1. **Provider标准化处理**
   - 统一不同provider的请求格式
   - 处理provider特定的字段映射
   - 管理provider配置差异

2. **字段映射和转换**
   - OpenAI → Provider格式转换
   - Provider → OpenAI格式转换
   - 特殊字段适配

3. **配置驱动处理**
   - 基于配置文件的兼容性规则
   - 动态配置加载
   - 配置验证和错误处理

4. **错误兼容处理**
   - Provider错误格式标准化
   - 错误码映射
   - 错误信息本地化

### ❌ 不应该做的
1. **工具处理** - 工具规范化、收割、指引都在llmswitch-core
2. **SSE流式处理** - 流式传输逻辑在llmswitch-core
3. **业务逻辑** - 不处理具体的业务逻辑
4. **认证处理** - 认证在Provider层

## 字段映射规则

### OpenAI → Provider映射
```typescript
interface OpenAIRequest {
  model: string;           // → Provider特定模型ID
  messages: Message[];     // → Provider消息格式
  temperature?: number;    // → Provider温度参数
  max_tokens?: number;     // → Provider最大tokens
  stream?: boolean;        // → Provider流式参数
  tools?: Tool[];          // ⚠️ 不在此处理，传递给llmswitch
}
```

### Provider → OpenAI映射
```typescript
interface ProviderResponse {
  choices: Choice[];       // → OpenAI choices格式
  usage: Usage;           // → OpenAI usage格式
  model: string;          // → 原始请求的model ID
  created: number;        // → OpenAI时间戳
}
```

## 配置文件结构

### 兼容性配置
```json
{
  "compatibility": {
    "openai": {
      "fieldMapping": {
        "model": "model_id",
        "temperature": "temp",
        "max_tokens": "max_completion_tokens"
      },
      "errorMapping": {
        "invalid_request": "invalid_request_error",
        "rate_limit": "rate_limit_error"
      }
    },
    "anthropic": {
      "fieldMapping": {
        "model": "model",
        "temperature": "temperature",
        "max_tokens": "max_tokens"
      }
    }
  }
}
```

## 调试检查点

### 1. 字段映射验证
```bash
# 检查字段映射是否正确
grep -r "fieldMapping" ../../routecodex-worktree/fix/config/
```

### 2. 配置加载验证
```bash
# 检查兼容性配置
cat ../../routecodex-worktree/fix/config/*compatibility*.json
```

### 3. 错误兼容验证
```bash
# 检查错误处理
grep -r "errorMapping" ~/.routecodex/codex-samples/
```

## 常见问题

### 1. 字段映射错误
**表现**: 请求参数传递错误
**检查**: 验证fieldMapping配置
**修复**: 更新映射规则

### 2. 配置加载失败
**表现**: 使用默认配置或配置错误
**检查**: 验证配置文件格式和路径
**修复**: 修复配置文件或加载逻辑

### 3. 错误格式不兼容
**表现**: Provider错误无法正确转换
**检查**: 验证errorMapping配置
**修复**: 补充错误映射规则

## 调试命令

### 验证兼容性处理
```bash
# 查看兼容性转换日志
grep "compatibility" ~/.routecodex/codex-samples/openai-chat/*pre.json
grep "compatibility" ~/.routecodex/codex-samples/openai-chat/*post.json
```

### 检查字段转换
```bash
# 对比转换前后
diff ~/.routecodex/codex-samples/openai-chat/req_*_pre.json \
     ~/.routecodex/codex-samples/openai-chat/req_*_post.json
```