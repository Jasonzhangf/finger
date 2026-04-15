# AI Provider Integration Points

## 当前架构

```text
ProcessChatCodexRunner (TS)
    ↓ FINGER_KERNEL_PROVIDER env
Rust kernel-bridge-bin
    ↓ HTTP API call
AI Provider (responses wire_api)
```

**限制**：
- Rust binary 只支持 `responses` 协议
- Anthropic Wire 协议在 TS 层实现，Rust 不支持
- Compaction/ranking 直接用 HTTP，绕过 Rust

## Phase 4 集成点

### 1. RuntimeFacade.compaction summarizer

**当前**：
```typescript
// src/runtime/runtime-facade.ts
const providerResolved = resolveKernelProvider(providerId);
const endpoints = buildResponsesEndpoints(provider.base_url);
const headers = buildProviderHeaders(provider);
const response = await fetch(endpoint, { ... });
```

**改为**：
```typescript
import { ProviderRegistry } from '../providers/provider-registry.js';

const registry = ProviderRegistry.getInstance();
const provider = registry.get(providerId);
const response = await provider.chat({
  model: providerConfig.defaultModel,
  messages: [{ role: 'user', content: prompt }],
  maxTokens: 4096,
});
```

### 2. ContextBuilder.ranking provider

**旧实现（已删除）**：
```typescript
// historical: src/runtime/context-builder.ts
const providerResolved = resolveKernelProvider(providerId);
const endpoints = buildResponsesEndpoints(provider.base_url);
const headers = buildProviderHeaders(provider);
```

**改为**：
```typescript
const registry = ProviderRegistry.getInstance();
const provider = registry.get(providerId);
```

### 3. ProcessChatCodexRunner（暂不改动）

**原因**：
- Rust binary 是核心 kernel 调用层
- Anthropic Wire 协议需要 Rust 支持（Phase 5）
- 当前 Phase 4 只改 TS 层调用

## 实施计划

| 步骤 | 文件 | 改动 |
|------|------|------|
| Step 1 | `runtime-facade.ts` | `summarizeCompactionWithProvider` 用 ProviderRegistry |
| Step 2 | `context-history/*` / `context-ledger-memory.ts` | 如仍保留 ranking/recall 能力，统一迁移到现存唯一实现链 |
| Step 3 | `kernel-provider-client.ts` | 标记为 deprecated（保留向后兼容） |
| Step 4 | E2E test | compaction + ranking 测试 |

## 不改动

- `ProcessChatCodexRunner`（依赖 Rust binary）
- `kernel-provider-client.ts`（保留，向后兼容）
- `user-settings.ts`（保持读取逻辑）
