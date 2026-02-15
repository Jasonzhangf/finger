# AGENTS.md - Finger 项目全局规则与架构

## 1. 技术栈与约定

### 1.1 语言与模块系统
- **TypeScript 强制**：所有代码必须使用 TypeScript 编写，禁用 `any` 类型（特殊情况需注释说明）。
- **ES Modules (ESM)**：必须使用 `import/export`，禁用 `require`。`package.json` 中 `"type": "module"` 已设置。
- **文件命名**：使用 kebab-case（如 `message-hub.ts`），类/接口使用 PascalCase。
- **文件大小限制**：单个文件不得超过 500 行（逻辑相关可拆分）。

### 1.2 代码风格
- **函数全局唯一**：同一功能函数全局只实现一次，通过骨架+配置复用。
- **分层清晰**：严禁将不同层（如 role/agent/provider）混放在同一文件。
- **注释**：只在复杂逻辑处添加必要注释，禁止冗余注释（如 `// 设置变量`）。

### 1.3 测试与质量
- **单元测试强制**：每个模块必须有对应测试（`tests/unit/`）。
- **CI 门禁**：未通过 lint 和测试的代码不得合入 main。
- **构建验证**：修改后必须运行 `npm run check`（lint + test + build）。

---

## 2. 项目架构

### 2.1 三层结构
```
└── src/
    ├── blocks/          # 基础功能块（无编排逻辑，每个块独立 CLI/API）
    ├── orchestration/   # 编排层（消息中枢、守护进程、模块注册）
    └── agents/          # Agent 层（角色、SDK 封装、工具）
```

#### 2.1.1 Blocks（基础功能）
- 每个 Block 实现单一功能（如 `StateBlock`、`TaskBlock`）。
- 必须实现 `BaseBlock` 接口，暴露 CLI 和状态查询 API。
- 所有 Block 注册到 `core/registry.ts`，前端可自动发现能力。

#### 2.1.2 Orchestration（编排）
- **MessageHub**：全局消息路由器，支持动态注册输入/输出，阻塞/非阻塞模式。
- **ModuleRegistry**：管理 `input`/`output`/`agent` 模块，支持从文件动态加载。
- **Daemon**：后台守护进程，管理生命周期，提供 REST API 和 IPC 通信。

#### 2.1.3 Agents（AI 代理）
- **Role**：定义角色行为（`orchestrator`、`executor`、`reviewer`）。
- **Provider**：封装 SDK（如 `iflow`、`codex`、`claude`）。
- **Runtime**：执行循环、工具注册。
- **Shared**：工具集、提示词、能力声明。

---

## 3. 消息中枢与模块系统

### 3.1 模块类型
| 类型 | 作用 | 示例 |
|------|------|------|
| `input` | 接收消息的入口 | CLI 输入、HTTP 回调 |
| `output` | 处理消息并返回结果 | Agent 执行器、Mock 服务 |
| `agent` | 可执行指令的代理 | Orchestrator、Executor |

### 3.2 模块定义（TypeScript）
```typescript
// 一个模块可同时拥有多个 input/output
import { InputModule, OutputModule, AgentModule } from '../orchestration/module-registry.js';

// Input 模块
export const myInput: InputModule = {
  id: 'my-input',
  type: 'input',
  name: 'my-input',
  version: '1.0.0',
  handle: async (msg) => {
    // 处理输入消息
    return { processed: true };
  },
  defaultRoutes: ['my-output']  // 可选默认路由
};

// Output 模块
export const myOutput: OutputModule = {
  id: 'my-output',
  type: 'output',
  name: 'my-output',
  version: '1.0.0',
  handle: async (msg, callback) => {
    const result = { echo: msg };
    if (callback) callback(result);
    return result;
  }
};

// Agent 模块（兼具 input/output 能力）
export const myAgent: AgentModule = {
  id: 'my-agent',
  type: 'agent',
  name: 'my-agent',
  version: '1.0.0',
  capabilities: ['execute', 'query'],
  execute: async (command, params) => {
    if (command === 'execute') return { done: true };
    throw new Error(`Unknown command: ${command}`);
  },
  // 可选：自定义 input/output
  initialize: async (hub) => {
    hub.registerInput('my-agent-input', async (msg) => {
      return myAgent.execute(msg.command, msg.params);
    });
    hub.registerOutput('my-agent-output', async (msg, cb) => {
      const result = await myAgent.execute('execute', msg);
      if (cb) cb(result);
      return result;
    });
  }
};
```

### 3.3 消息路由与同名回复
- **发送消息**：CLI 或模块通过 `hub.sendToModule(moduleId, message, callback?)` 直接发送。
- **同名回复**：若消息包含 `sender` 字段，中枢会尝试查找与 `sender` 同名的 input 模块，并将结果回调。
- **阻塞模式**：`-b` 标志使 CLI 等待结果（通过回调 ID 实现）。

### 3.4 动态注册
```bash
# 注册模块文件（支持数组批量注册）
finger daemon register-module -f ./dist/my-agent.js

# 列出所有模块
finger daemon list
```

---

## 4. 守护进程（Daemon）

### 4.1 生命周期管理
```bash
finger daemon start    # 启动后台进程（PID 写入 ~/.finger/daemon.pid）
finger daemon stop     # 停止进程
finger daemon restart  # 重启
finger daemon status   # 查看状态及已注册模块
```

### 4.2 服务端口
- **默认端口**：`5521`（可通过环境变量 `PORT` 覆盖）
- **REST API**：
  - `GET  /api/v1/modules` - 列出所有模块
  - `GET  /api/v1/routes`  - 列出路由规则
  - `POST /api/v1/message` - 发送消息（JSON 格式）
  - `POST /api/v1/module/register` - 动态注册模块（需提供模块文件路径）

### 4.3 日志
日志输出到 `~/.finger/daemon.log`，包含消息路由记录和错误堆栈。

---

## 5. 刚性约束

### 5.1 代码质量
- **禁止巨型文件**：超过 500 行必须拆分。
- **禁止重复函数**：同一功能全局唯一实现，通过配置复用。
- **禁止 any 类型**：必须定义接口或使用 `unknown` 加类型守卫。

### 5.2 测试与 CI
- **单元测试**：所有模块必须有对应测试（`tests/unit/`）。
- **集成测试**：关键流程（如 daemon 启动/消息路由）需有测试（`tests/integration/`）。
- **门禁**：提交前必须通过 `npm run check`。

### 5.3 构建验证
- 修改后运行 `npm run build` 确保无 TypeScript 错误。
- 运行 `npm test` 确保测试通过。

---

## 6. BD 任务管理

### 6.1 任务与进度
- 所有开发任务必须创建 BD issue：
  ```bash
  bd --no-db create "任务标题" -p 0 --parent <epic>
  ```
- 任务状态更新：
  ```bash
  bd --no-db update <id> --status in_progress|blocked|closed
  ```
- 依赖管理：
  ```bash
  bd --no-db dep add <blocked> <blocker>
  ```

### 6.2 同步流程
- 使用 `git-portable` 模式：
  ```bash
  bd sync mode set git-portable
  bd hooks install
  ```
- 每次提交前自动同步 `.beads/issues.jsonl`。

---

## 7. 后续开发路线

### 7.1 已完成
- ✅ 消息中枢与模块注册表（TypeScript + ESM）
- ✅ 守护进程管理器与 CLI 命令
- ✅ 测试 Agent 示例（`mock-echo`）

### 7.2 待完成
- [ ] 实际 Agent 角色（Orchestrator/Executor）
- [ ] iFlow SDK 集成与能力测试
- [ ] 任务分解与分配逻辑
- [ ] 状态持久化与恢复机制

---

> 本文件作为项目核心约束，后续修改需通过 PR 更新。
