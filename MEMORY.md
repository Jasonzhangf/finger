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
