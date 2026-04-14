# Progress Monitor 架构设计

## 1. 概述

Progress Monitor 是 Finger 系统的实时进度更新模块，负责向用户展示 Agent 执行状态、上下文使用情况、团队状态等信息。

**核心目标**：
- 全局唯一真源：所有进度数据来自同一个更新点
- 可配置：更新间隔、显示内容、截断规则均可配置
- 低延迟：使用最新一轮的 usage 数据，不等待模型回传

---

## 2. 当前问题

| 问题 | 说明 |
|------|------|
| 数据来源分散 | progress 数据来自多个地方（chat-codex、agent-status-subscriber、progress-monitor） |
| 更新时机错误 | 工具执行阶段显示"等待模型回传上下文统计"，但上一轮 usage 已有 |
| 兜底逻辑愚蠢 | 没有最新 usage 时显示"等待"，而不是用上一轮数据 |
| 不可配置 | 更新间隔固定 1 分钟，显示内容固定 |
| 重复数据 | contextBreakdown 可能来自多个 snapshot |

---

## 3. 新架构：唯一真源

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ Progress Monitor 唯一真源架构 │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 1. 唯一数据源：KernelResponse（chat-codex-module） │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│ chat-codex-module │
│ │
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ kernel 响应处理 │ │
│ │ │ │
│ │ 每次收到 kernel 响应（model_round）： │ │
│ │ │ │
│ │ 1. 解析 metadata： │ │
│ │ - input_tokens │ │
│ │ - output_tokens │ │
│ │ - total_tokens │ │
│ │ - history_items_count │ │
│ │ - context_window │ │
│ │ │ │
│ │ 2. 构建 contextBreakdown： │ │
│ │ - historyDigestTokens │ │
│ │ - currentFullTokens │ │
│ │ - systemPromptTokens │ │
│ │ - developerInstructionsTokens │ │
│ │ │ │
│ │ 3. 发送 ProgressUpdateEvent： │ │
│ │ { │ │
│ │ type: 'progress_update', │ │
│ │ source: 'kernel_response', │ │
│ │ sessionId, │ │
│ │ agentId, │ │
│ │ timestamp, │ │
│ │ kernelMetadata: {...}, │ │
│ │ contextBreakdown: {...}, │ │
│ │ toolCalls: [...], // 本轮工具调用 │ │
│ │ lastTurnSummary: "..." │ │
│ │ } │ │
│ │ │ │
│ │ 发送时机： │ │
│ │ - model_round 完成后（有 usage） │ │
│ │ - tool_result 处理后（有工具结果） │ │
│ │ - 下一个请求发出之前 │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────┘
│
│ EventBus.emit('progress_update', event)
│
▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 2. Progress 数据存储：ProgressStore（唯一真源） │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│ ProgressStore │
│ │
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ 数据结构： │ │
│ │ │ │
│ │ sessionProgress: Map<sessionId, ProgressSnapshot> │ │
│ │ │ │
│ │ ProgressSnapshot { │ │
│ │ // 来自最新 kernel 响应 │ │
│ │ latestKernelMetadata: { │ │
│ │ input_tokens: number, │ │
│ │ output_tokens: number, │ │
│ │ total_tokens: number, │ │
│ │ context_window: number, │ │
│ │ history_items_count: number, │ │
│ │ round: number, │ │
│ │ seq: number, │ │
│ │ }, │ │
│ │ │ │
│ │ // 上下文分解 │ │
│ │ contextBreakdown: { │ │
│ │ historyDigestTokens: number, │ │
│ │ currentFullTokens: number, │ │
│ │ systemPromptTokens: number, │ │
│ │ developerInstructionsTokens: number, │ │
│ │ totalTokens: number, │ │
│ │ maxInputTokens: number, │ │
│ │ }, │ │
│ │ │ │
│ │ // 工具调用 │ │
│ │ recentToolCalls: ToolCallRecord[], │ │
│ │ │ │
│ │ // 执行状态 │ │
│ │ status: 'idle' | 'waiting_model' | 'waiting_tool' | 'processing', │ │
│ │ currentTask: string, │ │
│ │ latestStepSummary: string, │ │
│ │ │ │
│ │ // 时间戳 │ │
│ │ lastKernelResponseAt: Date, │ │
│ │ lastProgressUpdateAt: Date, │ │
│ │ │ │
│ │ // 团队状态 │ │
│ │ teamStatus: TeamStatusSnapshot, │ │
│ │ │ │
│ │ // Mailbox │ │
│ │ mailboxStatus: MailboxStatusSnapshot, │ │
│ │ │ │
│ │ // 元数据 │ │
│ │ sessionId, │ │
│ │ agentId, │ │
│ │ projectPath, │ │
│ │ } │ │
│ │ │ │
│ │ 更新规则： │ │
│ │ - 只接受来自 'kernel_response' 的 ProgressUpdateEvent │ │
│ │ - 不接受其他来源的数据 │ │
│ │ - 每次更新覆盖旧数据（不合并） │ │
│ │ - 保留历史 kernel 响应的 usage（用于兜底） │ │
│ └──────────────────────────────────────────────────────────────────────────────┐ │
└──────────────────┘
│
│ ProgressStore.get(sessionId) → ProgressSnapshot
│
▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 3. Progress 渲染：ProgressReporter │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│ ProgressReporter │
│ │
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ 读���配置：progress-config.json │ │
│ │ │ │
│ │ { │ │
│ │ "updateIntervalMinutes": 1, │ │
│ │ "display": { │ │
│ │ "contextUsage": true, │ │
│ │ "contextBreakdown": "summary" | "full" | "none", │ │
│ │ "toolCalls": "summary" | "full" | "none", │ │
│ │ "teamStatus": true | false, │ │
│ │ "mailboxStatus": true | false, │ │
│ │ "sessionInfo": true | false, │ │
│ │ "reasoning": true | false, │ │
│ │ "controlTags": true | false │ │
│ │ }, │ │
│ │ "breakdownMode": "release" | "dev", │ │
│ │ "truncation": { │ │
│ │ "maxToolCallChars": 60, │ │
│ │ "maxRecentRounds": 5, │ │
│ │ "maxTeamMembers": 10 │ │
│ │ } │ │
│ │ } │ │
│ │ │ │
│ │ 渲染流程： │ │
│ │ │ │
│ │ 1. 从 ProgressStore 读取 ProgressSnapshot │ │
│ │ │ │
│ │ 2. 根据配置选择显示内容 │ │
│ │ │ │
│ │ 3. 构建进度字符串 │ │
│ │ - 上下文占用（如果 contextUsage=true） │ │
│ │ - 工具调用摘要（如果 toolCalls=summary） │ │
│ │ - 团队状态（如果 teamStatus=true） │ │
│ │ │ │
│ │ 4. 发送到输出通道 │ │
│ │ - QQBot │ │
│ │ - WebUI │ │
│ │ │ │
│ │ 兜底逻辑： │ │
│ │ - 如果 latestKernelMetadata 为空，用上一轮数据 │ │
│ │ - 如果上一轮也没有，显示"启动中"（不显示"等待模型回传"） │ │
│ └──────────────────────────────────────────────────────────────────────────────┐ │
└──────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 4. 输出通道 │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐ ┌──────────────────┐
│ QQBot │ │ WebUI │
│ │ │ │
│ 通过 EventBus │ │ 通过 WebSocket │
│ 接收 progress │ │ 接收 progress │
│ 输出 │ │ 输出 │
└──────────────────┘ └──────────────────┘

---

## 4. 更新时机（唯一时机）

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 进度更新时机 │
└─────────────────────────────────────────────────────────────────────────────────────┘

Turn 执行流程：
│
├─ 用户请求进入
│
├─ 发送给 kernel
│
├─ kernel 响应（model_round） ← 第一次更新时机
│ │
│ └─ 有 usage 数据（input_tokens, total_tokens）
│ └─ 有 contextBreakdown
│ └─ 发送 ProgressUpdateEvent
│
├─ tool_call 执行
│
├─ tool_result 返回 ← 第二次更新时机
│ │
│ └─ 有工具执行结果
│ └─ 有状态变化（waiting_tool → waiting_model）
│ └─ 发送 ProgressUpdateEvent
│
├─ 下一个请求发出之前 ← 最终更新时机
│ │
│ └─ 所有本轮数据都已就绪
│ └─ usage、toolCalls、状态全部确定
│ └─ 发送 ProgressUpdateEvent（完整数据）
│
└─ Turn 结束

关键规则：
│
├─ 不在"工具执行中"更新（数据不完整）
│
├─ 不在"等待模型"时显示"等待模型回传"
│ │
│ └─ 应该用上一轮的 usage 数据
│ └─ 如果上一轮也没有，显示"启动中"
│
└─ 更新时机统一在 kernel 响应后、tool_result 后、下一请求前
```

---

## 5. 配置详解

### 5.1 更新间隔

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| updateIntervalMinutes | 1 | 更新间隔（分钟） |

允许值：0.5, 1, 2, 5, 10

### 5.2 显示内容

| 配置项 | 默认值 | 可选值 | 说明 |
|--------|--------|--------|------|
| contextUsage | true | true/false | 显示上下文占用百分比 |
| contextBreakdown | summary | summary/full/none | 显示上下文分解 |
| toolCalls | summary | summary/full/none | 显示工具调用 |
| teamStatus | true | true/false | 显示团队状态 |
| mailboxStatus | true | true/false | 显示 Mailbox 状态 |
| sessionInfo | true | true/false | 显示 Session 信息 |
| reasoning | false | true/false | 显示 Reasoning 摘要 |
| controlTags | false | true/false | 显示 Control Tags |

### 5.3 截断规则

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| maxToolCallChars | 60 | 工具调用摘要最大字符数 |
| maxRecentRounds | 5 | 最近轮次最大数量 |
| maxTeamMembers | 10 | 团队成员最大显示数量 |

---

## 6. 上下文分解模式

### 6.1 summary 模式

```
🧠 上下文: 13% · 36.3k/262k
🧩 历史: digest=2.8k(1.1%) · current=13.7k(5.2%)
```

### 6.2 full 模式

```
🧠 上下文: 13% · 36.3k/262k
🧩 分解:
- historyDigestTokens: 2800 (1.1%)
- currentFullTokens: 13700 (5.2%)
- systemPromptTokens: 9000 (3.4%)
- developerInstructionsTokens: 5000 (1.9%)
- totalTokens: 36300 (13.8%)
```

### 6.3 none 模式

```
（不显示上下文分解）
```

---

## 7. 团队状态显示

### 7.1 teamStatus=true

```
👥 Team: 3 agents active
├─ finger-project-agent: 执行中 (36.3k tokens)
├─ finger-system-agent: idle
└─ finger-reviewer-agent: 等待任务
```

### 7.2 teamStatus=false

```
（不显示团队状态）
```

---

## 8. 模块拆分

```
src/server/modules/progress/
├── progress-store.ts # 唯一数据存储
├── progress-reporter.ts # 渲染 + 输出
├── progress-config.ts # 配置读取
├── progress-types.ts # 类型定义
├── progress-utils.ts # 工具函数
└── index.ts # 导出

src/agents/chat-codex/
└── chat-codex-module.ts # 发送 ProgressUpdateEvent（唯一数据源）
```

---

## 9. 迁移步骤

| 步骤 | 内容 | 优先级 |
|------|------|--------|
| 1 | 创建 ProgressStore（唯一数据存储） | P0 |
| 2 | 修改 chat-codex-module 发送 ProgressUpdateEvent | P0 |
| 3 | 创建 ProgressReporter（渲染 + 输出） | P0 |
| 4 | 创建 progress-config.json 配置文件 | P0 |
| 5 | 删除旧的 progress-monitor 散落代码 | P1 |
| 6 | 修改 agent-status-subscriber 只消费 ProgressStore | P1 |
| 7 | 添加团队状态显示 | P2 |

---

## 10. 关键约束

| 约束 | 说明 |
|------|------|
| 唯一真源 | ProgressStore 是唯一数据源，不接受其他来源 |
| 唯一时机 | 只在 kernel 响应后、tool_result 后、下一请求前更新 |
| 兜底规则 | 用上一轮 usage，不显示"等待模型回传" |
| 可配置 | 更新间隔、显示内容、截断规则均可配置 |
| 低延迟 | 不等待新数据，用已有数据立即渲染 |

---

## 11. 测试矩阵

| 场景 | 预期行为 |
|------|---------|
| 新 session 启动 | 显示"启动中"，不显示"等待模型回传" |
| 第一轮完成 | 显示第一轮 usage |
| 第二轮进行中 | 用第一轮 usage 作为兜底 |
| 第二轮完成 | 显示第二轮 usage |
| 工具执行中 | 显示上一轮 usage + 本轮工具调用 |
| 上下文超限 | 显示超限警告 + 当前 usage |
| 团队状态开启 | 显示所有 agent 状态 |
| 团队状态关闭 | 不显示团队状态 |
| 配置间隔 2 分钟 | 每 2 分钟更新一次 |
