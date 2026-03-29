# TUI Project Bootstrap Design

## 目标

在任意项目目录执行 `myfinger tui` 时，自动完成：

1. 复用（或创建）当前目录的 project session  
2. 注册 monitor project（`enabled=true`）  
3. 启动 TUI，对话默认目标为该目录对应的 project agent

同时支持快捷切换：

- `/systemagent`：切换到 `finger-system-agent`
- `/agent`：切回当前项目 agent（bootstrap 返回的 `agentId`）

## 架构原则

- TUI 与 WebUI/QQ/Weixin 走同一后端链路（`/api/v1/message` + runtime WS events）。
- 不新增私有消息存储；session/ledger 仍是唯一真源。
- 多 UI 可并发消费同一会话事件。

## API：`POST /api/v1/projects/bootstrap`

### 请求

```json
{
  "projectPath": "/absolute/project/path",
  "createIfMissing": true,
  "monitor": true
}
```

### 响应（成功）

```json
{
  "success": true,
  "projectPath": "/absolute/project/path",
  "sessionId": "session-xxx",
  "agentId": "webauto-01",
  "monitorEnabled": true,
  "createdSession": false,
  "reusedSession": true
}
```

### 响应（失败）

```json
{
  "success": false,
  "error": "reason",
  "failedStage": "session_lookup|set_current_session|monitor_registration|bootstrap"
}
```

## 会话选择规则

- 仅选择 **同目录精确匹配** 的 root session。
- root session 过滤：`sessionTier !== runtime` 且没有 `parentSessionId/rootSessionId`。
- 多条命中时按 `lastAccessedAt` 取最新。
- 未命中且 `createIfMissing=true` 时创建新 session。

## CLI：`myfinger tui`

启动流程：

1. 调用 `/api/v1/projects/bootstrap`
2. 获取 `sessionId + agentId`
3. 启动 TUI 会话循环（基于现有 session-panel 交互链路）

默认 target 绑定 `agentId`（项目 agent）。

## 验收清单

1. `myfinger tui` 在项目目录可自动进入可用会话
2. `/systemagent` / `/agent` 切换路由正确
3. monitor 注册幂等
4. 多 UI 同步可见、无串台
