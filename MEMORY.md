# MEMORY.md

## General Memory
- [2026-03-14] 长期记忆仅写入本文件；短期记忆写入 `CACHE.md`，review 通过后汇总写入本文件并清空 `CACHE.md`（保留头部）。  
  Tags: memory, cache, review

## Architecture & Runtime
- [2026-03-11] 三层架构：blocks（唯一真源）/ orchestration（编排）/ ui（展示），保持层间解耦。  
  Tags: architecture, blocks, orchestration, ui
- [2026-03-11] 标准化 Channel Bridge：统一 types/manager/openclaw-adapter，消息闭环为 `channel-message -> handleChannelMessage -> hub.route -> outputs`。  
  Tags: channel-bridge, openclaw, messagehub
- [2026-03-11] 双 daemon 架构：两组端口（9999/9998 & 9997/9996），5s 健康检查，故障自动重启；CLI 提供 start/stop/restart/status/enable-autostart。  
  Tags: daemon, dual-daemon, runtime
- [2026-03-12] ChannelBridge 全部统一进入 MessageHub：ChannelBridge 只做 IO，不做 routing；消息 envelope 统一 `id/messageId/replyTo` 语义。  
  Tags: channel-bridge, messagehub, envelope
- [2026-03-12] 动态接入开关：`FINGER_CHANNEL_BRIDGE_USE_HUB` 控制是否走 MessageHub；通道按 `channel.<channelId>` 自动注册路由。  
  Tags: channel-bridge, config, routing
- [2026-03-12] QQ Bot 通道：`msg_id` 必须保留为原始 MessageSid；`replyTo` 必须使用 `metadata.messageId`。  
  Tags: qqbot, messagehub, replyTo

## System Agent & Super Commands
- [2026-03-11] System Agent 仅允许操作 `~/.finger/system`，独立 session 与 cwd，响应需自报家门 `SystemBot:`。  
  Tags: system-agent, isolation, sessions
- [2026-03-11] 超级命令语法 `<##@system##>` / `<##@agent##>` / `<##@system:pwd=...##>`；系统命令有通道白名单与可选密码鉴权。  
  Tags: super-command, system-auth, channel-auth
- [2026-03-17] CLI `execute --task` 载荷兼容修复：为 `EXECUTE` 同时发送 `task/text/content`，并在 `parseUnifiedAgentInput` 支持 `task/description` 文本别名，避免 gateway/agent 路径出现 `No input text provided`。  
  Tags: cli, execute, message-payload, system-agent, agent-runtime
- [2026-03-13] ChannelContextManager 作为上下文真源：system/agent/project 切换命令必须更新上下文；provider 切换不影响 agent 上下文。  
  Tags: channel-context, persistence
- [2026-03-13] MessageHub 指令集：Project -> Session -> Agent 关系为单一真源；通道策略 `direct`/`mailbox` 决定是否可直达 agent。  
  Tags: messagehub, commands, auth, session

## Session Management & Agent Runtime SSOT
- [2026-03-24] 约束更新（Jason 明确）：旧的 `new / resume / session` 语义是基于旧 session 文件模型；新架构中这些操作必须以 **ledger 为唯一真源** 解释与实现。UI 的会话切换/新建/恢复都要对应 ledger（持久化），动态 session 只是按 ledger slots 拼接的上下文视图。
  Tags: session, ledger, ssot, ui
- [2026-03-13] Session 管理迁移到 Agent 层：移除 MessageHub `/resume`；新增 `session.list` / `session.switch` 工具；System Agent 可跨 agent 切换。
  Tags: session-management, agent-tools
- [2026-03-13] `system:restart` 仍在 MessageHub 层直连 daemon，避免交给 agent。
  Tags: system, restart, messagehub
- [2026-03-07..08] UI 运行态单一真源：`configAgents`/`runtimeAgents`/`catalogAgents` 分离；`sessionAgentId/ownerAgentId` 为唯一真源；LeftSidebar 合并 runtime+历史会话并去重。
  Tags: ui, runtime, ssot
- [2026-03-13] UI 会话刷新修复：取消 `limit=0`，实时 WS events 不再被 session messages 覆盖；仅在无 WS 事件时做 session hydrate。
  Tags: ui, websocket, session-refresh
- [2026-03-20] 概念区分：codex 的 session(thread) 同时承载上下文与完整事件流；finger 的 session 主要是 UI 对话历史；finger 的 ledger(context-ledger.jsonl) 是推理层结构化事件记录。finger 发送请求的上下文以 session history 为主，ledger 仅在 focus 注入时进入上下文。为对齐 codex，ledger 需完整记录 tool_call/tool_result/tool_error（含输入/输出/错误/耗时），session 需完整呈现工具事件。
  Tags: session, ledger, tool-call, memory, context

## OpenClaw Gate & Mailbox
- [2026-03-10] OpenClaw gate 保持通用；finger 自行实现 thread binding、权限策略、消息分类。  
  Tags: openclaw, mailbox, thread-binding
- [2026-03-10] Mailbox 是异步消息唯一真源：控制渠道可进主会话，非控制渠道只入 mailbox；agent 接收 mailbox notice，必要时调用 read/ack。  
  Tags: mailbox, async, permissions
- [2026-03-10] OpenClaw Gate 实施进度：Block 层 + 配置 schema/loader + openclaw input/output 适配完成；orchestration adapter 可注册 OpenClaw 工具，仍待接入 runtime 启动链路。  
  Tags: openclaw, block-layer, orchestration, config
- [2026-03-23] `user.ask` 在纯文本渠道（当前先收敛到 `qqbot`、`weixin`）采用异步握手：agent 发起 ask 后，`waiting_for_user` 事件必须主动推送问题到渠道；用户下一条文本回复先按 `channelId + userId + groupId + sessionId + agentId` 作用域匹配 pending ask，命中则直接 resolve 原 ask promise、记录 session user message，并回复“已收到你的回复，继续处理中…”，不得重新 dispatch 新任务。三类 agent（system/project/reviewer）都需要白名单放行 `user.ask`。  
  Tags: user.ask, qqbot, weixin, async, channel-bridge, waiting-for-user, ask-scope, whitelist
- [2026-03-23] 当目标 agent 忙且 dispatch queue 超时，不应直接标记失败；应转入目标 agent 的 mailbox 作为待处理任务。通道/UI 文案应显示“邮箱等待 ACK”而不是“失败”。目标 agent 空闲后通过 mailbox-check 提示逐条处理：先 `mailbox.read(id)` 读取完整任务，真正处理完成后再 `mailbox.ack(id)`；未处理完成不得 ack。  
  Tags: mailbox, dispatch, queue-timeout, ack, busy-agent
- [2026-03-23] Mailbox 生命周期统一为 `pending -> processing -> completed|failed`：`mailbox.read(id)` 是领取动作，普通 task 首次读取会把 `pending` 切到 `processing`；`notification` 首次读取只记录 `readAt`，仍保持 `pending`，仅在 agent 空闲且没有 actionable mailbox work 时提示阅读。`mailbox.ack(id, { summary/result | status:\"failed\", error })` 必须在 read 之后调用，用于提交终态；dispatch-task 的 ack 完成后，结果通知要回流到 source agent 的 mailbox，而不是硬编码 system agent。  
  Tags: mailbox, lifecycle, notification, idle-only, ack, source-agent, runtime-tools
- [2026-03-23] Agent mailbox 工具补齐批量操作：新增 `mailbox.read_all` 与 `mailbox.remove_all`，三类 agent（system/project/reviewer）白名单都要放行。`read_all` 默认批量读取未读消息，task 会批量进入 `processing`，notification 仍只标记已读；`remove_all` 支持按 `status/category/unreadOnly/ids/limit` 批量清理 mailbox。  
  Tags: mailbox, batch, read-all, remove-all, whitelist, runtime-tools
- [2026-03-23] Mailbox 生命周期收敛为“纯消息传递、非持久化”：`HeartbeatMailboxManager` 改为内存态（不再写 `~/.finger/mailbox/<agent>/inbox.jsonl`），并在 `mailbox.ack(...)` 成功后自动 `remove` 清理消息；`get/list/markRead/ack/remove` 对不存在 mailbox 返回空结果，不再隐式创建空 mailbox。  
  Tags: mailbox, lifecycle, ephemeral, non-persistent, ack, auto-clean
- [2026-03-23] QQBot 正文增量补齐结构化 `ask` 可见性：当 `lastAgentMessage` 为结构化 orchestrator 输出（含 `summary/status/nextAction/ask`）时，正文会格式化出“下一步 / 需要(可选)回复 / 可选项 / 直接回复提示”，避免只显示 summary 导致用户看不到 `user.ask`。  
  Tags: qqbot, body-updates, user.ask, structured-output, event-forwarding
- [2026-03-23] 进度更新通道文本新增 mailbox 状态快照：`sendProgressUpdate` 在 summary 中附加 `mailbox.status(target): unread/pending/processing`，并在 details 挂 `mailboxStatus.counts/recentUnread`，用于“不是简单通知”的进度可观测性。  
  Tags: progress-update, mailbox.status, observability, qqbot

## Compact & Ledger
- [2026-03-09] 自动 compact 阈值 85%；Ledger 支持 search/index/compact；系统通知触发 `maybeAutoCompact`。  
  Tags: compact, ledger, memory
- [2026-03-23] `context_ledger.memory` 查询接口改为三段式：`index` 只负责索引维护，`search` 默认返回 slot-indexed 命中摘要，`query` 通过 `slot_start/slot_end` + `detail=true` 拉取小范围明细；同时 `memory-ledger` CLI 写 stdout/stderr 后不再立刻 `process.exit()`，避免大 JSON 输出在 pipe 中被截断。  
  Tags: context-ledger, search, slot, query, cli, truncation

## Long-term Memory
- [2026-03-14 15:27:58] role=user
  summary: "完成 CACHE.md + MEMORY.md 双层记忆管理与 Reviewer 流程联动，测试通过，任务已闭环"
  Tags: memory, cache, review, compaction, orchestrator
- [2026-03-14 17:57:06] role=user
  summary: "Phase 1 核心改动完成（MultiAgentMonitorGrid 接收 panels prop、canvasElement 从 sessions 构造、rightPanelElement 固定 system agent），TypeScript 编译 + 16 项 UI 测试通过，Phase 2 已 closed，finger-237 待收尾状态更新。"
  Tags: ui, refactoring, multi-agent-grid, session-panel, finger-237
- [2026-03-20 08:55:00] role=user
  summary: "5555 是正式业务服务器（非 mock），支持 /v1/responses 与 /v1/chat/completions，必须带 Authorization: Bearer $ROUTECODEX_HTTP_APIKEY 才能正常调用；缺少认证会导致 unauthorized 和 run_turn http request failed。message-hub routeToOutput 已加 isExtensible 守卫以避免对 string 注入 meta 的崩溃；tool_error 已加入 EventBus 广播到 WebSocket/QQBot；server/index.ts 增加 uncaughtException/unhandledRejection/exit 记录到 ~/.finger/logs/daemon-crash.log。"
  Tags: provider, responses, auth, messagehub, tool_error, daemon, crashlog

---

## iflow SDK 剥离迁移计划 {#mem-iflow-migration-2026-03-16}

> timestamp: `2026-03-16T06:40:14.689Z`

### 背景
当前项目有大量基于 iflow SDK (`@iflow-ai/iflow-cli-sdk`) 的 Agent 实现，但正式业务已迁移到 ChatCodexModule（基于 KernelAgentBase）。需要剥离 iflow SDK 依赖，统一到 ChatCodexModule 架构。

### 决策
- **Orchestrator 处理**：方案A - 重构为使用 ChatCodexModule
- **Session 管理**：方案A - 使用 MemorySessionManager
- **优先级**：优先删除 iflow SDK 依赖，快速验证 system agent 功能

### 实施阶段

#### Phase 1: 添加 role=system 支持（高优先级）
1. `src/agents/chat-codex/chat-codex-module.ts` - 检测 `metadata.role === 'system'`，跳过历史和 developer instructions
2. `src/blocks/agent-runtime-block/index.ts` - 检测 system role，不添加 DISPATCH CONTRACT
3. `src/common/agent-dispatch.ts` - 导出 `extractTaskText`

#### Phase 2: 移除 iflow SDK 依赖
**删除文件（10个核心 + 3个 CLI）：**
- `src/agents/sdk/iflow-*.ts` (6个)
- `src/agents/chat/iflow-session-manager.ts`
- `src/agents/base/iflow-agent-base.ts`
- `src/agents/base/base-session-agent.ts`
- `src/agents/providers/iflow-provider.ts`
- `src/cli/iflow.ts`, `src/cli/index.ts`, `src/cli/loop-test.ts`

**package.json:** 移除 `@iflow-ai/iflow-cli-sdk`

#### Phase 3: 重构业务代码
保留业务逻辑，替换底层实现：
- `src/agents/agent.ts` → 基于 KernelAgentBase
- `src/agents/base/base-agent.ts` → 移除 IflowBaseAgent 继承
- `src/agents/chat/chat-agent.ts` → 使用 ChatCodexModule
- `src/agents/roles/*.ts` → 使用 ChatCodexModule
- `src/agents/router-chat/*.ts` → 使用 ChatCodexModule
- `src/agents/daemon/*.ts` → 使用 ChatCodexModule

### 成功标准
1. 构建成功，无 TypeScript 错误
2. `@iflow-ai/iflow-cli-sdk` 依赖已移除
3. system agent bootstrap 注入正常工作
4. role=system 的消息不被污染到历史记录

### 状态
- [x] 计划制定
- [ ] Phase 1: role=system 支持
- [ ] Phase 2: 移除 iflow SDK
- [ ] Phase 3: 重构业务代码
- [ ] Phase 4: 验证测试

## IFlow SDK 剥离完成 (2026-03-16)

### 完成内容
- ✅ 删除 `src/agents/sdk/image-test-real.ts`（唯一 iflow SDK 使用）
- ✅ 保留 iflow 兼容性枚举（`AgentImplementation.kind: 'iflow' | 'native'`）
- ✅ 所有业务逻辑完整保留（router/daemon/system-agent）
- ✅ Session 落盘实现（`src/orchestration/session-manager.ts`）
- ✅ System role=system 处理（`src/agents/chat-codex/chat-codex-module.ts`）
- ✅ `pnpm build` 通过（version 0.1.0119）

### 保留的 iflow 兼容层
- `src/blocks/agent-runtime-block/index.ts`: iflow 枚举保留
- `src/blocks/ai-block/index.ts`: sdk 枚举保留
- `src/blocks/agent-block/index.ts`: sdk 枚举保留
- `src/core/finger-paths.ts`: iflow-session-map.json 路径保留

### 关键实现
- **Session 落盘**: 792 行完整实现，支持 system/project session 分离
- **System role**: 跳过历史记录和 developer instructions
- **ChatCodexModule**: 作为唯一执行内核，替代 iflow SDK

### 验收标准
- [x] 构建通过
- [x] 无 iflow 运行时依赖
- [x] 业务逻辑保留
- [x] Session 落盘完整


## System Agent Bootstrap 实现 (2026-03-16 15:51)

### 完成内容
- ✅ `SystemAgentManager.injectSystemBootstrap()` - 启动时注入 bootstrap prompt
- ✅ 读取 `~/.finger/system/BOOTSTRAP.md` 并发送给 system agent
- ✅ `metadata.role = 'system'` 标记系统注入消息
- ✅ ChatCodexModule 正确处理 role=system（跳过历史/developer instructions）
- ✅ Session 落盘支持 system session���`~/.finger/system/sessions/`）
- ✅ 测试覆盖：12 tests passed

### 测试文件
- `tests/unit/system-agent/system-agent-static.test.ts` (5 tests)
- `tests/integration/system-agent-bootstrap.test.ts` (3 tests)
- `tests/integration/system-agent-role-system.test.ts` (4 tests)

### Git 提交记录
- 8cb2cfe "feat: add system agent bootstrap injection on daemon start"
- 3bbcc8a "chore: remove iflow SDK dependency, complete ChatCodexModule migration"


## IFlow SDK 剥离完成 - 最终验证状态 (2026-03-16 15:54)

### 完成内容汇总
- ✅ 删除 iflow SDK 依赖（唯一使用文件 `image-test-real.ts`）
- ✅ 保留 iflow 兼容性枚举（向后兼容）
- ✅ 业务逻辑完整保留（router/daemon/system-agent）
- ✅ Session 落盘实现（792 行完整实现）
- ✅ System role=system 处理实现
- ✅ System Agent Bootstrap 注入实现
- ✅ 构建通过（version 0.1.0120）
- ✅ 单元测试通过（16 tests）

### Git 提交链
- 6aca7c8 "test: add integration tests for dual daemon and session persistence"
- 8cb2cfe "feat: add system agent bootstrap injection on daemon start"
- 3bbcc8a "chore: remove iflow SDK dependency, complete ChatCodexModule migration"
- 4fc70f5 "Remove @iflow-ai/iflow-cli-sdk dependency from package.json"
- 6654d09 "Remove iflow SDK dependency and add role=system support"

### 测试覆盖
- ✅ `tests/unit/system-agent/system-agent-static.test.ts` (5 tests)
- ✅ `tests/integration/system-agent-bootstrap.test.ts` (3 tests)
- ✅ `tests/integration/system-agent-role-system.test.ts` (4 tests)
- ✅ `tests/integration/dual-daemon-heartbeat.test.ts` (5 tests)
- ✅ `tests/integration/session-manager-persistence.test.ts` (4 tests)

### 待验证（需要实际运行 daemon）
- [ ] Daemon 启动后 system session 落盘文件包含 bootstrap 消息
- [ ] System Agent 实际响应 bootstrap 提示词并产生回复
- [ ] Project agent 定时心跳检查工作正常
- [ ] Dual daemon 互相心跳检测和重启机制工作

---

## 权限管理设计 (2026-03-21)

### 核心概念
这是**权限管理**，不是"授权模式"。权限管理有几个层面的意义：

### 三种权限模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| **最低执行权限** | 每个工具执行前都需要用户授权，授权后加入白名单 | 高安全场景 |
| **最高授权模式** | 所有命令默认可执行 | 完全信任场景 |
| **默认模式** | 白名单执行，黑名单拒绝，高危命令需要用户授权 | 普通场景 |

### 高危命令定义
- `rm -rf` 及其变体
- `git checkout` (可能丢失未提交更改)
- `git reset --hard` (丢失更改)
- `file.delete`
- 其他可能造成不可逆损失的操作

### 关键设计原则

1. **拒绝后必须返回结果给模型**
   - 不能静默失败
   - 提供工具让用户决定是否授权
   - 避免死循环

2. **QQBot 渠道特殊处理**
   - 默认走"默认模式"
   - 需要授权的工具：发送授权指令 `<##auth:xxxx##>` 给用户
   - 用户复制后回复，解析后授权继续执行
   - 发送时状态为 `pending`，等待授权

3. **权限绑定到渠道/会话，而非 agent**
   - 权限模式是渠道级别的配置
   - 同一渠道的所有 agent 共享权限配置

### 实现顺序（重要）
```
授权工具 → 配置 → 连线
```
1. **授权工具**：先实现让用户可以授权/拒绝的工具
2. **配置**：权限模式配置（白名单/黑名单/高危命令列表）
3. **连线**：把整个流程串联起来

### 当前代码问题
- `authorizationMode: auto/prompt/deny` 设计偏离正确方向
- 应重命名为 `permissionMode: minimal/default/full`
- 不应该绑定到 agent，应该绑定到渠道
- 不应该静默失败
- 缺少授权工具

Tags: permission, authorization, security, qqbot, design

### 2026-03-21 补充
- 拒绝颗粒度对齐 Codex 的 RejectConfig 设计。
- 需要支持 sandbox_approval / rules / skill_approval / request_permissions / mcp_elicitations 级别的细粒度拒绝。
- 拒绝后必须返回结果给模型继续推理，不能静默失败。

Tags: permission, reject-config, codex-alignment

## [design] Mailbox + 心跳任务优先级与三段式包裹
**时间**: 2026-03-22 21:46 +08:00

**规则**:
1. 用户输入 (最高优先级) → [User] 信封
2. dispatch 异步结果 → [System][DispatchResult] 信封 (mailbox)
3. 子 agent 报告 → [System][AgentReport] 信封 (mailbox)
4. 心跳任务 (最低优先级) → [System][Heartbeat] 信封 (mailbox)

**三段式格式**:
[Type][Category] Title

**Short Description**: …
**Full Text**:
- 目标 / 停止条件
- 执行步骤
- 期望回复方式

**心跳任务约束**:
- 间隔最大 5 分钟
- agent 忙碌时跳过
- 支持 heartbeat.enable / heartbeat.disable 工具
- 可停止标记: HEARTBEAT.md 头部 `heartbeat: off`

## Daemon Lifecycle Management
- [2026-03-23] Daemon 生命周期管理实现：
  1. **HeartbeatBroker**（UDP广播）：daemon 启动时在 9998 端口广播心跳，每 30s 一次，子进程通过监听此端口判断 daemon 存活
  2. **子进程清理**：daemon 优雅关闭时（SIGTERM/SIGINT），先 kill 所有 finger-kernel-bridge-bin 子进程，再 close server
  3. **启动脚本** `scripts/start-daemon.sh`：包含孤儿清理（只杀 ppid=1 的进程）、单实例保证、健康检查（检查 PID 存活 + 9999 端口监听）、PID 文件写入
  4. **Blocking API 修复**：`Promise.race` 中放入 `log.info()` 返回 undefined 导致所有 blocking 请求返回 "No result returned from module"，已移除
  Tags: daemon, lifecycle, heartbeat, child-process, startup

- [2026-03-23] QQBot 消息完整链路：QQBot WebSocket → openclaw-qqbot plugin → channel.reply → bridge.callbacks_.onMessage → hub.send(channel.qqbot) → MessageHub route → channel-bridge-hub-route → dispatch → kernel bridge → event-forwarding → broadcast → ChannelBridgeOutput → sendText 回 QQBot
  Tags: qqbot, message-routing, channel-bridge, event-forwarding

- [2026-03-23] 非阻塞 vs 阻塞 dispatch：非阻塞 dispatch（void sendToModule.then）走 AgentRuntimeBlock，结果通过 EventBus 回来；阻塞 dispatch（await sendToModule）走 message route 的 Promise.race，直接等结果。两者都能正常工作但走不同的代码路径。
  Tags: dispatch, blocking, non-blocking, agent-runtime

- [2026-03-23] 新增 repo-local skill `.opencode/skills/context-ledger-memory`，把 `context_ledger.memory` 的 index/search/query(detail) 三段式、slot 输出约定、返回结构与示例固化为可复用说明。  
  Tags: skill, context-ledger, slot, search, query

- [2026-03-23] Mailbox 工具补完单条删除与批量清理：`mailbox.remove` / `mailbox.remove_all` / `mailbox.read_all` 都已进入 runtime tool list 与 `finger-system-agent` / `finger-project-agent` / `finger-reviewer` 白名单；notification 维持 idle-only 读取规则，单条已消费消息可 `mailbox.remove(id)`，批量通知清理可 `mailbox.remove_all(...)`。为通过 500 行门禁，internal 删除工具拆分到 `src/tools/internal/mailbox-tool-remove.ts`。已验证 `pnpm build`、`npm install -g .`、`npm run daemon:restart`、`/health`、`/api/v1/tools`、三类 agent policy，以及 live `mailbox.remove`（证据：`~/.finger/logs/mailbox-remove-live-1774263379.json`）。
  Tags: mailbox, mailbox-remove, mailbox-read-all, mailbox-remove-all, build, daemon, live-verify

 - [2026-03-23] **图片协议验证**：Responses API + `input_image` + `data:image/png;base64,...` 格式正确。`ali-coding-plan.kimi-k2.5` 支持 vision（单轮/多轮均通过）。`ali-coding-plan.glm-5` 不支持 vision。默认任务路由需配置到支持图片的模型。
   Tags: vision, image, responses-api, base64

 - [2026-03-23] **finger-256.1 完成**：统一 Attachment 类型定义（`src/bridges/types.ts`），扩展 `ChannelAttachment` 字段（mimeType, width, height, thumbnailUrl, source, metadata），历史消息 attachments 用 `{ count, summary }` 占位符替换（`src/runtime/ledger-reader.ts`），`OpenClawBridgeAdapter.sendMessage` 支持 sendMedia 路由。
   Tags: attachment, channel-attachment, ledger, vision, finger-256

 - [2026-03-23] **Channel 路由配置**：`~/.finger/config/channel-contexts.json` 存储每个 channel 的当前 agent 目标。默认应路由到 `finger-system-agent`，由 System Agent 决定是否派发到 Project Agent。如果路由到未部署的 agent 会出现 "Deployment not found"。
   Tags: channel-context, routing, system-agent, project-agent

- [2026-03-23] **Ledger 原始数据原则（Jason 强调）**：凡是进入 ledger 的数据都不能截断。显示给用户可以用 summary/preview，但 ledger 必须保存完整原始数据（raw payload）。尤其是结构化返回（JSON）必须完整落盘，防止记忆现场丢失。Session 重建依赖 ledger，因此原始数据完整性是硬约束。
  Tags: ledger, ssot, raw-payload, no-truncate, session-rebuild

- [2026-03-24] **Context Builder 动态上下文构建**：从 Ledger 读取历史 → 按任务边界分组 → 24h 时间窗口粗筛 → 大模型排序 → 预算截断 → 展平消息列表。只改变 history 部分，不影响 skills/mailbox/AGENTS.md 等 context slots。配置在 `~/.finger/config/user-settings.json` 的 `contextBuilder` 字段。支持 `enableModelRanking: true | 'dryrun' | false`，排序模型通过 `rankingProviderId` 引用 `aiProviders` 配置，不硬编码。排序原则：内容相关性（首要）+ 时间相关性（次要），最终排序为 高相关(时间倒序) → 中相关(时间倒序) → 低相关(时间倒序)。设计文档：`docs/design/context-builder-design.md`。
  Tags: context-builder, ledger, ranking, dryrun, user-settings, history

- [2026-03-24] **Context Builder UI Monitor**：`ui/src/components/ContextMonitor/` 组件，集成在 WorkflowContainer 2x2 grid 右下角。左侧显示 Context Rounds（可折叠），右侧显示 Ledger Events 对比面板，底部显示详情。API: `/api/v1/sessions/:sessionId/context-monitor`。
  Tags: context-monitor, ui, context-builder
