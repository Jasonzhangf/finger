# Agents Usage

本目录负责 Agent 抽象与 iFlow SDK 封装，当前支持：
- 通用 Agent（自动/手动模式）
- 独立 Agent Daemon（可作为 runtime agent 进程）
- MessageHub 可注册的 iFlow Output 模块

## 目录说明

- `agent.ts`: 通用 Agent 抽象，统一对外接口
- `sdk/iflow-base.ts`: 基础能力接口（session/状态/能力查询）
- `sdk/iflow-interactive.ts`: 交互循环接口（ReAct 循环）
- `daemon/agent-daemon.ts`: 独立 Agent Daemon
- `daemon/agent-daemon-cli.ts`: Agent Daemon CLI 启动器
- `daemon/iflow-agent-module.ts`: 可注册到 MessageHub 的 output module

## 一、通用 Agent

文件：`src/agents/agent.ts`

### 1) 创建 Agent

```ts
import { createAgent } from './agent.js';

const agent = createAgent({
  id: 'executor-1',
  name: 'Executor 1',
  mode: 'auto', // 'auto' | 'manual'
  provider: 'iflow',
  systemPrompt: 'You are a code executor',
  cwd: '/path/to/project',
});
```

### 2) 初始化与状态

```ts
await agent.initialize();
const status = agent.getStatus();
```

状态字段：
- `connected`
- `sessionId`
- `capabilities`
- `running`

### 3) 执行任务

自动模式：
```ts
const result = await agent.execute('请实现一个函数并写测试');
```

手动模式（必须提供 callbacks）：
```ts
const result = await agent.execute('复杂任务', {
  onAssistantChunk: async (chunk) => {
    process.stdout.write(chunk);
  },
  onPlan: async () => true,
  onPermission: async () => 'allow',
});
```

### 4) 中断与断开

```ts
await agent.interrupt();
await agent.disconnect();
```

## 二、iFlow SDK CLI

文件：`src/cli/iflow.ts`

### 命令

```bash
fingerdaemon iflow status
fingerdaemon iflow tools
fingerdaemon iflow capabilities
fingerdaemon iflow capability-test
fingerdaemon iflow run -t "your task"
fingerdaemon iflow chat
```

可选参数：
- `-d, --cwd <dir>`: 工作目录
- `--add-dir <dirs...>`: 额外目录

## 三、独立 Agent Daemon

文件：`src/agents/daemon/agent-daemon.ts`

Agent Daemon 是独立进程，提供 HTTP 接口：
- `GET /health`
- `GET /status`
- `POST /task`
- `POST /interrupt`

### 启动方式

文件：`src/agents/daemon/agent-daemon-cli.ts`

```bash
node dist/agents/daemon/agent-daemon-cli.js start \
  --id executor-1 \
  --name "Executor 1" \
  --mode auto \
  --port 9001 \
  --finger-daemon-url http://localhost:5521
```

## 四、注册为 MessageHub 模块

文件：`src/agents/daemon/iflow-agent-module.ts`

```ts
import { createIflowAgentOutputModule } from '../agents/daemon/iflow-agent-module.js';

const { module } = createIflowAgentOutputModule({
  id: 'executor-1',
  name: 'Executor 1',
  mode: 'auto',
  systemPrompt: 'You are a code executor',
});

await moduleRegistry.register(module);
```

之后可通过 hub 发送：
```ts
await hub.sendToModule('executor-1', { content: '实现一个函数' });
```

## 五、模式说明

### auto
- 自动执行任务
- 默认自动批准计划与权限
- 适合执行型 agent

### manual
- 需要外部提供交互回调
- 可精细控制计划/权限/问答
- 适合 orchestrator 或人工监管流程

## 六、故障排查

1. iFlow 连接失败
- 检查 `iflow --version`
- 检查本机权限与网络

2. 任务无输出
- 查看 daemon 日志
- 检查是否进入 `manual` 模式但未提供 callbacks

3. Agent 忙碌
- 同一个 agent 同时只允许一个运行中任务
- 返回错误：`Agent is already running a task`
