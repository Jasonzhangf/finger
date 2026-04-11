## [task] Tag-Aware Context Builder Enhancement {#mem-tag-aware-cb-20260326}
时间: 2026-03-26 08:30
状态: completed

### 架构简化
用户提出：既然已打 tag，无需拆分 session。直接在 ledger 层按 tag 聚合 + 大模型排序��好。

### 变更内容

1. **TaskBlock tags/topic 提取** (`src/runtime/context-builder.ts`)
   - `finalizeBlock` 从 assistant 消息的 metadata 中提取 tags/topic
   - TaskBlock 类型新增 `tags?: string[]` + `topic?: string`

2. **三重维度排序 prompt** (`src/runtime/context-builder.ts`)
   - 原来只有内容相关性 + 时间（双重维度）
   - 新增标签匹配作为最高优先级维度
   - 排序原则：标签匹配 > 内容相关性 > 时间接近度
   - 判断标准新增：tag/topic 匹配优先级

3. **Block preview 包含 tags** (`src/runtime/context-builder.ts`)
   - 排序候选预览中显示 `标签: xxx` 和 `主题: xxx`

4. **移除 tag 长度限制** (`src/common/agent-dispatch.ts`)
   - `normalizeStringArray` 不再限制 tag 字符串 <= 50 字符
   - 仅过滤空值和纯空白

5. **设计文档更新** (`docs/design/SESSION_CLASSIFICATION_CONTEXT_BUILDER_EPIC.md`)
   - 简化为 tag-aggregated 方案（无 session switch）
   - 完整记录数据流和设计决策

### Epic
关联: finger-261
子任务: finger-261.3 — tag-aware context builder ✅

## [task] Context digest-first rebuild + ranking fallback + progress readability {#mem-context-digest-fallback-20260330}
时间: 2026-03-30 22:31
状态: completed

### 用户要求（Jason）
1. 进度更新中 `update_plan` 需展示完整计划清单；
2. `dispatch` 需展示派发任务身份与内容；
3. `write_stdin` 需展示实际写入内容；
4. context rebuild 优先使用 compact digest 历史；
5. context builder 专用排序模型不可用时，不中断，降级到 digest 历史继续执行。

### 关键实现
1. **Progress 可读性增强**
   - `src/server/modules/progress-monitor-reporting.ts`
   - `src/server/modules/progress-monitor-reporting-helpers.ts`
   - `tests/unit/server/progress-monitor-reporting.test.ts`
   - `update_plan` 全量项输出、`dispatch` 输出 task/name/content、`write_stdin` 输出 stdin 内容。

2. **压缩产出 replacement_history（digest）**
   - `src/runtime/runtime-facade.ts`
   - `compressContext()` 在 compact 写入时附带 task-level `replacement_history`（request/summary/key_tools/key_reads/key_writes）。

3. **Rebuild 优先 compact history**
   - `src/runtime/context-builder.ts`
   - `src/runtime/context-builder-types.ts`
   - 若存在 `compact-memory.replacement_history`，historical_memory 优先使用 compact digest；working_set 仍保留 live task。

4. **排序模型不可用降级**
   - `src/runtime/context-builder.ts`
   - `enableModelRanking=active` 且 provider 不可用时，historical_memory 自动降级为 digest blocks，继续执行；
   - metadata 标记 `rankingReason=digest_fallback:<reason>`。

5. **测试验证**
   - `tests/unit/runtime/context-builder.test.ts` 新增 ranking fallback 场景；
   - TypeScript 编译 + 单测通过。

## [task] Task-End Tagging Pipeline (session classification 基础) {#mem-tags-pipeline-20260326}
时间: 2026-03-26 08:00
状态: completed

### 变更内容

1. **DispatchSummaryResult 新增 tags/topic 字段** (`src/common/agent-dispatch.ts`)
   - `tags?: string[]` — 动态多标签，从 raw.tags / response.tags / topic 合并去重
   - `topic?: string` — 粗路由主题提示
   - `normalizeStringArray()` / `coalesceTags()` 辅助函数
   - `DispatchEvidenceItem.tags` 也支持透传

2. **Ledger metadata 持久化 tags** (`src/server/modules/agent-runtime/dispatch.ts`)
   - dispatch 结果写入 session 时，ledgerMetadata 附带 tags + topic

3. **Mailbox envelope 包含 tags** (`src/server/modules/mailbox-envelope.ts` + `event-forwarding.ts`)
   - `buildDispatchResultEnvelope()` 新增可选 tags/topic 参数
   - shortDescription 附加 `[topic]` 后缀
   - fullText 附加 **Tags** / **Topic** 段
   - event-forwarding 通过 `extractDispatchResultTags/Topic` 从 payload.result 提取

4. **测试覆盖**
   - `tests/modules/agent-dispatch-tags.test.ts` — 12 ��用例覆盖全部 tags 提取场景
   - 原有 `agent-dispatch-sanitize.test.ts` / `mailbox-envelope.test.ts` / `dispatch-task-to-agent.test.ts` 全部通过

### Epic
关联: finger-261 (SESSION_CLASSIFICATION_CONTEXT_BUILDER_EPIC)
子任务: finger-261.2 — task-end tagging pipeline ✅

# MEMORY.md

## General Memory
- [2026-03-14] 长期记忆仅写入本文件；短期记忆写入 `CACHE.md`，review 通过后汇总写入本文件并清空 `CACHE.md`（保留头部）。
  Tags: memory, cache, review
- [2026-03-25] Jason 明确：Finger 项目的 Skills 目录唯一真源是 `~/.finger/skills`；不要写到 `~/.openclaw/skills`、`~/.codex/skills` 或仓库内临时 `skills/` 目录。
  Tags: skills, finger, ssot, directory
- [2026-04-04] Jason 新增强约束：默认禁止“先回退再说”的处理方式。出现错误时优先做根因诊断与正向修复；回退仅在用户明确授权时作为例外。
  Tags: rollback, root-cause-fix, execution-policy, no-rollback-default

## Architecture & Runtime
- [2026-03-11] 三层架构：blocks（唯一真源）/ orchestration（编排）/ ui（展示），保持层间解耦。
  Tags: architecture, blocks, orchestration, ui
- [2026-03-28] Jason 明确要求：每次编译都必须自动 bump 一个可读 build 版本（当前用 `package.json.fingerBuildVersion`，格式如 `0.1.0001`），并且每次交付安装后都必须明确重启 daemon 并校验 `/health`；不能靠人工口头确认“应该已经重启”。
  Tags: build-version, daemon, release, automation, runtime
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
- [2026-04-05] Jason 明确新的会话记忆原则：Session 等同于 worker 的活跃记忆，ownership 必须绑定到 worker（`memoryOwnerWorkerId`）；scope 仅用于可见性筛选，不可作为 ownership 迁移机制。允许跨 agent 只读共享，但禁止跨 worker 写入/执行。reviewer 为无历史特例，每次按当前 CWD 使用干净审查上下文。旧 session 数据需启动时自动迁移补齐 ownership 字段并持久化。
  Tags: session, memory, worker-ownership, scope, reviewer-stateless, migration
- [2026-03-29] Jason 新增约束：`mailbox/news-cron/email-cron/clock/systemDirectInject` 等后台推理链路默认写入 **transient ledger**（非 main ledger）；当该轮 `finishReason=stop` 成功闭环时自动删除对应 transient ledger，未完成/失败必须保留以便恢复与排查。实现上通过 `SessionManager.setTransientLedgerMode()/finalizeTransientLedgerMode()` 与 message/dispatch 路由的 source 策略联动。
  Tags: transient-ledger, mailbox, news-cron, recovery, session-manager
- [2026-03-29] Jason 确认 reviewer gate 必须可配置：`orchestration.reviewPolicy.dispatchReviewMode` 支持 `off|always`（默认 `off`），仅在 `enabled=true && dispatchReviewMode=always` 时，对 `system -> project` 完成态自动派发 reviewer；review 不通过可按 attempt 回传重派 project。
  Tags: reviewer-gate, dispatch-review-mode, orchestration-config, optional
- [2026-03-28] Jason 明确新增硬约束：Context Builder 的最小历史单位必须是“完整 task block”，禁止 task 内编辑。也就是每个被选中的 task 必须保留从 `role=user` 到该轮结束（含 assistant/tool_call/tool_result/tool_error/reasoning，直到 `finish_reason=stop`）的完整链路；允许做的只有 task 级别选择/重排/整块剔除，禁止在 task 内删消息、改顺序或用摘要片段替代事件链。该规则已同步到 `docs/design/context-builder-design.md`。
  Tags: context-builder, task-granularity, history, invariant, ledger
- [2026-03-28] Jason 确认当前 System Agent 收敛策略采用两阶段路线：**第一阶段先靠 prompt 约束收敛行为**（长时自运行、停止前复盘目标、伪完成转真完成、真完成后再看 heartbeat）；若后续实测 prompt 约束仍不稳定，则进入 **第二阶段 reviewer gate**：在 `finish_reason=stop` 时强制走 reviewer/审查环节，未通过则直接打回进入下一轮继续执行，而不是把 stop 视为最终完成。
  Tags: system-agent, prompt, reviewer-gate, stop-review, closure, roadmap
- [2026-03-28] Jason 明确收敛 System Agent/heartbeat 启动顺序：**先收上一轮任务，再处理 heartbeat**。具体规则：daemon/heartbeat 启动后先检查上一轮执行状态；若上一轮未到 `finish_reason=stop`，必须直接从中断处继续；若已 `stop`，也必须先审查是否只是“伪完成”，若未真正完成则继续执行直到真完成；只有上一轮任务真正闭环后，才允许查看/处理 heartbeat 文件。System prompt / developer prompt / `SystemAgentManager` 启动恢复逻辑已同步到该规则。
  Tags: system-agent, heartbeat, recovery, stop-review, startup-order, closure
- [2026-03-28] Daemon 守护链路进一步收敛：`daemon-restart/guard/stop/cleanup` 脚本已统一改为读取 `FINGER_HOME`（默认 `~/.finger`）下的 `runtime/logs`，不再错误使用仓库内 `.finger/runtime`。同时 `port-guard.ensureSingleInstance()` 改为“只回收 finger 自己的占口进程”：先用 `lsof + ps` 校验 cmdline 命中当前 `FINGER_SOURCE_ROOT` 的 `dist/server/index.js / dist/daemon/dual-daemon / daemon-guard.cjs`，再按显式 PID 树发送 `SIGTERM -> SIGKILL`；若端口被无关进程占用则直接报错，不误杀。`src/orchestration/daemon.ts` 也已切到复用这套安全守卫，不再保留旧的按端口直接 kill 逻辑。
  Tags: daemon, self-heal, single-instance, runtime-hygiene, port-guard, ssot
- [2026-03-28] `finger-263.2` 阶段性收敛：执行生命周期现在不只记录 `stage/substage`，还会透传结构化恢复字段 `timeoutMs / retryDelayMs / recoveryAction / delivery`。本轮已把这些字段从 `message-route` 的 blocking timeout/retry、`dispatch.ts` 的 execute-throw/result-failed/auto-deploy retry、`queued_mailbox` fallback、以及 `event-forwarding` 的 `turn_retry/turn_error` 全链路写入 `executionLifecycle`。另外修复了 `message-route` blocking `Promise.race` 的 timeout timer 未清理问题，避免旧 timer 在后续轮次里残留触发。
  Tags: execution-lifecycle, watchdog, retry, timeout, mailbox, dispatch, pending-input
- [2026-03-28] Jason 明确要求：内部工具必须统一分为两类——`state`（结构化真源/状态工具，必须进程内直连，禁止依赖 CLI stdout 解析）与 `execution`（命令/PTTY/外部执行器，可使用 subprocess）。已将 `context_ledger.memory` 从 CLI/stdout 协议改为直接调用 `executeContextLedgerMemory(...)`，并新增 `docs/design/internal-tool-execution-model.md` 作为规则说明。
  Tags: internal-tools, ledger, state-tool, execution-tool, ssot
- [2026-03-26] Jason 确认切换语义：`<##@agent##>` / `<##@agent:alias##>` / `<##@system##>` 采用**持久化 channel context**，未显式切换就保持当前目标；默认使用 latest（固定续写）而不是自动 `new`。`<##...##>` 是唯一有效切换语法（不使用 `<**...**>`）。
  Tags: channel-context, super-command, agent-switch, latest-session, ledger
- [2026-03-24] 约束更新（Jason 明确）：旧的 `new / resume / session` 语义是基于旧 session 文件模型；新架构中这些操作必须以 **ledger 为唯一真源** 解释与实现。UI 的会话切换/新建/恢复都要对应 ledger（持久化），动态 session 只是按 ledger slots 拼接的上下文视图。
  Tags: session, ledger, ssot, ui
- [2026-03-25] Jason 明确补充：要对齐 codex 的模型可见性。`ledger` 只负责重建历史消息；`system prompt / developer instructions / skills / mailbox baseline / user input` 必须稳定注入，不得因 context builder 重建历史而丢失。`system agent` 与 `project agent` 各自维护独立 session/ledger；派发与回报要写入各自 ledger 流水。
  Tags: session, ledger, codex-alignment, prompt-injection, mailbox, user-input
- [2026-03-26] ChatCodex reasoning 实时推送修复：`src/agents/chat-codex/chat-codex-module.ts` 不再只在 `task_complete.metadata_json.reasoning_trace` 阶段补发 reasoning，而是在 streaming `model_round` 等 kernel event 携带 `metadata_json.reasoning_trace` 时立即抽取并转成 `kernel_event(type=reasoning)`；同一 turn 内按 `agentId + roleProfile + index + text` 去重，避免结尾重复批量推送。相关验证已覆盖 `tests/unit/agents/chat-codex-module.test.ts`，并联通 `event-forwarding` / `agent-status-subscriber` 定向测试。
  Tags: reasoning, streaming, chat-codex, event-forwarding, progress-update
- [2026-03-26] Jason 明确要求 ledger/context builder 必须开始使用 embedding recall，而不是只靠 tags/topic 的精确或 fuzzy 文本匹配。已在 `src/runtime/context-builder.ts` 前置接入 session-local hybrid recall：对历史 task block 建立 `task-embedding-index.json`（保存在 ledger 目录），embedding 文本由 `tags + topic + 首条 user + 最后一条 assistant` 组成；当前 prompt 先做语义召回，再进入 build mode / 可选模型 rerank。当前 task 不参与历史重排，始终保留在尾部。
  Tags: ledger, context-builder, embedding, hybrid-recall, tag-recall
- [2026-03-26] Jason 提出新的长期收敛方向：废弃“session 文件=持久化会话真源”的概念，收敛到 **Ledger-only persistence + dynamic session views**。新的上下文结构应明确拆分为：`本轮推理区(working set)` 与 `历史记忆区(history memory zone)`；超出预算的历史不再强行注入，而是通过 `context_ledger.memory search/query` 按需检索。该方向已落盘设计文档 `docs/design/ledger-only-dynamic-session-views.md`，并要求后续提示词明确告诉模型：当前上下文不是完整历史，证据不足时必须主动检索 ledger。
  Tags: ledger, session, dynamic-view, context-builder, prompt, history-zone
- [2026-03-26] `finger-262.3` 已实现第一步：context builder 显式区分 `working_set` 与 `historical_memory`。当前 task block 不再参与历史 recall 竞争，始终保留在尾部；`buildContext()` 的 messages 会标记 `contextZone`，metadata 追加 `workingSetTaskBlockCount / historicalTaskBlockCount / workingSetMessageCount / historicalMessageCount / workingSetTokens / historicalTokens`。Context Monitor / session view 映射链路已透出这些分区信息，验证通过：context-builder 定向测试 + TypeScript 编译。
  Tags: context-builder, working-set, history-zone, ledger, observability
- [2026-03-28] Context Builder 连续性修复：新增 `contextBuilderHistoryIndex` 持久化索引（history/current/pinned/anchor），并在 `finger-role-modules` 中改为“先走 persisted indexed history，再按需 bootstrap”，避免重启后每次首轮都重建导致历史顺序反复抖动。`chat-codex-module` 同步加保护：当 `contextHistorySource=context_builder_*` 时，不再优先使用 `metadata.kernelApiHistory` 覆盖 builder 结果。新增测试 `tests/unit/server/context-builder-history-index.test.ts`。
  Tags: context-builder, indexed-history, bootstrap, kernelApiHistory, ledger
- [2026-03-28] QQ/Weixin 重复回复修复：根因是 direct send (`[HH:mm] ...`) 与 bodyUpdates (`正文：...`) 存在并发竞态，body 已在发送中但去重标记尚未落盘，导致两路都发。修复：`AgentStatusSubscriber.sendBodyUpdate` 在实际 IO 前预写 route/session 去重标记；`channel-bridge-hub-route.sendReply` 在发送前先 `markFinalReplySent`，发送失败再 `clearFinalReplySent` 回滚。新增单测覆盖失败回滚。
  Tags: channel, qqbot, dedup, bodyUpdates, direct-reply, race
- [2026-03-26] `finger-262.2` 已完成：prompt 层正式教会模型“当前上下文不是完整历史”。`src/agents/chat-codex/prompt.md`、`coding-cli-system-prompt.ts`、各角色 developer prompt、`skill-prompt-injector.ts` 与 `context_ledger.memory` 工具描述都已统一强调：`working_set` / `historical_memory` 只是 budgeted dynamic view，缺失历史证据时必须先 `context_ledger.memory search`，再 `query(detail=true, slot_start, slot_end)`，不能把 prompt 中缺失当成历史不存在。
  Tags: ledger, prompt, dynamic-view, context-builder, skills, tool-contract
- [2026-03-26] `finger-262.1` 已完成：`context_ledger.memory` 现在会把 search 结果提升到 **overflow-history retrieval path**。除了原有 compact hits / slot summaries 外，`search` 会返回 task-block candidates（含 `start_slot/end_slot`、`detail_query_hint`、`match_reason`、`visibility`），并附带 `context_bridge` 明确说明本次检索扫描的是 full ledger、结果可能位于当前 prompt budget 之外。内部 tool wrapper 还会自动补齐 `session_id / agent_id` 到 `_runtime_context`，减少模型手填作用域参数。
  Tags: ledger, overflow-history, context-ledger, task-blocks, retrieval, runtime-context
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

- [2026-04-07] **关键认知修正**：compact 和 context rebuild 是同一操作的不同阶段，不是两件事。
  - ❌ 错误理解：先 compact（压缩），再想办法触发 rebuild（重建）
  - ✅ 正确理解：compact 的目的就是为了 rebuild context，它们是一个原子操作
  - compact：将 currentHistory 压缩成 digest，写入 compact-memory.jsonl
  - rebuild：基于新指针（contextHistory + currentHistory）重建上下文窗口
  - **必须在同一函数内完成**，确保 Kernel 拿到重建后的上下文
  Tags: compact, rebuild, context, cognitive-correction

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
- [2026-03-24] Context Builder 三模式与 dryrun 规范落地：`contextBuilder.mode` 支持 `minimal|moderate|aggressive`；`enableModelRanking` 支持 `false|true|'dryrun'`。moderate 以 task 为最小颗粒，补充历史时允许“单个 task 超过移除量但总预算内仍补入”；current task 必须保持尾部。UI Settings 新增 mode/ranking 选择并持久化到 `~/.finger/config/user-settings.json`；后端新增 `/api/v1/context-builder/settings` GET/PUT。
  Tags: context-builder, mode, dryrun, moderate, ui-settings, user-settings, api
- [2026-03-24] Context Monitor 调整为“只观测”面板：移除面板内 CB 开关/模式下拉/ranking 下拉（避免和 Settings 双入口冲突），配置入口统一在 LeftSidebar → Settings。Context Monitor 仅展示 build 元数据（mode/ranking/history-only）与 round 对照；通过 websocket 订阅触发刷新。
  Tags: context-monitor, ui, observer-only, settings, context-builder
- [2026-03-25] Context Monitor 新增“展开大视图”能力：小卡片右上角 `展开` 按钮可打开全屏 overlay，完整显示 Round 列表 / Selected Context / Ledger 对照 / 详情四区；支持遮罩点击与 `Esc` 关闭。该能力只影响 UI 展示层，不改变 context builder 逻辑与数据源。
  Tags: context-monitor, ui, modal, overlay, esc, observability
- [2026-03-25] 修复 UI 实时刷新滞后：Ledger/Context Monitor 的 WS 触发类型补齐 `chat_codex_turn`、`user_message`、`tool_call`、`messageCreated/messageCompleted`；并放宽会话相关性判断（无 session hints 的全局事件也允许触发刷新）。同时 `useWorkflowExecution` 将 `chat_codex_turn/assistant_complete/session_changed/session_compressed` 纳入消息刷新触发，避免“必须手动刷新页面才看到新事件”。
  Tags: websocket, live-update, ledger-monitor, context-monitor, workflow-execution, session

- [2026-03-25] 修复渠道消息重复推送：删除 `AgentStatusSubscriber.isVerboseTextChannel()` 硬编码绕过（之前 qqbot/openclaw-weixin 无条件绕过 pushSettings），所有渠道严格遵循 `channels.json` 的 `pushSettings` 配置（唯一真源）。`sendBodyUpdate()` 新增去重：相同 sessionId + 相同内容不重复推送；新增 `markFinalReplySent()` 记录主回复链路发送时间，`sendBodyUpdate` 在 10s 内检测到相同归一化内容则跳过。`channel-bridge-hub-route.ts` 的 `sendReply()` 成功后调用 `markFinalReplySent()` 联动去重。commit: c6d549c, 636f7ac。
  Tags: channel-dedup, pushSettings, isVerboseTextChannel, body-update, markFinalReplySent, agent-status-subscriber

- [2026-03-25] Ledger delete_slots 安全机制落地：`context_ledger.memory` 新增 `delete_slots` action，支持 `preview_only`/`confirm`/`user_authorized`/`user_confirmation`(intent-scoped phrase)/`intent_id`/`reason`。preview 返回 slot 摘要（time/event_type/preview），real delete 写入 `ledger_slots_deleted` 审计事件。确认短语格式 `CONFIRM_DELETE_SLOTS:<intent_id>:<slot_csv>`，防止对话漂移导致误删。`context_compact` 类型 slot 受保护不可删除。Skill 文档 `~/.finger/skills/context-ledger-memory/SKILL.md` 更新交互式删除工作流。
  Tags: ledger, delete-slots, safety, intent-scoped, confirmation, audit

- [2026-03-25] 修复 context builder session miss： 调用  时改用外部/响应 sessionId（），不再强制用内部 memory session id，避免  在  查询不到导致持续 fallback。新增单测断言 provider 接收外部 sessionId（）。并落盘设计文档 ，定义 task 粒度 summary+多 tag、保守续接、topic 切换时按 tag 置信度+时间选择 session、无匹配新建 session。bd Epic: ，子任务  已完成。
  Tags: context-builder, session-id, external-session-binding, task-tagging, session-switch, epic


- [2026-03-25] 修复 context builder session miss：`KernelAgentBase` 调用 `contextHistoryProvider` 时改用外部/响应 sessionId（`responseSessionId || input.sessionId || session.id`），不再强制用内部 memory session id，避免 `finger-role-modules` 在 `runtime.getSession(sessionId)` 查询不到导致持续 fallback。新增单测断言 provider 接收外部 sessionId（`ui-session-context-meta-1`）。并落盘设计文档 `docs/design/SESSION_CLASSIFICATION_CONTEXT_BUILDER_EPIC.md`，定义 task 粒度 summary+多 tag、保守续接、topic 切换时按 tag 置信度+时间选择 session、无匹配新建 session。bd Epic: `finger-261`，子任务 `finger-261.1` 已完成。
  Tags: context-builder, session-id, external-session-binding, task-tagging, session-switch, epic

- [2026-03-26] **finger-262.4（ledger-only session 收口）**：Session 文件彻底去真源化（加载/保存统一 `messages=[]`），`SessionManager` 读历史与计数统一改走 ledger；`updateMessage/deleteMessage` 在 ledger-only append-only 模式下禁用。`session.ts`、`messagehub-command-handler.ts`、`ledger-routes.ts` 移除 `session.messages` 与 `metadata.messages` 计数依赖，统一使用 ledger snapshot；`finger-role-modules` 的 context builder 历史源改为 `runtime.getMessages(sessionId, 0)`，并补齐附件媒体检测。验证：`pnpm -s tsc --noEmit` + 5 个关键回归测试通过。
  Tags: ledger-only, session, session-manager, context-builder, messagehub, routes, finger-262

- [2026-03-26] Context Builder 预算策略调整：历史重建改为固定 token 预算 `contextBuilder.historyBudgetTokens`（默认 100000），按 task 粒度从高相关到低相关填充，不再按消息条数截断；`chat-codex` 的 `maxContextMessages` 设为 0（unlimited），由 token 预算控制实际输入。`MEMORY.md` 不再直接注入上下文，`includeMemoryMd` 兼容字段保留但运行时固定为 false。Context Monitor 增加预算截断可观测：`budgetTruncatedTasks`（含 task id/token/summary）。
  Tags: context-builder, token-budget, historyBudgetTokens, memory-ground-truth, context-monitor

## 2026-03-27 新闻推送Sender回调修复

### 问题
定时新闻推送脚本运行成功，但日志中反复出现错误：
```
Error: Module mailbox-cli not registered as input or output
```

### 根因
在`src/server/routes/message.ts`中，当`body.sender`存在时，会尝试调用`deps.hub.sendToModule(body.sender, ...)`发送回调。但是当sender是`mailbox-cli`时，它不是一个注册的模块，所以会报错。

### 修复
在message.ts的两处sender回调逻辑中添加了非模块sender检查：

1. **阻塞路径**（第372-393行）：添加`nonModuleSenders`列表，检查sender是否为非模块标识符
2. **非阻塞路径**（第442-453行）：同样添加检查

```typescript
const nonModuleSenders = ['mailbox-cli', 'cli', 'heartbeat', 'system'];
const isNonModuleSender = nonModuleSenders.includes(body.sender) || body.sender.startsWith('cli-');

if (!isNonModuleSender) {
  // 发送回调
}
```

### 验证
- 编译通过
- Daemon重启成功
- 手动运行新闻脚本后��日志中不再出现`Module mailbox-cli not registered as input or output`错误
- System agent正常处理mailbox消息（mailbox.list → mailbox.read → exec_command → mailbox.read → mailbox.ack）

### 文件变更
- `src/server/routes/message.ts`：添加非模块sender检查
- `src/server/modules/event-forwarding.ts`：注释掉未定义的`emitToolStepEventsFromLoopEvent`调用

### 待确认
- 新闻内容是否真正推送到用户的对话渠道（需要用户确认是否收到QQ消息）

## 2026-03-27 定时可靠性改造（对齐 OpenClaw 方案）

### 目标
把“定时触发可靠性”从外部 `sleep/at` 依赖，收敛到 Finger 进程内持久调度（OpenClaw 风格）：
`daemon 常驻 + 持久任务文件 + 启动补偿 + 调度防重入/防热循环`。

### 本次改动
1. `ClockTaskInjector` 重构为 **self-rearm setTimeout**（不再 setInterval 叠加）
   - 启动立即 `tick`（0ms）执行 missed catch-up。
   - 每轮 `finally` 重置下一轮定时，避免卡死后不再调度。
   - 自动按最近 `next_fire_at` 计算下一次 wake，空闲时按 poll 间隔巡检。
2. `ClockTaskInjector` 执行语义修复
   - repeat 定时按 `computeNextClockRunForTimer()` 正确推进下一次触发。
   - dispatch 失败不吞，记录错误并指数退避重试（30s 起，最高 30min）。
   - 写盘改为 `tmp + rename` 原子落盘，降低中断损坏风险。
3. `clockTool` 去副作用修复
   - 移除 `create/list/cancel/update` 里“读取即消费 due timer”逻辑。
   - `list` 不再提前把到期任务标记 completed，避免“定时未执行但被查询吞掉”。
4. `HeartbeatScheduler` 调度可靠性增强
   - 改为 one-shot rearm（避免重入）。
   - 增加运行态持久化：`~/.finger/schedules/heartbeat-runtime-state.json`。
   - 重启后恢复 `lastRun/lastMailboxPromptAt`，并在首轮立即调度。

### 验证
- `pnpm -s tsc --noEmit` ✅
- `pnpm -s vitest tests/unit/tools/internal/clock-integration.test.ts --run` ✅（9/9）

## 2026-03-29 Context Consumption Rule (User Confirmed)

- Jason clarified and confirmed a hard rule for runtime context behavior:
  - **Ledger is append-only storage/timeline, not the default consumption source for model turns.**
  - The model should consume the **built session view** as the runtime single source of truth.
  - Session history should continue to evolve in-place; writes are mirrored into ledger for storage/audit.
- Implementation adjustment in this round:
  - `finger-role-modules` context history provider now reads from runtime session snapshot instead of raw-ledger message replay.
  - Existing indexed continuity (`contextBuilderHistoryIndex`) remains active so rebuilt history + delta can continue across turns.
- Operational expectation:
  - New user input should not implicitly switch history source to raw ledger or cause abrupt context detachment.

## 2026-03-29 Session Snapshot Consumption Enforcement

- Runtime read path hardened to prefer **session snapshot (`session.messages`)** as the model-visible history source.
- `SessionManager.addMessage(...)` now performs write-through:
  1) append to ledger (storage/audit),
  2) append the same message to `session.messages` (runtime consumption truth).
- `SessionManager.getMessages(...)` and `getMessagesAsync(...)` now:
  - read from `session.messages` first,
  - only perform one-time compatibility hydration from ledger when snapshot is empty,
  - persist hydrated snapshot for subsequent turns (avoids repeated raw-ledger replay on runtime path).
- `getLatestUserPromptFromLedgerSync(...)` now checks session snapshot first to keep context-builder prompt alignment on the same runtime truth.
- Further tightened in strict mode:
  - removed runtime compatibility fallback that hydrated from ledger when `session.messages` is empty;
  - `getMessages()` / `getMessagesAsync()` now return snapshot-only data (or empty), no runtime ledger replay path.

- [2026-03-30] Jason 要求把 channel 链接自动下载能力收敛为“可配置触发骨架”：`channelAutoDetail.triggers[]` 统一通过 `match/input/command` 配置触发条件、输入文件模板和执行命令；`weibo/xiaohongshu` 仅作为 legacy fallback。并新增系统技能 `~/.finger/skills/channel-auto-trigger/SKILL.md`，后续配置修改走 skills 流程（含模板、校验、回滚步骤）。
  Tags: channel-auto-detail, triggers, config-skeleton, skills, qqbot, webauto
- [2026-03-30] Jason 追加要求：channel auto trigger 规则除输入模板外，还必须支持“输出目录”可配置。实现为 trigger 级 `output.outputRoot`（并支持 `${output_root}` 占位符注入命令参数）；当 trigger 未配置时回退全局 `channelAutoDetail.outputRoot`。
  Tags: channel-auto-trigger, output-root, trigger-config, placeholders
- [2026-03-30] Jason 确认 channel auto trigger 需要“每个触发器独立可配置输出目录”。已在 `~/.finger/config/config.json` 配置：`weibo-detail.output.outputRoot=~/.webauto/download-weibo`，`xhs-detail.output.outputRoot=~/.webauto/download-xhs`，命令参数统一使用 `${output_root}`。
  Tags: channel-auto-trigger, per-trigger-output, config

- [2026-03-30] Jason 新增 System Agent 派发前硬约束：面对用户开发任务，System Agent 必须先完整澄清需求并给出“执行合同包”（需求理解/详细开发需求/开发流程/测试流程/验证与交付清单/风险与疑问），得到用户完整确认后，先写入目标项目 `FLOW.md`，再派发给 project agent；禁止“未确认先派发”。
  Tags: system-agent, prompt, dispatch-gate, flow-md, requirement-clarification

- [2026-03-30] Jason 要求补充 ledger 使用规则：复杂任务默认先做 `context_ledger.memory search -> query(detail=true)` 检索，再决定是否 `context_builder.rebuild`；该规则需同时写入 ledger 说明文档与 context-ledger-memory skill，禁止“无证据先重建”。
  Tags: ledger, context-builder, rebuild-gate, skills, complex-task

## Control Hook Memory Patch
- idempotency_key: session-1775216411994-26x61fzi|turn-1775216804773|hook.project.memory.update
- updated_at: 2026-04-03T11:46:44.778Z
- source_session: session-1775216411994-26x61fzi
- source_turn: turn-1775216804773
- long_term: apply_patch context lines must match file exactly; use grep first

## [task] Session 管理唯一真源整顿 {#mem-session-single-source-20260409}
时间: 2026-04-09 23:45
状态: in_progress
关联: finger-285 (Epic)

### 问题诊断
用户发现上下文断裂、session 漂移、类型冲突问题，根源是 Session 管理散乱：

**4 个 Manager 实现**：
- `SessionManager` (orchestration/session-manager.ts, 2277行) — 真源实现（Ledger + Context Builder + 压缩）
- `MemorySessionManager` (agents/base/memory-session-manager.ts, ~120行) — 简化版，无 Ledger
- `ResumableSessionManager` (orchestration/resumable-session.ts, ~394行) — 可恢复 session
- `CodexExecSessionManager` (tools/internal/codex-exec-session-manager.ts) — codex exec 专用

**2 个 Session 类型冲突**：
- `chat/session-types.ts` — 旧版（无 projectPath、无 Ledger 指针）
- `orchestration/session-types.ts` — 新版（完整 Ledger 指针）

**类型引用散乱**：
- kernel-agent-base、memory-session-manager 用旧的 chat/session-types
- session-manager、message-preflight-compact、projects route 用新的 orchestration/session-types

### 整顿方案

**唯一真源**：
- **唯一 Session 类型**: `orchestration/session-types.ts`
- **唯一 ISessionManager 接口**: 从 `orchestration/session-types.ts` 导出
- **唯一 Manager 实现**: `SessionManager` (orchestration/session-manager.ts)

**要删除的**：
1. `src/agents/base/memory-session-manager.ts` — 功能被 SessionManager 覆盖
2. `src/agents/chat/session-types.ts` — 类型合并到 orchestration/session-types.ts
3. `src/orchestration/resumable-session.ts` — 功能合并到 SessionManager
4. `src/tools/internal/codex-exec-session-manager.ts` — 功能合并到 SessionManager
5. `runtime/runtime-facade.ts` 中的 ISessionManager — 合并到统一类型

**kernel-agent-base.ts 修复**：
- 改用 `orchestration/session-types.ts` 的 Session/SessionMessage
- 移除 MemorySessionManager 默认 fallback，改用统一 SessionManager
- `tryBuildContextBuilderHistory` 方法接入 Context Builder

### Session 设计原则（用户定义）

**Session 管理**：
1. 默认一个 project 就是一个 session，除非 `new`，否则就是原来的 session
2. Ledger 只有一个，按时间顺序管理
3. Session new 和 switch 都是一个 dynamic view
4. Heartbeat 和定时任务都是 stateless session（只有内存中存在，不做状态管理）
5. Heartbeat 任务需要 system/project agent assign，带所有必要参数

**多窗口问题**：
- 一个 project 下开两个窗口，各自独立 session + ledger track
- 基于 MemPalace 索引做合并
- Context rebuild 自动整合

**Reviewer 移除**：
- 移除 finger-reviewer-agent（只剩 system + project agent）
- System agent 用原 session 进行 review（复用 review thread）

### Epic 结构
- finger-285 (Epic): Session Manager Single Source 整顿
- finger-285.1: Phase 1 - 类型统一
- finger-285.2: Phase 2 - 移除冗余 Manager
- finger-285.3: Phase 3 - kernel-agent-base.ts 修复
- finger-285.4: Phase 4 - 清理与验证

---

## [task] Session 上下文与任务真源统一改造 (finger-288) {#mem-session-task-truth-20260411}
时间: 2026-04-11
状态: completed

### 用户核心诉求
1. **bd epic 为复杂任务唯一真源**，session context 是当前执行 epic 的只读视图
2. **update_plan 降级**为非持久化内部小进度，不参与恢复
3. **周期任务**用 periodicKey 做唯一键，触发时替换上一次未完成的任务
4. **Task Mode**：非阻塞 in_progress 任务不允许停止推理

### 根因分析
- session 恢复依赖 `projectTaskState` 字符串而非 bd 状态 → ghost session 风暴
- 多 session 目录污染 → 重启时加载到错误 session
- update-plan-store.json 被当作恢复依据 → 与实际执行脱节
- `finish_reason=stop` 可单独停止 → 任务未完成就停了

### 关键实现
1. **bd-epic-view 模块** (`src/serverx/modules/bd-epic-view.ts`)
   - `getCurrentEpic`, `getCandidateEpics`, `getNextEpic`, `getEpicTaskState`
   - `isBdAvailable` 检查 bd CLI 可用性
   - 候选排序：priority 升序 → updatedAt 降序

2. **projectTaskState 数据结构** (`src/common/project-task-state.ts`)
   - 新增 `epicId`, `bdStorePath`, `periodicKey` 字段
   - `resolveBeadsStorePath(agentId, projectPath)`：system→`~/.finger/beads/`，project→`.beads`
   - `validateBdIssue(taskId, bdStorePath)` 验证 taskId 有效性
   - `parseProjectTaskState`, `isProjectTaskStateActive`

3. **heartbeat 恢复** (`src/serverx/modules/heartbeat-scheduler.impl.ts`)
   - `detectActiveProjectRecoverySessions()` 改为检查 bd epic 状态
   - 移除 `staleTaskSessionIds` 模糊判定

4. **上下文构建** (`src/agents/base/kernel-agent-base.ts`)
   - 新增 `task.bd_epic` slot，注入当前 epic + 候选 epic
   - 启动恢复时从 bd 重新读取

5. **Task Mode** (`src/common/stop-reasoning-policy.ts` + `event-forwarding.impl.ts`)
   - `taskMode`: default / light（当前 epic 必须完成）/ forever（永远不停）
   - event-forwarding 在 stop gate 中新增 taskMode gate
   - 有活跃非阻塞任务时阻止 `finish_reason=stop`

6. **session 清理** (`src/serverx/modules/system-agent-manager.impl.ts`)
   - `resumeProjectSessionIfNeeded()` 从 bd 读取 epic 状态
   - 任务完成后自动清除 projectTaskState

### 教训
- 测试污染 session 是反复风暴的根因 → 启动时清理无关 session
- 已完成任务必须移除 → 避免毒害后续 session 上下文
- bd 工具是外部依赖 → 启动检查 + 优雅降级

### Epic
关联: finger-288

## [task] Always-On 模块化架构与热升级系统 {#mem-always-on-20260411}
时间: 2026-04-11 15:00
状态: completed
关联: finger-287

### 背景
用户提出 `finger:always-on` 目标：
1. Daemon 永远在线 + 可控关闭（不死循环）
2. 基础能力完备 + 自检
3. 模块隔离 + 局部热升级

### 核心架构决策

#### 1. Core/Extension 分层
- **Core 层**（完整升级）：runtime、session、protocol、message-hub、agent-runtime-block、websocket-block、logger、event-bus、gateway-manager、tool-registry
- **Extension 层**（热升级）：finger-*-agent、channel-bridge-*、inputs、outputs、可选工具

#### 2. 双槽位机制
- 每个模块有 active/standby 两个槽位
- 升级 → 新版本安装到 standby → 釕证通过 → 槽位切换
- 降级 → standby 切回 active
- 允许跳过版本（v1.0.0 → v3.0.0）

#### 3. Runtime 主备规则
- Runtime 只有一个实例
- 本地切主/切备 → 写入角色文件 → 重启生效
- 默认启动为 active
- 切备后重启保持 standby（不自动变 active）

### 实现组件

| 组件 | 文件 | 测试 | 说明 |
|------|------|------|------|
| ActiveStandbyManager | `src/orchestration/active-standby-manager.ts` | 24 tests | Runtime 角色 + 模块槽位管理 |
| UpgradePackageManager | `src/orchestration/upgrade-package-manager.ts` | 23 tests | npm/tarball/URL 获取 + checksum |
| PreUpgradeHealthCheck | `src/orchestration/pre-upgrade-health-check.ts` | 19 tests | daemon/provider/disk/sessions |
| UpgradeEngine | `src/orchestration/upgrade-engine.ts` | 19 tests | 事务升级 + 失败回滚 |
| ModuleLayers | `src/orchestration/module-layers.ts` | 26 tests | 分层声明 + 依赖图 |
| RollbackManager | `src/orchestration/rollback-manager.ts` | 21 tests | 回滚点创建/恢复/清理 |
| CLI upgrade | `src/cli/upgrade.ts` | 20 tests | run/all/core/list/rollback/status |
| 集成测试 | `tests/integration/full-upgrade-pipeline.test.ts` | 10 tests | 热升级/降级/跳版本/回滚 |

**总计**: 138 单元测试 + 10 集成测试 = 148 tests

### 真实升级验证

```
myfinger upgrade run finger-project-agent \
  --source /tmp/finger-upgrade-pkg/v0.1.362-extracted/package/dist \
  -v 0.1.362

Upgrade Steps:
  ✓ validate (0ms)
  ✓ backup (301ms) → 2318 files backed up
  ✓ stop (0ms)
  ✓ replace (0ms)
  ✓ start (0ms)
  ✓ verify (0ms)
  ✓ commit (0ms) → Slots switched

Upgrade completed successfully

myfinger upgrade rollback finger-project-agent -y
  → Restored 2318 files from rollback point

myfinger upgrade list finger-project-agent
  → 显示所有回滚点（版本、时间、文件数、��径）

Daemon 状态: 全程保持 running on port 9999
```

### 关键学习

#### 升级包来源处理
- **错误**: `--source` 指向 .tgz 文件 → `ENOTDIR: not a directory, scandir`
- **正确**: `--source` 必须指向解压后的 dist 目录

#### 版本参数
- CLI `-v` 被 commander 解析为全局 `--version`，覆盖子命令参数
- 使用长格式 `--version` 可绕过此问题

#### 回滚点消耗
- 执行 rollback 会消耗最新回滚点（删除后恢复）
- 回滚点保留最近 3 个（自动清理最旧）

### 目录结构

```
~/.finger/runtime/
├── runtime-role.json              # Runtime 角色（active/standby）
├── module-slots/                  # 模块槽位状态
│   ├── finger-project-agent.json
│   └── finger-executor-agent.json
├── upgrade-cache/                 # 升级包缓存
│   └── finger-executor-agent/
│       ├── v2.0.0.tar.gz
│       └── v2.0.0.sha256
└── rollback/                      # 回滚点
    ├── core/
    └── extension/
        └── finger-project-agent/
            └── 0.1.362.bak.1775890997321/
```

### CLI 命令清单

```bash
myfinger upgrade status                    # 状态概览
myfinger upgrade run <module> --version X  # 升级指定模块
myfinger upgrade all --yes                 # 升级所有 Extension
myfinger upgrade core --yes                # Core 完整升级
myfinger upgrade list <module>             # 查看回滚点
myfinger upgrade rollback <module> -y      # 回滚到最新
```

### 下一步
- Worker 进程级隔离（Phase 3）
- npm registry 集成（自动拉取）
- 心跳计数器重置机制（防永久死亡）

