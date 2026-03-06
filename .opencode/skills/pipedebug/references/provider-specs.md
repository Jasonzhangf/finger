# Provider接口规范

## Provider层职责边界

### ✅ 核心职责
1. **双向HTTP通信**
   - 发送HTTP请求到外部AI服务
   - 接收HTTP响应并解析
   - 处理连接超时和重试

2. **认证管理**
   - 管理API密钥和认证令牌
   - 处理OAuth流程
   - 认证信息刷新

3. **模型ID双向替换**
   - 发送前：替换为provider当前设置的模型ID
   - 响应时：替换回原始请求的模型ID
   - 维护模型映射关系

### ❌ 严格禁止
1. **工具处理** - 任何工具逻辑都在llmswitch-core
2. **业务逻辑** - 不处理具体业务规则
3. **格式转换** - 格式转换在Compatibility层
4. **SSE处理** - 流式处理在llmswitch-core

## Provider接口标准

### 基础Provider接口
```typescript
interface Provider {
  // 核心通信方法
  sendRequest(request: ProcessedRequest): Promise<RawResponse>;

  // 认证管理
  authenticate(): Promise<boolean>;
  refreshAuth(): Promise<void>;

  // 模型管理
  mapModel(requestModel: string): string;
  unmapModel(providerModel: string): string;

  // 健康检查
  healthCheck(): Promise<boolean>;
}
```

### HTTP通信规范
```typescript
interface ProcessedRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body: string;
  timeout: number;
  retries: number;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  timings: RequestTimings;
}
```

## 具体Provider实现

### OpenAI Provider
```typescript
class OpenAIProvider implements Provider {
  private apiKey: string;
  private baseURL: string;
  private modelMapping: Map<string, string>;

  async sendRequest(request: ProcessedRequest): Promise<RawResponse> {
    // 1. 模型ID替换
    const mappedBody = this.mapModelInRequest(request.body);

    // 2. 发送HTTP请求
    const response = await this.httpClient.request({
      ...request,
      body: mappedBody
    });

    // 3. 模型ID恢复
    const restoredBody = this.unmapModelInResponse(response.body);

    return {
      ...response,
      body: restoredBody
    };
  }
}
```

### Anthropic Provider
```typescript
class AnthropicProvider implements Provider {
  private apiKey: string;
  private baseURL: string;

  // Anthropic特定的认证和通信逻辑
  async authenticate(): Promise<boolean> {
    // 验证API密钥有效性
  }

  // Anthropic模型映射
  mapModel(requestModel: string): string {
    const mapping = {
      'gpt-4': 'claude-3-opus-20240229',
      'gpt-3.5-turbo': 'claude-3-sonnet-20240229'
    };
    return mapping[requestModel] || requestModel;
  }
}
```

## 配置规范

### Provider配置结构
```json
{
  "providers": {
    "openai-provider": {
      "type": "openai",
      "enabled": true,
      "config": {
        "apiKey": "${OPENAI_API_KEY}",
        "baseURL": "https://api.openai.com/v1",
        "timeout": 30000,
        "maxRetries": 3
      },
      "models": {
        "gpt-4": {
          "providerModelId": "gpt-4-turbo-preview",
          "maxTokens": 128000,
          "supportsStreaming": true,
          "supportsTools": true
        }
      }
    },
    "anthropic-provider": {
      "type": "anthropic",
      "enabled": true,
      "config": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "baseURL": "https://api.anthropic.com",
        "timeout": 60000
      }
    }
  }
}
```

## 调试检查点

### 1. HTTP通信验证
```bash
# 检查HTTP请求日志
grep -r "http.request" ~/.routecodex/codex-samples/
grep -r "http.response" ~/.routecodex/codex-samples/
```

### 2. 认证状态检查
```bash
# 检查认证相关日志
grep -r "auth" ~/.routecodex/codex-samples/
grep -r "api.key" ~/.routecodex/codex-samples/
```

### 3. 模型映射验证
```bash
# 检查模型ID替换
grep -r "model.mapping" ~/.routecodex/codex-samples/
diff ~/.routecodex/codex-samples/*/req_*_pre.json \
     ~/.routecodex/codex-samples/*/req_*_post.json | grep -i model
```

## 常见问题

### 1. HTTP连接失败
**表现**: 连接超时、网络错误
**检查**: 网络连通性、DNS解析、防火墙
**修复**: 检查网络配置，增加超时时间

### 2. 认证失败
**表现**: 401未授权、403禁止访问
**检查**: API密钥有效性、权限范围
**修复**: 更新API密钥，检查权限设置

### 3. 模型映射错误
**表现**: 模型不存在、模型不匹配
**检查**: 模型映射配置、provider支持列表
**修复**: 更新模型映射表

### 4. 响应解析失败
**表现**: JSON解析错误、格式不匹配
**检查**: 响应格式、API版本兼容性
**修复**: 更新解析逻辑，处理边缘情况

## 调试命令

### Provider状态检查
```bash
# 检查provider健康状态
curl -X GET http://localhost:5506/api/debug/providers

# 检查特定provider配置
curl -X GET http://localhost:5506/api/debug/providers/openai-provider
```

### 请求追踪
```bash
# 追踪完整请求链路
grep "request.id" ~/.routecodex/codex-samples/openai-chat/req_*.json
```