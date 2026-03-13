# MessageHub 指令集 + 双层鉴权 + 会话管理设计

## 2026-03-13 设计决策

### 核心概念关系

```
Project (工作目录)
  ↓ 包含多个
Session (对话上下文)
  ↓ attach
Agent (活跃的对话智能体)

示例：
Project: /Volumes/extension/code/finger
  ├─ Session-1 (agent: orchestrator, 15 条消息)
  ├─ Session-2 (agent: system, 8 条消息)
  └─ Session-3 (agent: orchestrator, 23 条消息)

Project: ~/.finger (系统目录)
  ├─ Session-sys-1 (agent: system, 5 条消息)
  └─ Session-sys-2 (agent: system, 12 条消息)
```

**关键点**：
- Session 数据按 Project 物理隔离存储
- Agent 必须 attach 到 Session 才能工作
- 切换 Agent = 切换 Project + Session

### 双层鉴权体系

#### 第一层：通道鉴权（Channel Authorization）

**配置位置**：`~/.finger/config/config.json`

```json
{
  "channelAuth": {
    "enabled": true,
    "defaultPolicy": "direct",
    "channels": [
      { "id": "webui", "type": "direct", "priority": 10 },
      { "id": "qqbot", "type": "direct", "priority": 20 },
      { "id": "cli", "type": "direct", "priority": 5 },
      { "id": "feishu", "type": "mailbox", "priority": 30 }
    ]
  }
}
```

**策略说明**：
- `type: "direct"` - 消息可直接路由到 agent（实时响应）
- `type: "mailbox"` - 消息必须进 mailbox 队列（异步处理）
- `defaultPolicy` - 未配置通道的默认策略
- qqbot 必须显式配置为 direct 才能进入 agent 模式

#### 第二层：System Agent 鉴权

**配置位置**：`~/.finger/config/config.json`

```json
{
  "systemAuth": {
    "enabled": true,
    "password": null
  }
}
```

**策略说明**：
- `enabled: false` - 禁用 system agent
- `password: null` - 无密码要求（开发模式）
- `password: "sha256:hash"` - 要求密码验证

### 命令语法

```
<##@cmd:list##>                → 列出所有可用命令
<##@agent:list##>               → 列出当前 project 的所有 session
<##@agent:list@/path/to/proj##> → 列出指定 project 的所有 session
<##@agent:new##>                → 在当前 project 创建新 session 并切换
<##@agent:new@/path/to/proj##>  → 在指定 project 创建新 session 并切换
<##@agent:switch@session-id##> → 切换到指定 session（自动识别 project）
<##@agent:delete@session-id##> → 删除指定 session
<##@system##>                   → 切换到 system agent (project=~/.finger, 最新 session)
<##@system:pwd=xxx##>           → 切换到 system agent (鉴权)
<##@project:list##>             → 列出所有有 session 的 project
<##@project:switch@/path##>     → 切换 project（使用该 project 最新 session）
```

### 默认策略

#### 默认项目策略

1. **配置优先**：`defaults.projectPath`（如 `~/.finger`）
2. **最近一次项目**：`defaults.useLastProject = true` 时，从 sessionManager 最近访问记录推断
3. **默认**：`~/.finger`

#### 默认会话策略

- 未指定 session 时，使用该项目的最新 session（按 lastAccessedAt 排序）
- 如果该项目没有 session，则创建新 session

### 消息路由决策流程

```
收到消息
  ↓
解析超级命令（<##@...##>）
  ├─ 是超级命令 → 直接处理命令
  └─ 非超级命令 → 检查通道策略
      ├─ type === "direct" → 通过 MessageHub 路由到 agent
      └─ type === "mailbox" → 进入 mailbox 队列
```

### 实现模块

1. **配置加载**：`src/core/config/channel-config.ts`
   - `loadFingerConfig()` - 加载 config.json
   - `getChannelAuth(config, channelId)` - 获取通道策略

2. **命令解析**：`src/server/middleware/super-command-parser.ts`
   - 扩展 `SuperCommandBlock` 类型
   - 扩展 `parseSuperCommand()` 函数

3. **命令处理**：`src/server/modules/messagehub-command-handler.ts`
   - `handleCmdList()` - 命令列表
   - `handleAgentList()` - session 列表
   - `handleAgentNew()` - 创建 session
   - `handleAgentSwitch()` - 切换 session
   - `handleAgentDelete()` - 删除 session
   - `handleSystemCommand()` - 切换到 system agent
   - `handleProjectList()` - 项目列表
   - `handleProjectSwitch()` - 切换项目

4. **路由集成**：`src/server/routes/message.ts`
   - 在 super_command 处理分支集成命令处理

5. **UI 刷新**：EventBus + WebSocket
   - `session_changed` 事件通知 UI 刷新

### 关键假设

1. **Project = 工作目录**：Session 按 Project 物理隔离
2. **Agent 必须 attach 到 Session**：切换 Agent = 切换 Project + Session
3. **通道鉴权**：qqbot 必须显式配置为 direct 才能进入 agent 模式
4. **超级命令优先**：超级命令始终直接处理，不受通道策略影响
5. **System Project**：固定为 `~/.finger`

Tags: messagehub, auth, command, session, project, agent, 2026-03-13
