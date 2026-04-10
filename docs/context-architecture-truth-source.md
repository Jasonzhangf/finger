# Context Architecture Truth Source

> 本文档是 Finger 项目「动态上下文构建」的设计真相唯一真源。
> 任何代码改动必须与本文档保持一致。若需变更，先更新本文档。

## 一、上下文分层架构

```
Layer 1: Persistent Store (唯一真源)
├── context-ledger.jsonl    — append-only 事件时间线（所有对话、工具调用、状态变更）
├── MEMORY.md               — 长期记忆（Long-term / Short-term 分区）
└── compact-memory.jsonl    — 压缩后的历史摘要（按任务边界分块）

Layer 2: Session View (投影)
├── Session.messages[]      — 运行时消费的会话快照
└── Session 快照文件         — 磁盘持久化的 session JSON

Layer 3: Context Builder (构建器)
├── 任务边界分组              — 一次完整用户请求 = 一个 task block
├── 优先级分层                — P1 核心对话 > P2 推理 > P3 工具事件 > P4 工具细节
├── 预算控制                  — 基于 token 预算裁剪低优先级内容
└── 嵌入召回(可选)            — 语义相似度召回历史任务

Layer 4: Context Slots (动态注入)
├── turn.user_input          — 用户请求原文
├── turn.task_context        — Context Builder 输出（替换原有 recent_history）
├── turn.allowed_tools       — 可用工具列表
├── turn.memory_md           — MEMORY.md 强制记忆
├── turn.system_slots        — plan / task / project 运行时状态
└── turn.developer           — developer 提示词 / skills / flow

Layer 5: System Prompt (静态层)
├── defaultPrompt            — 模块默认提示词
├── rolePrompt               — 角色约束提示词
├── slotPrompt               — Context Slots 渲染结果
├── stopReasoningPrompt      — Finish reason = stop 引导
└── controlBlockPrompt       — Control Block 防护
```

## 二、数据唯一真源

### 2.1 存储真源

| 数据类型 | 真源位置 | 说明 |
|----------|----------|------|
| 对话事件流 | `context-ledger.jsonl` | append-only，不可修改 |
| 会话快照 | `Session.messages[]` | Ledger 的投影，非真源 |
| 长期记忆 | `MEMORY.md` | Long-term 只追加不删除 |
| 压缩摘要 | `compact-memory.jsonl` | Context Builder compact 输出 |
| 用户配置 | `~/.finger/config/user-settings.json` | AI provider 等配置 |
| 系统配置 | `orchestration.json` / `channels.json` | 各自独立，全局唯一 |

### 2.2 构建真源

| 构建环节 | 唯一真源 | 说明 |
|----------|----------|------|
| 历史上下文 | Context Builder 输出 | 非 mergeHistory 截断 |
| 本轮累积 | currentHistory | Gate 循环中累积上一轮 reply |
| 动态插槽 | composeTurnContextSlots() | 一次渲染，多处消费 |
| 系统提示词 | buildSystemPrompt() | 静态 + 动态合一 |

## 三、Session 生命周期

### 3.1 Session 创建规则

| 场景 | 行为 | 真源 |
|------|------|------|
| 新用户请求（无 session） | 创建新 session | `sessionManager.createSession()` |
| 同项目 + 空会话可复用 | 复用空 session | `findReusableEmptySession()` |
| System agent 请求 | 创建/复用 system session | `ensureSystemSession()` |
| Reviewer 请求 | 创建独立 review session | 每次干净会话（stateless review） |
| Project agent dispatch | 按 target_agent + project_path + worker_id 确定性映射 | dispatch 逻辑 |

### 3.2 Session 复用规则

```
1. 同一用户 → 同一渠道 → 同一项目 → 复用最近 session
2. session.messages 为空（或仅含 system 消息）→ 可复用
3. session 已有实际对话 → 不复用，创建新 session
4. Gate 循环中的 runTurn → 同一 session 内累积 history
```

### 3.3 Session 数据继承

```
新 session 创建时：
  ├── 从 Ledger 读取该项目的上下文历史（Context Builder）
  ├── 从 MEMORY.md 读取长期记忆
  ├── 从 plan / task state 读取当前任务状态
  └── 组装为 system prompt + context slots 注入
```

## 四、动态上下文构建流程

### 4.1 完整构建链路（目标架构）

```
用户输入
  │
  ├─ 1. Session 决策（create / reuse / continue）
  │     └─ sessionManager.getSession() / createSession()
  │
  ├─ 2. 历史构建（Context Builder）
  │     ├─ 从 Ledger 读取事件流
  │     ├─ 任务边界分组
  │     ├─ 应用压缩摘要（compact-memory）
  │     ├─ 优先级分层 + 预算控制
  │     └─ 输出 taskContext
  │
  ├─ 3. Context Slots 组装
  │     ├─ turn.user_input = 用户输入
  │     ├─ turn.task_context = taskContext（Context Builder 输出）
  │     ├─ turn.allowed_tools = 可用工具
  │     ├─ turn.memory_md = MEMORY.md
  │     ├─ turn.system_slots = plan / task / project 状态
  │     └─ turn.developer = developer / skills / flow
  │
  ├─ 4. System Prompt 拼装
  │     ├─ defaultPrompt + rolePrompt
  │     ├─ + slotPrompt (context slots rendered)
  │     ├─ + stopReasoningPrompt
  │     └─ + controlBlockPrompt
  │
  ├─ 5. History 注入
  │     └─ currentHistory = Context Builder 输出（非简单截断）
  │
  └─ 6. 调用模型
        ├─ systemPrompt
        ├─ history (currentHistory)
        ├─ tools
        └─ metadata
```

### 4.2 压缩机制

```
触发时机：
  - turn_complete 后检测 token 用量超过阈值（默认 70%）
  - 用户手动触发 compact
  - preflight 检测到即将超出预算

压缩流程：
  1. 读取当前 session 的 Ledger 事件流
  2. 按任务边界分组
  3. 对超过 N 轮的旧任务生成摘要
  4. 摘要写入 compact-memory.jsonl
  5. 下次构建上下文时使用摘要替代原始消息

保留策略：
  - 最近 K 轮对话保持原始（不压缩）
  - 旧任务保留摘要（保留关键：request / key_tools / key_writes / topic）
  - MEMORY.md 长期记忆永不压缩
```

## 五、当前问题诊断（技术债）

### 5.1 核心问题

| # | 问题 | 根因 | 优先级 |
|---|------|------|--------|
| P0 | mergeHistory 截断最近 20 条，绕过 Context Builder | kernel-agent-base.ts 直接使用 mergeHistory | 🔴 高 |
| P0 | history 与 context-slots 重复注入同一段历史 | turn.recent_history 与 history 重叠 | 🔴 高 |
| P1 | Gate 循环 history 不累积（已修复） | params.history 是静态快照 | 🟡 已修 |
| P1 | stop-reasoning-policy maxAutoContinueTurns=0 导致 Gate 无效 | 配置文件被手动置零 | 🟡 已修 |
| P2 | Context Builder 能力被架空 | kernel-agent-base 未接入 | 🟡 中 |
| P2 | developer/skills/flow 未显式注入上下文 | 缺少对应 slot | 🟡 中 |
| P3 | 上下文丢失（连续会话不知道该做什么） | 无跨 session 的上下文继承机制 | 🔴 高 |

### 5.2 整顿路线图

| Phase | 内容 | 验收标准 |
|-------|------|----------|
| P0-1 | kernel-agent-base 接入 Context Builder 替换 mergeHistory | 新任务保留完整任务上下文 |
| P0-2 | Context Slots 去重，移除 turn.recent_history | 历史只注入一次 |
| P1-1 | 新增 turn.developer / turn.memory_md / turn.system_slots | developer/skills/flow 显式注入 |
| P1-2 | 跨 session 上下文继承机制 | 新 session 能获取上一轮任务状态 |
| P2-1 | 压缩自动化 | turn_complete 自动触发压缩 |
| P2-2 | 清理冗余上下文路径 | 只保留一条主路径 |

## 六、数据流向图（目标）

```
                     ┌──────────────┐
                     │  用户输入     │
                     └──────┬───────┘
                            │
                 ┌──────────▼──────────┐
                 │   Session 决策       │
                 │   create/reuse/cont  │
                 └──────────┬──────────┘
                            │
          ┌─────────────────▼─────────────────┐
          │         Ledger (真源)              │
          │   context-ledger.jsonl             │
          │   compact-memory.jsonl             │
          │   MEMORY.md                        │
          └─────────────────┬─────────────────┘
                            │
                 ┌──────────▼──────────┐
                 │  Context Builder    │
                 │  任务分组+预算+压缩  │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │  Context Slots      │
                 │  user_input         │
                 │  task_context       │
                 │  allowed_tools      │
                 │  memory_md          │
                 │  system_slots       │
                 │  developer          │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │  System Prompt      │
                 │  static + dynamic   │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │  模型调用            │
                 │  system + history   │
                 │  + tools + metadata │
                 └─────────────────────┘
```

## 七、维护规则

- 本文档是上下文架构的唯一真源，代码实现必须与本文档保持一致
- 任何架构变更必须先更新本文档
- 每个 Phase 完成后更新「当前问题诊断」章节
- 新增上下文组件必须在「上下文分层架构」中登记
