# Context Builder 动态上下文构建设计

> Last updated: 2026-03-24 23:52:00 +08:00
> Status: Active
> Owner: Jason

## 1. 概述

Context Builder 负责在用户输入时动态构建推理上下文（history），替代传统的内存历史切片方式。

**核心区别**：
- 传统方式：`MemorySessionManager.getMessageHistory()` — 内存中 slice 最后 N 条
- Context Builder：从 Ledger 读取 → 分组 → 过滤 → 模式构建 → 截断 → 构建上下文

**影响范围**：只改变 history 部分，不影响其他上下文组件（skills、mailbox、AGENTS.md 路由、HEARTBEAT 等都在 context slots 中独立处理）。

## 2. 构建模式

Context Builder 提供三种构建模式（UI 可选，选择后持久化到 `user-settings.json`）：

### 2.1 最轻模式（minimal）

保持原始顺序，只移除与最新用户输入无关的 task。

```
原始: [task1] [task2] [task3] [task4(当前)]
              ↑判定无关
结果: [task1] [task3] [task4(当前)]
```

- 保持原始时间顺序
- 若执行了模型排序，按相关性保留前 60% 作为"相关"，其余移除
- 不从历史补充

### 2.2 中等模式（moderate，默认）

移除无关 task 后，从历史中用相关性高的 task 补充。

```
原始: [task1] [task2] [task3] [task4(当前)]
              ↑无关(释放 100 tokens)
历史: [taskA(相关)] [taskB(相关)]
结果: [task1] [task3] [task4(当前)] + [taskA]  ← 补充到尾部
```

- 以最小颗粒（task）为单位
- 优先按"释放额度"补充
- **即使单个 task 超过释放量，只要总上下文预算不超，仍允许添加**
- 补充的 task 放在尾部（保持原始 task 的时间顺序不变）

### 2.3 激进模式（aggressive）

完全按相关性重排所有 task。

```
原始: [task1] [task2] [task3] [task4(当前)]
排序后相关性: task3 > task1 > task2
结果: [task3] [task1] [task2] [task4(当前)]
```

- 当前 task 始终保留在尾部
- 历史完全按内容相关性+时间排序重排

## 3. 构建流程

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: 读取 Ledger 条目                                      │
│         从 context-ledger.jsonl 读取 session_message 类型条目  │
├─────────────────────────────────────────────────────────────┤
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
│ Step 5: 模式构建（minimal/moderate/aggressive）                │
│         - minimal: 移除无关 task                               │
│         - moderate: 移除 + 补充（等量替换，可超释放量）         │
│         - aggressive: 完全重排                                 │
├─────────────────────────────────────────────────────────────┤
│ Step 6: MEMORY.md 预算预留                                    │
│         从总预算中扣减 MEMORY.md 预估 token                    │
├─────────────────────────────────────────────────────────────┤
│ Step 7: 预算截断                                              │
│         按排序后的顺序填充，当前 task 块必须保留                 │
│         只在完整 task 块边界截断，不拆分单个块                  │
├─────────────────────────────────────────────────────────────┤
│ Step 8: 展平为消息列表                                        │
│         附件用占位符 {count, summary} 替换                    │
└─────────────────────────────────────────────────────────────┘
```

## 4. 排序设计

### 4.1 排序开关

| 值 | 行为 |
|---|---|
| `false` | 关闭排序，按原始时间顺序 |
| `true` (active) | 执行排序并按结果重排 blocks |
| `'dryrun'` | 执行排序但保持原顺序，结果记录到 metadata 中便于观测 |

### 4.2 排序原则（双重维度）

**一、内容相关性（首要维度）**
- 高相关：task 直接涉及当前问题的话题/文件/概念
- 中相关：task 与当前问题有间接关联（相关领域、依赖模块等）
- 低相关：task 与当前问题无明显关联

**二、时间相关性（次要维度）**
- 在相同内容相关性级别内，时间更近的 task 排在前面
- 最近的任务优先级更高，因为上下文更连贯

**最终排序**：高相关(时间倒序) → 中相关(时间倒序) → 低相关(时间倒序)

### 4.3 排序触发时机
- **只在用户输入时触发一次**
- 后续工具调用不触发排序
- 排序模型通过 `rankingProviderId` 引用 `aiProviders` 配置

## 5. 配置

配置文件：`~/.finger/config/user-settings.json`

```json
{
  "contextBuilder": {
    "enabled": true,
    "mode": "moderate",
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

### 5.1 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | false | 是否启用 context builder |
| `mode` | `'minimal'\|'moderate'\|'aggressive'` | `'moderate'` | 构建模式 |
| `budgetRatio` | number | 0.85 | 目标上下文占模型窗口的比例 |
| `halfLifeMs` | number | 86400000 (24h) | 时间窗口半衰期 |
| `overThresholdRelevance` | number | 0.5 | 超过半衰期后相关性阈值 |
| `enableModelRanking` | boolean \| 'dryrun' | false | 排序开关 |
| `rankingProviderId` | string | '' | 排序模型 provider ID（引用 aiProviders） |
| `includeMemoryMd` | boolean | true | 是否注入 MEMORY.md |

## 6. 代码结构

| 文件 | 职责 |
|---|---|
| `src/runtime/context-builder.ts` | 核心构建逻辑 + 三种模式 + 排序 |
| `src/runtime/context-builder-types.ts` | 类型定义（含 ContextBuildMode） |
| `src/core/user-settings.ts` | 配置接口 + `loadContextBuilderSettings()` |
| `src/agents/base/kernel-agent-base.ts` | `contextHistoryProvider` hook |
| `src/agents/chat-codex/chat-codex-module.ts` | 透传 `contextHistoryProvider` |
| `src/server/modules/finger-role-modules.ts` | 注入 provider 实现 |
| `src/server/routes/ledger-routes.ts` | `/api/v1/sessions/:sessionId/context-monitor` API |
| `ui/src/components/ContextMonitor/` | UI 面板（含模式/removed/supplemented 指标） |

## 7. Metadata 可观测字段

```typescript
metadata: {
  rawTaskBlockCount: number;
  timeWindowFilteredCount: number;
  budgetTruncatedCount: number;
  targetBudget: number;
  actualTokens: number;
  buildMode: 'minimal' | 'moderate' | 'aggressive';
  removedIrrelevantCount: number;    // 移除的无关 task 数量
  supplementedCount: number;         // 补充的历史 task 数量
  removedTokens: number;             // 移除释放的 token 数
  supplementedTokens: number;        // 补充消耗的 token 数
  rankingExecuted: boolean;
  rankingMode: 'off' | 'active' | 'dryrun';
  rankingProviderId: string;
  rankingProviderModel: string;
  rankingIds: string[];
}
```

## 8. 相关文档
- `docs/design/ledger-session-integration.md` - Ledger-Session 一体化架构
- `docs/design/system-agent-v2-design.md` - System Agent V2 设计
