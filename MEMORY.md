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
- [2026-03-13] ChannelContextManager 作为上下文真源：system/agent/project 切换命令必须更新上下文；provider 切换不影响 agent 上下文。  
  Tags: channel-context, persistence
- [2026-03-13] MessageHub 指令集：Project -> Session -> Agent 关系为单一真源；通道策略 `direct`/`mailbox` 决定是否可直达 agent。  
  Tags: messagehub, commands, auth, session

## Session Management & Agent Runtime SSOT
- [2026-03-13] Session 管理迁移到 Agent 层：移除 MessageHub `/resume`；新增 `session.list` / `session.switch` 工具；System Agent 可跨 agent 切换。  
  Tags: session-management, agent-tools
- [2026-03-13] `system:restart` 仍在 MessageHub 层直连 daemon，避免交给 agent。  
  Tags: system, restart, messagehub
- [2026-03-07..08] UI 运行态单一真源：`configAgents`/`runtimeAgents`/`catalogAgents` 分离；`sessionAgentId/ownerAgentId` 为唯一真源；LeftSidebar 合并 runtime+历史会话并去重。  
  Tags: ui, runtime, ssot
- [2026-03-13] UI 会话刷新修复：取消 `limit=0`，实时 WS events 不再被 session messages 覆盖；仅在无 WS 事件时做 session hydrate。  
  Tags: ui, websocket, session-refresh

## OpenClaw Gate & Mailbox
- [2026-03-10] OpenClaw gate 保持通用；finger 自行实现 thread binding、权限策略、消息分类。  
  Tags: openclaw, mailbox, thread-binding
- [2026-03-10] Mailbox 是异步消息唯一真源：控制渠道可进主会话，非控制渠道只入 mailbox；agent 接收 mailbox notice，必要时调用 read/ack。  
  Tags: mailbox, async, permissions
- [2026-03-10] OpenClaw Gate 实施进度：Block 层 + 配置 schema/loader + openclaw input/output 适配完成；orchestration adapter 可注册 OpenClaw 工具，仍待接入 runtime 启动链路。  
  Tags: openclaw, block-layer, orchestration, config

## Compact & Ledger
- [2026-03-09] 自动 compact 阈值 85%；Ledger 支持 search/index/compact；系统通知触发 `maybeAutoCompact`。  
  Tags: compact, ledger, memory

## Long-term Memory
- [2026-03-14 15:27:58] role=user
  summary: "完成 CACHE.md + MEMORY.md 双层记忆管理与 Reviewer 流程联动，测试通过，任务已闭环"
  Tags: memory, cache, review, compaction, orchestrator
- [2026-03-14 17:57:06] role=user
  summary: "Phase 1 核心改动完成（MultiAgentMonitorGrid 接收 panels prop、canvasElement 从 sessions 构造、rightPanelElement 固定 system agent），TypeScript 编译 + 16 项 UI 测试通过，Phase 2 已 closed，finger-237 待收尾状态更新。"
  Tags: ui, refactoring, multi-agent-grid, session-panel, finger-237

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

