# Orchestration 模块说明

本目录负责消息路由、模块注册、守护进程管理以及 Runtime Agent 池。

## 目录结构

- `message-hub.ts` - 核心消息中枢，负责输入/输出注册、路由匹配、阻塞/非阻塞模式。
- `module-registry.ts` - 模块注册表，管理 input/output/agent 模块，支持动态加载。
- `daemon.ts` - 守护进程管理器，启动/停止主 HTTP 服务及 Runtime Agent 池。
- `agent-pool.ts` - Runtime Agent 池管理器，负责独立 Agent Daemon 的生命周期。
- `types.ts` - 公共类型定义。
- `index.ts` - 统一导出。

## 1. 消息中枢 (`MessageHub`)

### 注册输入/输出

```ts
const hub = new MessageHub();

// 注册输入模块
hub.registerInput('cli-input', async (msg) => {
  console.log('Received:', msg);
  return { processed: true };
}, ['echo-output']); // 默认路由

// 注册输出模块
hub.registerOutput('echo-output', async (msg, callback) => {
  const result = { echo: msg };
  if (callback) callback(result);
  return result;
});
```

### 发送消息

```ts
// 直接发送给某个模块（自动识别 input/output）
const result = await hub.sendToModule('echo-output', { text: 'hello' });

// 通过路由自动匹配
await hub.send({ type: 'test', data: 'xxx' });

// 阻塞模式（带回调）
const cbResult = await hub.sendToModule('echo-output', { text: 'hi' }, (res) => {
  console.log('Callback:', res);
});
```

### 添加路由规则

```ts
hub.addRoute({
  pattern: 'test',           // 匹配 message.type === 'test'
  handler: async (msg) => hub.routeToOutput('echo-output', msg),
  blocking: false,
  priority: 0,
});
```

## 2. 模块注册表 (`ModuleRegistry`)

### 注册模块

```ts
import { echoInput, echoOutput } from './mock-echo-agent.js';

const registry = new ModuleRegistry(hub);
await registry.register(echoInput);
await registry.register(echoOutput);
```

### 动态加载文件

```ts
await registry.loadFromFile('./dist/my-agent.js');
```

### 创建路由

```ts
registry.createRoute(
  () => true,                    // 所有消息
  'echo-output',                 // 目标输出
  { blocking: false, priority: 0, description: 'default' }
);
```

## 3. 守护进程 (`OrchestrationDaemon`)

主入口：`fingerdaemon daemon` 命令。

### 生命周期管理

```bash
fingerdaemon daemon start      # 启动守护进程（同时启动 autoStart agents）
fingerdaemon daemon stop       # 停止守护进程（同时停止所有 agents）
fingerdaemon daemon restart
fingerdaemon daemon status     # 查看进程状态及已注册模块
fingerdaemon daemon list       # 列出已注册模块
fingerdaemon daemon send ...   # 发送消息
fingerdaemon daemon register-module ...
```

### 环境变量

- `PORT` - 覆盖 HTTP 服务端口（默认 5521）
- `HOST` - 覆盖监听地址

### 日志

- 主进程日志：`~/.finger/daemon.log`
- Agent 日志：`~/.finger/agents/<id>.log`

## 4. Runtime Agent 池 (`AgentPool`)

独立 Agent Daemon 的管理器，通过 `fingerdaemon daemon agent` 子命令操作。

### 配置文件

- `~/.finger/agents.json` - 存储所有 Agent 配置。
- PID 文件：`~/.finger/agents/<id>.pid`

### 子命令

```bash
# 添加一个 agent（保存配置）
fingerdaemon daemon agent add \
  --id executor1 \
  --name "Executor 1" \
  --mode auto \
  --port 9001 \
  --system-prompt "You are a code executor" \
  --auto-start

# 列出 agents
fingerdaemon daemon agent list

# 查看单个状态
fingerdaemon daemon agent status executor1

# 启动/停止/重启
fingerdaemon daemon agent start executor1
fingerdaemon daemon agent stop executor1
fingerdaemon daemon agent restart executor1

# 移除（会自动停止）
fingerdaemon daemon agent remove executor1
```

### 与主守护进程集成

- `daemon start` 时自动启动所有 `autoStart=true` 的 agents。
- `daemon stop` 时自动停止所有运行中的 agents。

### Agent 实现要求

每个 Agent 必须实现以下 HTTP 接口（由 `agent-daemon.ts` 提供）：

- `POST /task` - 接收任务，返回执行结果
- `POST /interrupt` - 中断当前任务
- `GET /status` - 返回 agent 状态
- `GET /health` - 健康检查

## 5. 模块注册 API

守护进程提供以下 REST 端点（端口 5521）：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/modules` | GET | 列出所有已注册模块 |
| `/api/v1/routes` | GET | 列出所有路由规则 |
| `/api/v1/message` | POST | 发送消息到指定模块 |
| `/api/v1/module/register` | POST | 动态注册模块文件 |

示例：

```bash
curl -X POST http://localhost:5521/api/v1/message \
  -H "Content-Type: application/json" \
  -d '{"target":"echo-output","message":{"text":"hello"},"blocking":true}'
```

## 6. 故障排查

- **端口冲突**：`lsof -ti:5521 | xargs kill -9`
- **Agent 启动失败**：查看 `~/.finger/agents/<id>.log`
- **消息路由不工作**：检查 `hub.getRoutes()` 和模块注册情况
