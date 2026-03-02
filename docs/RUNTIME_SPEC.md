# Finger 基础运行规范 v1.0

## 1. 核心原则

### 1.1 单一真相源
- **基础 Daemon 是所有运行的唯一入口和管理中心**
- 任何组件（Agent、Sub-Agent、应用）必须通过 Daemon 启动
- 禁止绕过 Daemon 直接启动服务或进程

- 所有组件间通信必须通过 **Message Hub** (端口 5521)
- CLI、UI、外部客户端都是 **消息发送者**，不是执行宿主
- 状态同步通过 **WebSocket** (端口 5522) 广播

### 1.3 生命周期托管
- Daemon 负责所有子进程的生命周期管理（启动、停止、监控、清理）
- 任何组件崩溃由 Daemon 负责重启或标记失败
- 孤儿进程清理由 Daemon 在启动时统一处理

## 2. 架构层级

```
┌─────────────────────────────────────────────────────────────┐
│                      客户端层 (Clients)                       │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ │
│  │ CLI     │  │ Web UI  │  │ API     │  │ External Tools  │ │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────────┬────────┘ │
└───────┼────────────┼────────────┼────────────────┼──────────┘
        │            │            │                │
        └────────────┴────────────┘                │
                     │                              │
                     ▼                              ▼
        ┌──────────────────────┐      ┌──────────────────────┐
        │   HTTP API (8080)    │      │   WebSocket (8081)   │
        │   (可选，面向外部)    │      │   (状态推送)         │
        └──────────┬───────────┘      └──────────────────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │   基础 Daemon        │◄──── 核心控制层
        │   - Message Hub      │      端口: 5521 (HTTP)
        │   - Process Manager  │      端口: 5522 (WS)
        │   - Agent Pool       │
        └──────────┬───────────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
┌────────────┐ ┌────────┐ ┌────────────┐
│ Agent Pool │ │Runtime │ │ Sub-Agents │
│ (Managed)  │ │Workers │ │ (Dynamic)  │
└────────────┘ └────────┘ └────────────┘
```

## 3. 通信协议

### 3.1 Message Hub API (端口 5521)

所有操作通过 HTTP POST 到 `/api/v1/message`：

```typescript
interface MessageRequest {
  target: string;      // 目标模块/Agent ID
  message: unknown;    // 消息内容
  blocking?: boolean;  // 是否等待响应
  sender?: string;     // 发送者标识
  callbackId?: string; // 回调 ID（非阻塞时使用）
}

interface MessageResponse {
  messageId: string;   // 消息唯一 ID
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: unknown;    // 阻塞模式下的结果
  error?: string;      // 错误信息
}
```

### 3.2 WebSocket 状态流 (端口 5522)

客户端订阅：`{ type: 'subscribe', target?: string, workflowId?: string }`

事件类型：
- `messageUpdate` - 消息状态变更
- `messageCompleted` - 消息完成
- `agentStatus` - Agent 状态变更
- `workflowUpdate` - 工作流状态变更
- `system` - 系统级事件

## 4. CLI 规范

### 4.1 CLI 是纯粹客户端
- CLI 进程生命周期：**发送请求 → 立即退出**（除非 `--watch`）
- 禁止 CLI 进程长期驻留或托管执行逻辑
- 所有命令最终转换为 Message Hub 消息

### 4.2 命令映射

| CLI 命令 | 目标模块 | 消息类型 | 阻塞 |
|----------|----------|----------|------|
| `finger understand <input>` | `understanding-agent` | `UNDERSTAND` | 否 |
| `finger route --intent <json>` | `router-agent` | `ROUTE` | 否 |
| `finger plan <task>` | `planner-agent` | `PLAN` | 否 |
| `finger execute --task <t>` | `executor-agent` | `EXECUTE` | 可选 |
| `finger review --proposal <json>` | `reviewer-agent` | `REVIEW` | 否 |
| `finger orchestrate <task>` | `orchestrator` | `ORCHESTRATE` | 否 |
| `finger daemon start` | `daemon` | `START` | 是 |
| `finger daemon stop` | `daemon` | `STOP` | 是 |
| `finger daemon status` | `daemon` | `STATUS` | 是 |

### 4.3 状态查看
- `finger status <workflowId>` - 查询工作流状态（HTTP 查询）
- `finger events <workflowId> --watch` - 订阅实时事件（WebSocket）

## 5. Agent 规范

### 5.1 Agent 必须实现
1. **HTTP 接口**：`POST /execute` - 接收任务
2. **心跳上报**：每 30 秒向 Daemon 报告健康状态
3. **状态回调**：任务状态变更主动推送到 Message Hub

### 5.2 Agent 生命周期
```
REGISTERED -> STARTING -> RUNNING -> [BUSY/IDLE] -> STOPPING -> STOPPED
                │           │            │
                └───────────┴────────────┘
                      Daemon 管理
```

### 5.3 Agent 启动方式
- 静态配置：`daemon.config.agents` 中定义，随 Daemon 自动启动
- 动态添加：`finger daemon agent add --id <id> --port <port>`
- 临时执行：通过 `execute` 命令动态创建

## 6. 当前代码修改清单

### 6.1 问题：Agent 命令直连 8080 API
**位置**：`src/cli/agent-commands.ts`
**问题**：直接调用 `http://localhost:8080/api/v1/agent/*`
**修改**：改为发送消息到 `http://localhost:5521/api/v1/message`

```typescript
// 修改前
const res = await fetch(`${API_BASE}/api/v1/agent/understand`, {...})

// 修改后
const res = await fetch('http://localhost:5521/api/v1/message', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    target: 'understanding-agent',
    message: { type: 'UNDERSTAND', input, sessionId },
    blocking: false,
    sender: 'cli'
  })
})
```

### 6.2 问题：CLI 命令缺少 callbackId 机制
**位置**：`src/cli/agent-commands.ts`
**问题**：非阻塞调用后无法追踪结果
**修改**：
1. 生成 `callbackId`（如 `cli-${timestamp}-${random}`）
2. 支持 `finger status <callbackId>` 查询结果
3. `--watch` 模式通过 WebSocket 订阅 `callbackId`

### 6.3 问题：WebSocket 端口混乱
**位置**：多处（8081 vs 5522）
**问题**：UI 连 8081，CLI daemon chat 连 5522
**修改**：
- Daemon WebSocket 统一为 5522
- 8081 仅作为 UI/外部客户端的代理转发层

### 6.4 问题：缺少 Agent 模块注册
**位置**：`src/server/index.ts`
**问题**：Agent 端点直接处理请求，未通过 Message Hub
**修改**：
1. 将 Agent 实现为 Message Hub 的 output module
2. 或保留 8080 作为代理层，转发到 5521

### 6.5 问题：生命周期管理不完善
**位置**：`src/orchestration/daemon.ts`
**问题**：Agent 池管理简单，缺少自动重启
**修改**：
1. 添加 Agent 健康检查定时器
2. 崩溃后自动重启（带退避策略）
3. 记录启动历史到 `~/.finger/logs/agent-history.json`

## 7. 实施优先级

### P0 - 核心解耦
1. [ ] 修改 `agent-commands.ts` 使用 Message Hub (5521)
2. [ ] 统一 WebSocket 端口为 5522
3. [ ] 添加 callbackId 追踪机制

### P1 - 完善生命周期
4. [ ] Agent 健康检查和自动重启
5. [ ] 孤儿进程清理优化
6. [ ] CLI `--watch` 实现 WebSocket 订阅

### P2 - 架构优化
7. [ ] 8080 作为 5521 的代理层
8. [ ] Agent 动态注册/发现
9. [ ] 多客户端并发测试

## 8. 验证标准

### 8.1 基础验证
```bash
# 1. 启动 Daemon
finger daemon start
# 2. 发送任务（非阻塞，立即返回）
# 3. 查询状态
finger status search-001
# 4. 实时监听
finger events search-001 --watch

### 8.2 多客户端验证
```bash
# 终端 1：CLI 发送
finger orchestrate "任务 A"
# 终端 2：同时发送
finger orchestrate "任务 B"
# UI：同时查看两个任务状态
# 三者互不阻塞，状态同步
```

### 8.3 生命周期验证
```bash
# 杀掉一个 Agent 进程，观察自动重启
kill <agent-pid>
# 查看 Daemon 日志确认重启
finger daemon logs
