# Context Builder 动态上下文构建设计

> Last updated: 2026-03-24 23:31:00 +08:00
> Status: Active
> Owner: Jason

## 1. 概述

Context Builder 负责在用户输入时动态构建推理上下文（history），替代传统的内存历史切片方式。

**核心区别**：
- 传统方式：`MemorySessionManager.getMessageHistory()` — 内存中 slice 最后 N 条
- Context Builder：从 Ledger 读取 → 分组 → 过滤 → 排序 → 截断 → 构建上下文

**影响范围**：只改变 history 部分，不影响其他上下文组件（skills、mailbox、AGENTS.md 路由、HEARTBEAT 等都在 context slots 中独立处理）。

## 2. 构建流程

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: 读取 Ledger 条目                                      │
│         从 context-ledger.jsonl 读取 session_message 类型条目  │
├─────────────────────────────────────────────��───────────────┤
│ Step 2: 按任务边界分组                                        │
│         任务 = 从 user 消息到下一个 user 消息之间的所有消息      │
├─────────────────────────────────────────────────────────────┤
│ Step 3: 24h 时间窗口粗筛                                      │
│         - 24h 内：全部保留                                     │
│         - 超过 24h：只保留有实质性用户消息的 task               │
├─────────────────────────────────────────────────────────────┤
│ Step 4: 大模型排序（可选，active/dryrun）                       │
│         - 内容相关性（首要）：话题/文件/概念匹配                 │
│         - 时间相关性（次要）：同级别内时间倒序                  │
├─────────────────────────────────────────────────────────────┤
│ Step 5: MEMORY.md 预算预留                                    │
│         从总预算中扣减 MEMORY.md 预估 token                    │
├─────────────────────────────────────────────────────────────┤
│ Step 6: 预算截断                                              │
│         按排序后的顺序填充，当前 task 块必须保留                 │
│         只在完整 task 块边界截断，不拆分单个块                  │
├─────────────────────────────────────────────────────────────┤
│ Step 7: 展平为消息列表                                        │
│         附件用占位符 {count, summary} 替换                    │
└─────────────────────────────────────────────────────────────┘
```

## 3. 排序设计

### 3.1 排序模式

| 模式 | 行为 |
|---|---|
| `false` | 关闭排序，按原始时间顺序 |
| `true` (active) | 执行排序并按结果重排 blocks |
| `'dryrun'` | 执行排序但保持原顺序，结果记录到 metadata 中便于观测 |

### 3.2 排序原则（双重维度）

**一、内容相关性（首要维度）**
- 高相关：task 直接涉及当前问题的话题/文件/概念
- 中相关：task 与当前问题有间接关联（相关领域、依赖模块等）
- 低相关：task 与当前问题无明显关联

**二、时间相关性（次要维度）**
- 在相同内容相关性级别内，时间更近的 task 排在前面
- 最近的任务优先级更高，因为上下文更连贯

**最终排序**：高相关(时间倒序) → 中相关(时间倒序) → 低相关(时间倒序)

### 3.3 排序触发时机
- **只在用户输入时触发一次**
- 后续工具调用不触发排序
- 排序模型调用通过配置 `rankingProviderId` 引用 `user-settings.json` 中的 `aiProviders`

## 4. 配置

配置文件：`~/.finger/config/user-settings.json`

```json
{
  "contextBuilder": {
    "enabled": true,
    "budgetRatio": 0.85,
    "halfLifeMs": 86400000,
    "overThresholdRelevance": 0.5,
    "enableModelRanking": "dryrun",
    "rankingProviderId": "tcm",
    "includeMemoryMd": true
  },
  "ledger": {
    "contextWindow": 262144,
    "compressTokenThreshold": 222822
  }
}
```

### 4.1 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | false | 是否启用 context builder（关闭时 fallback 到传统内存历史） |
| `budgetRatio` | number | 0.85 | ��标上下文占模型窗口的比例 |
| `halfLifeMs` | number | 86400000 (24h) | 时间窗口半衰期 |
| `overThresholdRelevance` | number | 0.5 | 超过半衰期后相关性阈值 |
| `enableModelRanking` | boolean \| 'dryrun' | false | 排序模式 |
| `rankingProviderId` | string | '' | 排序模型 provider ID（引用 aiProviders） |
| `includeMemoryMd` | boolean | true | 是否注入 MEMORY.md |

### 4.2 配置唯一真源
- `rankingProviderId` 引用 `aiProviders` 中的 provider 配置
- 排序模型的 `base_url`、`model`、`wire_api` 全部从 provider 配置读取
- **不硬编码任何模型名称**

## 5. 代码结构

| 文件 | 职责 |
|---|---|
| `src/runtime/context-builder.ts` | 核心构建逻辑 + 排序实现 |
| `src/runtime/context-builder-types.ts` | 类型定义 |
| `src/core/user-settings.ts` | 配置接口 + `loadContextBuilderSettings()` |
| `src/agents/base/kernel-agent-base.ts` | `contextHistoryProvider` hook |
| `src/agents/chat-codex/chat-codex-module.ts` | 透传 `contextHistoryProvider` |
| `src/server/modules/finger-role-modules.ts` | 注入 provider 实现 |
| `src/server/routes/ledger-routes.ts` | `/api/v1/sessions/:sessionId/context-monitor` API |
| `ui/src/components/ContextMonitor/` | UI 面板 |

## 6. Metadata 可观测字段

```typescript
metadata: {
  rawTaskBlockCount: number;
  timeWindowFilteredCount: number;
  budgetTruncatedCount: number;
  targetBudget: number;
  actualTokens: number;
  rankingExecuted: boolean;       // 排序是否成功执行
  rankingMode: 'off' | 'active' | 'dryrun';
  rankingProviderId: string;      // 使用的 provider ID
  rankingProviderModel: string;   // provider 配置的 model
  rankingIds: string[];           // 排序结果
}
```

## 7. UI Context Monitor

- 2x2 grid 右下角面板
- 左侧：Context Rounds（按 round 折叠）
- 右侧：Ledger Events（对比面板）
- 底部：详情查看
- 支持 live update（通过 WebSocket 触发刷新）

## 8. 相关文档
- `docs/design/ledger-session-integration.md` - Ledger-Session 一体化架构
- `docs/design/system-agent-v2-design.md` - System Agent V2 设计
